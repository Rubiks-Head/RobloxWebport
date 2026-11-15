// create-web-client.js — STOCK emscripten runtime (de-minified, not yet renamed).
// createWebClient(Module) factory: shared-memory setup (Vr), pthread pool (P),
// exception/abort handling (Oe/br/Qr), wasm fetch+instantiate (di/mi/Jr).
// The K.xhrs registry + sn() XHR dispatcher lives in xhr.js; all GL/env/socket
// host functions live in glue.js. Identifiers are still the emcc minified
// names — rename only with a full-reference check.

var createWebClient = (() => {
  var X = globalThis.document?.currentScript?.src;
  return async function(ee = {}) {
    var l = ee,
      Re = !!globalThis.window,
      ae = !!globalThis.WorkerGlobalScope,
      ur = globalThis.process?.versions?.node && globalThis.process?.type != "renderer",
      fr = !Re && !ur && !ae,
      S = ae && globalThis.name == "em-pthread",
      De = [],
      Ie = "./this.program",
      Pe = (e, r) => {
        throw r
      };
    ae && (X = self.location.href);
    var Ue = "";

    function Je(e) {
      return l.locateFile ? l.locateFile(e, Ue) : Ue + e
    }
    var Nr, _r;
    if (Re || ae) {
      try {
        Ue = new URL(".", X).href
      } catch {}
      ae && (_r = e => {
        var r = new XMLHttpRequest;
        return r.open("GET", e, !1), r.responseType = "arraybuffer", r.send(null), new Uint8Array(r.response)
      }), Nr = async e => {
        var r = await fetch(e, {
          credentials: "same-origin"
        });
        if (r.ok) return r.arrayBuffer();
        throw new Error(r.status + " : " + r.url)
      }
    }
    var $e = console.log.bind(console),
      $ = console.error.bind(console),
      Gr, de, Ce = !1,
      Se;

    function m_(e, r) {
      e || Oe(r)
    }
    var p_ = e => e.startsWith("file://"),
      Hr;
    if (S) {
      var dr = !1;
      self.onunhandledrejection = r => {
        throw r.reason || r
      };
      async function e(r) {
        try {
          var t = r.data,
            n = t.cmd;
          if (n == 1) {
            let a = [];
            self.onmessage = i => a.push(i), Hr = () => {
              postMessage({
                cmd: 3
              });
              for (let i of a) e(i);
              self.onmessage = e
            };
            for (const i of t.handlers)(!l[i] || l[i].proxy) && (l[i] = (...o) => {
              postMessage({
                cmd: 9,
                handler: i,
                args: o
              })
            }, i == "print" && ($e = l[i]), i == "printErr" && ($ = l[i]));
            Ae = t.wasmMemory, globalThis.__rhMem = Ae, Vr(), de = t.wasmModule, $r(), oi(), Hr()
          } else if (n == 2) {
            vi(t.pthread_ptr), Ir(t.pthread_ptr, 0, 0, 1, 0, 0), P.threadInitTLS(), kr(t.pthread_ptr), dr || (za(), dr = !0);
            try {
              await bi(t.start_routine, t.arg)
            } catch (a) {
              if (a != "unwind") throw a
            }
          } else n == 4 ? dr && Ze() : n && ($(`worker: received unknown command ${n}`), $(t))
        } catch (a) {
          throw mr && Ya(), a
        }
      }
      self.onmessage = e
    }
    var mr = !1;

    function Vr() {
      var e = Ae.buffer;
      F = new Int8Array(e), Y = new Int16Array(e), l.HEAPU8 = D = new Uint8Array(e), Ee = new Uint16Array(e), l.HEAP32 = g = new Int32Array(e), l.HEAPU32 = T = new Uint32Array(e), ne = new Float32Array(e), j = new Float64Array(e), le = new BigInt64Array(e), ut = new BigUint64Array(e)
    }

    function ci() {
      if (!S) {
        if (l.wasmMemory) Ae = l.wasmMemory;
        else {
          var e = l.INITIAL_MEMORY || 4294967296;
          Ae = new WebAssembly.Memory({
            initial: e / 65536,
            maximum: e / 65536,
            shared: !0
          })
        }
        globalThis.__rhMem = Ae;   // stats block (ws-transport/page) reads via SAB
        Vr()
      }
    }

    function li() {
      var e = l.preRun;
      e && (typeof e == "function" && (e = [e]), pr.push(...e)), pi(pr)
    }
    async function jr() {
      mr = !0, !S && await se.__wasm_call_ctors()
    }

    function g_() {}

    function Oe(e) {
      e = `Aborted(${e})`, $(e), Ce = !0, e += ". Build with -sASSERTIONS for more info.", mr && ri();
      var r = new WebAssembly.RuntimeError(e);
      throw r
    }
    var zr;

    function ui() {
      return Je("WebClient.wasm")
    }

    function fi(e) {
      if (_r) return _r(e);
      throw "both async and sync fetching of the wasm failed"
    }
    async function _i(e) {
      if (!Gr) try {
        var r = await Nr(e);
        return new Uint8Array(r)
      } catch {}
      return fi(e)
    }
    async function di(e, r) {
      try {
        var t = await _i(e),
          n = await WebAssembly.instantiate(t, r);
        return n
      } catch (a) {
        $(`failed to asynchronously prepare wasm: ${a}`), Oe(a)
      }
    }
    async function mi(e, r, t) {
      if (!e) try {
        var n = fetch(r, {
            credentials: "same-origin"
          }),
          a = await WebAssembly.instantiateStreaming(n, t);
        return a
      } catch (i) {
        $(`wasm streaming compile failed: ${i}`), $("falling back to ArrayBuffer instantiation")
      }
      return di(r, t)
    }

    function Jr() {
      c_(), We.__instrumented || (We.__instrumented = !0, G.instrumentWasmImports(We));
      var e = {
        env: We,
        wasi_snapshot_preview1: We
      };
      return e
    }
    async function $r() {
      function e(s, c) {
        return se = s.exports, se = G.instrumentWasmExports(se), se = l_(se), hi(se._emscripten_tls_init), s_(se), de = c, se
      }

      function r(s) {
        return e(s.instance, s.module)
      }
      var t = Jr(),
        n = l.instantiateWasm;
      if (n) return new Promise(s => {
        n(t, (c, u) => s(e(c, u)))
      });
      if (S) {
        var a = new WebAssembly.Instance(de, Jr());
        return e(a, de)
      }
      zr ?? (zr = ui());
      var i = await mi(Gr, zr, t),
        o = r(i);
      return o
    }
    class qr {
      constructor(r) {
        lr(this, "name", "ExitStatus");
        this.message = `Program terminated with exit(${r})`, this.status = r
      }
    }
    var Xr = e => {
        e.terminate(), e.onmessage = r => {}
      },
      Yr = e => {
        var r = P.pthreads[e];
        P.returnWorkerToPool(r)
      },
      pi = e => {
        for (; e.length > 0;) e.shift()(l)
      },
      pr = [],
      gi = e => pr.push(e),
      Kr = e => {
        var r = P.getNewWorker();
        if (!r) return 6;
        P.pthreads[e.pthread_ptr] = r, r.pthread_ptr = e.pthread_ptr;
        var t = {
          cmd: 2,
          start_routine: e.startRoutine,
          arg: e.arg,
          pthread_ptr: e.pthread_ptr
        };
        return r.postMessage(t, e.transferList), 0
      },
      Ne = 0,
      gr = () => Ne > 0,
      Zr = () => ai(),
      vr = e => ti(e),
      qe = e => ni(e),
      j, le, W = (e, r, t, ...n) => {
        var a = 8 * n.length * 2,
          i = Zr(),
          o = qe(a),
          s = o >>> 3;
        for (var c of n) typeof c == "bigint" ? (le[s++ >>> 0] = 1n, le[s++ >>> 0] = c) : (le[s++ >>> 0] = 0n, j[s++ >>> 0] = c);
        var u = Za(e, r, a, o, t);
        return vr(i), u
      };

    function br(e) {
      if (S) return W(0, 0, 1, e);
      Se = e, gr() || (P.terminateAllThreads(), Ce = !0), Pe(e, new qr(e))
    }

    function Qr(e) {
      if (S) return W(1, 0, 0, e);
      hr(e)
    }
    var et = (e, r) => {
        if (Se = e, S) throw Qr(e), "unwind";
        br(e)
      },
      hr = et,
      rt = !Atomics.waitAsync || globalThis.navigator?.userAgent && Number((navigator.userAgent.match(/Chrom(e|ium)\/([0-9]+)\./) || [])[2]) < 91,
      g, P = {
        unusedWorkers: [],
        tlsInitFunctions: [],
        pthreads: {},
        init() {
          S || P.initMainThread()
        },
        initMainThread() {
          for (var e = 8; e--;) P.allocateUnusedWorker();
          gi(async () => {
            var r = P.loadWasmModuleToAllWorkers()
          })
        },
        terminateAllThreads: () => {
          for (var e of Object.values(P.pthreads)) Xr(e);
          for (var e of P.unusedWorkers) Xr(e);
          P.unusedWorkers = [], P.pthreads = {}
        },
        clearMailboxAwait: e => {
          rt || Atomics.notify(g, e >>> 2)
        },
        terminateRuntime: () => {
          P.terminateAllThreads();
          var e = fe();
          Xa(0, 0, 0, 1), P.clearMailboxAwait(e)
        },
        returnWorkerToPool: e => {
          var r = e.pthread_ptr;
          delete P.pthreads[r], e.pthread_ptr = 0, P.clearMailboxAwait(r), Promise.resolve(Qa(r)).then(() => {
            P.unusedWorkers.push(e)
          }).catch(Ke)
        },
        threadInitTLS() {
          P.tlsInitFunctions.forEach(e => e())
        },
        loadWasmModuleToWorker: e => new Promise(r => {
          e.onmessage = i => {
            var o = i.data,
              s = o.cmd;
            if (o.targetThread && o.targetThread != fe()) {
              var c = P.pthreads[o.targetThread];
              c?.postMessage(o);
              return
            }
            if (o === "setimmediate" || o === "_si") {
              e.postMessage(o);
              return
            }
            switch (s) {
              case 4:
                Ze();
                break;
              case 5:
                Kr(o);
                break;
              case 6:
                Fe(() => Yr(o.thread));
                break;
              case 3:
                r(e);
                break;
              case 9:
                l[o.handler](...o.args);
                break;
              default:
                s && $(`worker sent an unknown command ${s}`)
            }
          }, e.onerror = i => {
            var o = "worker sent an error!";
            throw $(`${o} ${i.filename}:${i.lineno}: ${i.message}`), i
          };
          var t = [],
            n = ["print"];
          for (var a of n) l.propertyIsEnumerable(a) && t.push(a);
          e.postMessage({
            cmd: 1,
            handlers: t,
            wasmMemory: Ae,
            wasmModule: de
          })
        }),
        async loadWasmModuleToAllWorkers() {
          if (S) return;
          let e = Promise.all(P.unusedWorkers.map(P.loadWasmModuleToWorker));
          l.pthreadPoolReady = e
        },
        allocateUnusedWorker() {
          var e, r = X;
          return l.mainScriptUrlOrBlob && (r = l.mainScriptUrlOrBlob, typeof r != "string" && (r = URL.createObjectURL(r))), e = new Worker(r, {
            name: "em-pthread"
          }), P.unusedWorkers.push(e), e
        },
        getNewWorker() {
          if (P.unusedWorkers.length == 0) {
            var e = P.allocateUnusedWorker();
            P.loadWasmModuleToWorker(e)
          }
          return P.unusedWorkers.pop()
        }
      },
      T;

    function vi(e) {
      var r = T[e + 48 >>> 2 >>> 0],
        t = T[e + 52 >>> 2 >>> 0],
        n = r - t;
      $a(r, n), vr(r)
    }
    var yr = [],
      z = e => {
        var r = yr[e];
        return r || (yr[e] = r = ii.get(e), G.isAsyncExport(r) && (yr[e] = r = G.makeAsyncFunction(r))), r
      },
      bi = async (e, r) => {
        Ne = 0;
        var t = WebAssembly.promising(z(e))(r);

        function n(a) {
          if (gr()) {
            Se = a;
            return
          }
          Pr(a)
        }
        t = await t, n(t)
      }, hi = e => P.tlsInitFunctions.push(e), Ae, yi = 9007199254740992, wi = -9007199254740992, Xe = e => e < wi || e > yi ? NaN : Number(e), tt = globalThis.TextDecoder && new TextDecoder, nt = (e, r, t, n) => {
        var a = r + t;
        if (n) return a;
        for (; e[r] && !(r >= a);) ++r;
        return r
      }, xi = (e, r = 0, t, n) => {
        r >>>= 0;
        var a = nt(e, r, t, n);
        if (a - r > 16 && e.buffer && tt) return tt.decode(e.buffer instanceof ArrayBuffer ? e.subarray(r, a) : e.slice(r, a));
        for (var i = ""; r < a;) {
          var o = e[r++];
          if (!(o & 128)) {
            i += String.fromCharCode(o);
            continue
          }
          var s = e[r++] & 63;
          if ((o & 224) == 192) {
            i += String.fromCharCode((o & 31) << 6 | s);
            continue
          }
          var c = e[r++] & 63;
          if ((o & 240) == 224 ? o = (o & 15) << 12 | s << 6 | c : o = (o & 7) << 18 | s << 12 | c << 6 | e[r++] & 63, o < 65536) i += String.fromCharCode(o);
          else {
            var u = o - 65536;
            i += String.fromCharCode(55296 | u >> 10, 56320 | u & 1023)
          }
        }
        return i
      }, D, w = (e, r, t) => (e >>>= 0, e ? xi(D, e, r, t) : "");

    function ki(e, r, t, n) {
      return e >>>= 0, r >>>= 0, n >>>= 0, Oe(`Assertion failed: ${w(e)}, at: ` + [r ? w(r) : "unknown filename", t, n ? w(n) : "unknown function"])
    }

    function Ci(e, r) {
      return e >>>= 0, z(e)(r)
    }

    function at(e, r, t, n) {
      return S ? W(2, 0, 1, e, r, t, n) : it(e, r, t, n)
    }
    var Si = () => !!globalThis.SharedArrayBuffer;

    function it(e, r, t, n) {
      if (e >>>= 0, r >>>= 0, t >>>= 0, n >>>= 0, !Si()) return 6;
      var a = [],
        i = 0;
      if (S && (!a.length || i)) return at(e, r, t, n);
      if (i) return i;
      var o = {
        startRoutine: t,
        pthread_ptr: e,
        arg: n,
        transferList: a
      };
      return S ? (o.cmd = 5, postMessage(o, a), 0) : Kr(o)
    }

    function ot() {
      return S ? W(3, 0, 1) : 0
    }

    function st() {
      return S ? W(4, 0, 1) : 0
    }

    function ct() {
      return S ? W(5, 0, 1) : 0
    }

    function lt() {
      return S ? W(6, 0, 1) : 0
    }
    var Ai = () => Oe(""),
      re = e => {
        e >>>= 0;
        for (var r = "";;) {
          var t = D[e++ >>> 0];
          if (!t) return r;
          r += String.fromCharCode(t)
        }
      },
      Te = {},
      Be = {},
      Ye = {};
    class Ti extends Error {
      constructor(r) {
        super(r), this.name = "BindingError"
      }
    }
    var te = e => {
      throw new Ti(e)
    };

    function Bi(e, r, t = {}) {
      var n = r.name;
      if (e || te(`type "${n}" must have a positive integer typeid pointer`), Be.hasOwnProperty(e)) {
        if (t.ignoreDuplicateRegistrations) return;
        te(`Cannot register type '${n}' twice`)
      }
      if (Be[e] = r, delete Ye[e], Te.hasOwnProperty(e)) {
        var a = Te[e];
        delete Te[e], a.forEach(i => i())
      }
    }

    function ie(e, r, t = {}) {
      return Bi(e, r, t)
    }
    var F, Y, Ee, ut, ft = (e, r, t) => {
        switch (r) {
          case 1:
            return t ? n => F[n >>> 0] : n => D[n >>> 0];
          case 2:
            return t ? n => Y[n >>> 1 >>> 0] : n => Ee[n >>> 1 >>> 0];
          case 4:
            return t ? n => g[n >>> 2 >>> 0] : n => T[n >>> 2 >>> 0];
          case 8:
            return t ? n => le[n >>> 3 >>> 0] : n => ut[n >>> 3 >>> 0];
          default:
            throw new TypeError(`invalid integer width (${r}): ${e}`)
        }
      },
      Ei = function(e, r, t, n, a) {
        e >>>= 0, r >>>= 0, t >>>= 0, r = re(r);
        const i = n === 0n;
        let o = s => s;
        if (i) {
          const s = t * 8;
          o = c => BigInt.asUintN(s, c), a = o(a)
        }
        ie(e, {
          name: r,
          fromWireType: o,
          toWireType: (s, c) => (typeof c == "number" && (c = BigInt(c)), c),
          readValueFromPointer: ft(r, t, !i),
          destructorFunction: null
        })
      };

    function Fi(e, r, t, n) {
      e >>>= 0, r >>>= 0, r = re(r), ie(e, {
        name: r,
        fromWireType: function(a) {
          return !!a
        },
        toWireType: function(a, i) {
          return i ? t : n
        },
        readValueFromPointer: function(a) {
          return this.fromWireType(D[a >>> 0])
        },
        destructorFunction: null
      })
    }
    var _t = [],
      ve = [0, 1, , 1, null, 1, !0, 1, !1, 1],
      dt = [];

    function Mi(e) {
      if (e >>>= 0, e > 9 && --ve[e + 1] === 0) {
        var r = ve[e];
        ve[e] = void 0;
        var t = dt[e];
        t && (dt[e] = void 0, t(r)), _t.push(e)
      }
    }
    var mt = {
      toValue: e => (e || te(`Cannot use deleted val. handle = ${e}`), ve[e]),
      toHandle: e => {
        switch (e) {
          case void 0:
            return 2;
          case null:
            return 4;
          case !0:
            return 6;
          case !1:
            return 8;
          default: {
            const r = _t.pop() || ve.length;
            return ve[r] = e, ve[r + 1] = 1, r
          }
        }
      }
    };

    function wr(e) {
      return this.fromWireType(T[e >>> 2 >>> 0])
    }
    var Wi = {
      name: "emscripten::val",
      fromWireType: e => {
        var r = mt.toValue(e);
        return Mi(e), r
      },
      toWireType: (e, r) => mt.toHandle(r),
      readValueFromPointer: wr,
      destructorFunction: null
    };

    function Li(e) {
      return e >>>= 0, ie(e, Wi)
    }
    var ne, Ri = (e, r) => {
        switch (r) {
          case 4:
            return function(t) {
              return this.fromWireType(ne[t >>> 2 >>> 0])
            };
          case 8:
            return function(t) {
              return this.fromWireType(j[t >>> 3 >>> 0])
            };
          default:
            throw new TypeError(`invalid float width (${r}): ${e}`)
        }
      },
      Di = function(e, r, t) {
        e >>>= 0, r >>>= 0, t >>>= 0, r = re(r), ie(e, {
          name: r,
          fromWireType: n => n,
          toWireType: (n, a) => a,
          readValueFromPointer: Ri(r, t),
          destructorFunction: null
        })
      },
      Ii = (e, r) => Object.defineProperty(r, "name", {
        value: e
      }),
      Pi = e => {
        for (; e.length;) {
          var r = e.pop(),
            t = e.pop();
          t(r)
        }
      };

    function Ui(e) {
      for (var r = 1; r < e.length; ++r)
        if (e[r] !== null && e[r].destructorFunction === void 0) return !0;
      return !1
    }

    function Oi(e, r, t, n, a, i) {
      var o = r.length;
      o < 2 && te("argTypes array size mismatch! Must at least get return value and receiver (this) types!");
      var s = r[1] !== null && t !== null,
        c = Ui(r),
        u = !r[0].isVoid,
        _ = o - 2,
        v = new Array(_),
        A = [],
        R = [],
        L = function(...h) {
          R.length = 0;
          var E;
          A.length = s ? 2 : 1, A[0] = a, s && (E = r[1].toWireType(R, this), A[1] = E);
          for (var O = 0; O < _; ++O) v[O] = r[O + 2].toWireType(R, h[O]), A.push(v[O]);
          var y = n(...A);

          function M(U) {
            if (c) Pi(R);
            else
              for (var H = s ? 1 : 2; H < r.length; H++) {
                var B = H === 1 ? E : v[H - 2];
                r[H].destructorFunction !== null && r[H].destructorFunction(B)
              }
            if (u) return r[0].fromWireType(U)
          }
          return i ? y.then(M) : M(y)
        };
      return Ii(e, L)
    }
    var Ni = (e, r, t) => {
        if (e[r].overloadTable === void 0) {
          var n = e[r];
          e[r] = function(...a) {
            return e[r].overloadTable.hasOwnProperty(a.length) || te(`Function '${t}' called with an invalid number of arguments (${a.length}) - expects one of (${e[r].overloadTable})!`), e[r].overloadTable[a.length].apply(this, a)
          }, e[r].overloadTable = [], e[r].overloadTable[n.argCount] = n
        }
      },
      Gi = (e, r, t) => {
        l.hasOwnProperty(e) ? ((t === void 0 || l[e].overloadTable !== void 0 && l[e].overloadTable[t] !== void 0) && te(`Cannot register public name '${e}' twice`), Ni(l, e, e), l[e].overloadTable.hasOwnProperty(t) && te(`Cannot register multiple overloads of a function with the same number of arguments (${t})!`), l[e].overloadTable[t] = r) : (l[e] = r, l[e].argCount = t)
      },
      Hi = (e, r) => {
        for (var t = [], n = 0; n < e; n++) t.push(T[r + n * 4 >>> 2 >>> 0]);
        return t
      };
    class Vi extends Error {
      constructor(r) {
        super(r), this.name = "InternalError"
      }
    }
    var pt = e => {
        throw new Vi(e)
      },
      ji = (e, r, t) => {
        l.hasOwnProperty(e) || pt("Replacing nonexistent public symbol"), l[e].overloadTable !== void 0 && t !== void 0 ? l[e].overloadTable[t] = r : (l[e] = r, l[e].argCount = t)
      },
      zi = (e, r, t = [], n = !1) => {
        var a = z(r);
        n && (a = WebAssembly.promising(a));
        var i = a(...t);

        function o(s) {
          return e[0] == "p" ? s >>> 0 : s
        }
        return n ? i.then(o) : o(i)
      },
      Ji = (e, r, t = !1) => (...n) => zi(e, r, n, t),
      $i = (e, r, t = !1) => {
        e = re(e);

        function n() {
          if (e.includes("p")) return Ji(e, r, t);
          var i = z(r);
          return t && (i = WebAssembly.promising(i)), i
        }
        var a = n();
        return typeof a != "function" && te(`unknown function pointer with signature ${e}: ${r}`), a
      };
    class qi extends Error {}
    var Xi = e => {
        var r = ja(e),
          t = re(r);
        return q(r), t
      },
      Yi = (e, r) => {
        var t = [],
          n = {};

        function a(i) {
          if (!n[i] && !Be[i]) {
            if (Ye[i]) {
              Ye[i].forEach(a);
              return
            }
            t.push(i), n[i] = !0
          }
        }
        throw r.forEach(a), new qi(`${e}: ` + t.map(Xi).join([", "]))
      },
      Ki = (e, r, t) => {
        e.forEach(s => Ye[s] = r);

        function n(s) {
          var c = t(s);
          c.length !== e.length && pt("Mismatched type converter count");
          for (var u = 0; u < e.length; ++u) ie(e[u], c[u])
        }
        var a = new Array(r.length),
          i = [],
          o = 0;
        for (let [s, c] of r.entries()) Be.hasOwnProperty(c) ? a[s] = Be[c] : (i.push(c), Te.hasOwnProperty(c) || (Te[c] = []), Te[c].push(() => {
          a[s] = Be[c], ++o, o === i.length && n(a)
        }));
        i.length === 0 && n(a)
      },
      Zi = e => {
        e = e.trim();
        const r = e.indexOf("(");
        return r === -1 ? e : e.slice(0, r)
      };

    function Qi(e, r, t, n, a, i, o, s) {
      e >>>= 0, t >>>= 0, n >>>= 0, a >>>= 0, i >>>= 0;
      var c = Hi(r, t);
      e = re(e), e = Zi(e), a = $i(n, a, o), Gi(e, function() {
        Yi(`Cannot call ${e} due to unbound types`, c)
      }, r - 1), Ki([], c, u => {
        var _ = [u[0], null].concat(u.slice(1));
        return ji(e, Oi(e, _, null, a, i, o), r - 1), []
      })
    }
    var eo = function(e, r, t, n, a) {
      e >>>= 0, r >>>= 0, t >>>= 0, r = re(r);
      const i = n === 0;
      let o = c => c;
      if (i) {
        var s = 32 - 8 * t;
        o = c => c << s >>> s, a = o(a)
      }
      ie(e, {
        name: r,
        fromWireType: o,
        toWireType: (c, u) => u,
        readValueFromPointer: ft(r, t, n !== 0),
        destructorFunction: null
      })
    };

    function ro(e, r, t) {
      e >>>= 0, t >>>= 0;
      var n = [Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array],
        a = n[r];

      function i(o) {
        var s = T[o >>> 2 >>> 0],
          c = T[o + 4 >>> 2 >>> 0];
        return new a(F.buffer, c, s)
      }
      t = re(t), ie(e, {
        name: t,
        fromWireType: i,
        readValueFromPointer: i
      }, {
        ignoreDuplicateRegistrations: !0
      })
    }
    var to = (e, r, t, n) => {
        if (t >>>= 0, !(n > 0)) return 0;
        for (var a = t, i = t + n - 1, o = 0; o < e.length; ++o) {
          var s = e.codePointAt(o);
          if (s <= 127) {
            if (t >= i) break;
            r[t++ >>> 0] = s
          } else if (s <= 2047) {
            if (t + 1 >= i) break;
            r[t++ >>> 0] = 192 | s >> 6, r[t++ >>> 0] = 128 | s & 63
          } else if (s <= 65535) {
            if (t + 2 >= i) break;
            r[t++ >>> 0] = 224 | s >> 12, r[t++ >>> 0] = 128 | s >> 6 & 63, r[t++ >>> 0] = 128 | s & 63
          } else {
            if (t + 3 >= i) break;
            r[t++ >>> 0] = 240 | s >> 18, r[t++ >>> 0] = 128 | s >> 12 & 63, r[t++ >>> 0] = 128 | s >> 6 & 63, r[t++ >>> 0] = 128 | s & 63, o++
          }
        }
        return r[t >>> 0] = 0, t - a
      },
      N = (e, r, t) => to(e, D, r, t),
      ue = e => {
        for (var r = 0, t = 0; t < e.length; ++t) {
          var n = e.charCodeAt(t);
          n <= 127 ? r++ : n <= 2047 ? r += 2 : n >= 55296 && n <= 57343 ? (r += 4, ++t) : r += 3
        }
        return r
      };

    function no(e, r) {
      e >>>= 0, r >>>= 0, r = re(r);
      var t = !0;
      ie(e, {
        name: r,
        fromWireType(n) {
          var a = T[n >>> 2 >>> 0],
            i = n + 4,
            o;
          if (t) o = w(i, a, !0);
          else {
            o = "";
            for (var s = 0; s < a; ++s) o += String.fromCharCode(D[i + s >>> 0])
          }
          return q(n), o
        },
        toWireType(n, a) {
          a instanceof ArrayBuffer && (a = new Uint8Array(a));
          var i, o = typeof a == "string";
          o || ArrayBuffer.isView(a) && a.BYTES_PER_ELEMENT == 1 || te("Cannot pass non-string to std::string"), t && o ? i = ue(a) : i = a.length;
          var s = J(4 + i + 1),
            c = s + 4;
          if (T[s >>> 2 >>> 0] = i, o)
            if (t) N(a, c, i + 1);
            else
              for (var u = 0; u < i; ++u) {
                var _ = a.charCodeAt(u);
                _ > 255 && (q(s), te("String has UTF-16 code units that do not fit in 8 bits")), D[c + u >>> 0] = _
              } else D.set(a, c >>> 0);
          return n !== null && n.push(q, s), s
        },
        readValueFromPointer: wr,
        destructorFunction(n) {
          q(n)
        }
      })
    }
    var gt = globalThis.TextDecoder ? new TextDecoder("utf-16le") : void 0,
      ao = (e, r, t) => {
        var n = e >>> 1,
          a = nt(Ee, n, r / 2, t);
        if (a - n > 16 && gt) return gt.decode(Ee.slice(n, a));
        for (var i = "", o = n; o < a; ++o) {
          var s = Ee[o >>> 0];
          i += String.fromCharCode(s)
        }
        return i
      },
      io = (e, r, t = 2147483647) => {
        if (t < 2) return 0;
        t -= 2;
        for (var n = r, a = t < e.length * 2 ? t / 2 : e.length, i = 0; i < a; ++i) {
          var o = e.charCodeAt(i);
          Y[r >>> 1 >>> 0] = o, r += 2
        }
        return Y[r >>> 1 >>> 0] = 0, r - n
      },
      oo = e => e.length * 2,
      so = (e, r, t) => {
        for (var n = "", a = e >>> 2, i = 0; !(i >= r / 4); i++) {
          var o = T[a + i >>> 0];
          if (!o && !t) break;
          n += String.fromCodePoint(o)
        }
        return n
      },
      co = (e, r, t = 2147483647) => {
        if (r >>>= 0, t < 4) return 0;
        for (var n = r, a = n + t - 4, i = 0; i < e.length; ++i) {
          var o = e.codePointAt(i);
          if (o > 65535 && i++, g[r >>> 2 >>> 0] = o, r += 4, r + 4 > a) break
        }
        return g[r >>> 2 >>> 0] = 0, r - n
      },
      lo = e => {
        for (var r = 0, t = 0; t < e.length; ++t) {
          var n = e.codePointAt(t);
          n > 65535 && t++, r += 4
        }
        return r
      };

    function uo(e, r, t) {
      e >>>= 0, r >>>= 0, t >>>= 0, t = re(t);
      var n, a, i;
      r === 2 ? (n = ao, a = io, i = oo) : (n = so, a = co, i = lo), ie(e, {
        name: t,
        fromWireType: o => {
          var s = T[o >>> 2 >>> 0],
            c = n(o + 4, s * r, !0);
          return q(o), c
        },
        toWireType: (o, s) => {
          typeof s != "string" && te(`Cannot pass non-string to C++ string type ${t}`);
          var c = i(s),
            u = J(4 + c + r);
          return T[u >>> 2 >>> 0] = c / r, a(s, u + 4, c + r), o !== null && o.push(q, u), u
        },
        readValueFromPointer: wr,
        destructorFunction(o) {
          q(o)
        }
      })
    }
    var fo = function(e, r) {
      e >>>= 0, r >>>= 0, r = re(r), ie(e, {
        isVoid: !0,
        name: r,
        fromWireType: () => {},
        toWireType: (t, n) => {}
      })
    };

    function _o(e, r, t) {
      r >>>= 0, t >>>= 0;
      var n = K.xhrs.get(e).getAllResponseHeaders();
      return N(n, r, t) + 1
    }

    function mo(e) {
      return ue(K.xhrs.get(e).getAllResponseHeaders())
    }

    function po(e) {
      e >>>= 0;
      var r = !Re;
      try {
        Atomics.wait(g, 0, 0, 0), r = !0
      } catch {}
      Ir(e, !ae, 1, r, 262144, !1), P.threadInitTLS()
    }
    var xr = () => new Error().stack.toString(),
      go = e => {
        var r = xr(),
          t = r.split(`
`);
        r = "";
        var n = new RegExp("\\s*(.*?)@(.*?):([0-9]+):([0-9]+)"),
          a = new RegExp("\\s*at (.*?) \\((.*):(.*):(.*)\\)");
        for (var i of t) {
          var o = "",
            s = "",
            c = 0,
            u = 0,
            _ = a.exec(i);
          if (_?.length == 5) o = _[1], s = _[2], c = _[3], u = _[4];
          else if (_ = n.exec(i), _?.length >= 4) o = _[1], s = _[2], c = _[3], u = _[4] | 0;
          else {
            r += i + `
`;
            continue
          }
          if (o == "_emscripten_log" || o == "_emscripten_get_callstack") {
            r = "";
            continue
          }
          e & 24 && (e & 64 && (s = s.substring(s.replace(/\\/g, "/").lastIndexOf("/") + 1)), r += `    at ${o} (${s}:${c}:${u})
`)
        }
        return r = r.replace(/\s+$/, ""), r
      };

    var __englog = (function () {
      var on = !1;
      try { on = /[?&]englog=1/.test(location.search) || globalThis.localStorage && "1" === localStorage.getItem("rh.englog") } catch (_) {}
      var arr = globalThis.__engx = globalThis.__engx || [];
      return function (e, r) {
        arr.length > 8192 && arr.splice(0, 4096);
        arr.push(e + r);
        if (on) { try { globalThis.LOG && LOG.raw("[eng] " + e + r) } catch (_) {} }
      }
    })();
    function vo(e, r) { var t = ""; try { t = w(r >>> 0 ? r : e) } catch (_) {} try { __englog("f ", t || "#" + e + "," + r) } catch (_) {} }
    var Ke = e => {
        if (e instanceof qr || e == "unwind") return Se;
        Pe(1, e)
      },
      vt = () => {
        if (!gr()) try {
          if (S) {
            fe() && Pr(Se);
            return
          }
          hr(Se)
        } catch (e) {
          Ke(e)
        }
      },
      Fe = e => {
        if (!Ce) try {
          return e()
        } catch (r) {
          Ke(r)
        } finally {
          vt()
        }
      };

    function kr(e) {
      if (e >>>= 0, !rt) {
        var r = Atomics.waitAsync(g, e >>> 2, e);
        r.value.then(Ze);
        var t = e + 112;
        Atomics.store(g, t >>> 2, 1)
      }
    }
    var Ze = () => {
      var e = fe();
      e && Fe(() => {
        kr(e), ei()
      })
    };

    function bo(e, r) {
      if (e >>>= 0, r >>>= 0, e == r) setTimeout(Ze);
      else if (S) postMessage({
        targetThread: e,
        cmd: 4
      });
      else {
        var t = P.pthreads[e];
        if (!t) return;
        t.postMessage({
          cmd: 4
        })
      }
    }
    var Cr = [];

    function ho(e, r, t, n, a, i, o) {
      r >>>= 0, t >>>= 0, a >>>= 0, i >>>= 0, o >>>= 0, Cr.length = 0;
      for (var s = a >>> 3, c = a + n >>> 3; s < c;) {
        var u;
        le[s++ >>> 0] ? u = le[s++ >>> 0] : u = j[s++ >>> 0], Cr.push(u)
      }
      var _ = r ? Rr[r] : Df[e];
      P.currentProxiedOperationCallerThread = t;
      var v = _(...Cr);
      if (P.currentProxiedOperationCallerThread = 0, i) {
        v.then(A => Ka(i, o, A));
        return
      }
      return v
    }
    var yo = () => {
      Ne = 0
    };

    function wo(e) {
      e >>>= 0, S ? postMessage({
        cmd: 6,
        thread: e
      }) : Yr(e)
    }

    function xo(e) {
      e >>>= 0
    }

    function ko(e, r) {
      e = Xe(e), r >>>= 0;
      var t = new Date(e * 1e3);
      if (isNaN(t.getTime())) return 1;
      g[r >>> 2 >>> 0] = t.getUTCSeconds(), g[r + 4 >>> 2 >>> 0] = t.getUTCMinutes(), g[r + 8 >>> 2 >>> 0] = t.getUTCHours(), g[r + 12 >>> 2 >>> 0] = t.getUTCDate(), g[r + 16 >>> 2 >>> 0] = t.getUTCMonth(), g[r + 20 >>> 2 >>> 0] = t.getUTCFullYear() - 1900, g[r + 24 >>> 2 >>> 0] = t.getUTCDay();
      var n = Date.UTC(t.getUTCFullYear(), 0, 1, 0, 0, 0, 0),
        a = (t.getTime() - n) / (1e3 * 60 * 60 * 24) | 0;
      return g[r + 28 >>> 2 >>> 0] = a, 0
    }
    var Co = e => e % 4 === 0 && (e % 100 !== 0 || e % 400 === 0),
      So = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335],
      Ao = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334],
      bt = e => {
        var r = Co(e.getFullYear()),
          t = r ? So : Ao,
          n = t[e.getMonth()] + e.getDate() - 1;
        return n
      };

    function To(e, r) {
      e = Xe(e), r >>>= 0;
      var t = new Date(e * 1e3);
      if (isNaN(t.getTime())) return 1;
      g[r >>> 2 >>> 0] = t.getSeconds(), g[r + 4 >>> 2 >>> 0] = t.getMinutes(), g[r + 8 >>> 2 >>> 0] = t.getHours(), g[r + 12 >>> 2 >>> 0] = t.getDate(), g[r + 16 >>> 2 >>> 0] = t.getMonth(), g[r + 20 >>> 2 >>> 0] = t.getFullYear() - 1900, g[r + 24 >>> 2 >>> 0] = t.getDay();
      var n = bt(t) | 0;
      g[r + 28 >>> 2 >>> 0] = n, g[r + 36 >>> 2 >>> 0] = -(t.getTimezoneOffset() * 60);
      var a = new Date(t.getFullYear(), 0, 1),
        i = new Date(t.getFullYear(), 6, 1).getTimezoneOffset(),
        o = a.getTimezoneOffset(),
        s = (i != o && t.getTimezoneOffset() == Math.min(o, i)) | 0;
      return g[r + 32 >>> 2 >>> 0] = s, 0
    }
    var Bo = function(e) {
        e >>>= 0;
        var r = (() => {
          var t = new Date(g[e + 20 >>> 2 >>> 0] + 1900, g[e + 16 >>> 2 >>> 0], g[e + 12 >>> 2 >>> 0], g[e + 8 >>> 2 >>> 0], g[e + 4 >>> 2 >>> 0], g[e >>> 2 >>> 0], 0);
          if (isNaN(t.getTime())) return -1;
          var n = g[e + 32 >>> 2 >>> 0],
            a = t.getTimezoneOffset(),
            i = new Date(t.getFullYear(), 0, 1),
            o = new Date(t.getFullYear(), 6, 1).getTimezoneOffset(),
            s = i.getTimezoneOffset(),
            c = Math.min(s, o);
          if (n < 0) n = +(o != s && c == a);
          else if (n > 0 != (c == a)) {
            var u = Math.max(s, o),
              _ = n > 0 ? c : u;
            if (t.setTime(t.getTime() + (_ - a) * 6e4), isNaN(t.getTime())) return -1
          }
          g[e + 32 >>> 2 >>> 0] = n, g[e + 24 >>> 2 >>> 0] = t.getDay();
          var v = bt(t) | 0;
          return g[e + 28 >>> 2 >>> 0] = v, g[e >>> 2 >>> 0] = t.getSeconds(), g[e + 4 >>> 2 >>> 0] = t.getMinutes(), g[e + 8 >>> 2 >>> 0] = t.getHours(), g[e + 12 >>> 2 >>> 0] = t.getDate(), g[e + 16 >>> 2 >>> 0] = t.getMonth(), g[e + 20 >>> 2 >>> 0] = t.getYear(), t.getTime() / 1e3
        })();
        return BigInt(r)
      },
      ht = {
        varargs: void 0,
        getStr(e) {
          var r = w(e);
          return r
        }
      };

    function yt(e, r, t, n, a, i) {
      return S ? W(7, 0, 1, e, r, t, n, a, i) : (e >>>= 0, r >>>= 0, i = Xe(i), isNaN(i) ? -22 : (ht.doMsync(e, ht.getStreamFromFD(a), r, n, i), 0))
    }
    var Eo = function(e, r, t, n) {
        e >>>= 0, r >>>= 0, t >>>= 0, n >>>= 0;
        var a = new Date().getFullYear(),
          i = new Date(a, 0, 1),
          o = new Date(a, 6, 1),
          s = i.getTimezoneOffset(),
          c = o.getTimezoneOffset(),
          u = Math.max(s, c);
        T[e >>> 2 >>> 0] = u * 60, g[r >>> 2 >>> 0] = +(s != c);
        var _ = R => {
            var L = R >= 0 ? "-" : "+",
              h = Math.abs(R),
              E = String(Math.floor(h / 60)).padStart(2, "0"),
              O = String(h % 60).padStart(2, "0");
            return `UTC${L}${E}${O}`
          },
          v = _(s),
          A = _(c);
        c < s ? (N(v, t, 17), N(A, n, 17)) : (N(v, n, 17), N(A, t, 17))
      },
      Qe = () => performance.timeOrigin + performance.now(),
      wt = () => Date.now(),
      Fo = 1,
      Mo = e => e >= 0 && e <= 3;

    function Wo(e, r, t) {
      if (r = Xe(r), t >>>= 0, !Mo(e)) return 28;
      var n;
      if (e === 0) n = wt();
      else if (Fo) n = Qe();
      else return 52;
      var a = Math.round(n * 1e3 * 1e3);
      return le[t >>> 3 >>> 0] = BigInt(a), 0
    }
    var Sr = [],
      xt = (e, r) => {
        Sr.length = 0;
        for (var t; t = D[e++ >>> 0];) {
          var n = t != 105;
          n &= t != 112, r += n && r % 8 ? 4 : 0, Sr.push(t == 112 ? T[r >>> 2 >>> 0] : t == 106 ? le[r >>> 3 >>> 0] : t == 105 ? g[r >>> 2 >>> 0] : j[r >>> 3 >>> 0]), r += n ? 8 : 4
        }
        return Sr
      },
      kt = (e, r, t, n) => {
        var a = xt(r, t);
        return S ? W(0, e, n, ...a) : Rr[e](...a)
      };

    function Lo(e, r, t) {
      return e >>>= 0, r >>>= 0, t >>>= 0, kt(e, r, t, 0)
    }
    var Ct = (e, r, t) => {
      var n = xt(r, t);
      return Rr[e](...n)
    };

    function Ro(e, r, t) {
      return e >>>= 0, r >>>= 0, t >>>= 0, Ct(e, r, t)
    }

    function Do(e, r, t) {
      return e >>>= 0, r >>>= 0, t >>>= 0, Ct(e, r, t)
    }

    function Io(e, r, t) {
      return e >>>= 0, r >>>= 0, t >>>= 0, kt(e, r, t, 1)
    }
    var be = () => {
        Ne += 1
      },
      he = () => {
        Ne -= 1
      },
      Po = (e, r) => (be(), setTimeout(() => {
        he(), Fe(e)
      }, r)),
      Ar = (e, r) => {
        if (C.timingMode = e, C.timingValue = r, !C.func) return 1;
        if (C.scheduler || be(), e == 0) C.scheduler = function() {
          var o = Math.max(0, C.tickStartTime + r - Qe()) | 0;
          setTimeout(C.runner, o)
        };
        else if (e == 1) C.scheduler = function() {
          C.requestAnimationFrame(C.runner)
        };
        else {
          if (!C.setImmediate)
            if (globalThis.scheduler) C.setImmediate = scheduler.postTask.bind(scheduler);
            else {
              var t = [],
                n = "setimmediate",
                a = i => {
                  i.data === n && (i.stopPropagation(), t.shift()())
                };
              addEventListener("message", a, !0), C.setImmediate = i => {
                t.push(i), ae ? postMessage(n) : postMessage(n, "*")
              }
            } C.scheduler = function() {
            C.setImmediate(C.runner)
          }
        }
        return 0
      },
      Uo = (e, r, t, n, a) => {
        C.func = e, C.arg = n;
        var i = C.currentlyRunningMainloop;

        function o() {
          return i < C.currentlyRunningMainloop ? (vt(), !1) : !0
        }
        if (C.runner = function() {
            if (!Ce) {
              if (C.queue.length > 0) {
                var c = Date.now(),
                  u = C.queue.shift();
                if (u.func(u.arg), C.remainingBlockers) {
                  var _ = C.remainingBlockers,
                    v = _ % 1 == 0 ? _ - 1 : Math.floor(_);
                  u.counted ? C.remainingBlockers = v : (v = v + .5, C.remainingBlockers = (8 * _ + v) / 9)
                }
                if (C.updateStatus(), !o()) return;
                setTimeout(C.runner, 0);
                return
              }
              if (o()) {
                if (C.currentFrameNumber = C.currentFrameNumber + 1 | 0, C.timingMode == 1 && C.timingValue > 1 && C.currentFrameNumber % C.timingValue != 0) {
                  C.scheduler();
                  return
                } else C.timingMode == 0 && (C.tickStartTime = Qe());
                C.runIter(e), o() && C.scheduler()
              }
            }
          }, a || (r > 0 ? Ar(0, 1e3 / r) : Ar(1, 1), C.scheduler()), t) throw "unwind"
      },
      C = {
        func: null,
        scheduler: null,
        currentlyRunningMainloop: 0,
        arg: 0,
        timingMode: 0,
        timingValue: 0,
        currentFrameNumber: 0,
        queue: [],
        preMainLoop: [],
        postMainLoop: [],
        pause() {
          C.scheduler && (C.scheduler = null, C.currentlyRunningMainloop++, he())
        },
        resume() {
          C.currentlyRunningMainloop++;
          var e = C.timingMode,
            r = C.timingValue,
            t = C.func;
          C.func = null, Uo(t, 0, !1, C.arg, !0), Ar(e, r), C.scheduler()
        },
        updateStatus() {
          if (l.setStatus) {
            var e = l.statusMessage || "Please wait...",
              r = C.remainingBlockers ?? 0,
              t = C.expectedBlockers ?? 0;
            r ? r < t ? l.setStatus("{message} ({expected - remaining}/{expected})") : l.setStatus(e) : l.setStatus("")
          }
        },
        init() {},
        runIter(e) {
          if (!Ce) {
            for (var r of C.preMainLoop)
              if (r() === !1) return;
            Fe(e);
            for (var t of C.postMainLoop) t()
          }
        },
        nextRAF: 0,
        fakeRequestAnimationFrame(e) {
          var r = Date.now();
          if (!C.nextRAF) C.nextRAF = r + 1e3 / 60;
          else
            for (; r + 2 >= C.nextRAF;) C.nextRAF += 1e3 / 60;
          var t = Math.max(C.nextRAF - r, 0);
          setTimeout(e, t)
        },
        requestAnimationFrame(e) {
          globalThis.requestAnimationFrame ? requestAnimationFrame(e) : C.fakeRequestAnimationFrame(e)
        }
      },
      Oo = e => (be(), C.requestAnimationFrame(() => {
        he(), Fe(e)
      })),
      No = function(e, r, t) {
        e >>>= 0, r >>>= 0;
        var n = () => z(e)(r);
        t >= 0 ? Po(n, t) : Oo(n)
      },
      Go = () => {};

    function Ho(e) { try { __englog("E ", w(e)) } catch (_) {} }   // emscripten_console_error

    function Vo(e) { try { __englog("L ", w(e)) } catch (_) {} }   // emscripten_console_log

    function jo(e) { try { __englog("W ", w(e)) } catch (_) {} }   // emscripten_console_warn

    function zo(e, r) { try { __englog("2 ", xi(D, e, Math.min(r >>> 0, 65536), 1)) } catch (_) {} } // emscripten_errn
    var Jo = [],
      v_ = e => Jo.push(e),
      b = {
        removeAllEventListeners() {
          for (; b.eventHandlers.length;) b._removeHandler(b.eventHandlers.length - 1);
          b.deferredCalls = []
        },
        inEventHandler: 0,
        deferredCalls: [],
        deferCall(e, r, t) {
          function n(i, o) {
            if (i.length != o.length) return !1;
            for (var s = 0; s < i.length; s++)
              if (i[s] != o[s]) return !1;
            return !0
          }
          for (var a of b.deferredCalls)
            if (a.targetFunction == e && n(a.argsList, t)) return;
          b.deferredCalls.push({
            targetFunction: e,
            precedence: r,
            argsList: t
          }), b.deferredCalls.sort((i, o) => i.precedence - o.precedence)
        },
        removeDeferredCalls(e) {
          b.deferredCalls = b.deferredCalls.filter(r => r.targetFunction != e)
        },
        canPerformEventHandlerRequests() {
          return navigator.userActivation.isActive
        },
        runDeferredCalls() {
          if (b.canPerformEventHandlerRequests()) {
            var e = b.deferredCalls;
            b.deferredCalls = [];
            for (var r of e) r.targetFunction(...r.argsList)
          }
        },
        eventHandlers: [],
        removeAllHandlersOnTarget: (e, r) => {
          for (var t = 0; t < b.eventHandlers.length; ++t) b.eventHandlers[t].target == e && (!r || r == b.eventHandlers[t].eventTypeString) && b._removeHandler(t--)
        },
        _removeHandler(e) {
          var r = b.eventHandlers[e];
          r.target.removeEventListener(r.eventTypeString, r.eventListenerFunc, r.useCapture), b.eventHandlers.splice(e, 1)
        },
        registerOrRemoveHandler(e) {
          if (!e.target) return -4;
          if (e.callbackfunc) e.eventListenerFunc = function(t) {
            ++b.inEventHandler, b.currentEventHandler = e, b.runDeferredCalls(), e.handlerFunc(t), b.runDeferredCalls(), --b.inEventHandler
          }, e.target.addEventListener(e.eventTypeString, e.eventListenerFunc, e.useCapture), b.eventHandlers.push(e);
          else
            for (var r = 0; r < b.eventHandlers.length; ++r) b.eventHandlers[r].target == e.target && b.eventHandlers[r].eventTypeString == e.eventTypeString && b._removeHandler(r--);
          return 0
        },
        removeSingleHandler(e) {
          let r = !1;
          for (let t = 0; t < b.eventHandlers.length; ++t) {
            const n = b.eventHandlers[t];
            n.target === e.target && n.eventTypeId === e.eventTypeId && n.callbackfunc === e.callbackfunc && n.userData === e.userData && (b._removeHandler(t--), r = !0)
          }
          return r ? 0 : -5
        },
        getTargetThreadForEventCallback(e) {
          switch (e) {
            case 1:
              return 0;
            case 2:
              return P.currentProxiedOperationCallerThread;
            default:
              return e
          }
        },
        getNodeNameForTarget(e) {
          return e == window ? "#window" : e == screen ? "#screen" : e?.nodeName ?? ""
        },
        fullscreenEnabled() {
          return document.fullscreenEnabled
        }
      },
      Tr = e => {
        if (e.requestPointerLock) e.requestPointerLock();
        else return document.body.requestPointerLock ? -3 : -1;
        return 0
      };

    function St() {
      return S ? W(8, 0, 1) : (b.removeDeferredCalls(Tr), document.exitPointerLock ? (document.exitPointerLock(), 0) : -1)
    }
    var $o = () => {
      throw be(), "unwind"
    };

    function qo(e) {
      if (K.xhrs.has(e)) {
        var r = K.xhrs.get(e);
        K.xhrs.free(e), r.readyState > 0 && r.readyState < 4 && r.abort()
      }
    }
    var Xo = e => e > 2 ? w(e) : e,
      At = [0, globalThis.document ?? 0, globalThis.window ?? 0],
      oe = e => {
        e = Xo(e);
        var r = At[e] || globalThis.document?.querySelector(e);
        return r
      },
      Ge = oe,
      Tt = (e, r, t) => {
        var n = Ge(e);
        if (!n) return -4;
        if (!n.controlTransferredOffscreen) g[r >>> 2 >>> 0] = n.width, g[t >>> 2 >>> 0] = n.height;
        else return -4;
        return 0
      };

    function Bt(e, r, t) {
      return S ? W(9, 0, 1, e, r, t) : Tt(e, r, t)
    }

    function Yo(e, r, t) {
      e >>>= 0, r >>>= 0, t >>>= 0;
      var n = Ge(e);
      return n ? Tt(e, r, t) : Bt(e, r, t)
    }

    function Et() {
      return S ? W(10, 0, 1) : devicePixelRatio
    }
    var Br = e => At.indexOf(e) < 0 ? e.getBoundingClientRect() : {
      left: 0,
      top: 0
    };

    function Ft(e, r, t) {
      if (S) return W(11, 0, 1, e, r, t);
      if (e >>>= 0, r >>>= 0, t >>>= 0, e = oe(e), !e) return -4;
      var n = Br(e);
      return j[r >>> 3 >>> 0] = n.width, j[t >>> 3 >>> 0] = n.height, 0
    }
    var Mt = (e, r) => {
      j[e >>> 3 >>> 0] = r.timestamp;
      for (var t = 0; t < r.axes.length; ++t) j[e + t * 8 + 16 >>> 3 >>> 0] = r.axes[t];
      for (var t = 0; t < r.buttons.length; ++t) F[e + t + 1040 >>> 0] = r.buttons[t].pressed, j[e + t * 8 + 528 >>> 3 >>> 0] = r.buttons[t].value;
      F[e + 1104 >>> 0] = r.connected, g[e + 1108 >>> 2 >>> 0] = r.index, g[e + 8 >>> 2 >>> 0] = r.axes.length, g[e + 12 >>> 2 >>> 0] = r.buttons.length, N(r.id, e + 1112, 64), N(r.mapping, e + 1176, 64)
    };

    function Wt(e, r) {
      return S ? W(12, 0, 1, e, r) : (r >>>= 0, e < 0 || e >= b.lastGamepadState.length ? -5 : b.lastGamepadState[e] ? (Mt(r, b.lastGamepadState[e]), 0) : -7)
    }
    var Ko = () => D.length;

    function Zo() {
      return Ko()
    }

    function Lt() {
      return S ? W(13, 0, 1) : b.lastGamepadState.length
    }
    var Qo = () => navigator.hardwareConcurrency;

    function es(e, r) { try { __englog("1 ", xi(D, e, Math.min(r >>> 0, 65536), 1)) } catch (_) {} } // emscripten_outn
    var ye = {},
      me = e => {
        var r = ue(e) + 1,
          t = J(r);
        return t && N(e, t, r), t
      },
      er = e => {
        var r;
        return (r = /\bwasm-function\[\d+\]:(0x[0-9a-f]+)/.exec(e)) ? +r[1] : (r = /:(\d+):\d+(?:\)|$)/.exec(e)) ? 2147483648 | +r[1] : 0
      },
      Rt = e => {
        for (var r of e) {
          var t = er(r);
          t && (ye[t] = r)
        }
      };

    function rs() {
      var e = xr().split(`
`);
      return e[0] == "Error" && e.shift(), Rt(e), ye.last_addr = er(e[3]), ye.last_stack = e, ye.last_addr
    }

    function rr(e) {
      e >>>= 0;
      var r = ye[e];
      if (!r) return 0;
      var t, n;
      if (n = /^\s+at .*\.wasm\.(.*) \(.*\)$/.exec(r)) t = n[1];
      else if (n = /^\s+at (.*) \(.*\)$/.exec(r)) t = n[1];
      else if (n = /^(.+?)@/.exec(r)) t = n[1];
      else return 0;
      return q(rr.ret ?? 0), rr.ret = me(t), rr.ret
    }

    function Dt(e, r) {
      return S ? W(14, 0, 1, e, r) : (e >>>= 0, e = oe(e), e ? e.requestPointerLock ? b.canPerformEventHandlerRequests() ? Tr(e) : r ? (b.deferCall(Tr, 2, [e]), 1) : -2 : -1 : -4)
    }

    function ts(e) {
      e >>>= 0;
      var r = D.length;
      return !1
    }
    var ns = be;

    function tr() {
      if (S) return W(15, 0, 1);
      try {
        if (navigator.getGamepads) return (b.lastGamepadState = navigator.getGamepads()) ? 0 : -1
      } catch {
        navigator.getGamepads = null
      }
      return -1
    }
    var It = (e, r, t, n, a, i, o) => {
      o = b.getTargetThreadForEventCallback(o);
      var s = 256;
      b.focusEvent || (b.focusEvent = J(s));
      var c = _ => {
          var v = b.getNodeNameForTarget(_.target),
            A = _.target.id ?? "",
            R = b.focusEvent;
          N(v, R + 0, 128), N(A, R + 128, 128), o ? pe(o, n, a, R, s, r) : z(n)(a, R, r) && _.preventDefault()
        },
        u = {
          target: oe(e),
          eventTypeString: i,
          eventTypeId: a,
          userData: r,
          callbackfunc: n,
          handlerFunc: c,
          useCapture: t
        };
      return b.registerOrRemoveHandler(u)
    };

    function Pt(e, r, t, n, a) {
      return S ? W(16, 0, 1, e, r, t, n, a) : (e >>>= 0, r >>>= 0, n >>>= 0, a >>>= 0, It(e, r, t, n, 12, "blur", a))
    }
    var Ut = (e, r, t) => {
      var n = Ge(e);
      if (!n || n.controlTransferredOffscreen) return -4;
      var a = !1;
      if (n.GLctxObject?.GLctx) {
        var i = n.GLctxObject.GLctx.getParameter(2978);
        a = !i[0] && !i[1] && i[2] === n.width && i[3] === n.height
      }
      return n.width = r, n.height = t, a && n.GLctxObject.GLctx.viewport(0, 0, r, t), 0
    };

    function Ot(e, r, t) {
      return S ? W(17, 0, 1, e, r, t) : Ut(e, r, t)
    }

    function as(e, r, t) {
      e >>>= 0;
      var n = Ge(e);
      return n ? Ut(e, r, t) : Ot(e, r, t)
    }

    function Nt(e, r, t, n, a) {
      return S ? W(18, 0, 1, e, r, t, n, a) : (e >>>= 0, r >>>= 0, n >>>= 0, a >>>= 0, It(e, r, t, n, 13, "focus", a))
    }
    var Gt = (e, r, t, n, a, i, o) => {
      o = b.getTargetThreadForEventCallback(o);
      var s = 1240;
      b.gamepadEvent || (b.gamepadEvent = J(s));
      var c = _ => {
          var v = b.gamepadEvent;
          Mt(v, _.gamepad), o ? pe(o, n, a, v, s, r) : z(n)(a, v, r) && _.preventDefault()
        },
        u = {
          target: oe(e),
          allowsDeferredCalls: !0,
          eventTypeString: i,
          eventTypeId: a,
          userData: r,
          callbackfunc: n,
          handlerFunc: c,
          useCapture: t
        };
      return b.registerOrRemoveHandler(u)
    };

    function Ht(e, r, t, n) {
      return S ? W(19, 0, 1, e, r, t, n) : (e >>>= 0, t >>>= 0, n >>>= 0, tr() ? -1 : Gt(2, e, r, t, 26, "gamepadconnected", n))
    }

    function Vt(e, r, t, n) {
      return S ? W(20, 0, 1, e, r, t, n) : (e >>>= 0, t >>>= 0, n >>>= 0, tr() ? -1 : Gt(2, e, r, t, 27, "gamepaddisconnected", n))
    }
    var jt = (e, r, t, n, a, i, o) => {
      o = b.getTargetThreadForEventCallback(o);
      var s = 160;
      b.keyEvent || (b.keyEvent = J(s));
      var c = _ => {
          var v = b.keyEvent;
          j[v >>> 3 >>> 0] = _.timeStamp;
          var A = v >>> 2;
          g[A + 2 >>> 0] = _.location, F[v + 12 >>> 0] = _.ctrlKey, F[v + 13 >>> 0] = _.shiftKey, F[v + 14 >>> 0] = _.altKey, F[v + 15 >>> 0] = _.metaKey, F[v + 16 >>> 0] = _.repeat, g[A + 5 >>> 0] = _.charCode, g[A + 6 >>> 0] = _.keyCode, g[A + 7 >>> 0] = _.which, N(_.key ?? "", v + 32, 32), N(_.code ?? "", v + 64, 32), N(_.char ?? "", v + 96, 32), N(_.locale ?? "", v + 128, 32), o ? pe(o, n, a, v, s, r) : z(n)(a, v, r) && _.preventDefault()
        },
        u = {
          target: oe(e),
          eventTypeString: i,
          eventTypeId: a,
          userData: r,
          callbackfunc: n,
          handlerFunc: c,
          useCapture: t
        };
      return b.registerOrRemoveHandler(u)
    };

    function zt(e, r, t, n, a) {
      return S ? W(21, 0, 1, e, r, t, n, a) : (e >>>= 0, r >>>= 0, n >>>= 0, a >>>= 0, jt(e, r, t, n, 2, "keydown", a))
    }

    function Jt(e, r, t, n, a) {
      return S ? W(22, 0, 1, e, r, t, n, a) : (e >>>= 0, r >>>= 0, n >>>= 0, a >>>= 0, jt(e, r, t, n, 3, "keyup", a))
    }
    var $t = (e, r, t) => {
        j[e >>> 3 >>> 0] = r.timeStamp;
        var n = e >>> 2;
        g[n + 2 >>> 0] = r.screenX, g[n + 3 >>> 0] = r.screenY, g[n + 4 >>> 0] = r.clientX, g[n + 5 >>> 0] = r.clientY, F[e + 24 >>> 0] = r.ctrlKey, F[e + 25 >>> 0] = r.shiftKey, F[e + 26 >>> 0] = r.altKey, F[e + 27 >>> 0] = r.metaKey, Y[n * 2 + 14 >>> 0] = r.button, Y[n * 2 + 15 >>> 0] = r.buttons, g[n + 8 >>> 0] = r.movementX, g[n + 9 >>> 0] = r.movementY;
        var a = Br(t);
        g[n + 10 >>> 0] = r.clientX - (a.left | 0), g[n + 11 >>> 0] = r.clientY - (a.top | 0)
      },
      He = (e, r, t, n, a, i, o) => {
        o = b.getTargetThreadForEventCallback(o);
        var s = 64;
        b.mouseEvent || (b.mouseEvent = J(s)), e = oe(e);
        var c = _ => {
            $t(b.mouseEvent, _, e), o ? pe(o, n, a, b.mouseEvent, s, r) : z(n)(a, b.mouseEvent, r) && _.preventDefault()
          },
          u = {
            target: e,
            allowsDeferredCalls: i != "mousemove" && i != "mouseenter" && i != "mouseleave",
            eventTypeString: i,
            eventTypeId: a,
            userData: r,
            callbackfunc: n,
            handlerFunc: c,
            useCapture: t
          };
        return b.registerOrRemoveHandler(u)
      };

    function qt(e, r, t, n, a) {
      return S ? W(23, 0, 1, e, r, t, n, a) : (e >>>= 0, r >>>= 0, n >>>= 0, a >>>= 0, He(e, r, t, n, 5, "mousedown", a))
    }

    function Xt(e, r, t, n, a) {
      return S ? W(24, 0, 1, e, r, t, n, a) : (e >>>= 0, r >>>= 0, n >>>= 0, a >>>= 0, He(e, r, t, n, 33, "mouseenter", a))
    }

    function Yt(e, r, t, n, a) {
      return S ? W(25, 0, 1, e, r, t, n, a) : (e >>>= 0, r >>>= 0, n >>>= 0, a >>>= 0, He(e, r, t, n, 34, "mouseleave", a))
    }

    function Kt(e, r, t, n, a) {
      return S ? W(26, 0, 1, e, r, t, n, a) : (e >>>= 0, r >>>= 0, n >>>= 0, a >>>= 0, He(e, r, t, n, 8, "mousemove", a))
    }

    function Zt(e, r, t, n, a) {
      return S ? W(27, 0, 1, e, r, t, n, a) : (e >>>= 0, r >>>= 0, n >>>= 0, a >>>= 0, He(e, r, t, n, 6, "mouseup", a))
    }
    var is = (e, r, t, n, a, i, o) => {
      o = b.getTargetThreadForEventCallback(o);
      var s = u => {
          o ? pe(o, n, a, 0, 0, r) : z(n)(a, 0, r) && u.preventDefault()
        },
        c = {
          target: e,
          eventTypeString: i,
          eventTypeId: a,
          userData: r,
          callbackfunc: n,
          handlerFunc: s,
          useCapture: t
        };
      return b.registerOrRemoveHandler(c)
    };

    function Qt(e, r, t, n, a) {
      return S ? W(28, 0, 1, e, r, t, n, a) : (e >>>= 0, r >>>= 0, n >>>= 0, a >>>= 0, document.body?.requestPointerLock ? (e = oe(e), e ? is(e, r, t, n, 38, "pointerlockerror", a) : -4) : -1)
    }
    var nr = (e, r, t, n, a, i, o) => {
      o = b.getTargetThreadForEventCallback(o);
      var s = 1552;
      b.touchEvent || (b.touchEvent = J(s)), e = oe(e);
      var c = _ => {
          var v, A = {},
            R = _.touches;
          for (let M of R) M.isChanged = M.onTarget = 0, A[M.identifier] = M;
          for (let M of _.changedTouches) M.isChanged = 1, A[M.identifier] = M;
          for (let M of _.targetTouches) A[M.identifier].onTarget = 1;
          var L = b.touchEvent;
          j[L >>> 3 >>> 0] = _.timeStamp, F[L + 12 >>> 0] = _.ctrlKey, F[L + 13 >>> 0] = _.shiftKey, F[L + 14 >>> 0] = _.altKey, F[L + 15 >>> 0] = _.metaKey;
          var h = L + 16,
            E = Br(e),
            O = 0;
          for (let M of Object.values(A)) {
            var y = h >>> 2;
            if (g[y + 0 >>> 0] = M.identifier, g[y + 1 >>> 0] = M.screenX, g[y + 2 >>> 0] = M.screenY, g[y + 3 >>> 0] = M.clientX, g[y + 4 >>> 0] = M.clientY, g[y + 5 >>> 0] = M.pageX, g[y + 6 >>> 0] = M.pageY, F[h + 28 >>> 0] = M.isChanged, F[h + 29 >>> 0] = M.onTarget, g[y + 8 >>> 0] = M.clientX - (E.left | 0), g[y + 9 >>> 0] = M.clientY - (E.top | 0), h += 48, ++O > 31) break
          }
          g[L + 8 >>> 2 >>> 0] = O, o ? pe(o, n, a, L, s, r) : z(n)(a, L, r) && _.preventDefault()
        },
        u = {
          target: e,
          allowsDeferredCalls: i == "touchstart" || i == "touchend",
          eventTypeString: i,
          eventTypeId: a,
          userData: r,
          callbackfunc: n,
          handlerFunc: c,
          useCapture: t
        };
      return b.registerOrRemoveHandler(u)
    };

    function en(e, r, t, n, a) {
      return S ? W(29, 0, 1, e, r, t, n, a) : (e >>>= 0, r >>>= 0, n >>>= 0, a >>>= 0, nr(e, r, t, n, 25, "touchcancel", a))
    }

    function rn(e, r, t, n, a) {
      return S ? W(30, 0, 1, e, r, t, n, a) : (e >>>= 0, r >>>= 0, n >>>= 0, a >>>= 0, nr(e, r, t, n, 23, "touchend", a))
    }

    function tn(e, r, t, n, a) {
      return S ? W(31, 0, 1, e, r, t, n, a) : (e >>>= 0, r >>>= 0, n >>>= 0, a >>>= 0, nr(e, r, t, n, 24, "touchmove", a))
    }

    function nn(e, r, t, n, a) {
      return S ? W(32, 0, 1, e, r, t, n, a) : (e >>>= 0, r >>>= 0, n >>>= 0, a >>>= 0, nr(e, r, t, n, 22, "touchstart", a))
    }
    var os = (e, r, t, n, a, i, o) => {
      o = b.getTargetThreadForEventCallback(o);
      var s = 96;
      b.wheelEvent || (b.wheelEvent = J(s));
      var c = _ => {
          var v = b.wheelEvent;
          $t(v, _, e), j[v + 64 >>> 3 >>> 0] = _.deltaX, j[v + 72 >>> 3 >>> 0] = _.deltaY, j[v + 80 >>> 3 >>> 0] = _.deltaZ, g[v + 88 >>> 2 >>> 0] = _.deltaMode, o ? pe(o, n, a, v, s, r) : z(n)(a, v, r) && _.preventDefault()
        },
        u = {
          target: e,
          allowsDeferredCalls: !0,
          eventTypeString: i,
          eventTypeId: a,
          userData: r,
          callbackfunc: n,
          handlerFunc: c,
          useCapture: t
        };
      return b.registerOrRemoveHandler(u)
    };

    function an(e, r, t, n, a) {
      return S ? W(33, 0, 1, e, r, t, n, a) : (e >>>= 0, r >>>= 0, n >>>= 0, a >>>= 0, e = oe(e), e ? typeof e.onwheel < "u" ? os(e, r, t, n, 9, "wheel", a) : -1 : -4)
    }

    function ss(e, r, t) {
      e >>>= 0, r >>>= 0;
      var n;
      ye.last_addr == e ? n = ye.last_stack : (n = xr().split(`
`), n[0] == "Error" && n.shift(), Rt(n));
      for (var a = 3; n[a] && er(n[a]) != e;) ++a;
      for (var i = 0; i < t && n[i + a]; ++i) T[r + i * 4 >>> 2 >>> 0] = er(n[i + a]);
      return i
    }
    class on {
      constructor() {
        lr(this, "allocated", [void 0]);
        lr(this, "freelist", [])
      }
      get(r) {
        return this.allocated[r]
      }
      has(r) {
        return this.allocated[r] !== void 0
      }
      allocate(r) {
        var t = this.freelist.pop() ?? this.allocated.length;
        return this.allocated[t] = r, t
      }
      free(r) {
        this.allocated[r] = void 0, this.freelist.push(r)
      }
    }
    var K = {
      async init() {
        K.xhrs = new on
      }
    };

    
