#!/usr/bin/env python3
# wt_server.py — native-WebTransport front for the game bridge.
#
# The engine's stock glue calls `new WebTransport(url)`; instead of shimming it
# over a WebSocket (ws-transport.js -> relay.js), the browser now dials a REAL
# WebTransport here. Each session is translated into the exact u32le shim
# frames quic_bridge.py already speaks, so the whole udmux client path is
# reused unchanged:
#
#   browser --WT/h3--> wt_server --shim frames--> quic_bridge.py --QUIC--> udmux
#
# Shim frames (same as quic_bridge.py):
#   ->  [0][data] datagram   [1][sid u32][data] stream (sid bit31 = uni)   [3][sid] close
#   <-  [0][data] datagram   [1][sid][data]     [2][sid][uni u8] new stream
#       [3][sid] close       [4] ready          [5] failed
import asyncio
import json
import os
import ssl
import struct
import subprocess
import sys
import time
import urllib.request

from aioquic.asyncio import serve
from aioquic.asyncio.protocol import QuicConnectionProtocol
from aioquic.quic.configuration import QuicConfiguration
from aioquic.quic.events import (
    ConnectionTerminated,
    DatagramFrameReceived,
    PingAcknowledged,
    ProtocolNegotiated,
)
from aioquic.h3.connection import H3_ALPN, H3Connection
from aioquic.h3.events import (
    DatagramReceived,
    HeadersReceived,
    WebTransportStreamDataReceived,
)

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("WT_PORT", "9988"))
API = os.environ.get("RB_API", "https://127.0.0.1:9989")
BRIDGE = os.path.join(HERE, "quic_bridge.py")
PYTHON = os.environ.get("PYTHON", sys.executable)

LOG = lambda *a: print("[wtsrv]", *a, file=sys.stderr, flush=True)

RX_BYTES = 0            # cumulative bridge->browser bytes (inbound replication)

# One H3 datagram must fit a single QUIC packet: varint ctx + payload +
# DATAGRAM frame hdr + packet hdr + AEAD tag, inside max_datagram_size=1472
# (Chrome's max_udp_payload_size). ~1400B payload is the safe cap.
DG_MAX_PAYLOAD = 1400


async def _stats_writer():
    # /stats on the api server merges this file so the loading-screen settle
    # logic sees inbound traffic on the native-WT path too (the ws-relay
    # counters only cover the shim path)
    while True:
        try:
            with open(os.path.join(HERE, "wt-stats.json"), "w") as f:
                json.dump({"rxBytes": RX_BYTES, "at": time.time()}, f)
        except Exception:
            pass
        await asyncio.sleep(1.0)


def join_script(connect_ms, cookie=b""):
    ctx = ssl.create_default_context()
    ctx.check_hostname = ctx.verify_mode = ssl.CERT_NONE
    # /session returns the captured session RECORD — JOIN_SCRIPT wants the
    # joinScript object inside it. The engine's WT CONNECT can arrive before
    # /gamejoin populates the record — and the record may hold a STALE script
    # from an older session — so only accept a script captured after this
    # CONNECT (sess.at) or one whose PepperId (issue unixtime) is fresh.
    # Fall back to whatever exists on timeout: a real reconnect legitimately
    # re-uses an old joinScript and stale still beats none.
    last_js = None
    for _ in range(300):
        try:
            req = urllib.request.Request(
                API + "/session",
                headers={"Cookie": cookie.decode("latin1")} if cookie else {})
            with urllib.request.urlopen(req, context=ctx, timeout=4) as r:
                sess = json.loads(r.read().decode() or "{}")
            js = sess.get("joinScript")
            if js:
                last_js = js
                fresh_at = (sess.get("at") or 0) >= connect_ms
                fresh_ts = (js.get("PepperId") or 0) >= time.time() - 300
                if fresh_at or fresh_ts:
                    return json.dumps(js)
        except Exception:
            pass
        time.sleep(0.05)
    if last_js:
        LOG("join-script: only stale session found — using it anyway")
        return json.dumps(last_js)
    LOG("join-script fetch timed out")
    return "{}"


