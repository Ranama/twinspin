// Music player UI (docs/PLAYER.md section 5): the pure wording / state helpers (src/ui/player-text.js), the player
// rows of the layout budget (src/ui/layout-math.js: playerBox, playerLayout, stripFit, the PLAYER tab and page),
// and the app shell on the fake DOM with the real Playlist, a fake AutoMix and a fake Player that follows the
// docs/PLAYER.md section 4 API: the PLAYER tab (five tabs at most), the page in all four layouts (one / two
// columns, big / small cover), now playing, seek bar (off while mixing, with a hint), transport, transition
// chooser (sheet on phones, inline in two columns), volume, Up next (tap, remove, drag and keyboard reorder),
// Clear queue, History, the empty state, the DECKS strip's mini transport, keys Space / N / B, the Songs page ⋯
// sheet (Play now / Play next / Add to queue / Remove), Help, the menu, and the PLAYER light while it plays.

import {
  playerSnapshot, playerView, transitionText, transitionShort, transitionInfo, nextRepeat, repeatInfo, seekTarget,
  queueKey, queueMoveIndex, songActionText, cleanCrossfade, cleanTransition, cleanRepeat, fmtSeconds, TRANSITIONS,
  REPEAT_MODES,
} from '../src/ui/player-text.js';
import {
  computeSizes, playerBox, playerLayout, stripFit, stripWidth, automixPlacement, visibility, tabsFor, effectivePage,
  pickLayout, PLAYER_GEOM, STRIP,
} from '../src/ui/layout-math.js';
import { installFakeDom, FakeEvent, Element, FakeDocument } from './helpers/fake-dom.js';
import { FakeEngine, FakeDeck, FakeSync, FakeLibrary } from './helpers/fake-models.js';
import { Emitter } from '../src/core/emitter.js';

const G = globalThis;
const errors = [];
const origError = console.error.bind(console);
console.error = (...args) => {
  errors.push(args.map((a) => (a && a.stack) || String(a)).join(' '));
  origError(...args);
};

// ---------------------------------------------------------------------------------------------------------
// Pure helpers

test('transition styles, repeat cycle, seconds and toast wording', () => {
  assert.deepEqual(TRANSITIONS.map((t) => t.value), ['dj', 'crossfade', 'gapless']);
  assert.deepEqual(TRANSITIONS.map((t) => t.label), ['DJ mix', 'Crossfade', 'Gapless']);
  assert.equal(cleanTransition('bogus'), 'dj');
  assert.equal(transitionInfo('gapless').label, 'Gapless');
  assert.match(transitionText('dj'), /Beat-matched/);
  assert.equal(transitionText('crossfade', 8), 'Fades one song into the next over 8 seconds.');
  assert.equal(transitionText('crossfade', 6.5), 'Fades one song into the next over 6.5 seconds.');
  assert.match(transitionText('gapless'), /starts the moment this one ends/);
  assert.equal(transitionShort('crossfade', 4), 'Crossfade 4 s');
  assert.equal(transitionShort('dj', 4), 'DJ mix');
  assert.equal(cleanCrossfade(1), 2);
  assert.equal(cleanCrossfade(30), 12);
  assert.equal(cleanCrossfade(6.3), 6.5);
  assert.equal(cleanCrossfade(NaN), 6);
  assert.equal(fmtSeconds(7), '7 s');
  assert.equal(fmtSeconds(7.5), '7.5 s');
  assert.deepEqual(REPEAT_MODES, ['off', 'all', 'one']);
  assert.equal(nextRepeat('off'), 'all');
  assert.equal(nextRepeat('all'), 'one');
  assert.equal(nextRepeat('one'), 'off');
  assert.equal(nextRepeat('nonsense'), 'all');
  assert.equal(cleanRepeat(undefined), 'off');
  assert.equal(repeatInfo('one').icon, 'repeatOne');
  assert.equal(repeatInfo('all').on, true);
  assert.equal(repeatInfo('off').on, false);
  assert.equal(songActionText('now', 'Neon Drift'), 'Playing “Neon Drift”');
  assert.equal(songActionText('next', 'Neon Drift'), '“Neon Drift” plays next');
  assert.equal(songActionText('queue', 'Neon Drift'), 'Added “Neon Drift” to the queue');
});

test('snapshot reads a player defensively; the view covers every state', () => {
  const none = playerView(playerSnapshot(null, null, null));
  assert.equal(none.empty, true);
  // getters that throw or are missing never break the page
  const broken = { get state() { throw new Error('x'); }, get nowPlaying() { throw new Error('y'); } };
  const sb = playerSnapshot(broken, null, null);
  assert.equal(sb.state, 'stopped');
  assert.equal(sb.hasNow, false);
  assert.equal(playerView(sb).title, 'Your queue is empty');

  const item = { uid: 'u1', title: 'Neon Drift', artist: 'TwinSpin', bpm: 124, duration: 96 };
  const deck = { playing: true };
  const p = {
    state: 'playing', nowPlaying: { item, deckIndex: 1, title: 'Neon Drift', artist: 'TwinSpin', bpm: 124.04, hue: 200 },
    position: 30, duration: 96, upNext: [{ uid: 'u2', title: 'Spore Garden' }], history: [], shuffle: true, repeat: 'all',
    transition: 'crossfade', crossfadeSec: 8, decks: [{}, deck],
  };
  const am = { enabled: true, progress: 0.45, nextItem: { uid: 'u2', title: 'Spore Garden' } };
  const s = playerSnapshot(p, am, null);
  assert.equal(s.title, 'Neon Drift');
  assert.equal(s.deckIndex, 1);
  assert.equal(s.deckPlaying, true);
  assert.equal(s.crossfadeSec, 8);
  assert.equal(s.firstUp, 'Spore Garden');
  let v = playerView(s);
  assert.equal(v.stateText, 'NOW PLAYING');
  assert.equal(v.tags, '124 BPM');
  assert.equal(v.deck, 'B');
  assert.equal(v.elapsed, '0:30');
  assert.equal(v.remaining, '-1:06');
  assert.closeTo(v.seek, 30 / 96, 1e-9);
  assert.equal(v.seekEnabled, true);
  assert.equal(v.spinning, true);
  assert.equal(v.playIcon, 'pause');
  assert.equal(v.hue, 200);
  // mixing: no seeking, the "mixing into" line
  v = playerView({ ...s, state: 'mixing' });
  assert.equal(v.seekEnabled, false);
  assert.equal(v.mixing, true);
  assert.equal(v.sub, 'Mixing into Spore Garden · 45%');
  // paused
  v = playerView({ ...s, state: 'paused' });
  assert.equal(v.stateText, 'PAUSED');
  assert.equal(v.playLabel, 'Resume');
  assert.equal(v.spinning, false, 'the record stands still while paused');
  assert.equal(v.seekEnabled, true);
  // loading
  v = playerView({ ...s, state: 'loading' });
  assert.equal(v.busy, true);
  assert.equal(v.seekEnabled, false);
  // stopped: the song play() starts, or a deck played by hand
  v = playerView({ ...s, state: 'stopped', deckPlaying: false });
  assert.equal(v.stateText, 'READY');
  assert.equal(v.sub, 'Press play to start the queue');
  assert.equal(v.playLabel, 'Play the queue');
  v = playerView({ ...s, state: 'stopped', deckPlaying: true });
  assert.equal(v.stateText, 'PLAYING BY HAND');
  assert.equal(v.spinning, true);
  // a hue from the title when the deck has none
  v = playerView({ ...s, hue: null });
  assert(v.hue >= 0 && v.hue < 360);
});

