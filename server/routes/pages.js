// routes/pages.js — the local surface: /pg session mint + resume,
// join/session introspection, stats, engine ABI, diagnostics.
module.exports = function initPages(r, ctx) {
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CORS, CFG, SERVER_DIR, relay, manifest, CACHE_DIR } = ctx;
const WT_META = ctx.WT_META;
const PG = /^\/pg\/([0-9a-f]{8,32})\/?$/;

r.get('/favicon.ico', (req, res) => { res.writeHead(204); res.end(); });

// POST /pg {token?, placeId?, joinMethod?} -> {sid, url} — mints a sid page;
// its api/join traffic runs under the session's own token + WARP egress.
r.post('/pg', (req, res) => {
  let body = '';
  req.on('data', c => { if ((body += c).length > 64e3) req.destroy(); });
  req.on('end', () => {
    let o = {}; try { o = JSON.parse(body); } catch {}
    const sess = ctx.mintSession(o);
    const url = `/pg/${sess.sid}/${sess.placeId ? `?gid=${sess.placeId}` : ''}`;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sid: sess.sid, url }));
  });
});

// GET /pg — the cookie's live session (landing-page resume card) plus
// whether a server default token exists so the field can be optional
r.get('/pg', (req, res) => {
  const s = req.sess;
  const url = s.sid ? `/pg/${s.sid}/${s.placeId ? `?gid=${s.placeId}` : ''}` : undefined;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(s.sid
    ? { sid: s.sid, url, placeId: s.placeId, defaultToken: !!ctx.TOKEN }
    : { defaultToken: !!ctx.TOKEN }));
});

// /pg/<sid>/ — the session page itself. Sets the rh_sid cookie and hands
// off to the static layer for the engine page.
r.get(PG, (req, res, u) => {
  const sess = ctx.SESS.get(PG.exec(u.pathname)[1]);
  if (!sess) { res.statusCode = 404; return res.end('unknown session'); }
  res.setHeader('set-cookie', `rh_sid=${sess.sid}; Path=/; SameSite=Lax; Secure`);
  // the sid owns its place — normalize to the canonical ?gid= URL
  if (sess.placeId && !/[?&](gid|placeId|id)=/.test(u.search)) {
    res.writeHead(302, { location: `/pg/${sess.sid}/?gid=${sess.placeId}` });
    return res.end();
  }
  ctx.serveStatic(new URL('/index.html', u), res, req);
});

r.get(/^\/(udmux|session)$/, (req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.sess.state.last() || {}));
});

// inbound replication traffic — the loading screen polls this to know
// when the world stream has settled before revealing the game. The
// native-WT front counts its own bytes in wt-stats.json — merge it so
// the settle logic works on either transport path.
r.get('/stats', (req, res) => {
  let wt = { rxBytes: 0 };
  try { wt = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'wt-stats.json'), 'utf8')); } catch {}
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    rxBytes: relay.stats.rxBytes + (wt.rxBytes || 0),
    rxMsgs: relay.stats.rxMsgs, at: relay.stats.at }));
});

// live txprobe — glue.js counters (engine write issue/pending) appended
r.post('/__txp', (req, res) => {
  const bufs = [];
  req.on('data', c => bufs.push(c));
  req.on('end', () => {
    try { fs.appendFileSync(path.join(SERVER_DIR, 'txp.log'), Buffer.concat(bufs) + '\n'); } catch {}
    res.writeHead(204); res.end();
  });
});

// engine-side diagnostic dump — glue.js POSTs the __engx ring when the
// engine fires a failure status (e.g. error 261) so the death self-reports
r.post('/__englog', (req, res) => {
  const bufs = [];
  req.on('data', c => bufs.push(c));
  req.on('end', () => {
    try { fs.writeFileSync(path.join(SERVER_DIR, 'englog-dump.txt'), Buffer.concat(bufs)); } catch {}
    res.writeHead(204); res.end();
  });
});

// native-WT front: the engine needs our cert's sha-256 DER hash for
// WebTransport serverCertificateHashes pinning. sid echoes back so the
// worker-side WT shim can put it on the CONNECT path — Chrome doesn't
// attach cookies to WebTransport CONNECTs
r.get('/wt-meta.json', (req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ...WT_META, sid: req.sess.sid || undefined }));
});

// what the cache holds — lets the client enumerate/prefetch game assets
// and lets us see which entries have derived variants (.lod/.min)
r.get('/asset-manifest.json', (req, res) => {
  const items = [];
  for (const [k, it] of manifest) {
    const kk = path.join(CACHE_DIR, k.split('|')[0] + '-' +
      crypto.createHash('sha1').update(it.p).digest('hex'));
    items.push({ p: it.p, s: it.s, ct: it.ct,
      lod: fs.existsSync(kk + '.lod'), min: fs.existsSync(kk + '.min') });
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ assets: items }));
});

// engine ABI + gate mailbox — served inline, not a captured artifact.
// ring layout: shared-mem socket ABI the engine reads at init; gate: the
// verdict mailbox the FSM polls. token = attestation it expects back.
r.get('/webclient/engine.json', (req, res, u) => {
  res.setHeader('content-type', 'application/json');
  // abi base tracks the wasm variant's relocated pin region (see
  // engine-launch.js TIER): std 0x7ff40000, low -0x40000000, min -0x50000000.
  const ABI_BASE = { std: 0x7ff40000, low: 0x3ff40000, min: 0x2ff40000 };
  const variant = u.searchParams.get('variant')
    || (u.searchParams.has('lowmem') || process.env.RBX_LOWMEM ? 'low' : 'std');
  const abiBase = ABI_BASE[variant] || ABI_BASE.std;
  res.end(JSON.stringify({
    abi: { base: abiBase, magic: 0, txHead: 4, txTail: 8, rxHead: 12, rxTail: 16, wake: 20, selects: 24, recvd: 28, addr: 32, peer: 48, updates: 52, slot: 1536, slots: 64, tx0: 128, rx0: 98432, maxDatagram: 1500 },
    gate: { abi: { base: abiBase + 0x40000, state: 0, len: 4, sig: 8, msg: 72, msgMax: 256 }, token: 'te_vP_JkCBwAAAAASMbdtsGWckVw5_KtWgnF8PU07mpNN-5qTqOdkJ4hiPl4X4ZcAhwll2BrGyjDMuTULwZQJf9gdoP6HNBtONnnnUjF38Fq1PKllNrM121JnPWnyIzQ2jS8MClJg6bxFH4L' },
  }));
});

// the captured joinScript for this session — the ws-relay debug path reads it
r.get('/join', (req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.sess.state.joinScript() || {}));
});

r.get('/rh-config', (req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ leavePage: CFG.leavePage || '' }));
});
}