class Session:
    """One browser WT session <-> one quic_bridge subprocess."""

    def __init__(self, proto, wt_sid, path, cookie=b""):
        self.proto = proto
        self.wt_sid = wt_sid
        # Chrome doesn't send cookies on WT CONNECTs — the client puts the
        # /pg sid in the query instead. Fall back to a raw cookie if present.
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(path or "").query)
        sid = (qs.get("sid") or [""])[0]
        self.cookie = cookie or (f"rh_sid={sid}".encode() if sid else b"")
        self.sid2qid = {}        # shim sid -> browser WT quic stream id
        self.qid2sid = {}        # browser WT quic stream id -> shim sid
        # client->server sids live in the low range (same as WsTransport's
        # _nextSid=1): 0x40000000+ is the bridge's namespace for
        # server->client streams — sharing it routed frames to wrong streams
        self.next_sid = 1
        self.bridge = None
        self.path = path
        self.outbuf = []
        self.t0 = time.time() * 1000
        self.answered = False

    async def start(self):
        # in-process bridge: the upstream QUIC/H3/RUPP client runs on this
        # same event loop — no subprocess, no stdio framing, direct calls.
        import quic_bridge as qb
        js = await asyncio.to_thread(join_script, self.t0, self.cookie)
        qb.set_join(json.loads(js or "{}"))
        os.environ["WT_PATH"] = self.path or "/wt"
        qb.OUT_SINK = self.on_bridge_frame
        self.bridge = qb.Bridge()
        self.bridge.in_process = True
        self._btask = asyncio.ensure_future(self.bridge.run())
        self._btask.add_done_callback(lambda *_: self.proto.lose_session(self))
        if self.outbuf:
            for payload in self.outbuf:
                self.bridge.feed(payload)
            self.outbuf.clear()

    def send(self, payload):
        if self.bridge:
            self.bridge.feed(payload)
        else:
            # engine frames written before the bridge spawns must not drop —
            # the ws shim queues them for the same reason (pending/_readyOk)
            self.outbuf.append(payload)

    def on_bridge_frame(self, f):
        global RX_BYTES
        RX_BYTES += len(f)
        t = f[0]
        h3 = self.proto.h3
        if t == 0:
            self._dg_out_n = getattr(self, "_dg_out_n", 0) + 1
            self._dg_out_b = getattr(self, "_dg_out_b", 0) + len(f) - 1
            # an H3 datagram that can't fit one QUIC packet (payload > ~1425B
            # at 1472B datagram size) would sit at _datagrams_pending[0]
            # forever — QuicPacketBuilderStop on every transmit — and stall
            # EVERY later datagram behind it. These frames are the lossy
            # plane: drop the oversize one instead of wedging the queue.
            if len(f) - 1 <= DG_MAX_PAYLOAD:
                h3.send_datagram(self.wt_sid, f[1:])
            else:
                self._dg_drop = getattr(self, "_dg_drop", 0) + 1
                if self._dg_drop <= 5:
                    LOG(f"dg oversize drop {len(f) - 1}B > {DG_MAX_PAYLOAD}B")
        elif t == 1 and len(f) >= 5:
            sid = struct.unpack("<I", f[1:5])[0]
            qid = self.sid2qid.get(sid)
            if qid is not None:
                self.proto._quic.send_stream_data(qid, f[5:])
        elif t == 2 and len(f) >= 6:
            sid, uni = struct.unpack("<I", f[1:5])[0], f[5]
            qid = h3.create_webtransport_stream(self.wt_sid, is_unidirectional=bool(uni))
            self.sid2qid[sid] = qid
            self.qid2sid[qid] = sid
        elif t == 3 and len(f) >= 5:
            sid = struct.unpack("<I", f[1:5])[0]
            qid = self.sid2qid.get(sid)
            if qid is not None:
                try:
                    self.proto._quic.send_stream_data(qid, b"", end_stream=True)
                except Exception:
                    pass
        elif t == 4:
            # upstream WT session accepted — NOW answer the browser's CONNECT.
            # Replying earlier resolved wt.ready while the joinScript/bridge
            # was still cold, so the engine's first auth frames dropped.
            h3.send_headers(stream_id=self.wt_sid, headers=[(b":status", b"200")])
        elif t == 5:
            if not self.answered:
                h3.send_headers(stream_id=self.wt_sid, headers=[(b":status", b"502")])
            self.proto._quic.close()
        if t == 4 or t == 5:
            self.answered = True
        self.proto.transmit()

    def feed(self, qid, data, ended):
        """browser WT stream data -> bridge stdin."""
        sid = self.qid2sid.get(qid)
        if sid is None:
            sid = self.next_sid | (0x80000000 if (qid & 0x2) else 0)
            self.next_sid += 4
            self.qid2sid[qid] = sid
            self.sid2qid[sid] = qid
        self.send(bytes([1]) + struct.pack("<I", sid) + data)
        if ended:
            self.send(bytes([3]) + struct.pack("<I", sid))

    def feed_datagram(self, data):
        self.send(bytes([0]) + data)

    def close(self):
        try:
            if self.bridge:
                if self.bridge.done:
                    self.bridge.done.set()
                c = getattr(self.bridge, "conn", None)
                if c:
                    c.close()
        except Exception:
            pass


