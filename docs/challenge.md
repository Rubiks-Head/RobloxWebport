# The 0x9B anti-cheat challenge

The last gate before replication. Documented here: what it is, how we answer
it, and how the engine is made to answer it itself.

## The exchange

Server → client, on app=4 chan-1, shortly after `0x93`:

```
[80 00 u16be len]  frame header (4B cvarint for ~2KB messages)
[f8]               wire type — the "generic challenge" carrier
[u1 u32le]         per-session value #1
[u2 u32le]         per-session value #2
[u32 len][blob]    ~1.9–2KB high-entropy challenge payload
                   (constant per server build; u1/u2 are per-session)
```

Client → server reply, on the client's chan-1 (auth) stream:

```
[09][9b][u2 u32le][answer u32le]    9-byte framed message
```

The answer is computed by running `blob` through `GenericChallengeService` —
a Luau VM program, not a hash (every simple-hash hypothesis was tested and
rejected — every simple-hash hypothesis failed). The server resends the
challenge until a reply lands in its window; a correct answer → `0x81` peer
assignment + replication.

## Two solvers, one gate

### 1. The bridge-side solver (`_maybe_solve_9b` / `_solve_and_reply`)

- Reassembles `[80 00 len]` frames per qid in `_sbuf` (consumed bytes are
  pruned — each frame is processed exactly once; the old rescan queued ~300
  duplicate solves per challenge).
- Detects `f8` → extracts `(u1, u2, blob)` → dedups on `(u1,u2,blob[:32])`
  via `_solving` (in-flight) and `_answers` (done → instant cached resends).
- Solve pipeline: `solve9b.ChallengeSolver.standardize(blob)` → "prog" →
  `solverd.exe` (long-lived stdin/stdout worker: `<prog> <u1:x> <u2:x> <job>`
  → `answer=<hex>`), all serialized under `_SOLVE_LOCK` because the solver's
  std_cache file races.
- Reply: `[09][9b][u2][ans]` on `_auth_qid` (the client's chan-1 stream —
  detected by the `a8` first message), reopening a fresh chan-1 stream if the
  original was finished.
- Post-answer: `a6` route declarations on chan-11 ~60 ms later
  (`_declare_routes`), matching native timing.
- `NO_9B=1` env → skip bridge solving, engine answers alone.
- `BOBLOX_ROOT` env → path to the external challenge-solver project: it
  provides the blob decoder (`solve9b`), the Luau challenge runtime, and the
  `solverd.exe` worker binary the bridge shells out to. Without it the bridge
  can still deliver the challenge — only the bridge-side fallback answer is
  unavailable.

### 2. The engine's own solver (the FSM we actually want)

The wasm has `GenericChallengeService` + `EnableGenericChallengeResponseHandling`.
Its dispatcher keys on internal type `0x9b`, but the WT wire carries `0xf8` —
so `_RxFrames` flips that single type byte in place, wherever the frame lands
across QUIC chunking (the old code only rewrote chunk-aligned frames).

With inbound delivery fixed (see shim-relay.md), the engine sees the
challenge, runs its in-wasm solver, and emits its own `[09][9b][u2][ans]`
followed by `0x8d`/ack traffic — the FSM completes *itself*; the bridge
answer just races it to satisfy the server early.

## Why answers were once "correct but rejected"

Early Python-client notes: a correct answer still got stream-reset `0x106` —
not an answer problem but session/integrity gating (A7 script-hash queue,
connection metadata). On the WT path the gate passes with just the answer —
replication (`0xba`, `0x97` zstd, `0x81`) follows within milliseconds.

## Watch it in the log

```
[bridge] framed qid=27 type=0xf8 len=1942 f8e97bd988...
[bridge] rewrote f8->9b challenge type on chan-1      <- engine sees it
[bridge] 9b challenge ... solving                     <- bridge races it
[bridge] solve9b] standardized blob 1929B -> 7256B
[bridge] 9b answered ans=0x5b609677
[bridge] framed qid=27 type=0x81 len=528              <- peer assigned
[bridge] tx sid=0x80000002 qid=18 ...ba               <- engine answers back
```

---
*This document was written 100% by an AI model, based on roughly 4 months of
work, ~20 GB of captured data, and a map of all the context used during
decompilation and debugging.

If anything seems wrong or doesn't connect to the code, the doc was written
wrong — these docs weren't made perfect because they weren't strictly
required. If you spot an issue and have some time on your hands, please open
an issue for it!*
