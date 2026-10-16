// Tests for remote songs in the library (docs/SOURCES.md section 2): add(files, { source, remote }) keeping the
// Drive file id, addRemote (dedupe, order, refresh, the 1000 cap), getBlob through a resolver (progress events,
// one download for several callers, aborts, the 3-blob LRU, readable errors), saveOffline / removeOffline and the
// 60-song cap, persistence through a small fake IndexedDB, and rows written before remote songs existed.
import { Library, LIBRARY_CAP, REMOTE_CAP, REMOTE_CACHE_SIZE, remoteKey } from '../src/library/library.js';
import { makeAbort } from '../src/sources/net.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fakes (the same small IndexedDB as tests/library.test.js) ------------------------------------------------

let fileSeq = 0;
function fakeFile(name, { size = 4000 + ++fileSeq, lastModified = 1700000000000, type = 'audio/mpeg' } = {}) {
  const bytes = new Uint8Array(Math.min(size, 256));
  bytes[0] = 0xff;
  bytes[1] = 0xfb;
  return {
    name, size, lastModified, type,
    arrayBuffer: async () => bytes.buffer.slice(0),
    slice: (a, b) => ({ arrayBuffer: async () => bytes.buffer.slice(Math.min(a, bytes.length), Math.min(b, bytes.length)) }),
  };
}

function fakeBlob(size, type = 'audio/mpeg') {
  return { size, type, arrayBuffer: async () => new ArrayBuffer(size) };
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
    return this._op(() => {
      this.store.data.set(v[this.store.keyPath], this.store.clone ? structuredClone(v) : v);
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
    setTimeout(() => this._check(), 0);
  }
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
    this.upgrades = 0;
    this.objectStoreNames = { contains: (n) => this.stores.has(n) };
  }
  createObjectStore(name, { keyPath }) {
    this.stores.set(name, { keyPath, data: new Map(), clone: name === 'songs' });
  }
  transaction(names, mode = 'readonly') {
    return new FakeTx(this, names, mode);
  }
  close() {}
}

class FakeIDB {
  constructor() {
    this.dbs = new Map();
  }
  open(name, version) {
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
        db.upgrades++;
        if (r.onupgradeneeded) r.onupgradeneeded();
      }
      if (r.onsuccess) r.onsuccess();
    }, 1);
    return r;
  }
}

function track(lib) {
  const log = { changes: 0, errors: [], downloads: [] };
  lib.on('change', () => log.changes++);
  lib.on('error', (m) => log.errors.push(m));
  lib.on('download', (ev) => log.downloads.push(ev));
  return log;
}

const SRV = 'srv-0123456789ab';
function song(n, extra = {}) {
  return {
    title: `Song ${n}`, artist: 'Band', album: 'Album', duration: 200 + n, coverArt: `al-${n}`, fileName: `Band - Song ${n}.mp3`,
    size: 5000 + n, type: 'audio/mpeg', remote: { kind: 'subsonic', serverId: SRV, songId: `s${n}` }, ...extra,
  };
}

// ---- tests -------------------------------------------------------------------------------------------------------

