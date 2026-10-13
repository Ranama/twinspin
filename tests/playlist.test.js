// Tests for the set list model (src/deck/playlist.js): adding library and demo songs, order changes, the current
// song pointer, persistence in settings.setList and keeping up with the library.
import { Emitter } from '../src/core/emitter.js';
import { Playlist, itemRef, titleFromFileName, MAX_SET_LIST } from '../src/deck/playlist.js';

class FakeSettings extends Emitter {
  constructor(values = {}) {
    super();
    this.v = { setList: [], ...values };
    this.writes = 0;
  }
  get(k) {
    return this.v[k];
  }
  set(k, x) {
    if (this.v[k] === x) return;
    this.v[k] = x;
    this.writes++;
    this.emit('change', k, x);
  }
}

class FakeLibrary extends Emitter {
  constructor(entries = [], loaded = true) {
    super();
    this.entries = entries;
    this.loaded = loaded;
  }
  get(id) {
    const e = this.entries.find((x) => x.id === id);
    return e ? { ...e } : null;
  }
  list() {
    return this.entries.map((e) => ({ ...e })).concat([{ id: 'demo-0', demo: true, source: 'demo', demoId: 0, title: 'Neon Drift', bpm: 124 }]);
  }
  remove(id) {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.emit('change');
  }
}

const songs = () => [
  { id: 's1', title: 'First', artist: 'Ann', fileName: 'first.mp3', bpm: 124, duration: 200 },
  { id: 's2', title: '', artist: '', fileName: 'Bob_-_Second Song.mp3', duration: 180 },
  { id: 's3', title: 'Third', artist: 'Cy', fileName: 'third.wav' },
];

function setup(saved = [], { loaded = true } = {}) {
  const settings = new FakeSettings({ setList: saved });
  const library = new FakeLibrary(songs(), loaded);
  const pl = new Playlist({ settings, library });
  let changes = 0;
  pl.on('change', () => changes++);
  return { settings, library, pl, changes: () => changes };
}

const uids = (pl) => pl.items.map((x) => x.uid);
const ids = (pl) => pl.items.map((x) => `${x.kind}:${x.id}`);

test('itemRef and titleFromFileName', () => {
  assert.deepEqual(itemRef({ id: 's1', title: 'x' }), { kind: 'library', id: 's1' });
  assert.deepEqual(itemRef({ kind: 'demo', id: 1 }), { kind: 'demo', id: 1 });
  assert.deepEqual(itemRef({ id: 'demo-1', demo: true, demoId: 1 }), { kind: 'demo', id: 1 });
  assert.deepEqual(itemRef({ id: 'demo-0' }), { kind: 'demo', id: 0 });
  assert.deepEqual(itemRef({ kind: 'library', id: 's9' }), { kind: 'library', id: 's9' });
  assert.equal(itemRef({ kind: 'demo', id: 7 }), null);
  assert.equal(itemRef({ id: 42 }), null);
  assert.equal(itemRef(null), null);
  assert.equal(titleFromFileName('Artist_Name - Tune.mp3'), 'Artist Name - Tune');
  assert.equal(titleFromFileName(''), '');
});

test('add: library and demo songs, duplicates allowed, details from the library, saved as { kind, id }', () => {
  const { pl, settings, changes } = setup();
  assert.equal(pl.length, 0);
  assert.equal(pl.currentIndex, -1);
  assert.equal(pl.peekNext(), null);
  const lib = new FakeLibrary(songs());
  const added = pl.add(lib.list().slice(0, 2));
  assert.equal(added.length, 2);
  pl.add({ kind: 'demo', id: 1 });
  pl.add({ id: 's1' }); // the same song again
  assert.deepEqual(ids(pl), ['library:s1', 'library:s2', 'demo:1', 'library:s1']);
  assert.equal(new Set(uids(pl)).size, 4, 'every copy has its own uid');
  const [a, b, c] = pl.items;
  assert.equal(a.title, 'First');
  assert.equal(a.artist, 'Ann');
  assert.equal(a.bpm, 124);
  assert.equal(a.duration, 200);
  assert.equal(b.title, 'Bob - Second Song', 'title from the file name');
  assert.equal(b.bpm, undefined);
  assert.equal(c.title, 'Spore Garden');
  assert.equal(c.bpm, 128);
  assert.equal(c.duration, 96);
  assert(Object.isFrozen(a) && Object.isFrozen(pl.items));
  assert.deepEqual(settings.get('setList'), [
    { kind: 'library', id: 's1' }, { kind: 'library', id: 's2' }, { kind: 'demo', id: 1 }, { kind: 'library', id: 's1' },
  ]);
  assert.equal(changes(), 3);
  // insert at the top; junk is ignored
  pl.add([{ kind: 'demo', id: 0 }, { nonsense: true }], { at: 0 });
  assert.deepEqual(ids(pl).slice(0, 2), ['demo:0', 'library:s1']);
  assert.deepEqual(pl.add([{ id: 5 }]), []);
  assert.equal(changes(), 4);
});

