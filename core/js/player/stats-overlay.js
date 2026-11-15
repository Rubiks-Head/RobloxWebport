// stats-overlay.js — F1 diagnostics bar.
//
// Reads a shared-memory stats block written by the engine worker
// (ws-transport.js / create-web-client.js) at abi.base+56 — the reserved
// tail of the socket ABI before tx0. No postMessage plumbing; the page just
// reads the Int32Array view of the same SharedArrayBuffer.
//
// Layout (i32 words, base 2146435128 = abi.base + 56):
//   [0] engine frame count        [1] frame interval ms*100
//   [2] dg rx bytes  [3] dg rx msgs   [4] dg tx bytes  [5] dg tx msgs
//   [6] jitter ms*1000 (RFC3550-style)  [7] dg tx drops (ws backpressure)
//   [8] stream rx bytes [9] stream rx msgs  [10] ws frames queued
//   [15] 'RHST' magic (worker hooked)
;(function () {
  const MAGIC = 0x52544853; // 'RHST'
  let st = null, mem = null, el = null, timer = null, pingWs = null;
  let last = { t: 0, f: 0, rxb: 0, rxm: 0, txb: 0, txm: 0, srxb: 0 };
  let pingAt = 0, rtt = -1;
  const statsBase = () =>
    (mem.buffer.byteLength > 2146435072 + 64 ? 2146435072 : 1072693248) + 56;

  function arm() {
    // wasmMemory is published on window by engine-launch for the pump
    mem = mem || (typeof window !== 'undefined' && (window.__rhMem || window.wasmMemory));
    if (!mem || !mem.buffer) return false;
    const sb = statsBase();
    if (mem.buffer.byteLength < sb + 64) return false;
    if (!st) st = new Int32Array(mem.buffer, sb, 16);
    return true;
  }

  function fmtB(n) {
    if (n > 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n > 1e3) return (n / 1e3).toFixed(0) + 'K';
    return '' + (n | 0);
  }

  function ping() {
    try {
      if (!pingWs || pingWs.readyState > 1) {
        pingWs = new WebSocket(location.origin.replace(/^http/, 'ws') + '/udp-relay?proto=msg');
        pingWs.binaryType = 'arraybuffer';
        pingWs.onmessage = ev => {
          const d = new Uint8Array(ev.data);
          if (d[0] === 5) pingWs.send(new Uint8Array([5, 0, 0, 0, 0, 0])); // HELLO->ack
          else if (d[0] === 7 && pingAt) { rtt = performance.now() - pingAt; }
        };
        pingWs.onclose = () => { pingWs = null; rtt = -1; };
        return;
      }
      if (pingWs.readyState === 1) {
        const f = new Uint8Array(5);
        f[0] = 7;
        pingWs.send(f);
        pingAt = performance.now();
      }
    } catch (e) { pingWs = null; }
  }

  function tick() {
    if (!arm()) { el.textContent = 'stats: waiting for engine…'; return; }
    const now = performance.now(), dt = (now - last.t) / 1000 || 1;
    const f = st[0], fms = st[1] / 100, rxb = st[2] >>> 0, rxm = st[3] >>> 0,
      txb = st[4] >>> 0, txm = st[5] >>> 0, jit = st[6] / 1000, drop = st[7] >>> 0,
      srxb = st[8] >>> 0, hooked = st[15] === MAGIC;
    const fps = hooked ? ((f - last.f) / dt).toFixed(0) : '—';
    const ps = (typeof window.__pumpStats === 'object' && window.__pumpStats) || {};
    const jsHeap = performance.memory ? (performance.memory.usedJSHeapSize / 1048576 | 0) : 0;
    el.textContent =
      `fps ${fps} (${fms.toFixed(1)}ms)  ` +
      `↓${fmtB((srxb - last.srxb) / dt)}B/s str + ${fmtB((rxb - last.rxb) / dt)}B/s dg (${((rxm - last.rxm) / dt) | 0}/s)  ` +
      `↑${fmtB((txb - last.txb) / dt)}B/s (${((txm - last.txm) / dt) | 0}/s)  ` +
      `jit ${jit.toFixed(1)}ms  rtt ${rtt < 0 ? '—' : rtt.toFixed(1) + 'ms'}  ` +
      `drop ${drop}  pump ${ps.rx || 0}↓/${ps.tx || 0}↑  ` +
      `mem ${mem.buffer.byteLength / 1048576 | 0}MB w+${jsHeap}MB js`;
    last = { t: now, f, rxb, rxm, txb, txm, srxb };
  }

  function toggle() {
    if (el) {
      clearInterval(timer); timer = null;
      el.remove(); el = null;
      window.__rhStatsOn = false;   // gate the hot-path draw counters off
      if (pingWs) { try { pingWs.close(); } catch (e) {} pingWs = null; }
      return;
    }
    window.__rhStatsOn = true;
    el = document.createElement('div');
    el.style.cssText = 'position:fixed;top:6px;left:50%;transform:translateX(-50%);' +
      'z-index:2147483647;background:rgba(10,12,16,.82);color:#9fe08a;' +
      'font:12px/1.6 ui-monospace,Consolas,monospace;padding:4px 12px;' +
      'border-radius:6px;pointer-events:none;white-space:pre;letter-spacing:.2px';
    document.body.appendChild(el);
    tick(); ping();
    timer = setInterval(() => { tick(); }, 250);
    setInterval(ping, 2000);
  }

  window.addEventListener('keydown', e => {
    if (e.key === 'F1' || e.keyCode === 112) { e.preventDefault(); toggle(); }
  }, true);
})();
