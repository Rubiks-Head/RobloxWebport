  // ── host device info (fed to the engine's telemetry + capability checks) ──

  var OS_NAMES = { 0: "", 1: "Windows", 2: "macOS", 3: "iOS", 4: "Android", 5: "Linux", 6: "Chrome OS" };
  var BROWSER_NAMES = {
    Chrome: "Google Chrome",
    Chromium: "Chromium",
    Edg: "Microsoft Edge",
    Opera: "Opera",
    SamsungInternet: "Samsung Internet"
  };

  var EMPTY_HOST_INFO = {
    hostOS: 0, osName: "", osVersion: "", deviceModel: "",
    browserName: "", browserVersion: "", mobile: false,
    screenWidthDip: 0, screenHeightDip: 0, screenWidthPx: 0, screenHeightPx: 0, dpi: 0
  };
  var EMPTY_GPU_INFO = { gpuVendor: "", gpuRenderer: "" };

  function sanitizeLabel(s) {
    return (s ?? "").replace(/[^A-Za-z0-9 ._-]/g, "").trim();
  }

  function matchGroup(s, re) {
    return s.match(re)?.[1] ?? "";
  }

  // Client Hints high-entropy values with a 500ms cap — some browsers hang.
  async function readClientHints(userAgentData) {
    if (!userAgentData?.getHighEntropyValues) return {};
    let timer;
    try {
      const timeout = new Promise(r => { timer = setTimeout(() => r({}), 500); });
      const hints = userAgentData.getHighEntropyValues(["model", "platformVersion", "fullVersionList"]);
      return await Promise.race([hints, timeout]);
    } catch (e) {
      return console.warn("[host-info] Client Hints unavailable", e), {};
    } finally {
      clearTimeout(timer);
    }
  }

  function detectOs(userAgent, platformUA, platform, maxTouchPoints) {
    return /Android/i.test(platformUA) || /Android/i.test(userAgent) ? 4
      : /iPhone|iPad|iPod/i.test(platformUA) || /iPhone|iPad|iPod/i.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1) ? 3
      : /Windows/i.test(platformUA) || /Windows NT/i.test(userAgent) ? 1
      : /Chrome OS|CrOS/i.test(platformUA) || /CrOS/i.test(userAgent) ? 6
      : /Mac/i.test(platformUA) || /Mac OS X/i.test(userAgent) ? 2
      : /Linux/i.test(platformUA) || /Linux/i.test(userAgent) ? 5
      : 0;
  }

  function osVersionString(userAgent, os) {
    switch (os) {
      case 4: return matchGroup(userAgent, /Android ([\d.]+)/);
      case 3: return matchGroup(userAgent, /OS ([\d_]+) like Mac OS X/).replace(/_/g, ".");
      case 1: return matchGroup(userAgent, /Windows NT ([\d.]+)/);
      case 6: return matchGroup(userAgent, /CrOS \S+ ([\d.]+)/);
      case 2: return matchGroup(userAgent, /Mac OS X ([\d_.]+)/).replace(/_/g, ".");
      case 5:
      case 0: return "";
    }
  }

  function deviceModelString(userAgent) {
    const model = matchGroup(userAgent, /Android [^;)]*;\s*([^;)]+?)(?: Build\/[^;)]*)?\)/);
    return model === "K" ? "" : model;
  }

  function parseBrowser(userAgent, brands) {
    let m;
    return (m = userAgent.match(/SamsungBrowser\/([\d.]+)/)) ? ["SamsungInternet", m[1]]
      : (m = userAgent.match(/(?:OPR|Opera|OPX)\/([\d.]+)/)) ? ["Opera", m[1]]
      : (m = userAgent.match(/Edg(?:A|iOS)?\/([\d.]+)/)) ? ["Edg", m[1]]
      : (m = userAgent.match(/(?:Firefox|FxiOS)\/([\d.]+)/)) ? ["Firefox", m[1]]
      : (m = userAgent.match(/(?:Chrome|CriOS)\/([\d.]+)/))
        ? [brands.includes("Chromium") && !brands.includes("Google Chrome") ? "Chromium" : "Chrome", m[1]]
      : (m = userAgent.match(/Version\/([\d.]+).*Safari/)) ? ["Safari", m[1]]
      : ["", ""];
  }

  async function collectNavigatorInfo(nav) {
    const userAgent = nav.userAgent || "";
    const uaData = nav.userAgentData;
    const platform = nav.platform || "";
    const hints = await readClientHints(uaData);
    const platformUA = hints.platform || uaData?.platform || platform;
    const hostOS = detectOs(userAgent, platformUA, platform, nav.maxTouchPoints || 0);
    const osVersion = (hostOS !== 0 && hints.platformVersion) || osVersionString(userAgent, hostOS);
    const deviceModel = hints.model || (hostOS === 4 ? deviceModelString(userAgent) : "");
    const [browserId, fallbackVersion] = parseBrowser(userAgent, (uaData?.brands ?? []).map(b => b.brand));
    const fullBrand = BROWSER_NAMES[browserId];
    const brandVersion = hints.fullVersionList?.find(b => b.brand === fullBrand)?.version;
    const dpr = window.devicePixelRatio || 0;
    const w = screen.width || 0;
    const h = screen.height || 0;
    return {
      hostOS,
      osName: OS_NAMES[hostOS],
      osVersion: sanitizeLabel(osVersion),
      deviceModel: sanitizeLabel(deviceModel),
      browserName: browserId,
      browserVersion: sanitizeLabel(brandVersion || fallbackVersion),
      mobile: hints.mobile ?? uaData?.mobile ?? /Mobi/i.test(userAgent),
      screenWidthDip: w,
      screenHeightDip: h,
      screenWidthPx: Math.round(w * dpr),
      screenHeightPx: Math.round(h * dpr),
      dpi: Math.round(96 * dpr)
    };
  }

  // probe the GPU via a throwaway webgl2 context (engine wants vendor/renderer)
  function probeGpu() {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return EMPTY_GPU_INFO;
    try {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      const vendor = gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR);
      const renderer = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
      return { gpuVendor: sanitizeLabel(String(vendor ?? "")), gpuRenderer: sanitizeLabel(String(renderer ?? "")) };
    } finally {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }

  async function collectHostInfo() {
    const nav = navigator;
    let base = EMPTY_HOST_INFO;
    try { base = await collectNavigatorInfo(nav); }
    catch (e) { console.warn("[host-info] parsing failed; reporting empty values", e); }
    let gpu = EMPTY_GPU_INFO;
    try { gpu = probeGpu(); }
    catch (e) { console.warn("[host-info] GPU query failed; reporting empty values", e); }
    const info = {
      ...base,
      ...gpu,
      memoryMB: Math.round((nav.deviceMemory || 0) * 1024),
      cpuLogicalCount: nav.hardwareConcurrency || 0
    };
    // Reported device memory must be consistent with the wasm heap cap —
    // the engine's PerformanceControl budgets caches against THIS number
    // and its memory-pressure triggers fire at a % of it. The heap size is
    // decided in engine-launch.js AFTER we run (it knows the real page
    // count) — we only apply EXPLICIT user overrides here and mark them so
    // launch doesn't overwrite; everything else derives from memoryPages.
    //   rh.memmb        — direct override of reported memory
    //   rh.graphics=good — desktop profile (16GB/8cpu) for max quality
    try {
      const memOverride = parseInt(localStorage.getItem("rh.memmb") || "");
      const gfx = localStorage.getItem("rh.graphics");
      if (Number.isFinite(memOverride) && memOverride > 0) {
        info.memoryMB = memOverride;
        info._memExplicit = true;
      } else if (gfx === "good") {
        if (info.memoryMB < 16384) info.memoryMB = 16384;
        if (info.cpuLogicalCount < 8) info.cpuLogicalCount = 8;
        info._memExplicit = true;
      }
    } catch (e) {}
    return info;
  }

  // kicked off at script eval — resolved later in launchEngine
  var hostInfoPromise = collectHostInfo();
