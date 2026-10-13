// The SONGS library: the user's own song files (the original compressed File/Blob, never decoded PCM) plus
// title/artist/BPM/duration, kept in IndexedDB so they are ready next time. When IndexedDB is blocked (private
// mode, sandboxed preview, storage disabled) it works in memory for this visit (`persistent` is false).
//   const lib = new Library();  await lib.init();
//   const entries = await lib.add(fileList);        // deduped by name + size + lastModified; tags read
//   lib.list();  const blob = await lib.getBlob(entries[0].id);  deck.loadFile(blob, { libraryId: id, ... });
//   lib.update(id, { bpm: 124, duration: 312.5, firstBeat: 0.08 });  lib.remove(id);  lib.clear();
//   lib.on('change', render);  lib.on('error', toast);  await lib.usage();   // { usedBytes, quotaBytes }
//   lib.loaded   // true once the stored list has been read (the set list waits for it before dropping songs)
// Database 'twinspin' v1: store 'songs' (metadata, keyPath id) and store 'files' ({ id, blob } or, when the
// browser cannot store Blobs, { id, data: ArrayBuffer, type }). At most 60 songs: adding more removes the
// songs that were used least recently. Demo tracks are listed too (demo: true, not stored).

import { Emitter } from '../core/emitter.js';
import { readTags } from '../audio/tags.js';
import { looksLikeAudio, readBlob } from '../audio/decode.js';
import { DEMO_TRACKS } from '../audio/demo-synth.js';

export const LIBRARY_CAP = 60;
const DB_NAME = 'twinspin';
const DB_VERSION = 1;
const SONGS = 'songs';
const FILES = 'files';
const OPEN_TIMEOUT_MS = 6000;
const TAG_BYTES = 512 * 1024;
const PATCH_KEYS = ['title', 'artist', 'bpm', 'duration', 'firstBeat', 'lastUsedAt'];

/** Promise for one IDBRequest. */
function reqP(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('IndexedDB request failed'));
  });
}

function isQuota(err) {
  const n = err && (err.name || '');
  return n === 'QuotaExceededError' || n === 'NS_ERROR_DOM_QUOTA_REACHED' || /quota/i.test(String(err && err.message));
}

/** Same song file = same name, size and modification date (works for File objects and stored entries). */
function dedupeKey(name, size, lastModified) {
  return `${name || ''}|${size || 0}|${lastModified || 0}`;
}

let idSeq = 0;
function newId(now) {
  idSeq = (idSeq + 1) % 1679616;
  const rnd = Math.floor(Math.random() * 1679616).toString(36);
  return `s${now.toString(36)}${idSeq.toString(36)}${rnd}`;
}

export class Library extends Emitter {
  /**
   * @param {{ indexedDB?: IDBFactory|null, storage?: StorageManager|null, now?: () => number }} [opts] for tests;
   *   default: the browser's indexedDB and navigator.storage
   */
  constructor(opts = {}) {
    super();
    this._idb = 'indexedDB' in opts ? opts.indexedDB : safeGlobal('indexedDB');
    this._storage = 'storage' in opts ? opts.storage : safeStorage();
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this._db = null;
    this._persistent = false;
    this._initP = null;
    /** @type {Map<string, object>} */
    this._entries = new Map();
    /** @type {Map<string, Blob>} blobs kept in memory (no IndexedDB, or storing failed) */
    this._mem = new Map();
    this._persistAsked = false;
    this._quotaWarned = false;
    this._lastAddedAt = 0;
    this._loaded = false;
  }

  /** True when songs are stored in IndexedDB (they survive a reload). */
  get persistent() {
    return this._persistent;
  }

  /** True once init() has read the stored song list (before that, list() may be missing saved songs). */
  get loaded() {
    return this._loaded === true;
  }

  /** Open the database and load the song list. Safe to call more than once. Never rejects. */
  init() {
    if (!this._initP) {
      this._initP = this._open().then(() => {
        this._loaded = true;
        this.emit('change');
      });
    }
    return this._initP;
  }

  async _open() {
    if (!this._idb || typeof this._idb.open !== 'function') return;
    let db;
    try {
      db = await openDb(this._idb);
    } catch (err) {
      console.warn('[TwinSpin] song library: IndexedDB unavailable, keeping songs for this visit only', err);
      return;
    }
    try {
      const rows = await this._readAll(db);
      for (const row of rows) {
        const e = sanitize(row);
        if (!e) continue;
        this._entries.set(e.id, e);
        if (e.addedAt > this._lastAddedAt) this._lastAddedAt = e.addedAt;
      }
    } catch (err) {
      console.warn('[TwinSpin] song library could not be read', err);
    }
    this._db = db;
    this._persistent = true;
    try {
      db.onversionchange = () => {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        if (this._db === db) this._db = null;
      };
      db.onclose = () => {
        if (this._db === db) this._db = null;
      };
    } catch {
      /* ignore */
    }
  }

