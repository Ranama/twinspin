// Tests for src/sources/drive-links.js (the saved Google Drive links): canonical links, save / dedupe / newest
// used first, renaming (kept when imported again), remove / clear, persistence across instances, corrupt and
// blocked storage, the 100-link cap (least recently used go first), 'storage' events from another tab, a tab
// that missed those events (it never writes over another tab's links) and a blocked list that events never empty.
import { DRIVE_LINKS_KEY, MAX_SAVED_LINKS, SavedDriveLinks, driveLinkUrl } from '../src/sources/drive-links.js';

const FOLDER = '0BwwA4oUTeiV1TGRPeTVjaWRDY1E';
const FILE = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';

/** A clock the test moves. */
function clock(start = 1000) {
  const c = { t: start };
  c.now = () => c.t;
  return c;
}

/** Where 'storage' events arrive (a window stand-in). */
function events() {
  const fns = new Set();
  return {
    addEventListener: (type, fn) => type === 'storage' && fns.add(fn),
    removeEventListener: (type, fn) => fns.delete(fn),
    fire: (e) => {
      for (const fn of [...fns]) fn(e);
    },
    get count() {
      return fns.size;
    },
  };
}

function make(extra = {}) {
  const c = extra.clock || clock();
  const storage = 'storage' in extra ? extra.storage : new Storage();
  const links = new SavedDriveLinks({ storage, now: c.now, events: extra.events || null, max: extra.max });
  const changes = [];
  links.on('change', (why) => changes.push(why));
  return { links, storage, clock: c, changes };
}

const id = (i) => `1link_${String(i).padStart(4, '0')}_xxxxxxxx`;

test('canonical links: folder and file, the resource key kept, anything else empty', () => {
  assert.equal(driveLinkUrl('folder', FOLDER), `https://drive.google.com/drive/folders/${FOLDER}`);
  assert.equal(driveLinkUrl('file', FILE), `https://drive.google.com/file/d/${FILE}/view`);
  assert.equal(driveLinkUrl('folder', FOLDER, '0-abc_DEF'), `https://drive.google.com/drive/folders/${FOLDER}?resourcekey=0-abc_DEF`);
  assert.equal(driveLinkUrl('file', FILE, '0-RK'), `https://drive.google.com/file/d/${FILE}/view?resourcekey=0-RK`);
  assert.equal(driveLinkUrl('file', FILE, 'bad key&x=1'), `https://drive.google.com/file/d/${FILE}/view`, 'a strange key is left out');
  assert.equal(driveLinkUrl('folder', 'short'), '');
  assert.equal(driveLinkUrl('folder', 'javascript:alert(1)//xxxxxxxx'), '');
  assert.equal(driveLinkUrl('folder', ''), '');
});

test('save: new links first, the same id updates its entry (dedupe), newest used first', () => {
  const { links, clock: c, changes } = make();
  assert.equal(links.size, 0);
  assert.deepEqual(links.list(), []);
  assert.equal(links.persistent, true);
  const a = links.save({ id: FOLDER, kind: 'folder', name: 'Road Trip', songCount: 9 });
  assert.deepEqual({ ...a }, {
    id: FOLDER, kind: 'folder', url: `https://drive.google.com/drive/folders/${FOLDER}`, resourceKey: '',
    name: 'Road Trip', renamed: false, songCount: 9, addedAt: 1000, lastImportedAt: 1000,
  });
  assert(Object.isFrozen(a));
  c.t = 2000;
  links.save({ id: FILE, kind: 'file', name: 'Midnight Signal', songCount: 1, resourceKey: '0-RK' });
  assert.deepEqual(links.list().map((l) => l.id), [FILE, FOLDER], 'newest used first');
  assert.equal(links.get(FILE).url, `https://drive.google.com/file/d/${FILE}/view?resourcekey=0-RK`);
  // imported again: one entry, new count / time, the first date kept, back at the top
  c.t = 3000;
  const again = links.save({ id: FOLDER, kind: 'folder', name: 'Road Trip 2026', songCount: 12, url: 'https://evil.example/' });
  assert.equal(links.size, 2);
  assert.deepEqual(links.list().map((l) => l.id), [FOLDER, FILE]);
  assert.equal(again.name, 'Road Trip 2026');
  assert.equal(again.songCount, 12);
  assert.equal(again.addedAt, 1000);
  assert.equal(again.lastImportedAt, 3000);
  assert.equal(again.url, `https://drive.google.com/drive/folders/${FOLDER}`, 'the url is always rebuilt from the id');
  // a save without a name or count keeps the known ones; the resource key stays
  c.t = 4000;
  const kept = links.save({ id: FILE, kind: 'file' });
  assert.equal(kept.name, 'Midnight Signal');
  assert.equal(kept.songCount, 1);
  assert.equal(kept.resourceKey, '0-RK');
  // two saves in the same millisecond still keep their order
  links.save({ id: FOLDER, kind: 'folder' });
  assert.deepEqual(links.list().map((l) => l.id), [FOLDER, FILE]);
  // nothing usable: nothing saved, no event
  const before = changes.length;
  assert.equal(links.save({ id: 'short', kind: 'folder' }), null);
  assert.equal(links.save({ id: FOLDER, kind: 'document' }), null);
  assert.equal(links.save(null), null);
  assert.equal(changes.length, before);
  assert.deepEqual(changes, ['save', 'save', 'save', 'save', 'save']);
  assert.equal(links.get('nope'), null);
  assert.equal(links.get(null), null);
});

