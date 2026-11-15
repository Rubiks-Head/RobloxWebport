# engine decomp workspace

Tooling for analyzing `WebClient.wasm` (the Roblox engine binary, ~101MB,
168,937 functions). Binaries and generated trees are gitignored — regenerate
them with the tools below.

## pipeline

```bash
# 1. get wabt 1.0.41 (the last release with wasm-decompile + exnref support)
git clone https://github.com/WebAssembly/wabt && cd wabt && git checkout 1.0.41
cmake -B build && cmake --build build --target wasm-decompile wat2wasm wasm2wat

# 2. drop the engine binary here as WebClient.wasm, then:
node tools/split.mjs            # truncate -> wasm2wat -> funcs/ + src/<cat>/f*.wat
<wabt>/wasm-decompile --enable-all -o WebClient.dcmp.c WebClient.trunc.wasm
node tools/decompile-split.mjs  # -> csrc/<cat>/f<idx>_<name>.c (100% coverage)
node tools/strings-index.mjs    # -> strings.tsv (86k strings -> mem addrs)
node tools/func-strings.mjs     # -> func-strings.tsv (func -> referenced strings)
```

## artifacts

| file | purpose |
|---|---|
| `csrc/*/f*.c` | decompiled C-like source, one file per function (read for analysis) |
| `src/*/f*.wat` | same functions as editable WAT (this is what recompiles) |
| `sec_*.wat` | module sections (types/imports/globals/data) for rebuild |
| `strings.tsv` | mem addr -> string (FLog names, URLs, flags) |
| `func-strings.tsv` | func id -> strings it uses — the symbol index |
| `src/index.tsv` | func id -> category -> imported JS fns it calls |

## edit + rebuild

```bash
# find the func: grep func-strings.tsv for a log string / symbol
# read it:       csrc/<cat>/f<idx>_*.c
# patch it:      edit src/<cat>/f<idx>.wat
node tools/rebuild.mjs         # -> WebClient.patched.wasm (wat2wasm)
```

Then drop the patched wasm over `core/staging/WebClient.wasm` (or
`out/webclient/WebClient.wasm` for the served copy).

## notes

- `wasm2c` cannot handle this binary (threads/JSPI/EH) — WAT is the only
  round-trippable editable form. The `.c` files are for reading.
- No debug names in the binary; functions are `f<index>` — use
  `func-strings.tsv` + `index.tsv` to navigate.
- `sec_import.wat` = the entire JS host boundary (268 named imports).
