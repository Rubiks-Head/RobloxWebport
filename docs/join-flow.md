# Join flow — page load to live game

The full sequence from `https://localhost:9989/play?id=1818` to a populated
DataModel. Stages marked ✅ are verified working in `server.log`.

## 1. Page + loader

`index.html` loads `WasmLoader.js`: environment detection, user-channel pin,
engine version resolution, then injects `WasmPlayer.js`.

## 2. Player boot

`WasmPlayer.js` applies flags, caches ixp buckets, resolves locale + host info
(all through `/api/...`), starts the LoadingScreen, and calls
`launchEngine()` → spawns the engine worker running `WebClient.js` +
`WebClient.wasm`.

## 3. Engine HTTP preflight

The wasm immediately starts issuing upstream calls through the XHR shim →
`toApiUrl()` → `/api/...`: clientsettings (flag injection happens here),
auth/session endpoints, telemetry. The server forwards them desktop-shaped.

## 4. gamejoin

The engine POSTs `{placeId, gameJoinAttemptId}` — too thin for upstream, so
the `gamejoin` special rebuilds the full desktop body (`isTeleport`,
`browserTrackerId`, `playSessionId`, `joinAttemptOrigin`, minted UUIDs) and
forwards with isolated desktop headers. Browser-shaped requests get
`status:12` — the isolated headers are why this works.

Upstream answers `status:2` + a real joinScript (UdmuxEndpoints,
ServerConnections, NetStackTokenValue, NetStackConfig, MachineAddress,
NetStackPort, SessionId, joinTicket, RandomSeed1, APIsecurityToken…).

## 5. joinScript transform

`transformJoin` on the response:

- saves a **pristine copy** server-side (the bridge's `JOIN_SCRIPT` env)
- injects the synthesized **qdmux SNI name**
  `{token}-{rccIp}-{rccPort}.{vip}.qdmux.roblox.com` into every dns/fqdn field
- rewrites `BaseUrl` → `https://localhost:9989/`
- captures udmux/machine/server endpoints into `session`

The engine now believes its WT endpoint is the qdmux name and dials
`https://<name>/wt?X-Rbx-Capabilities=<caps>` — which resolves to localhost.

## 6. WT session (`new WebTransport(url)`)

The wasm's `RbxTransportRnaExpConnection` calls our `WsTransport` shim → ws to
`/udp-relay?proto=udp&path=/wt?...` → relay spawns `quic_bridge.py`
(`JOIN_SCRIPT` + `WT_PATH` env) → real QUIC handshake (ALPN `h3`) → h3
extended-CONNECT `:status 200` → `WT_READY` frame releases the shim's queued
stream writes. Handshake reported `connectSuccess` to wasm; the
`RbxTransportRnaExpConnection` FSM proceeds.

## 7. Channel setup (engine → server)

The engine opens its streams (all client-unidirectional) and writes each
`[06 01 <app> <chan u32be>]` preamble, then channel messages
`[cvarint len][type][payload]`:

- ctrl streams (app=4 + app=0, chan `0x6374726c` 'ctrl'): hello `00 00`, then
  `OpenUnreliable`/`OpenReliable` type-2 declarations
- chan-1 (auth stream, detected by the `a8` type byte): `a8` early-auth
  (ClientTicket), then `0x90` client-info (~12 KB flags+JSON), `0x92` nonce,
  `0x8A` join request (~1.7 KB ticket+hashes), `0x8F 00` end marker

## 8. Server side (server → engine)

The server answers ctrl (mirrored `OpenUnreliable` wire-id assignments), then
opens **its own** server-unidirectional stream per channel — each announced
through the shim and parsed by the engine's channel layer via its `06 01 04`
preamble. On chan-1 the server sends `0x93` flag-override (~1.9 KB), the
`0xf8` anti-cheat challenge (~1.9 KB), then `0x81` peer-assignment (528 B),
`0xc4`, `0xeb`, `0xba`/`0x96`/`0x97` replication bursts, and chan-5 datagrams.

## 9. Challenge gate

The f8 frame's type byte is flipped to `0x9b` by `_RxFrames` so the engine's
own dispatcher routes it to `GenericChallengeService`. The bridge ALSO
answers it server-side (solverd) as a belt-and-braces fallback — either way,
the gate passes and replication unblocks. See [challenge.md](challenge.md).

## 10. Replication / DataModel

Post-answer traffic flows both ways: server chan-1 carries `0xba` instance
streams and `0x96`/`0x97` zstd replication frames; the engine emits its own
`0xba` responses + datagram-channel traffic; `contentdelivery` API fetches
pull model bytes. DataModel populates; the session stays alive (QUIC
keepalive ping 1/s + chan-5-shaped WT datagrams 1/s).

## What used to break here

- `getaddrinfo` failing (-4): fixed by the qdmux name mint + dns-shim.
- WT session dying at CONNECT: needed `X-Rbx-Capabilities` query + `h3` ALPN.
- **FSM stall** (the recent fix): all inbound stream data was dropped —
  announced streams registered under `sid|0x80000000` while data frames key
  the bare sid, and chan-1 was aliased to a stream the engine never reads.
  Engine only saw datagrams → peer-assign consumed → stall → idle timeout.

---
*This document was written 100% by an AI model, based on roughly 4 months of
work, ~20 GB of captured data, and a map of all the context used during
decompilation and debugging.

If anything seems wrong or doesn't connect to the code, the doc was written
wrong — these docs weren't made perfect because they weren't strictly
required. If you spot an issue and have some time on your hands, please open
an issue for it!*
