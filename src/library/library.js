// The SONGS library: the user's own song files (the original compressed File/Blob, never decoded PCM) plus
// title/artist/BPM/duration, kept in IndexedDB so they are ready next time. When IndexedDB is blocked (private
// mode, sandboxed preview, storage disabled) it works in memory for this visit (`persistent` is false).
//   const lib = new Library();  await lib.init();
//   const entries = await lib.add(fileList);        // deduped by name + size + lastModified; tags read
//   lib.list();  const blob = await lib.getBlob(entries[0].id);  deck.loadFile(blob, { libraryId: id, ... });
//   lib.update(id, { bpm: 124, duration: 312.5, firstBeat: 0.08 });  lib.remove(id);  lib.clear();
//   lib.on('change', render);  lib.on('error', toast);  await lib.usage();   // { usedBytes, quotaBytes }
//   lib.loaded   // true once the stored list has been read (the set list waits for it before dropping songs)
// Remote songs (docs/SOURCES.md section 2): music-server songs are listed WITHOUT a stored file and fetched when
// they are played, through a resolver their source registers:
//   lib.setResolver('subsonic', async (entry, { signal, onProgress }) => blob);
//   await lib.addRemote(server.toEntries(songs));    // deduped by remote kind + id; at most 1000 listed
//   await lib.getBlob(id, { signal, onProgress });   // the stored file, else the resolver (3 blobs cached)
//   await lib.saveOffline(id);  lib.on('download', ({ id, phase, bytes, totalBytes }) => showProgress());
//   await lib.add(files, { source: 'gdrive' });      // Drive files are stored; File.remote keeps the file id
// Entry fields: source 'file' | 'gdrive' | 'subsonic', remote ({ kind: 'gdrive', fileId } |
// { kind: 'subsonic', serverId, songId } | null) and stored (a copy of the file is on this device).
// Database 'twinspin' v1: store 'songs' (metadata, keyPath id) and store 'files' ({ id, blob } or, when the
// browser cannot store Blobs, { id, data: ArrayBuffer, type }). Rows written before remote songs existed have no
// source / remote / stored fields and read as stored 'file' songs: no schema change, so no version bump that an
// old open tab could block. At most 60 stored songs: adding more removes the songs used least recently (a
// music-server song only loses its offline copy). Demo tracks are listed too (demo: true, not stored).

import { Emitter } from '../core/emitter.js';
import { readTags } from '../audio/tags.js';
import { looksLikeAudio, readBlob } from '../audio/decode.js';
import { DEMO_TRACKS } from '../audio/demo-synth.js';
import { sourceError } from '../sources/net.js';
import { RemoteFetcher } from '../sources/remote-fetcher.js';
import {
  ON_DEMAND_KINDS, isSource, refreshRemote, remoteEntry, remoteForFile, remoteKey, sanitizeRemote, songName,
  unavailableMessage,
} from '../sources/remote-ref.js';

export { remoteKey, sanitizeRemote };

export const LIBRARY_CAP = 60;
/** At most this many remote songs without a stored copy are listed. */
export const REMOTE_CAP = 1000;
/** Remote songs kept in memory after a download, for the session (least recently used go first). */
export const REMOTE_CACHE_SIZE = 3;
const DB_NAME = 'twinspin';
const DB_VERSION = 1;
const SONGS = 'songs';
const FILES = 'files';
const OPEN_TIMEOUT_MS = 6000;
const TAG_BYTES = 512 * 1024;
const PATCH_KEYS = ['title', 'artist', 'album', 'bpm', 'duration', 'firstBeat', 'lastUsedAt'];
const ON_DEMAND = new Set(ON_DEMAND_KINDS);

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

function copy(e) {
  return { ...e };
}