  _readAll(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SONGS, 'readonly');
      const store = tx.objectStore(SONGS);
      if (typeof store.getAll === 'function') {
        reqP(store.getAll()).then(resolve, reject);
        return;
      }
      const out = [];
      const cur = store.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) {
          resolve(out);
          return;
        }
        out.push(c.value);
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    });
  }

  /** The database, re-opened when the browser closed it (Safari does that after a while in the background). */
  async _dbReady() {
    if (this._db || !this._persistent) return this._db;
    try {
      this._db = await openDb(this._idb);
    } catch {
      this._db = null;
    }
    return this._db;
  }

  /** Run fn(stores) in one transaction; resolves with fn's result when the transaction commits. */
  async _tx(names, mode, fn) {
    const db = await this._dbReady();
    if (!db) throw new Error('no database');
    return new Promise((resolve, reject) => {
      let tx;
      let result;
      try {
        tx = db.transaction(names, mode);
        const stores = names.map((n) => tx.objectStore(n));
        result = fn(...stores);
      } catch (err) {
        reject(err);
        return;
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  // -------------------------------------------------------------------------------------------------------

  /**
   * Songs, newest first, then the demo tracks. Each entry: { id, title, artist, fileName, size, duration?,
   * bpm?, firstBeat?, addedAt, lastUsedAt, type, lastModified }; demo entries have demo: true, source: 'demo',
   * demoId and id 'demo-<n>'. The objects are copies.
   */
  list() {
    const songs = [...this._entries.values()].sort((a, b) => b.addedAt - a.addedAt).map((e) => ({ ...e }));
    const demos = DEMO_TRACKS.map((d) => ({
      id: `demo-${d.id}`, demo: true, source: 'demo', demoId: d.id, title: d.title, artist: d.artist, bpm: d.bpm,
      fileName: '', size: 0, addedAt: 0,
    }));
    return songs.concat(demos);
  }

  /** One entry by id (a copy), or null. */
  get(id) {
    const e = this._entries.get(id);
    return e ? { ...e } : null;
  }

  /**
   * Add picked or dropped files. Files already in the library (same name, size and date) are not stored again;
   * their existing entries come back instead. Non-audio files are skipped (with an 'error' message).
   * @param {File[]|FileList} files
   * @returns {Promise<object[]>} the entries, in the order of the files
   */
  async add(files) {
    await this.init();
    const list = Array.from(files || []).filter(Boolean);
    const out = [];
    const addedIds = [];
    const skipped = [];
    const byKey = new Map();
    for (const e of this._entries.values()) byKey.set(dedupeKey(e.fileName, e.size, e.lastModified), e);
    for (const f of list) {
      if (!(f.size > 0) || !looksLikeAudio(f)) {
        skipped.push(f.name || 'file');
        continue;
      }
      const key = dedupeKey(String(f.name || ''), f.size, Number.isFinite(f.lastModified) ? f.lastModified : 0);
      const existing = byKey.get(key);
      if (existing) {
        out.push({ ...existing });
        continue;
      }
      // strictly increasing, so the newest-first list keeps a stable order within one batch
      const now = Math.max(this._now(), this._lastAddedAt + 1);
      this._lastAddedAt = now;
      const tags = await readFileTags(f);
      const entry = {
        id: newId(now),
        title: tags.title || '',
        artist: tags.artist || '',
        fileName: String(f.name || ''),
        size: f.size,
        type: String(f.type || ''),
        lastModified: Number.isFinite(f.lastModified) ? f.lastModified : 0,
        addedAt: now,
        lastUsedAt: now,
      };
      await this._store(entry, f);
      this._entries.set(entry.id, entry);
      byKey.set(key, entry);
      addedIds.push(entry.id);
      out.push({ ...entry });
    }
    if (skipped.length) {
      this.emit('error', skipped.length === 1
        ? `“${skipped[0]}” is not a song file, so it was skipped.`
        : `${skipped.length} files are not song files, so they were skipped.`);
    }
    if (addedIds.length) {
      await this._enforceCap(addedIds);
      this._askPersist();
      this.emit('change');
    }
    return out;
  }

  async _store(entry, file) {
    if (!this._persistent) {
      this._mem.set(entry.id, file);
      return;
    }
    try {
      await this._tx([SONGS, FILES], 'readwrite', (songs, files) => {
        songs.put(entry);
        files.put({ id: entry.id, blob: file });
      });
      return;
    } catch (err) {
      if (isQuota(err)) {
        this._mem.set(entry.id, file);
        this._warnQuota();
        return;
      }
      // Some browsers (old Safari, some WebViews) cannot store Blobs: store the bytes instead.
      try {
        const data = await readBlob(file);
        await this._tx([SONGS, FILES], 'readwrite', (songs, files) => {
          songs.put(entry);
          files.put({ id: entry.id, data, type: entry.type });
        });
        return;
      } catch (err2) {
        if (isQuota(err2)) this._warnQuota();
        else console.warn('[TwinSpin] song could not be saved, keeping it for this visit', err2);
      }
    }
    this._mem.set(entry.id, file);
  }

  _warnQuota() {
    if (this._quotaWarned) return;
    this._quotaWarned = true;
    this.emit('error', 'This device is out of storage for songs. New songs work until you close the app; ' +
      'remove some songs to keep new ones.');
  }

  async _enforceCap(protectIds) {
    if (this._entries.size <= LIBRARY_CAP) return;
    const protect = new Set(protectIds);
    const order = [...this._entries.values()].sort((a, b) => {
      const pa = protect.has(a.id) ? 1 : 0;
      const pb = protect.has(b.id) ? 1 : 0;
      return pa - pb || (a.lastUsedAt || 0) - (b.lastUsedAt || 0) || a.addedAt - b.addedAt;
    });
    const n = this._entries.size - LIBRARY_CAP;
    const victims = order.slice(0, n);
    for (const v of victims) {
      try {
        await this._delete(v.id);
      } catch {
        /* stays; the next add tries again */
      }
    }
    this.emit('error', `Your library keeps up to ${LIBRARY_CAP} songs, so the ${n === 1 ? 'song' : `${n} songs`} ` +
      'you used least recently made room.');
  }

  _askPersist() {
    if (this._persistAsked || !this._persistent) return;
    this._persistAsked = true;
    try {
      const s = this._storage;
      if (s && typeof s.persist === 'function') {
        Promise.resolve(s.persisted ? s.persisted() : false)
          .then((already) => (already ? true : s.persist()))
          .catch(() => {});
      }
    } catch {
      /* not allowed here */
    }
  }

  /**
   * The stored song file, or null when it is gone. Marks the song as used (for the 60-song limit).
   * @returns {Promise<Blob|null>}
   */
  async getBlob(id) {
    await this.init();
    const e = this._entries.get(id);
    if (!e) return null;
    e.lastUsedAt = this._now();
    let blob = this._mem.get(id) || null;
    if (!blob && this._persistent) {
      try {
        // (the transaction resolves with the request's promise, which the await then unwraps)
        const row = await this._tx([FILES], 'readonly', (files) => reqP(files.get(id)));
        if (row && row.blob) blob = row.blob;
        else if (row && row.data && typeof Blob === 'function') blob = new Blob([row.data], { type: row.type || '' });
        else if (row && row.data) blob = bytesBlob(row.data, row.type);
      } catch (err) {
        console.warn('[TwinSpin] song file could not be read', err);
        blob = null;
      }
      this._saveMeta(e);
    }
    return blob;
  }

  /**
   * Store analysis results or user edits: title, artist, bpm, duration, firstBeat, lastUsedAt. Emits 'change'
   * when something changed. Returns the updated entry (a copy) or null.
   */
  async update(id, patch) {
    await this.init();
    const e = this._entries.get(id);
    if (!e || !patch || typeof patch !== 'object') return null;
    let changed = false;
    for (const k of PATCH_KEYS) {
      if (!(k in patch)) continue;
      let v = patch[k];
      if (k === 'title' || k === 'artist') v = String(v == null ? '' : v).slice(0, 200);
      else if (!Number.isFinite(v)) continue;
      if (e[k] !== v) {
        e[k] = v;
        if (k !== 'lastUsedAt') changed = true;
      }
    }
    if (changed) {
      await this._saveMeta(e);
      this.emit('change');
    }
    return { ...e };
  }

  _saveMeta(entry) {
    if (!this._persistent || this._mem.has(entry.id)) return Promise.resolve();
    const row = { ...entry };
    return this._tx([SONGS], 'readwrite', (songs) => {
      songs.put(row);
    }).catch((err) => console.warn('[TwinSpin] song details could not be saved', err));
  }

  /** Remove one song (file and details). */
  async remove(id) {
    await this.init();
    if (!this._entries.has(id)) return;
    await this._delete(id);
    this.emit('change');
  }

  async _delete(id) {
    if (this._persistent && !this._mem.has(id)) {
      try {
        await this._tx([SONGS, FILES], 'readwrite', (songs, files) => {
          songs.delete(id);
          files.delete(id);
        });
      } catch (err) {
        console.warn('[TwinSpin] song could not be removed from storage', err);
        throw err; // the entry stays listed, so the list matches what is stored
      }
    }
    this._entries.delete(id);
    this._mem.delete(id);
  }

  /** Remove every stored song. */
  async clear() {
    await this.init();
    this._entries.clear();
    this._mem.clear();
    if (this._persistent) {
      try {
        await this._tx([SONGS, FILES], 'readwrite', (songs, files) => {
          songs.clear();
          files.clear();
        });
      } catch (err) {
        console.warn('[TwinSpin] library could not be cleared', err);
        this.emit('change');
        throw err;
      }
    }
    this.emit('change');
  }

  /**
   * Storage use: navigator.storage.estimate() when available (the whole site, incl. the app cache), else the
   * sum of the song sizes and quotaBytes null.
   * @returns {Promise<{ usedBytes: number, quotaBytes: number|null }>}
   */
  async usage() {
    let sum = 0;
    for (const e of this._entries.values()) sum += e.size || 0;
    try {
      const s = this._storage;
      if (s && typeof s.estimate === 'function') {
        const est = await s.estimate();
        if (est && Number.isFinite(est.usage)) {
          return { usedBytes: Math.max(est.usage, 0), quotaBytes: Number.isFinite(est.quota) ? est.quota : null };
        }
      }
    } catch {
      /* fall through */
    }
    return { usedBytes: sum, quotaBytes: null };
  }
}

// ---------------------------------------------------------------------------------------------------------

function openDb(idb) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(v);
    };
    // Safari can leave open() pending forever (e.g. right after an update): give up and use memory.
    const timer = setTimeout(() => finish(reject, new Error('IndexedDB open timed out')), OPEN_TIMEOUT_MS);
    let r;
    try {
      r = idb.open(DB_NAME, DB_VERSION);
    } catch (err) {
      finish(reject, err); // SecurityError in sandboxed frames
      return;
    }
    r.onupgradeneeded = () => {
      try {
        const db = r.result;
        const names = db.objectStoreNames;
        const has = (n) => (names && typeof names.contains === 'function' ? names.contains(n) : false);
        if (!has(SONGS)) db.createObjectStore(SONGS, { keyPath: 'id' });
        if (!has(FILES)) db.createObjectStore(FILES, { keyPath: 'id' });
      } catch (err) {
        finish(reject, err);
      }
    };
    r.onsuccess = () => {
      if (done) {
        try {
          r.result.close();
        } catch {
          /* ignore */
        }
        return;
      }
      finish(resolve, r.result);
    };
    r.onerror = () => finish(reject, r.error || new Error('IndexedDB open failed'));
    r.onblocked = () => {
      /* an old tab holds the previous version; the timeout covers a permanent block */
    };
  });
}

