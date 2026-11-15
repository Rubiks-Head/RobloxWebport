// routes/api.js — /api/<id>/ upstream gateway.
// <id> is sha256(domain)[:5]; the arg hex-decodes to the real path+query.
// Most domains forward verbatim through lib/proxy.forward; the `specials`
// table below holds domains needing protocol-aware handling (gamejoin is the
// big one — it runs the two-shape join + joinScript transform).
module.exports = function initApi(r, ctx) {
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const {
  CORS, MAP, CFG, TOKEN, UP_WWW, UP_PLAY, UP_AGENT, SERVER_DIR, SKIP,
  forward, transformJoin, webJoinAttempt, sessOf, isCdnHost,
} = ctx;
// ---------- special domain handlers -----------------------------------------
// domains that don't forward verbatim; keyed by map.domain
const specials = {
  thumbnails: (e, req, res) => {
    if (e.pathQ.split('?')[0] !== '/v1/batch' || req.method !== 'POST')
      return forward(e.host, e.pathQ, req, res, { domain: e.domain });
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      let payload = body;
      try {
        const requests = JSON.parse(body.toString('utf8'));
        if (Array.isArray(requests)) {
          for (const item of requests) {
            if (item && typeof item === 'object') {
              // The WebClient omits these required fields from its batch
              // thumbnail request; the public endpoint rejects that shape 400.
              if (!item.format) item.format = 'Png';
              if (item.token === undefined) item.token = '';
            }
          }
          payload = Buffer.from(JSON.stringify(requests));
        }
      } catch {}
      forward(e.host, e.pathQ, req, res, { domain: e.domain, _body: payload });
    });
  },
  // These are fire-and-forget client analytics. Their schemas change
  // independently of the join API, and upstream rejects the wasm client's
  // compact payloads (400); acknowledging them locally keeps telemetry from
  // filling the engine error log without affecting game state.
  ecsv2: (_e, req, res) => {
    req.resume();
    res.statusCode = 204;
    for (const k in CORS) res.setHeader(k, CORS[k]);
    res.end();
  },
  'experience-signals-ingest': (_e, req, res) => {
    req.resume();
    res.statusCode = 204;
    for (const k in CORS) res.setHeader(k, CORS[k]);
    res.end();
  },
  'ephemeralcounters.api': (_e, req, res) => {
    // Client counters are fire-and-forget and are not needed by the game.
    req.resume();
    res.statusCode = 204;
    for (const k in CORS) res.setHeader(k, CORS[k]);
    res.end();
  },
  apis: (e, req, res) => {
    const p = e.pathQ.split('?')[0];
    // The web client emits several desktop-only/analytics requests through
    // the shared apis host. Their browser payloads are not accepted by the
    // public endpoints; these are non-gameplay calls, so return the empty
    // successful response shape instead of surfacing repeated 400s.
    if (p.startsWith('/experience-signals-ingest/')) {
      req.resume();
      res.statusCode = 204;
      for (const k in CORS) res.setHeader(k, CORS[k]);
      return res.end();
    }
    if (p === '/rm3-evidence-filter/v1/upload-screenshot') {
      // Screenshot evidence is an optional moderation telemetry upload. The
      // local web client has no compatible upstream contract; consume the
      // body and acknowledge it without delaying gameplay on an upstream 422.
      req.resume();
      res.statusCode = 204;
      for (const k in CORS) res.setHeader(k, CORS[k]);
      return res.end();
    }
    if (p.startsWith('/product-experimentation-platform/')) {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      return req.on('end', () => {
        let input = {};
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        const project = /\/projects\/(\d+)/.exec(p);
        const output = {
          projectId: input.projectId ?? (project ? Number(project[1]) : 1),
          platformType: input.platformType ?? 'Web',
          userAgent: input.userAgent ?? req.headers['user-agent'] ?? 'RobloxWebport',
          version: input.version ?? '1',
          layers: [],
        };
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        for (const k in CORS) res.setHeader(k, CORS[k]);
        res.end(JSON.stringify(output));
      });
    }
    if (p.startsWith('/user-profile-api/')) {
      req.resume();
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      for (const k in CORS) res.setHeader(k, CORS[k]);
      return res.end('{"profileDetails":[]}');
    }
    forward(e.host, e.pathQ, req, res, { domain: e.domain });
  },
  assetdelivery: (e, req, res) => {
    // restricted in-experience animation assets 403 upstream ("User is not
    // authorized to access Asset") — the place re-uploaded default anims as
    // private assets. Substitute each known-restricted id with the matching
    // PUBLIC R15 default so characters actually animate (idle/jump/fall/...).
    // id->id rewrite covers both ?id= GETs and /v1/assets/batch bodies.
    const ASSET_SUBS = {
      '129357696649097': '507766666',   // IdleAnimation -> Roblox R15 idle
      '133675829795968': '507765000',   // JumpAnimation -> Roblox R15 jump
      '91936228703870': '507765644',    // Climbing -> Roblox R15 climb
      '911864050': '12222200',          // moderated swoosh -> public legacy swoosh
    };
    {
      const m = /([?&]id=)(\d+)/.exec(e.pathQ);
      if (m && ASSET_SUBS[m[2]]) {
        e = { ...e, pathQ: e.pathQ.replace(m[0], m[1] + ASSET_SUBS[m[2]]) };
        console.log(`[api] assetdelivery sub ${m[2]} -> ${ASSET_SUBS[m[2]]}`);
      }
    }
    // Resolve signed CDN URLs returned by AssetDelivery batches through this
    // origin. The engine's fetch path cannot reliably follow a cross-origin
    // FTS URL, while forwarding the asset hash itself returns 403. Restrict
    // this endpoint to Roblox's CDN hosts; never turn it into an open proxy.
    if (e.pathQ.startsWith('/v1/asset?url=')) {
      let target;
      try { target = new URL(decodeURIComponent(e.pathQ.slice('/v1/asset?url='.length))); } catch {}
      if (!target || target.protocol !== 'https:' || !isCdnHost(target.hostname)) {
        res.statusCode = 400;
        return res.end('invalid asset URL');
      }
      const directLookup = (hostname, opts, cb) => dns.resolve4(hostname, (err, addrs) => {
        if (err) return cb(err);
        if (opts && opts.all) return cb(null, addrs.map(address => ({ address, family: 4 })));
        cb(null, addrs[0], 4);
      });
      const assetReq = https.get(target, {
        agent: UP_AGENT,
        lookup: directLookup,
        headers: { 'user-agent': 'Roblox/WinInet' },
      }, assetRes => {
        res.statusCode = assetRes.statusCode || 502;
        for (const key of ['content-type', 'content-encoding', 'content-length', 'cache-control'])
          if (assetRes.headers[key]) res.setHeader(key, assetRes.headers[key]);
        for (const key in CORS) res.setHeader(key, CORS[key]);
        assetRes.pipe(res);
      });
      assetReq.setTimeout(15000, () => assetReq.destroy(new Error('asset CDN timeout')));
      assetReq.on('error', err => {
        if (!res.headersSent) { res.statusCode = 502; res.end(`asset CDN ${err.code || err.message}`); }
        else res.destroy(err);
      });
      return;
    }
    // hash-addressed lookups: the InExperience patch model is fetched once by
    // id and served for its own hash requests ONLY — every hash-addressed
    // asset used to get this same 15MB rbxm back (images choked on it:
    // "Failed to resolve texture format"). Now: serve the local file only
    // when the requested hash matches the file's fingerprints; all other
    // hashes forward upstream.
    if (e.pathQ.includes('hash=')) {
      const f = require('path').join(SERVER_DIR, 'inexperience.rbxm.gz');
      const m = /hash=([0-9a-fA-F]+)/.exec(e.pathQ);
      if (m && require('fs').existsSync(f)) {
        if (!specials._hashFp) {
          const fs = require('fs'), cr = require('crypto'), zlib = require('zlib');
          const gz = fs.readFileSync(f);
          let raw = gz;
          try { raw = zlib.gunzipSync(gz); } catch {}
          specials._hashFp = new Set([
            cr.createHash('md5').update(raw).digest('hex'),
            cr.createHash('md5').update(gz).digest('hex'),
            cr.createHash('sha256').update(raw).digest('hex').slice(0, 32),
            cr.createHash('sha256').update(gz).digest('hex').slice(0, 32),
          ]);
        }
        if (specials._hashFp.has(m[1].toLowerCase())) {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/octet-stream');
          res.setHeader('content-encoding', 'gzip');
          for (const k in CORS) res.setHeader(k, CORS[k]);
          return require('fs').createReadStream(f).pipe(res);
        }
        console.log(`[api] assetdelivery hash->upstream ${m[1]}`);
      }
    }
    // batch requests for hash-addressed content can't be served upstream —
    // answer them locally with a location pointing back at our ?hash= route
    // (which serves the downloaded asset bytes)
    if (/^\/v\d+\/assets\/batch/.test(e.pathQ)) {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      return req.on('end', () => {
        let items;
        try { items = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { items = null; }
        // same restricted-anim substitution on batch assetIds — upstream then
        // returns a real CDN location the engine can fetch
        if (Array.isArray(items)) {
          for (const i of items) {
            const sub = i && ASSET_SUBS[String(i.assetId || i.assetid || i.id)];
            if (sub) {
              i.assetId = +sub;
              // the requested "Residual v2" representation doesn't exist for
              // 2007-era public anims — allow baseline fallback or upstream
              // returns no location at all
              delete i.doNotFallbackToBaselineRepresentation;
            }
          }
        }
        const isHashBatch = Array.isArray(items) && items.length && items.every(i => i.hash);
        // forward the (possibly substituted) items — NOT the raw chunks:
        // mutating `items` alone used to leave the original restricted ids
        // in the body upstream actually saw
        forward(e.host, e.pathQ, req, res, {
          domain: 'assetdelivery',
          _body: items ? Buffer.from(JSON.stringify(items)) : Buffer.concat(chunks),
          transform: isHashBatch ? buf => {
            const result = JSON.parse(buf.toString('utf8'));
            if (!Array.isArray(result)) return buf;
            for (const item of result) {
              if (!item || typeof item.location !== 'string') continue;
              let location;
              try { location = new URL(item.location); } catch { continue; }
              if (location.protocol === 'https:' && isCdnHost(location.hostname)) {
                item.location = `https://assetdelivery.localhost:9989/v1/asset?url=${encodeURIComponent(location.href)}`;
              }
            }
            return Buffer.from(JSON.stringify(result));
          } : undefined,
        });
      });
    }
    forward(e.host, e.pathQ, req, res, { domain: 'assetdelivery' });
  },
  gamejoin: (e, req, res) => {
    // two ways to get the engine's join admitted:
    //   web     (non-skid): honest Web Play identity — engine headers through,
    //           thin body untouched. status:2 + real gameFqdn on web-enabled
    //           places; status:12 elsewhere.
    //   desktop (skid/UA):  Roblox/WinInet + desktop-shaped body — admitted
    //           anywhere but gameFqdn:null → the qdmux name gets synthesized.
    // cnfg.json joinMethod: 'auto' (web → desktop on denial) | 'web' | 'desktop'
    // (aliases: 'nonskid'/'honest' → web, 'skid'/'ua' → desktop)
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
      const uuid = () => crypto.randomUUID();
      const sess = sessOf(req);
      const sessTok = sess.token || TOKEN;
      const sessCsrf = sess.csrf || ctx.CSRF;
      const rawMethod = (sess.joinMethod || CFG.joinMethod || 'auto').toLowerCase();
      const method = { nonskid: 'web', honest: 'web', skid: 'desktop', ua: 'desktop' }[rawMethod] || rawMethod;

      const sendDesktop = why => {
        if (why) console.log(`[api:gamejoin] ${why} — desktop join`);
        const h = {
          'user-agent': 'Roblox/WinInet', 'referer': `https://${UP_WWW}/`,
          'origin': `https://${UP_WWW}`, 'content-type': 'application/json',
          'x-csrf-token': sessCsrf || '', 'cookie': sessTok ? `.ROBLOSECURITY=${sessTok}` : '',
        };
        const full = {
          placeId: body.placeId,
          isTeleport: false,
          gameJoinAttemptId: body.gameJoinAttemptId || uuid(),
          browserTrackerId: 0,
          playSessionId: uuid(),
          eventId: uuid(),
          launchData: '',
          joinAttemptOrigin: 'PlayButton',
          ...(['jobId', 'followUserId', 'gameId'].reduce((o, k) => body[k] !== undefined ? { ...o, [k]: body[k] } : o, {})),
        };
        forward(e.host, e.pathQ, req, res, { domain: 'gamejoin', transform: buf => transformJoin(buf, sess.state), retries: 8, headers: h, headersOnly: true, _body: Buffer.from(JSON.stringify(full)) });
      };
      if (method === 'desktop') return sendDesktop();

      // web path — pass the engine's headers verbatim (it already sends
      // rbx-user-agent: Roblox/Web + a real browser UA), the play host
      // origin, body untouched except a minted attempt id when absent.
      const wh = {};
      for (const k in req.headers) if (!SKIP.has(k)) wh[k] = req.headers[k];
      if (!wh['rbx-user-agent']) wh['rbx-user-agent'] = CFG.webUserAgent || 'Roblox/Web Windows';
      wh['referer'] = `https://${UP_PLAY}/`;
      wh['origin'] = `https://${UP_PLAY}`;
      wh['content-type'] = 'application/json';
      wh['x-csrf-token'] = wh['x-csrf-token'] || sessCsrf || '';
      wh['cookie'] = sessTok ? `.ROBLOSECURITY=${sessTok}` : '';
      const wb = { ...body };
      if (!wb.gameJoinAttemptId) wb.gameJoinAttemptId = uuid();
      webJoinAttempt(e.host, e.pathQ, wh, Buffer.from(JSON.stringify(wb)), false, (ok, buf, st) => {
        if (!ok) {
          if (method === 'web') {                    // forced — surface the denial
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            for (const k in CORS) res.setHeader(k, CORS[k]);
            return res.end(buf || JSON.stringify({ status: -1, message: String(st) }));
          }
          return sendDesktop(`web join denied (status ${st})`);
        }
        console.log(`[api:gamejoin] web join accepted (status ${st})`);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        for (const k in CORS) res.setHeader(k, CORS[k]);
        res.end(transformJoin(buf, sess.state));
      }, sess);
    });
  },
  refract: (e, req, res) => {                       // local stub — no external call
    res.statusCode = 200;
    for (const k in CORS) res.setHeader(k, CORS[k]);
    res.end(JSON.stringify({ verdict: 'ok', ts: Date.now() }));
  },
  clientsettingscdn: (e, req, res) => {
    // inject transport flags — force the engine OFF the WebTransport path
    // (WT streams can't ride our UDP relay) and onto the ring/RUPP path,
    // plus the Qdmux VIP so its SNI generator produces a routable name.
    forward(e.host, e.pathQ, req, res, {
      domain: e.domain,
      transform: buf => {
        try {
          const j = JSON.parse(buf.toString('utf8'));
          const as = j.applicationSettings || (j.applicationSettings = {});
          // force the QUIC/RbxTransport client (not WT, and no RakNet fallback
          // — the fallback is what produced RakNet-in-RUPP the server drops)
          as.FFlagUseRbxTransportClient3 = 'True';
          as.FFlagUseRbxTransportClient3_PlaceFilter = 'True';
          as.FFlagRbxTransportRuntime = 'True';
          as.FFlagRbxTransportConnectionFailureFallbackToRakNet = 'False';
          as.DFFlagRbxTransportUseGameFqdn2 = 'True';
          as.DFFlagRbxTransportTakeServerCapabilitiesFromJoin = 'True';
          // generate the qdmux SNI so the WT url host isn't nil, and give the
          // QUIC path its full joinScript fields
          as.DFFlagDebugRbxTransportGenerateGameFqdn = 'True';
          as.DFFlagRbxTransportUseGameFqdn2 = 'True';
          // verbose join/replication tracing — makes the engine print every
          // deserialized packet's internal ID/Type/SubType so we can see which
          // wire messages it understands (diagnostic; safe to ship)
          if (process.env.RBX_VERBOSE_ITEMS) {
            // confirmed flag names from captured clientsettings (flags.json)
            as.FLogSessionTransitionFSM = 'Verbose';
            as.DFLogNetworkJoin = '8';
            as.DFLogNetworkClient = '8';
            as.DFLogNetworkAudit = '8';
            as.DFLogReplicationDataCaching = '8';
            as.DFLogPlayerCharacterLoadingLog = '8';
            as.FLogAvatarJoinMetrics = 'Verbose';
            as.FLogNetwork = '8';
            // per-item replication tracing — 'readItem wireType {} ...' fires
            // for every item the deserializer pulls off the stream; the last
            // line before a streaming-data error names the failing type
            as.FLogNetworkReadItem = '9';
            as.DFLogJoinDataRxStats = '9';
            as.DFLogNetworkJDIImpact = '9';
          }
          // RBX_ISRDBG=1 — item-level replication tracing on both directions:
          // which props/attributes the engine reads AND writes, plus the
          // ownership-error channel. If the RCC kills us over a client-authored
          // ref the engine thought was live, these lines name it.
          if (process.env.RBX_ISRDBG) {
            as.DFLogISRIncomingOutgoingProps = '9';
            as.DFLogISRIncomingOutgoingAttributes = '9';
            as.DFLogNetworkOwnershipErrors = '9';
            as.DFLogNetworkPacketsReceive = '9';
            as.FLogNetworkReadItem = '9';
            as.DFLogNetworkAudit = '9';
            as.DFLogMegaReplicatorConnData = '9';
            as.DFLogJoinInstanceTypeBreakdown = '9';
          }
          // RBX_NGW_OFF=1 — force the NextGen replicator WRITE path off.
          // Upstream enables FFlagNextGenReplicatorEnabledWrite4 only via a
          // place filter (189707;3633505977) — everywhere else the client is
          // expected to write the LEGACY replication format. Our wasm's
          // FFlagNextGenReplicatorEnabledWrite isn't served at all, so it
          // defaults ON → we emit NextGen 1c/0e batches that a legacy-read
          // RCC (place 1818) can't deserialize → DisconnectReceivePacketError
          // once the ISR write pipeline warms up (~16-130s in).
          if (process.env.RBX_NGW_OFF) {
            as.FFlagNextGenReplicatorEnabledWrite = 'False';
            as.FFlagNextGenReplicatorEnabledWrite4 = 'False';
            as.FFlagNextGenReplicatorEnabledWrite4_PlaceFilter = 'False';
            // the server-synchronized twin — the value the RCC actually drives
            // per-session (isrW bit in 0x81). clientsettings default is ON;
            // if this suppresses 1c/0e the flag eval works and the server
            // sync is what's broken.
            as.DFFlagNextGenReplicatorEnabledWriteServerSynchronized = 'False';
          }
          // RBX_PINGDBG=1 — the engine's RakNet-layer ping/pong + transport
          // state logs; names whether the RCC's ~60-120s receive watchdog is
          // a missed client ping (dead/outgoingWaiting counters in
          // RakNetMissingPingPong stats)
          if (process.env.RBX_PINGDBG) {
            as.DFLogRakNetMissingPingPong = '9';
            as.FLogRakNetMissingPingPong = '9';
            as.DFLogNetworkClient = '8';
            as.DFLogRbxTransportRnaExpConnection = '8';
            as.FLogRbxTransportRnaExpConnection = '8';
            as.DFLogRbxTransport = '8';
          }
          // RBX_HQ=1 — de-mush experiment. Upstream clientsettings run the
          // whole DRS stack ON (FFlagAutomaticDRS5/RenderDynamicResolution
          // Scale12/StratusDynamicResolution) with framebuffer tiers that
          // drop to 50% — the engine is dynamically downscaling the render.
          // Binary confirms DebugDisableDRS (f131270), DebugFRMQualityLevel
          // Override, DebugForceMSAASamples, DebugOverrideDPIScale exist.
          if (process.env.RBX_HQ) {
            for (const [k, v] of Object.entries({
              // kill dynamic resolution downscaling (all three arms)
              FFlagAutomaticDRS5: 'False',
              FFlagRenderDynamicResolutionScale12: 'False',
              FFlagStratusDynamicResolution: 'False',
              FFlagAutomaticDRSEnableLowDPI: 'False',
              DFFlagAutomaticDRSUseFrameTime: 'False',
              DFFlagAutomaticDRSUseGpuTime2: 'False',
              // debug overrides registered in the binary — force full res
              // + max quality level + MSAA instead of the auto-low tier
              DFFlagDebugDisableDRS: 'True',
              DFIntDebugFRMQualityLevelOverride: '21',
              DFIntDebugForceMSAASamples: '4',
              // force 100% framebuffer instead of the 50/80% tiers
              DFIntDebugAutomaticDRSAreaScaleOverrideTenths: '10',
              // see "DRS state: ql={} mode={} msaa={} halved={}" + the
              // StratusSession [Resolution] line (display/renderView/dpiScale)
              FLogGraphics: '9',
              DFLogStratusSession: '9',
            })) as[k] = v;
          }
          // memory-diet defaults (always on): arm the engine's memory-pressure
          // system so it sheds caches under pressure — the triggers are % of
          // the REPORTED device memory (host-info reports cap*1.25 so the 75%
          // trigger lands just under the heap). FIntWasmMemoryPages is the
          // CEILING, not the size — the client picks its own pages within it.
          // RBX_MEMVAR=low|min: serve a relocated wasm variant (ABI/stack
          // shifted down) on a smaller heap — low=1GB (0x3ff40000), min=769MB
          // (0x2ff40000). RBX_WMEM_MB overrides the ceiling explicitly.
          const memvar = process.env.RBX_MEMVAR || (process.env.RBX_LOWMEM ? 'low' : 'std');
          const wmb = parseInt(process.env.RBX_WMEM_MB || ({ low: '1024', min: '769' }[memvar] || '4096'), 10);
          as.FIntWasmMemoryPages = String(Math.max(16384, Math.min(65536, wmb * 16)));
          if (memvar === 'low') as.DFFlagLowmemWasm = 'True';
          if (memvar === 'min') as.DFFlagMinmemWasm = 'True';
          // tell the RCC we can receive fast — without this the client
          // reports its built-in (era-era ~500Kbps) cap and the server meters
          // world replication to a trickle. Also lift the per-step client
          // stream processing cap so received data gets instanced promptly.
          as.DFIntSendMaxClientBandwidthBps = process.env.RBX_MAXBW || '1000000000';
          as.DFIntMaxStreamPacketsPerStep = process.env.RBX_STREAMSTEP || '4096';
          as.DFIntDesiredStreamJobTimeMSPerThread = process.env.RBX_STREAMJOB || '8';
          // assert a fat measured bandwidth at join — the client smooths/reports
          // its observed throughput to the RCC, which paces DataSender to it.
          // Through our relay the measurement starts tiny; seed it high.
          const bwmbps = process.env.RBX_BWMBPS || '1000';
          as.DFIntRaknetBandwidthMbps = bwmbps;
          as.DFIntRakNetJoinBandwidthMbps = bwmbps;
          as.DFIntRaknetEffectiveInitialBandwidthMbps = bwmbps;
          as.DFIntHttpBandwidthMbps = bwmbps;
          as.FFlagPerformanceControlExposeMemoryPressureLevels = 'True';
          as.DFIntMemoryPressureTriggerMB = process.env.RBX_MEMTRIG || '75';
          as.DFIntMemoryPressureTriggerLowMB = process.env.RBX_MEMTRIG_LOW || '20';
          as.DFIntMemoryPressureTriggerCriticalMB = process.env.RBX_MEMTRIG_CRIT || '10';
          // texture quality follows upstream by default (full-res mips,
          // full-res compositor) — the 4GB heap + pressure triggers above
          // handle real pressure now. RBX_LOWTEX=1 forces the old diet path
          // (mip skipping + quarter-res compositor) on RAM-starved devices.
          as.DFFlagDoNotSkipMipsBasedOnSystemMemoryPS =
            process.env.RBX_LOWTEX ? 'False' : 'True';
          as.FIntTextureCompositorLowResFactor = process.env.RBX_TEXF || '1';
          // perf-stats flags left at upstream — forcing FFlagLazyPerfStatsInit
          // off (eager init) stalled the FSM between "Joining" and transport
          // create in testing
          const s = sessOf(req).state.last();
          as.DFStringDebugRbxTransportQdmuxVip = (s && s.udmux && s.udmux.ip) || '';
          as.DFStringRbxTransportQdmuxVip = (s && s.udmux && s.udmux.ip) || '';
          return Buffer.from(JSON.stringify(j));
        } catch { return buf; }
      },
    });
  },
};

