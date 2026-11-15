# The shared-memory socket ABI (legacy path)

The engine's other transport: a raw datagram "socket" exposed through a
shared-memory ring buffer, pumped by `driver.js`
(`core/js/engine/transport/socket-pump.js`). Mostly dormant on the WT path,
but still used by the gate mailbox and `engine-test.html`.

## The ABI (`GET /webclient/engine.json`)

```c
struct abi {                    // offsets from abi.base
  magic   +0    'NJLK' sentinel (we stamp it; engine sanity-checks it)
  txHead  +4    engine->us ring head (word index)
  txTail  +8    our read cursor
  rxHead  +12   us->engine ring head
  rxTail  +16   engine's read cursor
  wake    +20   futex word — Atomics.notify wakes the engine's poller
  selects +24   POINTER: engine's select() writes *selects=1 when ready
  recvd   +28   bytes received counter
  addr    +32   local sockaddr (16B)
  peer    +48   remote sockaddr (16B) — we write AF_INET + ip + port
  updates +52   monotonic counter — bumped on state changes
  tx0     +128  TX slots  (64 × 1536B: [u32 len][datagram])
  rx0     +98432 RX slots
  maxDatagram 1500
}
abi.base = 2146435072   // inside the engine's 256MB shared memory
```

## `startSocketPump` (`socket-pump.js`)

- `tick()` every 2–10 ms: post gate verdict → sync joinScript → if `waiting`,
  read the engine's requested sockaddr (`abi.addr`/`abi.peer`; loopback/bogus
  `127.x`/`0.0.0.0`/`1.x` → fall back to the session's udmux target) → open.
- `open()`: `openUdpRelay` (or injected `openUdp`) → on success, writes the
  peer sockaddr into `abi.peer`, points `selects` at a scratch word, bumps
  `updates`, pokes `wake` → the engine's connect()/select() completes.
- `txPump()`: drains TX slots → `rupp.outbound()` → `[MSG_DATA][sid][dg]`.
- `deliver()`: relay datagram → `rupp.inbound()` → RX slot + `rxHead++` +
  `Atomics.notify(wake)`. Drops anything > `SLOT-4` (1492+B — a max-MTU QUIC
  packet + RUPP wrapper used to wedge here).
- Ring dump every 400 ms (`[ring] txH=… peer=…`) — the best live view of
  what the engine actually wrote.

## The RUPP codec (`class Rupp`)

Same wire format as [protocol.md](protocol.md) but patching the *engine's*
datagrams rather than synthesizing them:

- `setJoinScript(js)` — pulls `NetStackTokenValue` (join token),
  `MachineAddress`+`NetStackPort` (rcc), `ServerConnections[0].Port`
  (dataPort).
- `outbound(dg)` — rewrites TLV1 ver-1's zeroed join-token slot and TLV2's
  rcc addr + **netstack** port (the engine writes the data port; udmux drops
  it without the netstack channel). ver-2 slots are left alone — they carry
  the session token the engine rotated itself.
- `inbound(dg)` — harvests the subtype-2 session token the server assigns.

## `openUdpRelay` — MSG_* mode handshake

```
server HELLO[5] → client HELLO[5] → server ACK[3]
→ client OPEN[1][sid][ver=2][port u16le][host] → DATA[2][sid][payload] ↔
REFUSE[4] = socket closed
```

The pump multiplexes everything on stream 1.

## The gate mailbox

`gate.abi` = a second shared-memory region (base `2146697216`): `state`,
`len`, `sig`, `msg[256]`. The engine's attestation FSM CAS-claims `state
0→2` and waits for a verdict; `postGate()` watches for `state==0 && len==0`
and writes `gate.token` (the engine.json token) + `len` — the engine claims
it and proceeds. Reversed protocol: we produce, engine consumes.

## Status

This path was the original RakNet-in-RUPP transport; the WT/QUIC path
(see [shim-relay.md](shim-relay.md)) replaced it. The pump still runs — the
gate mailbox is live and the dump is useful telemetry — but game traffic no
longer rides it. `rawUdpMode` in the relay is the sibling path for the
engine's `DebugUTPLauncherWebSocketUri` socket (sockaddr-prefixed datagrams,
RUPP-wrapped server-side).

---
*This document was written 100% by an AI model, based on roughly 4 months of
work, ~20 GB of captured data, and a map of all the context used during
decompilation and debugging.

If anything seems wrong or doesn't connect to the code, the doc was written
wrong — these docs weren't made perfect because they weren't strictly
required. If you spot an issue and have some time on your hands, please open
an issue for it!*
