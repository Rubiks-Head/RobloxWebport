// xhr.js — engine XHR implementation (sn, called by cs in glue.js).
// The wasm builds its request in memory; we read method/headers/body out of
// the struct and drive a browser XMLHttpRequest. THE one URL conversion:
// B.open(c, toApiUrl(o), ...) turns the wasm's absolute upstream URL into the
// canonical /api/<id>/?arg=<hex> (see shared/api-url.js). Everything else is
// stock emscripten streaming-XHR bookkeeping.

function sn(e, r, t, n, a) {
      var i = T[e + 8 >>> 2 >>> 0];
      if (!i) {
        t(e, "no url specified!");
        return
      }
      var o = w(i),
        s = e + 108,
        c = w(s + 0);
      c || (c = "GET");
      var u = T[s + 56 >>> 2 >>> 0],
        _ = T[s + 68 >>> 2 >>> 0],
        v = T[s + 72 >>> 2 >>> 0],
        A = T[s + 76 >>> 2 >>> 0],
        R = T[s + 80 >>> 2 >>> 0],
        L = T[s + 84 >>> 2 >>> 0],
        h = T[s + 88 >>> 2 >>> 0],
        E = T[s + 52 >>> 2 >>> 0],
        O = !!(E & 1),
        y = !!(E & 2),
        M = !!(E & 64),
        U = _ ? w(_) : void 0,
        H = v ? w(v) : void 0,
        B = new XMLHttpRequest;
      if (B.withCredentials = !!D[s + 60 >>> 0], B._streamData = y, B.open(c, toApiUrl(o), !M, U, H), M || (B.timeout = u), B.url_ = o, B.responseType = "arraybuffer", R) {
        var k = w(R);
        B.overrideMimeType(k)
      }
      if (A)
        for (;;) {
          var ze = T[A >>> 2 >>> 0];
          if (!ze) break;
          var cr = T[A + 4 >>> 2 >>> 0];
          if (!cr) break;
          A += 8;
          var Ur = w(ze),
            Le = w(cr);
          B.setRequestHeader(Ur, Le)
        }
      var ge = K.xhrs.allocate(B);
      T[e >>> 2 >>> 0] = ge;
      var Or = L && h ? D.slice(L, L + h) : null;

      function x() {
        var m = 0,
          p = 0;
        B.response && O && T[e + 12 >>> 2 >>> 0] === 0 && (p = B.response.byteLength), p > 0 && (m = Dr(T[e + 12 >>> 2 >>> 0], p), D.set(new Uint8Array(B.response), m >>> 0)), T[e + 12 >>> 2 >>> 0] = m, we(e + 16, p), we(e + 24, 0);
        var I = B.response?.byteLength ?? 0;
        if (I && we(e + 32, I), Y[e + 40 >>> 1 >>> 0] = B.readyState, Y[e + 42 >>> 1 >>> 0] = B.status, B.statusText && N(B.statusText, e + 44, 64), M) {
          var V = me(B.responseURL);
          T[e + 200 >>> 2 >>> 0] = V
        }
      }
      B.onload = m => {
        K.xhrs.has(ge) && (x(), B.status >= 200 && B.status < 300 ? r(e, B, m) : t(e, m))
      }, B.onerror = m => {
        K.xhrs.has(ge) && (x(), t(e, m))
      }, B.ontimeout = m => {
        K.xhrs.has(ge) && t(e, m)
      }, B.onprogress = m => {
        if (K.xhrs.has(ge))
          for (var p = O && y ? B.response?.byteLength ?? 0 : 0, I = 8 * 1024 * 1024, V = 0; V < p || !p;) {
            var Q = Math.min(p - V, I),
              ce = 0;
            Q > 0 && O && y && (ce = Dr(T[e + 12 >>> 2 >>> 0], Q), D.set(new Uint8Array(B.response, V, Q), ce >>> 0)), T[e + 12 >>> 2 >>> 0] = ce, we(e + 16, Q), we(e + 24, m.loaded - p + V), we(e + 32, m.total), Y[e + 40 >>> 1 >>> 0] = B.readyState;
            var ke = B.status;
            if (B.readyState >= 3 && B.status === 0 && m.loaded > 0 && (ke = 200), Y[e + 42 >>> 1 >>> 0] = ke, B.statusText && N(B.statusText, e + 44, 64), n(e, m), V += Q, !p) break
          }
      }, B.onreadystatechange = m => {
        if (!K.xhrs.has(ge)) {
          he();
          return
        }
        if (Y[e + 40 >>> 1 >>> 0] = B.readyState, B.readyState >= 2 && (Y[e + 42 >>> 1 >>> 0] = B.status), !M && B.readyState === 2 && B.responseURL.length > 0) {
          var p = me(B.responseURL);
          T[e + 200 >>> 2 >>> 0] = p
        }
        a(e, m)
      };
      try {
        B.send(Or)
      } catch (m) {
        t(e, m)
      }
    }
    var we = (e, r) => {
      T[e >>> 2 >>> 0] = r;
      var t = T[e >>> 2 >>> 0];
      T[e + 4 >>> 2 >>> 0] = (r - t) / 4294967296
    };

    
