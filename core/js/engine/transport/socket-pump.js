// socket-pump.js — the engine's datagram transport (the driver.js bundle).
//
// The wasm engine talks to game servers over a shared-memory ring buffer:
// it writes outbound datagrams to the TX ring and waits on a futex; we read
// them, wrap them in Roblox's RUPP (Roblox UDP Protocol) session header, and
// send them over a WebSocket->UDP relay to the UDMux game endpoint. Inbound
// datagrams flow the other way (relay -> RX ring -> wake the wasm).
//
// The relay is the same-origin /udp-relay ws endpoint (server/relay.js) —
// a bare connection there speaks the MSG_* handshake below.
//
// Two layers:
//   Rupp           — Roblox's UDP session codec (token/session/addr patching)
//   startSocketPump — the ring-buffer <-> relay pump
//
// Wire protocol over the WS relay (binary, 5-byte header: type + u32 streamId):
//   MSG_HELLO  (5) server hello      -> we ack
//   MSG_ACK    (3) handshake ack     -> we send the bind/open frame
//   MSG_OPEN   (1) open stream (host,port)
//   MSG_DATA   (2) datagram payload  -> deliver to engine RX ring
//   MSG_REFUSE (4) stream refused    -> socket._end

'use strict';

// ---- relay wire opcodes --------------------------------------------------
const MSG_OPEN = 1;
const MSG_DATA = 2;
const MSG_ACK = 3;
const MSG_REFUSE = 4;
const MSG_HELLO = 5;
const STREAM_ID = 1;          // we multiplex everything on stream 1
const RING_MAGIC = 0x4B4C4A4E; // 'NJLK' — our ring sentinel

// ============================================================================
//  RUPP — Roblox UDP Protocol session codec
// ============================================================================
// The engine's outbound datagrams carry a RUPP header we fill in from the
// joinScript: the join token (16B), the session token (16B, set after the
// server's first reply), and the RCC/server addr+port. inbound() harvests
// the session token the server assigns.
class Rupp {
  constructor() {
    this.join = null;     // 16B join token (NetStackTokenValue / TokenValue)
    this.session = null;  // 16B session token (assigned by server, typ=1 ver=2)
    this.rcc = null;      // {addr:Uint8Array(4), netstack:port}
    this.dataPort = 0;
  }

  // Feed the engine a joinScript: pull the token + server endpoints out of it.
  setJoinScript(joinScript) {
    DBG?.join('setJoinScript',
      joinScript && (joinScript.SessionId || joinScript.gameId || ''),
      'udmux:', joinScript?.UdmuxEndpoints?.length);
    if (!joinScript) return this;

    const token = this._decodeToken(joinScript.NetStackTokenValue || joinScript.TokenValue);   // spec: TLV1 carries NetStackTokenValue
    if (token) {
      // a new join token invalidates the previous session
      if (this.join && !this._eq(this.join, token)) this.session = null;
      this.join = token;
    }
    const conn = joinScript.ServerConnections?.[0];
    const addr = this._ipv4(joinScript.MachineAddress || conn?.Address);
    const netstack = joinScript.NetStackPort;
    if (addr && netstack) this.rcc = { addr, netstack };
    const dataPort = conn?.Port || joinScript.ServerPort || 0;
    if (dataPort) this.dataPort = dataPort;
    return this;
  }

  get ready() { return !!(this.join || this.rcc); }

