// Arcadia — almacenamiento local (IndexedDB).
// Proyectos = JSON pequeño. Audio = archivos (Blob) guardados aparte, una sola vez.

const DB_NAME = 'arcadia';
const DB_VERSION = 1;
let dbPromise = null;
const memory = { projects: new Map(), audio: new Map() }; // respaldo si IndexedDB no está disponible

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await openDb();
  if (!db) return fn(null);
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    let result;
    Promise.resolve(fn(os)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export async function loadProjects() {
  const db = await openDb();
  if (!db) return [...memory.projects.values()];
  return tx('projects', 'readonly', (os) => reqP(os.getAll()));
}

export async function saveProject(project) {
  const copy = JSON.parse(JSON.stringify(project));
  const db = await openDb();
  if (!db) { memory.projects.set(copy.id, copy); return; }
  return tx('projects', 'readwrite', (os) => reqP(os.put(copy)));
}

export async function deleteProjectForever(id) {
  const db = await openDb();
  if (!db) { memory.projects.delete(id); return; }
  return tx('projects', 'readwrite', (os) => reqP(os.delete(id)));
}

export async function saveAudio(id, blob, name) {
  const db = await openDb();
  const rec = { id, blob, name, createdAt: Date.now() };
  if (!db) { memory.audio.set(id, rec); return; }
  return tx('audio', 'readwrite', (os) => reqP(os.put(rec)));
}

export async function loadAudio(id) {
  const db = await openDb();
  if (!db) return memory.audio.get(id) || null;
  return tx('audio', 'readonly', (os) => reqP(os.get(id)));
}

/** Pide al navegador que no borre los datos de Arcadia cuando falta espacio. */
export async function askPersistence() {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
}
