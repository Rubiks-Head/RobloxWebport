/* eslint-disable */
"use strict";
// WasmPlayer.js — the browser player (emitted by core/build.mjs from
// core/js/player/*). Join flow: flags -> locales -> wasm module ->
// launchEngine -> joinScript handshake inside the wasm. Upstream calls use
// apiUrl() directly — no URL rewriting (see shared/api-url.js).
(() => {
