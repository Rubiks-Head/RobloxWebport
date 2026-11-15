  // ── boot: tab lock -> flags/locales/metadata -> launch -> join ────────────
  let bootPhase;   // LOG.phase handle — closed when launchEngine returns

  // launch the engine, then resolve when it reports gameExit
  async function runUntilExit(args) {
    let settled = false;
    const exit = new Promise(resolve => {
      window.__resolveGameExit = r => { if (!settled) { settled = true; resolve(r); } };
    });
    await launchEngine(
      args.canvas, args.robloxBaseUrl, args.websiteBaseUrl, args.authCookie,
      args.accountLocales, args.flags, args.enableProxy, args.placeId,
      args.assetMetadata, args.channel);
    // the join attempt is now underway inside the engine — watch the status
    // feed; the first join/gui-service event settles the phase (fail or pass)
    const joinPhase = LOG.phase('Joining');
    const prevStatus = window.__onEngineLoadingStatus;
    let joinSettled = false;
    window.__onEngineLoadingStatus = e => {
      try { prevStatus && prevStatus(e); } finally {
        if (!joinSettled && e && (e.source === 'join' || e.source === 'gui-service')) {
          joinSettled = true;
          joinPhase();                                // "Joining took xx ms."
          if (e.kind !== 'failure') window.__renderPhase = LOG.phase('Rendering');
        }
        // a later failure cancels an already-open Rendering phase
        if (joinSettled && e && e.kind === 'failure' && window.__renderPhase) {
          window.__renderPhase(); window.__renderPhase = null;
        }
      }
    };
    return exit;
  }

  (async () => {
    // one engine per browser — bail if another tab already holds the lock
    const lock = await acquireTabLock();
    if (lock.kind === "contended") { showTabContended(); return; }
    if (lock.kind === "unavailable")
      LOG.warn(`Tab mutex unavailable; continuing without cross-tab coordination`);
    else LOG.info(`Tab lock acquired (${lock.mechanism})`);

    let lastBeat = performance.now(), beats = 0;
    setInterval(() => {
      const now = performance.now();
      console.log(`[MAIN] heartbeat #${++beats} t=${now.toFixed(1)}ms delta=${(now - lastBeat).toFixed(1)}ms`);
      lastBeat = now;
    }, 500);

    window.addEventListener("unhandledrejection", e => {
      const reason = e.reason;
      console.error("[UNHANDLED-REJECTION]", reason);
      if (reason?.stack) console.error("[UNHANDLED-REJECTION stack]", reason.stack);
      if (reason && typeof reason == "object")
        for (const k of Object.getOwnPropertyNames(reason)) console.error("  ." + k + " =", reason[k]);
      window.Module?._web_client_record_browser_event?.(BROWSER_EVENT.unhandledRejection);
    });
    window.addEventListener("error", e => {
      console.error("[WINDOW-ERROR]", e.message, `${e.filename}:${e.lineno}:${e.colno}`);
      if (e.error?.stack) console.error("[WINDOW-ERROR stack]", e.error.stack);
      window.Module?._web_client_record_browser_event?.(BROWSER_EVENT.jsError);
    });

    const params = new URLSearchParams(window.location.search);
    const hostname = window.location.hostname;
    // the real upstream domain behaves like prod (auth-gated + redirect when no place)
    const _up = window.UPSTREAM || {};
    const isProdDomain = hostname === _up.domain || hostname.endsWith("." + _up.domain) || (_up.labs && hostname.endsWith("." + _up.labs));
    const websiteHost = SERVER_ENVIRONMENTS[serverName].website;
    // host the engine derives <svc>.* API hosts from — first label is all that
    // matters to apiUrl, so www.<our host> is a perfectly good base.
    const robloxBaseUrl = devSettings?.baseUrl ?? `www.${location.host}`;
    const rawPlaceId = params.has("placeId") ? Number(params.get("placeId")) : undefined;
    const placeId = rawPlaceId !== undefined && Number.isSafeInteger(rawPlaceId) && rawPlaceId > 0 ? rawPlaceId : undefined;
    if (isProdDomain && !placeId) {
      window.location.replace(`https://${websiteHost}.${_up.domain}`);
      return;
    }

    loadingScreen.prepare(placeId);
    loadingScreen.setStatus(placeId ? "Preparing experience…" : "Preparing Roblox…");
    if (placeId) loadingScreen.loadExperience(placeId);
    bootPhase = LOG.phase('BootStraping');           // app bootstrap steps collapse under this
    const channel = loaderContext.channel;
    LOG.info('Fetching application flags…');
    const flagsPromise = fetchApplicationFlags(serverName, channel);
    window.__onDefaultLoadingScreenRemoved = () => loadingScreen.dismissAfterRenderedFrame();

    const canvas = document.getElementById("canvas");

    LOG.info('Prefetching engine wasm…');
    wasmModulePromise = prefetchWasmModule(fileLocations["WebClient.wasm"]);
    wasmModulePromise.catch(e => {
      console.error("[wasm] engine load failed", e);
      loadingScreen.showFailure("Failed to load Roblox. Please reload the page.");
    });

    // pull in the emscripten glue (defines createWebClient)
    LOG.info('Loading WebClient.js…');
    await (src => new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.crossOrigin = "anonymous";
      s.src = src;
      s.onload = () => resolve(s);
      s.onerror = () => reject(new Error(`Script load error for ${src}`));
      document.head.appendChild(s);
    }))(fileUrl("WebClient.js"));

    // auth: real session lives server-side (cnfg.json injects the cookie on
    // upstream calls). On prod domains we'd gate on users/authenticated; on
    // localhost there is nothing to check — proceed with an empty client cookie.
    let authCookie = "";
    if (isProdDomain) {
      try {
        if (!(await fetch(apiUrl("users", "/v1/users/authenticated"), { credentials: "include" })).ok) {
          console.log("[Auth] No active session, redirecting to login");
          window.location.href = `https://${websiteHost}.${_up.domain}/login`;
          return;
        }
      } catch (e) {
        console.warn("[Auth] Auth check failed, proceeding anyway:", e);
      }
    } else if (devSettings) {
      authCookie = devSettings.authCookie || "";
    }

    LOG.info('Fetching account locales + asset metadata…');
    const localesPromise = fetchAccountLocales();
    const [flags, assetMetadata, accountLocales] = await Promise.all([
      flagsPromise,
      fetch(fileUrl("WebClient.metadata.json")).then(r => r.json()),
      localesPromise
    ]);
    LOG.info(`Ready — ${Object.keys(flags.applicationSettings || {}).length} flags, ${assetMetadata.length} assets, locales ${accountLocales.robloxLocaleId}/${accountLocales.gameLocaleId}`);

    if (devSettings) Object.assign(flags.applicationSettings, devSettings.getFlagOverrides());
    if (!isAndroidDevice()) flags.applicationSettings.FFlagHideCursorForNonMouseUsers = "False";

    // prefetch engine assets during the loading screen so rbx_fs reads hit
    // memory instead of a network stall — DISABLED by default (baseline):
    // front-loading ~50MB into the wasm heap before join skews the residency
    // measurement and competes with join-time fetches. rh.prefetch=auto /
    // =all re-enables (filtered / everything).
    const prefetchMode = localStorage.getItem("rh.prefetch") ?? "0";
    const SKIP = a => /webgpu/i.test(a.path) || a.size > 8 * 1024 * 1024;
    // priority: first-render blockers (fonts before text, shaders before
    // pixels) go to the front of the queue, the long tail follows
    const prio = a => /fonts?\//i.test(a.path) ? 0
      : /shader/i.test(a.path) ? 1
      : /textures?\//i.test(a.path) ? 2 : 3;
    const prefetchList = (prefetchMode === "all" ? assetMetadata
      : prefetchMode === "0" ? []
      : assetMetadata.filter(a => !SKIP(a)))
      .slice().sort((a, b) => prio(a) - prio(b));
    if (prefetchList.length) {
      const prefetched = window.__prefetchedAssets = new Map;
      const prefetchAll = new Promise(done => {
        let inflight = 0, next = 0, finished = 0;
        const pump = () => {
          for (; inflight < 20 && next < prefetchList.length;) {
            inflight++;
            const asset = prefetchList[next++];
            fetch(`${engineBase}${asset.path}`)
              .then(r => r.ok ? r.arrayBuffer() : null)
              .then(buf => { if (buf) prefetched.set(asset.path, buf); })
              .finally(() => { inflight--; ++finished === prefetchList.length ? done() : pump(); });
          }
        };
        pump();
      }).then(n => LOG.info(`Asset prefetch complete: ${prefetched.size}/${prefetchList.length} (${assetMetadata.length - prefetchList.length} skipped)`));
      // don't block boot on the full list — wasm compile/instantiate takes
      // seconds anyway, so give prefetch a 3s head start and let the rest
      // keep warming the server cache during join
      await Promise.race([prefetchAll, new Promise(r => setTimeout(r, 3000))]);
    } else LOG.info(`No prefetch — ${assetMetadata.length} assets fetch on-demand`);

    bootPhase && bootPhase();                         // "BootStraping took xx ms. Moving on"

    if (placeId) {
      const result = await runUntilExit({
        canvas,
        robloxBaseUrl,
        websiteBaseUrl: pageOrigin,
        authCookie,
        accountLocales,
        flags,
        enableProxy: true,
        placeId,
        assetMetadata,
        channel
      });
      if (window.opener) window.opener.postMessage({ type: "gameExit", ...result }, "*");
      if (result.reason === "leave" || result.reason === "native_exit") {
        loadingScreen.dismiss();
        setTimeout(() => { window.close(); window.location.replace(window.__leaveTarget ? window.__leaveTarget() : "about:blank"); }, 50);
      } else if (result.reason !== "join_failed") showExitScreen(result);
    } else {
      await launchEngine(canvas, robloxBaseUrl, pageOrigin, authCookie, accountLocales, flags, true, placeId, assetMetadata, channel);
      loadingScreen.dismiss();
    }
  })().catch(e => {
    LOG.raw("[WasmPlayer] startup failed:", e);
    loadingScreen.showFailure("Unable to start Roblox. Check the console and reload.");
  });
})();

;
! function() {
  try {
    var g = globalThis,
      s = new g.Error().stack;
    s && ((g._sentryDebugIds = g._sentryDebugIds || {})[s] = "5d2f23d7-9443-5bc6-b064-05cb09da01cd")
  } catch (e) {}
}();
//# debugId=5d2f23d7-9443-5bc6-b064-05cb09da01cd