test('seek target, queue signature and drag-to-queue index', () => {
  assert.equal(seekTarget(0, 100), 0);
  assert.closeTo(seekTarget(1, 100), 99.75, 1e-9, 'kept off the very end');
  assert.closeTo(seekTarget(0.5, 100), 49.875, 1e-9);
  assert.equal(seekTarget(0.5, 0), 0);
  assert.equal(seekTarget(NaN, 100), 0);
  const a = [{ uid: 'a', title: 'A' }, { uid: 'b', title: 'B' }];
  assert.equal(queueKey(a), queueKey([...a]));
  assert.notEqual(queueKey(a), queueKey([a[1], a[0]]));
  assert.notEqual(queueKey(a, 'x'), queueKey(a, 'y'));
  const shown = [{ uid: 'c' }, { uid: 'd' }, { uid: 'e' }];
  const idx = { a: 0, b: 1, c: 2, d: 3, e: 4 };
  assert.equal(queueMoveIndex(shown, 2, (u) => idx[u]), 4);
  assert.equal(queueMoveIndex(shown, 0, (u) => idx[u]), 2);
  assert.equal(queueMoveIndex(shown, 3, (u) => idx[u]), -1);
  assert.equal(queueMoveIndex([], 0, (u) => idx[u]), -1);
});

// ---------------------------------------------------------------------------------------------------------
// Layout budget

test('the PLAYER page and tab per layout (five tabs at most)', () => {
  for (const l of ['pp', 'tp', 'pl', 'console']) assert.equal(effectivePage(l, 'player'), 'player');
  assert.deepEqual(tabsFor('pp'), ['decks', 'mix', 'fx', 'songs', 'player']);
  assert.deepEqual(tabsFor('tp'), ['mix', 'fx', 'songs', 'player']);
  // tablet: 4 page tabs + the AUTO MIX switch = 5; phone: 5 page tabs, the switch goes (two taps via the player)
  assert.equal(automixPlacement('tp', 'mix', true, { player: true }).tabToggle, true);
  assert.equal(tabsFor('tp').length + 1, 5);
  assert.equal(automixPlacement('pp', 'decks', true, { player: true }).tabToggle, false);
  assert.equal(automixPlacement('pp', 'decks', true).tabToggle, true, 'without a Player the switch stays');
  // no strip on the player page (it shows everything itself)
  assert.equal(automixPlacement('pp', 'player', true, { player: true }).show, false);
  assert.equal(automixPlacement('tp', 'player', true, { player: true }).row, false);
  // the player page covers the decks, waveforms and crossfader on phones / tablets; a drawer on the console
  for (const l of ['pp', 'tp', 'pl']) {
    const v = visibility(l, 'player', 'A');
    assert.equal(v.player, true, l);
    assert.equal(v.decks || v.waves || v.xf || v.mixer || v.songs, false, l);
  }
  assert.equal(visibility('pp', 'player', 'A').tabs, true);
  assert.equal(visibility('pl', 'player', 'A').tabs, false);
  const c = visibility('console', 'player', 'A');
  assert.equal(c.player && c.decks && c.mixer && c.xf && c.waves, true);
  assert.equal(c.songs, false, 'one drawer at a time');
  assert.equal(visibility('console', 'songs', 'A').player, false);
});

test('player page geometry: one column on phones, two from 640 px, big cover when there is room', () => {
  const lay = (w, h, ins = {}) => {
    const s = computeSizes(pickLayout(w, h), w, h, ins);
    const b = playerBox(s);
    return { s, b, l: playerLayout(b.w, b.h) };
  };
  // 360 x 560: small cover beside the title, and the Up next list keeps its room
  let r = lay(360, 560);
  assert.equal(r.b.w, 328);
  assert.equal(r.b.h, 560 - 44 - 52 - 16);
  assert.equal(r.l.cols, 1);
  assert.equal(r.l.stack, false);
  assert(r.l.art >= 64 && r.l.art <= 96, `art ${r.l.art}`);
  const G2 = PLAYER_GEOM;
  const fixed = Math.max(r.l.art, 76) + G2.seek + G2.transport + G2.opts + 3 * G2.gap;
  assert(r.b.h - fixed >= 160, `queue room at 360 x 560: ${r.b.h - fixed}`);
  // tall phones: a big cover above the title
  r = lay(390, 844, { t: 47, b: 34 });
  assert.equal(r.l.cols, 1);
  assert.equal(r.l.stack, true);
  assert(r.l.art >= 140 && r.l.art <= 280, `art ${r.l.art}`);
  assert(r.l.art <= r.b.w - 64);
  // phone landscape: two columns under the full-width header
  r = lay(844, 390, { l: 59, r: 59, b: 21 });
  assert.equal(r.s.layout, 'pl');
  assert.equal(r.l.cols, 2);
  assert(r.l.colW >= 300 && r.l.colW <= 440);
  // tablet portrait: two columns, big cover
  r = lay(768, 1000);
  assert.equal(r.s.layout, 'tp');
  assert.equal(r.l.cols, 2);
  assert.equal(r.l.stack, true);
  // desktop drawer
  r = lay(1280, 720);
  assert.equal(r.s.layout, 'console');
  assert.equal(r.l.cols, 2);
  assert(r.b.w <= 980 - 36);
  // nonsense input stays sane
  const z = playerLayout(NaN, -5);
  assert.equal(z.cols, 1);
  assert.equal(z.stack, false);
  assert(z.art >= 64);
});

