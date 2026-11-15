# core/js — readable client source (de-minified, organized)

Every bundle is assembled by `core/build.mjs` from the files below — sorted
`NN-` prefix order inside each dir. Edit here, rebuild, ship.
Upstream calls are ALWAYS canonical: `<origin>/api/<domainId>/?arg=<hex>`
— see `shared/api-url.js`. No runtime URL rewriting except `toApiUrl()` at the
wasm XHR boundary (the binary still emits absolute https URLs internally).

```
core/js/
  consolelog.js             console strip — no-ops console.*/LOG.*/DBG.*,
                            leaves LOG.raw; wasm logs ride the __engx ring
  _ids.js                   GENERATED domain->id map (build.mjs, do not edit)
  shared/
    api-url.js              apiUrl(domain,path), apiBase, toApiUrl(url), hex
  loader/    -> WasmLoader.js   bootstrap: envs, user channel, engine version, inject player
  player/    -> WasmPlayer.js   flags, ixp cache, host info, locales,
                                LoadingScreen, tab lock, launchEngine, boot
  engine/
    webclient/ -> WebClient.js  emscripten glue + shims:
                    00 relay url, 01 WsTransport (WebTransport over /udp-relay),
                    02 getaddrinfo fabricator (polls /udmux), 03 prelude,
                    04 createWebClient, 05 XHR impl (toApiUrl at B.open),
                    06 GL/ws glue (external ws -> relay ?proto=tcp), 07 tail
    transport/ -> driver.js     socket-ABI ring pump + RUPP session codec
                                (engine-test + diagnostics)
    worker/    -> stub.js       worker bootstrap (fallback; pthreads import
                                WebClient.js directly)
    audio/     -> audio-processor-fast.js
```

## server side (../server)
- `/api/<id>/?arg=<hex>` -> `domains/<domain>.js` — ONE function per domain.
- `/api/<id>/<path>` — path form for composed base URLs.
- `/udmux` last captured joinScript datagram target; `/session` debug dump.
- `ws /udp-relay` — `?proto=tcp&to=h:p` bridge | `?proto=udp` frames | MSG_* handshake.
- auth: cnfg.json `robloxAuthToken` injected upstream; never reaches the page.