test('add(files, { source, remote }) keeps the Drive file id; File.remote / driveFileId are picked up', async () => {
  const lib = new Library({ indexedDB: null, storage: null });
  const plain = await lib.add([fakeFile('Plain - One.mp3')]);
  assert.equal(plain[0].source, 'file');
  assert.equal(plain[0].remote, null);
  assert.equal(plain[0].stored, true);

  const [a] = await lib.add([fakeFile('Drive - A.mp3')], { source: 'gdrive', remote: { kind: 'gdrive', fileId: 'FILEID_AAAA01' } });
  assert.equal(a.source, 'gdrive');
  assert.deepEqual({ ...a.remote }, { kind: 'gdrive', fileId: 'FILEID_AAAA01' });
  assert.equal(a.driveFileId, 'FILEID_AAAA01');
  assert.equal(a.stored, true);

  const withProp = fakeFile('Drive - B.mp3');
  withProp.remote = { kind: 'gdrive', fileId: 'FILEID_BBBB02' };
  const withId = fakeFile('Drive - C.mp3');
  withId.driveFileId = 'FILEID_CCCC03';
  const [b, c] = await lib.add([withProp, withId], { source: 'gdrive' });
  assert.equal(b.driveFileId, 'FILEID_BBBB02');
  assert.equal(c.driveFileId, 'FILEID_CCCC03');
  assert.equal(c.source, 'gdrive');

  // one object for several files is ignored (it would give them all the same id); arrays work per file
  const two = await lib.add([fakeFile('x1.mp3'), fakeFile('x2.mp3')], { source: 'gdrive', remote: { kind: 'gdrive', fileId: 'FILEID_SAME01' } });
  assert.equal(two[0].remote, null);
  assert.equal(two[1].remote, null);
  const arr = await lib.add([fakeFile('y1.mp3'), fakeFile('y2.mp3')], { remote: [{ fileId: 'FILEID_YYYY01' }, null] });
  assert.equal(arr[0].driveFileId, 'FILEID_YYYY01', 'a bare { fileId } means Drive');
  assert.equal(arr[1].remote, null);

  // the same Drive file again (another File object, other name/date): the existing entry comes back
  const again = fakeFile('renamed.mp3', { lastModified: 5 });
  again.remote = { kind: 'gdrive', fileId: 'FILEID_AAAA01' };
  const [a2] = await lib.add([again]);
  assert.equal(a2.id, a.id);
  assert.equal(lib.findRemote({ kind: 'gdrive', fileId: 'FILEID_BBBB02' }).id, b.id);
  assert.equal(lib.findRemote({ kind: 'gdrive', fileId: 'nope-nope-nope' }), null);
  assert.equal(remoteKey({ kind: 'gdrive', fileId: 'abc' }), 'gdrive|abc');
  assert.equal(remoteKey({ kind: 'subsonic', serverId: 'x', songId: 7 }), 'subsonic|x|7');
  assert.equal(remoteKey({ kind: 'subsonic', serverId: 'x' }), null);

  // a song file added by hand first, then the same file from Drive: it gets the Drive id
  const local = fakeFile('Same - Song.mp3', { size: 7777 });
  const [l1] = await lib.add([local]);
  const fromDrive = fakeFile('Same - Song.mp3', { size: 7777 });
  fromDrive.remote = { kind: 'gdrive', fileId: 'FILEID_SAME02' };
  const [l2] = await lib.add([fromDrive]);
  assert.equal(l2.id, l1.id);
  assert.equal(l2.driveFileId, 'FILEID_SAME02');
});

test('addRemote: listed without a file, deduped, in album order, refreshed; invalid entries left out', async () => {
  let t = 1000;
  const lib = new Library({ indexedDB: null, storage: null, now: () => t });
  const log = track(lib);
  await lib.add([fakeFile('Older - File.mp3')]);
  t = 2000;
  const out = await lib.addRemote([song(1), song(2), { title: 'bad', remote: { kind: 'subsonic' } }, song(3), song(2)]);
  assert.equal(out.length, 4, 'the invalid one is left out; the duplicate maps to the first');
  assert.equal(out[1].id, out[3].id);
  for (const e of out) {
    assert.equal(e.stored, false);
    assert.equal(e.source, 'subsonic');
    assert.equal(e.remote.serverId, SRV);
  }
  assert.equal(out[0].title, 'Song 1');
  assert.equal(out[0].album, 'Album');
  assert.equal(out[0].coverArt, 'al-1');
  assert.equal(out[0].duration, 201);
  assert.equal(out[0].fileName, 'Band - Song 1.mp3');
  // newest first, but the batch keeps its own order
  const titles = lib.list().filter((e) => !e.demo).map((e) => e.title || e.fileName);
  assert.deepEqual(titles, ['Song 1', 'Song 2', 'Song 3', 'File']);
  const changes = log.changes;
  // the same songs again: same entries, the server's newer details copied
  const again = await lib.addRemote([song(1, { title: 'Song 1 (Remaster)' }), song(3)]);
  assert.equal(again[0].id, out[0].id);
  assert.equal(again[0].title, 'Song 1 (Remaster)');
  assert.equal(again[1].id, out[2].id);
  assert.equal(log.changes, changes + 1);
  await lib.addRemote([song(3)]);
  assert.equal(log.changes, changes + 1, 'nothing new, no change event');
  assert.equal(lib.isAvailable(out[0].id), false, 'no resolver yet');
  lib.setResolver('subsonic', async () => fakeBlob(10));
  assert.equal(lib.isAvailable(out[0].id), true);
  assert.equal(lib.hasResolver('subsonic'), true);
  // usage() counts stored songs only
  const u = await lib.usage();
  assert.equal(u.usedBytes, lib.list().filter((e) => e.stored).reduce((s, e) => s + e.size, 0));
});

