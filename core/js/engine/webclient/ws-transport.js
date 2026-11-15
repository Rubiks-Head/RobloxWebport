// WsTransport — a WebTransport-shaped object backed by the server's UDP relay.
// The engine (DebugRbxTransportClientUseWt) calls new WebTransport(url) for its
// datagram channel; we tunnel it as framed ws messages:
//   [0]=datagram   [1][sid u32][data]=stream data   [2][sid]=incoming stream
//   [3][sid]=stream close
// `url` is whatever the engine passed — when it carries a usable host:port we
// pin the relay target with ?to=, otherwise the relay uses the last captured
// joinScript endpoint (server-side session).
// stats block: shared-mem at abi.base+56 (reserved tail before tx0@128).
// Page-side stats-overlay.js reads the same Int32Array — no postMessage.
var __rhStView = null;
function __rhSt() {
  if (__rhStView) return __rhStView;
  var m = globalThis.__rhMem;
  if (m && m.buffer && m.buffer.byteLength > 1072693248 + 128) {
    const b = m.buffer.byteLength > 2146435072 + 128 ? 2146435072 : 1072693248;
    try { __rhStView = new Int32Array(m.buffer, b + 56, 16); } catch (e) {}
  }
  return __rhStView;
}
var __rhDgLast = 0, __rhJit = 0, __rhAvgD = 0;
function __rhDgIn(n) {
  var st = __rhSt(); if (!st) return;
  Atomics.add(st, 2, n); Atomics.add(st, 3, 1);
  var now = performance.now();
  if (__rhDgLast) {
    var d = now - __rhDgLast;
    __rhAvgD += (d - __rhAvgD) / 32;                   // EWMA inter-arrival
    __rhJit += (Math.abs(d - __rhAvgD) - __rhJit) / 16; // RFC3550-style jitter
    Atomics.store(st, 6, (__rhJit * 1000) | 0);
  }
  __rhDgLast = now;
}

