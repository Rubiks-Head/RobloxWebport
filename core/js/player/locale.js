  // ── account locales (Roblox + UGC game locale the engine localizes with) ──

  var ACCOUNT_LOCALES_PATH = "/v1/locales/user-localization-locus-supported-locales";

  function localeIdOf(obj) {
    if (typeof obj !== "object" || obj === null) return "";
    const locale = obj.locale;
    return typeof locale === "string" ? locale.trim() : "";
  }

  // fetchAccountLocales — the locale upstream. Empty ids on failure are legal —
  // the engine falls back to built-in defaults.
  async function fetchAccountLocales() {
    try {
      const resp = await fetch(apiUrl("locale", ACCOUNT_LOCALES_PATH), { credentials: "include" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const locales = {
        robloxLocaleId: localeIdOf(data.generalExperience),
        gameLocaleId: localeIdOf(data.ugc)
      };
      if (!locales.robloxLocaleId) throw new Error("response did not contain generalExperience.locale");
      console.log(`[Locale] Account locales loaded: Roblox=${locales.robloxLocaleId}, UGC=${locales.gameLocaleId || "<fallback>"}`);
      return locales;
    } catch (e) {
      console.warn("[Locale] Account locale fetch failed; engine defaults will be used:", e);
      return { robloxLocaleId: "", gameLocaleId: "" };
    }
  }
