// Tests for the set list model (src/deck/playlist.js): adding library and demo songs, order changes, the current
// song pointer, persistence in settings.setList and keeping up with the library.
import { Emitter } from '../src/core/emitter.js';
import { Playlist, itemRef, titleFromFileName, MAX_SET_LIST } from '../src/deck/playlist.js';
import { mulberry32 } from '../src/core/util.js';

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

// ---- music player queue (docs/PLAYER.md section 2) ------------------------------------------------------------

/** A library of n songs q0..q(n-1). */
const many = (n) => Array.from({ length: n }, (_, i) => ({ id: `q${i}`, title: `Song ${i}`, fileName: `q${i}.mp3` }));

/** A playlist of library songs q0..q(n-1), a seeded shuffle and a settings stub. */
function queue(n = 8, { seed = 7, shuffle = false } = {}) {
  const settings = new FakeSettings({ setList: [], playerShuffle: shuffle });
  const library = new FakeLibrary(many(n + 20));
  const pl = new Playlist({ settings, library, random: mulberry32(seed) });
  pl.add(Array.from({ length: n }, (_, i) => ({ id: `q${i}` })));
  return { settings, library, pl };
}

test('addNext: right after the current song, at the top when none is current, several in order', () => {
  const { pl, settings } = setup();
  pl.add([{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
  const [a, b, c] = pl.items;
  const [x] = pl.addNext({ kind: 'demo', id: 0 });
  assert.equal(pl.items[0], x, 'nothing current: it is next = the top');
  assert.equal(pl.peekNext(), x);
  pl.setCurrent(b.uid);
  const [y, z] = pl.addNext([{ kind: 'demo', id: 1 }, { id: 's1' }]);
  assert.deepEqual(uids(pl), [x.uid, a.uid, b.uid, y.uid, z.uid, c.uid]);
  assert.equal(pl.peekNext(), y);
  assert.equal(pl.current, b, 'the current song stays current');
  assert.deepEqual(settings.get('setList').map((r) => r.id), [0, 's1', 's2', 1, 's1', 's3']);
  assert.deepEqual(pl.addNext([{ nonsense: 1 }]), []);
});

test('setShuffle: only the upcoming songs, seeded, saved; off restores their order', () => {
  const { pl, settings } = queue(8);
  pl.setCurrent(2);
  const before = uids(pl);
  assert.equal(pl.shuffle, false);
  assert.equal(pl.setShuffle(true), true);
  assert.equal(pl.shuffle, true);
  assert.equal(settings.get('playerShuffle'), true);
  const after = uids(pl);
  assert.deepEqual(after.slice(0, 3), before.slice(0, 3), 'played songs and the current one stay put');
  assert.deepEqual([...after.slice(3)].sort(), [...before.slice(3)].sort(), 'a permutation of the upcoming songs');
  assert.notDeepEqual(after.slice(3), before.slice(3), 'in another order');
  assert.equal(pl.currentIndex, 2);
  assert.deepEqual(settings.get('setList').map((r) => r.id), pl.items.map((x) => x.id), 'the new order is saved');
  // the same seed gives the same order (deterministic tests)
  const again = queue(8);
  again.pl.setCurrent(2);
  again.pl.setShuffle(true);
  assert.deepEqual(again.pl.items.map((x) => x.id), pl.items.map((x) => x.id));
  assert.equal(pl.setShuffle(true), false, 'already on');
  // off: the upcoming songs go back to their old order
  assert.equal(pl.setShuffle(false), true);
  assert.deepEqual(uids(pl), before);
  assert.equal(settings.get('playerShuffle'), false);
  // nothing current: the whole list is upcoming
  const all = queue(8, { seed: 5 });
  const order = uids(all.pl);
  all.pl.setShuffle(true);
  assert.notDeepEqual(uids(all.pl), order);
  all.pl.setShuffle(false);
  assert.deepEqual(uids(all.pl), order);
});

test('shuffle: songs played meanwhile stay where they are; songs added meanwhile follow at the end', () => {
  const { pl } = queue(8, { seed: 11 });
  pl.setCurrent(0);
  const before = uids(pl);
  pl.setShuffle(true);
  // two songs are played in the shuffled order
  pl.advance();
  pl.advance();
  const played = uids(pl).slice(0, 3);
  // add (random upcoming position) and addNext (right next) while shuffled
  const [r] = pl.add({ id: 'q20' });
  assert(pl.indexOf(r.uid) > pl.currentIndex, 'a random UPCOMING position');
  const [nx] = pl.addNext({ id: 'q21' });
  assert.equal(pl.indexOf(nx.uid), pl.currentIndex + 1, 'play next stays right next while shuffled');
  const addedOrder = uids(pl).filter((u) => u === r.uid || u === nx.uid);
  pl.setShuffle(false);
  const now = uids(pl);
  assert.equal(now.length, 10);
  assert.deepEqual(now.slice(0, 3), played, 'history untouched');
  const upcomingOld = before.filter((u) => !played.includes(u));
  assert.deepEqual(now.slice(3, 3 + upcomingOld.length), upcomingOld, 'the remaining songs in their old order');
  assert.deepEqual(now.slice(3 + upcomingOld.length), addedOrder, 'the added ones after them (in their order)');
});

test('shuffle: add() spreads new songs over the upcoming positions', () => {
  const { pl } = queue(6, { seed: 3 });
  pl.setCurrent(1);
  pl.setShuffle(true);
  const atEnd = [];
  const spots = new Set();
  for (let i = 0; i < 12; i++) {
    const [it] = pl.add({ id: `q${6 + i}` });
    const at = pl.indexOf(it.uid);
    assert(at >= 2 && at < pl.length, `upcoming (${at})`);
    atEnd.push(at === pl.length - 1);
    spots.add(at);
  }
  assert(atEnd.includes(false), 'not simply appended');
  assert(spots.size >= 6, `spread over the upcoming positions (${[...spots]})`);
  assert.equal(pl.currentIndex, 1);
  // an explicit index still wins
  const [top] = pl.add({ kind: 'demo', id: 0 }, { at: 0 });
  assert.equal(pl.items[0], top);
});

test('previous, rewind and peekNext with repeat', () => {
  const { pl } = queue(4);
  const [a, b, c, d] = pl.items;
  assert.equal(pl.previous(), null, 'nothing current');
  assert.equal(pl.peekNext({ repeat: 'one' }), a, 'repeat one, nothing current: the first song');
  pl.setCurrent(c.uid);
  assert.equal(pl.previous(), b);
  assert.equal(pl.current, b);
  assert.equal(pl.previous(), a);
  assert.equal(pl.previous(), null, 'at the top');
  assert.equal(pl.current, a);
  pl.setCurrent(d.uid);
  assert.equal(pl.peekNext(), null);
  assert.equal(pl.peekNext({ repeat: 'off' }), null);
  assert.equal(pl.peekNext({ repeat: 'all' }), a, 'repeat all: the top again after the last song');
  assert.equal(pl.peekNext({ repeat: 'one' }), d, 'repeat one: the same song');
  pl.setCurrent(b.uid);
  assert.equal(pl.peekNext({ repeat: 'all' }), c);
  let changes = 0;
  pl.on('change', () => changes++);
  assert.equal(pl.rewind(), a);
  assert.equal(pl.currentIndex, 0);
  assert(!pl.isPlayed(a.uid) && !pl.isPlayed(c.uid), 'everything unplayed again');
  assert.equal(changes, 1);
  pl.rewind();
  assert.equal(changes, 1, 'no change the second time');
  const empty = new Playlist();
  assert.equal(empty.rewind(), null);
  assert.equal(empty.peekNext({ repeat: 'all' }), null);
});

test('shuffle from settings: restored on start (order kept), outside changes applied, reset turns it off', () => {
  const { pl, settings } = queue(6, { shuffle: true });
  assert.equal(pl.shuffle, true, 'restored from settings.playerShuffle');
  const order = uids(pl);
  pl.setShuffle(false);
  assert.deepEqual(uids(pl), order, 'nothing remembered from before the reload: the order stays');
  settings.set('playerShuffle', true); // the Settings sheet
  assert.equal(pl.shuffle, true);
  assert.notDeepEqual(uids(pl), order);
  settings.set('playerShuffle', false); // e.g. Reset all settings
  assert.equal(pl.shuffle, false);
  assert.deepEqual(uids(pl), order, 'the order from before shuffling');
});

test('removeMany / clearUpcoming: one save and one change; the current song handled like remove()', () => {
  const { pl, settings } = queue(6);
  const [a, b, c, d, e, f] = pl.items;
  pl.setCurrent(c.uid);
  let changes = 0;
  pl.on('change', () => changes++);
  const writes = settings.writes;
  assert.equal(pl.removeMany([b.uid, 'nope', e.uid]), 2);
  assert.deepEqual(uids(pl), [a.uid, c.uid, d.uid, f.uid]);
  assert.equal(changes, 1);
  assert.equal(settings.writes, writes + 1, 'saved once');
  assert.equal(pl.current, c);
  // the current song and the one before it go: the nearest song before them that stays is current
  assert.equal(pl.removeMany([c.uid, a.uid]), 2);
  assert.equal(pl.currentIndex, -1, 'nothing before them: none current, the next song is next');
  assert.equal(pl.peekNext(), d);
  assert.equal(pl.removeMany([]), 0);
  assert.equal(pl.removeMany(null), 0);
  assert.equal(changes, 2);
  // clear the queue after the current song
  pl.setCurrent(d.uid);
  pl.add([{ id: 'q10' }, { id: 'q11' }]);
  assert.equal(pl.clearUpcoming(), 3);
  assert.deepEqual(uids(pl), [d.uid]);
  assert.equal(pl.current, d);
  assert.equal(pl.clearUpcoming(), 0);
  pl.setCurrent(-1);
  assert.equal(pl.clearUpcoming(), 1, 'none current: everything is upcoming');
  assert.equal(pl.length, 0);
});

test('reshuffle: shuffle on, a new order for the upcoming songs (repeat all, a new round); shuffle off still restores', () => {
  const { pl, settings } = queue(8, { seed: 3 });
  const original = uids(pl);
  assert.equal(pl.reshuffle(), false, 'shuffle is off: nothing happens');
  assert.deepEqual(uids(pl), original);
  pl.setShuffle(true);
  pl.setCurrent(0);
  const round1 = uids(pl);
  let changes = 0;
  const off = pl.on('change', () => changes++);
  assert.equal(pl.reshuffle(), true);
  off();
  assert.equal(changes, 1, 'one change');
  const round2 = uids(pl);
  assert.equal(round2[0], round1[0], 'the current song stays first');
  assert.equal(pl.currentIndex, 0);
  assert.deepEqual(round2.slice(1).sort(), round1.slice(1).sort());
  assert.notDeepEqual(round2.slice(1), round1.slice(1), 'another order');
  assert.deepEqual(settings.get('setList').map((r) => r.id), pl.items.map((x) => x.id), 'saved');
  // shuffle off: the order from before shuffling
  pl.setShuffle(false);
  const head = uids(pl)[0];
  assert.deepEqual(uids(pl).slice(1), original.filter((u) => u !== head));
  // fewer than two upcoming songs: nothing to do
  const small = queue(2, { seed: 3, shuffle: true });
  small.pl.setCurrent(0);
  assert.equal(small.pl.reshuffle(), false);
});