  // base64 -> bytes, or 32-hex -> bytes (16B expected)
  _decodeToken(value) {
    if (!value) return null;
    if (/^[0-9a-f]{32}$/i.test(value)) {
      const b = new Uint8Array(16);
      for (let i = 0; i < 16; i++) b[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
      return b;
    }
    try {
      const s = atob(value);
      const b = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
      return b.length === 16 ? b : null;
    } catch { return null; }
  }

  _ipv4(host) {
    if (!host) return null;
    const parts = host.split('.');
    if (parts.length !== 4) return null;
    const b = new Uint8Array(4);
    for (let i = 0; i < 4; i++) {
      const n = +parts[i];
      if (!(n >= 0 && n < 256)) return null;
      b[i] = n;
    }
    return b;
  }

  _eq(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }

  // RUPP header length: [ver:1][pad:1][len:u16be] -> len, or -1 if not RUPP
  _headerLen(datagram) {
    if (datagram.length < 4 || datagram[0] !== 1 || datagram[1] !== 0) return -1;
    const len = datagram[2] << 8 | datagram[3];
    return len < 4 || len > datagram.length ? -1 : len;
  }

  // Patch an OUTBOUND datagram's RUPP header: fill join/session token + rcc addr.
  outbound(datagram) {
    if (!this.join && !this.rcc) return datagram;
    const headerEnd = this._headerLen(datagram);
    if (headerEnd < 0) return datagram;
    for (let off = 4; off + 2 <= headerEnd;) {
      const type = datagram[off], len = datagram[off + 1];
      if (off + 2 + len > headerEnd) break;
      if (type === 1 && len === 17) {
        // only the ver-1 join token is proven zeroed — patch it. ver-2 slots
        // carry the ROTATED session token the engine itself harvested from the
        // replies it consumes; overwriting with our copy races stale.
        const ver = datagram[off + 2];
        if (ver === 1 && this.join) datagram.set(this.join, off + 3);
      } else if (type === 2 && len === 6 && this.rcc) {
        // spec: TLV2 = rcc_ip + NetStackPort — the engine writes the wrong
        // (data) port; UDMux drops the packet without the netstack channel
        const port = this.rcc.netstack || this.dataPort;
        datagram.set(this.rcc.addr, off + 2);
        datagram[off + 6] = port >> 8;
        datagram[off + 7] = port & 255;
      }
      off += 2 + len;
    }
    return datagram;
  }

  // Read an INBOUND datagram's RUPP header: harvest the assigned session token.
  inbound(datagram) {
    const headerEnd = this._headerLen(datagram);
    if (headerEnd < 0) return;
    for (let off = 4; off + 2 <= headerEnd;) {
      const type = datagram[off], len = datagram[off + 1];
      if (off + 2 + len > headerEnd) return;
      if (type === 1 && len === 17 && datagram[off + 2] === 2) {
        this.session = datagram.slice(off + 3, off + 19);
        return;
      }
      off += 2 + len;
    }
  }

  summary() {
    return `join=${this.join ? 'yes' : 'NO'} session=${this.session ? 'yes' : 'no'} ` +
      `rcc=${this.rcc ? this.rcc.addr.join('.') + ':' + this.rcc.netstack : 'none'} ` +
      `dataPort=${this.dataPort || 'none'}`;
  }
}

// ============================================================================
//  openUdpRelay — WebSocket -> UDP relay client
// ============================================================================
// Opens a ws to the relay, does the hello/ack handshake, then issues a STREAM
// open for (host,port). Returns a socket { send, close, onDatagram, onClose }.
async function openUdpRelay({ relayUrl, host, port }) {
  const target = `${host}:${port}`;
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    ws.binaryType = 'arraybuffer';
    let state = 'connecting';            // connecting -> handshake -> open
    const sock = {
      closed: false,
      onDatagram: null,
      onClose: null,
      async send(d) {
        if (sock.closed || ws.readyState !== 1) return;
        // relay msgMode expects [MSG_DATA][sid u32le][payload]
        const f = new Uint8Array(5 + d.length);
        f[0] = MSG_DATA;
        f[1] = STREAM_ID & 255; f[2] = (STREAM_ID >> 8) & 255; f[3] = (STREAM_ID >> 16) & 255; f[4] = (STREAM_ID >> 24) & 255;
        f.set(d, 5);
        ws.send(f);
      },
      close() {
        if (sock.closed) return;
        sock.closed = true;
        try { ws.close(); } catch {}
      },
      _deliver(d) { sock.onDatagram?.(d); },
      _end(msg) {
        if (sock.closed) return;
        sock.closed = true;
        try { ws.close(); } catch {}
        sock.onClose?.(msg);
      },
    };
    ws.onopen = () => { state = 'handshake'; };
    ws.onmessage = (m) => {
      const frame = new Uint8Array(m.data);
      if (frame.length < 5) return;
      const type = frame[0];
      const sid = (frame[1] | frame[2] << 8 | frame[3] << 16 | frame[4] << 24) >>> 0;
      if (type === MSG_HELLO) {                       // server hello -> ack
        if (state === 'handshake') ws.send(new Uint8Array([MSG_HELLO, 0, 0, 0, 0, 0]));
        return;
      }
      if (type === MSG_ACK) {                         // ack -> send stream open
        if (state === 'handshake') {
          state = 'open';
          const enc = new TextEncoder();
          const open = new Uint8Array(5 + 3 + host.length);
          open[0] = MSG_OPEN;
          open[1] = STREAM_ID & 255;
          open[5] = 2;                                // addr format: ipv4/host
          open[6] = port & 255;
          open[7] = port >> 8;
          open.set(enc.encode(host), 8);
          ws.send(open);
          resolve(sock);
        }
        return;
      }
      if (type === MSG_DATA) {                        // datagram -> engine
        if (sid === STREAM_ID && state === 'open' && !sock.closed)
          sock._deliver(frame.subarray(5));
        return;
      }
      if (type === MSG_REFUSE) {
        sock._end(`stream refused (${frame.length > 5 ? frame[5] : 0})`);
      }
    };
    ws.onerror = () => sock._end('websocket error');
    ws.onclose = (e) => {
      if (state !== 'open') reject(new Error(`ws closed during handshake (${e.code})`));
      else sock._end(`websocket closed (${e.code} ${e.reason})`);
    };
    setTimeout(() => {
      if (state !== 'open') {
        try { ws.close(); } catch {}
        reject(new Error(`udp relay open timeout to ${target}`));
      }
    }, 8000);
  });
}

