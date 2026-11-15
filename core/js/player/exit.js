  // ── game exit + microprofile helpers ──────────────────────────────────────

  // engine resolves this when the session ends (join_failed / leave / crash)
  window.__resolveGameExit = e => {
    console.log("[WasmPlayer] gameExit (no listener):", e);
  };

  var W = window;
  W.__downloadMicroProfile = (data, filename, mime) => {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 6e4);
  };
  W.startMicroProfile = () => {
    if (!window.Module?.start_microprofile_capture) {
      console.error("[MicroProfile] engine not ready");
      return;
    }
    window.Module.start_microprofile_capture();
    console.log("[MicroProfile] capture started");
  };
  W.stopMicroProfile = () => {
    if (!window.Module?.stop_microprofile_capture) {
      console.error("[MicroProfile] engine not ready");
      return;
    }
    window.Module.stop_microprofile_capture();
    console.log("[MicroProfile] capture stopped");
  };
  W.dumpMicroProfile = async (captureSeconds = 5, durationMs = 600) => {
    if (!window.Module?.dump_microprofile_html) {
      console.error("[MicroProfile] engine not ready");
      return;
    }
    let started = false;
    if (captureSeconds > 0) {
      window.Module.start_microprofile_capture();
      started = true;
      console.log(`[MicroProfile] capturing for ${captureSeconds}s, then dumping...`);
      await new Promise(r => setTimeout(r, captureSeconds * 1e3));
    }
    const t0 = performance.now();
    const html = window.Module.dump_microprofile_html(durationMs);
    const elapsed = (performance.now() - t0).toFixed(0);
    if (started) window.Module.stop_microprofile_capture();
    if (!html || html.length === 0) {
      console.error("[MicroProfile] empty dump — capture may not have been active");
      return;
    }
    console.log(`[MicroProfile] dumped ${(html.length / 1024).toFixed(0)}KB in ${elapsed}ms`);
    W.__lastMicroProfileHtml = html;
    const name = `MicroProfile_${new Date().toISOString().replace(/[:.]/g, "-")}.html`;
    W.__downloadMicroProfile?.(html, name, "text/html;charset=utf-8");
    console.log(`[MicroProfile] triggered download: ${name}
[MicroProfile] desktop chrome://inspect alternative: copy(window.__lastMicroProfileHtml)`);
  };

  // non-clean exit (crash / join_failed after gameplay) — keep the tab open
  // with details instead of closing, so logs stay reachable.
  function showExitScreen(e) {
    console.error("[WasmPlayer] non-clean exit, keeping tab open:", e);
    const wrap = document.createElement("div");
    wrap.style.cssText = ["position:fixed", "inset:0", "z-index:1000", "background:rgba(0,0,0,0.85)",
      "color:#fff", "font-family:monospace", "font-size:14px", "display:flex", "flex-direction:column",
      "align-items:center", "justify-content:center", "padding:24px", "gap:12px", "text-align:center"].join(";");
    const title = document.createElement("div");
    title.textContent = e.reason === "crash" ? "Engine crashed" : `Exit: ${e.reason}`;
    title.style.cssText = "font-size:20px;font-weight:bold;color:#ff7070";
    const detail = document.createElement("pre");
    const lines = [
      e.errorType ? `type: ${e.errorType}` : null,
      e.errorMessage ? `message: ${e.errorMessage}` : null,
      e.statusCode !== undefined ? `statusCode: ${e.statusCode}` : null
    ].filter(Boolean);
    detail.textContent = lines.join("\n") || "(no details)";
    detail.style.cssText = "max-width:80vw;max-height:50vh;overflow:auto;white-space:pre-wrap;text-align:left;background:#111;padding:12px;border-radius:6px";
    const note = document.createElement("div");
    note.textContent = "Open devtools console for full logs. The tab is intentionally left open.";
    note.style.cssText = "opacity:0.75";
    const buttons = document.createElement("div");
    buttons.style.cssText = "display:flex;gap:8px";
    const reload = document.createElement("button");
    reload.textContent = "Reload";
    reload.onclick = () => window.location.reload();
    const close = document.createElement("button");
    close.textContent = "Close tab";
    close.onclick = () => { window.close(); window.location.replace(window.__leaveTarget ? window.__leaveTarget() : "about:blank"); };
    for (const b of [reload, close]) b.style.cssText = "padding:6px 14px;font:inherit;cursor:pointer";
    buttons.append(reload, close);
    wrap.append(title, detail, note, buttons);
    document.body.appendChild(wrap);
  }
