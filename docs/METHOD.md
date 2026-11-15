# The Method

How a browser tab ends up as a fully-admitted Roblox client — real join,
real replication, live players — without reimplementing a single protocol.

The short version: **the client is not a client.** The engine is Roblox's own
`WebClient.wasm`, byte-for-byte their build, running unmodified in Chrome.
Everything around it exists to make each upstream boundary see the request
shape it was built to accept. Nothing is forged at the cryptography or
attestation layer — real cookie, real joinScript, real engine, real Chrome
TLS stack — so there is nothing to fail.

Upstream discriminates on *shape*, not identity. There are four surfaces
where the shape has to be right.

## 1. gamejoin — the "UA method" itself

`gamejoin.roblox.com` gates admission on whether the request looks like the
desktop launcher or like web play. `cnfg.json` `joinMethod` selects
(`auto | web | desktop`; aliases `nonskid`/`honest` → web,
`skid`/`ua` → desktop):

- **web (honest)** — the engine's own request passed through verbatim:
  `rbx-user-agent: Roblox/Web`, real Chrome UA, `referer`/`origin`
  `play.roblox.com`, thin body `{placeId, gameJoinAttemptId}`. Web-enabled
  places answer `status:2` + a real `gameFqdn`. Everything else answers
  `status:12` (playtest-only denial).
- **desktop (the UA method)** — the request reshaped to desktop-launcher
  form: `user-agent: Roblox/WinInet`, `referer`/`origin`
  `https://www.roblox.com`, and the desktop-shaped body:
  `{placeId, isTeleport:false, gameJoinAttemptId, browserTrackerId:0,
  playSessionId, eventId, launchData:'', joinAttemptOrigin:'PlayButton'}`.
  Admitted on places where the honest shape is denied — but `gameFqdn` comes
  back `null`, so the qdmux hostname is synthesized from the join payload.
- **auto** — try honest web first; on `status:12` or any denial, fall back
  to the desktop shape. This is the default and the right answer.

The lesson this encodes: the public web join is *real* — it just isn't
authorized for most places. You don't fake the check; you submit the form
the check was written for.

## 2. The /api gateway — URL laundering

The wasm emits absolute `https://*.roblox.com/...` URLs internally. One
boundary rewrites all of them: `toApiUrl()` →
`/api/<hexId>/?arg=<hex(path+query)>` where `hexId = sha256(domain)[:5]`.
The server decodes, then applies the shape each domain needs:

- `.ROBLOSECURITY` is injected **server-side** from `server/cnfg.json`
  (gitignored). The cookie never crosses the page boundary — the engine gets
  a placeholder so `document.cookie` reads don't break.
- CSRF tokens are captured from upstream 403s and retried automatically,
  mirroring the desktop client's backoff.
- Domains that reject the wasm's compact request shapes get repaired or
  acknowledged locally (thumbnail batch fields, fire-and-forget analytics).
- DNS is pinned per-domain with real SNI/cert — only the TCP dial goes to a
  fixed IP.

## 3. The wire — QUIC/WebTransport/RUPP

The engine's RbxTransport layer asks for `new WebTransport(...)`. It gets a
real one: a native aioquic H3 endpoint on UDP `:9988`. Behind it,
`quic_bridge.py` is a QUIC client to the real edge (udmux), and every
datagram is wrapped in RUPP:

```
[01 00][u16be total] [01 11 <subtype> <16B token>] [02 06 <RCC ip><port>]
```

- Handshake packets use subtype-1 with the join token.
- Post-handshake, subtype-2 must echo the **freshest observed tag** — stale
  values are silently dropped by the edge (`WEBPORT_RUPP_TAG=latest`).
  Join-token echoing fails closed (error 279); the observed-tag echo is the
  only shape the edge accepts.
- The extended CONNECT carries a real Chrome `user-agent` and
  `X-Rbx-Capabilities` (byte-reversed into TLS extension `0xFF00`); SNI
  follows the qdmux grammar; ALPN is `h3`.
- Streams are passed verbatim — 7-byte preambles
  `[06 01 <app> <chan u32be>]` and all — the engine's own channel layer
  parses them.
- **Datagrams are the unreliable plane and they are why this document
  exists.** Player position/physics updates ride QUIC DATAGRAM frames.
  aioquic's default `max_datagram_size=1200` leaves ~1181B of packet room;
  every ~1.2KB physics frame hit `QuicPacketBuilderStop` on every transmit
  and head-of-line-blocked the queue forever — players rendered, never
  moved. `max_datagram_size=1472` (Chrome's `max_udp_payload_size`) unblocks
  it. Oversize datagrams must be dropped, never queued — one of them wedges
  everything behind it.

## 4. Why attestation can't object

Every check upstream performs is satisfied with genuine material:

- `.ROBLOSECURITY` — your real account cookie.
- joinScript / browserTicket / challenge — answered by the real engine.
- TLS — Chrome's real stack for browser APIs; the QUIC leg carries the
  capabilities extension the engine itself produced.
- Engine — the official binary, unmodified. Integrity checks are
  checks *of the binary*; the binary is theirs.

The only synthesized data is routing (the qdmux hostname when
`gameFqdn:null`) and the RUPP envelope — which is the real wire format the
edge was already speaking.

## What this buys

`status:2` join on public places, the full replication session — peer
assign, world stream, ISR items both directions, unreliable physics
datagrams — a live DataModel with real players moving, indefinitely.

## What it costs

You inherit the engine's bugs and the platform's version treadmill: flags
drift, channels rotate, and every upstream shape change has to be re-derived
from wire captures again. `docs/` records the ones found so far — start
with `protocol.md`, `journey.md`, and `challenge.md`.
