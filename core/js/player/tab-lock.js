  // ── single-instance tab lock ──────────────────────────────────────────────
  // Only one tab may hold the engine at a time. navigator.locks preferred,
  // localStorage lease as fallback (release on pagehide).

  function newTabId() {
    return typeof crypto.randomUUID == "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function readLockOwner(json) {
    if (json === null) return null;
    try {
      const data = JSON.parse(json);
      return typeof data.ownerId != "string" ? null : { ownerId: data.ownerId };
    } catch { return null; }
  }

  function showTabContended() {
    const overlay = document.getElementById("loading-overlay");
    overlay?.classList.add("tab-lock-contended");
    overlay?.setAttribute("aria-busy", "false");
    document.getElementById("canvas")?.classList.add("tab-lock-contended");
    const status = document.getElementById("status");
    if (status) status.textContent = "Roblox is already running in another tab. Close that tab, then reload this one.";
  }

  async function acquireNavigatorLock() {
    return "locks" in navigator ? new Promise(resolve => {
      let done = false;
      const finish = v => { if (!done) { done = true; resolve(v); } };
      navigator.locks.request(TAB_LOCK_NAME, { ifAvailable: true }, lock => {
        if (lock === null) { finish("contended"); return; }
        let release;
        const held = new Promise(r => { release = r; });
        finish({ release });
        return held;
      }).catch(e => {
        console.warn("[WasmPlayer] navigator.locks failed; trying localStorage lease:", e);
        finish(null);
      });
    }) : null;
  }

  function acquireStorageLock() {
    let store;
    try {
      store = window.localStorage;
      if (readLockOwner(store.getItem(TAB_LOCK_KEY)) !== null) return { kind: "contended" };
    } catch (e) {
      console.warn("[WasmPlayer] localStorage is unavailable for tab coordination:", e);
      return { kind: "unavailable" };
    }
    const ownerId = newTabId();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try {
        if (readLockOwner(store.getItem(TAB_LOCK_KEY))?.ownerId === ownerId) store.removeItem(TAB_LOCK_KEY);
      } catch (e) { console.warn("[WasmPlayer] Failed to release localStorage tab lock:", e); }
    };
    try {
      store.setItem(TAB_LOCK_KEY, JSON.stringify({ ownerId }));
      if (readLockOwner(store.getItem(TAB_LOCK_KEY))?.ownerId !== ownerId) return { kind: "contended" };
    } catch (e) {
      console.warn("[WasmPlayer] Failed to acquire localStorage tab lock:", e);
      return { kind: "unavailable" };
    }
    window.addEventListener("pagehide", release, { once: true });
    return { kind: "acquired", lease: { release }, mechanism: "local-storage" };
  }

  async function acquireTabLock() {
    const nav = await acquireNavigatorLock();
    if (nav === "contended") return { kind: "contended" };
    if (nav !== null) return { kind: "acquired", lease: nav, mechanism: "navigator-locks" };
    return acquireStorageLock();
  }
