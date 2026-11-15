// pw-verify.mjs — join place 1818, watch console for the disconnect reason,
// run 150s (past the ~30-60s kill window), screenshot along the way.
import { chromium } from 'playwright';
import fs from 'fs';
import { execSync } from 'child_process';

const placeId = process.argv[2] || '1818';
const DUR = +(process.argv[3] || 150) * 1000;
const log = fs.createWriteStream('pw-verify.log', { flags: 'w' });
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
const cdp = await browser.newBrowserCDPSession();
const pidWS = pid => {
  try {
    const out = execSync(`powershell -NoProfile -C "(Get-Process -Id ${pid} -EA Stop).WorkingSet64"`, { timeout: 5000 }).toString().trim();
    return (parseInt(out) / 1048576).toFixed(0);
  } catch (e) { return 'err'; }
};
async function memSample(tag) {
  try {
    const procs = await cdp.send('SystemInfo.getProcessInfo');
    const pm = await page.evaluate(() => performance.memory ? {
      jsUsed: performance.memory.usedJSHeapSize,
      jsTotal: performance.memory.totalJSHeapSize,
    } : {});
    // four buckets, measured separately:
    //   wasmCap   — heap capacity the engine was granted (pages*64KB)
    //   renderer  — OS working set of the page's renderer PID
    //   jsHeap    — V8 heap (used/total) via performance.memory
    //   gpuWS     — OS working set of the shared GPU process (textures etc;
    //               shared across tabs — attribution is approximate)
    const me = procs.processInfo.find(p => p.type === 'renderer') || {};
    const gpu = procs.processInfo.find(p => p.type === 'gpu') || {};
    const ws = me.id ? pidWS(me.id) : '?';
    const gpuWS = gpu.id ? pidWS(gpu.id) : '?';
    const wasmPages = await page.evaluate(() =>
      (window.Module?.wasmMemory?.buffer?.byteLength ?? 0) / 65536).catch(() => 0);
    const wasmMB = (wasmPages * 64 / 1024).toFixed(0);
    const jsMB = (pm.jsUsed / 1048576).toFixed(0), jsTotMB = (pm.jsTotal / 1048576).toFixed(0);
    console.log(`[pw] mem ${tag}: wasmCap=${wasmMB}MB rendererWS=${ws}MB jsHeap=${jsMB}/${jsTotMB}MB gpuWS=${gpuWS}MB`);
    log.write(`MEM ${tag} wasmCapMB=${wasmMB} wsMB=${ws} jsUsedMB=${jsMB} jsTotMB=${jsTotMB} gpuWSMB=${gpuWS}\n`);
    return ws;
  } catch (e) { log.write(`MEM ${tag} err ${e}\n`); }
}
let disconnects = 0;
page.on('console', m => {
  const t = m.text();
  log.write(`${m.type()}: ${t}\n`);
  if (/disconnect|lost connection|reconnect/i.test(t)) { disconnects++; console.log(`[pw] DC#${disconnects}: ${t.slice(0, 140)}`); }
});
page.on('pageerror', e => log.write(`PAGEERROR: ${e}\n`));

const t0 = Date.now();
await page.goto(process.env.PW_URL || `https://localhost:9989/play?placeId=${placeId}`, { waitUntil: 'domcontentloaded' });
console.log('[pw] joined t=' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
// hold W+A+space in pulses — walking into the world makes the physics solver
// pick up nearby unanchored assemblies, which is what triggers the engine's
// 0e-family client-physics replication (the kill correlate)
const MOVE = process.env.PW_MOVE !== '0';
if (MOVE) (async () => {
  await page.waitForTimeout(6000);
  const keys = ['w', 'a', 's', 'd', ' '];
  let i = 0;
  while (true) {
    const k = keys[i++ % keys.length];
    try { await page.keyboard.down(k); await page.waitForTimeout(900); await page.keyboard.up(k); } catch { return; }
    await page.waitForTimeout(300);
  }
})();
const marks = [30,60,90,120,145,300,600,900,1150];
for (const m of marks) {
  const wait = m * 1000 - (Date.now() - t0);
  if (wait <= 0 || wait > DUR) continue;
  await page.waitForTimeout(Math.min(wait, DUR - (Date.now() - t0)));
  await page.screenshot({ path: `shots/verify-t${m}.png` });
  const mem = await memSample(`t=${m}s`);
  console.log(`[pw] t=${m}s disconnects=${disconnects}`);
}
console.log(`[pw] FINAL disconnects=${disconnects}`);
await browser.close();
