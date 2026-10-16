// Song sources in the UI (docs/SOURCES.md section 4): the pure wording / reader helpers (src/ui/sources-text.js) on
// the browser-QA fixture answers (tests/fixtures/subsonic), and the app shell on the fake DOM with the real
// Library (memory mode), Playlist and MusicServerSource (its fetch stubbed onto the fixture files), a fake Google
// Drive source, a fake AutoMix and a fake Player: the Add music sheet (This device, Google Drive set up or not,
// the Drive link sheet, Other ways), Google Drive picks (the popup starts inside the tap, the import bar with
// progress and Cancel, finished songs kept), the music server connect form (checks, plain errors, the password
// never stored or sent), the browser (Albums / Artists / Playlists / Search, album / artist / playlist pages,
// song actions Play now / Play next / Add to queue / Load on deck A / B / Save offline, Add all, Save offline for
// an album), source badges on the Songs page, the deck chip and the player while a server song downloads,
// Settings (Music server, Google Drive), Help, the menu, all four layouts, saved Drive links (saved through
// onInfo after a link import, failed links not saved, the quick rows in Add music, the Saved links cards with
// Import again / Copy link / Rename / Remove / Forget all, the result toasts; end to end with the real
// GoogleDriveSource on a stubbed Drive API: Import again downloads nothing, keeps the resource key, the 60-song
// notice, blocked storage), Songs from Suno (the sheet, the helper script fetched only when it opens, Copy script
// through the clipboard or the selected box, Download script, the Drive link shortcut, a script that cannot load),
// and a clean error log.

import * as T from '../src/ui/sources-text.js';
import { installFakeDom, FakeEvent, Element, FakeDocument } from './helpers/fake-dom.js';
import { FakeEngine, FakeDeck, FakeSync } from './helpers/fake-models.js';
import { Emitter } from '../src/core/emitter.js';

const G = globalThis;
const errors = [];
const origError = console.error.bind(console);
console.error = (...args) => {
  errors.push(args.map((a) => (a && a.stack) || String(a)).join(' '));
  origError(...args);
};
const realFetch = G.fetch;
const FIXTURE = 'http://localhost:8100/tests/fixtures/subsonic';

/** A fixture answer (the whole JSON document, like the server sends it). */
async function fixture(method) {
  const res = await realFetch(new URL(`./fixtures/subsonic/rest/${method}.view`, import.meta.url));
  return res.json();
}

// ---------------------------------------------------------------------------------------------------------
// Pure helpers

test('where a song comes from: kind, badge, needs a download', () => {
  assert.equal(T.remoteKind(null), null);
  assert.equal(T.remoteKind({ source: 'file' }), null);
  assert.equal(T.remoteKind({ source: 'gdrive' }), 'gdrive');
  assert.equal(T.remoteKind({ remote: { kind: 'gdrive', fileId: 'x' } }), 'gdrive');
  assert.equal(T.remoteKind({ source: 'subsonic' }), 'server');
  assert.equal(T.needsDownload({ source: 'subsonic', stored: false }), true);
  assert.equal(T.needsDownload({ source: 'subsonic', stored: true }), false);
  assert.equal(T.needsDownload({ source: 'gdrive', stored: true }), false);
  assert.equal(T.sourceBadge({ source: 'file' }), null);
  assert.deepEqual(T.sourceBadge({ source: 'gdrive' }), { kind: 'gdrive', icon: 'cloud', label: 'From Google Drive', offline: true });
  const b = T.sourceBadge({ remote: { kind: 'subsonic' }, stored: false });
  assert.equal(b.icon, 'server');
  assert.equal(b.offline, false);
  assert.match(b.label, /downloads when you play it/);
  assert.equal(T.sourceBadge({ source: 'subsonic', stored: true }).offline, true);
});

test('progress: event and callback shapes, bar fraction, lines', () => {
  // a source 'progress' event counts files in total
  assert.deepEqual(T.progressOf({ done: 1, total: 3, bytes: 2097152, totalBytes: 8388608, name: 'a.mp3' }),
    { done: 1, total: 3, bytes: 2097152, totalBytes: 8388608, name: 'a.mp3' });
  // onProgress(bytes, totalBytes) and a fetch-style { loaded, total }
  assert.deepEqual(T.progressOf(500, 1000), { done: 0, total: 0, bytes: 500, totalBytes: 1000, name: '' });
  assert.deepEqual(T.progressOf({ loaded: 5, total: 10 }), { done: 0, total: 0, bytes: 5, totalBytes: 10, name: '' });
  assert.deepEqual(T.progressOf(NaN, -1), { done: 0, total: 0, bytes: 0, totalBytes: 0, name: '' });
  assert.equal(T.progressFraction({ bytes: 1, totalBytes: 4, done: 0, total: 0 }), 0.25);
  assert.equal(T.progressFraction({ bytes: 0, totalBytes: 0, done: 1, total: 2 }), 0.5);
  assert.equal(T.progressFraction({ bytes: 9, totalBytes: 0, done: 0, total: 0 }), null, 'unknown size: indeterminate');
  assert.equal(T.progressLine({ done: 3, total: 8, bytes: 12 * 1048576, totalBytes: 40 * 1048576 }), '3 of 8 · 12 of 40 MB');
  assert.equal(T.progressLine({ done: 0, total: 2, bytes: 1048576, totalBytes: 4 * 1048576 }), '0 of 2 · 1.0 of 4.0 MB');
  assert.equal(T.progressLine({ done: 0, total: 1, bytes: 1258291, totalBytes: 0 }), '1.2 MB', 'one file, no total: just the size');
  assert.equal(T.progressLine({ done: 0, total: 0, bytes: 0, totalBytes: 0 }), '');
  assert.equal(T.downloadText({ bytes: 128000, totalBytes: 256000 }), 'Downloading 50%');
  assert.equal(T.downloadText({ bytes: 0, totalBytes: 0 }), 'Downloading…');
});