class WtProtocol(QuicConnectionProtocol):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.h3 = None
        self.session = None
        self._last_rx = time.monotonic()
        self._ka = asyncio.ensure_future(self._keepalive())

    async def _keepalive(self):
        # the engine's datagrams ride the ws leg, so this session can idle
        # between stream bursts — without PINGs both Chrome's and our own
        # idle timers kill a live session mid-game ("streaming data error")
        try:
            while True:
                await asyncio.sleep(15)
                try:
                    self._quic.send_ping(0)
                    self.transmit()
                    s = self.session
                    LOG(f"keepalive ping (last rx {time.monotonic() - self._last_rx:.0f}s ago,"
                        f" idle_cap={self._quic._idle_timeout():.0f}s)"
                        f" remote_dgmax={self._quic._remote_max_datagram_frame_size}"
                        f" dg_out={(getattr(s, '_dg_out_n', 0) if s else -1)}/"
                        f"{(getattr(s, '_dg_out_b', 0) if s else -1)}B")
                    # flow-control probe: if the engine's outbound dies while
                    # the conn stays up, is a receive window exhausted? rx
                    # window = what WE grant the browser; exhausted => their
                    # writer.write() pends forever => writeChain wedges.
                    try:
                        lim = self._quic._local_max_data
                        LOG(f"flow conn rxwin used={lim.used}/{lim.value}")
                        for _sid, _st in self._quic._streams.items():
                            r = _st.receiver
                            LOG(f"flow st{_sid} rxoff={r.highest_offset}"
                                f" max={_st.max_stream_data_local}"
                                f" fin={r._final_size}")
                    except Exception as e:
                        LOG(f"flow probe err: {e}")
                except Exception as e:
                    LOG(f"keepalive stopped: {e}")
                    return
        except asyncio.CancelledError:
            pass

    def datagram_received(self, data, addr):
        self._last_rx = time.monotonic()
        if not hasattr(self, "_pkts"):
            self._pkts = 0
        self._pkts += 1
        if self._pkts <= 20:
            LOG(f"pkt {len(data)}B from {addr} {data[:8].hex()}")
        super().datagram_received(data, addr)

    def quic_event_received(self, ev):
        if not hasattr(self, "_evs"):
            self._evs = 0
        self._evs += 1
        if isinstance(ev, PingAcknowledged):
            LOG("keepalive ack")
        if self._evs <= 12 or isinstance(ev, ConnectionTerminated):
            extra = ""
            if isinstance(ev, ConnectionTerminated):
                extra = f" code={ev.error_code} reason={getattr(ev, 'reason_phrase', '')!r}"
            LOG(f"event {type(ev).__name__}{extra}")
        if isinstance(ev, ProtocolNegotiated):
            self.h3 = H3Connection(self._quic, enable_webtransport=True)
        elif isinstance(ev, ConnectionTerminated):
            if self.session:
                self.session.close()
                self.session = None
            if self._ka:
                self._ka.cancel()
            return
        if self.h3 is None:
            return
        raw_dg = ev.data if isinstance(ev, DatagramFrameReceived) else None
        h3_delivered = False
        for hev in self.h3.handle_event(ev):
            h3_delivered = h3_delivered or isinstance(hev, DatagramReceived)
            self.on_h3(hev)
        if raw_dg and not h3_delivered and self.session:
            d = raw_dg
            ln = 1 << (d[0] >> 6)
            if len(d) > ln:
                self.session.feed_datagram(d[ln:])
        self.transmit()

    def on_h3(self, ev):
        if not hasattr(self, "_h3n"):
            self._h3n = 0
        self._h3n += 1
        if self._h3n <= 20:
            LOG(f"h3 {type(ev).__name__} {getattr(ev, 'headers', b'')!r}"[:200])
        if isinstance(ev, HeadersReceived):
            hdrs = dict(ev.headers)
            if hdrs.get(b":method") == b"CONNECT" and hdrs.get(b":protocol") == b"webtransport":
                path = (hdrs.get(b":path") or b"/wt").decode("latin1")
                # :status 200 is deferred until the bridge reports [4] (upstream
                # session accepted) — answering now would resolve wt.ready while
                # the joinScript fetch/bridge spawn are still cold
                self.session = Session(self, ev.stream_id, path, hdrs.get(b"cookie", b""))
                asyncio.ensure_future(self.session.start())
                LOG(f"WT CONNECT {path} (sid {ev.stream_id})")
            else:
                self.h3.send_headers(stream_id=ev.stream_id, headers=[(b":status", b"404")])
        elif isinstance(ev, WebTransportStreamDataReceived):
            if self.session and ev.stream_id != self.session.wt_sid:
                try:
                    self.session.feed(ev.stream_id, ev.data, ev.stream_ended)
                except Exception as e:
                    LOG(f"feed st{ev.stream_id} error: {e!r}")
        elif isinstance(ev, DatagramReceived):
            if self.session:
                try:
                    self.session.feed_datagram(ev.data)
                except Exception as e:
                    LOG(f"feed dg error: {e!r}")

    def lose_session(self, s):
        if self.session is s:
            self.session = None
        try:
            self._quic.close()
        except Exception:
            pass
        self.transmit()


