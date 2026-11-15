# Extracting & dissecting the engine

How `WebClient.wasm` (~101 MB, **168,937 functions**, no debug names) was
turned into an analyzable, patchable workspace — `core/src/engine/`.

## Pipeline (from `core/src/engine/README.md`)

```bash
# 1. wabt 1.0.41 — LAST release whose wasm-decompile handles exnref;
#    this binary needs threads/JSPI/EH support
git clone https://github.com/WebAssembly/wabt && cd wabt && git checkout 1.0.41
cmake -B build && cmake --build build --target wasm-decompile wat2wasm wasm2wat

# 2. drop the engine binary here as WebClient.wasm, then:
node tools/split.mjs            # truncate -> wasm2wat -> funcs/ + src/<cat>/f*.wat
<wabt>/wasm-decompile --enable-all -o WebClient.dcmp.c WebClient.trunc.wasm
node tools/decompile-split.mjs  # -> csrc/<cat>/f<idx>_<name>.c (100% coverage)
node tools/strings-index.mjs    # -> strings.tsv (86k strings -> mem addrs)
node tools/func-strings.mjs     # -> func-strings.tsv (func -> referenced strings)
```

### Artifacts

| file | purpose |
|---|---|
| `csrc/<cat>/f<idx>_<name>.c` | decompiled C-like source — READ for analysis |
| `src/<cat>/f<idx>.wat` | same functions as editable WAT — what recompiles |
| `sec_*.wat` | module sections (types/imports/globals/data/elem/export/start/tag) for rebuild |
| `strings.tsv` | mem addr → string (FLog names, URLs, flag names) |
| `func-strings.tsv` | func id → strings it references — THE symbol index |
| `src/index.tsv` | func id → category → imported JS fns it calls |
| `WebClient.dcmp.c` | monolithic decompile (reference) |
| `WebClient.trunc.wasm` | wasm2wat-friendly truncation |

### Workflow

1. Find the func: grep `func-strings.tsv` for an FLog string or symbol
   (`Assigned peer id = %u`, `GenericChallengeService`,
   `RbxTransportRnaExpConnection`, …).
2. Read `csrc/core/f<idx>_*.c` (decompiled bodies are obfuscated but legible
   enough to find constants, call graphs, log sites).
3. Patch `src/<cat>/f<idx>.wat`.
4. `node tools/rebuild.mjs` → `WebClient.patched.wasm` (wat2wasm).
5. Drop over `core/staging/WebClient.wasm` (or `out/webclient/` copy).

`wasm2c` can't handle this binary — WAT is the only round-trippable editable
form; `.c` files are read-only analysis.

## How the transport was extracted (worked example)

- `strings.tsv` grep `RbxTransport` → ~500 FLog sites:
  `RbxTransportRnaExpConnection`, `Connecting WASM WebTransport to {}`,
  `Opening send channel: app={} channelId={} reliability={}`,
  `Invalid WASM receive ring slot`, `Compat control: received
  OpenUnreliableChannel`, `RbxTransportClient ACK ReceiveChannelOpened`…
- `func-strings.tsv` back-maps each string to the function(s) referencing it
  → read those funcs → reconstruct: connection FSM, stream/channel model,
  receive-ring contract, compat-mode semantics.
- `glue.js`'s `__rbxWasmRna` implements the JS side of exactly that contract
  (ring slots, `streamAccepted`, `streamFin`, `streamError`, deferred
  callbacks) — it's the stock Roblox glue, captured.

## The companion research project

Alongside this repo lives an independent from-scratch Roblox client built over
the same ~4 months — a C++ QUIC/RakNet stack plus a Python reference — that
natively joined live servers and solved the challenge in-process. It is the
source of most of the protocol knowledge here:

- the join sequence and every message layout (early-auth, 0x90, 0x92, 0x8A,
  0x8F, 0x93, 0x9B, peer-assign, replication grammar)
- the RUPP TLV wrapper and token-rotation behavior
- the native QUIC ClientHello fingerprint (cipher list, extension order, no
  GREASE, no cert compression) and the 0xFF00 capabilities extension
- the challenge solver: blob XOR-decode → xxh32 check → zstd → wire-bytecode
  opcode standardization → Roblox-flavored Luau sandbox with the exact PCG
  `Random`, `game`/`UserSettings`/`RunService` shims
- frozen message captures used as byte-parity test vectors

Its solver binaries are what `quic_bridge.py` invokes through `BOBLOX_ROOT`
for the bridge-side challenge fallback. The knowledge is what matters — the
code itself lives outside this repo.

## What we verified by reading the binary

- The 268-import JS host boundary (`sec_import.wat`) — every hook point.
- `RbxTransportRnaExpConnection` supports a **compat mode** (`compatMode={}`
  in logs) where channel streams carry the desktop message types — why the
  server wire's `0xf8` needs rewriting to `0x9b`.
- `GenericChallengeService` + `EnableGenericChallengeResponseHandling` exist
  in-wasm → the engine can solve the challenge itself.
- `[FLog::Network] Assigned peer id = %u` — the FSM's own peer-assign log.

---
*This document was written 100% by an AI model, based on roughly 4 months of
work, ~20 GB of captured data, and a map of all the context used during
decompilation and debugging.

If anything seems wrong or doesn't connect to the code, the doc was written
wrong — these docs weren't made perfect because they weren't strictly
required. If you spot an issue and have some time on your hands, please open
an issue for it!*
