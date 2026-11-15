# Every outbound API & service used

Everything the webport talks to on Roblox's infrastructure, organized by what
it's for. The 94 routed domains come from the client's service seed; the
non-`/api` upstreams are hit directly by the server or synthesized locally.

## How they're reached

- **Via `/api/<id>/?arg=<hex>`** — engine + page HTTPS calls, forwarded with
  desktop-shaped headers (`Roblox/WinInet`, www referer/origin,
  `.ROBLOSECURITY`, learned CSRF token). See [apis.md](apis.md).
- **Via `<domain>.localhost`** — same routing, keyed by Host subdomain.
- **Direct server-side** — a handful of endpoints the server itself calls
  (CSRF harvest, DNS pinning covers them).
- **Game session plane** — UDP/QUIC to UDMux/qdmux edges; not HTTP at all.

## Identity & auth

| domain | upstream host | used for |
|---|---|---|
| `auth` | auth.roblox.com | authentication/session endpoints |
| `users` | users.roblox.com | `/v1/users/authenticated`, user lookups |
| `accountsettings` | accountsettings.roblox.com | account settings |
| `accountinformation` | accountinformation.roblox.com | account info |
| `twostepverification` | twostepverification.roblox.com | 2FA flows |
| `www` | www.roblox.com | web surfaces the engine touches |

