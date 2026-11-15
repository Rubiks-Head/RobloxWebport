# Server internals — `server/index.js`

One-file HTTPS server on `:9989` (self-signed `cert.pem`/`key.pem`).

## Request routing order

```
upgrade /udp-relay        → relay.js ws modes
GET  /webclient/engine.json → socket ABI + gate mailbox + token (inline)
GET  /join                → pristine joinScript JSON
GET  /udmux               → {ip,port} datagram target (dns-shim polls it)
GET  /session             → captured session dump
/api/<id>/?arg=<hex>      → domain handler (see apis.md)
<domain>.localhost/...    → same, keyed by Host subdomain
anything else             → static out/ (COOP/COEP isolation headers)
```

## Config (`cnfg.json`, gitignored)

```json
{ "port": 9989, "robloxAuthToken": "<.ROBLOSECURITY cookie>" }
```

The token is injected into upstream headers only — never reaches the page.

## Boot behavior

- builds `MAP` (`sha256(domain)[:5]` → `{domain,host,args[]}`) from
  `core/_ids-seed.json` — same derivation as `build.mjs`, can never desync.
- `refreshDns()` — resolve4 every upstream host once, re-resolve every 60 s;
  `pinnedLookup(host)` hands https a fixed IP (SNI/cert still get the real
  hostname). Kills mid-session DNS-flake stalls.
- `fetchCsrf()` — POST `logout.roblox.com/v1/logout` → harvest
  `x-csrf-token` for all POSTs.

## `lib/session.js`

`capture(joinScript)` stores `{placeId, jobId, udmux{ip,port},
machine{ip,NetStackPort}, server{ip,port}}` from each join response.
`datagramTarget()` = udmux → server → machine preference. `setJoinScript`
keeps the pristine object for the bridge (`JOIN_SCRIPT` env). All getters
are functions — `session.last()` not `session.last`.

## `lib/ws.js`

Minimal RFC6455: `accept()` does the 101 handshake; `WsConn` decodes masked
frames, reassembles continuations, ping→pong, `send()` binary only. No
extensions — enough for the relay.

## Special handlers (summary — full detail in apis.md)

- `gamejoin`: desktop-shaped body + isolated headers + `transformJoin`.
- `assetdelivery`: local `?hash=` + batch answers.
- `clientsettingscdn`: transport flag injection.
- `refract`: local verdict stub.

## Spawned children

`relay.js` `frameMode` → `python quic_bridge.py` per WT ws (env
`JOIN_SCRIPT`, `WT_PATH`; stderr inherited → `[bridge]` log lines).
`conn.on('close')` kills the child.

## Failure notes

- `status:12` on join = browser-shaped headers leaked upstream (gamejoin
  uses isolated headers for exactly this reason).
- `status:18` = thin join body (missing desktop fields).
- Bridge spawn fails → ws closes; check `python` resolves and aioquic is
  installed (`pip show aioquic`).
- Server restart is required after `server/` edits; `quic_bridge.py` itself
  reloads per spawn.

---
*This document was written 100% by an AI model, based on roughly 4 months of
work, ~20 GB of captured data, and a map of all the context used during
decompilation and debugging.

If anything seems wrong or doesn't connect to the code, the doc was written
wrong — these docs weren't made perfect because they weren't strictly
required. If you spot an issue and have some time on your hands, please open
an issue for it!*
