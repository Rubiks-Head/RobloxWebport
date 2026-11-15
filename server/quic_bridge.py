#!/usr/bin/env python3
"""WebTransport -> QUIC bridge.

The wasm engine treats the browser's WebTransport as its QUIC transport; a ws
shim alone can't fake stream semantics over UDP, so this module IS the QUIC
endpoint. It runs merged in-process inside wt_server.py — Session feeds it
frames via feed()/wr() (see wt_server for the frame format):

    [0x00][data]           datagram
    [0x01][sid u32][data]  stream data (sid bit31 = unidirectional)
    [0x02][sid u32]        incoming-stream announce
    [0x03][sid u32]        stream close/reset

Join data arrives via set_join() in wtproxy mode (or the JOIN_SCRIPT env var
standalone — full upstream joinScript JSON; the server keeps the pristine
copy since NetStackPort etc. are stripped for the engine).

Wire format (verified against py/rbx_client.py + captures):
  dial    = udmux.Address : NetStackPort
  RUPP    = [01 00 u16be total][01 11 01 <16B NetStackTokenValue>]
            [02 06 <rcc ip 4B><NetStackPort u16be>] + QUIC packet
  QUIC    = aioquic, ALPN "RbxTransport", CERT_NONE, DATAGRAM frames on,
            SNI = {32-hex token}-{8hex rccIp}-{4hex rccPort}.{8hex vip}.{UP_QDMUX}
"""

import asyncio
import base64
import json
import os
import re
import socket
import ssl
import struct
import sys
import time
import urllib.parse

from aioquic.quic.configuration import QuicConfiguration
from aioquic.quic.connection import QuicConnection
from aioquic.quic.events import (
    HandshakeCompleted,
    ConnectionTerminated,
    ProtocolNegotiated,
    DatagramFrameReceived,
)
from aioquic.h3.connection import H3Connection
from aioquic.h3.events import (
    HeadersReceived,
    DataReceived,
    DatagramReceived,
    WebTransportStreamDataReceived,
)

# TLS custom extension 0xFF00 — RbxTransport capability exchange (Boblox
# FINDINGS: u64 LE bitmask in ClientHello, server echoes its own caps in
# EncryptedExtensions; common = local & remote is assigned to the Replicator).
# Native conn#0 asserts 0x002dd3c750b70892 (wire LE 9208b750c7d32d00), conn#1
# sends zeros. Without the ext a fail-closed server computes common=0 -> all
# client-authored ISR writes (0x1c/0x0e) are unauthorized -> delayed
# DisconnectReceivePacketError on the first physics/instance batch.
_Qconn_initialize = QuicConnection._initialize


def _qconn_initialize_caps(self, peer_cid):
    _Qconn_initialize(self, peer_cid)
    # merged wtproxy runs this module in the wt_server process — the patch
    # must NOT touch server-side conns or our EncryptedExtensions carry the
    # client-only 0xFF00 ext and Chrome aborts (UNEXPECTED_EXTENSION -> 279)
    if not self._is_client:
        return
    caps = getattr(self, "_rbxt_caps", None)
    if caps is None:
        # Assert the ENGINE's caps, not the native client's: the wasm build
        # advertises its own word in its CONNECT (WT_PATH carries
        # ?X-Rbx-Capabilities=<be64 hex>; wire form is the same 8 bytes LE).
        # Asserting native caps negotiates common = srv & native — a feature
        # set the engine never claimed; replication items in the wrong
        # format wedge the consumer ~45s in (frozen world, live wire).
        caps = bytes.fromhex("9208b750c7d32d00")
        try:
            q = urllib.parse.parse_qs(
                urllib.parse.urlparse(os.environ.get("WT_PATH") or "")
                .query)
            w = (q.get("X-Rbx-Capabilities") or [None])[0]
            if w and len(w) == 16:
                caps = bytes.fromhex(w)[::-1]
        except Exception:
            pass
    self.tls.handshake_extensions.append((0xFF00, caps))


QuicConnection._initialize = _qconn_initialize_caps

JOIN = json.loads(os.environ.get("JOIN_SCRIPT", "{}"))
# upstream host config — passed down from index.js via env; no upstream
# literals live in the source.
QDMUX_SUFFIX = os.environ.get("UP_QDMUX") or ("qdmux." + os.environ.get("UP_DOMAIN", ""))
WT_ORIGIN = os.environ.get("UP_WT_ORIGIN", "")


def set_join(js):
    """In-process mode (wtproxy): the caller owns session lifecycle and hands
    us the joinScript dict instead of a JOIN_SCRIPT env var. JOIN is read
    lazily inside functions, so replacing the dict object is enough."""
    JOIN.clear()
    JOIN.update(js or {})
_VERBOSE = os.environ.get("WEBPORT_BRIDGE_VERBOSE", "").strip().lower() in ("1", "true", "yes", "on")
_DROP_1C = os.environ.get("WEBPORT_DROP_1C", "0").strip() in ("1", "true", "yes", "on")
_NOISY_TRACE = re.compile(r"^(?:map shim-sid |quic stream .* -> new shim-sid |tx sid=|rx st |tx dg |rx dg |framed qid=)")
_trace_counts = {}


_T0 = time.monotonic()


def LOG(*parts):
    body = " ".join(str(part) for part in parts)
    if not _VERBOSE and _NOISY_TRACE.match(body):
        category = body.split(" ", 1)[0]
        count = _trace_counts.get(category, 0) + 1
        _trace_counts[category] = count
        if count > 4:
            if count == 5:
                print(f"[bridge] suppressing repeated {category} packet traces (set WEBPORT_BRIDGE_VERBOSE=1 to enable)", file=sys.stderr, flush=True)
            return
    print(f"[bridge +{time.monotonic() - _T0:6.1f}s]", body, file=sys.stderr, flush=True)

def _udmux(js):
    e = (js.get("UdmuxEndpoints") or [{}])[0]
    return e.get("Address"), int(e.get("Port") or 0)


def _rcc(js):
    conn = (js.get("ServerConnections") or [{}])[0]
    return conn.get("Address") or js.get("MachineAddress"), int(
        js.get("NetStackPort") or 0
    )


def _sni(js, udmux_ip, rcc_ip, rcc_port):
    tok = base64.b64decode(js.get("NetStackTokenValue") or js.get("TokenValue") or "").hex()
    rip = "".join(f"{int(x):02x}" for x in rcc_ip.split("."))
    vip = "".join(f"{int(x):02x}" for x in udmux_ip.split("."))
    return f"{tok}-{rip}-{rcc_port:04x}.{vip}.{QDMUX_SUFFIX}"


