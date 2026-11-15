# Client bundle internals

Readable source lives in `core/js/`; `core/build.mjs` concatenates each
bundle in explicit order into `out/webclient/*.js` and stages the wasm +
assets verbatim. Edit source, rebuild, Ctrl+F5 — never edit `out/`.

## Bundles (`BUNDLES` in build.mjs)

| bundle | parts | role |
|---|---|---|
| `consolelog.js` | consolelog.js | DBG logger plumbing |
| `i18n.js` | i18n.js | locale strings |
| `_ids.js` | generated | `globalThis.API` domain→id map |
| `api-url.js` | shared/api-url.js | standalone for workers |
| `WasmLoader.js` | api-url + loader/* | bootstrap |
| `WasmPlayer.js` | api-url + player/* | player shell |
| `WebClient.js` | api-url + consolelog + webclient/* | engine worker glue + all shims |
| `driver.js` | engine/transport/socket-pump.js | legacy ring pump |
| `stub.js` | engine/worker/stub.js | worker fallback (pthreads import WebClient.js directly) |
| `audio-processor-fast.js` | engine/audio/processor.js | audio worklet |

`shared/api-url.js` is prepended to every self-contained bundle (workers
never see the page's script tags).

## Loader (`js/loader/` → `WasmLoader.js`)

Environment detection → user channel → engine version resolve → inject the
player script. Small, sequential, boring (on purpose — it runs before any
api machinery).

## Player (`js/player/` → `WasmPlayer.js`)

`head.js`/`env.js` globals → `flags.js` FFlag table → `host-info.js` +
`locale.js` via /api → `loading-screen.js` UI → `tab-lock.js` →
`engine-launch.js` (spawns the engine worker, feeds join params) →
`exit.js` teardown → `boot.js` entry.

## Engine worker (`js/engine/webclient/` → `WebClient.js`)

Concatenated in this order — each file's job:

1. **`api-url.js`** — `apiUrl/apiBase/toApiUrl/hexEncode` + `fetch` wrap.
   Every upstream URL becomes `/api/<id>/?arg=<hex>` at emission.
2. **`consolelog.js`** — `DBG.<cat>` tagged logging.
3. **`relay-config.js`** — `RELAY_URL = ws(s)://<host>/udp-relay`.
4. **`ws-transport.js`** — `WsTransport`, the WebTransport-shaped ws tunnel
   (frames, ready gating, incoming stream announce — see shim-relay.md).
   Installed as `globalThis.WebTransport = __WsTransport`.
5. **`dns-shim.js`** — getaddrinfo fabricator. Hooks `WebAssembly.Memory` +
   `instantiate*`, claims the engine's 256 MB shared memory, writes a fake
   `struct addrinfo`+`sockaddr_in` at `GAI_ADDR=0x10000000`, keeps it synced
   with `GET /udmux` every 800 ms.
6. **`prelude.js`** — stock glue prelude (`d_`/`lr` property helpers).
7. **`create-web-client.js`** — the stock emscripten `createWebClient`
   factory (wasm instantiation, pthread pool, import wiring — the 268 named
   imports surface).
8. **`xhr.js`** — `sn()`: engine XHR struct → browser `XMLHttpRequest`.
   `B.open(c, toApiUrl(o))` — THE single URL-rewrite boundary. Streaming
   progress chunks into wasm memory (`_streamData`), header list walk,
   readyState/status write-back.
9. **`glue.js`** — minified stock glue + `__rbxWasmRna`: connection registry,
   `tryWriteReceiveRingSlot` (ring head/tail, slot caps, deferred
   `receiveRingSlot` callbacks), `Ur()` incoming-uni reader, `Or()` datagram
   reader, `resumeStreamRead`, `onReceiveRingConsumed`, MessageChannel
   callback drain, handshake/connectSuccess/close/fin/error reporting.
10. **`tail.js`** — bench worker body + sentry debug-id trailer.

## `toApiUrl` — the one rewrite

The wasm emits absolute `https://<host>/<path>` URLs internally. At the XHR
open boundary (and wrapped `fetch`), `toApiUrl()` maps upstream hosts
(`*.roblox.com|robloxlabs.com|rbxcdn.com|.net|rbxinfra.com|refract.best|
local|localhost`) to `apiUrl(firstLabel[+.api], path+query)`. Same-origin,
relative, ws:, data:, blob:, unknown hosts pass through.

## What runs where

- Page thread: loader + player + consolelog + api-url.
- Engine worker: WebClient.js (whole bundle) + wasm + pthreads (which
  re-import WebClient.js — that's why api-url is prepended).
- driver.js is loaded only by `engine-test.html` / the transport driver.

---
*This document was written 100% by an AI model, based on roughly 4 months of
work, ~20 GB of captured data, and a map of all the context used during
decompilation and debugging.

If anything seems wrong or doesn't connect to the code, the doc was written
wrong — these docs weren't made perfect because they weren't strictly
required. If you spot an issue and have some time on your hands, please open
an issue for it!*
