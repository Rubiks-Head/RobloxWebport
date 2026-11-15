  // server-endpoints.ts
  // Server environments. We only ship "prod" — the named map is kept so
  // robloxWasmHostConfig.server stays meaningful and adding an environment is
  // a one-line change. Values are DOMAIN labels (see server/domains/), not
  // hosts — every upstream call goes through apiUrl(domain, path).
  var SERVER_ENVIRONMENTS = {
    prod: {
      clientSettings: "clientsettings",
      clientsettingscdn: "clientsettingscdn",
      setupCdn: "setup",
      website: "www"
    }
  };

  function isServerName(value) {
    return typeof value === "string" && Object.prototype.hasOwnProperty.call(SERVER_ENVIRONMENTS, value);
  }

  // channel-resolution.ts
  var WEB_CLIENT_BINARY_TYPE = "WindowsPlayer";

  function isProductionChannel(channel) {
    const normalized = channel.trim().toLowerCase();
    return normalized === "" || normalized === "live" || normalized === "production";
  }
