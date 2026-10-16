// Tests for the song library (src/library/library.js): in-memory mode (no IndexedDB), and persistence through a
// small fake IndexedDB (async requests and transactions on the virtual clock), quota and Blob-unsupported
// fallbacks, the 60-song cap, dedupe, persist() and usage().
import { Library, LIBRARY_CAP } from '../src/library/library.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fakes ------------------------------------------------------------------------------------------------------

let fileSeq = 0;
/** File look-alike: the bytes are a tiny untagged MP3 frame header. */
function fakeFile(name, { size = 4000 + ++fileSeq, lastModified = 1700000000000, type = 'audio/mpeg' } = {}) {
  const bytes = new Uint8Array(Math.min(size, 256));
  bytes[0] = 0xff;
  bytes[1] = 0xfb;
  const f = {
    name, size, lastModified, type,
    arrayBuffer: async () => bytes.buffer.slice(0),
    slice: (a, b) => ({ arrayBuffer: async () => bytes.buffer.slice(Math.min(a, bytes.length), Math.min(b, bytes.length)) }),
  };
  return f;
}

function request() {
  return { result: undefined, error: null, onsuccess: null, onerror: null };
}

class FakeStore {
  constructor(tx, store) {
    this.tx = tx;
    this.store = store;
  }
  _op(fn) {
    const r = request();
    const tx = this.tx;
    tx._pending++;
    setTimeout(() => {
      try {
        if (!tx.error) r.result = fn();
        if (r.onsuccess) r.onsuccess();
      } catch (err) {
        r.error = err;
        tx._fail(err);
        if (r.onerror) r.onerror();
      }
      tx._pending--;
      tx._check();
    }, 0);
    return r;
  }
  put(v) {
    if (this.tx.mode !== 'readwrite') throw new Error('ReadOnlyError');
    const db = this.tx.db;
    return this._op(() => {
      if (db.failPut && db.failPut(v)) {
        const e = new Error(db.failName);
        e.name = db.failName;
        throw e;
      }
      this.store.data.set(v[this.store.keyPath], v);
      return v[this.store.keyPath];
    });
  }
  get(k) {
    return this._op(() => this.store.data.get(k));
  }
  getAll() {
    return this._op(() => [...this.store.data.values()]);
  }
  delete(k) {
    return this._op(() => {
      this.store.data.delete(k);
    });
  }
  clear() {
    return this._op(() => this.store.data.clear());
  }
}

class FakeTx {
  constructor(db, names, mode) {
    this.db = db;
    this.names = [].concat(names);
    this.mode = mode;
    this.error = null;
    this._pending = 0;
    this._done = false;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this._snap = new Map(this.names.map((n) => [n, new Map(db.stores.get(n).data)]));
    setTimeout(() => this._check(), 0); // a transaction without requests completes too
  }
  /** Commit (or roll back) once every request has run, like IndexedDB does. */
  _check() {
    if (this._done || this._pending > 0) return;
    this._done = true;
    if (this.error) {
      for (const [n, data] of this._snap) this.db.stores.get(n).data = data;
      if (this.onerror) this.onerror();
      if (this.onabort) this.onabort();
    } else if (this.oncomplete) this.oncomplete();
  }
  _fail(err) {
    if (!this.error) this.error = err;
  }
  objectStore(name) {
    if (!this.names.includes(name)) throw new Error('NotFoundError');
    return new FakeStore(this, this.db.stores.get(name));
  }
}

class FakeDB {
  constructor() {
    this.stores = new Map();
    this.version = 0;
    this.objectStoreNames = { contains: (n) => this.stores.has(n) };
    this.failPut = null;
    this.failName = '';
  }
  createObjectStore(name, { keyPath }) {
    this.stores.set(name, { keyPath, data: new Map() });
  }
  transaction(names, mode = 'readonly') {
    return new FakeTx(this, names, mode);
  }
  close() {}
}

class FakeIDB {
  constructor() {
    this.dbs = new Map();
    this.opens = 0;
  }
  open(name, version) {
    this.opens++;
    const r = request();
    setTimeout(() => {
      let db = this.dbs.get(name);
      if (!db) {
        db = new FakeDB();
        this.dbs.set(name, db);
      }
      r.result = db;
      if (db.version < version) {
        db.version = version;
        if (r.onupgradeneeded) r.onupgradeneeded();
      }
      if (r.onsuccess) r.onsuccess();
    }, 1);
    return r;
  }
}

function fakeStorage() {
  const s = { persistCalls: 0 };
  s.persisted = async () => false;
  s.persist = async () => {
    s.persistCalls++;
    return true;
  };
  s.estimate = async () => ({ usage: 123456, quota: 9876543 });
  return s;
}

function track(lib) {
  const log = { changes: 0, errors: [] };
  lib.on('change', () => log.changes++);
  lib.on('error', (m) => log.errors.push(m));
  return log;
}