test('the DECKS strip fits the mini transport at 360 x 560', () => {
  const s360 = computeSizes('pp', 360, 560, {}, { am: true });
  const w = stripWidth(s360);
  assert.equal(w, 360 - 32 - STRIP.pad - 2);
  const f = stripFit(w);
  assert.equal(f.transport, 'full', 'previous / play-pause / next next to MIX NOW');
  assert(f.info >= STRIP.infoMin);
  // a 320 px phone drops "previous" first
  assert.equal(stripFit(stripWidth(computeSizes('pp', 320, 500, {}, { am: true }))).transport, 'compact');
  // the console strip also has the AUTO switch: its label goes before the transport does
  const c1 = stripFit(stripWidth(computeSizes('console', 1920, 1080, {})), { toggle: true });
  assert.equal(c1.transport, 'full');
  const c2 = stripFit(stripWidth(computeSizes('console', 1024, 768, {})), { toggle: true });
  assert(c2.transport !== 'full' || !c2.toggleLabel);
  for (const [cw, ch] of [[800, 600], [1024, 700], [1280, 720], [1366, 768]]) {
    const fit = stripFit(stripWidth(computeSizes('console', cw, ch, {})), { toggle: true });
    assert(fit.info >= STRIP.infoMin || fit.transport === 'none', `${cw}x${ch}: ${JSON.stringify(fit)}`);
  }
  assert.equal(stripFit(0).transport, 'none');
  assert.equal(stripWidth(computeSizes('pl', 844, 390, {})), 0, 'phone landscape: pills, no transport');
  // tablets have room for everything
  assert.equal(stripFit(stripWidth(computeSizes('tp', 768, 1000, {}, { am: true }))).transport, 'full');
});

// ---------------------------------------------------------------------------------------------------------
// App shell with the real Playlist, a fake AutoMix and a fake Player

