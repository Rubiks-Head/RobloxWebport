// decompile-split.mjs — split wasm-decompile output into per-function C files.
//  WebClient.dcmp.c -> csrc/<cat>/f<idx>_<name>.c (+ HEADER.c + index.tsv)
// Categories reuse src/index.tsv (import-call classification).
// Usage: node tools/decompile-split.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const cat = {};
const idxPath = path.join(ROOT, 'src', 'index.tsv');
if (fs.existsSync(idxPath))
  for (const l of fs.readFileSync(idxPath, 'utf8').split('\n')) {
    const p = l.split('\t'); if (p[1]) cat[p[0]] = p[1];
  }
const s = fs.readFileSync(path.join(ROOT, 'WebClient.dcmp.c'), 'utf8');
for (const c of ['graphics', 'net', 'auth', 'storage', 'audio', 'physics', 'ui', 'sys', 'core'])
  fs.mkdirSync(path.join(ROOT, 'csrc', c), { recursive: true });
const parts = s.split(/(?=^function )/m);
fs.writeFileSync(path.join(ROOT, 'csrc', 'HEADER.c'), parts[0]);
const B = {}; const idx = [];
for (const body of parts.slice(1)) {
  const nm = /^function (\w+)\([^)]*\)[^{]*\{ \/\/ func(\d+)/.exec(body);
  if (!nm) continue;
  const c = cat[nm[2]] || 'core';
  fs.writeFileSync(path.join(ROOT, 'csrc', c, `f${nm[2]}_${nm[1]}.c`), body);
  B[c] = (B[c] || 0) + 1;
  idx.push(`${nm[2]}\t${nm[1]}\t${c}`);
}
fs.writeFileSync(path.join(ROOT, 'csrc', 'index.tsv'), idx.join('\n'));
console.log(B, 'written:', idx.length);
