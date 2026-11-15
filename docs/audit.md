# rubiks-head audit — every outbound call the client makes

Sources: `core/js/*.js` (de-minified from `out/…/_next/chunks/*` + `assets/webclient/*`).
`api-map.json` has the raw per-file hits. `services.js` maps each to an upstream.

## Auth / session (server-injected; client must never see the token)
- `users.roblox.com/v1/users/authenticated` — `918-` `_()`. Checks `401/403` ->
  login redirect. **Neutered** in `918-` (`return false`) + `location.replace` -> `console.warn`.
- `clientsettings.roblox.com/v2/user-channel?binaryType=WebClientApp` — channel.
- `clientsettingscdn.roblox.com/v2/settings/application/WebClientApp` — FFlags.
- `locale.roblox.com/v1/locales/...` — locale/locus.

## Join / game (dynamic per-session)
- `gamejoin.roblox.com/v1/join-game` POST — returns `{status:2, joinScript:{...}}`.
  Server must STRIP `joinScriptUrl` (dead Join.ashx) so engine uses embedded `joinScript`.
- `apis.roblox.com/matchmaking-api/v1/client-status` — join status poll.
- `games.roblox.com/v1/games?universeIds=` — game meta.
- `develop.roblox.com/v1/universes/<id>` — dev info.
- `groups.roblox.com/v2/groups/<id>/users`, `friends.roblox.com/v1/users/<id>/friends/statuses`,
  `voice.roblox.com/v1/settings`, `gameinternationalization.roblox.com/v1/...`,
  `apis.roblox.com/access-management`, `apis.roblox.com/universes/v1/...`.

## Assets / content
- `economy.roblox.com/v2/assets/<placeId>/details` — product info (`ue` builds it).
- `assetdelivery.roblox.com/v1/asset?hash=` + `/v1/assets/batch` — place assets.
- `contentdelivery.roblox.com/v1/bytes/<acl>` — signed content.
- `thumbnails.roblox.com/v1/games/icons` + `multiget/thumbnails` + `/v1/batch`.
- `setup.rbxcdn.com/webclient/version-*-RobloxWebClient/*` — engine wasm/js/content.
- `c0–c7/t0–t7/tr.rbxcdn.com` — CDN shards.

## Telemetry / sinks
- `ecsv2.roblox.com/client/pbe` + `/timespent/pbe` + `/pe`.
- `ephemeralcounters.api.roblox.com/v1.1/Counters/BatchIncrement` + `v1.0/SequenceStatistics`.
- `apis.roblox.com/experience-signals-ingest/public/v1/events/single`.
- `tracing.roblox.com/v1/traces`.
- `sentry-relay.rbxinfra.com/api/26/envelope/` — crash reports.

## Transport (NOT http — ws/udp)
- `driver.js` `rupp.setJoinScript(joinScript)` — hands `UdmuxEndpoints` to transport.
- `WebClient.js` `ws://127.0.0.1:8444/udp-relay` + `?to=<host>:<port>` — datagram relay.
- `/udmux` — local endpoint the page fetches for the current UDMux name.
- `stub.js` service-rewrite -> `/services/<svc>` for all `*.roblox.com`/`*.rbxcdn`/`*.localhost`.

## Per-URL server
`server/routes.js` implements an explicit handler for each endpoint above —
`POST /v1/join-game`, `client-status`, `economy details`, `universes`,
`thumbnails`, `clientsettings`, `assetdelivery`, `contentdelivery`, telemetry
sinks, and the `/udmux` + `/udp-relay` transport — instead of a lazy proxy.
