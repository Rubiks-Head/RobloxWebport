// split.mjs — decompile pipeline.
//  WebClient.wasm -> WebClient.trunc.wasm  (drop malformed trailing blob)
//                 -> WebClient.wat        (wat2wat --enable-all)
//                 -> funcs/batch_NNN.wat  (2000 funcs/file)
//                 -> src/<cat>/f<idx>.wat (one file per function, categorized
//                                          by which JS imports it calls)
//                 -> src/index.tsv        (func id -> category -> called imports)
// Usage: node tools/split.mjs [path-to-wasm2wat]
import fs from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const WASM2WAT = process.argv[2] || process.env.WASM2WAT ||
  path.resolve(ROOT, '../../../wabt-src/build41/wasm2wat.exe');
const SRC = path.join(ROOT, 'WebClient.trunc.wasm');
const ORIG = path.join(ROOT, 'WebClient.wasm');

// ---------- 1) truncate trailing non-wasm blob ----------
const src = fs.readFileSync(fs.existsSync(SRC) ? SRC : ORIG);
const u32 = (buf, o) => { let r = 0, s = 0; for (;;) { const x = buf[o++]; r |= (x & 0x7f) << s; s += 7; if (!(x & 0x80)) return [r, o] } };
{
  let p = 8, end = 8;
  while (p < src.length) { const id = src[p++]; const [sz, e] = u32(src, p); if (e + sz > src.length) break; p = e + sz; end = p; }
  if (!fs.existsSync(SRC)) { fs.writeFileSync(SRC, src.subarray(0, end)); console.log('truncate ->', end.toString(16)); }
}

// ---------- 2) wasm2wat ----------
const WAT = path.join(ROOT, 'WebClient.wat');
if (!fs.existsSync(WAT)) {
  if (!fs.existsSync(WASM2WAT)) throw new Error(`wasm2wat missing: ${WASM2WAT}`);
  execFileSync(WASM2WAT, ['--enable-all', '-o', WAT, SRC]);
  console.log('wat written');
}
const wat = fs.readFileSync(WAT);

// ---------- 3) split module children: funcs -> batch files, others -> sec_*.wat ----------
fs.mkdirSync(path.join(ROOT, 'funcs'), { recursive: true });
const BATCH = 2000;
let inStr = false, depth = 0, start = -1, kind = '', funcIdx = 0, batch = 0, batchCount = 0;
let batchF = null; const secs = {};
const kindAt = j => { let s = ''; while (wat[j] > 32 && s.length < 12) s += String.fromCharCode(wat[j++]); return s };
for (let i = 0; i < wat.length; i++) {
  const c = wat[i];
  if (inStr) { if (c === 92) { i++; continue } if (c === 34) inStr = false; continue }
  if (c === 34) { inStr = true; continue }
  if (c === 59 && wat[i + 1] === 59) { while (i < wat.length && wat[i] !== 10) i++; continue }
  if (c === 40) {
    if (depth === 1 && start < 0) {
      start = i; kind = kindAt(i + 1);
      if (kind === 'func') {
        if (!batchF || batchCount >= BATCH) { if (batchF) batchF.end(); batch++; batchCount = 0; batchF = fs.createWriteStream(path.join(ROOT, 'funcs', `batch_${String(batch).padStart(3, '0')}.wat`)); }
      } else if (!secs[kind]) secs[kind] = fs.createWriteStream(path.join(ROOT, `sec_${kind}.wat`));
    }
    depth++; continue;
  }
  if (c === 41) {
    depth--;
    if (depth === 1 && start >= 0) {
      const w = kind === 'func' ? batchF : secs[kind];
      if (w) { w.write(wat.subarray(start, i + 1)); w.write('\n') }
      if (kind === 'func') { funcIdx++; batchCount++ }
      start = -1; kind = '';
    }
    continue;
  }
}
if (batchF) batchF.end();
for (const k in secs) secs[k].end();
console.log('children split — funcs:', funcIdx, 'batches:', batch, 'sections:', Object.keys(secs).join(','));

// ---------- 4) per-func files under src/<cat>/ classified by called imports ----------
const CAT = {
  graphics: /webgl|gl_|canvas|render|shader|texture|framebuffer|viewport/i,
  net: /fetch|xhr|websocket|socket|dns|getaddrinfo|connect|sendto|recv|udp|tcp|http|url/i,
  auth: /auth|token|cookie|login|credential|oauth|csrf|jwt/i,
  storage: /storage|filesystem|file|cache|tombstone|localstorage|indexeddb|mkdir|_open|_read|_write/i,
  audio: /audio|sound|voice|midi/i,
  physics: /physics|contact|collision|simulat/i,
  ui: /input|pointerlock|mouse|keyboard|touch|gamepad|cursor|focus|blur|keydown|element|dom|devicepixel/i,
  sys: /futex|wait|async|sleep|date|time|random|crypto|longjmp|setjmp|throw|exit|abort|signal|pthread|thread|worker|atomics|malloc|free|realloc|memcpy/i,
};
const impTxt = fs.readFileSync(path.join(ROOT, 'sec_import.wat'), 'utf8');
const imps = []; let m;
const ire = /\(import "env" "([^"]+)"\s*\(func \(;(\d+);\)/g;
while ((m = ire.exec(impTxt))) imps[+m[2]] = m[1];
const impCat = {}; for (const i in imps) { impCat[i] = 'core'; for (const c in CAT) if (CAT[c].test(imps[i])) { impCat[i] = c; break } }
for (const c of [...Object.keys(CAT), 'core']) fs.mkdirSync(path.join(ROOT, 'src', c), { recursive: true });
const idx = []; const counts = {};
for (const f of fs.readdirSync(path.join(ROOT, 'funcs')).filter(x => x.endsWith('.wat')).sort()) {
  const s = fs.readFileSync(path.join(ROOT, 'funcs', f), 'utf8');
  for (const body of s.split(/(?=\(func )/)) {
    const nm = /^\(func \(;(\d+);\)/.exec(body); if (!nm) continue;
    const id = nm[1];
    const hits = {};
    for (const cm of body.matchAll(/\bcall\s+(\d+)/g)) { const ci = impCat[+cm[1]]; if (ci) hits[ci] = (hits[ci] || 0) + 1 }
    let cat = 'core', best = 0;
    for (const c in hits) if (hits[c] > best) { best = hits[c]; cat = c }
    fs.writeFileSync(path.join(ROOT, 'src', cat, `f${id}.wat`), body);
    const called = [...new Set([...body.matchAll(/\bcall\s+(\d+)/g)].map(x => imps[x[1]]).filter(Boolean))].slice(0, 4);
    idx.push(`${id}\t${cat}\t${called.join(',')}`);
    counts[cat] = (counts[cat] || 0) + 1;
  }
}
fs.writeFileSync(path.join(ROOT, 'src', 'index.tsv'), idx.join('\n'));
console.log('per-func split:', counts, 'total:', idx.length);
