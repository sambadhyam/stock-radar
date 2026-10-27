// idb.js — a small key-value store in IndexedDB, for price history downloaded for the Backtest lab.
// Everything stays on this phone. If IndexedDB is unavailable, reads miss and writes are skipped.
const DB = 'sr-lab', STORE = 'kv';
let opening = null;

function open() {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
  return opening;
}

function run(mode, fn) {
  return open().then((db) => new Promise((resolve) => {
    if (!db) { resolve(undefined); return; }
    try {
      const tx = db.transaction(STORE, mode), st = tx.objectStore(STORE), req = fn(st);
      tx.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
      tx.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    } catch (e) { resolve(undefined); }
  }));
}

export const idb = {
  get: (key) => run('readonly', (st) => st.get(key)),
  set: (key, value) => run('readwrite', (st) => st.put(value, key)),
  keys: () => run('readonly', (st) => st.getAllKeys()),
  del: (key) => run('readwrite', (st) => st.delete(key)),
  /** Remove every entry whose key does not start with `prefix` (old backtest runs). */
  async keepOnly(prefix) {
    const all = (await idb.keys()) || [];
    for (const k of all) if (!String(k).startsWith(prefix)) await idb.del(k);
  },
};
