/* eslint-disable */
// WebClient.js — emscripten glue + our browser-side shims (emitted by
// core/build.mjs from core/js/engine/webclient/*). The wasm binary generates
// absolute upstream URLs internally; toApiUrl() (shared/api-url.js, prepended
// by the build) converts them at the XHR boundary — the single point where
// rewriting is still unavoidable until the wasm is decompiled.
"use strict";

// Same-origin ws endpoint the server exposes (server/relay.js). Datagrams ride
// ?proto=udp frames; engine WebSockets ride ?proto=tcp&to=<host>:<port>.
var RELAY_URL = (typeof location !== "undefined" ? location.origin.replace(/^http/, "ws") : "ws://localhost:9989") + "/udp-relay";
