// IndexedDB persistence.
//
// Projects are small JSON documents; audio is kept as the *original imported
// file blob*, not as decoded PCM. That keeps a session with a dozen stems in
// the tens of megabytes instead of gigabytes, and re-decoding on load is fast.

const DB_NAME = "basic-daw";
const DB_VERSION = 1;

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("assets")) db.createObjectStore("assets", { keyPath: "id" });
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/* ── assets ─────────────────────────────────────────────────────────────── */
export const putAssetBlob = (rec) => tx("assets", "readwrite", (s) => s.put(rec));
export const getAssetBlob = (id) => tx("assets", "readonly", (s) => s.get(id));
export const deleteAssetBlob = (id) => tx("assets", "readwrite", (s) => s.delete(id));
export const listAssetBlobs = () => tx("assets", "readonly", (s) => s.getAll());

/* ── projects ───────────────────────────────────────────────────────────── */
export const putProject = (rec) => tx("projects", "readwrite", (s) => s.put(rec));
export const getProject = (id) => tx("projects", "readonly", (s) => s.get(id));
export const deleteProject = (id) => tx("projects", "readwrite", (s) => s.delete(id));
export const listProjects = () => tx("projects", "readonly", (s) => s.getAll());

/* ── meta ───────────────────────────────────────────────────────────────── */
export const setMeta = (key, value) => tx("meta", "readwrite", (s) => s.put(value, key));
export const getMeta = (key) => tx("meta", "readonly", (s) => s.get(key));

/** Drop asset blobs no project references any more. */
export async function gcAssets(usedIds) {
  const all = await listAssetBlobs();
  const keep = new Set(usedIds);
  let freed = 0;
  for (const rec of all) {
    if (keep.has(rec.id)) continue;
    freed += rec.blob?.size ?? 0;
    await deleteAssetBlob(rec.id);
  }
  return freed;
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}
