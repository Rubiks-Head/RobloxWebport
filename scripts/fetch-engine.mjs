#!/usr/bin/env node
// fetch-engine.mjs — pull the official web engine into core/staging/.
//
// The web player is published as a versioned package on the upstream CDN:
//   1. <clientsettingscdn>/<v2/client-version/WindowsPlayer>
//      -> { clientVersionUpload: "version-XXXXXXXX" }
//   2. <setup cdn>/webclient/<upload>-RobloxWebClient/<file>
//      -> the package files (WebClient.wasm, WebClient.js, ...)
//
// The wasm is ~96MB of proprietary engine code and is NOT distributed in this
// repo, and neither is the rest of the extracted content tree. Upstream
// hosts come from server/cnfg.json "upstream" (see cnfg.example.json) — no
// upstream literals live in this source tree.
//
//   node scripts/fetch-engine.mjs            # wasm only (matches staged JS)
//   node scripts/fetch-engine.mjs --set      # wasm + JS/metadata consistent set
//   node scripts/fetch-engine.mjs --upload version-XXXXXXXX   # pin a version
//
// If the direct CDN path is gated (403), the reliable path is to let the
// running app fetch it: start the server, then run `node core/sync-staging.mjs`
// which pulls every file in WebClient.metadata.json through the local /api
// gateway (server-side auth + DNS pinning). You can also dump the engine
// files from a real browser session (DevTools network tab / cache) into
// core/staging/.
//
// --set is the safe option if the staged JS and the fetched wasm must match;
// use it after pulling a repo update that bumps the staged engine files.

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGING = path.join(ROOT, 'core', 'staging');
const BINARY_TYPE = process.env.RBX_BINARY_TYPE || 'WindowsPlayer';
const CHANNEL = process.env.RBX_CHANNEL || ''; // e.g. "zflag" — empty = production

const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null } };
const UP = readJson(path.join(ROOT, 'server', 'cnfg.json'))?.upstream ||
           readJson(path.join(ROOT, 'server', 'cnfg.example.json'))?.upstream || {};
if (!UP.domain || !UP.cdn) {
  console.error('[fetch] no upstream config — set "upstream" in server/cnfg.json (see cnfg.example.json)');
  process.exit(1);
}

const VERSION_URL = (ch) =>
  `https://clientsettingscdn.${UP.domain}/v2/client-version/${BINARY_TYPE}` +
  (ch ? `/channel/${encodeURIComponent(ch)}` : '');
const SETUP_CDN = process.env.RBX_SETUP_CDN || `setup.${UP.cdn}`;
const BASE = (upload) => `https://${SETUP_CDN}/webclient/${upload}-RobloxWebClient`;

const args = new Set(process.argv.slice(2));
const wantSet = args.has('--set');
const uploadArg = (process.argv.find(a => a.startsWith('--upload=')) || '').split('=')[1];

const CORE_FILES = ['WebClient.wasm'];
const SET_FILES = ['WebClient.wasm', 'WebClient.js', 'WasmPlayer.js',
                   'WasmLoader.js', 'WebClient.metadata.json'];

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'Roblox/WinInet' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return resolve(get(new URL(res.headers.location, url).href));
      if (res.statusCode !== 200)
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const out = fs.createWriteStream(dest + '.tmp');
    https.get(url, { headers: { 'user-agent': 'Roblox/WinInet' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return res.resume(), resolve(download(new URL(res.headers.location, url).href, dest));
      if (res.statusCode !== 200)
        return res.resume(), reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      res.pipe(out);
      out.on('finish', () => out.close(() => { fs.renameSync(dest + '.tmp', dest); resolve(); }));
    }).on('error', reject);
  });
}

async function resolveUpload() {
  if (uploadArg) return uploadArg;
  const data = JSON.parse((await get(VERSION_URL(CHANNEL))).toString('utf8'));
  if (!data.clientVersionUpload)
    throw new Error(`no clientVersionUpload in ${JSON.stringify(data).slice(0, 200)}`);
  console.log(`[fetch] channel=${CHANNEL || 'production'} version=${data.version} upload=${data.clientVersionUpload}`);
  return data.clientVersionUpload;
}

const upload = await resolveUpload();
const base = BASE(upload);
let failed = 0;
for (const f of (wantSet ? SET_FILES : CORE_FILES)) {
  const dest = path.join(STAGING, f);
  process.stdout.write(`[fetch] ${base}/${f} `);
  try {
    await download(`${base}/${f}`, dest);
    console.log(`-> ${path.relative(ROOT, dest)} (${fs.statSync(dest).size}B)`);
  } catch (e) {
    failed++;
    console.log(`FAILED: ${e.message}`);
  }
}
if (failed) {
  console.log(`\n[fetch] ${failed} file(s) denied by the CDN. Fallback: start the`);
  console.log(`server and run "node core/sync-staging.mjs" — it pulls the whole`);
  console.log(`staged tree (wasm + content) through the local /api gateway.`);
  process.exit(1);
}
console.log('[fetch] done — content tree: node core/sync-staging.mjs, then rebuild: cd core && node build.mjs');
