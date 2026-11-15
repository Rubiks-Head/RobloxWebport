// lib/proxy.js — upstream transport layer.
// WARP egress agents, DNS pinning, header shaping, the CDN disk+hot cache,
// and forward() — the one path every upstream request funnels through.
module.exports = function initProxy(ctx) {
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const dns = require('dns');
const child_process = require('child_process');
const {
  UP_CDN, UP_WWW, UP_LOGOUT, TOKEN, MAP, CFG, CORS,
  isCdnHost, WARP_SOCKS, SERVER_DIR,
} = ctx;
function socksHandshake(sock, host, port) {
  return new Promise((resolve, reject) => {
    sock.write(Buffer.from([5, 1, 0]));                       // v5, 1 method, no-auth
    sock.once('data', function auth(auth) {
      if (auth[0] !== 5 || auth[1] !== 0) return reject(new Error(`socks: auth method ${auth[1]}`));
      const hb = Buffer.from(host, 'ascii');
      sock.write(Buffer.concat([
        Buffer.from([5, 1, 0, 3, hb.length]), hb,            // CONNECT, domain form
        Buffer.from([(port >> 8) & 255, port & 255]),
      ]));
      sock.once('data', rep => {
        if (rep[0] !== 5 || rep[1] !== 0) return reject(new Error(`socks: connect ${host} -> ${rep[1]}`));
        resolve(sock);
      });
    });
  });
}
class WarpAgent extends https.Agent {
  // Agent.createSocket is async-capable: do the SOCKS5 handshake then layer
  // TLS on the tunnelled socket. Keeps keepAlive pooling per upstream host.
  constructor(opts, socks) { super(opts); this._socks = socks; }
  createSocket(req, opts, cb) {
    if (!this._socks) return super.createSocket(req, opts, cb);
    const host = opts.servername || opts.host;
    const port = opts.port || 443;
    const raw = net.connect(this._socks.port, this._socks.host);
    raw.once('error', cb);
    raw.once('connect', () => {
      socksHandshake(raw, host, port)
        .then(s => {
          const t = tls.connect({ socket: s, servername: host });
          t.once('secureConnect', () => cb(null, t));
          t.once('error', cb);
        })
        .catch(cb);
    });
  }
}
const UP_AGENT = new WarpAgent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 32 }, WARP_SOCKS);
const _agents = new Map([['', UP_AGENT]]);
function agentFor(socks) {
  const k = socks ? `${socks.host}:${socks.port}` : '';
  if (!_agents.has(k)) _agents.set(k, new WarpAgent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 32 }, socks || null));
  return _agents.get(k);
}
// ---------- DNS pinning -----------------------------------------------------
// mid-session DNS drops were stalling the whole boot — resolve each upstream
// host once, cache the IPs, refresh every 60s. https still gets the hostname
// for SNI/certs; only the TCP dial uses the pinned IP.
const DNS_IPS = new Map();
function refreshDns() {
  for (const host of [...Object.values(MAP).map(e => e.host), UP_LOGOUT]) {
    dns.resolve4(host, (e, addrs) => {
      const ip = addrs && addrs[0];
      if (!e && typeof ip === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) DNS_IPS.set(host, ip);
    });
  }
}
function pinnedLookup(cbHost) {
  const ip = DNS_IPS.get(cbHost);
  return (typeof ip === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(ip))
    ? (name, opts, cb) => opts && opts.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4)
    : undefined;
}
refreshDns();
setInterval(refreshDns, 60000).unref();
// CSRF token for POSTs — upstream 400s without it. Prefetched at boot via a
// POST that returns the token header; also captured from any 403 response.
const SKIP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'cookie', 'origin', 'referer']);
function upHeaders(domain, req) {
  const h = {};
  for (const k in req.headers) if (!SKIP.has(k)) h[k] = req.headers[k];
  h['user-agent'] = domain === 'gamejoin' ? 'Roblox/WinInet' : (req.headers['user-agent'] || 'Roblox/WinInet');
  h['referer'] = `https://${UP_WWW}/`;
  h['origin'] = `https://${UP_WWW}`;
  const sess = ctx.sessOf(req);
  h['x-csrf-token'] = req.headers['x-csrf-token'] || h['x-csrf-token'] || sess.csrf || ctx.CSRF;
  h['cookie'] = (sess.token || TOKEN) ? `.ROBLOSECURITY=${sess.token || TOKEN}` : '';
  return h;
}