test('getBlob through the resolver: progress, one download for several callers, the 3-song cache', async () => {
  const lib = new Library({ indexedDB: null, storage: null });
  const log = track(lib);
  const entries = await lib.addRemote([song(1), song(2), song(3), song(4)]);
  const calls = [];
  lib.setResolver('subsonic', async (entry, { signal, onProgress }) => {
    calls.push(entry.remote.songId);
    assert(signal && typeof signal.addEventListener === 'function', 'the resolver gets a signal');
    assert.equal(typeof onProgress, 'function');
    entry.title = 'changed by the resolver'; // a copy: the library is not touched
    await sleep(50);
    onProgress(100000, 1000000);
    onProgress(150000, 1000000); // < 256 KB further: not reported
    onProgress(600000, 1000000);
    onProgress(1000000, 1000000);
    return fakeBlob(1000000);
  });
  const seen = [];
  const p1 = lib.getBlob(entries[0].id, { onProgress: (b, t) => seen.push([b, t]) });
  await sleep(1);
  assert.deepEqual(lib.downloadState(entries[0].id), { bytes: 0, totalBytes: 0 });
  assert.deepEqual(lib.downloading, [entries[0].id]);
  const p2 = lib.getBlob(entries[0].id);
  const [b1, b2] = await Promise.all([p1, p2]);
  assert.equal(b1, b2, 'both callers get the same blob');
  assert.deepEqual(calls, ['s1'], 'one download');
  assert.deepEqual(seen, [[100000, 1000000], [600000, 1000000], [1000000, 1000000]]);
  assert.deepEqual(log.downloads.map((d) => d.phase), ['start', 'progress', 'progress', 'progress', 'done']);
  assert.equal(log.downloads[0].totalBytes, 5001, 'start: the size the server listed');
  assert.equal(log.downloads[4].bytes, 1000000);
  assert.equal(lib.get(entries[0].id).title, 'Song 1');
  assert.equal(lib.downloadState(entries[0].id), null);
  // cached: no second download
  assert.equal(await lib.getBlob(entries[0].id), b1);
  assert.equal(calls.length, 1);
  // three more songs: the least recently used one (song 1) leaves the cache
  for (const e of entries.slice(1)) await lib.getBlob(e.id);
  assert.deepEqual(calls, ['s1', 's2', 's3', 's4']);
  assert.equal(REMOTE_CACHE_SIZE, 3);
  await lib.getBlob(entries[1].id);
  assert.equal(calls.length, 4, 'song 2 is still cached');
  await lib.getBlob(entries[0].id);
  assert.deepEqual(calls.slice(4), ['s1'], 'song 1 was dropped from the cache');
  // the stored-file path is unchanged
  const [f] = await lib.add([fakeFile('Local - Song.mp3')]);
  assert.equal((await lib.getBlob(f.id)).name, 'Local - Song.mp3');
  assert.equal(calls.length, 5);
});