test('rename: the user\'s name stays when the link is imported again; empty names are refused', () => {
  const { links, clock: c, changes } = make();
  links.save({ id: FOLDER, kind: 'folder', name: 'Road Trip', songCount: 9 });
  assert.equal(links.rename(FOLDER, '  Car \n songs  '), true);
  assert.equal(links.get(FOLDER).name, 'Car songs', 'one line, trimmed');
  assert.equal(links.get(FOLDER).renamed, true);
  assert.equal(changes[changes.length - 1], 'rename');
  c.t = 5000;
  const again = links.save({ id: FOLDER, kind: 'folder', name: 'Road Trip', songCount: 10 });
  assert.equal(again.name, 'Car songs');
  assert.equal(again.songCount, 10);
  assert.equal(links.rename(FOLDER, '   '), false);
  assert.equal(links.rename('unknown-id-000000', 'x'), false);
  assert.equal(links.get(FOLDER).name, 'Car songs');
  assert.equal(links.rename(FOLDER, 'x'.repeat(300)), true);
  assert.equal(links.get(FOLDER).name.length, 120, 'long names are cut');
});

test('remove and clear', () => {
  const { links, storage, changes } = make();
  links.save({ id: FOLDER, kind: 'folder', name: 'A' });
  links.save({ id: FILE, kind: 'file', name: 'B' });
  assert.equal(links.remove(FOLDER), true);
  assert.equal(links.remove(FOLDER), false);
  assert.deepEqual(links.list().map((l) => l.id), [FILE]);
  assert.equal(changes[changes.length - 1], 'remove');
  links.clear();
  assert.equal(links.size, 0);
  assert.equal(storage.getItem(DRIVE_LINKS_KEY), null, 'nothing left in storage');
  assert.equal(changes[changes.length - 1], 'clear');
  const n = changes.length;
  links.clear();
  assert.equal(changes.length, n, 'clearing an empty list says nothing');
});

test('persistence: a new instance (a reload) reads the same links from storage', () => {
  const { links, storage, clock: c } = make();
  links.save({ id: FOLDER, kind: 'folder', name: 'Road Trip', songCount: 9, resourceKey: '0-xyz' });
  c.t = 2000;
  links.save({ id: FILE, kind: 'file', name: 'Midnight' });
  links.rename(FILE, 'Late night');
  const stored = JSON.parse(storage.getItem(DRIVE_LINKS_KEY));
  assert.equal(stored.v, 1);
  assert.equal(stored.links.length, 2);
  const reloaded = new SavedDriveLinks({ storage, now: () => 9000, events: null });
  assert.deepEqual(reloaded.list(), links.list());
  assert.equal(reloaded.get(FILE).renamed, true);
  // a save after the reload is newer than everything loaded, even with a clock that went back
  const back = new SavedDriveLinks({ storage, now: () => 10, events: null });
  back.save({ id: FOLDER, kind: 'folder' });
  assert.equal(back.list()[0].id, FOLDER);
  assert(back.get(FOLDER).lastImportedAt > 2000);
});

