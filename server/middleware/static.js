// middleware/static.js — out/ static serving + the landing page.
// Terminal middleware: anything not claimed by a route ends here.
module.exports = function staticMw(ctx) {
const fs = require('fs');
const path = require('path');
const { OUT, MIME, UP_DOMAIN, SERVER_DIR, forward } = ctx;
const wasmCache = new Map();  // path -> {etag, body} — wasm served from RAM
return function serveStatic(u, res, req) {
  let p = decodeURIComponent(u.pathname.split('?')[0]);
  // `/` is the landing page — mint a session there, it lands on /pg/<sid>/.
  // /play only skips the landing page when it actually names a place.
  if (p === '/' || (p === '/play' && !/[?&](id|placeId|gid)=/.test(u.search))) {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return fs.createReadStream(path.join(SERVER_DIR, 'landing.html')).pipe(res);
  }
  if (p === '/play') p = '/index.html';
  const legacySound = p.replace(/^\/webclient(?:\/content)?/i, '').toLowerCase();
  const soundAssetIds = {
    '/sounds/pageturn.wav': '12222076',
    '/sounds/rubber band sling shot.wav': '12222103',
    '/sounds/swoosh.wav': '12222200',
  };
  if (soundAssetIds[legacySound]) {
    return forward(`assetdelivery.${UP_DOMAIN}`, `/v1/asset?id=${soundAssetIds[legacySound]}`, req, res, { domain: 'assetdelivery' });
  }
  let f = path.normalize(path.join(OUT, p));
  if (!f.startsWith(OUT)) { res.statusCode = 403; return res.end() }
  // rbxasset://models/... resolves to /webclient/models/... but the CDN bundle
  // ships it under ExtraContent/ — fall back when the direct path misses
  if ((!fs.existsSync(f) || fs.statSync(f).isDirectory()) && p.startsWith('/webclient/')) {
    const f2 = path.normalize(path.join(OUT, '/webclient/ExtraContent/' + p.slice('/webclient/'.length)));
    if (f2.startsWith(OUT) && fs.existsSync(f2) && !fs.statSync(f2).isDirectory()) f = f2;
  }
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('not found') }
  // wasm pinned in RAM — 101MB re-streamed per load was the boot bottleneck;
  // keyed on mtime so a rebuild invalidates it
  if (f.endsWith('.wasm')) {
    const st = fs.statSync(f);
    const ce = wasmCache.get(f);
    const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
    res.setHeader('cross-origin-opener-policy', 'same-origin');
    res.setHeader('cross-origin-embedder-policy', 'require-corp');
    res.setHeader('content-type', MIME['.wasm']);
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('etag', etag);
    if (req.headers['if-none-match'] === etag) { res.statusCode = 304; return res.end(); }
    if (!ce || ce.etag !== etag) wasmCache.set(f, { etag, body: fs.readFileSync(f) });
    res.statusCode = 200;
    return res.end(wasmCache.get(f).body);
  }
  const st = fs.statSync(f);
  // SharedArrayBuffer (engine pthreads) needs crossOriginIsolated
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('cross-origin-embedder-policy', 'require-corp');
  res.setHeader('content-type', MIME[path.extname(f).toLowerCase()] || 'application/octet-stream');
  if (/\.(wasm|js|json)$/.test(f)) {
    // no-cache revalidates every load; pair it with an etag so unchanged files
    // answer 304 — the 101MB wasm was being re-sent (and re-compiled) per load
    res.setHeader('cache-control', 'no-cache');
    const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
    res.setHeader('etag', etag);
    if (req.headers['if-none-match'] === etag) { res.statusCode = 304; return res.end(); }
  }
  res.statusCode = 200;
  fs.createReadStream(f).on('error', () => res.destroy()).pipe(res);
};
}