def _token(js):
    t = js.get("NetStackTokenValue") or js.get("TokenValue") or ""
    b = base64.b64decode(t)
    return b if len(b) == 16 else None


def _tune_quic(cfg):
    """Inbound throughput tuning — aioquic defaults choke bulk world data:
    max_data/max_stream_data=1MB means a 62MB world stalls 60+ times on
    flow-control window updates; reno under-performs cubic for bulk;
    1200B datagrams waste header bytes. Big windows so flow control
    never gates the receive path."""
    cfg.max_data = 64 * 1024 * 1024          # 64MB connection window
    cfg.max_stream_data = 16 * 1024 * 1024   # 16MB per-stream window
    cfg.congestion_control_algorithm = "cubic"


def _has_1c_batch(body):
    """True if the body carries a 1c replication-batch envelope: `1c`-first,
    or the signature `1c 00 <u32> ff 7f` embedded in a 23-clock/07 chain."""
    if not body:
        return False
    if body[0] == 0x1C:
        return True
    i = body.find(b"\xff\x7f")
    while i != -1:
        if i >= 6 and body[i - 6] == 0x1C and body[i - 5] == 0x00:
            return True
        i = body.find(b"\xff\x7f", i + 1)
    return False


def _has_1c_physics(body):
    """True if an 83-chain body carries client-physics item signatures:
    `0e`-first chains, or `05 <0x10-0x1f>` timing/transform items and
    `0e <00/01>` physics items anywhere inside (they ride within 1c batches).
    Byte-pair heuristic — over-dropping errs toward suppression, which is the
    safe direction for the A/B."""
    if not body:
        return False
    if body[0] == 0x0E:
        return True
    i = body.find(b"\x05")
    while i != -1:
        if i + 1 < len(body) and 0x10 <= body[i + 1] <= 0x1F:
            return True
        i = body.find(b"\x05", i + 1)
    j = body.find(b"\x0e")
    while j != -1:
        if j + 1 < len(body) and body[j + 1] in (0x00, 0x01):
            return True
        j = body.find(b"\x0e", j + 1)
    return False


def _has_low_ref_event(body):
    """True if the body has a `07 01 <u32>` event targeting a client-allocated
    instance id (<0x10000; server-assigned ids are in the millions)."""
    j = body.find(b"\x07\x01")
    while j != -1:
        if j + 6 <= len(body):
            ref = struct.unpack("<I", body[j + 2:j + 6])[0]
            if ref < 0x10000:
                return True
        j = body.find(b"\x07\x01", j + 1)
    return False


def _has_client_repl(body):
    """True if an 83-chain body carries client-instance/physics replication:
    a 1c batch envelope, 05/0e physics items, or a 07 event on a
    client-allocated id (they dangle once the creates in the 1c/0e plane are
    suppressed — they're the same family)."""
    return (_has_1c_batch(body) or _has_1c_physics(body)
            or _has_low_ref_event(body))


_1C_ENV = re.compile(rb"\x1c\x00....\xff\x7f", re.S)


def _u24(b, o):
    return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)


class _RaknetFramer:
    """RakNet datagram -> app messages. Ported from the native-verified
    grammar (Boblox/tools/raknet_rx_decode.py): datagram = [flags][u24 dg]
    then [flags][u16be bits][hdr][payload] messages; 0x40=reliable u24,
    0x20=ordered (u24 ordv + u8 chan), 0x10=sequenced u24, 0x08=+4B.
    Split reassembly keyed on (ordv|seq, split-id). Yields
    (type, chan, len) per complete message — inspection only."""
    def __init__(self):
        self.parts = {}

    def feed(self, d):
        out = []
        if len(d) < 4 or (d[0] & 0x60):
            return out          # ACK/NAK datagrams carry no app payload
        o = 4
        while o + 3 <= len(d):
            fl, bits = d[o], (d[o + 1] << 8) | d[o + 2]
            o += 3
            ordv = seq = chan = None
            if fl & 0x08:
                o += 4
            try:
                if fl & 0x40:
                    o += 3          # reliable msg u24
                if fl & 0x20:
                    ordv, chan = _u24(d, o), d[o + 3]
                    o += 4
                if fl & 0x10:
                    seq = _u24(d, o)
                    o += 3
            except IndexError:
                break
            n = bits // 8
            raw = d[o:o + n]
            o += n
            if len(raw) < n:
                break
            # split header: ordered u32be count|u16be id|u32be idx (10B, or the
            # RCC's short u8 count form 7B); sequenced always the 7B form
            split = None
            if fl & 0x40 and fl & 0x20 and len(raw) >= 10:
                c, sid = int.from_bytes(raw[:4], 'big'), int.from_bytes(raw[4:6], 'big')
                idx = int.from_bytes(raw[6:10], 'big')
                if 1 < c <= 4096 and idx < c:
                    split, raw = (c, sid, idx), raw[10:]
                else:
                    c, sid, idx = raw[0], int.from_bytes(raw[1:3], 'big'), \
                        int.from_bytes(raw[3:7], 'big')
                    if 1 < c <= 255 and idx < c:
                        split, raw = (c, sid, idx), raw[7:]
            elif fl & 0x40 and fl & 0x10 and len(raw) >= 7:
                c, sid, idx = raw[0], int.from_bytes(raw[1:3], 'big'), \
                    int.from_bytes(raw[3:7], 'big')
                if 1 < c <= 255 and idx < c:
                    split, raw = (c, sid, idx), raw[7:]
            if split:
                key = (ordv if ordv is not None else seq, split[1])
                self.parts.setdefault(key, [split[0], {}])[1][split[2]] = raw
                if len(self.parts[key][1]) == split[0]:
                    whole = b''.join(self.parts[key][1][i]
                                     for i in range(split[0]))
                    del self.parts[key]
                    out.append((whole[0], chan, len(whole)))
            elif raw:
                out.append((raw[0], chan, len(raw)))
        return out