installFakeDom();
const { Settings } = await import('../src/core/settings.js');
const { Playlist } = await import('../src/deck/playlist.js');
const { AppUI } = await import('../src/ui/app-ui.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $$ = (root, sel) => root.querySelectorAll(sel);
const $ = (root, sel) => root.querySelector(sel);
const textOf = (el) => (el ? el.textContent : '');

class FakeAutoMix extends Emitter {
  constructor(playlist) {
    super();
    this.playlist = playlist;
    this.enabled = false;
    this.state = 'off';
    this.currentDeck = null;
    this.nextItem = null;
    this.nextReady = false;
    this.secondsToMix = null;
    this.progress = null;
    this.plan = null;
    this.paused = false;
    this.calls = [];
  }

  setEnabled(on) {
    this.calls.push(['setEnabled', on]);
    if (on && !this.playlist.items.length) {
      this.emit('error', 'Add songs to the set list first.');
      return;
    }
    this.enabled = !!on;
    this.state = on ? 'playing' : 'off';
    if (!on) this.paused = false;
    this.emit('change', 'enabled');
  }

  toggle() {
    this.setEnabled(!this.enabled);
  }

  mixNow() {
    this.calls.push(['mixNow']);
  }

  noteUserCrossfader(x) {
    this.calls.push(['noteUserCrossfader', x]);
  }

  count(name) {
    return this.calls.filter((c) => c[0] === name).length;
  }
}

/** docs/PLAYER.md section 4 on top of the real Playlist and the fake AutoMix (records every call). */
class FakePlayer extends Emitter {
  constructor({ automix, playlist, decks, settings }) {
    super();
    this.automix = automix;
    this.playlist = playlist;
    this.decks = decks;
    this.settings = settings;
    this.calls = [];
    this.position = 0;
    this.duration = 0;
    playlist.on('change', () => this.emit('change', 'queue'));
    automix.on('change', () => this.emit('change', 'state'));
  }

  get state() {
    const am = this.automix;
    if (!am.enabled) return 'stopped';
    if (am.paused) return 'paused';
    return am.state === 'mixing' ? 'mixing' : 'playing';
  }

  get nowPlaying() {
    const pl = this.playlist;
    const it = pl.current || (!this.automix.enabled ? pl.items[0] : null) || null;
    if (!it) return null;
    const di = this.automix.enabled ? 0 : null;
    if (!this._np || this._np.item !== it || this._np.deckIndex !== di) {
      this._np = { item: it, deckIndex: di, title: it.title, artist: it.artist, bpm: it.bpm || null, hue: 210 };
    }
    return this._np;
  }

  get upNext() {
    const np = this.nowPlaying;
    const i = np ? this.playlist.indexOf(np.item.uid) : -1;
    return this.playlist.items.slice(i + 1);
  }

  get history() {
    const np = this.nowPlaying;
    const i = np ? this.playlist.indexOf(np.item.uid) : -1;
    return i > 0 ? this.playlist.items.slice(0, i).reverse() : [];
  }

  get shuffle() {
    return !!this.settings.get('playerShuffle');
  }

  get repeat() {
    return this.settings.get('playerRepeat');
  }

  get transition() {
    return this.settings.get('transitionStyle');
  }

  get crossfadeSec() {
    return this.settings.get('crossfadeSec');
  }

  _c(name, ...args) {
    this.calls.push([name, ...args]);
  }

  count(name) {
    return this.calls.filter((c) => c[0] === name).length;
  }

  play() {
    this._c('play');
    const am = this.automix;
    if (am.enabled && am.paused) {
      am.paused = false;
      am.emit('change', 'state');
      return true;
    }
    am.setEnabled(true);
    if (!am.enabled) return false;
    if (this.playlist.currentIndex < 0) this.playlist.setCurrent(0);
    am.currentDeck = 0;
    this.duration = 96;
    this.position = 12;
    return true;
  }

  pause() {
    this._c('pause');
    this.automix.paused = true;
    this.automix.emit('change', 'state');
    return true;
  }

  toggle() {
    this._c('toggle');
    const s = this.state;
    return s === 'stopped' || s === 'paused' ? this.play() : this.pause();
  }

  next() {
    this._c('next');
    this.playlist.advance();
    return true;
  }

  previous() {
    this._c('previous');
    return true;
  }

  seek(sec) {
    this._c('seek', sec);
    this.position = sec;
    return true;
  }

  jumpTo(uid) {
    this._c('jumpTo', uid);
    this.playlist.setCurrent(uid);
    return true;
  }

  setShuffle(on) {
    this._c('setShuffle', on);
    this.settings.set('playerShuffle', !!on);
    return true;
  }

  cycleRepeat() {
    this._c('cycleRepeat');
    const m = ['off', 'all', 'one'];
    this.settings.set('playerRepeat', m[(m.indexOf(this.repeat) + 1) % 3]);
    return this.repeat;
  }

  setRepeat(mode) {
    this.settings.set('playerRepeat', mode);
    return true;
  }

  setTransition(style) {
    this._c('setTransition', style);
    this.settings.set('transitionStyle', style);
    return true;
  }

  setCrossfadeSec(s) {
    this._c('setCrossfadeSec', s);
    this.settings.set('crossfadeSec', s);
    return true;
  }

  playNow(entry) {
    this._c('playNow', entry);
    const added = this.playNext(entry);
    if (added.length) this.jumpTo(added[0].uid);
    return added;
  }

  playNext(entry) {
    this._c('playNext', entry);
    return this.playlist.add(entry, { at: this.playlist.currentIndex + 1 });
  }

  addToQueue(entry) {
    this._c('addToQueue', entry);
    return this.playlist.add(entry);
  }
}

function makeApp(w, h, { player = true } = {}) {
  G.innerWidth = w;
  G.innerHeight = h;
  G.document = new FakeDocument();
  const root = new Element('div');
  root.setAttribute('id', 'app');
  G.document.body.append(root);
  const settings = new Settings(`ui-player-${w}x${h}-${Math.random()}`);
  settings.set('tipsSeen', true); // the first-run tips would take the page back to the records
  const engine = new FakeEngine();
  const decks = [new FakeDeck('A'), new FakeDeck('B')];
  const sync = new FakeSync(decks);
  const library = new FakeLibrary();
  const playlist = new Playlist({ settings, library });
  const automix = new FakeAutoMix(playlist);
  const pl = player ? new FakePlayer({ automix, playlist, decks, settings }) : null;
  const ui = new AppUI({ root, engine, decks, sync, settings, library, playlist, automix, player: pl });
  return { root, settings, engine, decks, sync, library, playlist, automix, player: pl, ui };
}

async function startAudio(app) {
  $(app.root, '.btn-start').click();
  await sleep(50);
  assert.equal(app.ui.audioOn, true);
}

const toastsOf = (app) => $$(app.root, '.toast').map(textOf).join(' | ');
const demos = [{ kind: 'demo', id: 0 }, { kind: 'demo', id: 1 }];

function pointer(el, type, y, id = 3) {
  el.dispatchEvent(new FakeEvent(type, { pointerId: id, pointerType: 'touch', button: 0, clientX: 20, clientY: y, isPrimary: true }));
}

function key(code, keyName, target = G.document.body) {
  const ev = new FakeEvent('keydown', { code, key: keyName, repeat: false, target });
  target.dispatchEvent(ev);
  return ev;
}

test('phone: the PLAYER tab replaces the AUTO MIX switch and opens a full-screen page', async () => {
  const app = makeApp(360, 560);
  await startAudio(app);
  const tabs = $$(app.root, '.tab').filter((t) => !t.hidden);
  assert.deepEqual(tabs.map((t) => t.dataset.page || 'auto'), ['decks', 'mix', 'fx', 'songs', 'player']);
  assert(tabs.length <= 5);
  assert.equal($(app.root, '.tab-auto').hidden, true);
  $(app.root, '.tab-player').click();
  await sleep(40);
  const page = $(app.root, '.player');
  assert.equal(app.root.dataset.page, 'player');
  assert.equal(page.hidden, false);
  for (const sel of ['.deck.deck-a', '.deck.deck-b', '.waves', '.xf', '.mixer', '.songs']) assert.equal($(app.root, sel).hidden, true, sel);
  assert.equal($(app.root, '.tabs').hidden, false);
  assert.equal(page.dataset.cols, '1');
  assert.equal(page.dataset.stack, '0');
  assert.match(page.style['--pl-art'], /^\d+px$/);
  // empty queue: the empty state points to the Songs page
  const empty = $(page, '.pq-empty');
  assert.equal(empty.hidden, false);
  assert.match(textOf(empty), /Your queue is empty/);
  assert.equal(textOf($(page, '.pl-title')), 'Your queue is empty');
  // play with nothing queued explains instead of starting
  $(page, '.pl-play').click();
  await sleep(10);
  assert.equal(app.player.count('toggle'), 0);
  assert.match(toastsOf(app), /queue is empty/);
  $(empty, '.pq-songs').click();
  assert.equal(app.root.dataset.page, 'songs');
  app.ui.destroy();
});

test('now playing, transport, seek, Up next, History, Clear queue and volume', async () => {
  const app = makeApp(360, 560);
  const { player, playlist } = app;
  await startAudio(app);
  app.ui.addToSetList([...demos, demos[0], demos[1]], { quiet: true });
  app.ui.setPage('player');
  await sleep(40);
  const page = $(app.root, '.player');
  // stopped: the card shows the first song, Up next the rest
  assert.equal(textOf($(page, '.pl-state')), 'READY');
  assert.equal(textOf($(page, '.pl-title')), 'Neon Drift');
  let rows = $$(page, '.pq-list .pq-row').filter((r) => !r.classList.contains('pq-played'));
  assert.equal(rows.length, 3);
  assert.equal(textOf($(page, '.pq-h .songs-count')), '3');
  // play: Auto Mix on, the record spins, the button shows pause
  $(page, '.pl-play').click();
  await sleep(60);
  assert.equal(player.count('toggle'), 1);
  assert.equal(app.automix.enabled, true);
  assert.equal(textOf($(page, '.pl-state')), 'NOW PLAYING');
  assert($(page, '.pl-art').classList.contains('spinning'));
  assert($(page, '.pl-play').classList.contains('is-playing'));
  assert.equal($(page, '.pl-play').getAttribute('aria-label'), 'Pause');
  assert.equal(textOf($(page, '.pl-deck')), 'A');
  assert.equal(textOf($(page, '.pl-tags')), '124 BPM');
  assert.equal(textOf($(page, '.pl-el')), '0:12');
  assert.equal(textOf($(page, '.pl-rem')), '-1:24');
  assert.equal($(page, '.pl-auto').getAttribute('aria-checked'), 'true');
  // pause: still, play icon
  $(page, '.pl-play').click();
  await sleep(60);
  assert.equal(player.calls[player.calls.length - 1][0], 'pause');
  assert.equal(textOf($(page, '.pl-state')), 'PAUSED');
  assert(!$(page, '.pl-art').classList.contains('spinning'));
  $(page, '.pl-play').click();
  await sleep(60);
  // next / previous
  $(page, '.pl-next').click();
  $(page, '.pl-prev').click();
  assert.equal(player.count('next'), 1);
  assert.equal(player.count('previous'), 1);
  await sleep(60);
  assert.equal(textOf($(page, '.pl-title')), 'Spore Garden');
  // shuffle / repeat: lit buttons, a short toast
  $(page, '.pl-shuffle').click();
  await sleep(40);
  assert.equal(app.settings.get('playerShuffle'), true);
  assert.equal($(page, '.pl-shuffle').getAttribute('aria-pressed'), 'true');
  assert.match(toastsOf(app), /Shuffle on/);
  $(page, '.pl-repeat').click();
  await sleep(40);
  assert.equal(app.settings.get('playerRepeat'), 'all');
  assert.equal($(page, '.pl-repeat').dataset.mode, 'all');
  $(page, '.pl-repeat').click();
  await sleep(40);
  assert.equal($(page, '.pl-repeat').dataset.mode, 'one');
  assert.match(toastsOf(app), /Repeat this song/);
  // seek with the keyboard on the bar (5 s steps)
  const seek = $(page, '.fader-seek');
  assert.equal(seek.getAttribute('role'), 'slider');
  seek.dispatchEvent(new FakeEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight' }));
  assert.equal(player.count('seek'), 1);
  assert(Math.abs(player.calls.find((c) => c[0] === 'seek')[1] - 17) < 0.6, 'about 5 s further');
  // mixing: seeking is off, a touch explains why, the "mixing into" line shows
  app.automix.state = 'mixing';
  app.automix.progress = 0.3;
  app.automix.nextItem = playlist.items[2];
  app.automix.emit('change', 'state');
  await sleep(60);
  assert(seek.classList.contains('is-disabled'));
  assert.equal($(page, '.pl-mixbar').hidden, false);
  assert.equal(textOf($(page, '.pl-sub')), `Mixing into ${playlist.items[2].title} · 30%`); // (shuffle is on: any order)
  pointer($(page, '.pl-seek-slot'), 'pointerdown', 10);
  await sleep(60);
  assert.match(textOf($(page, '.pl-sub')), /Seeking is off while the songs mix/);
  assert.equal(player.count('seek'), 1, 'no seek while mixing');
  app.automix.state = 'playing';
  app.automix.emit('change', 'state');
  await sleep(60);
  // History: the first song, collapsible; tap plays it again
  const hist = $(page, '.pq-hist');
  assert.equal(hist.hidden, false);
  assert.equal(textOf($(hist, '.songs-count')), '1');
  $(hist, '.pq-main').click();
  assert.equal(player.calls[player.calls.length - 1][0], 'jumpTo');
  await sleep(40);
  // Up next: tap plays now, x removes
  rows = $$(page, '.pq-list .pq-row').filter((r) => !r.classList.contains('pq-played'));
  const before = playlist.items.length;
  const target = rows[1];
  $(target, '.pq-main').click();
  assert.equal(player.calls[player.calls.length - 1][1], target.dataset.uid);
  await sleep(40);
  rows = $$(page, '.pq-list .pq-row').filter((r) => !r.classList.contains('pq-played'));
  $(rows[0], '.pq-rm').click();
  await sleep(40);
  assert.equal(playlist.items.length, before - 1);
  // volume
  const vol = $(page, '.fader-pvol');
  vol.dispatchEvent(new FakeEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft' }));
  assert(app.engine.mixer.calls.some((c) => c[0] === 'master'), 'master volume reached the mixer');
  // Clear queue asks, then removes only what comes next
  playlist.setCurrent(0);
  app.ui.addToSetList(demos, { quiet: true });
  await sleep(40);
  const cur = playlist.items[0].uid;
  $(page, '.pq-clear').click();
  await sleep(10);
  const dlg = $(app.root, '.dialog-layer');
  assert.match(textOf(dlg), /Clear the queue\?/);
  $$(dlg, 'button').find((b) => textOf(b).trim() === 'Clear queue').click();
  await sleep(40);
  assert.deepEqual(playlist.items.map((it) => it.uid), [cur], 'the song playing now stays');
  assert.equal($(page, '.pq-empty').hidden, false);
  assert.match(textOf($(page, '.pq-empty')), /Nothing after this song/);
  app.ui.destroy();
});

test('Up next: drag the handle and arrow keys reorder the queue', async () => {
  const app = makeApp(360, 640);
  const { playlist } = app;
  await startAudio(app);
  app.ui.addToSetList([demos[0], demos[1], demos[0], demos[1]], { quiet: true });
  playlist.setCurrent(0);
  app.ui.setPage('player');
  await sleep(40);
  const page = $(app.root, '.player');
  const uids = () => playlist.items.map((it) => it.uid);
  const start = uids();
  let rows = $$(page, '.pq-list .pq-row');
  assert.equal(rows.length, 3);
  // drag the first row of Up next (playlist index 1) down one place (fake rows are 48 px tall)
  const handle = $(rows[0], '.pq-handle');
  pointer(handle, 'pointerdown', 100);
  pointer(handle, 'pointermove', 130);
  assert(rows[0].classList.contains('dragging'));
  pointer(handle, 'pointermove', 100 + 48 + 5);
  pointer(handle, 'pointerup', 100 + 48 + 5);
  await sleep(40);
  assert.deepEqual(uids(), [start[0], start[2], start[1], start[3]]);
  rows = $$(page, '.pq-list .pq-row');
  assert.equal(rows[0].style.transform || '', '');
  // arrow up on the last row's handle
  $(rows[2], '.pq-handle').dispatchEvent(new FakeEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp' }));
  await sleep(40);
  assert.deepEqual(uids(), [start[0], start[2], start[3], start[1]]);
  app.ui.destroy();
});

test('transition chooser: a sheet on phones, inline in two columns', async () => {
  const app = makeApp(360, 560);
  await startAudio(app);
  app.ui.setPage('player');
  await sleep(40);
  const page = $(app.root, '.player');
  const btn = $(page, '.pl-trans-btn');
  assert.equal(textOf($(btn, '.pl-tb-text')), 'DJ mix');
  btn.click();
  const sheet = $(app.root, '.sheet');
  assert.equal(textOf($(sheet, '.sheet-title')), 'Transition');
  const opts = $$(sheet, '.pl-trans-row');
  assert.deepEqual(opts.map((b) => textOf($(b, '.row-label'))), ['DJ mix', 'Crossfade', 'Gapless']);
  assert(opts.every((b) => textOf($(b, '.row-detail')).length > 10), 'one line explaining each');
  assert.equal(opts[0].getAttribute('aria-checked'), 'true');
  assert.equal($(sheet, '.pl-xf-row').hidden, true);
  opts[1].click();
  assert.equal(app.player.calls.find((c) => c[0] === 'setTransition')[1], 'crossfade');
  assert.equal(opts[1].getAttribute('aria-checked'), 'true');
  assert.equal($(sheet, '.pl-xf-row').hidden, false, 'the seconds slider shows for Crossfade');
  // the slider: 2..12 s, whole seconds
  const xf = $(sheet, '.fader-xfsec');
  xf.dispatchEvent(new FakeEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight' }));
  assert.equal(app.settings.get('crossfadeSec'), 7);
  assert.equal(textOf($(sheet, '.pl-xf-val')), '7 s');
  xf.dispatchEvent(new FakeEvent('keydown', { key: 'End', code: 'End' }));
  assert.equal(app.settings.get('crossfadeSec'), 12);
  $(sheet, '.sheet-close').click();
  await sleep(40);
  assert.equal(textOf($(page, '.pl-tb-text')), 'Crossfade 12 s');
  app.ui.destroy();

  // tablet portrait: two columns, the chooser inline
  const tab = makeApp(768, 1000);
  await startAudio(tab);
  tab.ui.setPage('player');
  await sleep(40);
  const tpage = $(tab.root, '.player');
  assert.equal(tpage.dataset.cols, '2');
  assert.equal(tpage.dataset.stack, '1');
  const seg = $$(tpage, '.pl-trans-seg .seg-btn');
  assert.deepEqual(seg.map(textOf), ['DJ mix', 'Crossfade', 'Gapless']);
  seg[2].click();
  assert.equal(tab.settings.get('transitionStyle'), 'gapless');
  await sleep(40);
  assert.match(textOf($(tpage, '.pl-trans-text')), /starts the moment this one ends/);
  // tablet tab bar: four pages + the AUTO MIX switch
  const tabs = $$(tab.root, '.tab').filter((t) => !t.hidden);
  assert.deepEqual(tabs.map((t) => t.dataset.page || 'auto'), ['mix', 'fx', 'songs', 'player', 'auto']);
  // no decks or crossfader behind the tablet player page
  assert.equal($(tab.root, '.deck.deck-a').hidden, true);
  tab.ui.setPage('mix');
  await sleep(20);
  assert.equal($(tab.root, '.deck.deck-a').hidden, false);
  tab.ui.destroy();
});

test('DECKS strip: mini transport next to MIX NOW, tap opens the player', async () => {
  const app = makeApp(360, 560);
  await startAudio(app);
  app.ui.addToSetList(demos, { quiet: true });
  app.ui.setPage('player');
  await sleep(20);
  $(app.root, '.player .pl-play').click();
  await sleep(40);
  app.ui.setPage('decks');
  await sleep(60);
  const strip = $(app.root, '.am-strip');
  assert.equal(strip.hidden, false);
  assert.equal(strip.dataset.tp, 'full');
  const tp = $(strip, '.am-tp');
  assert.equal(tp.hidden, false);
  assert.equal($(strip, '.am-prev').hidden, false);
  assert.equal($(strip, '.am-mixnow').hidden, false);
  $(strip, '.am-next').click();
  $(strip, '.am-prev').click();
  $(strip, '.am-play').click();
  assert.equal(app.player.count('next'), 1);
  assert.equal(app.player.count('previous'), 1);
  assert.equal(app.player.calls[app.player.calls.length - 1][0], 'pause');
  await sleep(60);
  assert.equal(textOf($(strip, '.am-detail')), 'paused');
  assert.equal($(strip, '.am-play').getAttribute('aria-label'), 'Resume the player');
  assert.equal($(strip, '.am-mixnow').hidden, true);
  // the PLAYER tab is lit (paused: dim dot)
  await sleep(120);
  assert($(app.root, '.tab-player').classList.contains('paused'));
  // a tap on the status opens the player
  $(strip, '.am-info').click();
  await sleep(20);
  assert.equal(app.root.dataset.page, 'player');
  app.ui.destroy();
});

test('keys: Space on the player page, N / B while it plays; never on a focused button', async () => {
  const app = makeApp(1280, 720);
  await startAudio(app);
  app.ui.addToSetList(demos, { quiet: true });
  const p = app.player;
  // not on the player page and nothing playing: the keys are free
  key('Space', ' ');
  key('KeyN', 'n');
  assert.equal(p.count('toggle') + p.count('next'), 0);
  // console: the header PLAYER button opens the drawer
  const hb = $(app.root, '.hb-player');
  assert.equal(hb.hidden, false);
  hb.click();
  await sleep(40);
  assert.equal(app.root.dataset.page, 'player');
  assert.equal(hb.getAttribute('aria-pressed'), 'true');
  const page = $(app.root, '.player');
  assert.equal(page.hidden, false);
  assert.equal(page.dataset.cols, '2');
  assert.equal($(app.root, '.deck.deck-a').hidden, false, 'the console keeps the decks under the drawer');
  assert.equal($(app.root, '.songs').hidden, true);
  const ev = key('Space', ' ');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(p.count('toggle'), 1);
  key('KeyN', 'n');
  key('KeyB', 'b');
  assert.equal(p.count('next'), 1);
  assert.equal(p.count('previous'), 1);
  // Space on a focused button belongs to that button
  const btn = $(page, '.pl-next');
  key('Space', ' ', btn);
  assert.equal(p.count('toggle'), 1);
  // the other shortcuts still work (M = Auto Mix)
  key('KeyM', 'm');
  assert.equal(app.automix.count('setEnabled'), 2);
  // N works from the decks too while the queue plays
  app.automix.setEnabled(true);
  hb.click();
  await sleep(20);
  assert.equal(app.root.dataset.page, 'mix');
  key('KeyN', 'n');
  assert.equal(p.count('next'), 2);
  // Space off the player page does nothing
  key('Space', ' ');
  assert.equal(p.count('toggle'), 1);
  app.ui.destroy();
});

test('Songs page: ⋯ opens Play now / Play next / Add to queue / Remove', async () => {
  const app = makeApp(360, 560);
  const p = app.player;
  await startAudio(app);
  $(app.root, '.tab-songs').click();
  await sleep(20);
  // add a library song
  $(app.root, '.btn-add').click(); // the Add music sheet: This device holds the file input
  const input = $(app.root, '.add-device input');
  input.files = [{ name: 'four.mp3', size: 10, type: 'audio/mpeg' }];
  input.dispatchEvent(new FakeEvent('change'));
  await sleep(40);
  app.ui.songs.render();
  const libRow = $$(app.root, '.songs .song-row').find((r) => /four/.test(textOf(r)));
  assert(libRow.classList.contains('with-menu'), 'A / B / + / ⋯');
  assert.equal($$(libRow, '.load-btn').length, 2);
  assert(!$(libRow, '.song-rm'), 'remove moved into the ⋯ sheet');
  const demoRow = $$(app.root, '.songs .song-row').find((r) => /Spore Garden/.test(textOf(r)));
  // Play next on a demo
  $(demoRow, '.song-more').click();
  let sheet = $(app.root, '.sheet');
  assert.equal(textOf($(sheet, '.sheet-title')), 'Spore Garden');
  const labels = $$(sheet, '.row-label').map(textOf);
  assert.deepEqual(labels, ['Play now', 'Play next', 'Add to queue'], 'no remove for a demo');
  $$(sheet, '.row-nav').find((b) => /Play next/.test(textOf(b))).click();
  await sleep(20);
  assert.equal(p.count('playNext'), 1);
  assert.deepEqual([p.calls[0][1].kind, p.calls[0][1].id], ['demo', 1]);
  assert.match(toastsOf(app), /“Spore Garden” plays next/);
  assert.equal($(app.root, '.sheet-layer').hidden, true, 'the sheet closes');
  // Play now on the library song
  $(libRow, '.song-more').click();
  sheet = $(app.root, '.sheet');
  assert.deepEqual($$(sheet, '.row-label').map(textOf), ['Play now', 'Play next', 'Add to queue', 'Remove from this device']);
  $$(sheet, '.row-nav').find((b) => /Play now/.test(textOf(b))).click();
  await sleep(20);
  assert.equal(p.count('playNow'), 1);
  assert.match(toastsOf(app), /Playing “four”/);
  const playerAction = $$(app.root, '.toast-action').find((b) => textOf(b) === 'Player');
  assert(playerAction, 'the toast offers the player');
  // Add to queue
  $(libRow, '.song-more').click();
  $$($(app.root, '.sheet'), '.row-nav').find((b) => /Add to queue/.test(textOf(b))).click();
  await sleep(20);
  assert.equal(p.count('addToQueue'), 1);
  assert.match(toastsOf(app), /Added “four” to the queue/);
  // Remove asks first
  $(libRow, '.song-more').click();
  $$($(app.root, '.sheet'), '.row-nav').find((b) => /Remove/.test(textOf(b))).click();
  await sleep(10);
  const dlg = $(app.root, '.dialog-layer');
  assert.match(textOf(dlg), /Remove this song\?/);
  $$(dlg, 'button').find((b) => textOf(b).trim() === 'Remove').click();
  await sleep(30);
  assert.equal(app.library.entries.length, 0);
  playerAction.click();
  await sleep(20);
  assert.equal(app.root.dataset.page, 'player');
  app.ui.destroy();
});

test('phone landscape: the PLAYER pill opens the player across the screen; close returns', async () => {
  const app = makeApp(844, 390);
  await startAudio(app);
  assert.equal(G.document.documentElement.dataset.layout, 'pl');
  const strip = $(app.root, '.am-strip');
  assert.equal(strip.parentNode, $(app.root, '.waves'));
  const pill = $(strip, '.am-pill-player');
  await sleep(40);
  assert.equal(pill.hidden, false);
  assert.equal($(strip, '.am-toggle').hidden, true, 'the AUTO pill gives way to the PLAYER pill');
  assert.equal(textOf($(pill, '.am-pill-text')), 'PLAYER');
  pill.click();
  await sleep(40);
  const page = $(app.root, '.player');
  assert.equal(page.hidden, false);
  assert.equal(page.dataset.cols, '2');
  for (const sel of ['.deck.deck-a', '.deck.deck-b', '.waves', '.mixer', '.xf']) assert.equal($(app.root, sel).hidden, true, sel);
  $(page, '.pl-close').click();
  await sleep(20);
  assert.equal(app.root.dataset.page, 'mix');
  assert.equal($(app.root, '.waves').hidden, false);
  app.ui.destroy();
});

test('help, menu and the app without a Player', async () => {
  const app = makeApp(1280, 800);
  await startAudio(app);
  app.ui.openMenu();
  const sheet = $(app.root, '.sheet');
  const playerRow = $$(sheet, '.row-nav').find((b) => /Music player/.test(textOf(b)));
  assert(playerRow, 'menu: Music player');
  $$(sheet, '.row-nav').find((b) => /^Help/.test(textOf(b))).click();
  assert($$(sheet, '.help-h').some((x) => /Music player/.test(textOf(x))), 'help: Music player section');
  $(sheet, '.sheet-back').click();
  $$(sheet, '.row-nav').find((b) => /Music player/.test(textOf(b))).click();
  await sleep(20);
  assert.equal(app.root.dataset.page, 'player');
  assert.equal($(app.root, '.sheet-layer').hidden, true);
  app.ui.destroy();

  // without a Player: no tab, no page, no ⋯ (the two-step remove stays), the AUTO MIX switch stays on phones
  const bare = makeApp(360, 560, { player: false });
  await startAudio(bare);
  assert.equal($(bare.root, '.tab-player').hidden, true);
  assert.equal($(bare.root, '.tab-auto').hidden, false);
  assert.equal($(bare.root, '.player').hidden, true);
  bare.settings.set('page', 'player'); // e.g. saved by a build that had one
  await sleep(20);
  assert.equal(bare.root.dataset.page, 'decks');
  assert.equal($(bare.root, '.player').hidden, true);
  assert.equal($$(bare.root, '.song-more').length, 0);
  bare.ui.destroy();
});

test('the real module graph: startApp builds the Player, the page reads it, the Songs ⋯ sheet queues', async () => {
  G.innerWidth = 360;
  G.innerHeight = 640;
  G.document = new FakeDocument();
  const root = new Element('div');
  root.setAttribute('id', 'app');
  G.document.body.append(root);
  const { startApp } = await import('../src/ui/boot-app.js');
  const app = startApp(root);
  assert(app.player && typeof app.player.toggle === 'function', 'player built');
  assert.equal(G.window.twinspin.player, app.player, 'exposed for the console');
  assert.equal(app.ui.player, app.player);
  await sleep(200);
  assert.equal($(root, '.tab-player').hidden, false);
  assert.equal($(root, '.tab-auto').hidden, true);
  app.playlist.clear();
  app.playlist.add([{ kind: 'demo', id: 0 }, { kind: 'demo', id: 1 }]);
  app.ui.setPage('player');
  await sleep(80);
  const page = $(root, '.player');
  assert.equal(page.hidden, false);
  // stopped: the card shows the song play() starts with, Up next the rest
  assert.equal(textOf($(page, '.pl-state')), 'READY');
  assert.equal(textOf($(page, '.pl-title')), 'Neon Drift');
  assert.equal($$(page, '.pq-list .pq-row').length, 1);
  assert.match(textOf($(page, '.pq-list')), /Spore Garden/);
  // shuffle / repeat / transition go through the real Player into the settings
  $(page, '.pl-repeat').click();
  assert.equal(app.settings.get('playerRepeat'), 'all');
  $(page, '.pl-repeat').click();
  $(page, '.pl-repeat').click();
  assert.equal(app.settings.get('playerRepeat'), 'off');
  app.ui.playerUI.setTransition('gapless');
  assert.equal(app.settings.get('transitionStyle'), 'gapless');
  app.ui.playerUI.setCrossfadeSec(9);
  assert.equal(app.settings.get('crossfadeSec'), 9);
  // Songs ⋯ > Play next: the real playlist inserts it after the current song
  app.ui.setPage('songs');
  await sleep(20);
  const demoRow = $$(root, '.songs .song-row').find((r) => /Spore Garden/.test(textOf(r)));
  $(demoRow, '.song-more').click();
  $$($(root, '.sheet'), '.row-nav').find((b) => /Play next/.test(textOf(b))).click();
  await sleep(20);
  assert.equal(app.playlist.items.length, 3);
  assert.equal(app.playlist.items[app.playlist.currentIndex + 1].title, 'Spore Garden', 'right after the current song');
  // audio is not started: Play now explains instead
  $(demoRow, '.song-more').click();
  $$($(root, '.sheet'), '.row-nav').find((b) => /Play now/.test(textOf(b))).click();
  await sleep(20);
  assert.match(toastsOf({ root }), /Tap Start first/);
  app.playlist.clear();
  app.ui.destroy();
});

test('no errors were logged', () => {
  assert.equal(errors.length, 0, errors.join('\n'));
});
