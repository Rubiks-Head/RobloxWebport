// pw-dgprobe.mjs — join 1818, sample the wasm datagram receive ring:
// does the physics dg flow die at the ring (droppedDatagrams, slot too
// small, ring full) or reach the engine?
import { chromium } from 'playwright';

const placeId = process.argv[2] || '1818';
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('[pw] PAGEERROR:', String(e).slice(0, 200)));

await page.goto(`https://localhost:9989/play?placeId=${placeId}`, { waitUntil: 'domcontentloaded' });
console.log('[pw] joined');

function sample() {
  return page.evaluate(() => {
    const M = window.Module;
    const rna = M && M.__rbxWasmRna;
    if (!rna || !rna.conns) return { err: 'no rna', keys: M ? Object.keys(M).filter(k => /rna|wasm/i.test(k)) : [] };
    const out = [];
    for (const [id, k] of rna.conns) {
      let head = -1, tail = -1;
      try {
        head = Atomics.load(M.HEAP32, k.receiveHeadPtr >>> 2);
        tail = Atomics.load(M.HEAP32, k.receiveTailPtr >>> 2);
      } catch (e) {}
      out.push({
        id, closed: k.closed,
        dropped: k.droppedDatagrams,
        slotSize: k.receiveSlotSize, slotCount: k.receiveSlotCount,
        head, tail, depth: (head - tail) >>> 0,
        streams: k.streams.size,
      });
    }
    return { conns: out, txp: window.__txp || null };
  }).catch(e => ({ err: String(e) }));
}

for (const t of [20, 35, 50, 70, 95]) {
  await page.waitForTimeout(t === 20 ? 20000 : (t - [20,35,50,70,95][[20,35,50,70,95].indexOf(t)-1]) * 1000);
  console.log(`[pw] t=${t}s`, JSON.stringify(await sample()));
}
await browser.close();
