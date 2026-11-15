// relay.js — WebSocket -> UDP/TCP relay. The browser can't open raw UDP, so the
// engine's datagram/websocket traffic terminates here and gets forwarded.
//
// Mounts on the main https server as a ws upgrade on /udp-relay.
//
// Modes (chosen by query params + first client frame):
//   ?to=<host>:<port>&proto=tcp   raw TCP bridge (engine WebSocket tunnel)
//   ?to=<host>:<port>&proto=udp   frame mode: [0]=datagram, [1|2|3]=stream ops
//   ?proto=udp                    same, target = last captured session endpoint
//   (no params)                   MSG_* handshake mode:
//                                 server HELLO[5] -> client HELLO[5] ->
//                                 server ACK[3] -> client OPEN[1,sid,ver,port,host]
//                                 -> DATA[2,sid,payload] both ways
const dgram = require('dgram');
const net = require('net');
const path = require('path');
const child_process = require('child_process');
const ws = require('./lib/ws');
const session = require('./lib/session');

const MSG_OPEN = 1, MSG_DATA = 2, MSG_ACK = 3, MSG_REFUSE = 4, MSG_HELLO = 5;
const STREAM_ID = 1;

// inbound traffic telemetry — the page polls /stats to know when the
// world stream has settled before revealing the game
const stats = { rxBytes: 0, rxMsgs: 0, at: 0 };

class FrameDecoder {
  constructor(maxFrameSize = 16 * 1024 * 1024) {
    this.maxFrameSize = maxFrameSize;
    this.chunks = [];
    this.buffered = 0;
  }

  _take(n) {
    if (n === 0) return Buffer.alloc(0);
    if (this.chunks[0].length >= n) {
      const data = this.chunks[0].subarray(0, n);
      this.chunks[0] = this.chunks[0].subarray(n);
      this.buffered -= n;
      if (!this.chunks[0].length) this.chunks.shift();
      return data;
    }
    const parts = [];
    let left = n;
    while (left) {
      const head = this.chunks[0];
      const used = Math.min(left, head.length);
      parts.push(head.subarray(0, used));
      this.chunks[0] = head.subarray(used);
      if (!this.chunks[0].length) this.chunks.shift();
      left -= used;
    }
    this.buffered -= n;
    return Buffer.concat(parts, n);
  }

  push(chunk) {
    if (chunk.length) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    const frames = [];
    while (this.buffered >= 4) {
      const header = this._take(4);
      const length = header.readUInt32LE(0);
      if (length > this.maxFrameSize) {
        this.chunks.unshift(header);
        this.buffered += 4;
        throw new RangeError(`invalid bridge frame length ${length}`);
      }
      if (this.buffered < length) {
        this.chunks.unshift(header);
        this.buffered += 4;
        break;
      }
      frames.push(this._take(length));
    }
    return frames;
  }
}

const frame = (t, sid, payload) =>
  Buffer.concat([Buffer.from([t]), Buffer.from([sid & 255, (sid >> 8) & 255, (sid >> 16) & 255, (sid >> 24) & 255]), payload]);

function parseTarget(u) {
  const to = u.searchParams.get('to');
  if (to) {
    const m = to.match(/^([a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d+))?$/i);
    if (m) {
      let host = m[1].replace(/^\[|\]$/g, '');
      // ipHostSuffix names (128-116-2-33.<fqdn>) -> dotted ipv4
      const ipm = host.match(/^(\d+)-(\d+)-(\d+)-(\d+)\./);
      if (ipm) host = ipm.slice(1, 5).join('.');
      // synthesized qdmux name <secret>-<rcc>-<port>.<ip_hex>.qdmux.<upstream>
      // — the label before .qdmux is the udmux ip in hex (domains/gamejoin.js)
      const qm = host.match(/\.([0-9a-f]{8})\.qdmux\.roblox\.com$/i);
      if (qm) { const h = qm[1]; host = [0, 2, 4, 6].map(i => parseInt(h.slice(i, i + 2), 16)).join('.'); }
      const path = u.searchParams.get('path');
      return { host, port: +(m[2] || 80), path };
    }
  }
  const t = session.datagramTarget();
  return t ? { host: t.ip, port: t.port } : null;
}

