# Browser↔server plumbing

How the wasm's `new WebTransport(url)` becomes a real QUIC session. Three
processes: the ws shim in the page, the ws relay in Node, the QUIC bridge in
Python.

## 1. `WsTransport` — `core/js/engine/webclient/ws-transport.js`

A WebTransport-shaped object over a ws to `/udp-relay?proto=udp[&to=h:p]
[&path=/wt?...]`. Binary frame protocol (shared with the relay + bridge):

| frame | meaning |
|---|---|
| `[0][data]` | datagram (WT datagrams ↔ engine `datagrams.readable/writable`) |
| `[1][sid u32le][data]` | stream data, both directions |
| `[2][sid u32le][uni u8]` | incoming-stream announce (server→engine only) |
| `[3][sid u32le]` | stream close / FIN |
| `[4]` | WT_READY — session accepted; flush queued writes, resolve `ready` |
| `[5]` | WT_FAILED — terminate; reject `ready` |

Engine-side API: `createBidirectionalStream()` → `{readable,writable}`,
`createUnidirectionalStream()` → `writable`, `incomingBidirectionalStreams` /
`incomingUnidirectionalStreams` ReadableStreams, `datagrams`, `ready`,
`closed`.

Sid space: engine-allocated = `(uni ? 0x80000000 : 0) | n`; bridge-allocated
(server streams) = `0x40000000+n`. **Announced streams register under the
bare sid** — bit31 is only an engine-side marker. (That distinction was the
FSM-stall bug: data frames arrive keyed by the bare sid.)

Writes before `WT_READY` queue in `_pending` — the wasm starts opening
channels before CONNECT completes, and dropping those frames loses the join.

## 2. The engine's WT glue — `glue.js` (`__rbxWasmRna`)

The stock wasm RNA glue: `new WebTransport(...)` per connection, then:

- `Ur()` — reads `incomingUnidirectionalStreams` forever; each item (a raw
  ReadableStream) gets an engine streamId (3,7,11,…) + `streamAccepted`
  callback → wasm resumes reads → `ge()`/`Le()` pump chunks into the wasm
  **receive ring** via `tryWriteReceiveRingSlot`, notifying wasm through
  `rbx_wasm_rna_on_receive_ring_slot` deferred callbacks.
- `Or()` — datagram readable → same ring (`receiveKind=1`).
- Writes: engine `writable.getWriter().write(chunk)` → `[1][sid][data]`.
- Callbacks drain on a MessageChannel microtask — never inside wasm call
  frames.

## 3. `server/relay.js` — the ws upgrade

`/udp-relay` modes picked by query + first frame:

| mode | trigger | behavior |
|---|---|---|
| `?proto=tcp&to=` | engine WebSocket tunnel | raw TCP bridge; `*.localhost` → `127.0.0.1:9989` (engine's own http layer) |
| `?proto=udp` or `?to=` | **WT shim** | `frameMode` — spawn `quic_bridge.py`, pipe frames ws↔stdio `[u32le len][frame]` |
| `?proto=msg` | explicit | `msgMode` MSG_* handshake (socket-pump path) |
| bare | sniffer | HELLO first → msgMode if client replies HELLO, else `rawUdpMode` (UTP datagrams w/ sockaddr unwrap + RUPP wrap) |

`frameMode` waits ≤15 s for `session.last().joinScript` (the WT ws can open
before /gamejoin returns), then spawns:

```
python quic_bridge.py   env: JOIN_SCRIPT=<pristine joinScript>  WT_PATH=/wt?...
```

`JOIN_SCRIPT` is the **server-side pristine copy** — fields stripped from the
client-facing transform stay intact for the bridge.

## 4. `quic_bridge.py` — the QUIC endpoint

stdio `[u32le len][frame]` ↔ UDMux QUIC, all in `Bridge`:

- `quic_stream_for(sid, uni)` — lazily maps each shim sid to a real QUIC WT
  stream on `wt_sid` (`is_unidirectional` from bit31). Writes are raw stream
  data — WT streams aren't h3 DATA frames.
- `shim_sid_for(qid)` — server-opened streams get sid `0x40000000+n` +
  announce frame; unidirectional from QUIC id bit `0x2`.
- Datagrams: engine→server `h3.send_datagram(wt_sid, data)`; server→engine
  `DatagramFrameReceived` strips the leading varint context (aioquic h3 drops
  non-capsule datagrams, so it's handled at the QUIC layer).
- `_RxFrames` — per-server-stream frame tracker: parses the `[06 01 app
  chan]` preamble, walks `[cvarint len][type]` frames across arbitrary
  chunking, flips chan-1's `f8`→`9b` for the engine's dispatcher
  ([challenge.md](challenge.md)).
- `_maybe_solve_9b` — bridge-side challenge answerer (cached resends,
  deduped solves, `NO_9B` to disable).
- `_declare_routes` — `a6` route declarations on chan-11 ~60 ms post-answer.
- `_dg_keepalive` — chan-5-shaped WT datagram every 1 s.
- `_dummy_channels()` — the native's app=6 DummyClient traffic (ctrl hello,
  chan-1 ping 77 B/1 s, chan-3 sync 25 B/5 s) run as extra WT streams on the
  MAIN session — the second QUIC conn sharing the RUPP token gets killed
  server-side, but the RCC appears to read this heartbeat as session
  liveness (its absence matched the ~30–60 s `01 08000001 00000001 04` +
  "Error while receiving data" kill clock). On by default; `NO_DUMMY=1`
  disables. Replies on dummy qids are logged, never forwarded to the shim.
- `dummy_conn()` — the original second-connection version, kept for
  reference (not launched).

### The FSM-stall bug (fixed)

Two defects blackholed all inbound stream data:

1. shim registered announced streams under `sid|0x80000000`, data frames key
   bare sid → `_streams.get()` missed → drop.
2. bridge aliased chan-1 data to the sid of the engine's *outgoing* uni
   stream — a readable the engine never holds — and stripped its `06 01 04`
   preamble.

Result: engine consumed datagram-chan peer-assign, never saw chan-1
0x93/challenge/replication, emitted nothing, died on its own timeout.

---
*This document was written 100% by an AI model, based on roughly 4 months of
work, ~20 GB of captured data, and a map of all the context used during
decompilation and debugging.

If anything seems wrong or doesn't connect to the code, the doc was written
wrong — these docs weren't made perfect because they weren't strictly
required. If you spot an issue and have some time on your hands, please open
an issue for it!*