/** Least recently used first (`protect` ids last). */
function byUse(protect) {
  return (a, b) => {
    const pa = protect.has(a.id) ? 1 : 0;
    const pb = protect.has(b.id) ? 1 : 0;
    return pa - pb || (a.lastUsedAt || 0) - (b.lastUsedAt || 0) || a.addedAt - b.addedAt;
  };
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
    /** @type {Set<string>} ids whose details are not in IndexedDB (storing failed): memory only */
    this._volatile = new Set();
    /** @type {Map<string, Function>} remote kind -> resolver */
    this._resolvers = new Map();
    this._fetcher = new RemoteFetcher({
      cacheSize: REMOTE_CACHE_SIZE,
      emit: (ev) => this.emit('download', ev),
      keep: (id) => this._entries.has(id),
    });
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
   * bpm?, firstBeat?, addedAt, lastUsedAt, type, lastModified, source, remote, stored, album?, coverArt?,
   * driveFileId? }; demo entries have demo: true, source: 'demo', demoId and id 'demo-<n>'. The objects are
   * copies (`remote` is a shared frozen object).
   */
  list() {
    const songs = [...this._entries.values()].sort((a, b) => b.addedAt - a.addedAt).map(copy);
    const demos = DEMO_TRACKS.map((d) => ({
      id: `demo-${d.id}`, demo: true, source: 'demo', demoId: d.id, title: d.title, artist: d.artist, bpm: d.bpm,
      fileName: '', size: 0, addedAt: 0,
    }));
    return songs.concat(demos);
  }

  /** One entry by id (a copy), or null. */
  get(id) {
    const e = this._entries.get(id);
    return e ? copy(e) : null;
  }

  /** The entry (a copy) for a remote reference ({ kind: 'gdrive', fileId } / { kind: 'subsonic', ... }), or null. */
  findRemote(remote) {
    const key = remoteKey(remote);
    if (!key) return null;
    for (const e of this._entries.values()) {
      if (e.remote && remoteKey(e.remote) === key) return copy(e);
    }
    return null;
  }

  /** True when the song can be played now: a stored copy, or a connected source for a remote song. */
  isAvailable(id) {
    const e = this._entries.get(id);
    if (!e) return false;
    return e.stored || (!!e.remote && this._resolvers.has(e.remote.kind));
  }

  /**
   * Register how remote songs of one kind are fetched (a source does this when it connects; null removes it).
   * The resolver gets a copy of the entry and { signal, onProgress(bytes, totalBytes) } and resolves with a
   * Blob or File; it rejects with an Error whose message the user can read. Emits 'change' (availability).
   * @param {string} kind e.g. 'subsonic'
   * @param {((entry: object, opts: { signal: AbortSignal, onProgress: Function }) => Promise<Blob>)|null} fn
   */
  setResolver(kind, fn) {
    if (typeof kind !== 'string' || !kind) return;
    const had = this._resolvers.get(kind);
    if (typeof fn === 'function') this._resolvers.set(kind, fn);
    else this._resolvers.delete(kind);
    if (had !== this._resolvers.get(kind)) this.emit('change');
  }

  /** True when a resolver is registered for that remote kind. */
  hasResolver(kind) {
    return this._resolvers.has(kind);
  }

  /**
   * Add picked or dropped files. Files already in the library (same name, size and date, or the same remote
   * file) are not stored again; their existing entries come back instead. Non-audio files are skipped (with an
   * 'error' message).
   * @param {File[]|FileList} files a File may carry `remote` ({ kind: 'gdrive', fileId }) or `driveFileId`
   * @param {{ source?: 'file'|'gdrive'|'subsonic', remote?: object|object[]|((file, index) => object) }} [opts]
   *   `remote`: one reference (used only when one file is added), one per file (array) or a function
   * @returns {Promise<object[]>} the entries, in the order of the files
   */
  async add(files, opts = {}) {
    await this.init();
    const o = opts && typeof opts === 'object' ? opts : {};
    const list = Array.from(files || []).filter(Boolean);
    const out = [];
    const addedIds = [];
    const skipped = [];
    let changed = false;
    const byKey = new Map();
    const byRemote = new Map();
    for (const e of this._entries.values()) {
      if (e.stored) byKey.set(dedupeKey(e.fileName, e.size, e.lastModified), e);
      if (e.remote) byRemote.set(remoteKey(e.remote), e);
    }
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (!(f.size > 0) || !looksLikeAudio(f)) {
        skipped.push(f.name || 'file');
        continue;
      }
      const remote = remoteForFile(f, i, o, list.length);
      const rk = remote ? remoteKey(remote) : null;
      const source = remote && isSource(remote.kind) ? remote.kind : isSource(o.source) ? o.source : 'file';
      const sameRemote = rk ? byRemote.get(rk) : null;
      if (sameRemote) {
        if (!sameRemote.stored) {
          // a listed music-server song added as a file: this is its offline copy
          sameRemote.stored = true;
          sameRemote.size = f.size;
          if (f.type) sameRemote.type = String(f.type);
          await this._store(sameRemote, f, !this._volatile.has(sameRemote.id));
          addedIds.push(sameRemote.id);
          changed = true;
        }
        out.push(copy(sameRemote));
        continue;
      }
      const key = dedupeKey(String(f.name || ''), f.size, Number.isFinite(f.lastModified) ? f.lastModified : 0);
      const existing = byKey.get(key);
      if (existing) {
        if (remote && !existing.remote) {
          existing.remote = remote;
          existing.source = source;
          if (remote.kind === 'gdrive') existing.driveFileId = remote.fileId;
          byRemote.set(rk, existing);
          await this._saveMeta(existing);
          changed = true;
        }
        out.push(copy(existing));
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
        source,
        remote: remote || null,
        stored: true,
      };
      if (remote && remote.kind === 'gdrive') entry.driveFileId = remote.fileId;
      await this._store(entry, f, false);
      this._entries.set(entry.id, entry);
      byKey.set(key, entry);
      if (rk) byRemote.set(rk, entry);
      addedIds.push(entry.id);
      out.push(copy(entry));
    }
    if (skipped.length) {
      this.emit('error', skipped.length === 1
        ? `“${skipped[0]}” is not a song file, so it was skipped.`
        : `${skipped.length} files are not song files, so they were skipped.`);
    }
    if (addedIds.length) {
      await this._enforceCap(addedIds);
      this._askPersist();
    }
    if (addedIds.length || changed) this.emit('change');
    return out;
  }

  /**
   * List songs that live on a music server, without storing their files. Songs already listed (same remote
   * kind + id) come back as they are, with the server's newer title / artist / album / cover. A batch shows in
   * the given order at the top of the list (an album keeps its track order). At most REMOTE_CAP remote songs
   * without a stored copy are kept; the ones used least recently go first.
   * @param {object|object[]} entries { title, artist, album?, duration?, bpm?, coverArt?, fileName?, size?,
   *   type?, remote: { kind: 'subsonic', serverId, songId } }
   * @returns {Promise<object[]>} the entries, in the order given (invalid ones are left out)
   */
  async addRemote(entries) {
    await this.init();
    const list = (Array.isArray(entries) ? entries : [entries]).filter((x) => x && typeof x === 'object');
    const byRemote = new Map();
    for (const e of this._entries.values()) if (e.remote) byRemote.set(remoteKey(e.remote), { entry: e, listed: true });
    const plan = [];
    let fresh = 0;
    for (const x of list) {
      const remote = sanitizeRemote(x.remote);
      if (!remote) continue;
      const rk = remoteKey(remote);
      const known = byRemote.get(rk);
      if (known) {
        plan.push({ known, x });
        continue;
      }
      const slot = { entry: null, listed: false };
      byRemote.set(rk, slot); // a duplicate later in the same batch maps to this one
      plan.push({ slot, x, remote });
      fresh++;
    }
    const base = Math.max(this._now(), this._lastAddedAt + 1);
    if (fresh) this._lastAddedAt = base + fresh - 1;
    let k = 0;
    const rows = [];
    const out = [];
    const newIds = new Set();
    for (const p of plan) {
      if (p.known) {
        const e = p.known.entry;
        if (p.known.listed && refreshRemote(e, p.x) && !rows.includes(e)) rows.push(e);
        if (e) out.push(e);
        continue;
      }
      const at = base + (fresh - 1 - k++);
      const entry = remoteEntry(p.x, p.remote, newId(at), at);
      p.slot.entry = entry;
      this._entries.set(entry.id, entry);
      rows.push(entry);
      newIds.add(entry.id);
      out.push(entry);
    }
    if (rows.length) await this._saveRows(rows, newIds);
    if (newIds.size) await this._enforceRemoteCap(out.map((e) => e.id));
    if (rows.length) this.emit('change');
    return out.filter((e) => this._entries.has(e.id)).map(copy);
  }

  /** Save the details of several entries in one transaction; new ones stay in memory when that fails. */
  async _saveRows(rows, newIds) {
    if (!this._persistent) return;
    try {
      await this._tx([SONGS], 'readwrite', (songs) => {
        for (const r of rows) if (!this._volatile.has(r.id) || newIds.has(r.id)) songs.put({ ...r });
      });
    } catch (err) {
      for (const id of newIds) this._volatile.add(id);
      if (isQuota(err)) this._warnQuota();
      else console.warn('[TwinSpin] song details could not be saved', err);
    }
  }

  /**
   * Store a file for an entry. `hasRow`: the entry's details are already in IndexedDB (an offline copy of a
   * remote song); if storing fails they stay there and only the file is kept in memory for this visit.
   */
  async _store(entry, file, hasRow = false) {
    if (!this._persistent) {
      this._mem.set(entry.id, file);
      return;
    }
    try {
      await this._tx([SONGS, FILES], 'readwrite', (songs, files) => {
        songs.put({ ...entry });
        files.put({ id: entry.id, blob: file });
      });
      this._volatile.delete(entry.id);
      this._mem.delete(entry.id);
      return;
    } catch (err) {
      if (isQuota(err)) {
        this._keepInMemory(entry, file, hasRow);
        this._warnQuota();
        return;
      }
      // Some browsers (old Safari, some WebViews) cannot store Blobs: store the bytes instead.
      try {
        const data = await readBlob(file);
        await this._tx([SONGS, FILES], 'readwrite', (songs, files) => {
          songs.put({ ...entry });
          files.put({ id: entry.id, data, type: entry.type });
        });
        this._volatile.delete(entry.id);
        this._mem.delete(entry.id);
        return;
      } catch (err2) {
        if (isQuota(err2)) this._warnQuota();
        else console.warn('[TwinSpin] song could not be saved, keeping it for this visit', err2);
      }
    }
    this._keepInMemory(entry, file, hasRow);
  }

  _keepInMemory(entry, file, hasRow) {
    this._mem.set(entry.id, file);
    if (!hasRow) this._volatile.add(entry.id);
  }

  _warnQuota() {
    if (this._quotaWarned) return;
    this._quotaWarned = true;
    this.emit('error', 'This device is out of storage for songs. New songs work until you close the app; ' +
      'remove some songs to keep new ones.');
  }

  /** At most LIBRARY_CAP stored songs: the least recently used go (a music-server song keeps its listing). */
  async _enforceCap(protectIds) {
    const stored = [...this._entries.values()].filter((e) => e.stored);
    if (stored.length <= LIBRARY_CAP) return;
    const n = stored.length - LIBRARY_CAP;
    const victims = stored.sort(byUse(new Set(protectIds))).slice(0, n);
    for (const v of victims) {
      try {
        if (v.remote && ON_DEMAND.has(v.remote.kind)) await this._unstore(v);
        else await this._delete(v.id);
      } catch {
        /* stays; the next add tries again */
      }
    }
    this.emit('error', `Your library keeps up to ${LIBRARY_CAP} songs, so the ${n === 1 ? 'song' : `${n} songs`} ` +
      'you used least recently made room.');
  }

  /** At most REMOTE_CAP listed remote songs without a stored copy. */
  async _enforceRemoteCap(protectIds) {
    const remote = [...this._entries.values()].filter((e) => !e.stored && e.remote);
    if (remote.length <= REMOTE_CAP) return;
    const n = remote.length - REMOTE_CAP;
    for (const v of remote.sort(byUse(new Set(protectIds))).slice(0, n)) {
      try {
        await this._delete(v.id);
      } catch {
        /* stays */
      }
    }
    this.emit('error', `Your library lists up to ${REMOTE_CAP} music-server songs, so the ` +
      `${n === 1 ? 'song' : `${n} songs`} you used least recently left the list.`);
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
   * The song file. Stored songs: the stored file, or null when it is gone. Remote songs (not stored): fetched
   * through the resolver of their kind (one download however many callers ask; the last REMOTE_CACHE_SIZE stay
   * in memory). Those reject with an Error whose message the user can read ("Can't reach your music server ...",
   * "Connect to your music server ...") and with an AbortError when `signal` aborts. Marks the song as used.
   * @param {string} id
   * @param {{ signal?: AbortSignal, onProgress?: (bytes: number, totalBytes: number) => void }} [opts]
   * @returns {Promise<Blob|null>}
   */
  async getBlob(id, opts = {}) {
    await this.init();
    const e = this._entries.get(id);
    if (!e) return null;
    e.lastUsedAt = this._now();
    if (e.stored) {
      const blob = await this._readStored(e);
      if (blob || !e.remote || !this._resolvers.has(e.remote.kind)) return blob;
      // the offline copy is gone (storage cleared by the browser): fetch it again
      e.stored = false;
      this.emit('change');
    }
    this._saveMeta(e);
    if (!e.remote) return null;
    const cached = this._fetcher.cached(id);
    if (cached) return cached;
    const resolver = this._resolvers.get(e.remote.kind);
    if (!resolver) throw sourceError('unavailable', unavailableMessage(e));
    const o = opts && typeof opts === 'object' ? opts : {};
    return this._fetcher.fetch(id, copy(e), resolver, { signal: o.signal, onProgress: o.onProgress });
  }

  async _readStored(e) {
    const id = e.id;
    let blob = this._mem.get(id) || null;
    if (!blob && this._persistent && !this._volatile.has(id)) {
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

  /** Download progress of a song being fetched now: { bytes, totalBytes } (totalBytes 0 = unknown), or null. */
  downloadState(id) {
    return this._fetcher.state(id);
  }

  /** Ids of the songs being downloaded now. */
  get downloading() {
    return this._fetcher.ids;
  }

  /**
   * Download a remote song and keep a copy on this device (then `stored: true`; it counts toward the 60-song
   * limit). Resolves with the updated entry; rejects with a readable Error (or an AbortError).
   * @param {string} id
   * @param {{ signal?: AbortSignal, onProgress?: Function }} [opts]
   */
  async saveOffline(id, opts = {}) {
    await this.init();
    const e = this._entries.get(id);
    if (!e) throw sourceError('missing', 'This song is no longer in your library.');
    if (e.stored) return copy(e);
    if (!e.remote) throw sourceError('missing', `${songName(e)} has no file to save.`);
    const blob = await this.getBlob(id, opts);
    if (!this._entries.has(id)) throw sourceError('missing', 'This song is no longer in your library.');
    if (!blob) throw sourceError('missing', `${songName(e)} couldn't be downloaded.`);
    if (e.stored) return copy(e);
    if (Number.isFinite(blob.size) && blob.size > 0) e.size = blob.size;
    if (!e.type && blob.type) e.type = String(blob.type);
    e.stored = true;
    await this._store(e, blob, !this._volatile.has(id));
    await this._enforceCap([id]);
    this._askPersist();
    this.emit('change');
    return copy(e);
  }

  /**
   * Drop the offline copy of a music-server song (it stays listed and is fetched again when played).
   * Resolves with the updated entry, or null when the song cannot do that (a file or Drive song).
   */
  async removeOffline(id) {
    await this.init();
    const e = this._entries.get(id);
    if (!e || !e.stored || !e.remote || !ON_DEMAND.has(e.remote.kind)) return null;
    await this._unstore(e);
    this.emit('change');
    return copy(e);
  }

  async _unstore(e) {
    if (this._persistent && !this._volatile.has(e.id)) {
      const row = { ...e, stored: false };
      await this._tx([SONGS, FILES], 'readwrite', (songs, files) => {
        songs.put(row);
        files.delete(e.id);
      });
    }
    e.stored = false;
    this._mem.delete(e.id);
  }

  /**
   * Store analysis results or user edits: title, artist, album, bpm, duration, firstBeat, lastUsedAt. Emits
   * 'change' when something changed. Returns the updated entry (a copy) or null.
   */
  async update(id, patch) {
    await this.init();
    const e = this._entries.get(id);
    if (!e || !patch || typeof patch !== 'object') return null;
    let changed = false;
    for (const k of PATCH_KEYS) {
      if (!(k in patch)) continue;
      let v = patch[k];
      if (k === 'title' || k === 'artist' || k === 'album') v = String(v == null ? '' : v).slice(0, 200);
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
    return copy(e);
  }

  _saveMeta(entry) {
    if (!this._persistent || this._volatile.has(entry.id)) return Promise.resolve();
    const row = { ...entry };
    return this._tx([SONGS], 'readwrite', (songs) => {
      songs.put(row);
    }).catch((err) => console.warn('[TwinSpin] song details could not be saved', err));
  }

  /** Remove one song (file and details; a download under way is cancelled). */
  async remove(id) {
    await this.init();
    if (!this._entries.has(id)) return;
    await this._delete(id);
    this.emit('change');
  }

  async _delete(id) {
    if (this._persistent && !this._volatile.has(id)) {
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
    this._volatile.delete(id);
    this._fetcher.forget(id);
  }

  /** Remove every song (stored songs and listed music-server songs). */
  async clear() {
    await this.init();
    this._entries.clear();
    this._mem.clear();
    this._volatile.clear();
    this._fetcher.clear();
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
   * sum of the stored song sizes and quotaBytes null.
   * @returns {Promise<{ usedBytes: number, quotaBytes: number|null }>}
   */
  async usage() {
    let sum = 0;
    for (const e of this._entries.values()) if (e.stored) sum += e.size || 0;
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

/** A stored row as an entry (rows from before remote songs read as stored 'file' songs). */
function sanitize(row) {
  if (!row || typeof row.id !== 'string') return null;
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  let remote = sanitizeRemote(row.remote);
  if (!remote && typeof row.driveFileId === 'string' && row.driveFileId) {
    remote = sanitizeRemote({ kind: 'gdrive', fileId: row.driveFileId });
  }
  const stored = row.stored !== false;
  if (!stored && !remote) return null; // nothing to play
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
    source: remote && isSource(remote.kind) ? remote.kind : isSource(row.source) ? row.source : 'file',
    remote,
    stored,
  };
  if (Number.isFinite(row.duration) && row.duration > 0) e.duration = row.duration;
  if (Number.isFinite(row.bpm) && row.bpm > 0) e.bpm = row.bpm;
  if (Number.isFinite(row.firstBeat)) e.firstBeat = row.firstBeat;
  if (typeof row.album === 'string' && row.album) e.album = row.album.slice(0, 200);
  if (typeof row.coverArt === 'string' && row.coverArt) e.coverArt = row.coverArt.slice(0, 512);
  if (remote && remote.kind === 'gdrive') e.driveFileId = remote.fileId;
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