test('music server address hints', () => {
  assert.equal(T.hostOf('https://Music.Example.synology.me/app/'), 'music.example.synology.me');
  assert.equal(T.hostOf('nas.local:4533'), 'nas.local');
  assert.equal(T.hostOf(''), '');
  assert.equal(T.serverUrlHint(''), '');
  assert.equal(T.serverUrlHint('music.me.synology.me'), '', 'no scheme: TwinSpin adds https://');
  assert.equal(T.serverUrlHint('https://music.me.synology.me'), '');
  assert.match(T.serverUrlHint('http://192.168.1.20:4533'), /only works in Chrome/);
  assert.match(T.serverUrlHint('http://diskstation:4533'), /only works in Chrome/);
  assert.match(T.serverUrlHint('http://music.example.com'), /block http:\/\//);
  assert.equal(T.serverUrlHint('http://localhost:8100/tests/fixtures/subsonic', { pageHttps: false }), '', 'the app itself on http');
  assert.match(T.serverUrlHint('ftp://nas'), /starts with https:\/\//);
});

test('other ways: the current platform first, every platform listed', () => {
  assert.deepEqual(T.otherWays({ ios: true }).map((w) => w.id), ['iphone', 'android', 'computer']);
  assert.deepEqual(T.otherWays({ android: true }).map((w) => w.id), ['android', 'iphone', 'computer']);
  assert.deepEqual(T.otherWays({}).map((w) => w.id), ['computer', 'iphone', 'android']);
  const iphone = T.otherWays({ ios: true })[0].items.join(' ');
  assert.match(iphone, /Connect to Server > smb:\/\//);
  assert.match(iphone, /Synology Drive app \(iOS 18 or later\)/);
  assert.match(T.otherWays({ android: true })[0].items.join(' '), /CIFS Documents Provider/);
});

test('Subsonic readers: the fixture answers, whole or unwrapped', async () => {
  const artistsDoc = await fixture('getArtists');
  for (const res of [artistsDoc, artistsDoc['subsonic-response']]) {
    const a = T.listArtists(res);
    assert.deepEqual(a.map((x) => x.name), ['Aurora Lane', 'Kaleido Club', 'The Velvet Static']);
    assert.equal(a[0].albumCount, 2);
    assert.equal(a[0].coverArt, 'ar-1');
  }
  const albums = T.listAlbums(await fixture('getAlbumList2'));
  assert.deepEqual(albums.map((x) => x.id), ['al-2', 'al-4', 'al-1', 'al-3']);
  assert.equal(T.albumLine(albums[2]), 'Aurora Lane · 2025 · 4 songs');
  assert.equal(T.albumLine(albums[2], { withArtist: false }), '2025 · 4 songs');
  const album = T.albumOf(await fixture('getAlbum'));
  assert.equal(album.name, 'Night Drive');
  assert.equal(album.songs.length, 4);
  assert.equal(album.songs[0].title, 'Midnight Signal');
  assert.equal(album.songs[0].track, 1);
  assert.equal(album.songs[0].raw.id, 'so-1', 'the raw song travels along (toEntries takes it)');
  assert.equal(T.songLine(album.songs[0]), 'Aurora Lane · 124 BPM · 0:08');
  assert.equal(T.songLine(album.songs[0], { withArtist: false }), '124 BPM · 0:08');
  const artist = T.artistOf(await fixture('getArtist'));
  assert.equal(artist.name, 'Aurora Lane');
  assert.deepEqual(artist.albums.map((x) => x.name), ['Night Drive', 'Glass City']);
  const pls = T.listPlaylists(await fixture('getPlaylists'));
  assert.deepEqual(pls.map((p) => p.name), ['Warm-up', 'Peak time']);
  assert.equal(T.playlistLine(pls[0]), '4 songs · 0:32');
  const pl = T.playlistOf(await fixture('getPlaylist'));
  assert.equal(pl.name, 'Warm-up');
  assert.deepEqual(pl.songs.map((s) => s.id), ['so-7', 'so-6', 'so-3', 'so-5']);
  const found = T.searchOf(await fixture('search3'));
  assert.deepEqual([found.artists.length, found.albums.length, found.songs.length], [1, 2, 3]);
  assert.deepEqual(T.listSongs(await fixture('getRandomSongs')).map((s) => s.id), ['so-6', 'so-2', 'so-7', 'so-4', 'so-1']);
  // one-item lists sent as a lone object, folders skipped, nothing at all
  assert.equal(T.listSongs({ album: { id: 'a', song: { id: 's', title: 'Solo' } } })[0].title, 'Solo');
  assert.deepEqual(T.listSongs([{ id: 'd', isDir: true }, { id: 's2' }]).map((s) => s.title), ['Untitled']);
  assert.deepEqual(T.listAlbums(null), []);
  assert.deepEqual(T.searchOf({}), { artists: [], albums: [], songs: [] });
  assert.deepEqual(T.pageOf([1, 2, 3, 4, 5], 2), { items: [1, 2], left: 3 });
  assert.deepEqual(T.pageOf([1, 2], 60), { items: [1, 2], left: 0 });
  assert.equal(T.countWord(1, 'song'), '1 song');
  assert.equal(T.serverLabel({ name: '', url: 'https://music.me.synology.me' }), 'music.me.synology.me');
  // `version` is the Subsonic API version; the server's own version is OpenSubsonic's serverVersion
  assert.equal(T.serverKind({ type: 'navidrome', version: '1.16.1', serverVersion: '0.64.2 (5f3a1c2)' }), 'Navidrome 0.64.2');
  assert.equal(T.serverKind({ type: 'navidrome', version: '1.16.1' }), 'Navidrome');
  assert.equal(T.serverKind({ type: '', version: '1.16.1' }), 'Subsonic API 1.16.1');
  assert.equal(T.serverKind({}), '');
});

test('errors in plain words, cancels recognised', () => {
  const fb = 'Fallback words.';
  assert.equal(T.errText(new Error('Wrong user name or password.'), fb), 'Wrong user name or password.');
  assert.equal(T.errText(new TypeError('Failed to fetch'), fb), fb);
  assert.equal(T.errText(new Error('Load failed'), fb), fb);
  assert.equal(T.errText(new Error("Cannot read properties of undefined (reading 'x')"), fb), fb);
  assert.equal(T.errText(null, fb), fb);
  assert.equal(T.errText('Plain string.', fb), 'Plain string.');
  const abort = new Error('The operation was aborted.');
  abort.name = 'AbortError';
  assert.equal(T.isAbort(abort), true);
  assert.equal(T.isAbort(new Error('x')), false);
});

test('saved Drive links in words: dates, names, lines, the import result', () => {
  const now = new Date(2026, 9, 16, 15, 30).getTime(); // 16 Oct 2026, local time
  assert.equal(T.shortDate(now - 3600e3, now), 'today');
  assert.equal(T.shortDate(new Date(2026, 9, 15, 23, 59).getTime(), now), 'yesterday');
  assert.equal(T.shortDate(new Date(2026, 9, 2, 8).getTime(), now), '2 Oct');
  assert.equal(T.shortDate(new Date(2025, 11, 31).getTime(), now), '31 Dec 2025');
  assert.equal(T.shortDate(0, now), '');
  assert.equal(T.savedLinkName({ kind: 'folder', name: ' Road Trip ' }), 'Road Trip');
  assert.equal(T.savedLinkName({ kind: 'folder', name: '' }), 'Google Drive folder');
  assert.equal(T.savedLinkName({ kind: 'file' }), 'Google Drive song');
  const folder = { kind: 'folder', songCount: 9, lastImportedAt: new Date(2026, 9, 2).getTime() };
  assert.equal(T.savedLinkMeta(folder, now), '9 songs · imported 2 Oct');
  assert.equal(T.savedLinkMeta(folder, now, { short: true }), '9 songs · 2 Oct');
  assert.equal(T.savedLinkMeta({ kind: 'folder', songCount: 1, lastImportedAt: now }, now), '1 song · imported today');
  assert.equal(T.savedLinkMeta({ kind: 'file', songCount: 1, lastImportedAt: now }, now), 'Song · imported today');
  assert.equal(T.savedLinkMeta({ kind: 'folder', songCount: 0 }, now), 'Folder');
  assert.equal(T.savedLinkMeta(null), '');
  // the toast after a link import: what was new, then the set list and the deck
  assert.equal(T.linkResultText({ name: 'Road Trip', total: 9, fresh: 3 }), '“Road Trip” · 3 new songs added');
  assert.equal(T.linkResultText({ name: 'Road Trip', total: 9, fresh: 0 }), '“Road Trip” · no new songs, all 9 are already in your library');
  assert.equal(T.linkResultText({ name: 'Road Trip', total: 9, fresh: 1, queued: 9, deck: 1 }),
    '“Road Trip” · 1 new song added · 9 queued, loading on deck B');
  assert.equal(T.linkResultText({ name: 'Solo', total: 1, fresh: 0 }), '“Solo” · no new songs, it is already in your library');
  assert.equal(T.linkResultText({ name: 'Midnight', kind: 'file', total: 1, fresh: 1, queued: 1, deck: 0 }),
    '“Midnight” · added to your songs · queued, loading on deck A');
  assert.equal(T.linkResultText({ kind: 'file', total: 1, fresh: 0 }), 'The song · already in your library');
  assert.equal(T.linkResultText({ total: 4, fresh: 4 }), 'The folder · 4 new songs added');
  // songs still waiting in the set list are not queued twice
  assert.equal(T.linkResultText({ name: 'Road Trip', total: 9, fresh: 0, queued: 0, waiting: 9 }),
    '“Road Trip” · no new songs, all 9 are already in your library · all already in the set list');
  assert.equal(T.linkResultText({ name: 'Road Trip', total: 9, fresh: 2, queued: 3, waiting: 6 }),
    '“Road Trip” · 2 new songs added · 3 queued · 6 already in the set list');
  assert.equal(T.linkResultText({ name: 'Midnight', kind: 'file', total: 1, fresh: 0, waiting: 1 }),
    '“Midnight” · already in your library · already in the set list');
});

// ---------------------------------------------------------------------------------------------------------
// The app shell

installFakeDom();
const { Settings } = await import('../src/core/settings.js');
const { Playlist } = await import('../src/deck/playlist.js');
const { Library, LIBRARY_CAP } = await import('../src/library/library.js');
const { MusicServerSource } = await import('../src/sources/subsonic.js');
const { SavedDriveLinks } = await import('../src/sources/drive-links.js');
const { GoogleDriveSource } = await import('../src/sources/gdrive.js');
const { AppUI } = await import('../src/ui/app-ui.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $$ = (root, sel) => root.querySelectorAll(sel);
const $ = (root, sel) => root.querySelector(sel);
const textOf = (el) => (el ? el.textContent : '');
const toastsOf = (app) => $$(app.root, '.toast').map(textOf).join(' | ');
const sheetOf = (app) => $(app.root, '.sheet');
const rowByLabel = (root, label) => $$(root, '.row').find((r) => textOf($(r, '.row-label')) === label) || null;
const buttonByText = (root, text) => $$(root, 'button').find((b) => textOf(b).trim() === text) || null;

let fileSeq = 0;
/** A File look-alike the real Library can read (tags fall back to the name). */
function fakeFile(name, extra = {}) {
  const size = 4000 + ++fileSeq;
  const bytes = new Uint8Array(64);
  return {
    name, size, lastModified: 1700000000000, type: 'audio/mpeg',
    arrayBuffer: async () => bytes.buffer.slice(0),
    slice: () => ({ arrayBuffer: async () => bytes.buffer.slice(0) }),
    ...extra,
  };
}

/** Storage look-alike (the source keeps its sign-in here). */
function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    dump: () => [...m.values()].join('\n'),
  };
}

/** fetch for the fixture server: http://localhost:8100/tests/fixtures/subsonic/rest/<method>.view?... */
function fixtureFetch(log, { fail = false } = {}) {
  return (url, init = {}) => {
    const u = String(url);
    log.push(u);
    if (fail) return Promise.reject(new TypeError('Failed to fetch'));
    const m = /\/rest\/([A-Za-z0-9]+)\.view(\?|$)/.exec(u);
    if (!u.startsWith(`${FIXTURE}/rest/`) || !m) return Promise.reject(new TypeError('Failed to fetch'));
    if (init.mode === 'no-cors') return Promise.resolve({ ok: false, status: 0, type: 'opaque' });
    return realFetch(new URL(`./fixtures/subsonic/rest/${m[1]}.view`, import.meta.url));
  };
}

/** A Subsonic answer that says "wrong password". */
function failingAuthFetch(log) {
  return (url) => {
    log.push(String(url));
    const body = { 'subsonic-response': { status: 'failed', version: '1.16.1', error: { code: 40, message: 'Wrong username or password' } } };
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body });
  };
}

/** docs/SOURCES.md 3.1 GoogleDriveSource, controlled by the test. */
class FakeDrive extends Emitter {
  constructor({ configured = true, linkReady = configured } = {}) {
    super();
    this._configured = configured;
    this.linkReady = linkReady;
    this.ready = false;
    this.stayLoading = false;
    this.loading = false;
    this.loadError = '';
    this.calls = [];
    this.pending = null;
  }

  get configured() {
    return this._configured;
  }

  count(name) {
    return this.calls.filter((c) => c[0] === name).length;
  }

  preload() {
    this.calls.push(['preload']);
    if (this.stayLoading) {
      this.loading = true;
    } else {
      this.ready = true;
    }
    this.emit('state');
    return Promise.resolve();
  }

  _wait(name, ...args) {
    this.calls.push([name, ...args]);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, args };
    });
  }

  pick(opts) {
    return this._wait('pick', opts);
  }

  importLink(url, opts) {
    return this._wait('importLink', url, opts);
  }

  cancel() {
    this.calls.push(['cancel']);
  }

  signOut() {
    this.calls.push(['signOut']);
    this.emit('state');
  }
}

class FakeAutoMix extends Emitter {
  constructor(playlist) {
    super();
    this.playlist = playlist;
    this.enabled = false;
    this.state = 'off';
    this.currentDeck = null;
    this.nextItem = null;
    this.pendingItem = null;
    this.currentItem = null;
    this.nextReady = false;
    this.paused = false;
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.emit('change', 'enabled');
  }

  toggle() {
    this.setEnabled(!this.enabled);
  }

  mixNow() {}

  noteUserCrossfader() {}
}

/** The docs/PLAYER.md section 4 surface the UI uses, recording the queue calls. */
class FakePlayer extends Emitter {
  constructor({ playlist, automix }) {
    super();
    this.playlist = playlist;
    this.automix = automix;
    this.state = 'stopped';
    this.calls = [];
    this.position = 0;
    this.duration = 0;
    this.upNext = [];
    this.history = [];
    this.shuffle = false;
    this.repeat = 'off';
    this.transition = 'dj';
    this.crossfadeSec = 6;
  }

  get nowPlaying() {
    const it = this.playlist.items[0];
    return it ? { item: it, deckIndex: null, title: it.title, artist: it.artist, bpm: it.bpm || null, hue: 200 } : null;
  }

  count(name) {
    return this.calls.filter((c) => c[0] === name).length;
  }

  playNow(entry) {
    this.calls.push(['playNow', entry]);
    return this.playlist.add(entry, { at: 0 });
  }

  playNext(entry) {
    this.calls.push(['playNext', entry]);
    return this.playlist.add(entry, { at: 0 });
  }

  addToQueue(entry) {
    this.calls.push(['addToQueue', entry]);
    return this.playlist.add(entry);
  }
}

function makeApp(w, h, { drive = null, server = 'fixture', fetchLog = [], fetchFn = null, links = undefined } = {}) {
  G.innerWidth = w;
  G.innerHeight = h;
  G.document = new FakeDocument();
  const root = new Element('div');
  root.setAttribute('id', 'app');
  G.document.body.append(root);
  const settings = new Settings(`ui-sources-${w}x${h}-${Math.random()}`);
  settings.set('tipsSeen', true);
  const engine = new FakeEngine();
  const decks = [new FakeDeck('A'), new FakeDeck('B')];
  const sync = new FakeSync(decks);
  const library = new Library({ indexedDB: null, storage: null });
  const playlist = new Playlist({ settings, library });
  const automix = new FakeAutoMix(playlist);
  const player = new FakePlayer({ playlist, automix });
  const local = memStore();
  const session = memStore();
  const srv = server === 'fixture'
    ? new MusicServerSource({ settings, library, fetch: fetchFn || fixtureFetch(fetchLog), local, session, location: { protocol: 'http:' } })
    : server;
  // saved Drive links: each app its own store in memory (no window 'storage' events)
  const driveLinks = links === undefined ? new SavedDriveLinks({ storage: memStore(), events: null }) : links;
  const ui = new AppUI({ root, engine, decks, sync, settings, library, playlist, automix, player,
    sources: { gdrive: drive, server: srv, driveLinks } });
  library.init();
  return { root, settings, engine, decks, sync, library, playlist, automix, player, ui, drive, server: srv, fetchLog, local,
    session, links: driveLinks };
}

async function startAudio(app) {
  $(app.root, '.btn-start').click();
  await sleep(50);
  assert.equal(app.ui.audioOn, true);
}

function type(input, value) {
  input.value = value;
  input.dispatchEvent(new FakeEvent('input'));
}

function submit(form) {
  form.dispatchEvent(new FakeEvent('submit'));
}

/** Fill in and send the connect form of the open server sheet. */
async function connect(app, { url = FIXTURE, user = 'dj', pass = 'secret-pw', remember = false } = {}) {
  const sheet = sheetOf(app);
  type($(sheet, '[id=sb-url]'), url);
  type($(sheet, '[id=sb-user]'), user);
  type($(sheet, '[id=sb-pass]'), pass);
  if (remember) $(sheet, '.sb-remember').click();
  submit($(sheet, '.sb-form'));
  await sleep(120);
}

