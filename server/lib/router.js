// lib/router.js — the smallest router this server needs.
// use(fn)   — middleware: (req, res, u, next). Call next() to continue;
//             end the response yourself to stop.
// add(m,p,h)— route: m = method or null for any, p = string path or regex.
//             Handler returns false to fall through to the next match.
module.exports = function createRouter() {
  const mws = [], routes = [];
  const api = {
    use: fn => mws.push(fn),
    add: (method, pattern, h) => routes.push({ method, pattern, h }),
    get: (p, h) => api.add('GET', p, h),
    post: (p, h) => api.add('POST', p, h),
    handle(req, res) {
      const u = new URL(req.url, `https://${req.headers.host}`);
      let i = 0;
      const next = () => {
        if (i < mws.length) return mws[i++](req, res, u, next);
        for (const r of routes) {
          if (r.method && r.method !== req.method) continue;
          const m = typeof r.pattern === 'string'
            ? r.pattern === u.pathname : r.pattern.test(u.pathname);
          if (m && r.h(req, res, u) !== false) return;
        }
        res.statusCode = 404;
        res.end('not found');
      };
      next();
    },
  };
  return api;
};
