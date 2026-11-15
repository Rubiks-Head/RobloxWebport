#!/usr/bin/env python3
# wt_flood_test.py — minimal native-WT datagram-flood server on :9990.
# Isolates Chrome's datagrams.readable delivery from the whole engine/bridge
# path: accept CONNECT /wt, 200 it, then flood H3 datagrams ~100/s and count
# inbound ones too. Compare dg-received-on-page vs dg-sent-here.
import asyncio
import os
import sys

from aioquic.asyncio import serve
from aioquic.asyncio.protocol import QuicConnectionProtocol
from aioquic.quic.configuration import QuicConfiguration
from aioquic.quic.events import ProtocolNegotiated, ConnectionTerminated
from aioquic.h3.connection import H3_ALPN, H3Connection
from aioquic.h3.events import DatagramReceived, HeadersReceived, WebTransportStreamDataReceived

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("FLOOD_PORT", "9990"))
LOG = lambda *a: print("[flood]", *a, file=sys.stderr, flush=True)

# instrument why pending datagrams never leave the queue
import aioquic.quic.connection as _qc
_orig_wdf = _qc.QuicConnection._write_datagram_frame
_dbg_n = [0]
def _dbg_wdf(self, builder, data, frame_type):
    _dbg_n[0] += 1
    try:
        r = _orig_wdf(self, builder, data, frame_type)
        if _dbg_n[0] <= 8:
            LOG(f"dg WROTE {len(data)}B")
        return r
    except Exception as e:
        if _dbg_n[0] <= 8:
            LOG(f"dg BLOCKED type={type(e).__name__} rem_buf={builder.remaining_buffer_space}"
                f" rem_flight={builder.remaining_flight_space} empty={builder.packet_is_empty}")
        raise
_qc.QuicConnection._write_datagram_frame = _dbg_wdf


class Flood(QuicConnectionProtocol):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.h3 = None
        self.sid = None
        self._tx = 0
        self._rx = 0

    def quic_event_received(self, ev):
        if isinstance(ev, ProtocolNegotiated):
            self.h3 = H3Connection(self._quic, enable_webtransport=True)
        elif isinstance(ev, ConnectionTerminated):
            LOG(f"terminated code={ev.error_code} sent={self._tx} rx={self._rx}")
            return
        if self.h3 is None:
            return
        for hev in self.h3.handle_event(ev):
            if isinstance(hev, HeadersReceived):
                hdrs = dict(hev.headers)
                if hdrs.get(b":protocol") == b"webtransport":
                    self.sid = hev.stream_id
                    self.h3.send_headers(stream_id=self.sid,
                                         headers=[(b":status", b"200")])
                    self.transmit()
                    LOG(f"session open sid={self.sid} remote_dgmax="
                        f"{self._quic._remote_max_datagram_frame_size}"
                        f" remote_settings={self.h3.received_settings}")
                    asyncio.ensure_future(self._flood())
            elif isinstance(hev, DatagramReceived):
                self._rx += 1
                if self._rx <= 10 or self._rx % 200 == 0:
                    LOG(f"dg rx#{self._rx} {len(hev.data)}B {hev.data[:8].hex()}")
            elif isinstance(hev, WebTransportStreamDataReceived):
                LOG(f"st rx sid={hev.stream_id} {len(hev.data)}B")

    async def _flood(self):
        # ~100/s small datagrams + a periodic ~1.2KB one to mimic physics dgs
        for i in range(30000):
            if self.sid is None:
                return
            payload = (b"dg%06d" % i) if i % 10 else (b"big" + bytes(1200))
            try:
                self.h3.send_datagram(self.sid, payload)
            except Exception as e:
                LOG(f"send_datagram err i={i}: {e}")
                return
            self._tx += 1
            self.transmit()
            if self._tx % 300 == 0:
                np = self._quic._network_paths[0]
                LOG(f"tx={self._tx} pending={len(self._quic._datagrams_pending)}"
                    f" cwnd={self._quic._loss.congestion_window}"
                    f" bif={self._quic._loss.bytes_in_flight}"
                    f" pacing_at={self._quic._pacing_at}"
                    f" valid={np.is_validated}"
                    f" rxB={np.bytes_received} txB={np.bytes_sent}")
            await asyncio.sleep(0.01)
        LOG(f"flood done tx={self._tx}")


async def main():
    cfg = QuicConfiguration(is_client=False, alpn_protocols=H3_ALPN,
                            max_datagram_frame_size=65536,
                            max_datagram_size=int(os.environ.get("FLOOD_MDS", "8192")))
    cfg.load_cert_chain(os.path.join(HERE, "wt-chain.pem"),
                        os.path.join(HERE, "wt-key.pem"))
    LOG(f"listening :{PORT}")
    await serve("127.0.0.1", PORT, configuration=cfg,
                create_protocol=Flood)
    try:
        await serve("::1", PORT, configuration=cfg,
                    create_protocol=Flood)
    except Exception:
        pass
    await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