// ---- TCP bridge -------------------------------------------------------------
function bridgeTcp(conn, target) {
  // the engine dials <domain>.localhost:<realport> via its own tcp layer —
  // loop subdomain targets back to this server so handleApi/specials answer
  // them (e.g. assetdelivery ?hash= fetches we serve locally)
  let host = target.host, port = target.port;
  if (/\.localhost$/i.test(host)) { host = '127.0.0.1'; port = 9989; }
  const tcp = net.connect(port, host);
  tcp.on('connect', () => console.log(`[relay] tcp -> ${host}:${port}`));
  tcp.on('data', d => conn.send(d));
  tcp.on('error', e => { console.log(`[relay] tcp err ${e.message}`); conn.close(); });
  tcp.on('close', () => conn.close());
  conn.on('message', d => { try { tcp.write(d); } catch {} });
  conn.on('close', () => tcp.destroy());
}

// ---- UDP socket + pump (shared by frame + MSG modes) -------------------------
function bindUdp(conn, host, port, wrap) {
  const udp = dgram.createSocket('udp4');
  udp.on('message', data => { try { conn.send(wrap(data)); rxCount++; if (rxCount < 30) console.log(`[relay] udp <- ${data.length}B (rx#${rxCount}) ${data.subarray(0, 60).toString('hex')}`); } catch {} });
  udp.on('error', e => console.log(`[relay] udp err ${e.message}`));
  conn.on('close', () => { try { udp.close(); } catch {} });
  // rbx_client.py: the real dial target is udmux_ip : NetStackPort — the
  // session's machine.port IS NetStackPort; the joinScript's udmux.Port is a
  // different service. Prefer it, fall back to the engine's requested port.
  const s = session.last();
  const ports = [s && s.machine && s.machine.port || port];
  console.log(`[relay] udp -> ${host}:${ports.join('/')}`);
  let rxCount = 0, txCount = 0;
  return { send: payload => { try { for (const p of ports) udp.send(payload, p, host); if (txCount < 20) { txCount++; console.log(`[relay] udp -> ${host}:${ports.join('/')} ${payload.length}B (tx#${txCount}) ${payload.subarray(0, 60).toString('hex')}`); } } catch {} } };
}

