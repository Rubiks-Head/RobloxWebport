// consolelog.js — all console output is REMOVED, not filtered.
// console.* are no-ops page-wide; the wasm console imports are restored in
// create-web-client.js and feed the window.__engx ring (invisible on-page,
// auto-POSTed to /__englog on engine failure). LOG.* / DBG.* remain as
// no-op call surfaces so existing callers don't break; LOG.raw is the
// escape hatch to the real console.
(function (root) {
  'use strict';
  if (root.LOG) return;
  const real = console.log.bind(console);
  const noop = () => {};
  console.log = noop; console.info = noop; console.debug = noop;
  console.trace = noop; console.warn = noop; console.error = noop;
  console.group = noop; console.groupCollapsed = noop; console.groupEnd = noop;

  const LOG = {
    hold: noop, release: noop,
    phase: () => noop,
    info: noop, warn: noop, error: noop, brand: noop, page: noop,
    raw: (...a) => real(...a),
    suppress: noop, time: () => noop,
    _orig: { log: real },
  };
  const DBG = {};
  for (const c of ['api', 'join', 'engine', 'transport', 'vfs', 'auth', 'load', 'ws', 'ui', 'flag', 'net']) DBG[c] = noop;
  DBG.err = noop; DBG.raw = LOG.raw;
  DBG.on = () => ''; DBG.set = () => ''; DBG.setAll = () => '';

  root.LOG = LOG;
  root.DBG = DBG;
})(typeof self !== 'undefined' ? self : this);