function WsTransport(url, opts) {
  var self = this;
  var relay = RELAY_URL + "?proto=udp";
  try {
    var m = String(url || "").match(/(?:wss?|https?):\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d+))?(\/[^ ]*)?/i);
    if (m) {
      // host may be "nil" (engine couldn't mint the fqdn) — the path+query
      // (/wt?X-Rbx-Caps) is still the authoritative WT CONNECT target
      if (m[1] !== "nil" && !/^(localhost|127\.0\.0\.1)$/.test(m[1]))
        relay += "&to=" + m[1] + ":" + (m[2] || "443");
      if (m[3]) relay += "&path=" + encodeURIComponent(m[3]);
    }
  } catch (_) {}
  self._ws = new WebSocket(relay);
  self._ws.binaryType = "arraybuffer";
  self._dgReadCtrl = null;
  self._dgIn = new ReadableStream({
    start: function(c) {
      self._dgReadCtrl = c;
    }
  });
  self._dgOut = new WritableStream({
    write: function(chunk) {
      // datagrams are lossy by design — if the ws is backed up, queueing
      // more just delivers stale position updates later (rubber banding).
      // Drop like real UDP: newest wins, stale never sends.
      var st2 = __rhSt();
      if (self._ws.bufferedAmount > 65536) { if (st2) Atomics.add(st2, 7, 1); return; }
      if (st2) { Atomics.add(st2, 4, chunk.byteLength); Atomics.add(st2, 5, 1); }
      var u = new Uint8Array(chunk);
      var f = new Uint8Array(1 + u.length);
      f[0] = 0;
      f.set(u, 1);
      self._send(f);
    },
    close: function() {
      try {
        self._ws.close();
      } catch (e) {}
    }
  });
  self._streams = new Map();
  self._nextSid = 1;
  self._inCtrl = null;
  self.incomingBidirectionalStreams = new ReadableStream({
    start: function(c) {
      self._inCtrl = c;
    }
  });
  self._inUniCtrl = null;
  self.incomingUnidirectionalStreams = new ReadableStream({
    start: function(c) {
      self._inUniCtrl = c;
    }
  });
  self._mkStream = function(sid) {
    var st = {
      sid: sid,
      _readCtrl: null
    };
    st.readable = new ReadableStream({
      start: function(c) {
        st._readCtrl = c;
      }
    });
    st.writable = new WritableStream({
      write: function(chunk) {
        var f = new Uint8Array(5 + chunk.byteLength);
        f[0] = 1;
        new DataView(f.buffer).setUint32(1, sid, true);
        f.set(new Uint8Array(chunk), 5);
        self._send(f);
      },
      close: function() {
        var f = new Uint8Array(5);
        f[0] = 3;
        new DataView(f.buffer).setUint32(1, sid, true);
        try {
          self._send(f);
        } catch (e) {}
      }
    });
    self._streams.set(sid, st);
    return st;
  };
  self._openStream = function(uni) {
    return self._mkStream((uni ? 0x80000000 : 0) | self._nextSid++);
  };
  // ready gates on the real WT CONNECT result — the bridge sends [4] on
  // :status=200 and [5] on terminate/close; frames written before then queue
  self._readyOk = false;
  self._pending = [];
  self._send = function(f) {
    if (self._readyOk && self._ws.readyState === 1) self._ws.send(f);
    else self._pending.push(f);
  };
  self._ws.onmessage = function(ev) {
    try {
      var d = new Uint8Array(ev.data);
      var t = d[0];
      if (t === 0) {
        __rhDgIn(d.length - 1);
        // inbound datagrams must also drop under backpressure — desiredSize
        // <= 0 means the engine hasn't consumed the last one; queueing a
        // pile of stale position frames is the rubber-banding mechanism
        if (self._dgReadCtrl && self._dgReadCtrl.desiredSize > 0)
          self._dgReadCtrl.enqueue(d.subarray(1));
      } else if (t === 1 && d.length >= 5) {
        var stq = __rhSt(); if (stq) { Atomics.add(stq, 8, d.length - 5); Atomics.add(stq, 9, 1); }
        var sid = new DataView(ev.data).getUint32(1, true);
        var st = self._streams.get(sid);
        if (st && st._readCtrl) st._readCtrl.enqueue(d.subarray(5));
      } else if (t === 2 && d.length >= 5) {
        var sid2 = new DataView(ev.data).getUint32(1, true);
        // bit0 of the announced id carries unidirectional (quic stream type).
        // Register under the BARE sid — inbound data/close frames are keyed by
        // it; bit31 is only set on the sids we allocate for engine streams.
        var uni = d.length >= 6 ? d[5] : 0;
        var nst = self._mkStream(sid2);
        // the glue stores `readable: <item>` — uni items must BE ReadableStreams;
        // bidi items are the {readable, writable} spec object
        var item = uni ? nst.readable : { readable: nst.readable, writable: nst.writable };
        if (uni ? self._inUniCtrl : self._inCtrl) (uni ? self._inUniCtrl : self._inCtrl).enqueue(item);
      } else if (t === 3 && d.length >= 5) {
        var sid3 = new DataView(ev.data).getUint32(1, true);
        var st3 = self._streams.get(sid3 & 0x7fffffff);
        if (st3 && st3._readCtrl) {
          try {
            st3._readCtrl.close();
          } catch (e) {}
        }
      } else if (t === 4) {             // WT_READY
        console.log("[WT] relay accepted WebTransport session");
        self._readyOk = true;
        self._resolveReady && self._resolveReady();
        for (var i = 0; i < self._pending.length; i++) self._ws.send(self._pending[i]);
        self._pending.length = 0;
      } else if (t === 5) {             // WT_FAILED
        self._rejectReady && self._rejectReady(new Error("wt session failed"));
      }
    } catch (e) {}
  };
  self._ws.onclose = function(ev) {
    console.warn("[WT] relay websocket closed", ev && ev.code, ev && ev.reason);
    try {
      self._dgReadCtrl.close();
    } catch (e) {}
    self._rejectReady && self._rejectReady(new Error("ws closed"));
    // unexpected drop — the engine's disconnect modal renders blank (no
    // localized strings/assets for it). Show a real message and rejoin by
    // reloading the play URL; engine-initiated close() doesn't trigger it.
    if (!self._userClosed) self._rejoin();
  };
  self._rejoin = function() {
    // WebClient runs in a worker. A worker has no DOM, so it cannot render the
    // reconnect overlay or reload the page; most importantly, don't turn a
    // transport close into an uncaught ReferenceError that masks the cause.
    if (typeof document === "undefined" || !document.body) {
      console.error("[WT] unexpected relay close in worker; reconnect UI unavailable");
      return;
    }
    var ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(23,25,29,.92);color:#fff;font:600 20px/1.4 system-ui,sans-serif;text-align:center";
    var msg = document.createElement("div");
    msg.textContent = "Connection to the game was lost.";
    var sub = document.createElement("div");
    sub.style.cssText = "margin-top:10px;font:400 14px/1.4 system-ui,sans-serif;opacity:.8";
    ov.appendChild(msg); ov.appendChild(sub);
    document.body.appendChild(ov);
    var n = 5;
    var tick = function() {
      sub.textContent = n > 0 ? "Reconnecting in " + n + "…" : "Reconnecting…";
      if (n-- > 0) setTimeout(tick, 1000);
      else location.reload();
    };
    tick();
  };
  self.ready = new Promise(function(res, rej) {
    self._resolveReady = res;
    self._rejectReady = rej;
    self._ws.onerror = function() {
      rej(new Error("ws error"));
    };
  });
  self.closed = new Promise(function(res) {
    self._ws.addEventListener("close", function() {
      res({});
    });
  });
  self._fail = function(e) {
    console.error("[WsTransport] " + e);
  };
  self.datagrams = {
    readable: self._dgIn,
    writable: self._dgOut,
    // spec default is null (no expiry) — 0 means "drop instantly", which would
    // silently kill every inbound datagram (position/state plane)
    incomingMaxAge: null,
    outgoingMaxAge: null,
    maxDatagramSize: 1200
  };
  self.createBidirectionalStream = function() {
    console.log('[WT] createBidirectionalStream');
    return Promise.resolve(self._openStream());
  };
  self.createUnidirectionalStream = function() {
    console.log('[WT] createUnidirectionalStream');
    return Promise.resolve(self._openStream(true).writable);
  };
  self.close = function() {
    self._userClosed = true;
    try {
      self._ws.close();
    } catch (e) {}
  };
}
if (typeof globalThis !== "undefined") {
  var NativeWebTransport = globalThis.WebTransport;
  var __wtMeta = null, __wtMetaTried = false;
  // pthreads run from blob: URLs — location.origin/href still carry the page
  // origin inside them, but relative URLs resolve against blob: and die
  function wtBase() {
    if (typeof location === "undefined") return null;
    if (location.origin && location.origin.indexOf("http") === 0) return location.origin;
    var m = String(location.href || "").match(/(?:blob:|^)(https?:\/\/[^/]+)/i);
    return m ? m[1] : null;
  }
  function wtMeta() {
    if (!__wtMetaTried) {
      __wtMetaTried = true;
      __wtMeta = (globalThis.__WT_META) || null;
      if (!__wtMeta) {
        try {
          // engine runs in a worker — sync XHR is the only synchronous fetch
          var base = wtBase();
          if (base) {
            var x = new XMLHttpRequest();
            x.open("GET", base + "/wt-meta.json", false);
            x.send();
            if (x.status === 200) __wtMeta = JSON.parse(x.responseText);
          }
        } catch (e) {}
      }
    }
    return __wtMeta;
  }
  var __nativeWtFailed = false;
  globalThis.__WsTransport = function(url, opts) {
    var meta = wtMeta();
    if (meta && meta.hash && meta.enabled !== false && NativeWebTransport && !__nativeWtFailed) {
      try {
        var path = "/wt";
        var m = String(url || "").match(/^[a-z]+:\/\/[^/]*(\/[^ ]*)?/i);
        if (m && m[1]) path = m[1];
        // Chrome won't send cookies on a WT CONNECT — the /pg sid rides the
        // query so the front can route this session's join data
        if (meta.sid) path += (path.indexOf("?") < 0 ? "?" : "&") + "sid=" + encodeURIComponent(meta.sid);
        var host = ((wtBase() || "").match(/https?:\/\/([^:/]+)/i) || [])[1] || "localhost";
        var hash = Uint8Array.from(atob(meta.hash), function(c) { return c.charCodeAt(0); });
        console.log("[WT->native] " + url + " -> https://" + host + ":" + meta.port + path);
        var wt = new NativeWebTransport("https://" + host + ":" + meta.port + path, {
          serverCertificateHashes: [{ algorithm: "sha-256", value: hash }]
        });
        // fail-latch: if the native handshake is rejected (cert policy,
        // no QUIC/UDP egress), every later connect in this session falls
        // back to the ws relay instead of erroring out dead
        wt.ready.catch(function(e) {
          __nativeWtFailed = true;
          console.warn("[WT] native handshake failed — latching ws relay", e);
        });
        return wt;
      } catch (e) {
        __nativeWtFailed = true;
        console.warn("[WT] native transport failed, using ws relay", e);
      }
    }
    console.log("[WT->relay] " + url);
    return new WsTransport(url, opts);
  };
  // the relay now terminates WT sessions in a real aioquic client
  // (server/quic_bridge.py) — registering WebTransport is safe
  globalThis.WebTransport = globalThis.__WsTransport;
}
