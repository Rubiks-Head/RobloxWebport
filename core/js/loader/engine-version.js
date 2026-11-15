  // engine-version-resolution.ts
  // Resolve the engine binary version for (server, channel) and turn it into
  // an engine base URL on the setup CDN (via the /api gateway, path form —
  // engineBase is a BASE that gets path segments appended).
  async function resolveEngineBase(server, channel) {
    if (!isServerName(server)) {
      console.error(`[ClientSettings] Unknown server environment "${server}" — cannot resolve engine base URL`);
      return null;
    }
    const domain = SERVER_ENVIRONMENTS[server].clientSettings;
    const { channelName, token } = channel;
    let clientVersionUpload = null;
    try {
      const versionPath = isProductionChannel(channelName)
        ? `/v2/client-version/${WEB_CLIENT_BINARY_TYPE}`
        : `/v2/client-version/${WEB_CLIENT_BINARY_TYPE}/channel/${encodeURIComponent(channelName)}`;
      const init = {};
      if (token) init.headers = { "Roblox-Channel-Token": token };
      const resp = await fetch(apiUrl(domain, versionPath), init);
      if (resp.ok) {
        const data = await resp.json();
        clientVersionUpload = data.clientVersionUpload ?? null;
        if (clientVersionUpload) {
          setCachedClientVersion(server, {
            clientVersionUpload,
            version: data.version ?? "",
            channelName,
            cachedAt: Date.now()
          });
          console.log(`[ClientSettings] channel=${channelName || "production"} version=${data.version} upload=${clientVersionUpload}`);
        }
      } else {
        console.warn(`[ClientSettings] HTTP ${resp.status} from ${domain}`);
      }
    } catch (e) {
      console.warn(`[ClientSettings] fetch failed:`, e);
    }
    if (!clientVersionUpload) {
      const cached = getCachedClientVersion(server);
      if (cached && cached.channelName === channelName) {
        clientVersionUpload = cached.clientVersionUpload;
        console.log(`[ClientSettings] Using cached channel=${cached.channelName || "production"} version=${cached.version} upload=${clientVersionUpload}`);
      } else if (cached) {
        console.warn(`[ClientSettings] Cached version is for channel "${cached.channelName || "production"}" but current channel is "${channelName || "production"}"; ignoring stale cache`);
      }
    }
    if (clientVersionUpload) return engineBaseForUpload(server, clientVersionUpload);
    console.log(`[ClientSettings] No version resolved, falling back to the loader's own directory`);
    return null;
  }

  // <setup-cdn>/webclient/<upload>-RobloxWebClient — path form so callers can
  // append /WasmPlayer.js, /WebClient.wasm, etc.
  function engineBaseForUpload(server, clientVersionUpload) {
    return apiBase(SERVER_ENVIRONMENTS[server].setupCdn, `/webclient/${clientVersionUpload}-RobloxWebClient`);
  }

  var CLIENT_VERSION_KEY_PREFIX = "clientVersion_";

  function getCachedClientVersion(server) {
    const raw = localStorage.getItem(CLIENT_VERSION_KEY_PREFIX + server);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  function setCachedClientVersion(server, info) {
    localStorage.setItem(CLIENT_VERSION_KEY_PREFIX + server, JSON.stringify(info));
  }
