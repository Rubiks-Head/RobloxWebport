/* eslint-disable */
"use strict";
// stub.js — worker bootstrap.
//
// NOTE: at runtime emscripten pthreads importScripts WebClient.js directly
// (mainScriptUrlOrBlob resolves "stub.js" -> WebClient.js same-origin), so this
// file only exists as a safe fallback. It does NO fetch/XHR rewriting — API
// calls are already canonical /api/… URLs emitted by apiUrl()/toApiUrl() in
// WebClient.js, and same-origin relative URLs need no help.
(() => {
  const src = new URLSearchParams(self.location.search).get("src");
  if (!src) throw new Error("[stub] missing src parameter");
  const engineScriptUrl = new URL(src, self.location.href);
  if (engineScriptUrl.origin !== self.location.origin)
    throw new Error(`[stub] refusing to load cross-origin engine script ${engineScriptUrl}`);
  importScripts(engineScriptUrl.href);
})();