// ---- tests --------------------------------------------------------------------------------------------------------

test('memory mode: add, tags from file names, dedupe, skip non-audio, list order, demos, getBlob', async () => {
  let t = 1000;
  const lib = new Library({ indexedDB: null, storage: null, now: () => t });
  const log = track(lib);
  await lib.init();
  assert.equal(lib.persistent, false);
  const a = fakeFile('DJ Alpha - First Light.mp3');
  const b = fakeFile('02_second_song.wav', { type: '' });
  const doc = fakeFile('notes.txt', { type: 'text/plain' });
  const entries = await lib.add([a, b, doc]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, 'First Light');
  assert.equal(entries[0].artist, 'DJ Alpha');
  assert.equal(entries[0].fileName, 'DJ Alpha - First Light.mp3');
  assert.equal(entries[0].size, a.size);
  assert.equal(entries[1].title, 'second song');
  assert.match(log.errors[0], /notes\.txt” is not a song file/);
  assert(log.changes >= 2);
  // newest first, then the demo tracks
  const list = lib.list();
  assert.deepEqual(list.slice(0, 2).map((e) => e.fileName), ['02_second_song.wav', 'DJ Alpha - First Light.mp3']);
  const demos = list.filter((e) => e.demo);
  assert.equal(demos.length, 2);
  assert.equal(demos[0].id, 'demo-0');
  assert.equal(demos[0].source, 'demo');
  assert.equal(demos[1].bpm, 128);
  // dedupe by name + size + lastModified
  t = 2000;
  const again = await lib.add([fakeFile('DJ Alpha - First Light.mp3', { size: a.size })]);
  assert.equal(again[0].id, entries[0].id);
  assert.equal(lib.list().filter((e) => !e.demo).length, 2);
  // the stored file comes back
  assert.equal(await lib.getBlob(entries[0].id), a);
  assert.equal(await lib.getBlob('nope'), null);
  assert.equal(lib.get(entries[0].id).lastUsedAt, 2000);
});

test('update, remove, clear and usage (memory mode)', async () => {
  const lib = new Library({ indexedDB: null, storage: null });
  const log = track(lib);
  const [e] = await lib.add([fakeFile('A - B.mp3')]);
  const n = log.changes;
  const u = await lib.update(e.id, { bpm: 124.5, duration: 301.2, firstBeat: 0.12, junk: 5, title: 'Better' });
  assert.equal(u.bpm, 124.5);
  assert.equal(u.duration, 301.2);
  assert.equal(u.firstBeat, 0.12);
  assert.equal(u.title, 'Better');
  assert.equal(u.junk, undefined);
  assert.equal(log.changes, n + 1);
  await lib.update(e.id, { bpm: 124.5 }); // no change, no event
  assert.equal(log.changes, n + 1);
  await lib.update(e.id, { bpm: NaN });
  assert.equal(lib.get(e.id).bpm, 124.5);
  assert.equal(await lib.update('missing', { bpm: 1 }), null);
  const usage = await lib.usage();
  assert.equal(usage.usedBytes, e.size);
  assert.equal(usage.quotaBytes, null);
  await lib.remove(e.id);
  assert.equal(lib.get(e.id), null);
  await lib.add([fakeFile('x.mp3'), fakeFile('y.mp3')]);
  await lib.clear();
  assert.equal(lib.list().filter((x) => !x.demo).length, 0);
});

test('IndexedDB: songs and files survive a reload; persist() asked once; estimate used', async () => {
  const idb = new FakeIDB();
  const storage = fakeStorage();
  const lib = new Library({ indexedDB: idb, storage });
  await lib.init();
  assert.equal(lib.persistent, true);
  const f1 = fakeFile('Artist One - Song One.mp3');
  const f2 = fakeFile('Song Two.flac', { type: 'audio/flac' });
  const [e1] = await lib.add([f1]);
  await lib.add([f2]);
  await sleep(10);
  assert.equal(storage.persistCalls, 1, 'persist() after the first add only');
  await lib.update(e1.id, { bpm: 128, duration: 200 });
  const db = idb.dbs.get('twinspin');
  assert(db.stores.has('songs') && db.stores.has('files'));
  assert.equal(db.stores.get('files').data.get(e1.id).blob, f1);

  const again = new Library({ indexedDB: idb, storage });
  await again.init();
  assert.equal(again.persistent, true);
  const songs = again.list().filter((e) => !e.demo);
  assert.equal(songs.length, 2);
  const r1 = songs.find((e) => e.id === e1.id);
  assert.equal(r1.title, 'Song One');
  assert.equal(r1.artist, 'Artist One');
  assert.equal(r1.bpm, 128);
  assert.equal(r1.duration, 200);
  assert.equal(await again.getBlob(e1.id), f1);
  const u = await again.usage();
  assert.deepEqual(u, { usedBytes: 123456, quotaBytes: 9876543 });
  await again.remove(e1.id);
  assert.equal(db.stores.get('songs').data.has(e1.id), false);
  assert.equal(db.stores.get('files').data.has(e1.id), false);
  await again.clear();
  assert.equal(db.stores.get('songs').data.size, 0);
  assert.equal(db.stores.get('files').data.size, 0);
});

