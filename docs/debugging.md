# Running & debugging

## Run

```bash
cp server/cnfg.example.json server/cnfg.json   # fill in robloxAuthToken
cd core && node build.mjs                      # builds out/  (run from core/)
node serve/serve.js                            # https://localhost:9989/play?id=1818
```

After ANY `core/` change: `cd core && node build.mjs` + tell the user Ctrl+F5
(the browser caches `out/webclient/*.js`). After `server/` changes: restart
the server (`taskkill //PID <pid> //F`; `netstat -ano | grep :9989` to find
it). `quic_bridge.py` reloads per-spawn — no restart needed for it alone.

## Env vars

| var | where | effect |
|---|---|---|
| `JOIN_SCRIPT` | relay → bridge | pristine joinScript JSON (required — bridge exits without it) |
| `WT_PATH` | relay → bridge | WT CONNECT path+query (`/wt?X-Rbx-Capabilities=…`) |
| `NO_9B` | bridge | skip bridge-side challenge solving — engine answers alone |
| `BOBLOX_ROOT` | bridge | path to the external challenge-solver project (`solverd.exe` worker) |
| `PYTHON` | relay | Python executable used for the QUIC bridge (defaults to `python3` off Windows, `python` on Windows) |
| `RB_PORT` | serve.js | override port |

## Log glossary (`server.log`)

### `[server]` / `[api]` / `[session]` / `[relay]`

- `[server] :9989 — /api map(94)…` — boot ok, 94 domains.
- `[server] csrf token acquired` — POSTs will work.
- `[api] <domain> <path>` — forwarded upstream call. `(subdomain)` = engine's
  `*.localhost` http layer.
- `[api] <host> 302 -> …` — asset redirect followed server-side.
- `[session] captured join: place=… udmux=… rcc=…` — join landed.
- `[relay] bridge spawned for <udmux>` / `[relay] bridge exited (n)` — one
  python child per WT session.
- `[relay] udp -> ip:port` — legacy raw-udp path dialing.

### `[bridge]` — the session, in order

```
dial <udmux>:<netstack> rcc=<ip> sni=<qdmux>…
ALPN: h3                                  <- QUIC negotiated h3
*** QUIC handshake complete — sending WT CONNECT ***
CONNECT /wt?X-Rbx-Capabilities=<caps> on stream 0
h3 headers on 0: :status=200              <- WT session accepted
map shim-sid 0xN -> quic stream <qid>     <- engine opened a channel
tx sid=… qid=… <len>B <hex>               <- engine → server stream data
auth stream = qid 18                      <- a8 detected = chan-1 outbound
quic stream <qid> -> new shim-sid 0x4…    <- server opened a channel
rx st qid=… <len>B <hex>                  <- server → engine stream data
framed qid=… type=0xTT len=…              <- parsed channel messages (rx)
rewrote f8->9b challenge type on chan-1   <- engine will see the challenge
9b challenge … solving / answered / cached-reply
routes declared on chan11                 <- a6 post-answer
rx dg ctx=0 32B 05…                       <- chan-5 datagrams inbound
*** terminated code=1 reason='Idle timeout'  <- engine gave up (bad)
```

### Success signature

Streams both ways, `framed` messages marching, `0x81` peer-assign, `0xba`/
`0x97` replication, `tx` traffic back from the engine (`ba`/`fa`/acks),
`contentdelivery` fetches. Failure signature: `rx st` lines exist but no
`framed` parsing past `0x93`, no engine `tx` after peer-assign, then
`Idle timeout`.

## Failure modes → where to look

| symptom | cause | file |
|---|---|---|
| join `status:12` | browser-shaped headers leaked upstream | `specials.gamejoin` headers |
| join `status:18` | thin join body | `specials.gamejoin` body |
| `getaddrinfo -4` | engine can't resolve host | dns-shim `/udmux` poll, qdmux mint |
| WT CONNECT 400 | missing `X-Rbx-Capabilities` | `WT_PATH` env / NetStackConfig.caps |
| QUIC dies at crypto | bad SNI | `qdmuxName` grammar |
| `udp relay open timeout` | MSG_* handshake order | `msgMode` HELLO-first |
| session accepted, then stall→`Idle timeout` | inbound stream data dropped | ws-transport sid map, bridge delivery |
| `9b` answered but no `0x81` | wrong/stale answer, or A7 gate | solverd, `_answers` cache |
| bridge spawn fails | `python` not on PATH / no aioquic | env |
| CSRF 403s | token not learned | `[server] csrf token acquired` at boot |
| mid-session stalls | upstream DNS flapping | `pinnedLookup` refresh |

## Debug surfaces

- `GET /session` — captured endpoints.
- `GET /join` — pristine joinScript.
- `GET /udmux` — what dns-shim hands getaddrinfo.
- `out/engine-test.html` — socket-ring harness.
- `server.log` — the running journal (gitignored).
- `snap*.png` / `shot*.png` — screenshots from live runs.

---
*This document was written 100% by an AI model, based on roughly 4 months of
work, ~20 GB of captured data, and a map of all the context used during
decompilation and debugging.

If anything seems wrong or doesn't connect to the code, the doc was written
wrong — these docs weren't made perfect because they weren't strictly
required. If you spot an issue and have some time on your hands, please open
an issue for it!*
