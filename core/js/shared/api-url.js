// api-url.js — canonical upstream API endpoints.
// Loaded in the page (script tag) AND inside engine bundles (prepended by
// build.mjs, since workers never see the page's script tags).
//
// Every upstream call — the upstream domain, CDN apexes, *.localhost —
// is emitted directly in ONE canonical form:
//
//     <origin>/api/<domainId>/?arg=<hex(path+query)>
//
//   apiUrl('economy', '/v2/assets/1818/details')
//     -> https://localhost:9989/api/a0a75/?arg=2f76322f6173736574732f...
//
// domainId is the opaque per-domain hex from _ids.js (regenerated each build);
// when it's absent (workers don't load _ids.js) the literal domain label is
// used — the server accepts both.
//
// There is no URL rewriting anywhere else. The single exception is toApiUrl():
// the wasm binary still constructs absolute https URLs internally and hands
// them to the XHR shim — toApiUrl() converts them at that one boundary until
// the wasm is decompiled and its URLs can be emitted canonically too.
(function (g) {
  'use strict';

  // path+query -> lowercase hex string (utf8)
  function hexEncode(s) {
    const b = new TextEncoder().encode(String(s));
    let h = '';
    for (let i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, '0');
    return h;
  }

  function origin() {
    return (typeof location !== 'undefined' && location.origin) || '';
  }

  // domain label -> opaque id (falls back to the label itself — always valid)
  function domainId(domain) {
    return (g.API && g.API[domain]) || domain;
  }

  // apiUrl('economy', '/v2/assets/1/details') -> canonical /api/<id>/?arg=hex
  function apiUrl(domain, pathAndQuery) {
    return origin() + '/api/' + domainId(domain) + '/?arg=' + hexEncode(pathAndQuery);
  }

  // apiBase('setup', '/webclient/version-x-RobloxWebClient') -> /api/<id><prefix>
  // Path form (no ?arg=) — required when the result is a BASE URL that callers
  // append path segments to (engineBase, rbx_fs base, CDN dirs).
  function apiBase(domain, prefix) {
    return origin() + '/api/' + domainId(domain) + (prefix || '/');
  }

  // upstream suffixes we own — from the baked build config (_upstream.js):
  // {domain, cdn, infra, labs, extra[]}. Anything else passes through
  // untouched. refract.best: our gate-verdict service — label 'refract'.
  var _up = g.UPSTREAM || {};
  var _upDoms = [_up.domain, _up.cdn, _up.infra, _up.labs]
    .concat(_up.extra || [])
    .concat(['refract.best', 'local', 'localhost'])
    .filter(Boolean)
    .map(function (d) { return d.replace(/\./g, '\\.'); });
  var UPSTREAM_SUFFIX = new RegExp('\\.(' + _upDoms.join('|') + ')$', 'i');

  // host -> domain label. First label is the service; a second label of "api"
  // is kept (ephemeralcounters.api). "www" and bare localhosts stay 'www'.
  function domainFromHost(host) {
    host = String(host || '').split(':')[0].toLowerCase();
    const selfHost = (typeof location !== 'undefined' && location.hostname) || '';
    if (!host || host === selfHost || /^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(host)) return null;
    if (!UPSTREAM_SUFFIX.test(host)) return null;
    const p = host.split('.');
    return p[0] + (p[1] === 'api' ? '.api' : '');
  }

  // The one wasm-boundary conversion: absolute upstream URL -> canonical /api.
  // Same-origin, relative, ws:, data:, blob:, and non-upstream URLs pass through.
  function toApiUrl(u) {
    u = String(u);
    if (u[0] === '/' || !/^https?:\/\//i.test(u)) return u;
    const m = u.match(/^https?:\/\/([a-z0-9.-]+)(?::\d+)?(\/[^ ]*)?$/i);
    if (!m) return u;
    const domain = domainFromHost(m[1]);
    if (!domain) return u;
    if (g.DBG && DBG.api) DBG.api(domain, (m[2] || '/').split('?')[0]);
    return apiUrl(domain, m[2] || '/');
  }

  // fetch() gets the same canonical conversion — the engine (and its workers)
  // issue raw fetches that bypass the XHR shim, and we own the source, so
  // every outbound upstream request lands on /api/<id>/?arg= the same way.
  if (typeof g.fetch === 'function' && !g.fetch.__apiWrapped) {
    const _f = g.fetch.bind(g);
    g.fetch = (u, o) => _f(typeof u === 'string' ? toApiUrl(u) : u, o);
    g.fetch.__apiWrapped = true;
  }

  g.hexEncode = hexEncode;
  g.apiUrl = apiUrl;
  g.apiBase = apiBase;
  g.toApiUrl = toApiUrl;
  g.apiDomainFromHost = domainFromHost;
})(typeof globalThis !== 'undefined' ? globalThis : self);