test('corrupt or strange storage: broken entries are skipped, never an error', () => {
  const storage = new Storage();
  storage.setItem(DRIVE_LINKS_KEY, '{not json');
  assert.deepEqual(new SavedDriveLinks({ storage, events: null }).list(), []);
  storage.setItem(DRIVE_LINKS_KEY, JSON.stringify({ v: 1, links: 'nope' }));
  assert.deepEqual(new SavedDriveLinks({ storage, events: null }).list(), []);
  storage.setItem(DRIVE_LINKS_KEY, JSON.stringify(42));
  assert.deepEqual(new SavedDriveLinks({ storage, events: null }).list(), []);
  storage.setItem(DRIVE_LINKS_KEY, JSON.stringify({ v: 1, links: [
    null, 7, 'x',
    { id: 'bad id!', kind: 'folder' },
    { id: FOLDER, kind: 'album' },
    { id: FOLDER, kind: 'folder', name: 'Old\u0000name', url: 'javascript:alert(1)', songCount: -3, resourceKey: '<b>',
      addedAt: 'x', lastImportedAt: 500 },
    { id: FOLDER, kind: 'folder', name: 'Newer copy', lastImportedAt: 600, renamed: true },
    { id: FILE, kind: 'file', name: 42, songCount: 2.7, addedAt: 100, lastImportedAt: 0 },
  ] }));
  const links = new SavedDriveLinks({ storage, events: null });
  assert.deepEqual(links.list().map((l) => l.id), [FOLDER, FILE]);
  const f = links.get(FOLDER);
  assert.equal(f.name, 'Newer copy', 'a duplicate id keeps the most recently used copy');
  assert.equal(f.url, `https://drive.google.com/drive/folders/${FOLDER}`);
  assert.equal(f.renamed, true);
  const g = links.get(FILE);
  assert.equal(g.name, '');
  assert.equal(g.songCount, 2);
  assert.equal(g.lastImportedAt, 100, 'no import time: the date it was added');
  // an older list stored as a bare array
  storage.setItem(DRIVE_LINKS_KEY, JSON.stringify([{ id: FILE, kind: 'file', name: 'Solo', lastImportedAt: 5 }]));
  assert.equal(new SavedDriveLinks({ storage, events: null }).get(FILE).name, 'Solo');
});

test('blocked storage: the links work for this visit, nothing throws', () => {
  const throwing = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
    removeItem() {
      throw new Error('SecurityError');
    },
  };
  const { links } = make({ storage: throwing });
  assert.deepEqual(links.list(), []);
  links.save({ id: FOLDER, kind: 'folder', name: 'Road Trip' });
  assert.equal(links.persistent, false);
  assert.equal(links.get(FOLDER).name, 'Road Trip');
  links.clear();
  assert.equal(links.size, 0);
  const none = make({ storage: null }).links;
  assert.equal(none.persistent, false);
  none.save({ id: FILE, kind: 'file' });
  assert.equal(none.size, 1);
});

test('the cap: at most 100 links; the least recently used go first', () => {
  const { links, storage, clock: c } = make();
  assert.equal(MAX_SAVED_LINKS, 100);
  for (let i = 0; i < MAX_SAVED_LINKS; i++) {
    c.t = 1000 + i;
    links.save({ id: id(i), kind: 'folder', name: `Folder ${i}` });
  }
  assert.equal(links.size, 100);
  c.t = 5000;
  links.save({ id: id(0), kind: 'folder' }); // the oldest is used again: it stays
  for (let i = 100; i < 103; i++) {
    c.t = 6000 + i;
    links.save({ id: id(i), kind: 'folder' });
  }
  assert.equal(links.size, 100);
  assert(links.get(id(0)), 'used again: kept');
  for (const gone of [1, 2, 3]) assert.equal(links.get(id(gone)), null, `link ${gone} dropped`);
  assert(links.get(id(4)));
  assert.equal(links.list()[0].id, id(102));
  assert.equal(JSON.parse(storage.getItem(DRIVE_LINKS_KEY)).links.length, 100);
  // a stored list longer than the cap is trimmed on load (here a smaller cap)
  const small = new SavedDriveLinks({ storage, events: null, max: 10 });
  assert.equal(small.size, 10);
  assert.equal(small.list()[0].id, id(102));
});

test('another tab: a storage event reloads the list and says so; other keys are ignored', () => {
  const storage = new Storage();
  const winA = events();
  const winB = events();
  const tabA = make({ storage, events: winA });
  const tabB = make({ storage, events: winB });
  assert.equal(winB.count, 1);
  tabA.links.save({ id: FOLDER, kind: 'folder', name: 'Road Trip' });
  assert.equal(tabB.links.size, 0, 'no event yet');
  winB.fire({ key: 'twinspin.settings', storageArea: storage });
  assert.equal(tabB.links.size, 0);
  assert.deepEqual(tabB.changes, []);
  winB.fire({ key: DRIVE_LINKS_KEY, storageArea: new Storage() });
  assert.equal(tabB.links.size, 0, 'an event about another storage (sessionStorage) is ignored');
  winB.fire({ key: DRIVE_LINKS_KEY, storageArea: storage, newValue: storage.getItem(DRIVE_LINKS_KEY) });
  assert.equal(tabB.links.get(FOLDER).name, 'Road Trip');
  assert.deepEqual(tabB.changes, ['storage']);
  // the other tab renames and removes: tab B follows
  tabA.links.rename(FOLDER, 'Car songs');
  winB.fire({ key: DRIVE_LINKS_KEY, storageArea: storage });
  assert.equal(tabB.links.get(FOLDER).name, 'Car songs');
  tabA.links.remove(FOLDER);
  winB.fire({ key: DRIVE_LINKS_KEY, storageArea: storage });
  assert.equal(tabB.links.size, 0);
  // the browser cleared the site's storage (key null)
  tabB.links.save({ id: FILE, kind: 'file' });
  storage.clear();
  winB.fire({ key: null, storageArea: storage });
  assert.equal(tabB.links.size, 0);
  // dispose: no more updates
  tabB.links.dispose();
  assert.equal(winB.count, 0);
});