test('current song, next, advance and played', () => {
  const { pl } = setup();
  pl.add([{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
  const [a, b, c] = pl.items;
  assert.equal(pl.peekNext(), a, 'nothing played yet: the first song is next');
  assert.equal(pl.advance(), a);
  assert.equal(pl.currentIndex, 0);
  assert.equal(pl.current, a);
  assert.equal(pl.peekNext(), b);
  pl.setCurrent(c.uid);
  assert.equal(pl.currentIndex, 2);
  assert(pl.isPlayed(a.uid) && pl.isPlayed(b.uid) && !pl.isPlayed(c.uid));
  assert.equal(pl.peekNext(), null);
  assert.equal(pl.advance(), null, 'end of the list');
  assert.equal(pl.currentIndex, 2);
  pl.setCurrent(1);
  assert.equal(pl.current, b);
  pl.setCurrent(-1);
  assert.equal(pl.currentIndex, -1);
  pl.setCurrent('nope');
  assert.equal(pl.currentIndex, -1);
});

test('remove and move keep the current song; removing it keeps the next one next', () => {
  const { pl, settings } = setup();
  pl.add([{ id: 's1' }, { id: 's2' }, { id: 's3' }, { kind: 'demo', id: 0 }]);
  const [a, b, c, d] = pl.items;
  pl.setCurrent(b.uid);
  assert(pl.move(d.uid, 0));
  assert.deepEqual(uids(pl), [d.uid, a.uid, b.uid, c.uid]);
  assert.equal(pl.current, b, 'still the current song');
  assert.equal(pl.currentIndex, 2);
  assert.equal(pl.peekNext(), c);
  assert(pl.move(b.uid, 99)); // to the end (clamped)
  assert.deepEqual(uids(pl), [d.uid, a.uid, c.uid, b.uid]);
  assert.equal(pl.peekNext(), null);
  assert.equal(pl.move(b.uid, 3), false, 'no change');
  assert.equal(pl.move('zz', 0), false);
  pl.move(b.uid, 1);
  assert.deepEqual(uids(pl), [d.uid, b.uid, a.uid, c.uid]);
  // removing the current song: the song before it becomes current, so a is still next
  assert(pl.remove(b.uid));
  assert.equal(pl.current, d);
  assert.equal(pl.peekNext(), a);
  // removing a played song shifts the index, not the song
  pl.setCurrent(a.uid);
  pl.remove(d.uid);
  assert.equal(pl.current, a);
  assert.equal(pl.currentIndex, 0);
  // removing the first song while it is current: none is current, the following one is next
  pl.remove(a.uid);
  assert.equal(pl.currentIndex, -1);
  assert.equal(pl.peekNext(), c);
  assert.equal(pl.remove('zz'), false);
  assert.deepEqual(settings.get('setList'), [{ kind: 'library', id: 's3' }]);
  pl.clear();
  assert.equal(pl.length, 0);
  assert.equal(pl.currentIndex, -1);
  assert.deepEqual(settings.get('setList'), []);
});

test('restore from settings; songs the library lost are dropped once it has loaded', () => {
  const saved = [{ kind: 'library', id: 's2' }, { kind: 'demo', id: 1 }, { kind: 'library', id: 'gone' }, { kind: 'demo', id: 9 }, 'x'];
  // library not read yet: unknown songs stay (with a placeholder title)
  const early = setup(saved, { loaded: false });
  assert.deepEqual(ids(early.pl), ['library:s2', 'demo:1', 'library:gone']);
  assert.equal(early.pl.items[2].title, 'Untitled');
  early.library.loaded = true;
  early.library.emit('change');
  assert.deepEqual(ids(early.pl), ['library:s2', 'demo:1']);
  assert.deepEqual(early.settings.get('setList'), [{ kind: 'library', id: 's2' }, { kind: 'demo', id: 1 }]);
  // a loaded library at construction: dropped at once
  const now = setup(saved);
  assert.deepEqual(ids(now.pl), ['library:s2', 'demo:1']);
  assert.equal(now.pl.items[0].title, 'Bob - Second Song');
  // a library without `loaded` counts as loaded after its first 'change'
  const settings = new FakeSettings({ setList: saved });
  const lib = new FakeLibrary(songs());
  delete lib.loaded;
  const pl = new Playlist({ settings, library: lib });
  assert.equal(pl.length, 3);
  lib.emit('change');
  assert.equal(pl.length, 2);
});

test('library changes: details refresh, removed songs leave (also the current one)', () => {
  const { pl, library, changes } = setup();
  pl.add([{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
  const [, b] = pl.items;
  const n0 = changes();
  library.entries[1].bpm = 126.5;
  library.entries[1].title = 'Second';
  library.emit('change');
  assert.equal(pl.items[1].title, 'Second');
  assert.equal(pl.items[1].bpm, 126.5);
  assert.equal(pl.items[1].uid, b.uid);
  assert.notEqual(pl.items[1], b, 'a new frozen object');
  assert.equal(changes(), n0 + 1);
  library.emit('change'); // nothing new
  assert.equal(changes(), n0 + 1);
  pl.setCurrent(b.uid);
  library.remove('s2');
  assert.deepEqual(ids(pl), ['library:s1', 'library:s3']);
  assert.equal(pl.currentIndex, 0, 'the song before the removed current one');
  assert.equal(pl.peekNext().id, 's3');
});

test('an outside settings change (reset) reloads the list; the cap holds', () => {
  const { pl, settings } = setup();
  pl.add([{ id: 's1' }, { id: 's2' }]);
  settings.set('setList', []);
  assert.equal(pl.length, 0);
  settings.set('setList', [{ kind: 'demo', id: 0 }]);
  assert.deepEqual(ids(pl), ['demo:0']);
  const many = Array.from({ length: MAX_SET_LIST + 10 }, () => ({ kind: 'demo', id: 1 }));
  pl.add(many);
  assert.equal(pl.length, MAX_SET_LIST);
  assert.deepEqual(pl.add({ kind: 'demo', id: 0 }), []);
  // without settings or a library it still works in memory
  const bare = new Playlist();
  bare.add({ kind: 'demo', id: 1 });
  bare.add({ id: 'x1', title: 'Hint title' });
  assert.equal(bare.length, 2);
  assert.equal(bare.items[1].title, 'Hint title');
});
