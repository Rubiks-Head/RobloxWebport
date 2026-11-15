  // ── engine module config + launch ─────────────────────────────────────────

  function isAndroidDevice() {
    return navigator.userAgent.includes("Android");
  }

  // mobile viewport vs fullscreen-canvas class (set once at eval)
  if (!isAndroidDevice()) document.querySelector("#canvas")?.classList.add("fullscreencanvas");
  else {
    const meta = document.createElement("meta");
    meta.name = "viewport";
    meta.content = "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0";
    document.getElementsByTagName("head")[0].appendChild(meta);
    document.querySelector("#canvas")?.classList.add("mobilecanvas");
  }

  // loader context produced by WasmLoader.js (script must load after it)
  var loaderContext = (() => {
    const ctx = window.__wasmLoaderContext;
    if (!ctx) throw new Error("window.__wasmLoaderContext is missing; WasmPlayer.js must be loaded by WasmLoader.js");
    return ctx;
  })();
  var engineBase = loaderContext.engineBase;
  var serverName = isServerName(loaderContext.server) ? loaderContext.server : "prod";
  var devSettings = window.__wasmDevSettings;
  var pageOrigin = window.location.origin;

  // browserTrackerId cookie (analytics identity the engine reports with)
  var BROWSER_TRACKER_COOKIE = "RBXEventTrackerV2";
  var browserTrackerId = (() => {
    const raw = `; ${document.cookie}`.split(`; ${BROWSER_TRACKER_COOKIE}=`);
    const cookie = raw.length === 2 ? raw.pop()?.split(";").shift() ?? null : null;
    return cookie == null ? null : new URLSearchParams(cookie).get("browserid");
  })();

  console.log(`Loading WasmPlayer: Engine Base URL is ${engineBase}, channel ${loaderContext.channel ?? "<none>"}`);
  console.log(`Loading WasmPlayer: Page Base URL is ${pageOrigin}`);

  // engine file map — everything lives next to this bundle under engineBase
  var webClientUrl = `${engineBase}/WebClient.js`;
  var workerStubUrl = (() => {
    const u = new URL(loaderContext.workerStubUrl ?? `${engineBase}/stub.js`);
    u.searchParams.set("src", webClientUrl);
    return u.href;
  })();
  var fileLocations = {
    "WebClient.js": webClientUrl,
    "WebClient.wasm": `${engineBase}/WebClient.wasm`,
    "WebClient.metadata.json": `${engineBase}/WebClient.metadata.json`,
    "audio-processor-fast.js": `${engineBase}/audio-processor-fast.js`,
    "stub.js": workerStubUrl
  };
  // same-origin engine -> the worker IS WebClient.js (emscripten importScripts)
  function fileUrl(name) {
    const origin = new URL(webClientUrl).origin;
    if (name == "stub.js" && pageOrigin == origin) {
      console.log("Redirecting WebWorker to primary script");
      name = "WebClient.js";
    }
    console.log(`${name} ${fileLocations[name]}`);
    return fileLocations[name];
  }
  var wasmModulePromise = null;

  // streaming wasm fetch with download progress on the loading screen
  function prefetchWasmModule(url) {
    return (async () => {
      const resp = await fetch(url);
      if (!resp.ok || !resp.body) throw new Error(`WebClient.wasm fetch failed: HTTP ${resp.status}`);
      const total = resp.headers.get("Content-Encoding") ? 0 : Number(resp.headers.get("Content-Length")) || 0;
      let loaded = 0, done = false, raf = 0;
      const pump = () => {
        if (done) return;
        if (total && loaded > total) total = 0;
        loadingScreen.setDownloadProgress(loaded, total);
        raf = requestAnimationFrame(pump);
      };
      raf = requestAnimationFrame(pump);
      // count progress on a CLONE — the original response must go to
      // compileStreaming verbatim: a synthetic Response carries no URL, so
      // Chrome's compiled-wasm code cache (keyed by response URL+etag) missed
      // every load and the 101MB module re-downloaded AND recompiled cold.
      const counter = resp.clone();
      (async () => {
        try {
          const rd = counter.body.getReader();
          for (;;) { const { value, done: d } = await rd.read(); if (d) break; loaded += value.length; }
        } catch (e) {}
      })();
      try {
        return await WebAssembly.compileStreaming(resp);
      } finally {
        done = true;
        cancelAnimationFrame(raf);
        loadingScreen.clearStatus();
      }
    })();
  }

  // launchEngine — build the emscripten Module, spawn createWebClient, return
  // the running module. Resolves when the engine is up; the caller awaits the
  // separate gameExit promise for shutdown.
  async function launchEngine(canvas, robloxBaseUrl, websiteBaseUrl, authCookie,
                              accountLocales, flags, enableProxy, placeId,
                              assetMetadata, channel) {
    const engPhase = LOG.phase('Launching engine');   // instantiate + runtime init collapse here
    // dev-only info spans (optional DOM — absent on the minimal page)
    const serverEl = document.getElementById("server");
    const proxyEl = document.getElementById("proxyenabled");
    if (serverEl) serverEl.innerText = robloxBaseUrl;
    if (proxyEl) proxyEl.innerText = enableProxy ? "Enabled" : "Disabled";

    const sessionJson = {
      WebLogin: "2",
      RobloxLocaleId: accountLocales.robloxLocaleId,
      GameLocaleId: accountLocales.gameLocaleId
    };
    // wasm heap size — the binary's link-time layout is the hard floor:
    // data segments reach 0x7ff4xxxx = 2047.25MB, so anything under 32757
    // pages fails instantiate ("data segment is out of bounds"). Above the
    // floor the heap scales to the device: 4GB on >=8GB desktops (a 4GB SAB
    // *reservation* is cheap — pages commit on touch — but the allocation
    // itself can fail on low-end mobile), the 2GB floor on small devices
    // where committing more can't help anyway. Priority:
    //   ?wmem=<MB>/rh.wmem (explicit) > deviceMemory probe > floor.
    // The server flag is the ceiling, not the size. Reported memoryMB
    // tracks memoryPages below, so pressure triggers stay proportional.
    const wmemOverride = parseInt(new URLSearchParams(location.search).get("wmem")
      || localStorage.getItem("rh.wmem") || "");
    const flagCeil = parseInt(flags.applicationSettings.FIntWasmMemoryPages ?? "65536");
    const devGB = navigator.deviceMemory || 0;
    const mobileUA = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    // wasm variants — the binary pins its ABI/stack/gate region at a fixed
    // high address, so each tier needs a heap above that floor:
    //   std  abi 0x7ff40000 → 32768p (2GB)   WebClient.wasm
    //   low  abi 0x3ff40000 → 16384p (1GB)   WebClient.lowmem.wasm  ?lowmem
    //   min  abi 0x2ff40000 → 12304p (769MB) WebClient.minmem.wasm  ?minmem
    // Every variant also runs on a BIGGER heap; the tier picks the smallest
    // binary whose floor fits the requested pages, explicit flags pin it.
    // NB: shared wasm memory commits eagerly — a 4GB default froze page
    // load in testing. Keep the proven 2GB floor for std.
    const qs = new URLSearchParams(location.search);
    const reqPages = Number.isFinite(wmemOverride) && wmemOverride > 0 ? wmemOverride * 16 : 0;
    const TIER = { std: { pages: 32768, file: "" }, low: { pages: 16384, file: "lowmem" }, min: { pages: 12304, file: "minmem" } };
    const memTier =
      qs.has("minmem") || localStorage.getItem("rh.minmem") === "1" || flags.applicationSettings.DFFlagMinmemWasm === 'True' ? "min"
      : qs.has("lowmem") || localStorage.getItem("rh.lowmem") === "1" || flags.applicationSettings.DFFlagLowmemWasm === 'True' ? "low"
      : reqPages && reqPages < 16384 ? "min"
      : reqPages && reqPages < 32757 ? "low"
      : "std";
    const memoryPages = Math.max(TIER[memTier].pages === 32768 ? 16384 : TIER[memTier].pages,
      Math.min(flagCeil, reqPages || TIER[memTier].pages));
    if (TIER[memTier].file) {
      fileLocations["WebClient.wasm"] = `${engineBase}/WebClient.${TIER[memTier].file}.wasm`;
      wasmModulePromise = prefetchWasmModule(fileLocations["WebClient.wasm"]);
    }
    const memoryBytes = memoryPages * (64 * 1024);
    LOG.info(`Shared memory: ${memoryPages} pages (${Math.round(memoryBytes / 1048576)}MB)`);
    const wasmMemory = new WebAssembly.Memory({ initial: memoryPages, maximum: memoryPages, shared: true });
    const hostInfo = await hostInfoPromise;
    // reported memory = the REAL heap, single source of truth — the engine's
    // pressure triggers (fractions of memoryMB) must shed just under the
    // actual cap. ~1.25x the heap lands the 75% trigger just under it.
    // host-info marks explicit overrides (rh.memmb / rh.graphics=good) so
    // they win; anything else would desync from memoryPages (the old
    // Math.max reported 2.5GB on the 1GB lowmem heap).
    if (!hostInfo._memExplicit)
      hostInfo.memoryMB = Math.round(memoryPages / 16 * 1.25);
    const t0 = performance.now();
    LOG.info('Creating web client…');
    console.log(`[WASM-TIMING] createWebClient starting at ${t0.toFixed(1)}ms from page load`);

    var mod = {
      wasmMemory,
      hostInfo,
      locateFile: fileUrl,
      mainScriptUrlOrBlob: fileUrl("stub.js"),
      instantiateWasm: (imports, done) => (
        (wasmModulePromise ?? prefetchWasmModule(fileLocations["WebClient.wasm"]))
          .then(m => { LOG.info('Instantiating WebClient.wasm…'); return WebAssembly.instantiate(m, imports).then(inst => { LOG.info('Wasm instantiated'); done(inst, m); }); })
          .catch(e => {
            LOG.raw("[wasm] instantiate failed", e, e?.message, e?.name);
            loadingScreen.showFailure("Unable to start Roblox. Check the console and reload.");
          }), {}),
      audioProcessorUrl: fileUrl("audio-processor-fast.js"),
      encoder: new TextEncoder,
      decoder: new TextDecoder,
      fontMap: {},
      preInit: [function () {
        const t = performance.now();
        window.__wasmPreInitTime = t;
        console.log(`[WASM-TIMING] preInit (before global ctors): +${(t - t0).toFixed(1)}ms`);
      }],
      preRun: [function () {
        const t = performance.now();
        console.log(`[WASM-TIMING] preRun (before main): +${(t - t0).toFixed(1)}ms`);
      }],

      onRuntimeInitialized: function () {
        const t = performance.now();
        const preInit = window.__wasmPreInitTime ?? t0;
        console.log(`[WASM-TIMING] onRuntimeInitialized: +${(t - t0).toFixed(1)}ms total, ${(t - preInit).toFixed(1)}ms since preInit (includes global ctors)`);

        // 261 trap: the in-game disconnect dialog is engine-drawn and never
        // hits the loading-status hook — watch the FLog ring for the death
        // line instead; first match POSTs the whole tail once.
        let __engxScan = 0, __engxDumped = false;
        const __engxTimer = setInterval(() => {
          const x = window.__engx;
          if (__engxDumped) { clearInterval(__engxTimer); return; }
          if (!x || !x.length) return;
          for (; __engxScan < x.length; __engxScan++) {
            if (/disconnect|error code|stream.*error|lost connection|kick/i.test(String(x[__engxScan]))) {
              __engxDumped = true;
              fetch("/__englog", { method: "POST", body: x.join("\n") }).catch(() => {});
              clearInterval(__engxTimer);
              break;
            }
          }
        }, 1500);
        addEventListener("pagehide", () => {
          const x = window.__engx;
          if (x && x.length) try { navigator.sendBeacon("/__englog", new Blob([x.join("\n")], { type: "text/plain" })); } catch (_) {}
        });
        // txprobe: does the engine keep HANDING writes to the WT layer when
        // the wire goes quiet? dgIn/stIn = calls into glue; *Pend = writes
        // whose promise never settled (flow-control or transport wedge).
        setInterval(() => {
          const p = window.__txp;
          if (p) fetch("/__txp", { method: "POST", body: `t=${(performance.now() / 1000) | 0} dgIn=${p.dgIn} dgPend=${p.dgPend} stIn=${p.stIn} stPend=${p.stPend}` }).catch(() => {});
        }, 5000);

        const addFile = mod.cwrap("rbx_fs_add_file", "number", ["string", "array", "number"]);
        const registerAsset = mod.cwrap("rbx_fs_register_asset", "number", ["string", "number"]);
        mod.cwrap("rbx_fs_set_base_url", null, ["string"])(engineBase);
        for (const asset of assetMetadata) registerAsset(asset.path, asset.size);
        LOG.info(`Runtime initialized — registered ${assetMetadata.length} asset metadata entries`);

        const prefetched = window.__prefetchedAssets;
        if (prefetched) {
          const preload = mod.cwrap("rbx_fs_preload_asset", "number", ["string", "number", "number"]);
          for (const [path, buf] of prefetched) {
            const bytes = new Uint8Array(buf);
            const ptr = mod._malloc(bytes.length);
            if (!ptr) continue;
            mod.HEAPU8.set(bytes, ptr);
            // ownership: rbx_fs_preload_asset stores ptr+len into the asset
            // table (no copy — verified in f286.wat) and returns 0 on a
            // registered path. -1 = not registered, nothing retained → the
            // malloc is ours to free or it leaks.
            if (preload(path, ptr, bytes.length) !== 0) mod._free(ptr);
          }
          console.log(`Preloaded ${prefetched.size} assets into VFS`);
          window.__prefetchedAssets = null;
        }

        const writeJson = (path, json) => { const b = mod.encoder.encode(json); addFile(path, b, b.length); };
        // Chrome-style host-resolver rules — the engine's internal resolver
        // reads this file. Minted qdmux names resolve to loopback; the socket
        // pump translates the 127.0.0.1 ring peer to the real UDMux endpoint.
        const rules = `MAP *.qdmux.${((typeof globalThis !== "undefined" && globalThis.UPSTREAM) || {}).domain || "local"} 127.0.0.1,MAP localhost 127.0.0.1`;
        for (const p of ['resolver-rules.txt', '/resolver-rules.txt', 'appData/resolver-rules.txt']) {
          const rb = mod.encoder.encode(rules);
          addFile(p, rb, rb.length);
        }
        const storage = JSON.stringify(sessionJson);
        writeJson("/appData/LocalStorage/appStorage.json", storage);
        writeJson(`/appData/LocalStorage/${location.hostname}_appStorage.json`, storage);
        mod.set_roblox_base_url(`https://${robloxBaseUrl}/`);
        if (channel !== null) {
          mod.set_channel(channel);
          console.log(`[WasmPlayer] Engine channel set to "${channel || "production"}"`);
        }
        mod.set_pretend_platform(isAndroidDevice() ? "mobile" : "desktop");
        flags.applicationSettings.BaseUrl = `https://${robloxBaseUrl}/`;
        LOG.info(`Feeding session — flags, locales, ${channel || 'production'} channel${placeId ? `, place ${placeId}` : ''}`);
        mod.set_preloaded_flags(JSON.stringify(flags));
        loadCachedIxpSettings(mod);
        mod.set_account_locales(accountLocales.robloxLocaleId, accountLocales.gameLocaleId);
        if (placeId) mod.set_place_id(placeId);
        mod.set_browser_tracker_id(browserTrackerId ?? "");

        const inputContainer = document.getElementById("input-container");
        const textArea = document.getElementById("input-textarea");
        const inputEl = document.getElementById("input-input");
        if (textArea && inputEl) {
          const onTextChanged = mod.cwrap("on_virtual_text_changed", null, ["number", "number", "number"]);
          const onReturnPressed = mod.cwrap("on_return_pressed", null, []);
          const sync = e => {
            const el = e.target;
            const value = el.value;
            const selStart = el.selectionStart ?? 0;
            const selEnd = el.selectionEnd ?? 0;
            const cursorBytes = mod.encoder.encode(value.substring(0, selStart)).length;
            const selectBytes = selStart == selEnd ? cursorBytes : mod.encoder.encode(value.substring(0, selEnd)).length;
            mod.pendingBytes = mod.encoder.encode(value);
            onTextChanged(mod.pendingBytes.length, cursorBytes, selectBytes);
          };
          textArea.addEventListener("input", sync);
          textArea.addEventListener("click", sync);
          inputEl.addEventListener("input", sync);
          inputEl.addEventListener("click", sync);
          inputEl.addEventListener("keydown", e => {
            if (e.key === "Enter") { e.preventDefault(); onReturnPressed(); }
          });
          if (inputContainer !== null) mod.inputContainer = inputContainer;
          mod.textAreaElement = textArea;
          mod.inputElement = inputEl;
        } else console.error('Could not find element with id "input-textarea" or "input-input"');

        document.addEventListener("fullscreenchange", () => {
          mod.notify_fullscreen_change(!!document.fullscreenElement);
        });

        // F1 -> our stats overlay (stats-overlay.js owns the key binding).

        // stuck-key watchdog: the engine's key handlers live on the canvas,
        // so a keyup landing elsewhere (chat input, other window, blur)
        // leaves the key held -> character keeps walking on its own.
        // mirror held keys, forward stray keyups to the canvas, and flush
        // everything on focus loss.
        const heldKeys = new Set();
        const synthKey = (src, type) => {
          const ev = new KeyboardEvent(type, {
            bubbles: true, cancelable: true, key: src.key, code: src.code,
            location: src.location || 0, repeat: false,
            ctrlKey: !!src.ctrlKey, shiftKey: !!src.shiftKey, altKey: !!src.altKey, metaKey: !!src.metaKey,
          });
          Object.defineProperty(ev, 'keyCode', { value: src.keyCode || 0 });
          Object.defineProperty(ev, 'which', { value: src.which || src.keyCode || 0 });
          canvas.dispatchEvent(ev);
        };
        window.addEventListener('keydown', e => heldKeys.add(e.code), true);
        window.addEventListener('keyup', e => {
          heldKeys.delete(e.code);
          if (e.target !== canvas && !e.__rhSynth) synthKey(e, 'keyup');
        }, true);
        const flushKeys = () => {
          for (const code of heldKeys) synthKey({ key: code, code, keyCode: 0, location: 0 }, 'keyup');
          heldKeys.clear();
        };
        window.addEventListener('blur', flushKeys);
        document.addEventListener('visibilitychange', () => { if (document.hidden) flushKeys(); });

        function watchPixelRatio() {
          const mq = `(resolution: ${window.devicePixelRatio}dppx)`;
          window.matchMedia(mq).addEventListener("change", function () {
            console.log("pixel ratio change observed");
            mod.update_pixel_ratio(mod.getEffectiveDevicePixelRatio());
            watchPixelRatio();
          }, { once: true });
        }
        watchPixelRatio();

        if ("virtualKeyboard" in navigator) {
          const vk = navigator.virtualKeyboard;
          const updateBounds = mod.cwrap("update_virtual_keyboard_bounds", null, ["number", "number", "number"]);
          vk.overlaysContent = true;
          vk.addEventListener("geometrychange", e => {
            const { left, bottom, width, height } = e.target.boundingRect;
            updateBounds(left, bottom - height, width, height);
          });
        }
      },

      print: (...a) => { console.log(a.join(" ")); },

      canvas: (canvas.addEventListener("webglcontextlost", e => {
        alert("WebGL context lost. You will need to reload the page.");
        e.preventDefault();
      }, false), canvas),

      setStatus: text => {
        if (!(mod.setStatus.last ?? (mod.setStatus.last = { time: Date.now(), text: "" }))) return;
        if (text === mod.setStatus.last.text) return;
        const progress = text.match(/([^(]+)\((\d+(\.\d+)?)\/(\d+)\)/);
        const now = Date.now();
        if (progress && now - mod.setStatus.last.time < 30) return;
        mod.setStatus.last.time = now;
        mod.setStatus.last.text = text;
        if (progress) {
          const label = progress[1].trim();
          const done = Number(progress[2]);
          const total = Number(progress[4]);
          loadingScreen.setStatus(total > 0 ? `${label} ${Math.round(done / total * 100)}%` : label);
        } else if (text) loadingScreen.setStatus(text);
        else loadingScreen.clearStatus();
      },

      totalDependencies: 0,
      monitorRunDependencies: n => {
        mod.totalDependencies = Math.max(mod.totalDependencies, n);
        mod.setStatus(n ? "Preparing... (" + (mod.totalDependencies - n) + "/" + mod.totalDependencies + ")" : "All downloads complete.");
      },
      logReadFiles: true,
      saveIxpSettings: persistIxpSettings
    };

    // audio unlock: first gesture resumes the engine's AudioContext
    const gestureEvents = ["pointerdown", "keydown", "touchstart"];
    const unlockAudio = () => {
      for (const e of gestureEvents) window.removeEventListener(e, unlockAudio, true);
      try { mod.resume_audio(); } catch {}
    };
    for (const e of gestureEvents) window.addEventListener(e, unlockAudio, { capture: true, passive: true });

    const isMobile = navigator.userAgentData?.mobile ?? /Mobi|Android/i.test(navigator.userAgent);
    const renderScale = parseFloat(new URLSearchParams(window.location.search).get("renderScale") || "");
    const hasScale = Number.isFinite(renderScale) && renderScale > 0;
    const scale = hasScale ? renderScale : 1;
    const maxDpr = hasScale ? 1 / 0 : isMobile ? 1.31 : 1 / 0;
    mod.getEffectiveDevicePixelRatio = () => Math.min(window.devicePixelRatio || 1, maxDpr) * scale;
    mod.isMobileDevice = () => isMobile;

    let pendingResize = false;
    new ResizeObserver(() => { pendingResize = true; }).observe(canvas);
    mod.applyPendingResize = () => {
      if (!pendingResize) return false;
      pendingResize = false;
      const dpr = mod.getEffectiveDevicePixelRatio();
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      return true;
    };

    window.onerror = (m, s, l, c, e) => {
      LOG.raw("[wasm] window.onerror", m, s, l, c, e?.stack || e);
      loadingScreen.showFailure("Roblox encountered a problem. Check the console and reload.");
      mod.setStatus = s => { if (s) LOG.raw("[post-exception status] " + s); };
    };
    window.Module = mod;

    const engineJsonData = await fetch('/webclient/engine.json?variant=' + memTier).then(r => r.json()).catch(() => null);
    // the shared-mem socket ABI + gate mailbox layouts — engine reads this at
    // init to find where to write datagrams and poll the gate verdict
    if (engineJsonData) mod.engineJson = JSON.stringify(engineJsonData);
    const engine = await createWebClient(mod);
    console.log(`[WASM-TIMING] createWebClient resolved: +${(performance.now() - t0).toFixed(1)}ms total`);

    // datagram transport: the engine's RakNet UDP goes through the shared-mem
    // socket ring (abi layout in engine.json) -> we pump it to /udp-relay.
    // joinScript comes back from /join (pristine copy — the client-facing one
    // gets NetStack fields stripped). gate mailbox gets the verdict token.
    try {
      const drv = await import('/webclient/driver.js');
      let jsCache = null;
      let joinRequest = null;
      let joinRetryAt = 0;
      let joinFailures = 0;
      const pullJoin = () => {
        if (jsCache || joinRequest || Date.now() < joinRetryAt) return joinRequest;
        joinRequest = fetch('/join', { cache: 'no-store' })
          .then(r => {
            if (!r.ok) throw new Error(`/join returned ${r.status}`);
            return r.json();
          })
          .then(j => {
            if (!j || !Array.isArray(j.UdmuxEndpoints) || !j.UdmuxEndpoints.length) {
              throw new Error('/join has no UdmuxEndpoints yet');
            }
            jsCache = j;
            joinFailures = 0;
            return j;
          })
          .catch(() => {
            // The engine's pump polls every few milliseconds. Keep an unavailable
            // /join endpoint from creating a request storm while still allowing
            // the joinScript to arrive after the pump has started.
            joinFailures++;
            joinRetryAt = Date.now() + Math.min(5000, 250 * (2 ** Math.min(joinFailures - 1, 5)));
            return null;
          })
          .finally(() => { joinRequest = null; });
        return joinRequest;
      };
      pullJoin();
      window.__rhMem = wasmMemory;   // stats-overlay reads engine counters via SAB
      drv.startSocketPump({
        memory: wasmMemory, abi: engineJsonData.abi, gate: engineJsonData.gate && engineJsonData.gate.abi, gateToken: engineJsonData.gate && engineJsonData.gate.token || 'ok',
        joinScript: () => { if (!jsCache) pullJoin(); return jsCache; },
        trace: s => LOG.info('[pump] ' + s),
      });
      LOG.info('Socket pump started — abi ring + gate mailbox live');
    } catch (e) { LOG.warn('socket pump failed: ' + (e.message || e)); }
    engPhase();                                       // "Launching engine took xx ms. Moving on"
    return engine;
  }
