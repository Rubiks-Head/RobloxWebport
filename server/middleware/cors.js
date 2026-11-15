// middleware/cors.js — preflight + permissive headers (the wasm worker and
// page run same-origin, but the engine fires cross-scheme requests).
module.exports = function cors(ctx) {
  return (req, res, u, next) => {
    for (const k in ctx.CORS) res.setHeader(k, ctx.CORS[k]);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    next();
  };
};
