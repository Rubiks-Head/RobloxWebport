/* eslint-disable */
"use strict";
// WasmLoader.js — engine bootstrap (emitted by core/build.mjs from
// core/js/loader/*). Resolves the user channel + engine base URL through the
// /api gateway, then injects WasmPlayer.js. All upstream calls use apiUrl() —
// see shared/api-url.js.
(() => {
