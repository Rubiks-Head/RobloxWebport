// lib/sessions.js — per-sid browser sessions.
// /pg/<sid>/ pages carry an rh_sid cookie; that sid's api + join traffic runs
// under its own token, CSRF, egress agent, and join state. Each sid pins one
// WARP_POOL entry (stable hash) — concurrent sids egress on different IPs.
// sids are also persisted to the db (metadata only — never tokens).
module.exports = function initSessions(ctx) {
const https = require('https');
const crypto = require('crypto');
const { TOKEN, UP_LOGOUT, WARP_SOCKS, WARP_POOL } = ctx;
// ---------- per-sid sessions -------------------------------------------------
// /pg/<sid>/ pages carry an rh_sid cookie; that sid's api + join traffic runs
// under its own token, CSRF, egress agent, and join state. Each sid pins one
// WARP_POOL entry (stable hash) — concurrent sids egress on different IPs.
const SESS = new Map();
function mintSession(opts = {}) {
  const sid = crypto.randomBytes(8).toString('hex');
  const socks = WARP_POOL.length
    ? WARP_POOL[[...sid].reduce((a, c) => a + c.charCodeAt(0), 0) % WARP_POOL.length]
    : null;
  const sess = {
    sid, token: opts.token || TOKEN, placeId: opts.placeId || null,
    joinMethod: opts.joinMethod || undefined,
    csrf: '', agent: ctx.agentFor(socks || WARP_SOCKS), socks,
    state: ctx.session.createSession(), created: Date.now(),
  };
  SESS.set(sid, sess);
  ctx.db.putSession({ sid, placeId: sess.placeId, joinMethod: sess.joinMethod,
    egress: socks ? `${socks.host}:${socks.port}` : null, created: sess.created });
  if (sess.token) fetchCsrf(sess);
  console.log(`[session] minted ${sid}${socks ? ` egress=${socks.host}:${socks.port}` : ''}`);
  return sess;
}
// requests without a sid share the global token/CSRF/agent/default state
const DEF_SESS = { sid: '', token: '', joinMethod: undefined, csrf: '', agent: ctx.UP_AGENT, state: ctx.session, socks: WARP_SOCKS };
function sessOf(req) {
  const m = /(?:^|;\s*)rh_sid=([0-9a-f]{8,32})/.exec(req.headers.cookie || '');
  return (m && SESS.get(m[1])) || DEF_SESS;
}

ctx.CSRF = '';
function fetchCsrf(sess) {
  const token = (sess && sess.token) || TOKEN;
  const r = https.request({
    host: UP_LOGOUT, path: '/v1/logout', method: 'POST', lookup: ctx.pinnedLookup(UP_LOGOUT), agent: (sess && sess.agent) || ctx.UP_AGENT,
    headers: { 'user-agent': 'Roblox/WinInet', 'cookie': token ? `.ROBLOSECURITY=${token}` : '', 'content-length': 0 },
  }, res => {
    const t = res.headers['x-csrf-token'];
    if (t) { if (sess) sess.csrf = t; else ctx.CSRF = t; console.log('[server] csrf token acquired'); }
    res.resume();
  });
  r.on('error', () => {});
  r.end();
}
fetchCsrf();


return { SESS, mintSession, sessOf, fetchCsrf };
}