// frame mode: WT shim frames -> the python QUIC bridge. The engine's
// WebTransport needs a REAL QUIC endpoint — streams can't ride raw UDP — so
// we spawn quic_bridge.py (aioquic, ALPN RbxTransport, RUPP wrap) and pipe
// frames: ws -> stdin (u32le len prefix), stdout -> ws.
function frameMode(conn, target) {
  // the WT ws opens before /gamejoin returns — wait for the joinScript to land
  // instead of dropping the connection (session.last is a getter function)
  const jsOf = () => { const s = session.last && session.last(); return s && s.joinScript; };
  if (!jsOf()) {
    let tries = 0;
    const wait = setInterval(() => {
      if (jsOf()) {
        clearInterval(wait);
        if (!conn.closed) frameMode(conn, target);
      } else if (++tries > 300 || conn.closed) {   // ~15s
        clearInterval(wait);
        try { conn.close(); } catch {}
      }
    }, 50);
    conn.on('close', () => clearInterval(wait));
    return;
  }
  const js = jsOf();
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const py = child_process.spawn(python, [path.join(__dirname, 'quic_bridge.py')], {
    // The WASM engine solves its own 0xf8 challenge. Keep the external bridge
    // solver opt-in; the Boblox solver/runtime are not bundled with Webport.
    env: { ...process.env, NO_9B: process.env.NO_9B || '1', JOIN_SCRIPT: JSON.stringify(js), WT_PATH: (target && target.path) || '/wt' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  // Stream errors are emitted async — a try/catch around write() cannot see
  // them. A bridge that exits (idle timeout, crash) leaves stdin dead; the
  // next engine frame written to it raises EPIPE on the Socket, and an
  // unhandled 'error' event takes down the entire relay process (every
  // session's ws drops 1006, new connections refused).
  py.stdin.on('error', () => {});
  py.stdout.on('error', () => {});
  py.on('error', e => { console.log('[relay] bridge spawn failed:', e.message); conn.close(); });
  py.on('exit', (c, signal) => { console.log(`[relay] bridge exited (code=${c}, signal=${signal || 'none'})`); try { conn.close(); } catch {} });
  conn.on('close', () => { console.log(`[relay] WT websocket closed hadError=${conn._closeHadError} err=${conn._lastError && conn._lastError.message}`); try { py.kill(); } catch {} });
  console.log(`[relay] bridge spawned for ${target ? target.host + ':' + target.port : 'session'}`);

  // ws -> bridge stdin (u32le len-prefixed)
  let clientFrameCount = 0;
  conn.on('message', d => {
    if (clientFrameCount++ < 12) console.log(`[relay] WT client frame type=${d[0]} len=${d.length}`);
    const packet = Buffer.allocUnsafe(4 + d.length);
    packet.writeUInt32LE(d.length, 0);
    d.copy(packet, 4);
    try { py.stdin.write(packet); } catch {}
  });

  // bridge stdout -> ws (same frame format back)
  // Keep stdout chunks segmented. Concatenating the entire partial-frame
  // buffer on each pipe event is quadratic for a frame split over many reads.
  const decoder = new FrameDecoder();
  let bridgeFrameCount = 0;
  py.stdout.on('data', chunk => {
    stats.rxBytes += chunk.length; stats.rxMsgs++; stats.at = Date.now();
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch (e) {
      if (e instanceof RangeError) {
        console.error(`[relay] ${e.message}; closing session`);
        conn.close();
        try { py.kill(); } catch {}
        return;
      }
      throw e;
    }
    for (const frame of frames) {
      if (bridgeFrameCount++ < 12) console.log(`[relay] WT bridge frame type=${frame[0]} len=${frame.length}`);
      // datagrams (type 0) are the lossy plane — position/physics updates.
      // If TCP backs up, queueing them delivers STALE state seconds late =
      // rubber banding. Drop like real UDP instead; streams stay ordered.
      if (frame[0] === 0 && conn.socket && conn.socket.writableLength > 262144) continue;
      try { conn.send(frame); } catch {}
    }
  });
}

// raw UTP mode (engine DebugUTPLauncherWebSocketUri path — serve.py model):
// every ws binary message is a UDP datagram. Emscripten may prepend a
// sockaddr_in header (family u16 LE 0x0002, port u16 BE, addr u32 BE, pad):
// unwrap it to learn dst + framing, wrap replies the same way.
// In practice this socket only ever carries the engine's StunPopProbe /
// PopUdpProbe bursts — ancillary latency probes aimed at the udmux service
// port (UdmuxEndpoints.Port), never at the session's NetStack channel.
function rawUdpMode(conn, target) {
  if (!target) return conn.close();
  const udp = dgram.createSocket('udp4');
  let framing = 0;                       // 0=raw, 8/16=sockaddr header len
  let rxCount = 0, txCount = 0;
  udp.on('message', (data, rinfo) => {
    let payload = data;
    if (framing) {
      const hdr = Buffer.alloc(framing);
      hdr.writeUInt16LE(2, 0);                       // AF_INET
      hdr.writeUInt16BE(rinfo.port, 2);              // src port, BE
      const p = rinfo.address.split('.');            // src ip, BE
      hdr[4] = +p[0]; hdr[5] = +p[1]; hdr[6] = +p[2]; hdr[7] = +p[3];
      payload = Buffer.concat([hdr, data]);
    }
    try { conn.send(payload); } catch {}
    if (rxCount < 6) { rxCount++; console.log(`[relay] utp <- ${data.length}B`); }
  });
  udp.on('error', e => console.log(`[relay] utp err ${e.message}`));
  conn.on('close', () => { try { udp.close(); } catch {} });
  console.log(`[relay] utp -> ${target.host}:${target.port}`);

  function unwrap(payload) {
    // sockaddr_in-prefixed datagram -> real dst lives inside the header
    if (payload.length > 16 && payload[0] === 2 && payload[1] === 0) {
      const port = payload.readUInt16BE(2);
      const addr = `${payload[4]}.${payload[5]}.${payload[6]}.${payload[7]}`;
      if (port > 0 && addr !== '0.0.0.0') {
        const hdrLen = payload.subarray(8, 16).equals(Buffer.alloc(8)) ? 16 : 8;
        return { ip: addr, port, data: payload.subarray(hdrLen), hdrLen };
      }
    }
    return { ip: target.host, port: target.port, data: payload, hdrLen: 0 };
  }

  conn.on('message', d => {
    const { ip, port, data, hdrLen } = unwrap(d);
    if (!framing) framing = hdrLen;
    // Forward the datagram raw, to ONE destination: the sockaddr-declared
    // port, else the udmux service port. Never to the session's NetStackPort —
    // the old code RUPP-wrapped probes (subtype-2 + join token + TLV2 naming
    // the RCC netstack) and sprayed a copy at the live session port, which is
    // a foreign packet on the session's receive path — the same class of
    // failure as the `01 08000001 00000001 04` / DisconnectReceivePacketError
    // teardown the RCC sends ~20-60s in. An unanswered probe is harmless.
    // NO_UTP=1 drops this channel entirely for A/B.
    if (process.env.NO_UTP) return;
    // shape gate: only edge-bound payloads may leave. sockaddr-prefixed probe
    // bursts (hdrLen) name their own dest; bare payloads must be RUPP
    // datagrams ([01 00][u16be len]). Anything else on this socket is
    // launcher-protocol traffic — the engine's UTS {"type":"handshake",...}
    // speaks to DebugUTPLauncherWebSocketUri, NOT the edge; forwarding it raw
    // to the session port is a foreign packet that draws DisconnectReceive-
    // PacketError ~30-60s in (verified live 2026-11-10).
    if (!hdrLen && !(data.length >= 4 && data[0] === 1 && data[1] === 0 &&
                     data.readUInt16BE(2) >= 4 && data.readUInt16BE(2) <= data.length)) {
      // launcher-protocol JSON gets a local answer, not a drop: the engine's
      // TestServiceConnectionManager gates its post-handshake work on
      // "WS handshake acknowledged; link ready" — {type:X} is answered with
      // {type:"<X>_acked"} (handshake_acked/stream_switch_acked strings in
      // the binary). An unanswered handshake leaves the channel dead.
      const txt = data.toString('utf8');
      let j = null;
      try { if (txt[0] === '{') j = JSON.parse(txt); } catch {}
      if (j && typeof j.type === 'string') {
        const reply = JSON.stringify({ type: `${j.type}_acked`, executionId: j.executionId, payload: j.payload || {} });
        try { conn.send(Buffer.from(reply)); } catch {}
        console.log(`[relay] utp answered ${j.type} -> ${reply.slice(0, 80)}`);
        return;
      }
      if (txCount < 6) { txCount++; console.log(`[relay] utp drop ${data.length}B ${/^[\x20-\x7e]+$/.test(txt) ? txt : data.subarray(0, 24).toString('hex')} (not sockaddr/RUPP)`); }
      return;
    }
    const s = session.last();
    const destPort = port || (s && s.udmux && s.udmux.port);
    if (!destPort) return;
    if (txCount < 6) { txCount++; console.log(`[relay] utp -> ${ip}:${destPort} ${data.length}B ${data.subarray(0, 24).toString('hex')}`); }
    udp.send(data, destPort, ip);
  });
}

// MSG_* handshake mode (transport-driver / engine-test protocol)
function msgMode(conn, helloSent) {
  if (!helloSent) conn.send(frame(MSG_HELLO, 0, Buffer.from([1])));
  let state = 'hello', udp = null;
  conn.on('message', d => {
    if (d.length < 5) return;
    const t = d[0];
    if (t === 7) { try { conn.send(d); } catch {} return; }   // stats-overlay RTT ping: echo verbatim
    if (state === 'hello') {
      if (t !== MSG_HELLO) return;
      state = 'open';
      return conn.send(frame(MSG_ACK, 0, Buffer.alloc(0)));
    }
    if (state === 'open' && t === MSG_OPEN) {
      const port = d[6] | d[7] << 8;
      const host = d.subarray(8).toString('utf8').replace(/\0.*$/, '');
      udp = bindUdp(conn, host, port, p => frame(MSG_DATA, STREAM_ID, p));
      state = 'data';
      return;
    }
    if (state === 'data' && t === MSG_DATA) udp?.send(d.subarray(5));
  });
}

function attach(server) {
  server.on('upgrade', (req, socket) => {
    const u = new URL(req.url, 'https://localhost');
    console.log(`[relay] upgrade attempt ${req.url.slice(0, 60)}`);
    if (u.pathname !== '/udp-relay') { socket.destroy(); return; }
    const conn = ws.accept(req, socket);
    if (!conn) { socket.destroy(); return; }
    console.log(`[relay] ws upgrade ${req.url.slice(0, 60)}`);
    const proto = u.searchParams.get('proto');
    const target = parseTarget(u);
    if (proto === 'tcp') return target ? bridgeTcp(conn, target) : conn.close();
    // framed udp (WT shim sends proto=udp; ?to= alone implies it too)
    if (proto === 'udp' || (proto === null && u.searchParams.has('to'))) return frameMode(conn, target);
    if (proto === 'msg') return msgMode(conn);
    // bare connection: sniff the first frame — MSG_HELLO [5,...] -> handshake
    // mode (driver pump); anything else -> raw UTP datagrams (engine's own
    // DebugUTPLauncherWebSocketUri socket)
    // send HELLO up-front — the pump waits for it before sending its own;
    // if we sniffed first instead we'd deadlock on each other's expectations.
    conn.send(frame(MSG_HELLO, 0, Buffer.from([1])));
    conn.once('message', d => {
      if (d.length >= 5 && d[0] === MSG_HELLO) {
        msgMode(conn, /*helloSent*/true);
        conn.emit('message', d);               // replay HELLO into msgMode
      } else {
        rawUdpMode(conn, target);
        conn.emit('message', d);               // replay first datagram
      }
    });
  });
}

module.exports = { attach, FrameDecoder, stats };
