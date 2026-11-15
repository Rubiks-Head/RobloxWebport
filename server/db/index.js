// db/index.js — persistence driver selection.
//
// sqlite (default)   — node:sqlite file at server/data/webport.db. Zero deps,
//                      right for a personal/small deployment.
// postgres           — set "database" in cnfg.json or DATABASE_URL env to a
//                      postgres:// URL. Needs `npm i pg` — loaded lazily so a
//                      sqlite-only checkout never installs it.
//
// Both expose the same tiny surface. NOTHING secret is ever persisted —
// no .ROBLOSECURITY, no CSRF, no cert material.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS cache_manifest (
  key TEXT PRIMARY KEY, path TEXT, size INTEGER, ct TEXT, variant TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY, place_id INTEGER, join_method TEXT,
  egress TEXT, created_at INTEGER
);`;

async function open(cfg) {
  const url = process.env.DATABASE_URL || cfg.CFG.database || '';
  if (/^postgres/i.test(url)) {
    try { return await require('./postgres').open(url, SCHEMA); }
    catch (e) {
      console.log(`[db] postgres unavailable (${e.message}) — falling back to sqlite`);
    }
  }
  try {
    return require('./sqlite').open(cfg.SERVER_DIR, SCHEMA);
  } catch (e) {
    console.log(`[db] sqlite unavailable (${e.message}) — running in-memory`);
    return require('./memory').open(SCHEMA);
  }
}

module.exports = { open };
