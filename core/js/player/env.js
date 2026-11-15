  // ── constants shared across the player bundle ─────────────────────────────

  // server environments (domain labels — see loader/10-environments.js)
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

  function isProductionChannel(channel) {
    const normalized = (channel || "").trim().toLowerCase();
    return normalized === "" || normalized === "live" || normalized === "production";
  }

  // browser-event kinds the engine records via _web_client_record_browser_event
  var BROWSER_EVENT = { jsError: 0, unhandledRejection: 1 };

  var RETRY_DELAYS_MS = [250, 500, 1e3, 2e3]; // thumbnail poll backoff
  var DISMISS_DELAY_MS = 600;                 // loading overlay fade-out
  var STATUS_SOURCE_BROWSER = 1;              // failure-priority floor
  var SHOW_ERROR_MODAL =
    new URLSearchParams(window.location.search).get("errorPromptModal") !== "0";

  // cross-tab single-instance lock (navigator.locks, localStorage fallback)
  var TAB_LOCK_NAME = "roblox-webclient-active";
  var TAB_LOCK_KEY = "roblox-webclient-active-tab-v1";