def _unwrap_1c(body):
    """Splice items out of `1c 00 <i32> ff 7f` batch envelopes into the
    chain's item stream — the items inside are legal standalone; only the
    envelope is rejected (NO_1CENV result, 2026-11-11). The 8-byte signature
    is distinctive enough to scan the whole body safely (covers 1c-first
    chains and batches embedded in 07/23 chains). The other observed form —
    `1c 00 00` group tags — is NOT handled: it collides with ordinary item
    payload bytes (e.g. a 23-clock u32 can contain `1c 00 00`) and stays
    dropped. Returns the rewritten body, or None when nothing was stripped
    or only a bare `00` terminator remains (caller drops the chain)."""
    out = _1C_ENV.sub(b"", body)
    if out == body or not out or out == b"\x00":
        return None
    return bytes(out)


# ---------------------------------------------------------------------------
# RUPP datagram transport (from py/rbx_client.py — same wrap/strip)
# ---------------------------------------------------------------------------
class RuppTransport(asyncio.DatagramProtocol):
    def __init__(self, conn, rcc_ip, rcc_port, token):
        self.conn = conn
        self.rcc_ip = rcc_ip
        self.rcc_port = rcc_port
        self.token = token
        self.transport = None
        self.peer = None
        self.on_events = None
        self._timer = None
        self.session = None   # harvested session tag — only when _tag_mode
                              # opts back into harvesting (see below)
        # Outbound TLV1 tag policy (WEBPORT_RUPP_TAG): the inbound subtype-2
        # field is a rolling per-window tag the edge expects reflected back —
        # subtype-2 + the JOIN token is silently dropped (WT CONNECT ignored,
        # idle-kill ~30s -> client error 279); a 3-sighting-guarded tag lags a
        # full window (~1s) and starves the reliable channel ~40s in.
        #   latest (default) — echo the freshest subtype-2 tag received
        #   first            — adopt the first subtype-2 tag once (issued
        #                      session token per the grammar)
        #   join             — never harvest; subtype-2 + join token always
        self._tag_mode = os.environ.get(
            "WEBPORT_RUPP_TAG", "latest").strip().lower()
        self._taglog = 0
        self.rx_n = self.rx_b = self.tx_n = self.tx_b = 0   # wire-rate probe

    def _wrap(self, payload):
        # handshake-phase packets are subtype-1 + join token — the native's
        # "first encrypted datagram" form, and the only one the edge honors
        # before a session exists (stamping subtype-2 on the Initial gets it
        # dropped -> QUIC dies on Idle timeout). Post-handshake keeps the
        # subtype-2 session form; which tag rides in it is the
        # WEBPORT_RUPP_TAG policy (default: the freshest observed subtype-2
        # tag — the field is a rolling window tag the edge wants echoed).
        if getattr(self, "hs", False):
            tlv1 = bytes([1, 17, 2]) + self._tx_tag()
        else:
            # subtype-1 + join token — required on handshake-phase datagrams
            tlv1 = bytes([1, 17, 1]) + self.token
        tlv2 = bytes([2, 6]) + socket.inet_aton(self.rcc_ip) + struct.pack(">H", self.rcc_port)
        body = tlv1 + tlv2
        return bytes([1, 0]) + struct.pack(">H", 4 + len(body)) + body + payload

    def _tx_tag(self):
        # Post-handshake TLV1 tag: the freshest harvested subtype-2 tag,
        # falling back to the join token until the first server reply.
        return self.session or self.token

    @staticmethod
    def _strip(pkt):
        if len(pkt) < 4 or pkt[0] != 1:
            return None
        total = struct.unpack(">H", pkt[2:4])[0]
        if not (4 <= total <= len(pkt)):
            return None
        return pkt[total:]

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        self.rx_n += 1; self.rx_b += len(data)
        s = self._strip(data)
        if s is None:
            return
        # session-tag harvest — only when WEBPORT_RUPP_TAG asks for it; by
        # default nothing here runs and outbound echoes the join token
        harvest = (self._tag_mode == "latest"
                   or (self._tag_mode == "first" and self.session is None))
        if harvest:
            off, end = 4, struct.unpack(">H", data[2:4])[0]
            while off + 2 <= end and off + 2 <= len(data):
                t, l = data[off], data[off + 1]
                if off + 2 + l > len(data):
                    break
                if t == 1 and l == 17 and data[off + 2] == 2:
                    tok = bytes(data[off + 3:off + 19])
                    if tok != self.session:
                        self.session = tok
                        if self._taglog < 8:
                            self._taglog += 1
                            LOG(f"RUPP tag adopted[{self._tag_mode}] -> "
                                f"{tok.hex()[:12]}...")
                    break
                off += 2 + l
        self.conn.receive_datagram(s, self.peer, time.monotonic())
        self._drain()

    def error_received(self, exc):
        pass

    def connection_lost(self, exc):
        pass

    def _drain(self):
        if self.on_events:
            self.on_events()
        self.flush()

    def flush(self):
        if self.transport is None or self.peer is None:
            return
        now = time.monotonic()
        for data, _addr in self.conn.datagrams_to_send(now):
            w = self._wrap(data)
            self.transport.sendto(w, self.peer)
            self.tx_n += 1; self.tx_b += len(w)
        self._arm()

    def _arm(self):
        t = self.conn.get_timer()
        if t is None:
            return
        delay = max(0.0, t - time.monotonic())
        if self._timer:
            self._timer.cancel()
        self._timer = asyncio.get_event_loop().call_later(delay, self._on_timer)

    def _on_timer(self):
        self._timer = None
        self.conn.handle_timer(time.monotonic())
        self._drain()


# ---------------------------------------------------------------------------
# stdio framing
# ---------------------------------------------------------------------------
READBUF = bytearray()
WRITEBUF = bytearray()


OUT_SINK = None   # in-process mode: wr() delivers payloads straight to the
                  # owning Session instead of stdio-framing them


def wr(payload):
    # Callbacks execute on one event-loop thread. Batch all framed messages
    # emitted while draining a QUIC event, avoiding one pipe flush per packet.
    # flush_wr() runs synchronously before the datagram callback returns, so
    # WT_READY cannot be stranded behind an unscheduled async writer.
    if OUT_SINK is not None:
        OUT_SINK(payload)
        return
    WRITEBUF.extend(struct.pack("<I", len(payload)))
    WRITEBUF.extend(payload)


def flush_wr():
    if OUT_SINK is not None or not WRITEBUF:
        return
    out = sys.stdout.buffer
    out.write(WRITEBUF)
    out.flush()
    WRITEBUF.clear()