async def main():
    cfg = QuicConfiguration(
        is_client=False,
        alpn_protocols=H3_ALPN,
        max_datagram_frame_size=65536,
        # packet buffer cap is also the max_udp_payload_size TP we advertise —
        # the 1200 default leaves ~1155B of frame room, so every ~1.2KB RCC
        # physics datagram got head-of-line-blocked at _datagrams_pending[0]
        # and the engine's datagrams.readable starved (remote players frozen).
        # 1472 == Chrome's advertised max_udp_payload_size; larger values make
        # Chrome drop our padded INITIALs and the handshake times out.
        max_datagram_size=1472,
        # aioquic defaults are 1MB for BOTH connection and per-stream windows;
        # the engine's replication stream pushes ~8.5KB/s so a 1MB stream
        # window exhausts ~120s in -> writer.write() pends -> writeChain
        # wedges -> engine outbound dies with the conn still up. aioquic does
        # auto-extend (x2 when half used) but only on transmits — give the leg
        # headroom so extension isn't on the critical path.
        max_data=64 * 1024 * 1024,
        max_stream_data=64 * 1024 * 1024,
        # dead-browser sessions must be reaped or they hold RCC slots forever,
        # but a live session can legitimately go quiet >60s (datagrams riding
        # the ws leg, afk, map streaming gaps) — 60s was killing real players
        idle_timeout=240,
    )
    # leaf+chain signed by a local CA installed in the user's root store —
    # Chrome verifies normally (self-signed leaves can't anchor themselves;
    # serverCertificateHashes pinning proved unreliable across builds).
    cfg.load_cert_chain(os.path.join(HERE, "wt-chain.pem"), os.path.join(HERE, "wt-key.pem"))
    await serve("127.0.0.1", PORT, configuration=cfg, create_protocol=WtProtocol)
    try:
        await serve("::1", PORT, configuration=cfg, create_protocol=WtProtocol)
    except Exception:
        pass
    LOG(f"WT server listening on 127.0.0.1+::1:{PORT}")
    asyncio.ensure_future(_stats_writer())
    await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
