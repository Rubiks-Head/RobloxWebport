// db/sqlite.js — node:sqlite driver (built in since node 22.5). Sync API,
// which keeps the hot paths in lib/proxy.js call sites unchanged.
const fs = require('fs');
const path = require('path');

function open(serverDir, schema) {
  const { DatabaseSync } = require('node:sqlite');
  const dir = path.join(serverDir, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'webport.db'));
  db.exec(schema);

  const putManifest = db.prepare(
    'INSERT OR REPLACE INTO cache_manifest (key, path, size, ct, variant) VALUES (?, ?, ?, ?, ?)');
  const allManifest = db.prepare('SELECT * FROM cache_manifest');
  const putSession = db.prepare(
    'INSERT OR REPLACE INTO sessions (sid, place_id, join_method, egress, created_at) VALUES (?, ?, ?, ?, ?)');
  const touch = db.prepare('UPDATE sessions SET created_at = created_at WHERE sid = ?');

  // one-time migration: the pre-db manifest.json is still honored
  if (!allManifest.all().length) {
    try {
      const legacy = JSON.parse(fs.readFileSync(path.join(serverDir, 'cache', 'manifest.json'), 'utf8'));
      for (const [k, v] of Object.entries(legacy))
        putManifest.run(k, v.p, v.s, v.ct, v.v ?? null);
      if (Object.keys(legacy).length)
        console.log(`[db] migrated ${Object.keys(legacy).length} cache manifest entries -> sqlite`);
    } catch {}
  }

  return {
    kind: 'sqlite',
    putManifest: (k, v) => putManifest.run(k, v.p, v.s, v.ct, v.v ?? null),
    loadManifest: () => allManifest.all().map(r => [r.key, { p: r.path, s: r.size, ct: r.ct, v: r.variant }]),
    putSession: s => putSession.run(s.sid, s.placeId ?? null, s.joinMethod ?? null, s.egress ?? null, s.created ?? Date.now()),
    close: () => db.close(),
  };
}

module.exports = { open };
