// emscripten glue prelude (stock) — property-define helpers.
var __ = Object.defineProperty;
var d_ = (X, ee, l) => ee in X ? __(X, ee, {
  enumerable: !0,
  configurable: !0,
  writable: !0,
  value: l
}) : X[ee] = l;
var lr = (X, ee, l) => d_(X, typeof ee != "symbol" ? ee + "" : ee, l);
