  // ── application flags + IXP settings cache ────────────────────────────────

  var WEB_CLIENT_APP = "WebClientApp";
  var FLAGS_PATH = `/v2/settings/application/${WEB_CLIENT_APP}`;

  // fetchApplicationFlags — clientsettingscdn preloaded flags for the engine.
  // Missing/error -> empty flags (engine falls back to compiled defaults).
  async function fetchApplicationFlags(server, channel) {
    const empty = { applicationSettings: {} };
    if (!isServerName(server))
      console.error(`[ClientSettings] Unknown server environment "${server}" — defaulting to production flags`);
    const domain = SERVER_ENVIRONMENTS[isServerName(server) ? server : "prod"].clientsettingscdn;
    const path = channel !== null && !isProductionChannel(channel)
      ? `${FLAGS_PATH}/bucket/${encodeURIComponent(channel)}`
      : FLAGS_PATH;
    const label = `${domain} (${server}, ${channel || "production"})`;
    try {
      const resp = await fetch(apiUrl(domain, path));
      if (resp.ok) {
        const data = await resp.json();
        if (data?.applicationSettings) {
          console.log(`[Flags] Fetched ${Object.keys(data.applicationSettings).length} preloaded flag(s) from ${label}`);
          return data;
        }
        console.warn(`[Flags] ${label} returned no applicationSettings; using engine defaults`);
      } else console.warn(`[Flags] ${label} HTTP ${resp.status}; using engine defaults`);
    } catch (e) {
      console.warn(`[Flags] ${label} fetch failed; using engine defaults:`, e);
    }
    return empty;
  }

  // IXP (experimentation) settings — the engine hands us a blob to persist;
  // we feed it back on next boot via set_cached_ixp_settings.
  var IXP_CACHE_KEY = "rbxIxpSettings.v1";

  function loadCachedIxpSettings(engine) {
    let cached = null;
    try { cached = localStorage.getItem(IXP_CACHE_KEY); }
    catch (e) { console.warn("[IXP] Could not read the IXP cache:", e); }
    if (cached) {
      engine.set_cached_ixp_settings(cached);
      console.log(`[IXP] Loaded cached IXP settings (${cached.length} bytes)`);
    }
  }

  function persistIxpSettings(json) {
    try { localStorage.setItem(IXP_CACHE_KEY, json); }
    catch (e) { console.warn("[IXP] Could not write the IXP cache:", e); }
  }
