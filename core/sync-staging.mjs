// sync-staging.mjs — pull every file declared in WebClient.metadata.json that
// is missing from core/staging/ down from the setup CDN through the local
// /api gateway (server-side DNS pinning resolves the setup CDN host).
//
//   node core/sync-staging.mjs [version-upload]
//
// version-upload defaults to the live client-version answer; pass e.g.
// version-db62701aba0b4bcd to pin a specific bundle.
import fs from 'fs';
import path from 'path';
import https from 'https';

const ROOT = path.resolve(import.meta.dirname, '..');
const STAGING = path.join(ROOT, 'core', 'staging');
const OUT = 'https://localhost:9989';
import crypto from 'crypto';
const tok = d => crypto.createHash('sha256').update(d).digest('hex').slice(0, 5);
const SETUP_ID = tok('setup');
const CS = tok('clientsettingscdn');

const meta = JSON.parse(fs.readFileSync(path.join(STAGING, 'WebClient.metadata.json'), 'utf8'));
// package-root files not listed in the manifest — the engine binary itself.
const PKG_FILES = ['WebClient.wasm'];

let upload = process.argv[2];
if (!upload) {
  const j = await getJson(`/api/${CS}/?arg=${Buffer.from('/v2/client-version/WebClientApp').toString('hex')}`);
  upload = j.clientVersionUpload;
  console.log(`[sync] live clientVersionUpload = ${upload}`);
}
if (!upload) { console.error('no version'); process.exit(1); }

const base = `/webclient/${upload}-RobloxWebClient`;
// fold the package-root files into the work list so a bare staging dir fully
// self-populates through the gateway
const all = [...PKG_FILES.filter(f => !meta.some(e => e.path === '/' + f)).map(f => ({ path: '/' + f })), ...meta];
let missing = all.filter(e => !fs.existsSync(path.join(STAGING, e.path.replace(/^\//, ''))));
console.log(`[sync] ${missing.length} of ${all.length} files missing (~${(missing.reduce((a, e) => a + (e.size || 0), 0) / 1048576).toFixed(0)} MB)`);

let ok = 0, fail = 0, bytes = 0;
// upstream CDN resets connections under load — low concurrency + retries
const CONC = 4;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchOne(e) {
  const rel = e.path.replace(/^\//, '');
  const dest = path.join(STAGING, rel);
  const url = `${OUT}/api/${SETUP_ID}/?arg=${Buffer.from(base + e.path).toString('hex')}`;
  for (let a = 0; a < 4; a++) {
    try {
      const buf = await getBuf(url);
      if (buf.length && e.size && buf.length !== e.size)
        console.log(`[sync] size mismatch ${e.path}: got ${buf.length} want ${e.size}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      return true;
    } catch (err) {
      if (a === 3) { if (fail++ < 20) console.log(`[sync] FAIL ${e.path}: ${err.message}`); return false; }
      await sleep(400 * (a + 1));
    }
  }
}
async function pool(items, fn) {
  const it = items[Symbol.iterator]();
  await Promise.all(Array.from({ length: CONC }, async () => {
    for (const x of it) await fn(x);
  }));
}
// passes until a pass makes no progress (transient upstream resets)
for (let pass = 1; pass <= 6; pass++) {
  const todo = all.filter(e => !fs.existsSync(path.join(STAGING, e.path.replace(/^\//, ''))));
  if (!todo.length) break;
  const before = ok;
  console.log(`[sync] pass ${pass}: ${todo.length} remaining`);
  await pool(todo, async e => { if (await fetchOne(e)) { ok++; bytes += fs.statSync(path.join(STAGING, e.path.replace(/^\//, ''))).size; if (ok % 200 === 0) console.log(`[sync] ${ok} ok (${(bytes / 1048576).toFixed(0)} MB)`); } });
  if (ok === before) { console.log('[sync] no progress — stopping'); break; }
  await sleep(2000);
}
const left = all.filter(e => !fs.existsSync(path.join(STAGING, e.path.replace(/^\//, '')))).length;
console.log(`[sync] done: ${ok} fetched, ${fail} failed, ${left} still missing, ${(bytes / 1048576).toFixed(1)} MB`);

function getJson(u) { return getBuf(u).then(b => JSON.parse(b.toString('utf8'))); }
function getBuf(u) {
  if (u.startsWith('/')) u = OUT + u;
  return new Promise((res, rej) => {
    https.get(u, { rejectUnauthorized: false }, r => {
      if (r.statusCode >= 400) { r.resume(); return rej(new Error('HTTP ' + r.statusCode)); }
      const c = []; r.on('data', d => c.push(d)); r.on('end', () => res(Buffer.concat(c)));
    }).on('error', rej);
  });
}
