// middleware/session.js — resolves the request's rh_sid cookie to its
// session and hangs it on req.sess. No cookie -> the shared default session.
module.exports = function session(ctx) {
  return (req, res, u, next) => {
    req.sess = ctx.sessOf(req);
    next();
  };
};
