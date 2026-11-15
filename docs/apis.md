# The `/api` gateway

Every upstream HTTPS request — from page scripts, the engine's XHR shim, and
raw `fetch()` — takes exactly one shape:

```
<origin>/api/<domainId>/?arg=<hex(path+query)>
```

Example: `apiUrl('economy', '/v2/assets/1818/details')` →
`https://localhost:9989/api/a0a75/?arg=2f76322f...`

## Domain ids

`domainId = sha256(domain)[:5]`, computed identically in two places:

- client: `core/build.mjs` → `core/js/_ids.js` (generated `globalThis.API` map)
- server: `server/index.js` boot → `MAP[id] = {domain, host, args[]}` from
  `core/_ids-seed.json`'s `services` list

Because both sides derive the id, they can never desync — but `out/` must be
rebuilt for a new client bundle to ship. The server also accepts the literal
domain label in place of the id (`BY_DOMAIN`), which is what workers use when
`_ids.js` isn't loaded.

`host` resolution: `HOST_OVERRIDE` first (`universes` → `apis.roblox.com`),
then dotted names pass through, `RBXCDN`-pattern names (`c0`, `t0`, `setup`,
`cdn`…) get `.rbxcdn.com`, everything else gets `.roblox.com`.

`args[]` is an allowlist of upstream path prefixes per domain (`KNOWN_ARGS`) —
anything not matching is 403'd. Widen the list when new real paths appear.

## Two entry forms

1. **`/api/<id>/?arg=<hex>`** — decoded `arg` is the path+query. This is what
   `apiUrl()`/`toApiUrl()` emit.
2. **`<domain>.localhost:9989/…`** — Chrome resolves `*.localhost` to
   loopback; requests arrive with the subdomain in `Host` (engine's raw http
   layer, e.g. `assetdelivery.localhost:9989/v1/asset?hash=…`). `handleApi`
   maps the subdomain straight to the domain entry.
3. **`/api/<id>/<path>`** — path form used when the URL is a *base* that
   callers append segments to (`apiBase()`).

## Forwarding (`forward()`)

- **Headers**: engine request headers pass through minus hop-by-hop/host/
  cookie/origin/referer, then overlaid with desktop identity:
  `Roblox/WinInet` UA, `www.roblox.com` referer+origin, `.ROBLOSECURITY`
  cookie from `cnfg.json`, and the learned `x-csrf-token`.
- **CSRF**: prefetched at boot (`POST logout.roblox.com/v1/logout`), learned
  from any upstream 403 `x-csrf-token` response header, and the request
  retried once automatically.
- **Retry**: 429/5xx → up to 3 attempts with `300ms × attempt` backoff; socket
  errors same loop; upstream requests hard-timeout at 8s (`ETIMEDOUT`).
- **Redirects**: 3xx + `location` is followed **server-side** (rbxcdn asset
  redirects can't be followed cross-origin by the browser) and streamed back
  as a 200 — up to 5 hops.
- **CORS**: `access-control-allow-*: *` on every response.

## Special domain handlers (`specials`)

| domain | behavior |
|---|---|
| `gamejoin` | rewrites the POST body to the desktop join shape (`isTeleport`, `browserTrackerId`, `playSessionId`, `joinAttemptOrigin`, UUIDs), uses isolated desktop headers only (engine headers → `status:12`), 8 retries, runs `transformJoin` on the response |
| `assetdelivery` | `?hash=` → serves `server/inexperience.rbxm.gz` locally; `/v1/assets/batch` → answers locally with `location` pointing back at our `?hash=` route; else forwards (302s handled by `forward()`) |
| `clientsettingscdn` | injects FFlags/DFStrings into `applicationSettings` — forces the RbxTransport/QUIC client, kills the RakNet fallback, sets `DFStringRbxTransportQdmuxVip` to the captured udmux IP |
| `refract` | local stub — `{verdict:'ok'}`; the gate-verdict service it emulates lives client-side (gate mailbox) |

## `transformJoin` (the joinScript rewrite)

Applied to the gamejoin response before it reaches the page:

1. Stash a **pristine** joinScript copy server-side (`session.setJoinScript`)
   — the QUIC bridge needs fields the client-facing copy may have altered.
2. Synthesize the **qdmux DNS name**
   `{token32}-{rccIp8}-{rccPort4}.{vip8}.qdmux.roblox.com` and inject it into
   every `dnsName`/`fqdn`/`hostname` field — the engine mints its WT URL and
   SNI from it.
3. `BaseUrl` → `https://localhost:9989/` so engine-side URL building stays
   same-origin.
4. `session.capture(js)` — record udmux/machine/server endpoints for
   `/udmux` and the relay.

## Non-API routes

- `GET /join` — pristine joinScript JSON (debug).
- `GET /udmux` — `{ip, port}` datagram target for the dns-shim poller.
- `GET /session` — captured session dump (debug).
- `GET /webclient/engine.json` — socket ABI + gate mailbox layout + attestation
  token (see [socket-ring.md](socket-ring.md)).
- Static: everything else serves `out/` with cross-origin-isolation headers
  (COOP/COEP — required for `SharedArrayBuffer` pthreads). `/play` →
  `index.html`.

---
*This document was written 100% by an AI model, based on roughly 4 months of
work, ~20 GB of captured data, and a map of all the context used during
decompilation and debugging.

If anything seems wrong or doesn't connect to the code, the doc was written
wrong — these docs weren't made perfect because they weren't strictly
required. If you spot an issue and have some time on your hands, please open
an issue for it!*