async def reader():
    loop = asyncio.get_event_loop()
    while True:
        data = await loop.run_in_executor(None, sys.stdin.buffer.read1, 65536)
        if not data:
            return
        READBUF.extend(data)
        while len(READBUF) >= 4:
            n = struct.unpack("<I", READBUF[:4])[0]
            if len(READBUF) < 4 + n:
                break
            yield_frame(READBUF[4:4 + n])
            del READBUF[:4 + n]


FRAME_Q = asyncio.Queue()


def yield_frame(f):
    FRAME_Q.put_nowait(bytes(f))


# ---------------------------------------------------------------------------
# bridge
# ---------------------------------------------------------------------------
def _cvarint(v):
    if v < 0x40:
        return bytes([v])
    if v < 0x4000:
        return struct.pack(">H", 0x4000 | v)
    return struct.pack(">I", 0x80000000 | v)


class _RxFrames:
    """Streaming view of one server->client channel stream.

    Wire layout: [06 01 <app> <chan u32be>] preamble, then
    [cvarint len][type][payload]* where len counts type+payload. Tracks frame
    boundaries across arbitrary QUIC chunking so the chan-1 challenge's wire
    type byte (0xf8) can be flipped to the type the engine's dispatcher keys
    on (0x9b) — a single byte, in place, wherever the chunking puts it.
    """
    PRE = 7

    def __init__(self):
        self.on_frame = None     # (chan, wire_type, frame_len) post-mortem hook
        self.pre = bytearray()   # preamble accumulator (first 7 stream bytes)
        self.chan = -1
        self.hdr = bytearray()   # accumulating varint frame header
        self.need = 0            # header size once the first byte is seen
        self.left = 0            # frame bytes remaining after the header
        self.at_type = False     # next byte is a frame's type byte

    def feed(self, data):
        # Inspection only — frame-boundary walk for the post-mortem ring;
        # bytes pass through untouched.
        d = data
        i, n = 0, len(d)
        while i < n:
            if len(self.pre) < self.PRE:
                k = min(self.PRE - len(self.pre), n - i)
                self.pre += d[i:i + k]
                i += k
                if len(self.pre) == self.PRE:
                    self.chan = struct.unpack(">I", self.pre[3:7])[0]
                continue
            if self.at_type:                 # next byte is the frame's type byte
                if self.on_frame:
                    try:
                        self.on_frame(self.chan, d[i], self.left)
                    except Exception:
                        pass
                self.at_type = False
                self.left -= 1               # left now counts payload only
                i += 1
                continue
            if self.left:                    # inside a frame's payload
                k = min(self.left, n - i)
                self.left -= k
                i += k
                continue
            self.hdr.append(d[i])
            i += 1
            if not self.need:
                self.need = 1 if self.hdr[0] < 0x40 else 2 if self.hdr[0] < 0x80 else 4
            if len(self.hdr) == self.need:
                v = self.hdr[0] & 0x3F
                for b in self.hdr[1:]:
                    v = v << 8 | b
                self.left = v                  # len covers [type][payload]
                self.hdr.clear()
                self.need = 0
                self.at_type = v > 0
        return d