test('a tab that missed the storage events (frozen, cached) never writes over links another tab saved', () => {
  const storage = new Storage();
  const c = clock();
  const tabA = make({ storage, clock: c });
  const tabB = make({ storage, clock: c }); // no events reach it
  tabA.links.save({ id: FOLDER, kind: 'folder', name: 'Road Trip', songCount: 9 });
  c.t = 2000;
  tabB.links.save({ id: FILE, kind: 'file', name: 'Midnight' });
  const stored = () => JSON.parse(storage.getItem(DRIVE_LINKS_KEY)).links.map((l) => l.id);
  assert.deepEqual(stored(), [FILE, FOLDER], 'both links stored');
  assert.deepEqual(tabB.links.list().map((l) => l.id), [FILE, FOLDER]);
  // rename / remove in a stale tab work on the stored list too
  tabA.links.rename(FILE, 'Late night');
  assert.equal(tabA.links.get(FILE).name, 'Late night');
  tabB.links.remove(FOLDER);
  assert.deepEqual(stored(), [FILE]);
  assert.equal(JSON.parse(storage.getItem(DRIVE_LINKS_KEY)).links[0].name, 'Late night', 'the other tab\'s rename kept');
  assert.equal(tabA.links.remove(FOLDER), false, 'already removed in the other tab');
  // a tab whose writes fail keeps its own links in memory and does not read them away
  const full = new Storage();
  let quota = false;
  const store = { getItem: (k) => full.getItem(k), setItem: (k, v) => {
    if (quota) throw new Error('QuotaExceededError');
    full.setItem(k, v);
  }, removeItem: (k) => full.removeItem(k) };
  const tabC = make({ storage: store, clock: c });
  quota = true;
  tabC.links.save({ id: FOLDER, kind: 'folder', name: 'Only here' });
  assert.equal(tabC.links.persistent, false);
  tabC.links.save({ id: FILE, kind: 'file', name: 'Also here' });
  assert.deepEqual(tabC.links.list().map((l) => l.name), ['Also here', 'Only here']);
});

test('blocked storage and storage events: a list kept for this visit is never emptied by another tab', () => {
  // memory only (no storage at all): events about the key or a cleared site leave this tab's list alone
  const win = events();
  const mem = make({ storage: null, events: win });
  mem.links.save({ id: FOLDER, kind: 'folder', name: 'Road Trip' });
  win.fire({ key: DRIVE_LINKS_KEY, storageArea: new Storage() });
  win.fire({ key: null });
  assert.equal(mem.links.get(FOLDER).name, 'Road Trip');
  assert.deepEqual(mem.changes, ['save'], 'no reload, no change event');
  // storage that cannot be read: not persistent from the start, and an event keeps the links of this visit
  let readable = true;
  const store = new Storage();
  const flaky = {
    getItem: (k) => {
      if (!readable) throw new Error('SecurityError');
      return store.getItem(k);
    },
    setItem: (k, v) => store.setItem(k, v),
    removeItem: (k) => store.removeItem(k),
  };
  const win2 = events();
  const tab = make({ storage: flaky, events: win2 });
  assert.equal(tab.links.persistent, true);
  tab.links.save({ id: FILE, kind: 'file', name: 'Midnight' });
  readable = false; // e.g. the site's storage was blocked while the page stays open
  win2.fire({ key: null, storageArea: flaky });
  assert.equal(tab.links.get(FILE).name, 'Midnight', 'kept');
  assert.equal(tab.links.persistent, false);
  assert.deepEqual(tab.changes, ['save']);
  const blocked = make({ storage: { getItem() {
    throw new Error('SecurityError');
  }, setItem() {}, removeItem() {} } }).links;
  assert.equal(blocked.persistent, false, 'unreadable storage is not persistent, even before a save');
});

test('defaults: localStorage and no window are fine', () => {
  const links = new SavedDriveLinks();
  links.save({ id: FOLDER, kind: 'folder', name: 'Default storage' });
  assert.match(localStorage.getItem(DRIVE_LINKS_KEY), /Default storage/);
  assert.equal(new SavedDriveLinks().get(FOLDER).name, 'Default storage');
  links.clear();
  links.dispose();
  assert.equal(localStorage.getItem(DRIVE_LINKS_KEY), null);
});