test('getBlob errors: no resolver, a failing server, an empty answer', async () => {
  const lib = new Library({ indexedDB: null, storage: null });
  const log = track(lib);
  const [e] = await lib.addRemote([song(7)]);
  await assert.rejects(lib.getBlob(e.id), (err) => err.code === 'unavailable' && /Connect to your music server to play “Song 7”/.test(err.message));
  lib.setResolver('subsonic', async () => {
    const err = new Error("Can't reach your music server to get “Song 7”.");
    err.code = 'unreachable';
    throw err;
  });
  await assert.rejects(lib.getBlob(e.id), (err) => err.code === 'unreachable' && /Can't reach/.test(err.message));
  const last = log.downloads[log.downloads.length - 1];
  assert.equal(last.phase, 'error');
  assert.match(last.message, /Can't reach/);
  lib.setResolver('subsonic', async () => fakeBlob(0));
  await assert.rejects(lib.getBlob(e.id), /empty file/);
  lib.setResolver('subsonic', null);
  assert.equal(lib.hasResolver('subsonic'), false);
  assert.equal(await lib.getBlob('missing-id'), null);
});

test('aborts: one caller giving up does not stop the others; the download stops when every caller gave up', async () => {
  const lib = new Library({ indexedDB: null, storage: null });
  const log = track(lib);
  const [e1, e2] = await lib.addRemote([song(1), song(2)]);
  let resolverAborted = 0;
  lib.setResolver('subsonic', (entry, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(fakeBlob(4321)), 1000);
    signal.addEventListener('abort', () => {
      resolverAborted++;
      clearTimeout(timer);
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  }));
  const c1 = makeAbort();
  const c2 = makeAbort();
  const pa = lib.getBlob(e1.id, { signal: c1.signal });
  const pb = lib.getBlob(e1.id, { signal: c2.signal });
  await sleep(100);
  c1.abort();
  await assert.rejects(pa, (err) => err.name === 'AbortError');
  assert.equal(resolverAborted, 0, 'the other caller still waits');
  const blob = await pb;
  assert.equal(blob.size, 4321);
  // both give up: the download is aborted
  const c3 = makeAbort();
  const c4 = makeAbort();
  const pc = lib.getBlob(e2.id, { signal: c3.signal });
  const pd = lib.getBlob(e2.id, { signal: c4.signal });
  await sleep(10);
  c3.abort();
  c4.abort();
  await assert.rejects(pc, (err) => err.name === 'AbortError');
  await assert.rejects(pd, (err) => err.name === 'AbortError');
  await sleep(10);
  assert.equal(resolverAborted, 1);
  assert.equal(log.downloads.filter((d) => d.id === e2.id).map((d) => d.phase).join(), 'start,cancel');
  // an already aborted signal rejects at once without a download
  const c5 = makeAbort();
  c5.abort();
  await assert.rejects(lib.getBlob(e2.id, { signal: c5.signal }), (err) => err.name === 'AbortError');
  // removing a song while it downloads cancels the download
  const pe = lib.getBlob(e2.id);
  await sleep(10);
  await lib.remove(e2.id);
  await assert.rejects(pe, (err) => err.name === 'AbortError');
  assert.equal(resolverAborted, 2);
});

test('a song asked for again while its abandoned download still winds down gets a fresh download', async () => {
  const lib = new Library({ indexedDB: null, storage: null });
  const [e1] = await lib.addRemote([song(7)]);
  let started = 0;
  lib.setResolver('subsonic', (entry, { signal }) => new Promise((resolve, reject) => {
    started++;
    const timer = setTimeout(() => resolve(fakeBlob(2468)), 200);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      // like a real fetch: the abort reaches the download a moment later
      setTimeout(() => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      }, 50);
    });
  }));
  const c1 = makeAbort();
  const pa = lib.getBlob(e1.id, { signal: c1.signal });
  await sleep(20);
  c1.abort(); // e.g. another song was loaded on that deck
  await assert.rejects(pa, (err) => err.name === 'AbortError');
  // ... and the user loads the first song again at once
  const blob = await lib.getBlob(e1.id);
  assert.equal(blob.size, 2468, 'a new download, not the abandoned one');
  assert.equal(started, 2);
  assert.equal(lib.downloading.length, 0);
});