// ---------- api routing ------------------------------------------------------
function decodeArg(arg) {
  try { return Buffer.from(arg, 'hex').toString('utf8') } catch { return null }
}
function argAllowed(pathQ, args) {
  const p = pathQ.split('?')[0];
  return (args || ['/']).some(a => a === '/' || p.startsWith(a));
}
// reverse map: domain -> entry (for the engine's <domain>.localhost URLs —
// Chrome resolves *.localhost to loopback; the request arrives with the
// subdomain in Host, not the /api form)
const BY_DOMAIN = {};
for (const id in MAP) BY_DOMAIN[MAP[id].domain] = MAP[id];

function handleApi(u, req, res) {
  // <domain>.localhost:port -> forward as that domain (engine's raw http layer)
  const sm = (req.headers.host || '').match(/^([a-z0-9.-]+)\.localhost(:\d+)?$/i);
  if (sm && BY_DOMAIN[sm[1]]) {
    const e = { ...BY_DOMAIN[sm[1]], pathQ: u.pathname + u.search };
    if (!(e.domain === 'assetdelivery' && /^\/v\d+\/assets\/batch/.test(u.pathname)))
      console.log(`[api] ${e.domain} ${u.pathname.split('?')[0]} (subdomain)`);
    (specials[e.domain] || ((e2, r2, s2) => forward(e2.host, e2.pathQ, r2, s2, { domain: e.domain })))(e, req, res);
    return true;
  }
  const m = u.pathname.match(/^\/api\/([0-9a-z.-]+)(\/.*)?$/i);
  if (!m) return false;
  const id = m[1].toLowerCase();
  // accept either the sha256 id or the domain name directly
  const entry = MAP[id] || BY_DOMAIN[id];
  if (!entry) { res.statusCode = 404; res.end(`unknown api id ${id}`); return true; }
  const arg = u.searchParams.get('arg');
  // ?arg=<hex> wins; otherwise the /api/<id>/<path> path form (apiBase URLs)
  const pathQ = arg ? decodeArg(arg) : (m[2] ? m[2] + u.search : '/');
  if (!pathQ || !argAllowed(pathQ, entry.args)) { res.statusCode = 403; res.end(`arg not allowed`); return true; }
  const e = { ...entry, pathQ };
  const hotAssetBatch = entry.domain === 'assetdelivery' && /^\/v\d+\/assets\/batch/.test(pathQ.split('?')[0]);
  const fireAndForget = ['ecsv2', 'ephemeralcounters.api', 'experience-signals-ingest'].includes(entry.domain);
  const analyticsPath = entry.domain === 'apis' && pathQ.startsWith('/experience-signals-ingest/');
  if (!hotAssetBatch && !fireAndForget && !analyticsPath)
    console.log(`[api] ${entry.domain} ${pathQ.split('?')[0]}`);
  (specials[entry.domain] || ((e2, r2, s2) => forward(e2.host, e2.pathQ, r2, s2, { domain: entry.domain })))(e, req, res);
  return true;
}


// mount: every /api/* request runs the domain dispatch; unhandled ones fall
// through to static serving
r.add(null, /^\/api\//, (req, res, u) => handleApi(u, req, res));
}
