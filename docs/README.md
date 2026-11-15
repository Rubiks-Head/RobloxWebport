# RubiksHead — documentation

Fully open-source Roblox webport for the new `play.roblox.com` URL — a
modified, decompiled version of the real engine that uses the desktop
client's APIs and documents how they work. These docs cover the
reverse-engineering itself: the decompilation pipeline, the protocol that was
cracked, the dead ends, and what's still open.

## Start here

| doc | what it is |
|---|---|
| [journey.md](journey.md) | **the story** — 4 months of RE: phases, walls, dead ends, what took longest and what broke each one |
| [decomp.md](decomp.md) | how the 100 MB wasm was extracted, split, decompiled, and patched |
| [protocol.md](protocol.md) | the wire protocol end-to-end: RUPP, QUIC, WebTransport, channels, message grammar |
| [challenge.md](challenge.md) | the 0x9B integrity challenge — the custom Luau VM and how it's answered |
| [services.md](services.md) | **every outbound API and service** the port talks to |

## How it works

| doc | scope |
|---|---|
| [architecture.md](architecture.md) | end-to-end data flow: page → engine → server → Roblox |
| [apis.md](apis.md) | the canonical `/api/<id>/?arg=<hex>` gateway, domain map, forwarding, specials |
| [join-flow.md](join-flow.md) | boot → auth → gamejoin → joinScript → engine launch → WT session → replication |
| [shim-relay.md](shim-relay.md) | browser↔server plumbing: WsTransport, relay modes, quic_bridge |
| [socket-ring.md](socket-ring.md) | the legacy shared-memory socket ABI + socket-pump + gate mailbox |
| [server.md](server.md) | `server/index.js` routes, session capture, DNS pinning, CSRF |
| [client.md](client.md) | the client bundle: loader, player, engine glue and browser shims |
| [debugging.md](debugging.md) | running it, log glossary, env vars, failure modes |

## 30-second version

```
browser tab                 local server                     Roblox
───────────                 ────────────                     ──────
index.html ──▶ /api/<id>/?arg=hex ──▶ domain handler ──▶ *.roblox.com / rbxcdn
   │                                                            (auth + join)
wasm engine ──▶ WebTransport shim ──▶ /udp-relay ws ──▶ quic_bridge.py
   │                                                   (aioquic, RUPP wrap)
   └◀── streams/datagrams ◀── ... ◀── QUIC+h3+WT ◀── UDMux edge ──▶ RCC game server
```

Every upstream HTTPS call takes the canonical `/api/<id>/?arg=<hex>` shape; the
game session itself is a real QUIC connection terminated by `quic_bridge.py`
(aioquic), with a WebSocket shim making the engine believe it has a native
WebTransport implementation.

---
*This document was written 100% by an AI model, based on roughly 4 months of
work, ~20 GB of captured data, and a map of all the context used during
decompilation and debugging.

If anything seems wrong or doesn't connect to the code, the doc was written
wrong — these docs weren't made perfect because they weren't strictly
required. If you spot an issue and have some time on your hands, please open
an issue for it!*
