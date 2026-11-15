// rebuild.mjs — reassemble src/<category>/f*.wat + sec_*.wat -> patched wasm.
// Funcs are emitted in index order (filenames carry the index).
// Usage:
//   node tools/rebuild.mjs [wat2wasm.exe]
// WAT2WASM env var or argv overrides the default sibling checkout path.
import fs from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const WAT2WASM = process.env.WAT2WASM || process.argv[2] ||
  path.resolve(ROOT, '../../../wabt-src/build41/wat2wasm.exe');
if (!fs.existsSync(WAT2WASM)) {
  console.error(`wat2wasm not found at ${WAT2WASM}`);
  console.error('build wabt (see README) or pass: node tools/rebuild.mjs <path-to-wat2wasm>');
  process.exit(1);
}

const out = path.join(ROOT, 'WebClient.patched.wat');
const w = fs.createWriteStream(out);
w.write('(module\n');
for (const f of ['sec_type.wat', 'sec_import.wat', 'sec_table.wat', 'sec_tag.wat',
  'sec_global.wat', 'sec_export.wat', 'sec_start.wat', 'sec_elem.wat']) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) w.write(fs.readFileSync(p));
}
const funcs = [];
const seen = new Set();
const srcDir = path.join(ROOT, 'src');
for (const dir of fs.readdirSync(srcDir).sort()) {
  const dp = path.join(srcDir, dir);
  if (!fs.statSync(dp).isDirectory()) continue;
  for (const f of fs.readdirSync(dp)) {
    const m = /^f(\d+)\.wat$/.exec(f);
    // decompiler writes multi-category funcs into several dirs — emit each
    // func index once or every later index shifts and the binary corrupts
    if (m && !seen.has(+m[1])) { seen.add(+m[1]); funcs.push([+m[1], path.join(dp, f)]); }
  }
}
funcs.sort((a, b) => a[0] - b[0]);
for (const [, p] of funcs) w.write(fs.readFileSync(p));
const data = path.join(ROOT, 'sec_data.wat');
if (fs.existsSync(data)) w.write(fs.readFileSync(data));
w.write(')\n');
w.end();
w.on('finish', () => {
  // --no-check: the round-tripped WAT uses EH/JSPI constructs the validator
  // rejects (thousands of false-positive "type mismatch" errors) — it was
  // produced from a known-good binary, so skip validation.
  // Redirect stderr to a file — spawnSync ENOBUFS on MBs of diagnostics.
  try {
    execFileSync(WAT2WASM, [
      // NOT --enable-all: --enable-compact-imports emits kind-0x7f import
      // entries Chrome rejects ("Invalid import kind 127"), and
      // --enable-code-metadata injects an extra custom section.
      '--enable-threads', '--enable-function-references', '--enable-gc',
      '--enable-custom-page-sizes', '--enable-wide-arithmetic',
      '--no-check', '-o',
      path.join(ROOT, 'WebClient.patched.wasm'), out],
      { stdio: ['ignore', 'inherit', fs.openSync(path.join(ROOT, 'rebuild-err.log'), 'w')] });
  } catch {
    console.error('wat2wasm failed — see rebuild-err.log');
    process.exit(1);
  }
  console.log(`wrote WebClient.patched.wasm — ${funcs.length} funcs`);
});
