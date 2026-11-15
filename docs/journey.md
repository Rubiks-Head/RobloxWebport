# The 4-month reverse-engineering journey

How this project actually got here — the dead ends, the walls, what took the
longest, and what finally broke each one open. Written from the working
journal kept during the effort; dates are approximate session dates.

## Phase 0 — packet-level recon

Started from public Roblox protocol knowledge (RakNet packet tables,
dissector tools) plus memory dumps of a live client session. Established the
replication item vocabulary early: `0x83` data container, `0x97` schema,
`0x81` globals, ping/pong pairs. Nothing worked end-to-end yet — this phase
was vocabulary, not grammar.

## Phase 1 — the native client, statically (weeks)

IDA/Ghidra on `libroblox.so` (Android) and the Windows PE. Ghidra project +
headless scripts, memory dumps, live-process snapshots. Recovered:

- the **RUPP wrapper**: every UDP datagram is `[01 00][u16be len][TLV1
  token][TLV2 rcc-addr]` around the real QUIC packet — the UDMux edge routes
  on those TLVs and silently drops anything malformed
- the **join API**: `POST gamejoin.roblox.com/v1|v2/join-game` → SSE
  `ResponseReady` → joinScript; `status:12` = browser-shaped request denied
- the **QUIC fingerprint**: ngtcp2+OpenSSL, ALPN `rbx-rtcio`, byte-parity
  ClientHello (2 ciphers, 14 extensions in exact order, no GREASE, no cert
  compression), TLS ext `0xFF00` = 8-byte capabilities word negotiated
  local & remote
- the **app=4 join sequence**: `a8` early-auth → `A7` script-hash queue →
  `90` client-info → `92` nonce → `8A` join request → `8F` — verified
  byte-for-byte against live native captures

### The 0x9B challenge — first great wall

The server's anti-cheat gate: a ~2 KB blob that decodes (XOR + xxh32 + zstd)
to **Luau bytecode with every opcode remapped through two tables** — a custom
VM, not a hash. Environment has Roblox globals (`game.JobId`,
`UserSettings()`, `RunService:IsStudio()`), a bespoke PCG `Random`, and the
answer must land inside a **~15 ms window** — which is why the Python solver
always got stream-reset and the working path had to be C++ in-process.

Solved by building a byte-exact Roblox-flavored Luau sandbox: extract →
decode → opcode-standardize → run → answer in ~1 ms. First fully local solve
verified against 5 native captures, then live: `challenge=yes answered=yes
peer=yes resets=0` on Crossroads.

## Phase 2 — replication grammar (days)

With joins accepted, focus shifted to the receive side: live `.repl`
captures → frame walk → `0x97` schema snapshot (zstd, class/property
dictionaries + shared string table) → `0x83`/`0x16` JoinRecord batches →
instance tree with typed properties (CFrame, Color3, refs, BrickColor) →
JSONL emitter → Three.js viewer. End state: **100% of observed replication
parsed**, ~3,900 records per join.

## Phase 3 — the spawn gate (THE longest wall, ~2 weeks)

The server never spawned *our* character. Remote rigs replicated fine; ours
never appeared. This consumed more time than everything before it combined.

What was tried, in order:

- every plausible C2S item built and sent post-marker — **all dead**:
  wire-2 tick datagrams (reset ~50 ms), `0x8d` referents, `0x1c/0x64`
  capacity deltas (server value-checks the budget diff — nonzero always
  kills), `0x13` resolve-acks, `0x08` spawn request (tolerated, produces
  nothing), JoinDataItem/StreamDataItem (need internal cell state we don't
  have)
- ClientQoS — unforgeable (ChaCha20 session crypto, re-randomized per send)
- replayed attestation — dead end proven by **memory dump**: live sessions
  carry per-session `rbx<hex>` key-IDs; our replayed set matched *nothing*
  in live memory. The attestation is generated inside the real client,
  bound to the session, and cannot be forged offline
- parked-session analysis: "park is pre-decided" — the server decides
  spawn-worthiness before the client says anything
- an **injector** (suspended-launch + manual-map + thread hijack) to steal
  the native client's ordered C2S trace — worked, produced the full item
  vocabulary, but the trace confirmed the gate wasn't message content

