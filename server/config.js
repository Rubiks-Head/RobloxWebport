// config.js — cnfg.json + env overrides + upstream host map.
// Everything derived from config lives here so no module hardcodes a host.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SERVER_DIR = __dirname;
const CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'cnfg.json'), 'utf8')) } catch { return {} } })();
// config-less checkouts still boot: unset keys fall back to the example
// file's values. Secret placeholders are dropped, not inherited.
try {
  const ex = JSON.parse(fs.readFileSync(path.join(__dirname, 'cnfg.example.json'), 'utf8'));
  for (const k in ex) if (CFG[k] === undefined) CFG[k] = ex[k];
} catch {}
if (String(CFG.robloxAuthToken || '').startsWith('<')) delete CFG.robloxAuthToken;
// env overrides — embedders launch without any config file (see ../index.mjs)
if (process.env.RH_TOKEN) CFG.robloxAuthToken = process.env.RH_TOKEN;
if (process.env.RH_JOIN_METHOD) CFG.joinMethod = process.env.RH_JOIN_METHOD;
if (process.env.RH_WEB_UA) CFG.webUserAgent = process.env.RH_WEB_UA;
if (process.env.RH_UPSTREAM) { try { CFG.upstream = JSON.parse(process.env.RH_UPSTREAM); } catch {} }
const PORT = +(process.env.RH_PORT || CFG.port || 9989);
// upstream host config — every upstream hostname derives from cnfg.json
// "upstream" so the source tree carries no upstream literals. Required:
// { domain, cdn, infra?, labs?, extra?[] } — see cnfg.example.json.
const UP = CFG.upstream || {};
const UP_DOMAIN = UP.domain, UP_CDN = UP.cdn;
if (!UP_DOMAIN || !UP_CDN) {
  console.error('[server] cnfg.json missing "upstream" {domain, cdn, infra?, labs?, extra?[]} — see cnfg.example.json');
  process.exit(1);
}
const UP_LABS = UP.labs || '';
const UP_EXTRA = Array.isArray(UP.extra) ? UP.extra : [];
const UP_QDMUX = `qdmux.${UP_DOMAIN}`;
const UP_WWW = `www.${UP_DOMAIN}`;
const UP_PLAY = `play.${UP_DOMAIN}`;
const UP_LOGOUT = `logout.${UP_DOMAIN}`;
const isCdnHost = h => h === UP_CDN || h.endsWith('.' + UP_CDN) ||
  UP_EXTRA.some(x => h === x || h.endsWith('.' + x));
// upstream connection reuse — hundreds of api calls/session; a fresh TLS
// handshake per request is the dominant per-call latency.
// Upstream connections go direct by default. Set WARP_SOCKS=on (or
// host:port) to tunnel through Cloudflare WARP's local SOCKS5 listener
// (warp-cli mode proxy → 127.0.0.1:40000). The CONNECT request carries the
// hostname, so WARP resolves DNS remotely — useful when local upstream CDN
// resolution is poisoned. WARP_SOCKS=off or unset = direct.
// egress pool — cnfg "warpProxies": ["host:port", ...]. Each /pg session pins
// one entry (stable hash on sid) so concurrent sessions egress upstream on
// different IPs. Empty pool -> every session shares WARP_SOCKS/direct.
const WARP_POOL = (Array.isArray(CFG.warpProxies) ? CFG.warpProxies : [])
  .map(s => { const [h, p] = String(s).split(':'); return { host: h || '127.0.0.1', port: +p || 40000 }; });
const WARP_SOCKS = (process.env.WARP_SOCKS === undefined || process.env.WARP_SOCKS === 'off' || process.env.WARP_SOCKS === '')
  ? null
  : process.env.WARP_SOCKS === 'on'
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out');
// id -> {domain, host, args[]} — computed at boot from the same scheme the
// client uses (build.mjs): id = sha256(domain)[:5]. Deterministic, no shared
// file, can never desync across builds.
const seed = require(path.join(ROOT, 'core', '_ids-seed.json'));
const RBXCDN = /^(c\d+|t\d+|tr|s\d+|setup|static|cdn|asset|web|e\d+|m\d+)$/;
// host overrides — domains that don't exist as <domain>.<upstream domain>
const HOST_OVERRIDE = { universes: `apis.${UP_DOMAIN}`, fts: `fts.${UP_CDN}`, 'ephemeralcounters.api': `ephemeralcounters.api.${UP_DOMAIN}` };
// arg = decoded path prefixes this domain accepts — from real engine traffic,
// not the upstream path shape (engine prepends /<domain>/ to some paths).
const KNOWN_ARGS = {
  gamejoin: ['/v1/join-game'],
  assetdelivery: ['/v1/asset', '/v1/assets', '/v2/asset', '/v3/'],
  users: ['/v1/users'], universes: ['/universes/', '/v1/', '/v2/'],
  games: ['/v1/games', '/v2/games'],
  economy: ['/v1/', '/v2/'],
  thumbnails: ['/v1/batch', '/v1/thumbnail', '/v1/games'],
  gameinternationalization: ['/v1/', '/v2/'],
  apis: ['/'],
  ecsv2: ['/client', '/timespent'],
  'ephemeralcounters.api': ['/v1.0', '/v1.1'],
  contentstore: ['/v2/sc5', '/v1/bytes', '/sc5'],
  cdn: ['/'], fts: ['/'],
};
const MAP = {};
for (const d of seed.services) {
  const id = crypto.createHash('sha256').update(d).digest('hex').slice(0, 5);
  MAP[id] = {
    domain: d,
    host: HOST_OVERRIDE[d] || (d.includes('.') ? d : (RBXCDN.test(d) ? d + '.' + UP_CDN : d + '.' + UP_DOMAIN)),
    args: KNOWN_ARGS[d] || ['/'],
  };
}
const TOKEN = CFG.robloxAuthToken || '';
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.dds': 'application/octet-stream',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.otf': 'font/otf', '.tex': 'application/octet-stream', '.ico': 'image/x-icon',
};

// session capture lives in lib/session (shared with the relay — it reads the
// datagram target for ?proto=udp mode)

// ---------- shared request headers ------------------------------------------
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
// pass the engine's own headers through (it sends custom ones like
// AssetDeliveryRequestType that upstream requires) minus hop-by-hop/host —
// then overlay the desktop identity headers.

module.exports = {
  CFG, PORT, TOKEN, MAP, ROOT, OUT, SERVER_DIR,
  UP_DOMAIN, UP_CDN, UP_LABS, UP_EXTRA, UP_QDMUX, UP_WWW, UP_PLAY, UP_LOGOUT,
  isCdnHost, WARP_POOL, WARP_SOCKS, MIME, CORS,
};
