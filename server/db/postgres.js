// db/postgres.js — postgres driver for bigger deployments. `pg` is an
// optional peer: only required when a postgres:// database URL is configured.
async function open(url, schema) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  for (const stmt of schema.split(';').map(s => s.trim()).filter(Boolean))
    await client.query(stmt);

  return {
    kind: 'postgres',
    putManifest: (k, v) => client.query(
      'INSERT INTO cache_manifest (key, path, size, ct, variant) VALUES ($1,$2,$3,$4,$5) ' +
      'ON CONFLICT (key) DO UPDATE SET path=$2,size=$3,ct=$4,variant=$5',
      [k, v.p, v.s, v.ct, v.v ?? null]).catch(() => {}),
    loadManifest: async () => (await client.query('SELECT * FROM cache_manifest'))
      .rows.map(r => [r.key, { p: r.path, s: r.size, ct: r.ct, v: r.variant }]),
    putSession: s => client.query(
      'INSERT INTO sessions (sid, place_id, join_method, egress, created_at) VALUES ($1,$2,$3,$4,$5) ' +
      'ON CONFLICT (sid) DO NOTHING',
      [s.sid, s.placeId ?? null, s.joinMethod ?? null, s.egress ?? null, s.created ?? Date.now()]).catch(() => {}),
    close: () => client.end(),
  };
}

module.exports = { open };