// ============================================================================
//  startSocketPump — ring buffer <-> relay pump
// ============================================================================
// abi: the shared-memory socket ABI layout (engine.json):
//   txHead +4  txTail +8  rxHead +12  rxTail +16  wake +20  selects +24
//   recvd +28  addr +32  peer +48  updates +52  tx0 +128  rx0 +98432
//   slot +1536 slots=64 maxDatagram=1500
// All ring indices are WORD (>>2) indices into an Int32Array view of the abi.
const RELAY_WS = (typeof location !== "undefined" ? location.origin.replace(/^http/, "ws") : "ws://localhost:9989") + "/udp-relay";

export function startSocketPump({ memory, abi, openUdp, joinScript, trace, gate, gateToken }) {
  const log = s => trace?.(s);
  const widx = v => v >> 2;            // byte offset -> int32 index
  const udpOpen = openUdp || ((h, p) => openUdpRelay({ relayUrl: RELAY_WS, host: h, port: p }));
  const rupp = new Rupp();

  // ---- gate attestation mailbox (REVERSED): the proxy writes the verdict
  // into the mailbox; the engine's poller CAS-claims state 0->2 then reads a
  // result (1 or 3). Default result 3 (len in [12,256], msg[0:8]!=base+544:548).
  let gateLastState = -1, gatePosts = 0;
  function postGate() {
    if (!gate || !gate.base || !memory) return;
    try {
      const i32 = new Int32Array(memory.buffer, gate.base, 160);
      const st = Atomics.load(i32, widx(gate.state || 0));
      const len = Atomics.load(i32, widx(gate.len || 4));
      if (st !== gateLastState) { gateLastState = st; log(`gate state -> ${st} len=${len}`); }
      if (len === 0 && st === 0) {                 // engine is waiting -> post verdict
        const tok = new TextEncoder().encode(gateToken || 'ok');
        const msg = new Uint8Array(memory.buffer, gate.base + (gate.msg || 72), gate.msgMax || 256);
        msg.fill(0); msg.set(tok.slice(0, gate.msgMax || 256));
        const L = Math.min(Math.max(tok.length, 12), gate.msgMax || 256);
        Atomics.store(i32, widx(gate.len || 4), L); // len!=0 + state==0 -> engine claims
        if (++gatePosts <= 3) log(`gate verdict posted (len=${L})`);
      }
    } catch (e) {}
  }

  // ring word indices (>>2) for the ABI fields
  const WI = {
    magic: widx(abi.magic), txHead: widx(abi.txHead), txTail: widx(abi.txTail),
    rxHead: widx(abi.rxHead), rxTail: widx(abi.rxTail), wake: widx(abi.wake),
  };
  const SLOT = abi.slot, SLOTS = abi.slots, MASK = SLOTS - 1, MAX_DG = abi.maxDatagram;
  const RING_LEN = Math.max(abi.rx0 + SLOTS * SLOT, abi.tx0 + SLOTS * SLOT, abi.addr + 16);

  const stats = { tx: 0, rx: 0, started: 0, errors: 0 };
  // page-side telemetry: loading screen polls rx to know when the world
  // stream has settled before revealing the game
  if (typeof window !== 'undefined') window.__pumpStats = stats;
  let state = 'waiting', sock = null, dest = null, lastJoin = null, dead = false, timer = null;
  let lastRing = null, lastDest = null;

  // view of the ABI shared-memory region; stamps our sentinel.
  // cached — the SAB never detaches/resizes, so re-viewing it at 500Hz was
  // pure GC churn for identical views.
  let ringViews = null;
  function ring() {
    const buf = memory.buffer;
    if (buf.byteLength < abi.base + RING_LEN) return null;
    if (!ringViews) ringViews = {
      i32: new Int32Array(buf, abi.base, RING_LEN >> 2),
      u8: new Uint8Array(buf, abi.base, RING_LEN),
    };
    Atomics.store(ringViews.i32, WI.magic, RING_MAGIC);
    return ringViews;
  }

  // the dest to connect to: engine's requested sockaddr in the ring — but a
  // loopback/empty peer means the engine resolved our minted 'localhost' name;
  // the real target is the udmux endpoint from the join session.
  function peer(v) {
    for (const off of [abi.addr, abi.peer]) {
      const q = v.u8.slice(off, off + 16);
      if (q.length >= 8 && (q[0] | q[1] << 8) === 2 && (q[4] | q[5] | q[6] | q[7]) !== 0) {
        const d = { host: `${q[4]}.${q[5]}.${q[6]}.${q[7]}`, port: q[2] << 8 | q[3] };
        // loopback/bogus/partial sockaddrs (127.x, 0.0.0.0, 1.x) mean the engine
        // resolved our minted name — the real target is the session's udmux.
        if (/^(127|0|1)\./.test(d.host)) break;
        if (d !== lastDest) { lastDest = d; log(`peer <- ring @+${off - abi.base}: ${d.host}:${d.port}`); }
        return d;
      }
    }
    const udmux = joinScript()?.UdmuxEndpoints?.[0];
    return udmux?.Address && udmux?.Port ? { host: udmux.Address, port: udmux.Port } : null;
  }

  // relay -> engine RX ring (and harvest RUPP session token)
  function deliver(dg) {
    // cap by the real slot capacity, not abi.maxDatagram — a max-mtu QUIC
    // packet + its 31B RUPP wrapper exceeds maxDatagram and was being dropped
    // (relay saw 19 rx but the ring only got 10 — the dropped flights stalled
    // the handshake at the same point every run)
    if (!sock || state !== 'open' || !dg.length || dg.length > SLOT - 4) return;
    rupp.inbound(dg);
    const v = lastRing; if (!v) return;
    const head = Atomics.load(v.i32, WI.rxHead), tail = Atomics.load(v.i32, WI.rxTail);
    if ((head - tail | 0) >= SLOTS) return;
    const off = abi.rx0 + (head & MASK) * SLOT;
    v.u8.set(dg, off + 4);
    Atomics.store(v.i32, widx(off), dg.length);
    Atomics.store(v.i32, WI.rxHead, head + 1 | 0);
    Atomics.notify(v.i32, WI.wake, 1);
    stats.rx++;
  }

  // engine TX ring -> relay (wrap datagrams in RUPP first)
  async function txPump(v, s) {
    let tail = Atomics.load(v.i32, WI.txTail);
    const head = Atomics.load(v.i32, WI.txHead);
    let sent = 0;
    for (; tail !== head && !dead && state === 'open';) {
      const off = abi.tx0 + (tail & MASK) * SLOT;
      const len = Atomics.load(v.i32, widx(off));
      if (!len || len > MAX_DG) break;
      s.send(rupp.outbound(v.u8.slice(off + 4, off + 4 + len)));   // engine leaves join-token slot zeroed — patch it
      stats.tx++; sent++;
      tail = tail + 1 | 0;
      Atomics.store(v.i32, WI.txTail, tail);
    }
    return sent;
  }

  // open the UDP relay to the dest, then register the socket in the ABI so the
  // engine's connect()/select() see it: peer addr + ready flag + wake.
  async function open(d) {
    state = 'opening'; dest = d;
    try {
      const s = await udpOpen(d.host, d.port);
      if (dead) { s.close(); return; }
      sock = s; state = 'open'; stats.started++;
      s.onDatagram = deliver;
      s.onClose = e => { if (!dead) { state = 'closed'; log(`socket closed: ${e}`); stopSock(); } };
      const v = ring();
      if (v) {
        lastRing = v;
        try {
          // peer sockaddr (AF_INET)
          v.u8.fill(0, abi.peer, abi.peer + 16);
          v.u8[abi.peer] = 2; v.u8[abi.peer + 1] = 0;
          v.u8[abi.peer + 2] = d.port >> 8; v.u8[abi.peer + 3] = d.port & 255;
          v.u8.set(d.host.split('.').map(Number), abi.peer + 4);
          // selects is a POINTER — the engine's select() stores *selects=1 to
          // mark the socket ready. Point it at a free slot (base+60 < tx0@128).
          if (!Atomics.load(v.i32, widx(abi.selects))) {
            Atomics.store(v.i32, widx(60), 0);
            Atomics.store(v.i32, widx(abi.selects), abi.base + 60);
          }
          Atomics.store(v.i32, widx(abi.updates), (Atomics.load(v.i32, widx(abi.updates)) || 0) + 1);
          Atomics.store(v.i32, WI.wake, 1);
          Atomics.notify(v.i32, WI.wake, 1);
          log(`udp open -> ${d.host}:${d.port} (registered)`);
        } catch (e) { log('register err ' + e.message); }
      } else log(`udp open -> ${d.host}:${d.port} (no ring)`);
    } catch (e) {
      stats.errors++; state = 'waiting'; log(`udp open failed: ${e.message || e}`);
    }
  }

  function stopSock() {
    const s = sock; sock = null;
    if (s) { s.onDatagram = null; s.onClose = null; s.close(); }
  }

  // main loop: post gate verdict, sync joinScript, open/pump the socket
  async function tick() {
    if (dead) return;
    try {
      postGate();
      const v = ring();
      if (v) {
        lastRing = v;
        const js = joinScript();
        if (js !== lastJoin) { lastJoin = js; rupp.setJoinScript(js); log(`rupp: ${rupp.summary()}`); }
        if (state === 'waiting') { const d = peer(v); if (d) open(d); }
        else if (state === 'open' && sock) await txPump(v, sock);
      }
    } catch (e) { stats.errors++; }
    if (!dead && state !== 'closed' && state !== 'failed')
      timer = setTimeout(tick, state === 'open' ? 2 : 10);
  }

  // ring dump — shows what the engine actually writes into the ABI.
  // diagnostics only — off unless ?rhdebug=1 / rh.debug is set; the 400ms
  // stringification is main-thread cost for nothing during gameplay
  let lastDump = '';
  const dumpOn = typeof location !== 'undefined' &&
    (/[?&]rhdebug=1/.test(location.search) || (typeof localStorage !== 'undefined' && localStorage.getItem('rh.debug')));
  const dumpT = dumpOn && setInterval(() => {
    if (dead) { clearInterval(dumpT); return; }
    const v = lastRing; if (!v) return;
    const g = o => Atomics.load(v.i32, widx(o)) >>> 0;
    const s = `txH=${g(abi.txHead)} txT=${g(abi.txTail)} rxH=${g(abi.rxHead)} rxT=${g(abi.rxTail)} ` +
      `wake=${g(abi.wake)} sel=0x${g(abi.selects).toString(16)} recvd=${g(abi.recvd)} upd=${g(abi.updates)} ` +
      `addr=${v.u8[abi.addr + 4]}.${v.u8[abi.addr + 5]}.${v.u8[abi.addr + 6]}.${v.u8[abi.addr + 7]}:${(v.u8[abi.addr + 2] << 8) | v.u8[abi.addr + 3]} ` +
      `peer=${v.u8[abi.peer + 4]}.${v.u8[abi.peer + 5]}.${v.u8[abi.peer + 6]}.${v.u8[abi.peer + 7]}:${(v.u8[abi.peer + 2] << 8) | v.u8[abi.peer + 3]} st=${state}`;
    if (s !== lastDump) { lastDump = s; log(`[ring] ${s}`); }
  }, 400);

  timer = setTimeout(tick, 0);
  // txprobe: engine TX-ring drain vs relay delivery, 5s cadence — if tx
  // flatlines while rx climbs, the engine stopped writing to the ring
  const txpT = setInterval(() => {
    if (dead) { clearInterval(txpT); return; }
    try { fetch("/__txp", { method: "POST", body: `tag=pump t=${(performance.now() / 1000) | 0} tx=${stats.tx} rx=${stats.rx} err=${stats.errors} st=${state}` }).catch(() => {}); } catch (e) {}
  }, 5000);
  return {
    stop() { dead = true; clearTimeout(timer); clearInterval(txpT); stopSock(); },
    stats() { return { ...stats, state, dest, rupp: rupp.summary() }; },
  };
}