function sanitize(row) {
  if (!row || typeof row.id !== 'string') return null;
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  const e = {
    id: row.id,
    title: typeof row.title === 'string' ? row.title : '',
    artist: typeof row.artist === 'string' ? row.artist : '',
    fileName: typeof row.fileName === 'string' ? row.fileName : '',
    size: num(row.size, 0),
    type: typeof row.type === 'string' ? row.type : '',
    lastModified: num(row.lastModified, 0),
    addedAt: num(row.addedAt, 0),
    lastUsedAt: num(row.lastUsedAt, num(row.addedAt, 0)),
  };
  if (Number.isFinite(row.duration) && row.duration > 0) e.duration = row.duration;
  if (Number.isFinite(row.bpm) && row.bpm > 0) e.bpm = row.bpm;
  if (Number.isFinite(row.firstBeat)) e.firstBeat = row.firstBeat;
  return e;
}

async function readFileTags(f) {
  const name = String(f.name || '');
  try {
    const size = f.size || 0;
    const head = await readBlob(typeof f.slice === 'function' ? f.slice(0, Math.min(size, TAG_BYTES)) : f);
    const tail = size > 128 && typeof f.slice === 'function' ? await readBlob(f.slice(size - 128, size)) : null;
    return readTags(head, name, tail);
  } catch {
    return readTags(null, name);
  }
}

/** Minimal Blob stand-in for engines without Blob (never in a browser). */
function bytesBlob(data, type) {
  return { size: data.byteLength, type: type || '', arrayBuffer: () => Promise.resolve(data.slice(0)) };
}

function safeGlobal(name) {
  try {
    return globalThis[name] || null;
  } catch {
    return null;
  }
}

function safeStorage() {
  try {
    const nav = globalThis.navigator;
    return nav && nav.storage ? nav.storage : null;
  } catch {
    return null;
  }
}
