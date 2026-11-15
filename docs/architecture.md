# Architecture

## The three planes

RubiksHead has three independent data planes between the browser and Roblox:

1. **HTTPS/API plane** — every upstream HTTP call the engine makes (auth,
   join, clientsettings, assets, telemetry) flows through the local server as
   `/api/<domainId>/?arg=<hex(path+query)>`. The server maps each opaque id to
   a real upstream host and forwards with desktop-shaped headers.

2. **Game session plane** — the engine's RbxTransport/QUIC game traffic. The
   wasm calls `new WebTransport(url)`; a shim (`WsTransport`) tunnels it over a
   same-origin WebSocket to `server/relay.js`, which spawns `quic_bridge.py`
   (a real aioquic QUIC endpoint) that dials the live UDMux edge with
   RUPP-wrapped datagrams.

3. **Legacy socket plane** — the engine's raw UDP "socket" ABI, a
   shared-memory ring buffer pumped by `socket-pump.js` over the same
   `/udp-relay` endpoint in `MSG_*` mode. Mostly dormant since the WT path
   landed, still used for the gate mailbox and diagnostics.

## Component map

```
out/index.html
└─ WasmLoader.js      envs, user channel, version → injects WasmPlayer
   └─ WasmPlayer.js   flags, ixp, locale, loading screen → launchEngine()
      └─ WebClient.js  (worker) — stock emscripten glue + our shims:
         ├─ api-url.js        /api/<id>/?arg= canonical URLs + fetch wrap
         ├─ relay-config.js   RELAY_URL = ws(s)://host/udp-relay
         ├─ ws-transport.js   WebTransport-shaped object over ws frames
         ├─ dns-shim.js       getaddrinfo fabricator (polls /udmux)
         ├─ xhr.js            engine XHR → browser XHR (toApiUrl at open)
         └─ glue.js           RNA glue: __rbxWasmRna conns, receive ring,
                             incoming stream readers, deferred callbacks
   └─ driver.js         socket-pump: ABI ring ↔ relay (legacy path)

server/
└─ index.js           HTTPS :9989 — /api map, /join /udmux /session,
                      /webclient/engine.json, static out/, ws upgrade
   ├─ relay.js        /udp-relay: ?proto=tcp | ?proto=udp→bridge | MSG_* | raw UTP
   ├─ quic_bridge.py  per-session aioquic endpoint (spawned by relay)
   ├─ lib/session.js  captured joinScript + datagram target
   ├─ lib/ws.js       minimal RFC6455 server
   └─ domains/        per-upstream-domain handlers (gamejoin, _forward, …)
```

## The trust boundaries

- **Browser**: no raw UDP, no QUIC, no h3 — everything is ws/fetch.
- **Local server**: holds the auth cookie (`cnfg.json`, never sent to the
  page), mints CSRF, pins DNS, and owns the real network identity.
- **quic_bridge.py**: the only process that speaks QUIC/RUPP — it is the
  "network card" for the wasm engine.
- **Roblox edge**: sees a well-formed QUIC client with the qdmux SNI, RUPP
  session headers, and a WT CONNECT carrying the session capabilities.

## Why it's built this way

- Browsers can't send raw UDP and Chrome WebTransport can't prepend RUPP
  headers — so the WT session is *terminated* in Python, not forwarded.
- The engine is a closed ~101 MB wasm binary — every host interaction goes
  through its JS import boundary (268 named imports), which is where all the
  shims live. Nothing inside the engine is patched at the JS layer except
  through the import surface.
- The `/api` scheme exists because the engine emits absolute `https://` URLs
  internally; converting them at the XHR/fetch boundary is the single point
  where rewriting is unavoidable until the wasm itself is repatched.

---
*This document was written 100% by an AI model, based on roughly 4 months of
work, ~20 GB of captured data, and a map of all the context used during
decompilation and debugging.

If anything seems wrong or doesn't connect to the code, the doc was written
wrong — these docs weren't made perfect because they weren't strictly
required. If you spot an issue and have some time on your hands, please open
an issue for it!*
