// lib/join.js — joinScript transform + the two join shapes.
// transformJoin: synthesizes the qdmux dns name, captures the session for the
// relay. webJoinAttempt: the honest Web Play join (status:12 -> desktop UA
// fallback, handled by the gamejoin route).
module.exports = function initJoin(ctx) {
const https = require('https');
const { UP_QDMUX, UP_AGENT, UP_DOMAIN } = ctx;
// ---------- joinScript transform (desktop path + transport shaping) ---------
// The join response gets: synthesized qdmux dns name (engine resolves it via
// the dashed-ip suffix), NetStack fields stripped (forces RakNet over RbxTransport),
// session captured for the relay.
function hexIp(a) { return a.split('.').map(n => (+n).toString(16).padStart(2, '0')).join('') }
function qdmuxName(js) {
  // SNI grammar from native captures: {32-hex token}-{8-hex rccIp}-{4-hex
  // rccPort}.{vip-hex}.qdmux.<upstream> — the QUIC ClientHello needs it or the
  // server drops the handshake at the crypto phase.
  const e = js.UdmuxEndpoints[0];
  const tok = Buffer.from(js.NetStackTokenValue || js.TokenValue || '', 'base64').toString('hex').padEnd(32, '0');
  const rip = (js.MachineAddress || js.ServerConnections?.[0]?.Address || '')
    .split('.').map(n => (+n).toString(16).padStart(2, '0')).join('');
  const rport = (+js.NetStackPort || e.Port || 0).toString(16).padStart(4, '0');
  const vip = e.Address.split('.').map(n => (+n).toString(16).padStart(2, '0')).join('');
  return `${tok}-${rip}-${rport}.${vip}.${UP_QDMUX}`;
}
function injectDnsName(o, nm) {
  if (!o || typeof o !== 'object') return;
  for (const k of Object.keys(o)) {
    if (/dnsname|fqdn|hostname/i.test(k) && typeof o[k] !== 'object') o[k] = nm;
    else injectDnsName(o[k], nm);
  }
}
// strip transport-selection fields, KEEP NetStackTokenValue — it's the RUPP
// session token the handshake needs (pump logs session=no when it's missing)
// strip transport-selection fields (NetStackPort/Config make the engine pick a
// WT path whose stream semantics can't ride a UDP relay), KEEP NetStackTokenValue —
// it's the RUPP session token the handshake needs
// keep everything — NetStackPort/Config make the engine pick the WT path,
// which is now CORRECT: the relay terminates WT in a real aioquic client
// (quic_bridge.py). The joinScript's transport fields feed both sides.
const STRIP = new Set();
function stripRbx(o) {
  if (!o || typeof o !== 'object') return;
  for (const k of Object.keys(o)) STRIP.has(k) ? delete o[k] : stripRbx(o[k]);
}
function transformJoin(buf, st) {
  st = st || ctx.session;
  let j; try { j = JSON.parse(buf.toString('utf8')) } catch { return buf }
  const js = j.joinScript || j.JoinScript || j;
  if (Array.isArray(js.UdmuxEndpoints) && js.UdmuxEndpoints.length) {
    st.setJoinScript(JSON.parse(JSON.stringify(js)));   // pristine copy for /join
    // the legacy api host is retired and no longer resolves. The wasm avatar
    // parser expects the same query on the avatar host's v2 fetch endpoint.
    if (typeof js.CharacterAppearance === 'string') {
      try {
        const appearance = new URL(js.CharacterAppearance);
        if (appearance.hostname.toLowerCase() === `api.${UP_DOMAIN}` &&
            /^\/v1\.1\/avatar-fetch\/?$/i.test(appearance.pathname)) {
          appearance.hostname = `avatar.${UP_DOMAIN}`;
          appearance.pathname = '/v2/avatar/avatar-fetch/';
          js.CharacterAppearance = appearance.toString();
          console.log('[api:gamejoin] migrated legacy CharacterAppearance URL');
        }
      } catch {}
    }
    // web-approved joinScripts carry a REAL gameFqdn (web-route vip + 32-hex
    // token) — use it verbatim; only synthesize for native-shaped responses
    const nm = js.gameFqdn || js.GameFqdn || qdmuxName(js);
    injectDnsName(js, nm);
    if (js.BaseUrl) js.BaseUrl = 'https://localhost:9989/';   // engine resolves BaseUrl host too
    stripRbx(js);
    st.capture(js);
    console.log(`[api:gamejoin] udmux ${js.UdmuxEndpoints[0].Address}:${js.UdmuxEndpoints[0].Port} qdmux ${nm}`);
  }
  return Buffer.from(JSON.stringify(j));
}

// ---------- non-skid join: honest Web Play identity --------------------------
// The engine already emits the real web join: rbx-user-agent: Roblox/Web,
// {placeId, gameJoinAttemptId}, originating at the play host. Pass that
// through and upstream returns a REAL gameFqdn for web-enabled places —
// no desktop impersonation, no synthesized route. Denied places come back
// status:12 (playtest-only) → the caller falls back to the UA method.
function webJoinAttempt(host, pathQ, headers, bodyBuf, retried, cb, sess) {
  const ureq = https.request({
    host, path: ctx.escapeReqPath(pathQ), method: 'POST',
    lookup: ctx.pinnedLookup(host), agent: (sess && sess.agent) || UP_AGENT, headers,
  }, ures => {
    const uc = [];
    ures.on('data', c => uc.push(c));
    ures.on('end', () => {
      const buf = Buffer.concat(uc);
      const t = ures.headers['x-csrf-token'];
      if (t) {
        ctx.CSRF = t;
        if (sess) sess.csrf = t;
        if (ures.statusCode === 403 && !retried)
          return webJoinAttempt(host, pathQ, { ...headers, 'x-csrf-token': t }, bodyBuf, true, cb, sess);
      }
      let st; try { st = JSON.parse(buf.toString('utf8')).status } catch {}
      // 0 = launcher pending (the engine re-polls), 2 = approved
      const ok = ures.statusCode === 200 && (st === 0 || st === 2 || st === undefined);
      cb(ok, buf, st !== undefined ? st : `HTTP ${ures.statusCode}`);
    });
  });
  ureq.setTimeout(8000, () => ureq.destroy(new Error('ETIMEDOUT')));
  ureq.on('error', e => cb(false, null, e.code || e.message));
  ureq.end(bodyBuf);
}


return { transformJoin, webJoinAttempt, qdmuxName, injectDnsName };
}
