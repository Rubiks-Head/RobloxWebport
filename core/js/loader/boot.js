  // WasmLoader.ts — resolve the loader context, then inject WasmPlayer.js.
  var PLAYER_SCRIPT = "WasmPlayer.js";
  var loaderBase = (() => {
    const tag = document.currentScript;
    if (tag instanceof HTMLScriptElement)
      return new URL(".", tag.src).href.replace(/\/$/, "");
    throw new Error("Not running from an imported script!");
  })();

  // Resolve which engine build to load. Local engine (useCdnBinary:false or
  // CDN resolution failure) -> the loader's own directory.
  async function resolveEngine(host, server) {
    if (host.useCdnBinary === false) {
      console.log(`[WasmLoader] CDN binary disabled — loading engine from local base: ${loaderBase}`);
      return { engineBase: loaderBase, channel: null };
    }
    const userChannel = await resolveUserChannel(server);
    let channel = userChannel.channelName;
    let versionedBase = host.engineVersion !== undefined
      ? engineBaseForUpload(server, host.engineVersion)
      : await resolveEngineBase(server, userChannel);
    if (versionedBase === null && channel) {
      console.warn(`[WasmLoader] No engine version resolved for channel "${channel}" — falling back to production binary and flags`);
      channel = "";
      versionedBase = await resolveEngineBase(server, { channelName: "", token: "" });
    }
    if (versionedBase === null) {
      console.log(`[WasmLoader] CDN resolution failed — loading engine from local base: ${loaderBase}`);
      return { engineBase: loaderBase, channel };
    }
    console.log(`[WasmLoader] Engine base ${versionedBase}${host.engineVersion !== undefined ? " (pinned)" : ""}`);
    return { engineBase: versionedBase, channel };
  }

  async function resolveLoaderContext() {
    const host = window.robloxWasmHostConfig;
    if (!host)
      throw new Error("window.robloxWasmHostConfig must be set before WasmLoader.js runs");
    let server = "prod";
    if (isServerName(host.server)) server = host.server;
    else console.error(`[WasmLoader] Unknown server "${String(host.server)}" in robloxWasmHostConfig; using prod`);
    const { engineBase, channel } = await resolveEngine(host, server);
    return {
      engineBase,
      channel,
      server,
      ...(host.workerStubUrl !== undefined
        ? { workerStubUrl: new URL(host.workerStubUrl, location.href).href }
        : {})
    };
  }

  function showEngineLoadError() {
    const message = "Failed to load engine. Please reload the page.";
    const status = document.getElementById("status");
    if (status) status.textContent = message;
    const overlay = document.getElementById("loading-overlay");
    const errorPanel = overlay?.querySelector(".loading-error-panel");
    if (!overlay || !errorPanel) return;
    const title = document.getElementById("loading-error-title");
    const errorMessage = document.getElementById("loading-error-message");
    if (title) title.textContent = "Error";
    if (errorMessage) errorMessage.textContent = message;
    document.getElementById("loading-error-leave")?.addEventListener("click", () => {
      window.close();
      window.location.replace("about:blank");
    });
    errorPanel.hidden = false;
    overlay.classList.add("loading-failed");
    overlay.setAttribute("aria-label", "Unable to start Roblox");
    overlay.setAttribute("aria-busy", "false");
  }

  (async () => {
    const context = await resolveLoaderContext();
    window.__wasmLoaderContext = context;
    const playerUrl = `${context.engineBase}/${PLAYER_SCRIPT}`;
    const script = document.createElement("script");
    script.crossOrigin = "anonymous";
    script.src = playerUrl;
    script.onerror = () => {
      console.error(`[WasmLoader] Failed to load ${playerUrl}`);
      showEngineLoadError();
    };
    document.body.appendChild(script);
  })().catch((err) => {
    console.error("[WasmLoader] Engine resolution failed", err);
    showEngineLoadError();
  });
})();