test('Add music sheet: five ways in, Other ways, This device adds through the file input', async () => {
  const app = makeApp(360, 560, { drive: new FakeDrive({ configured: false }) });
  await startAudio(app);
  $(app.root, '.tab-songs').click();
  await sleep(20);
  const add = $(app.root, '.btn-add');
  assert.equal(add.tagName, 'BUTTON');
  assert.equal(add.getAttribute('aria-haspopup'), 'dialog');
  add.click();
  const sheet = sheetOf(app);
  assert.equal(sheet.dataset.sheet, 'add-music');
  assert.equal(textOf($(sheet, '.sheet-title')), 'Add music');
  assert.deepEqual($$(sheet, '.add-opt .row-label').map(textOf),
    ['This device', 'Google Drive', 'Music server / NAS', 'Paste a Google Drive link', 'Songs from Suno']);
  assert.equal($(sheet, '.add-device').tagName, 'LABEL', 'the system picker opens in the same tap');
  // Other ways: Android first on this (Android) phone, the guides linked
  const ways = $$(sheet, '.add-way');
  assert.deepEqual(ways.map((w) => w.dataset.way), ['android', 'iphone', 'computer']);
  assert($$(sheet, '.add-guides a').every((a) => /^https:\/\/github\.com\/Ranama\/twinspin\/blob\/main\/docs\//.test(a.getAttribute('href'))));
  assert.equal($(sheet, '.add-privacy a').getAttribute('href'), 'privacy.html');
  // Google Drive not set up: an explanation and the guide, no popup, no Google scripts
  const drive = $(sheet, '.add-drive');
  assert.match(textOf($(drive, '.row-detail')), /one-time setup/);
  assert.equal($(sheet, '.add-explain').hidden, true);
  drive.click();
  assert.equal($(sheet, '.add-explain').hidden, false);
  assert.equal(drive.getAttribute('aria-expanded'), 'true');
  assert.match(textOf($(sheet, '.add-explain')), /three public values/);
  assert.equal(app.drive.count('pick'), 0);
  assert.equal(app.drive.count('preload'), 0, 'nothing loads from Google until Drive is set up');
  // This device: the files go to the library and the set list; the sheet closes
  const input = $(sheet, '.add-device input');
  input.files = [fakeFile('Local Song.mp3')];
  input.dispatchEvent(new FakeEvent('change'));
  await sleep(60);
  assert.equal($(app.root, '.sheet-layer').hidden, true);
  assert.equal(app.library.list().filter((e) => !e.demo).length, 1);
  assert.equal(app.playlist.items.length, 1);
  assert.match(toastsOf(app), /Added “Local Song”/);
  app.ui.destroy();
});

test('Google Drive: the popup starts inside the tap, progress with Cancel, finished songs kept', async () => {
  const drive = new FakeDrive();
  const app = makeApp(360, 560, { drive });
  await startAudio(app);
  // Google's scripts still loading: the tap cannot open the popup yet, the sheet stays and says so
  drive.stayLoading = true;
  app.ui.openAddMusic();
  assert.equal(drive.count('preload'), 1, 'Google scripts load when the sheet opens');
  assert.match(textOf($(sheetOf(app), '.add-drive .row-detail')), /Getting Google Drive ready/);
  $(sheetOf(app), '.add-drive').click();
  assert.equal(drive.count('pick'), 0);
  assert.equal(sheetOf(app).dataset.sheet, 'add-music');
  assert.match(toastsOf(app), /getting ready/);
  app.ui.sheets.close();
  drive.stayLoading = false;
  drive.loading = false;
  app.ui.openAddMusic();
  assert.equal(drive.count('preload'), 2, 'opening the sheet again retries');
  assert.equal(drive.ready, true);
  let sheet = sheetOf(app);
  assert.match(textOf($(sheet, '.add-drive .row-detail')), /only sees the songs you pick/);
  $(sheet, '.add-drive').click();
  assert.equal(drive.count('pick'), 1, 'pick() runs synchronously in the click');
  assert.equal($(app.root, '.sheet-layer').hidden, true, 'the sheet makes way for Google’s picker');
  const bar = $(app.root, '.import-bar');
  assert.equal(bar.hidden, true, 'no bar while the user is still picking');
  drive.emit('progress', { done: 0, total: 2, bytes: 1048576, totalBytes: 4 * 1048576, name: 'One.mp3' });
  await sleep(40);
  assert.equal(bar.hidden, false);
  assert.equal(bar.parentNode, $(app.root, '.toasts'), 'the bar sits on top of the toast stack');
  assert.equal(textOf($(bar, '.ib-title')), 'Importing from Google Drive');
  assert.equal(textOf($(bar, '.ib-detail')), '0 of 2 · 1.0 of 4.0 MB');
  assert.equal($(bar, '.ib-track').getAttribute('aria-valuenow'), '25');
  // a second Drive tap while importing explains instead of opening another picker
  app.ui.openAddMusic();
  $(sheetOf(app), '.add-drive').click();
  assert.equal(drive.count('pick'), 1);
  assert.match(toastsOf(app), /still running/);
  app.ui.sheets.close();
  // done: the songs land in the library with their Drive id, the set list and an empty deck
  drive.pending.resolve([fakeFile('Drive One.mp3', { remote: { kind: 'gdrive', fileId: 'fileOne123456' } }),
    fakeFile('Drive Two.mp3', { driveFileId: 'fileTwo123456' })]);
  await sleep(80);
  assert.equal(bar.hidden, true);
  const songs = app.library.list().filter((e) => !e.demo);
  assert.deepEqual(songs.map((e) => e.source).sort(), ['gdrive', 'gdrive']);
  assert.deepEqual(songs.map((e) => e.remote.fileId).sort(), ['fileOne123456', 'fileTwo123456']);
  assert.equal(app.playlist.items.length, 2);
  assert.equal(app.decks[0].count('loadFile'), 1, 'the first song loads on the empty deck A');
  assert.match(toastsOf(app), /Added 2 songs to your songs and the set list/);
  // the Songs list marks them with the cloud badge
  app.ui.setPage('songs');
  await sleep(20);
  const badges = $$(app.root, '.songs .song-row .src-badge.src-gdrive');
  assert.equal(badges.length, 2);
  // Cancel: the bar goes at once, the source is told, the songs that finished are kept
  app.ui.openAddMusic();
  $(sheetOf(app), '.add-drive').click();
  assert.equal(drive.count('pick'), 2);
  const signal = drive.pending.args[0].signal;
  drive.emit('progress', { done: 1, total: 3, bytes: 3e6, totalBytes: 9e6, name: 'x.mp3' });
  await sleep(40);
  $(bar, '.ib-cancel').click();
  assert.equal(bar.hidden, true);
  assert.equal(drive.count('cancel'), 1);
  assert.equal(signal.aborted, true);
  assert.match(toastsOf(app), /Import cancelled/);
  drive.pending.resolve([fakeFile('Drive Three.mp3', { remote: { kind: 'gdrive', fileId: 'fileThree1234' } })]);
  await sleep(60);
  assert.equal(app.library.list().filter((e) => !e.demo).length, 3, 'the finished song is kept');
  // Google's sign-in window never answered (seen in iPhone Home Screen apps): a new tap asks again
  app.ui.openAddMusic();
  $(sheetOf(app), '.add-drive').click();
  const stuck = drive.pending;
  const picks = drive.count('pick');
  app.ui.openAddMusic();
  $(sheetOf(app), '.add-drive').click();
  assert.equal(drive.count('pick'), picks + 1, 'no "still running" while nothing shows yet');
  stuck.resolve([]); // the source drops the earlier pick
  await sleep(20);
  drive.emit('progress', { done: 0, total: 1, bytes: 10, totalBytes: 100, name: 'y.mp3' });
  await sleep(40);
  assert.equal(bar.hidden, false, 'the new pick owns the bar');
  drive.pending.resolve([]);
  await sleep(40);
  assert.equal(bar.hidden, true);
  // a failure says why in plain words
  app.ui.openAddMusic();
  $(sheetOf(app), '.add-drive').click();
  drive.pending.reject(Object.assign(new Error('Allow pop-ups for TwinSpin, or use Add music > Google Drive in your phone’s file picker.'), { code: 'popup-blocked' }));
  await sleep(40);
  assert.match(toastsOf(app), /Allow pop-ups for TwinSpin/);
  // a raw browser error becomes a plain sentence
  app.ui.openAddMusic();
  $(sheetOf(app), '.add-drive').click();
  drive.pending.reject(new TypeError('Failed to fetch'));
  await sleep(40);
  assert.match(toastsOf(app), /Google Drive didn't answer/);
  sheet = null;
  app.ui.destroy();
});

test('Drive link sheet: checks the link, imports with the bar, explains without the key', async () => {
  const drive = new FakeDrive();
  const app = makeApp(360, 560, { drive });
  await startAudio(app);
  app.ui.openAddMusic();
  $(sheetOf(app), '.add-link').click();
  let sheet = sheetOf(app);
  assert.equal(sheet.dataset.sheet, 'drive-link');
  assert.equal($(sheet, '.sheet-back').hidden, false, 'Back returns to Add music');
  const input = $(sheet, '[id=drive-link-input]');
  assert.equal(input.getAttribute('type'), 'url');
  assert.equal(input.getAttribute('autocapitalize'), 'none');
  const form = $(sheet, '.src-form');
  const err = $(sheet, '.src-error');
  submit(form);
  assert.equal(err.hidden, false);
  assert.equal(textOf(err), 'Paste the link first.');
  type(input, 'https://example.com/song.mp3');
  assert.equal(err.hidden, true, 'typing clears the error');
  submit(form);
  assert.match(textOf(err), /not a Google Drive link/);
  assert.equal(drive.count('importLink'), 0);
  const link = 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv?usp=sharing';
  type(input, link);
  submit(form);
  assert.equal(drive.count('importLink'), 1);
  assert.equal(drive.calls.find((c) => c[0] === 'importLink')[1], link);
  assert.equal($(app.root, '.sheet-layer').hidden, true);
  const bar = $(app.root, '.import-bar');
  await sleep(40);
  assert.equal(bar.hidden, false, 'a link import shows the bar at once');
  assert.equal(textOf($(bar, '.ib-title')), 'Importing a Google Drive link');
  assert.equal(textOf($(bar, '.ib-detail')), 'Looking in the folder…');
  assert($(bar, '.ib-track').classList.contains('indeterminate'));
  drive.pending.resolve([]);
  await sleep(40);
  assert.equal(bar.hidden, true);
  assert.match(toastsOf(app), /No songs found behind that link/);
  app.ui.destroy();
  // no API key: the sheet explains and links the guide
  const app2 = makeApp(360, 560, { drive: new FakeDrive({ configured: false }) });
  await startAudio(app2);
  app2.ui.openAddMusic();
  $(sheetOf(app2), '.add-link').click();
  sheet = sheetOf(app2);
  assert(!$(sheet, '.src-form'));
  assert.match(textOf(sheet), /needs the one-time Google setup/);
  assert.match($(sheet, '.src-link').getAttribute('href'), /GOOGLE_DRIVE\.md$/);
  app2.ui.destroy();
});

test('music server: connect form checks, plain errors, the password is never stored or sent', async () => {
  const log = [];
  const app = makeApp(360, 560, { fetchLog: log, fetchFn: failingAuthFetch(log) });
  await startAudio(app);
  app.ui.openAddMusic();
  assert.match(textOf($(sheetOf(app), '.add-server .row-detail')), /Navidrome or another Subsonic server/);
  $(sheetOf(app), '.add-server').click();
  const sheet = sheetOf(app);
  assert.equal(sheet.dataset.sheet, 'server');
  assert.equal($(sheet, '[id=sb-pass]').getAttribute('type'), 'password');
  assert.equal($(sheet, '[id=sb-pass]').getAttribute('autocomplete'), 'current-password');
  assert.equal($(sheet, '[id=sb-user]').getAttribute('autocomplete'), 'username');
  assert.equal($(sheet, '.sb-remember').getAttribute('aria-checked'), 'false', 'remembering is opt-in');
  assert.match($(sheet, '.src-link').getAttribute('href'), /SYNOLOGY\.md$/);
  const err = $(sheet, '.src-error');
  submit($(sheet, '.sb-form'));
  assert.equal(textOf(err), 'Type the address of your music server.');
  type($(sheet, '[id=sb-url]'), FIXTURE);
  submit($(sheet, '.sb-form'));
  assert.equal(textOf(err), 'Type your user name.');
  type($(sheet, '[id=sb-user]'), 'dj');
  submit($(sheet, '.sb-form'));
  assert.equal(textOf(err), 'Type your password.');
  assert.equal(log.length, 0, 'nothing sent before the form is complete');
  // an http:// address while the app runs on https would get a hint (here the app runs on http, like the dev server)
  // wrong password: the server's answer in plain words, inline
  type($(sheet, '[id=sb-pass]'), 'wrong-pw');
  submit($(sheet, '.sb-form'));
  assert.equal(textOf($(sheet, '.sb-connect')), 'Connecting…');
  await sleep(80);
  assert.equal(textOf(err), 'Wrong user name or password.');
  assert.equal(err.hidden, false);
  assert.equal(textOf($(sheet, '.sb-connect')), 'Connect');
  assert.equal(app.server.connected, false);
  assert(log.length >= 1);
  assert(log.every((u) => !u.includes('wrong-pw') && !/[?&]p=/.test(u)), 'the password never goes into a URL');
  assert.equal(app.local.dump() + app.session.dump(), '', 'nothing stored after a failed sign-in');
  assert(!/connected to/i.test(toastsOf(app)));
  app.ui.destroy();
  // an unreachable server
  const log2 = [];
  const app2 = makeApp(360, 560, { fetchLog: log2, fetchFn: fixtureFetch(log2, { fail: true }) });
  await startAudio(app2);
  app2.ui.openMusicServer();
  await connect(app2);
  assert.match(textOf($(sheetOf(app2), '.src-error')), /Can't reach your music server/);
  app2.ui.destroy();
});

test('music server browser on the fixture: albums, album page, song actions, Add all, Save offline', async () => {
  const log = [];
  const app = makeApp(360, 560, { fetchLog: log });
  const { player, playlist, library, decks } = app;
  await startAudio(app);
  app.ui.openMusicServer();
  await connect(app, { remember: false });
  assert.equal(app.server.connected, true);
  assert.match(toastsOf(app), /Connected to localhost/);
  assert(log.some((u) => u.includes('/rest/ping.view?') && u.includes('u=dj') && /[?&]t=[0-9a-f]{32}/.test(u) && /[?&]s=/.test(u)));
  assert(log.every((u) => !u.includes('secret-pw')), 'the password never goes into a URL');
  assert(!app.local.dump().includes('secret-pw') && !app.session.dump().includes('secret-pw'), 'never stored');
  assert.equal(app.local.dump(), '', 'not remembered: nothing in localStorage');
  assert(app.session.dump().includes('"token"'), 'a sign-in key for this visit only');
  let sheet = sheetOf(app);
  assert.equal($(sheet, '[id=sb-pass]'), null, 'the form is gone');
  assert.equal(textOf($(sheet, '.sb-server-name')), 'localhost');
  assert.match(textOf($(sheet, '.sb-server-url')), /Navidrome 0\.64\.2 · http:\/\/localhost:8100\/tests\/fixtures\/subsonic/);
  const tabs = $$(sheet, '.sb-tab');
  assert.deepEqual(tabs.map(textOf), ['Artists', 'Albums', 'Playlists', 'Search']);
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true', 'Albums first');
  await sleep(60);
  let cards = $$(sheet, '.sb-card');
  assert.deepEqual(cards.map((c) => textOf($(c, '.sb-card-title'))), ['Glass City', 'Low Light', 'Night Drive', 'Prism Loops']);
  const img = $(cards[0], 'img');
  assert.match(img.getAttribute('src'), /\/rest\/getCoverArt\.view\?.*id=al-2/);
  assert.equal(img.getAttribute('loading'), 'lazy');
  assert.equal($(sheet, '.sb-more'), null, 'a short page is the last one');
  // the album page (pushed: Back returns to the albums)
  cards[2].click();
  await sleep(60);
  sheet = sheetOf(app);
  assert.equal(sheet.dataset.sheet, 'server-album');
  assert.equal(textOf($(sheet, '.sheet-title')), 'Night Drive');
  assert.equal($(sheet, '.sheet-back').hidden, false);
  assert.equal(textOf($(sheet, '.sb-head-title')), 'Night Drive');
  assert.equal(textOf($(sheet, '.sb-head-line')), '2025 · 4 songs');
  let rows = $$(sheet, '.sb-song');
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => textOf($(r, '.sb-num'))), ['1', '2', '3', '4']);
  assert.equal(textOf($(rows[0], '.song-title')), 'Midnight Signal');
  assert.equal(library.list().filter((e) => !e.demo).length, 0, 'browsing adds nothing to the library');
  // a song: the action sheet with the deck loads and Save offline
  $(rows[0], '.sb-song-main').click();
  sheet = sheetOf(app);
  assert.equal(sheet.dataset.sheet, 'song');
  assert.deepEqual($$(sheet, '.row-label').map(textOf),
    ['Play now', 'Play next', 'Add to queue', 'Load on deck A', 'Load on deck B', 'Save offline']);
  // Add to queue: back to the album
  rowByLabel(sheet, 'Add to queue').click();
  await sleep(60);
  assert.equal(sheetOf(app).dataset.sheet, 'server-album', 'queueing keeps the album open');
  assert.equal(player.count('addToQueue'), 1);
  const entry = player.calls[0][1];
  assert.equal(entry.source, 'subsonic');
  assert.equal(entry.stored, false);
  assert.equal(entry.remote.songId, 'so-1');
  assert.equal(library.list().filter((e) => !e.demo).length, 1, 'the song is listed once it is used');
  assert.match(toastsOf(app), /Added “Midnight Signal” to the queue/);
  // + on a row: Add to queue
  rows = $$(sheetOf(app), '.sb-song');
  $(rows[1], '.sb-add').click();
  await sleep(60);
  assert.equal(player.count('addToQueue'), 2);
  // Play now closes the sheets
  $(rows[2], '.sb-song-main').click();
  rowByLabel(sheetOf(app), 'Play now').click();
  await sleep(60);
  assert.equal($(app.root, '.sheet-layer').hidden, true);
  assert.equal(player.count('playNow'), 1);
  assert.equal(player.calls.find((c) => c[0] === 'playNow')[1].title, 'Tail Lights');
  // Load on deck A: downloads (the fixture WAV), then loads with the library id
  app.ui.openMusicServer();
  await sleep(40);
  $$(sheetOf(app), '.sb-card')[2].click();
  await sleep(40);
  $($$(sheetOf(app), '.sb-song')[3], '.sb-song-main').click();
  rowByLabel(sheetOf(app), 'Load on deck A').click();
  await sleep(200);
  assert.equal(decks[0].count('loadFile'), 1);
  const [, blob, meta] = decks[0].calls.find((c) => c[0] === 'loadFile');
  assert.equal(meta.title, 'Last Exit');
  assert.equal(blob.size, 256044, 'the original file from download.view');
  assert(log.some((u) => /\/rest\/download\.view\?.*id=so-4/.test(u)));
  assert.equal(textOf($(app.root, '.chip-a .chip-title')), 'Last Exit');
  // Add all + Save offline for the album
  app.ui.openMusicServer();
  await sleep(40);
  $$(sheetOf(app), '.sb-card')[2].click();
  await sleep(40);
  sheet = sheetOf(app);
  const before = playlist.items.length;
  $(sheet, '.sb-addall').click();
  await sleep(60);
  assert.equal(playlist.items.length, before + 4);
  assert.match(toastsOf(app), /Added 4 songs to the queue/);
  $(sheet, '.sb-saveall').click();
  await sleep(40);
  const bar = $(app.root, '.import-bar');
  assert.equal(bar.dataset.kind, 'offline');
  await sleep(400);
  assert.equal(bar.hidden, true);
  const listed = library.list().filter((e) => e.source === 'subsonic');
  assert.equal(listed.length, 4);
  assert(listed.every((e) => e.stored === true), 'all four saved on this device');
  assert.match(toastsOf(app), /Saved 4 songs on this device/);
  await sleep(40);
  rows = $$(sheetOf(app), '.sb-song');
  assert(rows.every((r) => $(r, '.sb-saved').hidden === false), 'saved marks on the rows');
  $(rows[0], '.sb-song-main').click();
  assert.equal(rowByLabel(sheetOf(app), 'Save offline'), null);
  assert.match(textOf($(sheetOf(app), '.song-saved')), /Saved on this device/);
  app.ui.sheets.close();
  // the Songs page: server badges (saved: the filled one), Remove keeps the server copy
  app.ui.setPage('songs');
  await sleep(30);
  const serverRows = $$(app.root, '.songs .song-row').filter((r) => $(r, '.src-badge.src-server'));
  assert.equal(serverRows.length, 4);
  assert(serverRows.every((r) => $(r, '.src-badge').classList.contains('offline')));
  app.ui.destroy();
});

test('music server browser: artists, playlists, search; Settings shows the server and disconnects', async () => {
  const log = [];
  const app = makeApp(360, 560, { fetchLog: log });
  await startAudio(app);
  app.ui.openMusicServer();
  await connect(app, { remember: true });
  assert(app.local.dump().includes('"token"'), 'remembered: the sign-in key (never the password) on this device');
  let sheet = sheetOf(app);
  // Artists
  buttonByText(sheet, 'Artists').click();
  await sleep(60);
  const artists = $$(sheet, '.sb-artist');
  assert.deepEqual(artists.map((a) => textOf($(a, '.song-title'))), ['Aurora Lane', 'Kaleido Club', 'The Velvet Static']);
  assert.equal(textOf($(artists[0], '.song-meta')), '2 albums');
  artists[0].click();
  await sleep(60);
  sheet = sheetOf(app);
  assert.equal(sheet.dataset.sheet, 'server-artist');
  assert.deepEqual($$(sheet, '.sb-card-title').map(textOf), ['Night Drive', 'Glass City']);
  $(sheet, '.sheet-back').click();
  await sleep(40);
  sheet = sheetOf(app);
  assert.equal(sheet.dataset.sheet, 'server');
  assert.equal($$(sheet, '.sb-tab').find((t) => t.getAttribute('aria-selected') === 'true').dataset.tab, 'artists', 'the tab is kept');
  // Playlists
  buttonByText(sheet, 'Playlists').click();
  await sleep(60);
  const pls = $$(sheet, '.sb-pl');
  assert.deepEqual(pls.map((p) => textOf($(p, '.song-title'))), ['Warm-up', 'Peak time']);
  assert.equal(textOf($(pls[0], '.song-meta')), '4 songs · 0:32');
  pls[0].click();
  await sleep(60);
  sheet = sheetOf(app);
  assert.equal(sheet.dataset.sheet, 'server-playlist');
  assert.equal($$(sheet, '.sb-song').length, 4);
  assert.equal(textOf($(sheet, '.sb-head-sub')), 'By twinspin');
  $(sheet, '.sb-addall').click();
  await sleep(60);
  assert.equal(app.playlist.items.length, 4);
  $(sheet, '.sheet-back').click();
  await sleep(30);
  // Search: waits for a pause in typing, then shows songs, albums and artists
  sheet = sheetOf(app);
  buttonByText(sheet, 'Search').click();
  await sleep(20);
  const q = $(sheet, '.sb-q');
  assert.equal(q.getAttribute('type'), 'search');
  assert.match(textOf($(sheet, '.sb-results')), /Search your server/);
  type(q, 'n');
  await sleep(450);
  assert.match(textOf($(sheet, '.sb-results')), /one more letter/);
  assert(!log.some((u) => u.includes('search3')), 'one letter waits for Search');
  type(q, 'night');
  await sleep(200);
  assert(!log.some((u) => u.includes('search3')), 'no search while typing');
  await sleep(300);
  assert(log.some((u) => /search3\.view\?.*query=night/.test(u)));
  const res = $(sheet, '.sb-results');
  assert.deepEqual($$(res, '.songs-h').map((x) => textOf(x.children[0])), ['Songs', 'Albums', 'Artists']);
  assert.equal($$(res, '.sb-song').length, 3);
  assert.equal($$(res, '.sb-card').length, 2);
  // Settings: the server, and Disconnect (asks first)
  app.ui.sheets.close();
  app.ui.openMenu();
  rowByLabel(sheetOf(app), 'Settings').click();
  sheet = sheetOf(app);
  const secs = $$(sheet, '.sheet-sec').filter((s) => textOf($(s, '.sheet-h')) === 'Music server');
  assert.equal(secs.length, 1);
  assert.match(textOf(secs[0]), /localhost/);
  assert.match(textOf(secs[0]), /Navidrome 0\.64\.2/, 'the server product version, not the API version');
  // Diagnostics: the kind of server and its status, never its address or the user
  const diag = app.ui.diagnostics();
  assert.equal(diag.sources.server, 'Navidrome 0.64.2 (connected)');
  const flat = JSON.stringify(diag.sources);
  assert(!/localhost|\bdj\b|token|salt/.test(flat), `no address or sign-in details: ${flat}`);
  rowByLabel(secs[0], 'Disconnect').click();
  await sleep(10);
  const dlg = $(app.root, '.dialog-layer');
  assert.match(textOf(dlg), /Disconnect the music server\?/);
  buttonByText(dlg, 'Disconnect').click();
  await sleep(40);
  assert.equal(app.server.connected, false);
  assert.equal(app.local.dump(), '', 'the sign-in key is forgotten');
  assert.equal(globalThis.localStorage.getItem('twinspin.serverForm'), null, 'the address and user name are not kept');
  assert.match(String(globalThis.sessionStorage.getItem('twinspin.serverForm')), /fixtures\/subsonic/,
    'this visit still fills in the form');
  assert.match(toastsOf(app), /Music server disconnected/);
  const secs2 = $$(sheetOf(app), '.sheet-sec').filter((s) => textOf($(s, '.sheet-h')) === 'Music server');
  assert(rowByLabel(secs2[0], 'Connect a music server'), 'the section offers to connect again');
  app.ui.destroy();
});

test('a server song downloading for a deck and for the player shows its progress', async () => {
  const app = makeApp(360, 560, { server: null });
  const { library, decks } = app;
  await startAudio(app);
  let release = null;
  let progress = null;
  library.setResolver('subsonic', (entry, { onProgress }) => new Promise((resolve) => {
    progress = onProgress;
    release = () => resolve({ size: 256000, type: 'audio/wav', name: entry.fileName });
  }));
  const [entry] = await library.addRemote([{ title: 'Far Away', artist: 'NAS', size: 256000, remote: { kind: 'subsonic', serverId: 'srv-1', songId: '9' } }]);
  assert.equal(entry.stored, false);
  app.ui.setPage('songs');
  await sleep(20);
  const row = $$(app.root, '.songs .song-row').find((r) => /Far Away/.test(textOf(r)));
  assert($(row, '.src-badge.src-server'));
  assert(!$(row, '.src-badge').classList.contains('offline'));
  // A on the row: the chip says Downloading, then the song
  $$(row, '.load-btn')[0].click();
  await sleep(40);
  const chip = $(app.root, '.chip-a');
  assert(chip.classList.contains('downloading'));
  assert.equal(textOf($(chip, '.chip-title')), 'Downloading…');
  progress(128000, 256000);
  await sleep(40);
  assert.equal(textOf($(chip, '.chip-title')), 'Downloading 50%');
  assert.match(chip.getAttribute('title'), /Downloading “Far Away” from your music server/);
  // the player waiting for it says so too
  app.player.state = 'loading';
  app.automix.pendingItem = { kind: 'library', id: entry.id };
  app.ui.setPage('player');
  await sleep(60);
  assert.equal(textOf($(app.root, '.pl-sub')), 'Downloading 50% from your music server');
  release();
  await sleep(60);
  assert.equal(decks[0].count('loadFile'), 1);
  assert(!chip.classList.contains('downloading'));
  assert.equal(textOf($(chip, '.chip-title')), 'Far Away');
  // a newer load on the same deck cancels the download
  let aborted = false;
  library.setResolver('subsonic', (e, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      aborted = true;
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  }));
  const [other] = await library.addRemote([{ title: 'Slow One', remote: { kind: 'subsonic', serverId: 'srv-1', songId: '10' } }]);
  app.ui.loadFromLibrary(1, other);
  await sleep(30);
  assert($(app.root, '.chip-b').classList.contains('downloading'));
  app.ui.loadDemo(1, 0);
  await sleep(60);
  assert.equal(aborted, true);
  assert(!$(app.root, '.chip-b').classList.contains('downloading'));
  assert(!/couldn't be downloaded/.test(toastsOf(app)), 'a cancelled download is not an error');
  app.ui.destroy();
});

test('Settings > Google Drive, Help, the menu, the player empty state and all layouts', async () => {
  const drive = new FakeDrive();
  const app = makeApp(360, 560, { drive });
  await startAudio(app);
  // Settings: sign out of Google Drive
  app.ui.openMenu();
  rowByLabel(sheetOf(app), 'Settings').click();
  let sheet = sheetOf(app);
  const gsec = $$(sheet, '.sheet-sec').find((s) => textOf($(s, '.sheet-h')) === 'Google Drive');
  rowByLabel(gsec, 'Sign out of Google Drive').click();
  assert.equal(drive.count('signOut'), 1);
  assert.match(toastsOf(app), /Signed out of Google Drive/);
  assert.equal($$(sheet, 'a').filter((a) => a.getAttribute('href') === 'privacy.html').length, 1, 'About links the privacy page');
  // Help
  app.ui.sheets.back();
  rowByLabel(sheetOf(app), 'Help').click();
  sheet = sheetOf(app);
  assert($$(sheet, '.help-h').some((x) => textOf(x) === 'Your music from Google Drive or your NAS'));
  const sunoHelp = $$(sheet, '.help-sec').find((s) => textOf($(s, '.help-h')) === 'Songs from Suno');
  assert(sunoHelp, 'help: Songs from Suno');
  assert.match(textOf(sunoHelp), /Add music > Songs from Suno/);
  // Menu > Add music
  app.ui.openMenu();
  rowByLabel(sheetOf(app), 'Add music').click();
  assert.equal(sheetOf(app).dataset.sheet, 'add-music');
  app.ui.sheets.close();
  // the player's empty state and Up next header open Add music
  app.ui.setPage('player');
  await sleep(40);
  const empty = $(app.root, '.pq-empty');
  assert.equal(empty.hidden, false);
  $(empty, '.pq-add').click();
  assert.equal(sheetOf(app).dataset.sheet, 'add-music');
  app.ui.sheets.close();
  $(app.root, '.pq-addmusic').click();
  assert.equal(sheetOf(app).dataset.sheet, 'add-music');
  app.ui.sheets.close();
  app.ui.destroy();
  // every layout: the Add music sheet and the server browser open and render
  for (const [w, h] of [[360, 560], [844, 390], [768, 1000], [1280, 720]]) {
    const a = makeApp(w, h, { drive: new FakeDrive() });
    await startAudio(a);
    a.ui.openAddMusic();
    assert.equal(sheetOf(a).dataset.sheet, 'add-music', `${w}x${h}`);
    $(sheetOf(a), '.add-server').click();
    assert.equal(sheetOf(a).dataset.sheet, 'server');
    await connect(a);
    await sleep(60);
    assert.equal($$(sheetOf(a), '.sb-card').length, 4, `${w}x${h}`);
    a.ui.destroy();
  }
});

const ROAD = '0BwwA4oUTeiV1TGRPeTVjaWRDY1E';
const SONG = '1MidnightSignal_000000000';
const roadSong = (i) => fakeFile(`Road ${i}.mp3`, { remote: { kind: 'gdrive', fileId: `roadTripFile${i}000` } });

/** Paste a link into the open Google Drive link sheet and send it. */
function pasteLink(app, url) {
  const sheet = sheetOf(app);
  type($(sheet, '[id=drive-link-input]'), url);
  submit($(sheet, '.src-form'));
}

test('saved Drive links: saved after an import (also with nothing new), failed links not saved, Import again', async () => {
  const drive = new FakeDrive();
  const app = makeApp(360, 560, { drive });
  const { links, library, playlist } = app;
  await startAudio(app);
  const bar = $(app.root, '.import-bar');
  // nothing saved yet: no quick rows in Add music, no Saved links section
  app.ui.openAddMusic();
  assert.equal($(sheetOf(app), '.add-saved').hidden, true);
  $(sheetOf(app), '.add-link').click();
  assert.equal($(sheetOf(app), '.dl-saved').hidden, true);
  // a folder link: Google Drive says what it is (onInfo) and the link is saved right then
  pasteLink(app, `https://drive.google.com/drive/folders/${ROAD}?usp=sharing`);
  assert.equal(drive.count('importLink'), 1);
  const opts = drive.pending.args[1];
  assert.equal(typeof opts.onInfo, 'function');
  assert.equal(links.size, 0, 'nothing saved before Google Drive answers');
  opts.onInfo({ id: ROAD, kind: 'folder', name: 'Road Trip', songCount: 3, resourceKey: '' });
  assert.equal(links.size, 1);
  const saved = links.get(ROAD);
  assert.equal(saved.url, `https://drive.google.com/drive/folders/${ROAD}`, 'the clean link, without ?usp=sharing');
  assert.equal(saved.name, 'Road Trip');
  assert.equal(saved.songCount, 3);
  drive.pending.resolve([roadSong(1), roadSong(2), roadSong(3)]);
  await sleep(80);
  assert.equal(bar.hidden, true);
  assert.match(toastsOf(app), /“Road Trip” · 3 new songs added · 3 queued, loading on deck A/);
  assert.equal(library.list().filter((e) => !e.demo).length, 3);
  assert.equal(playlist.items.length, 3);
  // Add music now offers it right under "Paste a Google Drive link"
  app.ui.openAddMusic();
  let sheet = sheetOf(app);
  const quick = $(sheet, '.add-saved');
  assert.equal(quick.hidden, false);
  let rows = $$(quick, '.add-saved-row');
  assert.equal(rows.length, 1);
  assert.equal(textOf($(rows[0], '.add-saved-name')), 'Road Trip');
  assert.equal(textOf($(rows[0], '.add-saved-meta')), '3 songs · today');
  assert.equal(textOf($(quick, '.add-saved-all')).trim(), 'All saved links (1)');
  // Import: the same import as pasting it (bar, its name on the bar), the sheet makes way
  $(rows[0], '.add-saved-go').click();
  assert.equal($(app.root, '.sheet-layer').hidden, true);
  assert.equal(drive.count('importLink'), 2);
  assert.equal(drive.pending.args[0], `https://drive.google.com/drive/folders/${ROAD}`);
  await sleep(40);
  assert.equal(bar.hidden, false);
  assert.equal(textOf($(bar, '.ib-title')), 'Importing a Google Drive link');
  assert.equal(textOf($(bar, '.ib-detail')), 'Looking in “Road Trip”…');
  // every song is already in the library: the link is still saved (used again), and the toast says so
  drive.pending.args[1].onInfo({ id: ROAD, kind: 'folder', name: 'Road Trip', songCount: 3, resourceKey: '' });
  drive.pending.resolve([roadSong(1), roadSong(2), roadSong(3)]);
  await sleep(80);
  assert.match(toastsOf(app), /“Road Trip” · no new songs, all 3 are already in your library · all already in the set list/); // still waiting in the set list: not queued twice
  assert.equal(library.list().filter((e) => !e.demo).length, 3, 'nothing new in the library');
  assert.equal(links.size, 1, 'still one saved link');
  // a link that fails (not found) is not saved
  app.ui.openAddMusic();
  $(sheetOf(app), '.add-link').click();
  pasteLink(app, 'https://drive.google.com/file/d/1GoneGoneGoneGone000000/view');
  drive.pending.reject(Object.assign(new Error("That file or folder wasn't found. Check the link, and that it is shared with “Anyone with the link”."),
    { code: 'not-found' }));
  await sleep(40);
  assert.match(toastsOf(app), /wasn't found/);
  // not a Drive link at all: the sheet says so, nothing starts or is saved
  app.ui.openAddMusic();
  $(sheetOf(app), '.add-link').click();
  pasteLink(app, 'https://example.com/folders/1AbCdEfGhIjKlMn');
  assert.match(textOf($(sheetOf(app), '.src-error')), /not a Google Drive link/);
  assert.equal(drive.count('importLink'), 3);
  assert.deepEqual(links.list().map((l) => l.id), [ROAD], 'failed links are not saved');
  app.ui.sheets.close();
  // a song link: saved with the song's name, at the top (newest used first)
  app.ui.openAddMusic();
  $(sheetOf(app), '.add-link').click();
  pasteLink(app, `https://drive.google.com/file/d/${SONG}/view?usp=drive_link&resourcekey=0-RK`);
  drive.pending.args[1].onInfo({ id: SONG, kind: 'file', name: 'Midnight Signal', songCount: 1, resourceKey: '0-RK' });
  drive.pending.resolve([fakeFile('Midnight Signal.mp3', { remote: { kind: 'gdrive', fileId: SONG } })]);
  await sleep(80);
  assert.match(toastsOf(app), /“Midnight Signal” · added to your songs · queued/);
  assert.deepEqual(links.list().map((l) => l.id), [SONG, ROAD]);
  assert.equal(links.get(SONG).url, `https://drive.google.com/file/d/${SONG}/view?resourcekey=0-RK`);
  // a saved import cancelled before Google Drive answered: the bar's Cancel works, nothing more is saved
  app.ui.openAddMusic();
  rows = $$(sheetOf(app), '.add-saved-row');
  assert.deepEqual(rows.map((r) => textOf($(r, '.add-saved-name'))), ['Midnight Signal', 'Road Trip']);
  $(rows[1], '.add-saved-go').click();
  await sleep(40);
  const late = drive.pending;
  $(bar, '.ib-cancel').click();
  assert.equal(bar.hidden, true);
  assert.match(toastsOf(app), /Import cancelled/);
  late.args[1].onInfo({ id: '1SomethingElse_000000000', kind: 'folder', name: 'Late', songCount: 2 });
  late.resolve([]);
  await sleep(40);
  assert.equal(links.size, 2, 'an answer after Cancel is not saved');
  // diagnostics: how many, never the links or names
  const diag = app.ui.diagnostics();
  assert.equal(diag.sources.savedDriveLinks, 2);
  assert(!/Road Trip|Midnight|drive\.google/.test(JSON.stringify(diag.sources)));
  sheet = null;
  app.ui.destroy();
});

test('Saved links sheet: cards above the paste field, Import again, Copy link, Rename, Remove, Forget all', async () => {
  const drive = new FakeDrive();
  const app = makeApp(360, 560, { drive });
  const { links } = app;
  links.save({ id: ROAD, kind: 'folder', name: 'Road Trip', songCount: 9 });
  links.save({ id: SONG, kind: 'file', name: 'Midnight Signal', songCount: 1 });
  await startAudio(app);
  // Add music > All saved links (2) opens the link sheet
  app.ui.openAddMusic();
  assert.equal($$(sheetOf(app), '.add-saved-row').length, 2);
  $(sheetOf(app), '.add-saved-all').click();
  let sheet = sheetOf(app);
  assert.equal(sheet.dataset.sheet, 'drive-link');
  assert.equal($(sheet, '.sheet-back').hidden, false, 'Back returns to Add music');
  const body = $(sheet, '.sheet-body');
  assert(body.children[0].classList.contains('dl-saved'), 'Saved links come first, above the paste field');
  assert.equal(textOf($(body.children[0], '.sheet-h')), 'Saved links');
  assert($(body.children[1], '.src-form'));
  let cards = $$(sheet, '.dl-row');
  assert.deepEqual(cards.map((c) => textOf($(c, '.dl-name'))), ['Midnight Signal', 'Road Trip']);
  assert.deepEqual(cards.map((c) => textOf($(c, '.dl-meta'))), ['Song · imported today', '9 songs · imported today']);
  assert.deepEqual(cards.map((c) => c.dataset.kind), ['file', 'folder']);
  assert.equal(textOf($(cards[1], '.dl-go')), 'Import again');
  assert.equal($(cards[1], '.dl-go').getAttribute('aria-label'), 'Import “Road Trip” again');
  // ⋯ opens Copy link / Rename / Remove for that card only
  const road = () => $$(sheetOf(app), '.dl-row').find((c) => c.dataset.id === ROAD);
  $(road(), '.dl-more').click();
  assert.equal($(road(), '.dl-more').getAttribute('aria-expanded'), 'true');
  assert.deepEqual($$(road(), '.dl-actions button').map(textOf), ['Copy link', 'Rename', 'Remove']);
  assert.equal($$(sheetOf(app), '.dl-menu').length, 1);
  // Copy link: the clipboard when there is one
  const copied = [];
  G.navigator.clipboard = { writeText: async (t) => {
    copied.push(t);
  } };
  $(road(), '.dl-copy').click();
  await sleep(10);
  assert.deepEqual(copied, [`https://drive.google.com/drive/folders/${ROAD}`]);
  assert.match(toastsOf(app), /Link copied/);
  // ... else (or when it refuses) a field with the link to select and copy by hand
  G.navigator.clipboard = { writeText: async () => {
    throw new Error('NotAllowedError');
  } };
  $(road(), '.dl-copy').click();
  await sleep(10);
  let field = $(road(), '.dl-url');
  assert(field, 'the select-text fallback');
  assert.equal(field.value, `https://drive.google.com/drive/folders/${ROAD}`);
  assert.equal(field.getAttribute('readonly'), '');
  delete G.navigator.clipboard;
  $(road(), '.dl-more').click(); // closes the menu
  assert.equal($(road(), '.dl-menu'), null);
  $(road(), '.dl-more').click();
  $(road(), '.dl-copy').click();
  field = $(road(), '.dl-url');
  assert.equal(field.value, `https://drive.google.com/drive/folders/${ROAD}`);
  assert.match(textOf($(road(), '.dl-copy-note')), /Select the link and copy it/);
  // Rename: inline, an empty name is refused, the new name is kept
  $(road(), '.dl-rename-btn').click();
  const input = $(road(), '.dl-name-input');
  assert.equal(input.value, 'Road Trip');
  assert.equal(G.document.activeElement, input, 'the name field gets the focus');
  type(input, '   ');
  submit($(road(), '.dl-rename'));
  assert.equal($(road(), '.dl-error').hidden, false);
  assert.equal(textOf($(road(), '.dl-error')), 'Type a name.');
  type($(road(), '.dl-name-input'), 'Car songs');
  submit($(road(), '.dl-rename'));
  assert.equal(links.get(ROAD).name, 'Car songs');
  assert.equal(textOf($(road(), '.dl-name')), 'Car songs');
  assert.equal($(road(), '.dl-name-input'), null);
  // Cancel and Escape leave the name alone
  $(road(), '.dl-more').click();
  $(road(), '.dl-rename-btn').click();
  type($(road(), '.dl-name-input'), 'Something else');
  $(road(), '.dl-cancel').click();
  assert.equal(links.get(ROAD).name, 'Car songs');
  // Remove: two taps ("Remove?" first), and the first tap gives up after a moment
  $(road(), '.dl-more').click();
  $(road(), '.dl-rm').click();
  assert.equal(textOf($(road(), '.dl-rm')), 'Remove?');
  assert($(road(), '.dl-rm').classList.contains('armed'));
  assert.equal(links.size, 2, 'not yet');
  await sleep(3700);
  assert.equal(textOf($(road(), '.dl-rm')), 'Remove');
  $(road(), '.dl-rm').click();
  $(road(), '.dl-rm').click();
  assert.equal(links.size, 1);
  assert.equal(links.get(ROAD), null);
  assert.match(toastsOf(app), /Removed “Car songs” from your saved links/);
  cards = $$(sheetOf(app), '.dl-row');
  assert.deepEqual(cards.map((c) => c.dataset.id), [SONG]);
  // the quick rows follow at once
  app.ui.sheets.back();
  assert.equal($$(sheetOf(app), '.add-saved-row').length, 1);
  assert.equal(textOf($(sheetOf(app), '.add-saved-all')).trim(), 'All saved links (1)');
  // Import again: the sheet closes, the import runs with the bar
  $(sheetOf(app), '.add-saved-all').click();
  $($$(sheetOf(app), '.dl-row')[0], '.dl-go').click();
  assert.equal($(app.root, '.sheet-layer').hidden, true);
  assert.equal(drive.pending.args[0], `https://drive.google.com/file/d/${SONG}/view`);
  await sleep(40);
  assert.equal(textOf($(app.root, '.import-bar .ib-detail')), 'Getting “Midnight Signal”…');
  // while it runs, a second Import again explains inside the sheet
  app.ui.openAddMusic();
  $(sheetOf(app), '.add-saved-all').click();
  $($$(sheetOf(app), '.dl-row')[0], '.dl-go').click();
  assert.equal(sheetOf(app).dataset.sheet, 'drive-link');
  assert.match(textOf($(sheetOf(app), '.dl-error')), /Another import is still running/);
  drive.pending.resolve([]);
  await sleep(40);
  // Forget all saved links: asks first; afterwards the section and the quick rows are gone
  $(sheetOf(app), '.dl-forget').click();
  await sleep(10);
  const dlg = $(app.root, '.dialog-layer');
  assert.match(textOf(dlg), /Forget all saved links\?/);
  buttonByText(dlg, 'Forget links').click();
  await sleep(20);
  assert.equal(links.size, 0);
  assert.equal($(sheetOf(app), '.dl-saved').hidden, true);
  assert.match(toastsOf(app), /Saved links forgotten/);
  app.ui.sheets.back();
  assert.equal($(sheetOf(app), '.add-saved').hidden, true);
  app.ui.sheets.close();
  // another tab saves a link while the sheet is open: it shows up
  app.ui.openAddMusic();
  $(sheetOf(app), '.add-link').click();
  links.save({ id: ROAD, kind: 'folder', name: 'From the other tab', songCount: 4 });
  assert.equal($(sheetOf(app), '.dl-saved').hidden, false);
  assert.equal(textOf($(sheetOf(app), '.dl-name')), 'From the other tab');
  app.ui.destroy();
  // Drive links not set up: no quick rows even with saved links; Help explains where they are
  const app2 = makeApp(360, 560, { drive: new FakeDrive({ configured: false }) });
  app2.links.save({ id: ROAD, kind: 'folder', name: 'Road Trip', songCount: 9 });
  await startAudio(app2);
  app2.ui.openAddMusic();
  assert.equal($(sheetOf(app2), '.add-saved').hidden, true);
  app2.ui.openMenu();
  rowByLabel(sheetOf(app2), 'Help').click();
  assert.match(textOf(sheetOf(app2)), /Drive links you import are remembered on this device \(Add music > Paste a Google Drive link > Saved links\)/);
  assert.match(textOf(sheetOf(app2)), /clearing the browser’s site data removes them/);
  app2.ui.destroy();
  // a build without the store: no quick rows, no section, imports still work
  const app3 = makeApp(360, 560, { drive: new FakeDrive(), links: null });
  await startAudio(app3);
  app3.ui.openAddMusic();
  assert.equal($(sheetOf(app3), '.add-saved').hidden, true);
  $(sheetOf(app3), '.add-link').click();
  assert.equal($(sheetOf(app3), '.dl-saved').hidden, true);
  pasteLink(app3, `https://drive.google.com/drive/folders/${ROAD}`);
  app3.drive.pending.args[1].onInfo({ id: ROAD, kind: 'folder', name: 'Road Trip', songCount: 1 });
  app3.drive.pending.resolve([roadSong(7)]);
  await sleep(80);
  assert.match(toastsOf(app3), /“Road Trip” · 1 new song added/);
  app3.ui.destroy();
  sheet = null;
});

/**
 * The Drive API for a real GoogleDriveSource (public links, API key only): files.get by id, one folder listing
 * page, media by id. Records every request; `firstMedia` holds what `onFirstMedia()` saw at the first download.
 */
function driveApiStub({ meta = {}, files = [], onFirstMedia = () => null } = {}) {
  const log = { calls: [], media: [], firstMedia: undefined };
  const media = new Map(files.map((f, i) => [f.id, new Uint8Array(200 + i).fill(7)]));
  const notFound = () => Response.json({ error: { code: 404, errors: [{ reason: 'notFound' }] } }, { status: 404 });
  const fetch = async (url, init = {}) => {
    const u = String(url);
    log.calls.push({ url: u, headers: { ...(init.headers || {}) } });
    const m = /\/drive\/v3\/files(?:\/([^?]+))?\?(.*)$/.exec(u);
    if (!m) throw new TypeError('Failed to fetch');
    const id = m[1] ? decodeURIComponent(m[1]) : '';
    if (id && /(^|&)alt=media(&|$)/.test(m[2])) {
      if (log.firstMedia === undefined) log.firstMedia = onFirstMedia();
      log.media.push(id);
      const bytes = media.get(id);
      if (!bytes) return notFound();
      const headers = new Headers({ 'content-length': String(bytes.length), 'content-type': 'audio/mpeg' });
      return { ok: true, status: 200, body: null, headers, arrayBuffer: async () => bytes.slice().buffer };
    }
    if (id) return meta[id] ? Response.json(meta[id]) : notFound();
    return Response.json({ files });
  };
  return { fetch, log };
}

/** A real GoogleDriveSource with only the API key (links work, no sign-in, no Google scripts). */
function realDrive(api) {
  return new GoogleDriveSource({ config: { google: { apiKey: 'AIzaTESTKEY' } }, library: null, deps: {
    global: {}, document: null, fetch: api.fetch, storage: memStore(), location: { origin: 'https://ranama.github.io' },
    loadScript: () => Promise.reject(new Error('no scripts in this test')),
  } });
}

async function until(cond, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) return false;
    await sleep(10);
  }
  return true;
}

test('saved Drive links, real Google Drive source: saved after the lookup, Import again downloads nothing, ' +
  'the resource key, the 60-song limit, blocked storage', async () => {
  const songs = (prefix, n) => Array.from({ length: n }, (_, i) => ({
    id: `1${prefix}Song${String(i).padStart(3, '0')}xxxxxxxx`, name: `${prefix} ${String(i + 1).padStart(2, '0')}.mp3`,
    mimeType: 'audio/mpeg', size: String(200 + i), modifiedTime: '2026-01-02T10:00:00.000Z', resourceKey: `0-s${i}`,
  }));
  const road = songs('Road', 3);
  let app = null;
  const api = driveApiStub({
    meta: { [ROAD]: { id: ROAD, name: 'Road Trip', mimeType: 'application/vnd.google-apps.folder', resourceKey: '0-FK' } },
    files: road,
    onFirstMedia: () => app.links.size,
  });
  const drive = realDrive(api);
  app = makeApp(360, 560, { drive });
  drive.library = app.library; // the source looks for songs it already has in the app's library
  const { links, library } = app;
  await startAudio(app);
  // paste a folder link with a resource key: the link is saved as soon as Drive says what it is (before the songs)
  app.ui.openAddMusic();
  $(sheetOf(app), '.add-link').click();
  pasteLink(app, `https://drive.google.com/drive/folders/${ROAD}?resourcekey=0-FK&usp=sharing`);
  assert(await until(() => /Road Trip/.test(toastsOf(app))), toastsOf(app));
  assert.equal(api.log.firstMedia, 1, 'saved before the first download');
  assert.equal(api.log.media.length, 3);
  const saved = links.get(ROAD);
  assert.equal(saved.url, `https://drive.google.com/drive/folders/${ROAD}?resourcekey=0-FK`);
  assert.equal(saved.name, 'Road Trip');
  assert.equal(saved.songCount, 3);
  assert.match(toastsOf(app), /“Road Trip” · 3 new songs added · 3 queued, loading on deck A/);
  assert.equal(library.list().filter((e) => !e.demo).length, 3);
  // Import again from Add music: the same folder with its resource key, and nothing is downloaded again
  const before = api.log.calls.length;
  const firstTime = saved.lastImportedAt;
  app.ui.openAddMusic();
  $($$(sheetOf(app), '.add-saved-row')[0], '.add-saved-go').click();
  assert(await until(() => /no new songs/.test(toastsOf(app))), toastsOf(app));
  const again = api.log.calls.slice(before);
  assert.equal(again.length, 2, 'only the folder lookup and its listing');
  for (const c of again) assert.equal(c.headers['X-Goog-Drive-Resource-Keys'], `${ROAD}/0-FK`, 'the resource key goes along');
  assert.equal(api.log.media.length, 3, 'no song downloaded again');
  assert.match(toastsOf(app), /“Road Trip” · no new songs, all 3 are already in your library · all already in the set list/); // still waiting in the set list: not queued twice
  assert.equal(library.list().filter((e) => !e.demo).length, 3);
  assert.equal(links.size, 1);
  assert(links.get(ROAD).lastImportedAt > firstTime, 'marked as used again');
  // the note on the link sheet: nothing about storage while it works
  app.ui.openAddMusic();
  $(sheetOf(app), '.add-link').click();
  assert.match(textOf($(sheetOf(app), '.dl-note')), /^Links you imported on this device/);
  assert(!/this visit/.test(textOf($(sheetOf(app), '.dl-note'))));
  app.ui.destroy();

  // a big folder while the browser blocks storage: the import works, the 60-song notice still shows, the link
  // lasts for this visit and the Saved links note says so
  const BIG = '1BigFolder_000000000000000';
  const big = songs('Big', LIBRARY_CAP + 2);
  const bigMeta = { id: BIG, name: 'Big Folder', mimeType: 'application/vnd.google-apps.folder' };
  const api2 = driveApiStub({ meta: { [BIG]: bigMeta }, files: big });
  const blocked = { getItem() {
    throw new Error('SecurityError');
  }, setItem() {
    throw new Error('QuotaExceededError');
  }, removeItem() {
    throw new Error('SecurityError');
  } };
  const drive2 = realDrive(api2);
  const app2 = makeApp(360, 560, { drive: drive2, links: new SavedDriveLinks({ storage: blocked, events: null }) });
  drive2.library = app2.library;
  await startAudio(app2);
  app2.ui.openAddMusic();
  $(sheetOf(app2), '.add-link').click();
  pasteLink(app2, `https://drive.google.com/drive/folders/${BIG}`);
  assert(await until(() => /Big Folder/.test(toastsOf(app2)), 8000), toastsOf(app2));
  assert.equal(api2.log.media.length, LIBRARY_CAP);
  assert.match(toastsOf(app2), new RegExp(`That folder has ${LIBRARY_CAP + 2} songs\\. TwinSpin imported the first ${LIBRARY_CAP}`));
  assert.match(toastsOf(app2), new RegExp(`“Big Folder” · ${LIBRARY_CAP} new songs added · ${LIBRARY_CAP} queued`));
  assert.equal(app2.links.persistent, false);
  assert.equal(app2.links.get(BIG).songCount, LIBRARY_CAP + 2);
  app2.ui.openAddMusic();
  $(sheetOf(app2), '.add-link').click();
  assert.match(textOf($(sheetOf(app2), '.dl-note')), /blocks storage for TwinSpin, so they are kept for this visit only/);
  app2.ui.destroy();
});

// ---------------------------------------------------------------------------------------------------------
// Songs from Suno (src/ui/sheets/suno-sheet.js): the helper script extras/suno-playlist-downloader.js

const SUNO_SCRIPT = new URL('../extras/suno-playlist-downloader.js', import.meta.url);

/** Open Add music > Songs from Suno; returns the sheet. */
function openSuno(app) {
  app.ui.openAddMusic();
  const opt = $(sheetOf(app), '.add-suno');
  assert(opt, 'the Songs from Suno option');
  opt.click();
  const sheet = sheetOf(app);
  assert.equal(sheet.dataset.sheet, 'suno');
  return sheet;
}

test('Songs from Suno: the option opens the sheet, the script loads, Copy script, the select fallback, ' +
  'Download script, the Drive link shortcut, This device', async () => {
  const want = await (await realFetch(SUNO_SCRIPT)).text();
  assert(want.length > 1000 && /Suno Playlist Downloader/.test(want), 'the helper script is in extras/');
  const fetched = [];
  const origFetch = G.fetch;
  G.fetch = (url, init) => {
    fetched.push(String(url));
    return origFetch(url, init);
  };
  try {
    const app = makeApp(360, 560, { drive: new FakeDrive() });
    await startAudio(app);
    app.ui.openAddMusic();
    const opt = $(sheetOf(app), '.add-suno');
    assert.equal(textOf($(opt, '.row-label')), 'Songs from Suno');
    assert.equal(textOf($(opt, '.row-detail')), 'Download your Suno songs, then add them here');
    assert.equal(fetched.filter((u) => /suno-playlist-downloader/.test(u)).length, 0, 'nothing loads before the sheet opens');
    const sheet = openSuno(app);
    assert.equal(textOf($(sheet, '.sheet-title')), 'Songs from Suno');
    assert.equal($(sheet, '.sheet-back').hidden, false, 'Back returns to Add music');
    assert.deepEqual($$(sheet, '.sheet-h').map(textOf),
      ['One song at a time (phone or computer)', 'A whole playlist at once (computer)', 'Get them into TwinSpin']);
    const secs = $$(sheet, '.sheet-sec');
    const one = secs.find((s) => textOf($(s, '.sheet-h')) === 'One song at a time (phone or computer)');
    assert.match(textOf(one), /⋯ menu > Download > MP3 \(WAV on paid plans\)/);
    assert.match(textOf(one), /Add music > This device/);
    assert.match(textOf(one), /download limit.*non-commercial use only.*Check your plan/);
    const pl = secs.find((s) => textOf($(s, '.sheet-h')) === 'A whole playlist at once (computer)');
    assert.match(textOf(pl), /downloads every song you made in a playlist/);
    assert.deepEqual($$(pl, '.suno-steps kbd').map(textOf), ['Ctrl+Shift+J', 'Ctrl+Shift+K', 'Cmd+Option+J', 'Cmd+Option+K']);
    assert.deepEqual($$(pl, '.suno-steps code').map(textOf), ['/playlist/', 'allow pasting']);
    // the steps in the order they are done; the console keys for each browser (Firefox's Ctrl+Shift+J would open
    // its Browser Console, not the page's console); allow pasting after the first paste, which is when it is asked
    const stepTexts = $$(pl, '.suno-steps li').map(textOf);
    assert.equal(stepTexts.length, 7);
    assert.match(stepTexts[0], /^On a computer, open suno\.com in Chrome, Edge or Firefox and sign in\./);
    assert.match(stepTexts[1], /\/playlist\//);
    assert.equal(stepTexts[2], 'Open the browser console. Windows or Linux: Ctrl+Shift+J in Chrome or Edge, ' +
      'Ctrl+Shift+K in Firefox. Mac: Cmd+Option+J in Chrome or Edge, Cmd+Option+K in Firefox.');
    assert.match(stepTexts[3], /Copy script below\. Paste it into the console on suno\.com and press Enter\./);
    assert.match(stepTexts[4], /^The first time, the browser may ask you to type allow pasting\. Do what it says/);
    assert.equal(stepTexts[5], 'A panel appears on suno.com. Keep MP3 ticked (MP3 is enough for TwinSpin). In Chrome or Edge choose ' +
      'Save to: A folder I pick. Click Start, then pick a folder and allow it when the browser asks.');
    assert.equal(stepTexts[6], 'If you save to the Downloads folder (the only choice in Firefox), allow multiple downloads when the ' +
      'browser asks. The songs land in your Downloads folder.');
    assert.equal(textOf($(pl, '.suno-tip')), 'You can Pause, minimise the panel to a small progress pill, or close it and paste ' +
      'the script again later: it skips the songs it already saved.');
    assert.match(textOf($(pl, '.suno-phone')), /^Phones have no console/);
    // the note is honest about the risk: not Suno's, can stop working, Suno's terms, the account, paid gigs
    const caution = $(pl, '.suno-note');
    assert.equal(caution.getAttribute('role'), 'note');
    assert.match(textOf(caution), /^This helper is not made by Suno\./);
    assert.match(textOf(caution), /If it saves nothing, use Suno’s own Download\./);
    assert.match(textOf(caution), /If Suno blocks the direct file, the helper uses Suno’s own Download, which counts toward your plan’s downloads\. The panel shows how many you have left\./);
    assert.match(textOf(caution), /Suno’s terms do not allow bots, scraping or downloading in ways Suno did not make for that\./);
    assert.match(textOf(caution), /break those terms, and Suno could act against your account\. Use it at your own risk\./);
    assert.match(textOf(caution), /For paid gigs, use songs from Suno’s own Download on a paid plan\./);
    assert.match(textOf(caution), /Only paste code you trust into a browser console/);
    assert(!/\b(7|20|60) (lifetime|a month|downloads|per month)/.test(textOf(sheet)), 'no plan numbers: they change');
    // the script loads when the sheet opens: Copy script waits for it
    const copy = $(sheet, '.suno-copy');
    assert.equal(copy.disabled, true, 'Copy script waits for the text');
    assert.equal(textOf($(sheet, '.suno-status')), 'Getting the script…');
    assert.equal($(sheet, '.suno-show').hidden, true);
    assert(await until(() => !copy.disabled), 'the script loaded');
    assert.deepEqual(fetched.filter((u) => /suno-playlist-downloader/.test(u)), [SUNO_SCRIPT.href]);
    assert.equal(textOf($(sheet, '.suno-status')), '');
    assert.equal($(sheet, '.suno-error').hidden, true);
    const show = $(sheet, '.suno-show');
    assert.equal(show.hidden, false);
    assert.equal(textOf($(show, 'summary')), 'Show the script');
    const box = $(show, 'textarea.suno-code');
    assert.equal(box.value, want, 'the whole script, unchanged');
    // the steps name the panel's own labels (the script builds them with these exact texts)
    for (const label of ["text: 'Save to'", "radio('folder', 'A folder I pick", "radio('downloads', 'Downloads folder'", "text: 'Start'",
      "text: 'Pause'", "label: 'MP3 audio'", "check('skipSaved', 'Skip songs saved before')"]) assert(want.includes(label), `the panel has ${label}`);
    assert(/'Start again'/.test(want) && /'Resume'/.test(want) && /minimise/i.test(want), 'Start again, Resume, minimise');
    assert.equal(box.getAttribute('readonly'), '');
    // Download script (.js): a plain same-origin link to the file, saved under its own name
    const dl = $(sheet, 'a.suno-download');
    assert.equal(dl.getAttribute('href'), SUNO_SCRIPT.href);
    assert.equal(dl.getAttribute('download'), 'suno-playlist-downloader.js');
    assert.equal(dl.getAttribute('target'), null);
    assert.equal(textOf(dl), 'Download script (.js)');
    // Copy script: the clipboard, called inside the tap with the fetched text
    const copied = [];
    G.navigator.clipboard = { writeText: async (t) => {
      copied.push(t);
    } };
    copy.click();
    assert.equal(copied.length, 1, 'writeText runs inside the click');
    assert.equal(copied[0], want);
    await sleep(10);
    assert.match(textOf($(sheet, '.suno-status')), /^Copied\. Paste it into the console on suno\.com/);
    assert.match(toastsOf(app), /Script copied/);
    assert.notEqual(show.open, true, 'the box stays closed when copying worked');
    // a clipboard that refuses: the script box opens with the text selected
    const proto = Object.getPrototypeOf(box);
    const selected = [];
    proto.select = function select() {
      selected.push(this);
    };
    proto.setSelectionRange = function setSelectionRange(a, b) {
      this._range = [a, b];
    };
    try {
      G.navigator.clipboard = { writeText: async () => {
        throw new Error('NotAllowedError');
      } };
      copy.click();
      await sleep(10);
      assert.equal(show.open, true, 'Show the script opens');
      assert.equal(G.document.activeElement, box, 'the box has the focus');
      assert.deepEqual(selected, [box], 'its text is selected');
      assert.deepEqual(box._range, [0, want.length]);
      assert.match(textOf($(sheet, '.suno-status')), /did not let TwinSpin copy\. The script is selected below/);
      // no clipboard at all (an http page, an older browser): the same, at once
      delete G.navigator.clipboard;
      show.open = false;
      G.document.activeElement = G.document.body;
      copy.click();
      assert.equal(show.open, true);
      assert.equal(G.document.activeElement, box);
      assert.equal(selected.length, 2);
    } finally {
      delete proto.select;
      delete proto.setSelectionRange;
      delete G.navigator.clipboard;
    }
    // Get them into TwinSpin: Paste a Google Drive link opens the link sheet, Back returns here
    const into = secs.find((s) => textOf($(s, '.sheet-h')) === 'Get them into TwinSpin');
    assert.match(textOf(into), /New > Folder upload and choose that folder\. \(With Google Drive for desktop/);
    assert.match(textOf(into), /“Anyone with the link”/);
    assert.match(textOf(into), /Saved links/);
    assert.equal($(into, '.sheet-note.warn'), null, 'Drive links are set up: no setup note');
    $(into, '.suno-drive').click();
    assert.equal(sheetOf(app).dataset.sheet, 'drive-link');
    assert($(sheetOf(app), '[id=drive-link-input]'), 'the paste field');
    app.ui.sheets.back();
    assert.equal(sheetOf(app).dataset.sheet, 'suno');
    // ... and Choose the songs adds the downloaded files like This device
    await until(() => !$(sheetOf(app), '.suno-copy').disabled);
    const pick = $(sheetOf(app), 'label.suno-files');
    assert(pick, 'Choose the songs');
    const input = $(pick, 'input');
    input.files = [fakeFile('01 - Neon Tide [1a2b3c4d].mp3'), fakeFile('02 - Glass Rain [5e6f7a8b].mp3')];
    input.dispatchEvent(new FakeEvent('change'));
    await sleep(60);
    assert.equal($(app.root, '.sheet-layer').hidden, true);
    assert.equal(app.library.list().filter((e) => !e.demo).length, 2);
    assert.equal(app.playlist.items.length, 2);
    // closed before the script arrives: the late answer (the text, or a failure) touches nothing
    for (const ok of [true, false]) {
      let release = null;
      const asked = [];
      G.fetch = (url) => {
        asked.push(String(url));
        return new Promise((resolve, reject) => {
          release = () => (ok ? resolve(origFetch(url)) : reject(new TypeError('Failed to fetch')));
        });
      };
      const again = openSuno(app);
      assert.deepEqual(asked, [SUNO_SCRIPT.href]);
      const box2 = $(again, 'textarea.suno-code');
      app.ui.sheets.close();
      release();
      await sleep(30);
      assert.equal(box2.value || '', '', 'the late text is ignored');
      assert.equal($(again, '.suno-copy').disabled, true);
      assert.equal($(again, '.suno-show').hidden, true);
      assert.equal($(again, '.suno-error').hidden, true, 'a late failure is ignored too');
      assert.equal(textOf($(again, '.suno-status')), 'Getting the script…');
    }
    app.ui.destroy();
  } finally {
    G.fetch = origFetch;
  }
});

test('Songs from Suno: the script address works under any base (GitHub Pages /twinspin/, localhost, a query)', async () => {
  const { sunoScriptUrl, SUNO_SCRIPT_NAME } = await import('../src/ui/sheets/suno-sheet.js');
  assert.equal(SUNO_SCRIPT_NAME, 'suno-playlist-downloader.js');
  assert.equal(sunoScriptUrl(), SUNO_SCRIPT.href, 'next to the app: <root>/extras/');
  assert.equal(sunoScriptUrl('https://ranama.github.io/twinspin/src/ui/sheets/suno-sheet.js'),
    'https://ranama.github.io/twinspin/extras/suno-playlist-downloader.js');
  assert.equal(sunoScriptUrl('http://localhost:8100/src/ui/sheets/suno-sheet.js?v=2'),
    'http://localhost:8100/extras/suno-playlist-downloader.js');
  assert.equal(sunoScriptUrl('https://abc.trycloudflare.com/src/ui/sheets/suno-sheet.js'),
    'https://abc.trycloudflare.com/extras/suno-playlist-downloader.js');
  // the published site and the service worker keep it at that same place
  const sw = await (await realFetch(new URL('../sw.js', import.meta.url))).text();
  assert(sw.includes("'./extras/suno-playlist-downloader.js',"), 'sw.js keeps the script offline');
  assert(sw.includes("'./src/ui/sheets/suno-sheet.js',"), 'sw.js keeps the sheet offline');
});

test('Songs from Suno: a script that cannot load says so and links it on GitHub; no Drive links set up', async () => {
  const origFetch = G.fetch;
  try {
    for (const fail of [() => Promise.reject(new TypeError('Failed to fetch')),
      async () => ({ ok: false, status: 404, text: async () => 'Not found' })]) {
      G.fetch = fail;
      const app = makeApp(360, 560, { drive: new FakeDrive({ configured: false }) });
      await startAudio(app);
      const sheet = openSuno(app);
      const err = $(sheet, '.suno-error');
      assert(await until(() => !err.hidden), 'the error shows');
      assert.equal(err.getAttribute('role'), 'alert');
      assert.match(textOf(err), /^The script could not be loaded\. Check your connection and open this page again, or get it from GitHub/);
      const link = $(err, 'a.src-link');
      assert.equal(link.getAttribute('href'), T.GUIDES.sunoScript);
      assert.equal(link.getAttribute('href'), 'https://github.com/Ranama/twinspin/blob/main/extras/suno-playlist-downloader.js');
      assert.equal(link.getAttribute('target'), '_blank');
      assert.equal(link.getAttribute('rel'), 'noopener');
      assert.equal($(sheet, '.suno-copy').disabled, true, 'nothing to copy');
      assert.equal($(sheet, '.suno-show').hidden, true, 'nothing to show');
      assert.equal(textOf($(sheet, '.suno-status')), '');
      // Drive links are not set up on this copy: the phone route says how to get by without them
      assert.match(textOf($(sheet, '.sheet-note.warn')), /Drive links need the one-time Google setup/);
      $(sheet, '.suno-drive').click();
      assert.equal(sheetOf(app).dataset.sheet, 'drive-link');
      assert.match(textOf(sheetOf(app)), /needs the one-time Google setup/);
      app.ui.destroy();
    }
  } finally {
    G.fetch = origFetch;
  }
});

test('no errors were logged', () => {
  assert.deepEqual(errors, []);
});