// ---------- generic upstream forward ----------------------------------------
// percent-encode anything Node's http client rejects in a request target
// (space, controls, unicode, gen-delims we don't need) while preserving
// already-encoded %XX and legal pchar/query chars. Without this a single
// filename containing a space crashes the whole server.
const PATH_SAFE = /[A-Za-z0-9\-._~!$&'()*+,;=:@/?%]/;
function escapeReqPath(p) {
  let out = '';
  for (const ch of String(p)) {
    if (PATH_SAFE.test(ch)) { out += ch; continue; }
    for (const b of Buffer.from(ch, 'utf8')) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}
// ---------- cdn disk cache ---------------------------------------------------
// Immutable upstream assets (contentdelivery/assetdelivery/etc.) cached to
// disk keyed by domain+path+query — repeat loads and shared assets become
// local-disk speed instead of a round trip through the real CDN.
const CACHEABLE = new Set(['contentdelivery', 'assetdelivery', 'cdn', 'setup', 'static', 'thumbnails']);
const CACHE_DIR = path.join(SERVER_DIR, 'cache');
function cacheKey(domain, pathQ) {
  return path.join(CACHE_DIR, domain + '-' + crypto.createHash('sha1').update(pathQ).digest('hex'));
}
// hot in-memory tier on top of the disk cache — avoids a sync readFileSync
// per hit and makes repeat loads RAM-speed. LRU at ~64MB.
const HOT_MAX = 64 * 1024 * 1024;
const hotCache = new Map();   // key -> {hdr, body, size}

let hotBytes = 0;
function hotKey(domain, pathQ) { return domain + '|' + pathQ; }
function hotGet(domain, pathQ) {
  const k = hotKey(domain, pathQ);
  const e = hotCache.get(k);
  if (e) { hotCache.delete(k); hotCache.set(k, e); }   // touch LRU
  return e || null;
}
function hotPut(domain, pathQ, hdr, body) {
  const k = hotKey(domain, pathQ);
  const size = body.length;
  if (size > HOT_MAX / 4) return;        // don't cache single huge blobs
  while (hotBytes + size > HOT_MAX && hotCache.size) {
    const [fk, fe] = hotCache.entries().next().value;
    hotCache.delete(fk); hotBytes -= fe.size;
  }
  if (!hotCache.has(k)) { hotCache.set(k, { hdr, body, size }); hotBytes += size; }
}
// inflight dedup — concurrent misses for the same upstream asset share one
// fetch instead of double-pulling (join burst asks for many assets at once)
const inflight = new Map();   // key -> Promise<buf|null>

// --- asset variants + manifest -------------------------------------------
// After a cacheable body lands, a background preprocessor derives variants
// next to the cache entry:  *.lod = decimated low-poly mesh (engine picks
// its LOD tier internally; this shrinks what reaches us), *.min = lossless
// PNG repack. The manifest records what the cache holds so the client can
// enumerate/prefetch game assets later.
const LOWMESH = !!process.env.RBX_LOWMESH;
const manifest = new Map();       // key -> {p, s, ct, v} — hot index over db
for (const [k, v] of ctx.manifestSeed || []) manifest.set(k, v);
function manifestPut(key, pathQ, size, ct, variant) {
  const e = { p: pathQ, s: size, ct, v: variant || null };
  manifest.set(key, e);
  ctx.db.putManifest(key, e);
}
let pyAvail = true;
function queueVariant(domain, pathQ, hdr, buf) {
  if (!pyAvail) return;
  const isMesh = buf.slice(0, 8).toString('latin1') === 'version ';
  const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!isMesh && !isPng) return;
  const k = cacheKey(domain, pathQ);
  const dst = k + (isMesh ? '.lod' : '.min');
  if (fs.existsSync(dst) || fs.existsSync(dst + '.fail')) return;
  const p = child_process.spawn('python',
    [path.join(SERVER_DIR, 'preprocess.py'), k + '.bin', dst,
     ...(isMesh ? ['--lod', '0.25'] : ['--png'])], { stdio: 'ignore' });
  p.on('error', () => { pyAvail = false; });
  p.on('exit', c => { if (c !== 0) try { fs.writeFileSync(dst + '.fail', ''); } catch {} });
}

function cacheRead(domain, pathQ) {
  const hot = hotGet(domain, pathQ);
  if (hot) return { hdr: hot.hdr, body: hot.body };
  try {
    const k = cacheKey(domain, pathQ);
    const hdr = JSON.parse(fs.readFileSync(k + '.hdr', 'utf8'));
    // a derived variant can stand in: .min is a lossless-smaller PNG so it
    // is always safe; .lod is the decimated low-poly mesh — served only in
    // low-mesh mode (RBX_LOWMESH) so full quality stays the default
    const vfile = (LOWMESH && fs.existsSync(k + '.lod')) ? k + '.lod'
      : (fs.existsSync(k + '.min') ? k + '.min' : k + '.bin');
    const body = fs.readFileSync(vfile);
    hotPut(domain, pathQ, hdr, body);
    return { hdr, body };
  } catch { return null; }
}
function cacheWrite(domain, pathQ, headers, buf) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const k = cacheKey(domain, pathQ);
    const hdr = {};
    for (const h of ['content-type', 'content-encoding', 'cache-control']) if (headers[h]) hdr[h] = headers[h];
    fs.writeFileSync(k + '.hdr', JSON.stringify(hdr));
    fs.writeFileSync(k + '.bin', buf);
    hotPut(domain, pathQ, hdr, buf);
  } catch {}
}
function forward(host, pathQ, req, res, extra = {}) {
  pathQ = escapeReqPath(pathQ);
  const attempt = (extra._attempt || 0) + 1;
  const body = extra._body;
  const cacheable = req.method === 'GET' && CACHEABLE.has(extra.domain) && !body;
  if (cacheable) {
    const hit = cacheRead(extra.domain, pathQ);
    if (hit) {
      res.statusCode = 200;
      for (const k in hit.hdr) res.setHeader(k, hit.hdr[k]);
      // immutable assets (content-hashed CDN paths) get a long browser
      // lifetime — revalidation requests never even reach us next load
      if (/[0-9a-f]{32,}/.test(pathQ)) res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      for (const k in CORS) res.setHeader(k, CORS[k]);
      return res.end(hit.body);
    }
    // dedup: a second GET for the same missing asset queues behind the
    // first fetch instead of pulling upstream twice
    const key = hotKey(extra.domain, pathQ);
    const ws = inflight.get(key);
    if (ws) { ws.push({ host, pathQ, req, res, extra }); return; }
    inflight.set(key, []);
    let drained = false;
    const drain = () => {
      if (drained) return;
      drained = true;
      const w = inflight.get(key) || [];
      inflight.delete(key);
      for (const it of w) forward(it.host, it.pathQ, it.req, it.res, it.extra);
    };
    res.once('finish', drain);
    res.once('close', drain);
  }
  const doReq = () => {
    const ureq = https.request({
      host, path: pathQ, method: req.method, lookup: pinnedLookup(host), agent: extra.agent || ctx.sessOf(req).agent || UP_AGENT,
      headers: extra.headersOnly ? extra.headers : { ...upHeaders(extra.domain || '', req), 'content-type': req.headers['content-type'] || 'application/json', ...(extra.transform ? { 'accept-encoding': 'identity' } : {}), ...(extra.headers || {}) },
    }, ures => {
      const uc = [];
      ures.on('data', c => uc.push(c));
      ures.on('end', () => {
        const buf = Buffer.concat(uc);
        if (cacheable && ures.statusCode === 200) {
          cacheWrite(extra.domain, pathQ, ures.headers, buf);
          manifestPut(hotKey(extra.domain, pathQ), pathQ, buf.length,
            ures.headers['content-type'] || '');
          queueVariant(extra.domain, pathQ, ures.headers, buf);
        }
        if (ures.statusCode >= 400)
          console.error(`[api] upstream ${host} ${ures.statusCode} ${pathQ.split('?')[0]}`);
        // csrf challenge — learn the token and retry once
        const t = ures.headers['x-csrf-token'];
        if (t) { ctx.CSRF = t; ctx.sessOf(req).csrf = t; }
        if (ures.statusCode === 403 && t && !extra._retried) {
          req.headers['x-csrf-token'] = t;
          return forward(host, pathQ, req, res, { ...extra, _retried: true, _body: buf });
        }
        // transient upstream (429/5xx) — retry with backoff like the desktop client
        if ((ures.statusCode === 429 || ures.statusCode >= 500) && attempt < (extra.retries || 3)) {
          return setTimeout(() => forward(host, pathQ, req, res, { ...extra, _attempt: attempt, _body: buf }), 300 * attempt);
        }
        // asset delivery 302s to the CDN — the browser can't follow cross-origin,
        // so resolve the redirect server-side and stream the bytes back as 200
        if (ures.statusCode >= 300 && ures.statusCode < 400 && ures.headers.location && attempt < 5) {
          const loc = ures.headers.location;
          console.log(`[api] ${host} 302 -> ${loc.slice(0, 80)}`);
          const mod = https;  // CDN redirects are always https
          // resolve4 directly — CDN hosts aren't in DNS_IPS and the
          // system resolver can't see them (that's why pinnedLookup exists)
          const directLookup = (name, opts, cb) => dns.resolve4(name, (e, addrs) => {
            if (e) return cb(e);
            if (opts && opts.all) return cb(null, addrs.map(a => ({ address: a, family: 4 })));
            cb(null, addrs[0], 4);
          });
          const rreq = mod.get(loc, { headers: { 'user-agent': 'Roblox/WinInet' }, lookup: directLookup, agent: UP_AGENT }, rres => {
            res.statusCode = rres.statusCode;
            for (const k of ['content-type', 'content-encoding', 'content-length', 'cache-control'])
              if (rres.headers[k]) res.setHeader(k, rres.headers[k]);
            for (const k in CORS) res.setHeader(k, CORS[k]);
            rres.pipe(res);
          });
          rreq.setTimeout(8000, () => rreq.destroy(new Error('ETIMEDOUT')));
          rreq.on('error', () => { if (!res.headersSent) { res.statusCode = 502; res.end('redirect fetch failed'); } });
          return;
        }
        res.statusCode = ures.statusCode;
        for (const k of ['content-type', 'content-encoding', 'cache-control']) if (ures.headers[k]) res.setHeader(k, ures.headers[k]);
        for (const k in CORS) res.setHeader(k, CORS[k]);
        try {
          let body = buf;
          if (extra.transform) {
            // browsers send accept-encoding:gzip — upstream honors it and the
            // transform would see compressed bytes, silently no-op, and leak
            // raw upstream past every flag injection. Decompress before the
            // transform and drop the stale encoding header (body is plaintext
            // after this, and content-length was never copied so it stays
            // consistent).
            const enc = ures.headers['content-encoding'];
            if (enc === 'gzip') body = zlib.gunzipSync(buf);
            else if (enc === 'br') body = zlib.brotliDecompressSync(buf);
            else if (enc === 'deflate' || enc === 'zlib') body = zlib.inflateSync(buf);
            if (enc) res.removeHeader('content-encoding');
          }
          res.end(extra.transform ? extra.transform(body) : body);
        }
        catch { res.end(buf); }
      });
    }).on('error', e => {
      console.log(`[api] ${host} attempt ${attempt} failed: ${e.code || e.message}`);
      if (attempt < (extra.retries || 3))
        return setTimeout(() => forward(host, pathQ, req, res, { ...extra, _attempt: attempt, _body: body }), 300 * attempt);
      res.statusCode = 502; res.end(`upstream ${e.code || e.message}`);
    });
    // don't let a held-open upstream socket stall the retry loop
    ureq.setTimeout(8000, () => ureq.destroy(new Error('ETIMEDOUT')));
    if (body) ureq.write(body); ureq.end();
  };
  if (body !== undefined) return doReq();
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => { extra._body = Buffer.concat(chunks); doReq(); });
}
// req._body reuse for the 403 retry — forward() drains from the stream once;
// for the retry we need the buffered body, so wrap a synthetic emitter.
const origForward = forward;
forward = function (host, pathQ, req, res, extra) {
  if (req._body) {
    const bufs = [req._body];
    const fake = { on: (ev, fn) => { if (ev === 'data') bufs.forEach(fn); if (ev === 'end') fn(); }, headers: req.headers, method: req.method };
    return origForward(host, pathQ, fake, res, extra);
  }
  return origForward(host, pathQ, req, res, extra);
};


return {
  agentFor, UP_AGENT, refreshDns, pinnedLookup, upHeaders, escapeReqPath,
  cacheKey, cacheRead, cacheWrite, manifest, manifestPut, queueVariant,
  hotGet, hotPut, inflight, forward, CACHE_DIR, SKIP,
};
}
