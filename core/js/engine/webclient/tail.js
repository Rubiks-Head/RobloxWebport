// tail.js — end of the stock glue: the wasm-benchmark worker body
// (self.onmessage init/run) + sentry debug-id trailer. Generated code.

let X = null;
  self.onmessage = async ee => {
    const {
      type: l,
      module: Re,
      durationMs: ae,
      batchSize: ur
    } = ee.data;
    if (l === "init") {
      X = (await WebAssembly.instantiate(Re, {})).exports, X.bench_init(), self.postMessage({
        type: "ready"
      });
      return
    }
    if (l === "run" && X) {
      const fr = X.bench_run,
        S = ur || 100;
      let De = 0,
        Ie = 0;
      const Pe = performance.now(),
        Ue = Pe + ae;
      for (; performance.now() < Ue;) Ie += fr(S), De += S;
      const Je = performance.now() - Pe;
      self.postMessage({
        type: "result",
        iterations: De,
        elapsedMs: Je,
        itersPerMs: De / Je,
        checksum: Ie
      })
    }
  }
}

;
! function() {
  try {
    var g = globalThis,
      s = new g.Error().stack;
    s && ((g._sentryDebugIds = g._sentryDebugIds || {})[s] = "7b202d92-ec4e-5624-b3dc-8e6bdfaafcdd")
  } catch (e) {}
}();
//# debugId=7b202d92-ec4e-5624-b3dc-8e6bdfaafcdd