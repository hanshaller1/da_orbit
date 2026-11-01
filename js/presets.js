// User-Presets (16 Plätze in 4 Bänken) inkl. Loop-Audio in IndexedDB
const LS_PRESETS = 'da_orbit.presets.v1';
const LS_GLOBAL = 'da_orbit.global.v1';
const LS_CURRENT = 'da_orbit.current.v1';
const DB_NAME = 'da_orbit', STORE = 'loops';

function lsGet(key, fallback) {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; } catch (_) { return fallback; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (_) { return false; }
}

let dbPromise = null;
function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (_) { resolve(null); }
  });
  return dbPromise;
}
async function idb(mode, fn) {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const tx = d.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : true);
      tx.onerror = () => resolve(null);
    } catch (_) { resolve(null); }
  });
}

export class PresetStore {
  constructor() {
    this.slots = lsGet(LS_PRESETS, null) || new Array(16).fill(null);
    if (this.slots.length !== 16) this.slots = new Array(16).fill(null);
  }
  get(i) { return this.slots[i]; }
  async save(i, preset, loop) {
    this.slots[i] = { ...preset, hasLoop: !!(loop && loop.L), savedAt: Date.now() };
    lsSet(LS_PRESETS, this.slots);
    if (loop && loop.L) await idb('readwrite', (s) => s.put({ L: loop.L, R: loop.R, sr: loop.sr }, i));
    else await idb('readwrite', (s) => s.delete(i));
  }
  async loadLoop(i) { return idb('readonly', (s) => s.get(i)); }
  async clear(i) {
    this.slots[i] = null; lsSet(LS_PRESETS, this.slots);
    await idb('readwrite', (s) => s.delete(i));
  }
  exportJSON() {
    return JSON.stringify({ app: 'da_orbit', version: 1, presets: this.slots }, null, 2);
  }
  importJSON(text) {
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.presets) || data.presets.length !== 16) throw new Error('Ungültige Preset-Datei');
    this.slots = data.presets.map((p) => (p ? { ...p, hasLoop: false } : null));
    lsSet(LS_PRESETS, this.slots);
  }
}

export const loadGlobal = (def) => ({ ...def, ...lsGet(LS_GLOBAL, {}) });
export const saveGlobal = (g) => lsSet(LS_GLOBAL, g);
export const loadCurrent = () => lsGet(LS_CURRENT, null);
export const saveCurrent = (c) => lsSet(LS_CURRENT, c);