Direct: `POST logout.roblox.com/v1/logout` — CSRF token harvest at boot (the
response's `x-csrf-token` header seeds all POSTs).

## Join & matchmaking

| domain | upstream host | used for |
|---|---|---|
| `gamejoin` | gamejoin.roblox.com | **the join** — `/v1|v2/join-game`, special-cased (desktop body + transform) |
| `matchmaking` | matchmaking.roblox.com | matchmaking service |
| `matchmaking-api` | matchmaking-api.roblox.com | matchmaking API |
| `games` | games.roblox.com | `/v1|v2/games` game metadata |
| `universes` | apis.roblox.com (override) | universe endpoints |
| `places` | places.roblox.com | place data |
| `gameserver` | gameserver.roblox.com | server-side surfaces |
| `ecsv2` | ecsv2.roblox.com | `/client`, `/timespent` experience signals |
| `experience-signals-ingest` | apis.roblox.com path | signal ingest (under `apis`) |
| `join` | join.roblox.com | join-adjacent service |

`assetgame.roblox.com/Game/Join.ashx` appears in join responses as
`joinScriptUrl` — informational; the engine uses the `joinScript` object
directly.

## Game session endpoints (non-HTTP)

| endpoint | protocol | role |
|---|---|---|
| `*.qdmux.roblox.com` | QUIC/h3 + WebTransport over UDP | the WT session the engine dials — SNI encodes token+rcc+vip |
| UDMux edge (`UdmuxEndpoints[].Address:Port`) | UDP + RUPP-wrapped QUIC | datagram/game endpoint behind the tunnel |
| RCC (`MachineAddress:NetStackPort`) | via UDMux | the actual game server process |

## Social & communication

| domain | host | used for |
|---|---|---|
| `friends` | friends.roblox.com | friends list |
| `contacts` | contacts.roblox.com | contacts |
| `social` | social.roblox.com | social graph |
| `groups` | groups.roblox.com | groups |
| `groupsmoderation` | groupsmoderation.roblox.com | group moderation |
| `followings` | followings.roblox.com | follow graph |
| `usermoderation` | usermoderation.roblox.com | user moderation |
| `notifications` | notifications.roblox.com | notifications |
| `chat` | chat.roblox.com | chat service |
| `privatemessages` | privatemessages.roblox.com | PMs |
| `presence` | presence.roblox.com | presence/heartbeat |
| `voice` / `voicechat` | voice*.roblox.com | voice services |
| `realtime` | realtime.roblox.com | realtime messaging |
| `textfilter` | textfilter.roblox.com | text filtering |

## Avatar, inventory & catalog

| domain | host | used for |
|---|---|---|
| `avatar` | avatar.roblox.com | avatar data |
| `avatarrender` | avatarrender.roblox.com | avatar render/headshot meta |
| `inventory` | inventory.roblox.com | inventory |
| `catalog` | catalog.roblox.com | catalog |
| `bundles` | bundles.roblox.com | bundles |
| `badges` | badges.roblox.com | badges |
| `thumbnails` | thumbnails.roblox.com | `/v1/batch`, `/v1/thumbnail` images |
| `itemconfiguration` | itemconfiguration.roblox.com | item config |

## Economy & marketplace

| domain | host | used for |
|---|---|---|
| `economy` | economy.roblox.com | `/v1|v2/assets`, purchases |
| `marketplace` | marketplace.roblox.com | marketplace |
| `trades` | trades.roblox.com | trades |
| `midas` | midas.roblox.com | premium currency |
| `premiumfeatures` | premiumfeatures.roblox.com | premium features |
| `pointbalancing` | pointbalancing.roblox.com | points |
| `advertising` | advertising.roblox.com | ads |

## Content & CDN

| domain | host pattern | used for |
|---|---|---|
| `assetdelivery` | assetdelivery.roblox.com | `/v1|v2/asset(s)` — model/mesh bytes; `?hash=` served locally |
| `contentdelivery` | contentdelivery.roblox.com | `/v1/bytes/scN/<hash>` — content-addressed blobs (the DataModel fetch flood) |
| `contentstore` | contentstore.roblox.com | `/v2/sc5`, `/v1/bytes` content store |
| `contentpool` | contentpool.roblox.com | content pool |
| `cdnproviders` | cdnproviders.roblox.com | CDN provider list |
| `clientsettings` | clientsettings.roblox.com | FFlag/settings |
| `clientsettingscdn` | clientsettingscdn.roblox.com | `/v2/client-version` — **special**: transport-flag injection |
| `setup` | setup.rbxcdn.com | `/webclient/<ver>-RobloxWebClient/` — engine bundle origin |
| `cdn`, `asset`, `web`, `static`, `c0`–`c7`, `t0`–`t2`, `tr`, `s0`, `e0`, `m0` | *.rbxcdn.com | static assets, images, fonts, meshes (RBXCDN pattern hosts) |

## Platform, config & experiments

| domain | used for |
|---|---|
| `apis` | apis.roblox.com catch-all: product-experimentation, player-hydration, experience-signals, cloud, api paths |
| `locale`, `localizationtables`, `translations`, `gameinternationalization` | i18n/locale data |
| `abtesting` | A/B experiments |
| `ropro`, `ropro-core` | Roblox production tooling surfaces |
| `lms` | learning/metrics service |
| `screentime` | screen-time limits |
| `sharelinks` | share links |
| `urlshortener` | URL shortening |
| `webcache` | web cache |
| `develop` | developer surfaces |
| `publish` | publish flows |
| `timespent` | timespent (also under ecsv2) |

## Telemetry & diagnostics

| domain | used for |
|---|---|
| `telemetry` | telemetry ingest |
| `metrics` | metrics |
| `tracing` | distributed tracing |
| `ephemeralcounters`, `ephemeralcounters.api` | ephemeral counters `/v1.0`,`/v1.1` |
| `sentry`, `sentry-relay` | error reporting |

## Local-only services (never forwarded)

| service | behavior |
|---|---|
| `refract` (`refract.best`) | gate-verdict stub — `{verdict:'ok'}` answered locally |
| `udmux` | local session endpoint info (`/udmux` route feeds dns-shim) |

## Not HTTP at all

- **QUIC/h3 + WebTransport** to `*.qdmux.roblox.com` — terminated by
  `quic_bridge.py`, carries RUPP-wrapped game traffic
- **UDP + RUPP** to UDMux edges — datagram plane, token-rotated TLVs
- **WebSocket** `/udp-relay` — same-origin tunnel between page and server

---
*This document was written 100% by an AI model, based on roughly 4 months of
work, ~20 GB of captured data, and a map of all the context used during
decompilation and debugging.

If anything seems wrong or doesn't connect to the code, the doc was written
wrong — these docs weren't made perfect because they weren't strictly
required. If you spot an issue and have some time on your hands, please open
an issue for it!*