**What solved it:** nothing — on the native path. The wall wasn't a missing
message; it was session-bound attestation only the genuine client binary
produces. That dead end *is* what pivoted the whole project to the wasm
client (below).

## Phase 4 — discovering the official web client (the pivot)

`play.roblox.com` was found serving a **real Emscripten client**: a
100 MB `WebClient.wasm`, ~168K functions, **uncloaked** (no Byfron) — every
opaque native mechanism readable as wasm bytecode. Playwright capture
harness built (wraps WebTransport/WebSocket/fetch/XHR/Worker across
pthread workers). Join injection proven: fulfill the engine's own
`join-game` POST with any joinScript and the engine proceeds exactly like a
real join.

Two walls here:

- **qdmux WT edge silence** — QUIC Initials to every probed edge got zero
  response, *including from the genuine client*. Looked like our bug for a
  while; turned out the WT listener simply wasn't deployed on that edge
  fleet at the time. Diagnostic matrix run: aioquic egress fine, all ports/
  DCs/SNI variants dead, genuine browser fails identically.
- **foreign-session replay** — feeding captured native replication into the
  engine got it to "in session" (`Replicator created`, `Assigned peer id`,
  world ticking) but never `LocalPlayer`: the engine's FSM only trusts
  responses to *its own* outbound handshake. Session-identity wall.

**Conclusion:** the only remaining path was giving the engine its *own* real
WT session — which is this repo.

## Phase 5 — the webport itself (this repo)

Browser can't do QUIC/WebTransport/RUPP, so three shims were built: a
WebTransport-shaped object over WebSocket (`WsTransport`), a DNS
fabricator for the engine's `getaddrinfo`, and the `/api` gateway for all
upstream HTTPS. `quic_bridge.py` (aioquic) terminates the real QUIC+h3+WT
session to the UDMux edge.

The debugging tail — each looked like a protocol problem, most were plumbing:

1. WT CONNECT 400 → missing `X-Rbx-Capabilities` (joinScript `caps`)
2. handshake dying at crypto → malformed qdmux SNI grammar
3. datagrams vanishing → aioquic h3 drops non-capsule datagrams; handled at
   the QUIC layer
4. **THE FSM STALL** — the big one: engine consumed peer-assign then went
   silent and timed out. Root cause was two stream-routing bugs, not
   protocol: announced server streams were registered under `sid|0x80000000`
   while data frames key the bare sid (all inbound stream bytes dropped),
   and chan-1 was aliased to the engine's *outgoing* stream whose readable
   it never holds, with its `06 01` preamble stripped. Engine only ever saw
   datagrams.
5. challenge rewrite only firing on lucky QUIC chunk boundaries →
   stream-aware frame tracker (`_RxFrames`)
6. `_maybe_solve_9b` rescanning the whole buffer per chunk → ~300 duplicate
   solves per challenge → prune + dedup

Final state: real WT session → auth → challenge → peer-assign → bidirectional
replication → DataModel populates.

## What took the longest, ranked

| problem | span | why it was hard | what ended it |
|---|---|---|---|
| 0x9B challenge | ~days | custom VM, remapped opcodes, 15 ms window | local Luau sandbox, byte-exact |
| spawn gate | ~2 weeks | session-bound attestation, unforgeable | nothing — pivoted to wasm |
| qdmux WT edge | ~days | zero diagnostics, fleet-side outage | edge fleet came up / correct SNI+caps |
| wasm FSM stall | ~session | symptoms upstream of a sid-keying bug | bare-sid registration + verbatim delivery |
| wasm dissection | ongoing | 100 MB, no symbols | func-strings xref index over mem strings |

The pattern: every "protocol mystery" that survived contact with the code
turned out to be plumbing — sid spaces, chunk boundaries, preamble offsets —
not missing protocol knowledge. The protocol was cracked early; the last
month was making the bytes actually arrive.

---
*This document was written 100% by an AI model, based on roughly 4 months of
work, ~20 GB of captured data, and a map of all the context used during
decompilation and debugging.

If anything seems wrong or doesn't connect to the code, the doc was written
wrong — these docs weren't made perfect because they weren't strictly
required. If you spot an issue and have some time on your hands, please open
an issue for it!*