test('saveOffline keeps a copy (survives a reload, plays without the server); removeOffline drops it', async () => {
  const idb = new FakeIDB();
  const lib = new Library({ indexedDB: idb, storage: null });
  await lib.init();
  const [e] = await lib.addRemote([song(5)]);
  const blob = fakeBlob(6000, 'audio/flac');
  let calls = 0;
  lib.setResolver('subsonic', async () => {
    calls++;
    return blob;
  });
  const progress = [];
  const saved = await lib.saveOffline(e.id, { onProgress: (b, t) => progress.push([b, t]) });
  assert.equal(saved.stored, true);
  assert.equal(saved.size, 6000);
  assert.equal(calls, 1);
  const db = idb.dbs.get('twinspin');
  assert.equal(db.stores.get('files').data.get(e.id).blob.size, 6000);
  assert.equal(db.stores.get('songs').data.get(e.id).stored, true);
  assert.equal((await lib.saveOffline(e.id)).stored, true, 'saving again is a no-op');
  assert.equal(calls, 1);

  const again = new Library({ indexedDB: idb, storage: null });
  await again.init();
  const r = again.get(e.id);
  assert.equal(r.stored, true);
  assert.equal(r.source, 'subsonic');
  assert.deepEqual({ ...r.remote }, { kind: 'subsonic', serverId: SRV, songId: 's5' });
  assert.equal(Object.isFrozen(r.remote), true);
  assert.equal((await again.getBlob(e.id)).size, 6000, 'plays from the stored copy, no resolver needed');

  const dropped = await again.removeOffline(e.id);
  assert.equal(dropped.stored, false);
  assert.equal(db.stores.get('files').data.has(e.id), false);
  assert.equal(db.stores.get('songs').data.get(e.id).stored, false);
  assert.equal(await again.removeOffline(e.id), null);
  const [f] = await again.add([fakeFile('A file.mp3')]);
  assert.equal(await again.removeOffline(f.id), null, 'a plain file cannot drop its only copy');
  assert.equal((await again.saveOffline(f.id)).stored, true, 'a stored file is already saved');
  await assert.rejects(again.saveOffline('missing'), /no longer in your library/);
});

test('a stored copy that vanished is fetched again; a music-server song only loses its copy to the 60-song cap', async () => {
  let t = 100;
  const idb = new FakeIDB();
  const lib = new Library({ indexedDB: idb, storage: null, now: () => t });
  const log = track(lib);
  await lib.init();
  lib.setResolver('subsonic', async (entry) => fakeBlob(9000 + Number(entry.remote.songId.slice(1))));
  const [r] = await lib.addRemote([song(1)]);
  await lib.saveOffline(r.id);
  // the browser cleared the file: the resolver brings it back
  idb.dbs.get('twinspin').stores.get('files').data.delete(r.id);
  const b = await lib.getBlob(r.id);
  assert.equal(b.size, 9001);
  assert.equal(lib.get(r.id).stored, false);
  await lib.saveOffline(r.id);
  assert.equal(lib.get(r.id).stored, true);
  // fill the library: the offline copy (used least recently) makes room but the song stays listed
  for (let i = 0; i < LIBRARY_CAP; i++) {
    t += 10;
    await lib.add([fakeFile(`song ${i}.mp3`)]);
  }
  const e = lib.get(r.id);
  assert(e, 'still listed');
  assert.equal(e.stored, false);
  assert.equal(idb.dbs.get('twinspin').stores.get('files').data.has(r.id), false);
  assert.equal(lib.list().filter((x) => x.stored).length, LIBRARY_CAP);
  assert.match(log.errors[log.errors.length - 1], /keeps up to 60 songs/);
  // remote songs without a copy do not count toward the 60
  await lib.addRemote([song(2), song(3)]);
  assert.equal(lib.list().filter((x) => !x.demo).length, LIBRARY_CAP + 3);
});

test(`at most ${REMOTE_CAP} music-server songs are listed; the least recently used leave first`, async () => {
  let t = 1;
  const lib = new Library({ indexedDB: null, storage: null, now: () => t });
  const log = track(lib);
  const first = await lib.addRemote(Array.from({ length: REMOTE_CAP }, (_, i) => song(i)));
  assert.equal(first.length, REMOTE_CAP);
  t = 5000000;
  lib.setResolver('subsonic', async () => fakeBlob(10));
  await lib.getBlob(first[0].id); // song 0 was used: it stays
  t += 1;
  const more = await lib.addRemote([song(REMOTE_CAP), song(REMOTE_CAP + 1)]);
  assert.equal(more.length, 2);
  const listed = lib.list().filter((e) => !e.demo);
  assert.equal(listed.length, REMOTE_CAP);
  const ids = new Set(listed.map((e) => e.id));
  assert(ids.has(first[0].id), 'the recently used song stays');
  // one batch is listed in its own order (the first song newest), so its last songs count as the oldest
  const last = first.length - 1;
  assert(!ids.has(first[last].id) && !ids.has(first[last - 1].id), 'the oldest unused songs left');
  assert(ids.has(first[1].id) && ids.has(first[last - 2].id));
  assert(ids.has(more[0].id) && ids.has(more[1].id));
  assert.match(log.errors[log.errors.length - 1], /lists up to 1000 music-server songs/);
});

