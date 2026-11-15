// strings-index.mjs — build strings.tsv: memory address -> string.
// Active data segments map at their declared address; passive segments are
// mapped via MemoryInit(dest, src, len) call sites in the decompiled C
// (matched to segment payloads by length).
// Usage: node tools/strings-index.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const b = fs.readFileSync(path.join(ROOT, 'WebClient.trunc.wasm'));
const u32 = o => { let r = 0, s = 0; for (;;) { const x = b[o++]; r |= (x & 0x7f) << s; s += 7; if (!(x & 0x80)) return [r, o] } };

let o = 8; const slots = [], pseg = [];
while (o < b.length) {
  const id = b[o++]; const [sz, e] = u32(o);
  if (id === 11) {
    let p = e; const [cnt, q] = u32(p); p = q;
    for (let k = 0; k < cnt; k++) {
      const flag = b[p++];
      if (flag === 1 || flag === 3) { const [n, q2] = u32(p); p = q2; pseg.push([k, p, n]); p += n }
      else { if (flag === 2) p++; if (b[p] === 0x41) p++; const [a, q3] = u32(p); p = q3; if (b[p] === 0x0b) p++; const [n, q4] = u32(p); p = q4; slots.push([a, p, n]); p += n }
    }
  }
  o = e + sz;
}

const byLen = new Map(pseg.map(s => [s[2], s]));
const d = fs.readFileSync(path.join(ROOT, 'WebClient.dcmp.c'), 'utf8');
const re = /MemoryInit\((\d+),\s*(\d+),\s*(\d+)\)/g; let m, hits = 0;
while ((m = re.exec(d))) {
  const s = byLen.get(+m[3]);
  if (s) { slots.push([+m[1], s[1], s[2]]); hits++ }
}
slots.sort((x, y) => x[0] - y[0]);
const PRINT = /^[\x20-\x7e]+$/;
const out = [];
for (const [a, off, len] of slots) {
  let s = 0;
  while (s < len) {
    let e2 = s; while (e2 < len && b[off + e2] !== 0) e2++;
    if (e2 - s >= 4 && e2 - s < 200) {
      const t = b.subarray(off + s, off + e2).toString('utf8');
      if (PRINT.test(t)) out.push((a + s) + '\t' + t.replace(/\t/g, ' '));
    }
    s = e2 + 1;
  }
}
fs.writeFileSync(path.join(ROOT, 'strings.tsv'), out.join('\n'));
console.log('mapped:', hits, 'strings:', out.length);
