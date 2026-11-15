// db/memory.js — last-ditch no-persistence driver (same surface, Map-backed).
function open() {
  const manifest = new Map();
  return {
    kind: 'memory',
    putManifest: (k, v) => manifest.set(k, v),
    loadManifest: () => [...manifest],
    putSession: () => {},
    close: () => {},
  };
}
module.exports = { open };
