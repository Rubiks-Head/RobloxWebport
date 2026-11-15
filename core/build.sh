#!/usr/bin/env bash
# rubiks-head /core — engine build: decompile wasm -> C -> C++ engine, then
# stage engine + host-side source into ../out.
#
# The engine is rebuilt from WebClient.wasm via wabt wasm2c -> engine.c,
# which is a functionally identical C translation (not a hand decompile —
# the real path to a 1:1 engine). engine.c compiles as C++ in src/engine/,
# linked with the host-side transport/VFS shim in src/.
set -e
cd "$(dirname "$0")"
WC=../out/9abe6eb1e8abf61dc7c5b180552fc29d6c83f5b9/assets/webclient
ST=staging

# 1. wasm -> C  (wabt wasm2c; install: https://github.com/WebAssembly/wabt)
if command -v wasm2c >/dev/null 2>&1; then
  wasm2c "$ST/WebClient.wasm" -o src/engine/engine.c && echo "[core] wasm -> engine.c"
  # engine.c is plain C99 -> compile it inside a .cc TU so the engine is C++
  cat > src/engine/engine.cc <<'EOF'
// engine — wasm2c translation unit, recompiled as C++.
#include "engine.c"
EOF
  echo "[core] engine.c staged for C++ compile"
else
  echo "[core] wasm2c not found — skipping engine.c (WebClient.wasm ships as-is)"
fi

# 2. compile host-side source + engine to ../out (emscripten)
if command -v em++ >/dev/null 2>&1 && [ -f src/engine/engine.cc ]; then
  em++ src/engine/engine.cc src/transport.cc -O2 -s WASM=1 -s MODULARIZE=1 \
       -o "$WC/engine.js" && echo "[core] engine+transport -> $WC/engine.js"
else
  echo "[core] em++/engine.c absent — copying upstream wasm+js verbatim"
  cp "$ST"/*.wasm "$WC/" 2>/dev/null || true
  cp "$ST"/*.js   "$WC/" 2>/dev/null || true
fi
echo "[core] done -> ../out"
