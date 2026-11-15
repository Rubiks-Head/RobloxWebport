  // ── loading screen: status text, experience card, failure panel ───────────
  // All DOM ids come from the #loading-overlay block in index.html; every
  // lookup is null-tolerant so a minimal page still runs.

  // delay that rejects early if the abort signal fires (dismiss cancels waits)
  function abortableDelay(ms, signal) {
    return new Promise((resolve, reject) => {
      const t = window.setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        window.clearTimeout(t);
        reject(new DOMException("Loading screen request cancelled", "AbortError"));
      }, { once: true });
    });
  }

  var LoadingScreen = class {
    constructor() {
      this.root = document.getElementById("loading-overlay");
      this.background = document.getElementById("loading-background-image");
      this.icon = document.getElementById("loading-experience-icon");
      this.iconShell = document.getElementById("loading-icon-shell");
      this.title = document.getElementById("loading-experience-title");
      this.creator = document.getElementById("loading-experience-creator");
      this.verifiedBadge = document.getElementById("loading-verified-badge");
      this.status = document.getElementById("status");
      this.errorPanel = document.querySelector(".loading-error-panel");
      this.errorTitle = document.getElementById("loading-error-title");
      this.errorMessage = document.getElementById("loading-error-message");
      this.errorCode = document.getElementById("loading-error-code");
      this.errorLeaveButton = document.getElementById("loading-error-leave");
      this.cancelButton = document.getElementById("loading-cancel");
      this.abortController = new AbortController;
      this.loadPromise = null;
      this.dismissAnimationFrame = null;
      this.dismissTimeout = null;
      this.dismissed = false;
      this.hiddenAfterSuccess = false;
      this.experienceLoaded = false;
      this.statusPriority = 0;
      this.failureSourcePriority = -1;
      const leave = () => { window.close(), window.location.replace(window.__leaveTarget ? window.__leaveTarget() : "about:blank"); };
      this.cancelButton?.addEventListener("click", leave);
      this.errorLeaveButton?.addEventListener("click", leave);
    }

    prepare(placeId) {
      this.failureSourcePriority = -1;
      this.statusPriority = 0;
      this.dismissed = false;
      this.hiddenAfterSuccess = false;
      this.experienceLoaded = false;
      this.cancelPendingDismissal();
      if (this.root) {
        this.setRootHidden(false);
        this.root.classList.remove("loading-failed", "loading-exiting");
        this.root.setAttribute("aria-label", "Loading Roblox");
        this.root.setAttribute("aria-busy", "true");
      }
      if (this.errorPanel) this.errorPanel.hidden = true;
      if (this.errorMessage) this.errorMessage.textContent = "";
      if (this.errorCode) this.errorCode.textContent = "";
      if (this.title) this.title.textContent = placeId ? "Joining experience" : "Roblox";
    }

    setStatus(text) { this.setStatusWithPriority(text, 0); }
    setEngineStatus(text) { this.setStatusWithPriority(text, 1); }
    clearEngineStatus() { this.clearStatusWithPriority(1); }

    setStatusWithPriority(text, priority) {
      const trimmed = text.trim();
      if (!trimmed || !this.status || priority < this.statusPriority) return;
      this.statusPriority = priority;
      this.status.textContent = trimmed;
      this.status.removeAttribute("aria-valuenow");
      this.status.removeAttribute("title");
    }

    clearStatus() { this.clearStatusWithPriority(0); }

    clearStatusWithPriority(priority) {
      if (!this.status || priority < this.statusPriority || this.statusPriority === 2) return;
      this.statusPriority = 0;
      this.status.textContent = "";
      this.status.removeAttribute("aria-valuenow");
    }

    setDownloadProgress(done, total) {
      const mb = n => (n / 1048576).toFixed(1);
      this.setStatus(total > 0
        ? `Downloading Roblox… ${mb(done)} / ${mb(total)} MB (${Math.round(done / total * 100)}%)`
        : `Downloading Roblox… ${mb(done)} MB`);
      if (this.status && this.statusPriority === 0 && total > 0)
        this.status.setAttribute("aria-valuenow", String(Math.round(done / total * 100)));
    }

    showFailure(message) {
      this.showFailureDetails(message, null, "browser", STATUS_SOURCE_BROWSER);
    }

    showEngineFailure(evt) {
      LOG.raw("[engine-failure]", JSON.stringify(evt));
      const priority = evt.source === "gui-service" ? 3 : 2;
      this.showFailureDetails(evt.message || "Unable to join the experience.", evt.errorCode, evt.source, priority, evt.statusCode);
    }

    // fetch the experience card content (name/creator + icon/background art)
    loadExperience(placeId) {
      if (this.loadPromise) return this.loadPromise;
      this.loadPromise = this.loadExperienceData(placeId).catch(e => {
        if (!(e instanceof DOMException && e.name === "AbortError"))
          console.warn("[LoadingScreen] Experience presentation data unavailable:", e);
      });
      return this.loadPromise;
    }

    dismiss() {
      if (this.dismissed || this.hasEngineFailure()) return;
      this.dismissed = true;
      this.abortController.abort();
      this.cancelPendingDismissal();
      this.root?.setAttribute("aria-busy", "false");
      this.root?.classList.add("loading-exiting");
      this.dismissTimeout = window.setTimeout(() => {
        this.dismissTimeout = null;
        this.hiddenAfterSuccess = true;
        this.setRootHidden(true);
      }, DISMISS_DELAY_MS);
    }

    // engine rendered a frame -> fade the overlay two frames later
    dismissAfterRenderedFrame() {
      if (window.__renderPhase) { window.__renderPhase(); window.__renderPhase = null; }   // "Rendering took xx ms."
      this.experienceLoaded = true;
      if (this.dismissed || this.dismissAnimationFrame !== null || this.hasEngineFailure()) return;
      // Hold the overlay until the world stream settles — the first frame
      // lands while instances/textures are still replicating, which is the
      // "everything is bad for a few seconds" window. Dismiss when inbound
      // datagrams have been flat for ~800ms, with a 1.4s floor (let
      // shaders/textures warm) and a 9s cap so we never hang the reveal.
      const t0 = performance.now();
      let lastBytes = -1, quietPolls = 0;
      LOG.info('Rendering — first frame presented, holding for world stream to settle');
      this.setStatus?.("Loading world…");
      this.dismissAnimationFrame = 1; // sentinel: dismissal is scheduled
      const iv = window.setInterval(async () => {
        if (this.dismissed || this.hasEngineFailure()) { window.clearInterval(iv); return; }
        let bytes = lastBytes;
        try { bytes = (await (await fetch('/stats', { cache: 'no-store' })).json()).rxBytes; } catch (e) {}
        const now = performance.now(), elapsed = now - t0;
        // "settled" = inbound replication dropped to a trickle (<2KB/300ms)
        // for 3 polls — keepalives are bytes-small so the rate gate ignores
        // them; world streaming is orders of magnitude louder
        quietPolls = (lastBytes >= 0 && bytes - lastBytes < 2048) ? quietPolls + 1 : 0;
        lastBytes = bytes;
        if ((quietPolls >= 3 && elapsed > 1400) || elapsed > 9000) {
          window.clearInterval(iv);
          this.dismissAnimationFrame = null;
          LOG.info(`[LoadingScreen] world settled in ${(elapsed / 1000).toFixed(1)}s (rxBytes=${bytes}) — revealing`);
          this.dismiss();
        }
      }, 300);
    }

    showFailureDetails(message, errorCode, source, priority, statusCode = null) {
      if (this.hiddenAfterSuccess || priority < this.failureSourcePriority) return;
      if (this.experienceLoaded && priority <= STATUS_SOURCE_BROWSER) return;
      this.failureSourcePriority = priority;
      this.statusPriority = 2;
      this.dismissed = false;
      this.cancelPendingDismissal();
      const hasCode = errorCode !== null && Number.isInteger(errorCode) && errorCode > 0;
      const text = message.trim() || "Unable to join the experience.";
      const shown = hasCode ? `${text}\nError Code: ${errorCode}` : text;
      if (this.status) {
        this.status.textContent = shown;
        this.status.removeAttribute("aria-valuenow");
        this.status.title = [`Source: ${source}`, ...(statusCode !== null ? [`Join status: ${statusCode}`] : [])].join("; ");
      }
      if (SHOW_ERROR_MODAL && this.errorTitle)
        this.errorTitle.textContent = source === "teleport" ? "Teleport Failed" : source === "browser" ? "Error" : "Join Error";
      if (SHOW_ERROR_MODAL && this.errorMessage) this.errorMessage.textContent = text;
      if (SHOW_ERROR_MODAL && this.errorCode) this.errorCode.textContent = source === "browser" ? "" : `(Error Code: ${hasCode ? errorCode : -1})`;
      if (this.errorPanel) this.errorPanel.hidden = !SHOW_ERROR_MODAL;
      if (this.root) {
        this.setRootHidden(false);
        this.root.classList.remove("loading-exiting");
        this.root.classList.toggle("loading-failed", SHOW_ERROR_MODAL);
        this.root.setAttribute("aria-label", "Unable to join Roblox");
        this.root.setAttribute("aria-busy", "false");
      }
    }

    hasEngineFailure() { return this.failureSourcePriority > STATUS_SOURCE_BROWSER; }

    setRootHidden(hidden) {
      if (this.root) {
        this.root.hidden = hidden;
        this.root.style.display = hidden ? "none" : "";
      }
    }

    cancelPendingDismissal() {
      if (this.dismissAnimationFrame !== null) {
        window.cancelAnimationFrame(this.dismissAnimationFrame);
        this.dismissAnimationFrame = null;
      }
      if (this.dismissTimeout !== null) {
        window.clearTimeout(this.dismissTimeout);
        this.dismissTimeout = null;
      }
    }

    // ── experience presentation data ──────────────────────────────────────
    async loadExperienceData(placeId) {
      const details = this.fetchJson(apiUrl("economy", `/v2/assets/${placeId}/details`))
        .then(d => this.applyProductInfo(d));
      const artwork = this.fetchJson(apiUrl("apis", `/universes/v1/places/${placeId}/universe`))
        .then(async d => {
          if (typeof d.universeId !== "number" || d.universeId <= 0) return;
          const iconParams = new URLSearchParams({
            universeIds: String(d.universeId), returnPolicy: "PlaceHolder",
            size: "256x256", format: "Png", isCircular: "false"
          });
          const bgParams = new URLSearchParams({
            universeIds: String(d.universeId), countPerUniverse: "1", defaults: "true",
            size: "768x432", format: "Png", isCircular: "false"
          });
          await Promise.all([
            this.reportPresentationFailure("experience icon",
              this.fetchThumbnailUrl(apiUrl("thumbnails", "/v1/games/icons?" + iconParams), d => d.data?.[0])
                .then(url => this.applyImage(this.icon, this.iconShell, url))),
            this.reportPresentationFailure("experience background",
              this.fetchThumbnailUrl(apiUrl("thumbnails", "/v1/games/multiget/thumbnails?" + bgParams), d => d.data?.[0]?.thumbnails?.[0])
                .then(url => this.applyImage(this.background, this.background?.parentElement ?? null, url)))
          ]);
        });
      await Promise.all([
        this.reportPresentationFailure("experience details", details),
        this.reportPresentationFailure("experience artwork", artwork)
      ]);
    }

    async fetchJson(url) {
      const resp = await fetch(url, { credentials: "include", signal: this.abortController.signal });
      if (!resp.ok) throw new Error(`${new URL(url).hostname} returned HTTP ${resp.status}`);
      return resp.json();
    }

    // thumbnails poll: state "Pending" -> retry on the backoff table
    async fetchThumbnailUrl(url, pick) {
      for (let i = 0; i <= RETRY_DELAYS_MS.length; ++i) {
        const data = pick(await this.fetchJson(url));
        if (data?.state === "Completed" && typeof data.imageUrl == "string") return data.imageUrl;
        if (data?.state !== "Pending" || i === RETRY_DELAYS_MS.length)
          throw new Error(`${new URL(url).pathname} returned thumbnail state ${String(data?.state)}`);
        await abortableDelay(RETRY_DELAYS_MS[i], this.abortController.signal);
      }
      return null;
    }

    applyProductInfo(data) {
      if (this.title && typeof data.Name == "string" && data.Name) this.title.textContent = data.Name;
      const creator = data.Creator?.Name;
      if (this.creator && typeof creator == "string" && creator) {
        this.creator.textContent = creator;
        this.creator.hidden = false;
      }
      if (this.verifiedBadge && data.Creator?.HasVerifiedBadge === true) this.verifiedBadge.hidden = false;
    }

    // imageUrl points at the CDN directly — <img> needs no proxy
    applyImage(img, shell, url) {
      if (!img || !shell || !url) return;
      img.addEventListener("load", () => shell.classList.add("loading-image-ready"), { once: true });
      img.addEventListener("error", () => {
        console.warn(`[LoadingScreen] Browser rejected image ${url}`);
        img.removeAttribute("src");
      }, { once: true });
      img.src = url;
    }

    async reportPresentationFailure(label, promise) {
      try { await promise; }
      catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") throw e;
        console.warn(`[LoadingScreen] Failed to load ${label}:`, e);
      }
    }
  };

  var loadingScreen = new LoadingScreen;

  // engine -> page status callback (engine invokes via asm_const import)
  window.__onEngineLoadingStatus = e => {
    if (e.kind === "failure") {
      console.error(`Engine failure — ${e.source || 'engine'}: ${e.message || e.kind}`);
      loadingScreen.showEngineFailure(e);
    } else if (e.message && e.message.trim()) {
      LOG.info(`Engine: ${e.source ? e.source + ': ' : ''}${e.message}`);
      loadingScreen.setEngineStatus(e.message);
    } else loadingScreen.clearEngineStatus();
  };
