// pw-dgtest.mjs — isolate Chrome WT datagram delivery: connect native WT to
// the flood server on :9990 from a real https origin, count datagrams.readable
// reads for 12s. No engine, no wasm, no bridge.
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
page.on('console', m => console.log('[pg]', m.text().slice(0, 200)));

await page.goto('https://localhost:9989/', { waitUntil: 'domcontentloaded' });

const res = await page.evaluate(async () => {
  const meta = await (await fetch('/wt-meta.json')).json();
  const hash = Uint8Array.from(atob(meta.hash), c => c.charCodeAt(0));
  const wt = new WebTransport('https://localhost:9990/wt', {
    serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }]
  });
  await wt.ready;
  let n = 0, bytes = 0, first = '', small = 0, big = 0;
  const r = wt.datagrams.readable.getReader();
  const stop = Date.now() + 12000;
  (async () => {
    for (;;) {
      const m = await r.read();
      if (m.done) break;
      n++; bytes += m.value.byteLength;
      if (!first) first = Array.from(m.value.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ');
      if (m.value.byteLength > 500) big++; else small++;
      if (Date.now() > stop) break;
    }
  })();
  await new Promise(r2 => setTimeout(r2, 12000));
  return { n, bytes, first, small, big, closed: wt.closed ? 'maybe' : 'no' };
});
console.log('RESULT', JSON.stringify(res));
await browser.close();
