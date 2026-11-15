// func-strings.mjs — build func-strings.tsv: func id -> strings it references.
// Scans each src/<cat>/f*.wat for i32.const <addr> and resolves via strings.tsv.
// This is the browsing index: grep a string to find the funcs that use it.
// Usage: node tools/func-strings.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const strs = new Map();
for (const l of fs.readFileSync(path.join(ROOT, 'strings.tsv'), 'utf8').split('\n')) {
  const i = l.indexOf('\t'); if (i > 0) strs.set(+l.slice(0, i), l.slice(i + 1));
}
const addrs = [...strs.keys()].sort((a, b) => a - b);
function lookup(a) {
  let lo = 0, hi = addrs.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (addrs[m] <= a) { r = m; lo = m + 1 } else hi = m - 1 }
  if (r < 0) return null;
  const A = addrs[r];
  return a >= A + strs.get(A).length ? null : strs.get(A);
}

const idx = [];
const src = path.join(ROOT, 'src');
for (const dir of fs.readdirSync(src)) {
  const dp = path.join(src, dir);
  if (!fs.statSync(dp).isDirectory()) continue;
  for (const f of fs.readdirSync(dp)) {
    const nm = /^f(\d+)\.wat$/.exec(f); if (!nm) continue;
    const body = fs.readFileSync(path.join(dp, f), 'utf8');
    const hits = [...new Set([...body.matchAll(/i32.const (\d+)/g)].map(x => lookup(+x[1])).filter(Boolean))];
    if (hits.length) idx.push(`${nm[1]}\t${hits.slice(0, 5).join(' | ').replace(/\n/g, ' ')}`);
  }
}
idx.sort((a, b) => +a - +b);
fs.writeFileSync(path.join(ROOT, 'func-strings.tsv'), idx.join('\n'));
console.log('funcs with string refs:', idx.length);