test('rows from before remote songs existed read as stored file songs (no version bump)', async () => {
  const idb = new FakeIDB();
  const db = new FakeDB();
  db.version = 1;
  db.createObjectStore('songs', { keyPath: 'id' });
  db.createObjectStore('files', { keyPath: 'id' });
  idb.dbs.set('twinspin', db);
  const oldFile = fakeFile('Old - Song.mp3');
  db.stores.get('songs').data.set('s-old', {
    id: 's-old', title: 'Song', artist: 'Old', fileName: 'Old - Song.mp3', size: oldFile.size, type: 'audio/mpeg',
    lastModified: 1, addedAt: 10, lastUsedAt: 10, bpm: 120,
  });
  db.stores.get('files').data.set('s-old', { id: 's-old', blob: oldFile });
  db.stores.get('songs').data.set('s-drive', {
    id: 's-drive', title: 'D', artist: '', fileName: 'D.mp3', size: 10, type: 'audio/mpeg', lastModified: 1, addedAt: 11,
    lastUsedAt: 11, driveFileId: 'FILEID_OLD001',
  });
  db.stores.get('songs').data.set('s-broken', { id: 's-broken', title: 'X', stored: false, addedAt: 12 });
  db.stores.get('songs').data.set('s-remote', {
    id: 's-remote', title: 'R', fileName: 'R.mp3', size: 99, addedAt: 13, source: 'subsonic', stored: false,
    remote: { kind: 'subsonic', serverId: SRV, songId: 'r1' }, coverArt: 'c1', album: 'Al',
  });
  const lib = new Library({ indexedDB: idb, storage: null });
  await lib.init();
  assert.equal(db.upgrades, 0, 'the database version is unchanged');
  const old = lib.get('s-old');
  assert.equal(old.source, 'file');
  assert.equal(old.remote, null);
  assert.equal(old.stored, true);
  assert.equal(old.bpm, 120);
  assert.equal(await lib.getBlob('s-old'), oldFile);
  const drive = lib.get('s-drive');
  assert.equal(drive.source, 'gdrive');
  assert.equal(drive.remote.fileId, 'FILEID_OLD001');
  assert.equal(lib.get('s-broken'), null, 'a row with nothing to play is left out');
  const rem = lib.get('s-remote');
  assert.equal(rem.stored, false);
  assert.equal(rem.album, 'Al');
  assert.equal(rem.coverArt, 'c1');
  // the next save writes the new fields
  await lib.update('s-old', { title: 'Song!' });
  const row = db.stores.get('songs').data.get('s-old');
  assert.equal(row.source, 'file');
  assert.equal(row.stored, true);
  assert.equal(row.remote, null);
  assert.equal(row.title, 'Song!');
});

test('remote songs survive a reload and work in memory mode too; clear() removes them', async () => {
  const idb = new FakeIDB();
  const lib = new Library({ indexedDB: idb, storage: null });
  await lib.init();
  const added = await lib.addRemote([song(1), song(2)]);
  const reload = new Library({ indexedDB: idb, storage: null });
  await reload.init();
  const back = reload.list().filter((e) => !e.demo);
  assert.deepEqual(back.map((e) => e.id), added.map((e) => e.id));
  assert.equal(back[0].stored, false);
  assert.equal(back[0].title, 'Song 1');
  await reload.update(back[0].id, { bpm: 126.5, album: 'New album' });
  assert.equal(reload.get(back[0].id).album, 'New album');
  await reload.remove(back[1].id);
  assert.equal(idb.dbs.get('twinspin').stores.get('songs').data.has(back[1].id), false);
  await reload.clear();
  assert.equal(reload.list().filter((e) => !e.demo).length, 0);
  assert.equal(idb.dbs.get('twinspin').stores.get('songs').data.size, 0);
});