test('IndexedDB blocked (sandboxed frame): falls back to memory', async () => {
  const blocked = { open: () => { const e = new Error('Access to the IndexedDB API is denied in this context.'); e.name = 'SecurityError'; throw e; } };
  const lib = new Library({ indexedDB: blocked, storage: null });
  await lib.init();
  assert.equal(lib.persistent, false);
  const [e] = await lib.add([fakeFile('a.mp3')]);
  assert(await lib.getBlob(e.id));
  // an open() that never answers times out
  const hung = { open: () => request() };
  const lib2 = new Library({ indexedDB: hung, storage: null });
  await lib2.init();
  assert.equal(lib2.persistent, false);
});

test('quota full: the song still works for this visit, with one warning', async () => {
  const idb = new FakeIDB();
  const lib = new Library({ indexedDB: idb, storage: null });
  const log = track(lib);
  await lib.init();
  const db = idb.dbs.get('twinspin');
  db.failName = 'QuotaExceededError';
  db.failPut = () => true;
  const f = fakeFile('big.wav', { type: 'audio/wav' });
  const [e] = await lib.add([f]);
  await lib.add([fakeFile('big2.wav', { type: 'audio/wav' })]);
  assert.equal(log.errors.filter((m) => /out of storage/.test(m)).length, 1);
  assert.equal(await lib.getBlob(e.id), f);
  assert.equal(db.stores.get('songs').data.size, 0, 'nothing half-written');
});

test('browsers that cannot store Blobs get the bytes stored instead', async () => {
  const idb = new FakeIDB();
  const lib = new Library({ indexedDB: idb, storage: null });
  await lib.init();
  const db = idb.dbs.get('twinspin');
  db.failName = 'DataError';
  db.failPut = (v) => !!v.blob;
  const f = fakeFile('Bytes - Only.mp3');
  const [e] = await lib.add([f]);
  const row = db.stores.get('files').data.get(e.id);
  assert(row && row.data instanceof ArrayBuffer && !row.blob);
  assert.equal(row.type, 'audio/mpeg');
  const lib2 = new Library({ indexedDB: idb, storage: null });
  await lib2.init();
  const blob = await lib2.getBlob(e.id);
  assert(blob, 'a Blob (or stand-in) comes back');
  const ab = await blob.arrayBuffer();
  assert.equal(ab.byteLength, row.data.byteLength);
});

test(`the library keeps at most ${LIBRARY_CAP} songs; the least recently used go first`, async () => {
  let t = 10;
  const lib = new Library({ indexedDB: new FakeIDB(), storage: null, now: () => t });
  const log = track(lib);
  await lib.init();
  const first = [];
  for (let i = 0; i < LIBRARY_CAP; i++) {
    t += 10;
    const [e] = await lib.add([fakeFile(`song ${i}.mp3`)]);
    first.push(e);
  }
  t += 10;
  await lib.getBlob(first[0].id); // song 0 was used recently: it stays
  t += 10;
  await lib.add([fakeFile('new one.mp3'), fakeFile('new two.mp3')]);
  const ids = new Set(lib.list().filter((e) => !e.demo).map((e) => e.id));
  assert.equal(ids.size, LIBRARY_CAP);
  assert(ids.has(first[0].id), 'recently used song kept');
  assert(!ids.has(first[1].id) && !ids.has(first[2].id), 'oldest unused songs removed');
  assert(ids.has(first[3].id));
  assert.match(log.errors[log.errors.length - 1], /keeps up to 60 songs/);
});

test('plain songs carry the new source fields: source "file", remote null, stored true; demos are unchanged', async () => {
  const lib = new Library({ indexedDB: new FakeIDB(), storage: null });
  await lib.init();
  const [e] = await lib.add([fakeFile('Artist - Plain.mp3')]);
  assert.equal(e.source, 'file');
  assert.equal(e.remote, null);
  assert.equal(e.stored, true);
  assert.equal(lib.isAvailable(e.id), true);
  assert.equal(lib.findRemote({ kind: 'gdrive', fileId: 'whatever-id' }), null);
  const demo = lib.list().find((x) => x.demo);
  assert.deepEqual(Object.keys(demo).sort(), ['addedAt', 'artist', 'bpm', 'demo', 'demoId', 'fileName', 'id', 'size', 'source', 'title']);
  const u = await lib.usage();
  assert.equal(u.usedBytes, e.size);
});
