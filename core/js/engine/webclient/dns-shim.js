// dns-shim.js — getaddrinfo fabricator.
//
// The engine resolves its datagram host through emscripten's getaddrinfo(),
// which in wasm-land has no real DNS. We carve a fake `struct addrinfo` into a
// fixed slot of the shared memory (GAI_ADDR) and keep it pointed at the current
// session's datagram endpoint, which the server hands us over GET /udmux
// (captured from the joinScript). If no endpoint is known yet the sockaddr is
// left zeroed — the engine's connect() then gets 0.0.0.0:0, which the socket
// pump/relay overrides with the joinScript target anyway.
//
// We grab the shared WebAssembly.Memory by hooking the Memory constructor and
// the instantiate* APIs — whichever path the engine takes to allocate it.

var GAI_ADDR = 0x10000000,
  gaiMemory = null,
  gaiTarget = {
    ip: null,
    port: 0
  };

// claim the shared memory once we see it (the 256MB growable region)
function grabSharedMemory(m) {
  if (gaiMemory || !m || !m.buffer) return;
  if (m.buffer.byteLength === 268435456) {
    gaiMemory = m;
    try {
      m.grow(1);
    } catch (e) {}
    writeFabricatedAddrInfo();
    pollDatagramEndpoint();
  } else if (m.buffer.byteLength > GAI_ADDR + 64) {
    // memory already grown by another thread; check if our page was claimed
    try {
      var v = new DataView(m.buffer);
      if (v.getUint32(GAI_ADDR + 4, true) === 2) {
        gaiMemory = m;
        pollDatagramEndpoint();
      }
    } catch (e) {}
  }
}

function scanForWasmMemory(o) {
  if (!o) return;
  if (o instanceof WebAssembly.Memory) {
    grabSharedMemory(o);
    return;
  }
  for (var k in o) {
    var v = o[k];
    if (v instanceof WebAssembly.Memory) {
      grabSharedMemory(v);
    } else if (v && typeof v === "object") {
      for (var k2 in v) {
        if (v[k2] instanceof WebAssembly.Memory) grabSharedMemory(v[k2]);
      }
    }
  }
}

try {
  var NativeWasmMemory = WebAssembly.Memory;
  WebAssembly.Memory = function(d) {
    var m = new NativeWasmMemory(d);
    grabSharedMemory(m);
    return m;
  };
  WebAssembly.Memory.prototype = NativeWasmMemory.prototype;
} catch (e) {}
["instantiate", "instantiateStreaming"].forEach(function(n) {
  var f = WebAssembly[n];
  if (!f) return;
  WebAssembly[n] = function() {
    for (var i = 0; i < arguments.length; i++) scanForWasmMemory(arguments[i]);
    var r = f.apply(this, arguments);
    if (r && r.then) r.then(function(x) {
      if (x) scanForWasmMemory(x.instance ? x.instance.exports : x.exports);
    }, function() {});
    return r;
  };
});

// lay down the fabricated addrinfo + sockaddr_in at GAI_ADDR
function writeFabricatedAddrInfo() {
  var m = gaiMemory;
  if (!m) return;
  var b = m.buffer;
  if (b.byteLength < GAI_ADDR + 64) return;
  var v = new DataView(b);
  v.setUint32(GAI_ADDR + 0, 0, true);              // ai_flags
  v.setUint32(GAI_ADDR + 4, 2, true);              // ai_family AF_INET
  v.setUint32(GAI_ADDR + 8, 2, true);              // ai_socktype SOCK_DGRAM
  v.setUint32(GAI_ADDR + 12, 17, true);            // ai_protocol UDP
  v.setUint32(GAI_ADDR + 16, 16, true);            // ai_addrlen
  v.setUint32(GAI_ADDR + 20, GAI_ADDR + 32, true); // ai_addr -> +32
  v.setUint32(GAI_ADDR + 24, 0, true);             // ai_canonname
  v.setUint32(GAI_ADDR + 28, 0, true);             // ai_next
  v.setUint16(GAI_ADDR + 32, 2, true);             // sockaddr family
  if (gaiTarget.ip) {
    var p = gaiTarget.ip.split('.').map(Number);
    if (p.length === 4) {
      v.setUint16(GAI_ADDR + 34, gaiTarget.port, false); // port BE
      for (var i = 0; i < 4; i++) v.setUint8(GAI_ADDR + 36 + i, p[i] & 255); // addr BE
      for (var i = 0; i < 8; i++) v.setUint8(GAI_ADDR + 40 + i, 0);
    }
  }
}

// keep gaiTarget synced with the server-side session endpoint
function pollDatagramEndpoint() {
  try {
    fetch("/udmux").then(function(r) {
      return r.json();
    }).then(function(j) {
      if (j && j.ip) {
        var p = j.port || j.wtPort || 0;
        if (j.ip !== gaiTarget.ip || p !== gaiTarget.port) {
          gaiTarget = {
            ip: j.ip,
            port: p
          };
          writeFabricatedAddrInfo();
        }
      }
    }).catch(function() {}).finally(function() {
      setTimeout(pollDatagramEndpoint, 800);
    });
  } catch (e) {
    setTimeout(pollDatagramEndpoint, 1500);
  }
}