class Bridge:
    def __init__(self):
        self.sid2qid = {}    # shim sid -> quic stream id
        self.qid2sid = {}    # quic stream id -> shim sid
        self.next_srv_sid = 0x40000000
        # Construct loop-bound asyncio primitives from run(), not __init__:
        self.in_process = False   # wtproxy mode: frames fed via feed(), no stdin
        # Bridge() is created before asyncio.run() installs its event loop.
        self.done = None
        self.h3 = None
        self.wt_sid = None   # the CONNECT stream = WT session id
        self.wt_ready = False
        self._dbg = 0
        self._dgdbg = 0
        self._drop1c = 0
        self._rxdbg = 0
        self._sbuf = {}      # per-quic-stream accumulate for stream parse
        self._spre = {}      # qid -> preamble bytes consumed (first 7 stream B)
        self._rxframes = {}  # qid -> _RxFrames (stream-aware message tracker)
        self._auth_qid = None  # client's chan-1 stream (a8 early-auth sender)
        self._last_engine_dg = 0.0  # last engine-originated WT datagram time
        self._peer_id = None      # peer id parsed from inbound 0x81
        self._dummy_qids = set()  # bridge-owned app=6 streams — never to shim
        self._dummy_rx = 0
        self.pending = []    # frames buffered until the session is accepted
        # per-channel liveness ledger — on the RCC disconnect record we dump
        # each stream's app/chan + seconds since its last rx/tx, which names
        # the channel the server's receive-watchdog was watching
        self._qid_rx = {}
        self._qid_tx = {}
        self._qid_chan = {}
        self._peer_t = None   # monotonic time of the 0x81 peer-assign
        from collections import deque
        self._postmortem = deque(maxlen=256)  # inbound frame types — death tail
        self._last_rx = deque(maxlen=24)      # last inbound payload heads (hex)
        self._dgframer = _RaknetFramer()      # inbound datagram -> app msgs
        self._rxhist = {}                     # (chan,type) -> frame count
        self._stall_dumped = False
        self._eng_in = [0, 0]    # frames,bytes shim -> QUIC (engine outbound)
        self._eng_out = [0, 0]   # frames,bytes QUIC -> shim (engine inbound)

    def _h3_ready(self):
        self.wt_ready = True
        wr(bytes([4]))           # WT_READY — the shim releases its queue now
        for f in self.pending:
            self._frame(f)
        self.pending.clear()
        # the native client always runs a second "DummyClient" connection
        # (app=6: ctrl hello, chan-1 ping 1/s, chan-3 sync 5s). A second QUIC
        # conn sharing the RUPP token gets the session killed server-side, so
        # its channels ride THIS WT session instead — if the RCC reads that
        # heartbeat as session liveness, its absence is the ~30-60s kill
        # clock ending every session in `01 08000001 00000001 04` +
        # "Error while receiving data".
        asyncio.ensure_future(self._dummy_channels())
        asyncio.ensure_future(self._rate_log())

    async def _rate_log(self):
        """5s direction probe for the starvation pattern — rcc_in: UDP from
        the edge, eng_out: forwarded to the engine, eng_in: engine frames,
        rcc_out: UDP to the edge. Frozen world + live eng_in/rcc_out but
        dead rcc_in = the edge/server stopped sending to us."""
        last = None
        while not self.done.is_set():
            await asyncio.sleep(5)
            if self.done.is_set():
                return
            p = self.proto
            cur = [p.rx_n, p.rx_b, self._eng_out[0], self._eng_out[1],
                   self._eng_in[0], self._eng_in[1], p.tx_n, p.tx_b]
            if last is not None:
                d = [c - l for c, l in zip(cur, last)]
                LOG(f"rate5s rcc_in={d[0]}dg/{d[1] // 1024}KB "
                    f"eng_out={d[2]}f/{d[3] // 1024}KB "
                    f"eng_in={d[4]}f/{d[5] // 1024}KB "
                    f"rcc_out={d[6]}dg/{d[7] // 1024}KB")
                # stall detector: engine stops producing while the wire stays
                # hot -> its replication consumer wedged on an inbound item.
                # Dump the tail NOW (not on disconnect, which never comes).
                if (d[4] <= 2 and d[0] > 50 and not self._stall_dumped
                        and getattr(self, "_stall_armed", False)):
                    self._stall_dumped = True
                    LOG("*** STALL: engine outbound dead, inbound live — pm tail:")
                    for ts, qid, chan, t, ln in list(self._postmortem)[-24:]:
                        LOG(f"pm +{ts - _T0:6.1f}s qid={qid} chan={chan if chan is not None else -1:#x} type={t:#04x} len={ln}")
                    for ts, kind, hx in list(self._last_rx)[-16:]:
                        LOG(f"rx +{ts - _T0:6.1f}s {kind} {hx}")
                self._stall_armed = d[4] > 50   # only arm once the engine was live
                # every ~30s: channel/type histogram — is physics actually on
                # the wire, and on which channel?
                ticks = getattr(self, "_rticks", 0) + 1
                self._rticks = ticks
                if ticks % 6 == 0 and self._rxhist:
                    top = sorted(self._rxhist.items(),
                                 key=lambda kv: -kv[1])[:14]
                    LOG("rxhist " + " ".join(
                        f"ch{c}:{t:#04x}x{n}" for (c, t), n in top))
            last = cur

    def quic_stream_for(self, sid, write_only):
        qid = self.sid2qid.get(sid)
        if qid is None:
            qid = self.h3.create_webtransport_stream(self.wt_sid, is_unidirectional=write_only)
            self.sid2qid[sid] = qid
            self.qid2sid[qid] = sid
            LOG(f"map shim-sid {sid:#x} -> quic stream {qid}")
        return qid

    def _rxframe_for(self, qid):
        r = self._rxframes.get(qid)
        if r is None:
            r = self._rxframes[qid] = _RxFrames()
            # skip chan-1 0x08 heartbeats — 1Hz noise floods the ring and
            # pushes the real replication items out before the death dump
            def _onf(chan, t, ln, _q=qid):
                k = (chan, t)
                self._rxhist[k] = self._rxhist.get(k, 0) + 1
                if not (chan == 1 and t == 0x08):
                    self._postmortem.append((time.monotonic(), _q, chan, t, ln))
            r.on_frame = _onf
        return r

    def shim_sid_for(self, qid):
        sid = self.qid2sid.get(qid)
        if sid is None:
            sid = self.next_srv_sid
            self.next_srv_sid += 1
            self.qid2sid[qid] = sid
            self.sid2qid[sid] = qid
            # announce with the stream-type flag (quic id bit 0x2 = unidirectional)
            wr(bytes([2]) + struct.pack("<I", sid) + bytes([1 if qid & 0x2 else 0]))
            LOG(f"quic stream {qid} -> new shim-sid {sid:#x}")
        return sid

    def on_events(self):
        try:
            while True:
                ev = self.conn.next_event()
                if ev is None:
                    break
                try:
                    self.on_event(ev)
                except Exception as e:
                    LOG(f"on_event error on {type(ev).__name__}: {e}")
        finally:
            flush_wr()

    def on_event(self, ev):
        if isinstance(ev, ProtocolNegotiated):
            LOG(f"ALPN: {ev.alpn_protocol}")
        elif isinstance(ev, HandshakeCompleted):
            LOG("*** QUIC handshake complete — sending WT CONNECT ***")
            c = self.conn
            try:
                ee = dict(c.tls.received_extensions or [])
                if 0xFF00 in ee:
                    LOG(f"0xFF00 server caps echo: {ee[0xFF00].hex()}")
                else:
                    LOG("0xFF00 caps ext NOT echoed by server")
            except Exception:
                pass
            LOG(f"server params: idle={c._remote_max_idle_timeout} "
                f"cid_limit={c._remote_active_connection_id_limit} "
                f"preferred_addr={c._remote_preferred_address} "
                f"scid={c._remote_initial_source_connection_id and c._remote_initial_source_connection_id.hex()}")
            self.proto.hs = True   # RUPP wrap flips to subtype-2 session form
            self.h3 = H3Connection(self.conn, enable_webtransport=True)
            sid = self.conn.get_next_available_stream_id()
            path = os.environ.get("WT_PATH") or "/wt"
            if "?" not in path:
                # the engine's WT url is /wt?X-Rbx-Capabilities=<caps>… — caps
                # come from NetStackConfig; without the query the CONNECT is 400
                try:
                    cfg_j = json.loads(urllib.parse.unquote(JOIN.get("NetStackConfig") or "{}"))
                    caps = cfg_j.get("caps")
                    if caps:
                        path += f"?X-Rbx-Capabilities={caps}"
                except Exception:
                    pass
            self.h3.send_headers(
                stream_id=sid,
                headers=[
                    (b":method", b"CONNECT"),
                    (b":protocol", b"webtransport"),
                    (b":scheme", b"https"),
                    (b":authority", self._sni_b),
                    (b":path", path.encode()),
                    # browser-realistic CONNECT — a real WT session originates
                    # from the page origin and carries fetch-metadata + Chrome UA
                    *([(b"origin", WT_ORIGIN.encode())] if WT_ORIGIN else []),
                    (b"sec-webtransport-http3-draft", b"draft02"),
                    (b"sec-fetch-site", b"cross-site"),
                    (b"sec-fetch-mode", b"webtransport"),
                    (b"sec-fetch-dest", b"empty"),
                    (b"user-agent", b"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
                ],
            )
            self.wt_sid = sid
            LOG(f"CONNECT {path} on stream {sid}")
        elif isinstance(ev, ConnectionTerminated):
            LOG(f"*** terminated code={ev.error_code} reason={ev.reason_phrase!r}")
            # post-mortem: the last inbound replication frames before death —
            # the engine's "streaming data error" names a wire item it can't
            # parse; its tail is almost always in this list
            for ts, qid, chan, t, ln in list(self._postmortem)[-24:]:
                LOG(f"pm +{ts - _T0:6.1f}s qid={qid} chan={chan if chan is not None else -1:#x} type={t:#04x} len={ln}")
            wr(bytes([5]))       # WT_FAILED — tell the shim to reject ready
            self.done.set()
            return
        # Let aioquic/H3 handle the frame first. For a recognized WT context it
        # emits DatagramReceived, which on_h3 forwards to the shim. Falling back
        # to raw QUIC parsing is only needed for unrecognized context IDs; doing
        # both used to enqueue every normal datagram twice in the WASM RX ring.
        raw_dg = ev.data if isinstance(ev, DatagramFrameReceived) else None
        if self.h3 is None:
            return
        h3_delivered = False
        try:
            h3_events = self.h3.handle_event(ev)
        except Exception as e:
            LOG(f"h3 handle_event error on {type(ev).__name__}: {e}")
            h3_events = []
        for hev in h3_events:
            h3_delivered = h3_delivered or isinstance(hev, DatagramReceived)
            self.on_h3(hev)
        if raw_dg and not h3_delivered:
            d = raw_dg
            ci = d[0] & 0x3F
            ln = 1 << (d[0] >> 6)
            if len(d) > ln:
                wr(bytes([0]) + d[ln:])
                if self._rxdbg < 40:
                    self._rxdbg += 1
                    LOG(f"rx dg ctx={ci} {len(d)-ln}B {d[ln:ln+12].hex()} (raw fallback)")

    def _inspect_stream(self, qid, data):
        # channel messages are framed [cvarint len][type][payload] where len
        # counts type+payload; each stream starts with a 7-byte preamble
        # [06 01 <app> <chan u32be>]. Frames may span arbitrary chunk
        # boundaries — consumed bytes are pruned so each frame is processed
        # exactly once. A real cvarint parser (not a "scan for 80 00"
        # heuristic) is required: zstd payloads contain 80 00 pairs that
        # otherwise create phantom frames which swallow all subsequent real
        # messages.
        self._qid_rx[qid] = time.monotonic()
        pre = self._spre.setdefault(qid, bytearray())
        buf = self._sbuf.get(qid, bytearray()) + data
        if len(pre) < 7:
            need = 7 - len(pre)
            take = buf[:need]
            pre += take
            del buf[:len(take)]
            if len(pre) < 7:
                self._sbuf[qid] = buf
                return
            if pre[0] == 0x06 and pre[1] == 0x01:
                self._qid_chan[qid] = (
                    f"app{pre[2]}/chan{struct.unpack('>I', bytes(pre[3:7]))[0]:#x}")
        off = 0
        while off < len(buf):
            b0 = buf[off]
            hsz = (1 if b0 < 0x40 else 2 if b0 < 0x80
                   else 4 if b0 < 0xC0 else 8)
            if off + hsz > len(buf):
                break
            v = b0 & 0x3F
            for k in range(1, hsz):
                v = (v << 8) | buf[off + k]
            if v < 1 or v > (1 << 20):
                off += 1          # implausible len — resync one byte
                continue
            ln = v
            if off + hsz + ln > len(buf):
                break             # incomplete frame — keep buffered
            msg = buf[off + hsz:off + hsz + ln]
            off += hsz + ln
            # the RCC's server-initiated teardown record
            # `01 08 000001 000000 01<reason>` on a ctrl stream: reason 04 =
            # DisconnectReceivePacketError, 05 = stream variant
            if len(msg) == 10 and msg[0] == 0x01 and msg[1] == 0x08:
                now = time.monotonic()
                delta = f" — {now - self._peer_t:.1f}s after peer-assign" if self._peer_t else ""
                LOG(f"RCC DISCONNECT RECORD qid={qid}: {bytes(msg).hex()} reason={msg[9]}{delta}")
                for q in sorted(set(self._qid_rx) | set(self._qid_tx)):
                    rx = self._qid_rx.get(q)
                    tx = self._qid_tx.get(q)
                    LOG(f"  chan-dump qid={q} {self._qid_chan.get(q, '?')} "
                        f"rx={'never' if rx is None else f'{now - rx:.1f}s ago'} "
                        f"tx={'never' if tx is None else f'{now - tx:.1f}s ago'}")
                LOG(f"  chan-dump last engine dg {now - self._last_engine_dg:.1f}s ago"
                    if self._last_engine_dg else "  chan-dump no engine dgs")
            # harvest our peer id from the 0x81 peer-assignment — byte-oriented
            # [81][ena][x][isrR][isrW][isrLeg][v53][v58][peer LEB128] (the
            # v53-present shape every observed session matches)
            if msg[0] == 0x81 and self._peer_id is None and len(msg) > 9:
                self._peer_t = time.monotonic()
                v, off = 0, 8
                for k in range(5):
                    v |= (msg[off + k] & 0x7F) << (7 * k)
                    if not msg[off + k] & 0x80:
                        self._peer_id = v
                        # isrW names the write format the server assigned:
                        # 0 = legacy (NextGen 1c envelopes are unintelligible
                        # upstream), 1 = NextGen. Native fixture on 1818: 0.
                        LOG(f"peer id={v:#x} from 0x81 "
                            f"isrR={msg[3]} isrW={msg[4]} isrLeg={msg[5]}")
                        break
            # wire type 0xf8 carries the anti-cheat challenge:
            # [f8][u1 u32le][u2 u32le][len u32le][blob] — the engine solves
            # it natively; logged here as a join-progress marker
            if msg[0] == 0xF8 and len(msg) >= 13:
                u1, u2, blen = struct.unpack_from("<III", msg, 1)
                LOG(f"9b challenge on qid={qid} u1={u1:#x} u2={u2:#x} blob={blen}B")
        if off:
            del buf[:off]
        self._sbuf[qid] = buf

    async def _dummy_channels(self):
        """The DummyClient's app=6 channels on this WT session (was a second
        QUIC conn — see _h3_ready): ctrl hello + openU c2/c3, chan-1 ping
        77B/1s, chan-3 sync 25B/5s."""
        PING = bytes.fromhex("0858fbbded5ddc184000000001") + b"P" * 64
        SYNC = bytes.fromhex(
            "03fa4715010000000000000000000000000000000000000000")
        APP6, CTRL = 6, 0x6374726C

        def stream(chan):
            qid = self.h3.create_webtransport_stream(
                self.wt_sid, is_unidirectional=False)
            self.conn.send_stream_data(
                qid, bytes([0x06, 0x01, APP6]) + struct.pack(">I", chan))
            self._dummy_qids.add(qid)
            return qid

        def framed(qid, payload):
            self.conn.send_stream_data(qid, _cvarint(len(payload)) + payload)

        try:
            # native order (DummySession::onConnected): ctrl open -> hello ->
            # openU c2 -> openU c3 -> c1 open -> c3 open -> sync#0 -> ping#0
            ctrl = stream(CTRL)
            framed(ctrl, b"\x00\x00")
            # wire ids 0x40/0x42 — re-claiming the engine's app4 ctx 2/4 on
            # the shared session would reroute its chan3/chan5 datagrams into
            # the dummy channel server-side (receive starvation)
            framed(ctrl, bytes([2, APP6]) + struct.pack(">I", 2) + struct.pack(">I", 0x40))
            framed(ctrl, bytes([2, APP6]) + struct.pack(">I", 3) + struct.pack(">I", 0x42))
            c1 = stream(1)
            c3 = stream(3)
            framed(c3, SYNC)
            framed(c1, PING)
            self.proto.flush()
            LOG(f"dummy app=6 channels up: ctrl qid={ctrl} c1 qid={c1} c3 qid={c3}")
        except Exception as e:
            LOG(f"dummy channel setup failed: {e}")
            return
        n = 0
        while not self.done.is_set():
            await asyncio.sleep(1.0)
            if self.done.is_set():
                return
            n += 1
            try:
                framed(c1, PING)
                if n % 5 == 0:
                    framed(c3, SYNC)
                self.proto.flush()
            except Exception as e:
                LOG(f"dummy heartbeat stopped (stream gone): {e}")
                return

    def on_h3(self, ev):
        if isinstance(ev, HeadersReceived):
            status = dict(ev.headers).get(b":status", b"?")
            LOG(f"h3 headers on {ev.stream_id}: :status={status.decode(errors='replace')}")
            if ev.stream_id == self.wt_sid and status == b"200":
                LOG("*** WebTransport session accepted ***")
                self._h3_ready()
        elif isinstance(ev, DatagramReceived):
            if self._rxdbg < 30:
                self._rxdbg += 1
                LOG(f"rx dg {len(ev.data)}B {ev.data[:12].hex()}")
            if ev.data:
                try:
                    msgs = self._dgframer.feed(ev.data)
                except Exception:
                    msgs = []
                if msgs:
                    for t, chan, ln in msgs:
                        self._postmortem.append(
                            (time.monotonic(), -1, chan, t, ln))
                        k = (chan, t)
                        self._rxhist[k] = self._rxhist.get(k, 0) + 1
                else:
                    self._postmortem.append(
                        (time.monotonic(), -1, -1, ev.data[0], len(ev.data)))
                self._last_rx.append((time.monotonic(), "dg",
                                      f"{len(ev.data)}B {ev.data[:40].hex()}"))
                self._eng_out[0] += 1; self._eng_out[1] += len(ev.data)
            wr(bytes([0]) + ev.data)
        elif isinstance(ev, WebTransportStreamDataReceived):
            if ev.stream_id in self._dummy_qids:
                # server->dummy traffic (ctrl echo, ping acks) — native routes
                # it to the DummyClient, never the engine; forwarding it to
                # the shim would hand the engine a preamble-less stream
                if self._dummy_rx < 12:
                    self._dummy_rx += 1
                    LOG(f"rx dummy qid={ev.stream_id} {len(ev.data)}B {ev.data[:24].hex()}")
                return
            sid = self.shim_sid_for(ev.stream_id)
            if self._rxdbg < 30:
                self._rxdbg += 1
                LOG(f"rx st qid={ev.stream_id} {len(ev.data)}B {ev.data[:12].hex()}")
            self._inspect_stream(ev.stream_id, ev.data)
            # deliver the stream verbatim on its announced sid, preamble
            # included — the engine's channel layer parses [06 01 04 <chan>]
            # itself; _RxFrames walks frame boundaries for the post-mortem
            # ring and passes bytes through untouched
            data = self._rxframe_for(ev.stream_id).feed(ev.data)
            self._last_rx.append((time.monotonic(), f"st{ev.stream_id}",
                                  f"{len(ev.data)}B {ev.data[:40].hex()}"))
            self._eng_out[0] += 1; self._eng_out[1] += len(ev.data)
            wr(bytes([1]) + struct.pack("<I", sid) + data)
            if ev.stream_ended:
                wr(bytes([3]) + struct.pack("<I", sid))   # server sent FIN
        elif isinstance(ev, DataReceived):
            # h3 capsule data on the CONNECT stream (WT session control plane)
            # and any non-WT stream data. If the server pushes a session-level
            # heartbeat/ping capsule we otherwise never see it — log it.
            LOG(f"h3 data on stream {ev.stream_id} {len(ev.data)}B {ev.data[:32].hex()}"
                f"{' (wt session)' if ev.stream_id == self.wt_sid else ''}")

    async def run(self):
        self.done = asyncio.Event()
        js = JOIN
        udmux_ip, _udp = _udmux(js)
        rcc_ip, rcc_port = _rcc(js)
        token = _token(js)
        if not (udmux_ip and rcc_port and token):
            LOG("missing join fields", bool(udmux_ip), rcc_port, bool(token))
            return
        sni = _sni(js, udmux_ip, rcc_ip, rcc_port)
        self._sni_b = sni.encode()
        LOG(f"dial {udmux_ip}:{rcc_port} rcc={rcc_ip} sni={sni[:44]}...")

        # browser path: the WT endpoint only accepts h3 (HTTP/3 + WebTransport
        # extended-CONNECT); the native RbxTransport ALPN is desktop-only
        cfg = QuicConfiguration(
            is_client=True,
            alpn_protocols=["h3"],
            server_name=sni,
        )
        cfg.verify_mode = ssl.CERT_NONE
        cfg.max_datagram_frame_size = 65535
        cfg.idle_timeout = 60.0
        _tune_quic(cfg)
        self.conn = QuicConnection(configuration=cfg)

        loop = asyncio.get_event_loop()
        transport, proto = await loop.create_datagram_endpoint(
            lambda: RuppTransport(self.conn, rcc_ip, rcc_port, token),
            remote_addr=(udmux_ip, rcc_port),
        )
        proto.peer = (udmux_ip, rcc_port)
        proto.on_events = self.on_events
        self.proto = proto
        # bulk inbound needs kernel buffer headroom — Windows defaults
        # (~64KB) drop under the 60MB+ world burst and force QUIC resends
        sock = transport.get_extra_info("socket")
        if sock is not None:
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF,
                                8 * 1024 * 1024)
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF,
                                2 * 1024 * 1024)
            except OSError:
                pass

        self.conn.connect(proto.peer, time.monotonic())
        proto.flush()

        # keepalive — the native client pings the QUIC session ~1/s; without it
        # the server closes us on idle timeout after the WT connect
        async def ping():
            while not self.done.is_set():
                try:
                    self.conn.send_ping(0)
                    proto.flush()
                except Exception:
                    pass
                await asyncio.sleep(1.0)
        asyncio.ensure_future(ping())

        rd_task = None
        if not self.in_process:
            rd_task = asyncio.ensure_future(self._reader_loop())
        await self.done.wait()
        # post-mortem on EVERY exit path — a browser-side close (engine dead)
        # never raises ConnectionTerminated, so the tail must dump here too
        for ts, qid, chan, t, ln in list(self._postmortem)[-24:]:
            LOG(f"pm +{ts - _T0:6.1f}s qid={qid} chan={chan if chan is not None else -1:#x} type={t:#04x} len={ln}")
        if rd_task:
            rd_task.cancel()
        try:
            self.conn.close()
            proto.flush()
        except Exception:
            pass
        transport.close()

    async def _reader_loop(self):
        # stdin frames -> QUIC
        loop = asyncio.get_event_loop()
        while True:
            data = await loop.run_in_executor(None, sys.stdin.buffer.read1, 65536)
            if not data:
                self.done.set()
                return
            READBUF.extend(data)
            while len(READBUF) >= 4:
                n = struct.unpack("<I", READBUF[:4])[0]
                if len(READBUF) < 4 + n:
                    break
                f = bytes(READBUF[4:4 + n])
                del READBUF[:4 + n]
                self._frame(f)
            self.proto.flush()

    def feed(self, payload):
        """In-process entry: one shim-protocol payload (no length prefix)."""
        self._frame(payload)
        p = getattr(self, "proto", None)
        if p:
            p.flush()

    def _frame(self, f):
        if not self.wt_ready:
            self.pending.append(f)
            return
        t = f[0]
        self._eng_in[0] += 1; self._eng_in[1] += len(f)
        if t == 0:
            if self._dgdbg < 120:            # dg flood — don't flush stderr per send
                self._dgdbg += 1
                LOG(f"tx dg {len(f)-1}B {f[1:13].hex()}")
            self._last_engine_dg = time.monotonic()
            self.h3.send_datagram(self.wt_sid, f[1:])
        elif t == 1 and len(f) >= 5:
            sid = struct.unpack("<I", f[1:5])[0]
            qid = self.quic_stream_for(sid & 0x7FFFFFFF, bool(sid & 0x80000000))
            self._qid_tx[qid] = time.monotonic()
            if qid not in self._qid_chan and f[5] == 0x06 and f[6] == 0x01 and len(f) >= 12:
                self._qid_chan[qid] = (
                    f"app{f[7]}/chan{struct.unpack('>I', f[8:12])[0]:#x}")
            # the stream that carries the a8 early-auth is the chan-1 auth
            # stream — the 0x9B reply must go back there. Messages are
            # [80 00 u16be len][type][payload] — type at f[9]
            if self._auth_qid is None and len(f) > 9 and f[9] == 0xA8:
                self._auth_qid = qid
                LOG(f"auth stream = qid {qid} sid={sid:#x}")
            if self._dbg < 80:
                self._dbg += 1
                LOG(f"tx sid={sid:#x} qid={qid} {len(f)-5}B {f[5:21].hex()}")
            # Upstream 83/1c replication batches: the `1c` NextGen-write
            # envelope is rejected by this RCC's upstream parser on
            # legacy-write sessions (isrW=0) — passing it raw was the delayed
            # receive-path teardown (reason 4/5, ~30-130s). We strip the
            # `1c 00 <i32> ff 7f` envelope and send the inner items inline
            # (legal standalone); group-tag / non-ff7f forms still drop.
            #
            # A/B: suppression is now OFF by default — dropping these batches
            # opened an ack-gap that stalled the engine's own replication
            # loop (eng_in -> ~0 at ~40s; world froze while property/event
            # channels kept applying). WEBPORT_DROP_1C=1 re-enables.
            if len(f) > 10 and f[9] == 0x83 and _has_client_repl(f[10:]):
                body = f[10:]
                drop = _has_1c_batch(body)
                if _DROP_1C:
                    if drop:
                        new_body = _unwrap_1c(body)
                        if new_body is not None:
                            wire_len = 1 + len(new_body)
                            f = (f[:7] + wire_len.to_bytes(2, "big")
                                 + f[9:10] + new_body)
                            if getattr(self, "_unwr1c", 0) < 8:
                                self._unwr1c = getattr(self, "_unwr1c", 0) + 1
                                LOG(f"1c unwrap {len(f)-5}B -> "
                                    f"{f[9:19].hex()}")
                            drop = False
                    if drop:
                        if self._drop1c < 8:
                            self._drop1c += 1
                            LOG(f"1c/0e drop {len(f)-5}B {f[5:13].hex()}")
                        return
                elif getattr(self, "_pass1c", 0) < 12:
                    self._pass1c = getattr(self, "_pass1c", 0) + 1
                    LOG(f"1c/0e pass {len(f)-5}B {f[5:13].hex()}"
                        f"{' batch' if drop else ''}")
            # WT streams are raw QUIC streams — not h3 DATA frames
            self.conn.send_stream_data(qid, f[5:])
        elif t == 3 and len(f) >= 5:
            # shim stream close = graceful FIN, not a reset
            sid = struct.unpack("<I", f[1:5])[0]
            qid = self.sid2qid.get(sid & 0x7FFFFFFF)
            if qid is not None:
                try:
                    self.conn.send_stream_data(qid, b"", end_stream=True)
                except Exception:
                    pass


if __name__ == "__main__":
    asyncio.run(Bridge().run())
