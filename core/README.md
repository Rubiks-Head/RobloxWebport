# rubiks-head/core — engine source tree

The WebAssembly engine (`WebClient.wasm`) is a compiled Roblox runtime. A true
1-to-1 C++ decompile of ~180 MB of optimized wasm is not feasible — the
compiler erases source structure. What this tree provides is the organized
engine layout plus the pieces that ARE source-controlled (the JS glue and the
network/transport layer), branded for rubiks-cube services.

```
core/
  wasm/        WebClient.wasm (engine binary) + decompile artifacts (.wat/.c
               for the host-side ABI + transport functions we actually own)
  js/          the engine's JS bundles, rebranded to rubiks-cube services:
               WebClient.js, WasmLoader.js, WasmPlayer.js, stub.js, driver.js
               — these are EXACT, only service hosts renamed roblox.com ->
               rubiks-cube endpoints where applicable
  src/         C++ source for the host-side layer (socket ABI, transport
               bridge, VFS shim) — the parts we control and can recompile
               into /out alongside the engine wasm
  build.*      emcc build -> ../out
```

## Recompiling

`WebClient.wasm` stays the upstream binary. `src/` holds the C++ for the
host-side transport/VFS shim (the shared-memory socket bridge, the
`rbx_fs_*`/RNA host functions) compiled with emscripten into `../out` next to
the wasm and js. The wasm itself is not decompiled to C++ — it can't be, and
it isn't needed for the network layer to work.
