// Set list + Auto Mix UI: the pure wording / drag helpers (src/ui/automix-text.js), the Auto Mix rows of the
// layout budget (src/ui/layout-math.js), and the app shell on the fake DOM with the real Playlist and a fake
// AutoMix that follows docs/AUTOMIX.md 4.5: the SET LIST section (AUTO MIX switch, mix length, + / Add all,
// drag and keyboard reorder, remove, clear, A / B), the AUTO switch in the tab bar, the status strip on the
// DECKS page (and inside the crossfader panel / over the waveforms in the other layouts), MIX NOW, toasts for
// 'error' / 'takeover' / 'finished', the crossfader following the mixer and reporting user moves, key M,
// overview markers, Settings / Help, the console songs drawer after the phone SONGS page, and FX pad labels.

import {
  fmtCountdown, automixStatus, automixSnapshot, setListBadge, dragTargetIndex, dragShift, autoScrollStep, planOutAt,
  planInAt, planMode, addedText, itemTitle, mixModeText,
} from '../src/ui/automix-text.js';
import {
  computeSizes, stackHeight, automixPlacement, pickLayout, consoleFits, cssVars, AM_STRIP_H, FX_TWO_ROW_MIN,
} from '../src/ui/layout-math.js';
import { installFakeDom, FakeEvent, Element, FakeDocument } from './helpers/fake-dom.js';
import { FakeEngine, FakeDeck, FakeSync, FakeLibrary } from './helpers/fake-models.js';
import { Emitter } from '../src/core/emitter.js';

const G = globalThis;
const SHY = String.fromCharCode(0xad); // soft hyphen
const errors = [];
const origError = console.error.bind(console);
console.error = (...args) => {
  errors.push(args.map((a) => (a && a.stack) || String(a)).join(' '));
  origError(...args);
};

// ---------------------------------------------------------------------------------------------------------
// Pure helpers

test('countdown, status line and mode words', () => {
  assert.equal(fmtCountdown(42), '0:42');
  assert.equal(fmtCountdown(41.2), '0:42', 'rounded up: never shows 0:00 before the mix');
  assert.equal(fmtCountdown(65), '1:05');
  assert.equal(fmtCountdown(null), '');
  assert.equal(mixModeText('meet'), 'tempos meet half way');
  assert.equal(planMode({ mode: 'cut' }), 'cut');
  assert.equal(planMode({ tempo: { mode: 'match' } }), 'match');

  const off = automixStatus({ available: true, enabled: false, state: 'off' });
  assert.equal(off.show, false);
  assert.equal(off.on, false);
  assert.equal(off.short, 'AUTO');
  const none = automixStatus(automixSnapshot(null, []));
  assert.equal(none.show, false);

  const base = { available: true, enabled: true, state: 'playing', nextTitle: 'Spore Garden', nextReady: true, secondsToMix: 42,
    progress: null, remaining: 90, incomingTitle: '' };
  let st = automixStatus(base);
  assert.equal(st.show, true);
  assert.equal(st.title, 'Next: Spore Garden');
  assert.equal(st.detail, 'mix in 0:42');
  assert.equal(st.short, '0:42');
  assert.equal(st.mixNow, true);
  st = automixStatus({ ...base, state: 'preparing', nextReady: false });
  assert.equal(st.detail, 'getting it ready…');
  assert.equal(st.mixNow, true, 'MIX NOW before the song is ready: Auto Mix mixes as soon as it is');
  assert.equal(st.short, 'AUTO');
  st = automixStatus({ ...base, state: 'mixing', progress: 0.454 });
  assert.equal(st.title, 'Mixing into Spore Garden');
  assert.equal(st.detail, '45%');
  assert.equal(st.pct, 45);
  assert.equal(st.mixing, true);
  assert.equal(st.mixNow, false);
  st = automixStatus({ ...base, nextTitle: '', remaining: 83 });
  assert.equal(st.title, 'Last song');
  assert.equal(st.detail, 'ends in 1:23');
  st = automixStatus({ ...base, state: 'starting' });
  assert.equal(st.detail, 'Starting…');
  st = automixStatus({ ...base, enabled: false, state: 'finished' });
  assert.equal(st.title, 'Set list finished');
  assert.equal(st.on, false);
});

test('snapshot reads an AutoMix defensively', () => {
  const decks = [{ duration: 200, position: 110, rate: 1, track: { title: 'A song' } }, { track: { title: 'B song' } }];
  const am = { enabled: true, state: 'mixing', currentDeck: 0, nextItem: { uid: 'u2', title: 'Next one' }, nextReady: true,
    secondsToMix: null, progress: 0.5, plan: { mode: 'meet', out: { at: 150 }, in: { at: 8 } } };
  const out = {};
  const s = automixSnapshot(am, decks, out);
  assert.equal(s, out, 'fills the given object');
  assert.equal(s.nextTitle, 'Next one');
  assert.equal(s.mode, 'meet');
  assert.equal(s.remaining, 90);
  assert.equal(s.incomingTitle, 'B song');
  // missing fields never throw
  const t = automixSnapshot({ enabled: true }, null);
  assert.equal(t.state, 'off');
  assert.equal(t.secondsToMix, null);
  assert.equal(planOutAt({ out: { at: 150 } }), 150);
  assert.equal(planOutAt({ outAt: 12 }), 12);
  assert.equal(planOutAt(null), null);
  assert.equal(planInAt({ in: { at: 8 } }), 8);
  assert.equal(planInAt({ in: 4 }), 4);
  assert.equal(planInAt({}), null);
  assert.equal(itemTitle({ kind: 'demo', id: 0 }), 'Demo track');
  assert.equal(itemTitle({ fileName: 'my_song.mp3' }), 'my song');
  assert.equal(addedText(1, 'Neon Drift'), 'Added “Neon Drift” to the set list');
  assert.equal(addedText(3, ''), 'Added 3 songs to the set list');
});

test('set list badges and drag math', () => {
  const o = { currentIndex: 2, nextIndex: 3, enabled: true };
  assert.equal(setListBadge(2, o), 'now');
  assert.equal(setListBadge(3, o), 'next');
  assert.equal(setListBadge(0, o), 'played');
  assert.equal(setListBadge(4, o), '');
  assert.equal(setListBadge(2, { ...o, enabled: false }), '', 'no NOW badge while Auto Mix is off');
  assert.equal(setListBadge(0, { ...o, enabled: false }), 'played', 'played songs stay dimmed');
  assert.equal(setListBadge(3, { ...o, enabled: false }), '', 'no NEXT badge while Auto Mix is off');
  assert.equal(setListBadge(0, { currentIndex: -1, nextIndex: 0, enabled: true }), 'next');
  // drag: half a row moves one place
  assert.equal(dragTargetIndex(0, 0, 60, 5), 0);
  assert.equal(dragTargetIndex(0, 29, 60, 5), 0);
  assert.equal(dragTargetIndex(0, 31, 60, 5), 1);
  assert.equal(dragTargetIndex(0, 130, 60, 5), 2);
  assert.equal(dragTargetIndex(3, -95, 60, 5), 1);
  assert.equal(dragTargetIndex(1, 9999, 60, 5), 4);
  assert.equal(dragTargetIndex(1, -9999, 60, 5), 0);
  assert.equal(dragTargetIndex(0, 50, 60, 0), 0);
  // the others make room
  assert.equal(dragShift(1, 0, 2, 60), -60);
  assert.equal(dragShift(2, 0, 2, 60), -60);
  assert.equal(dragShift(3, 0, 2, 60), 0);
  assert.equal(dragShift(1, 3, 1, 60), 60);
  assert.equal(dragShift(0, 3, 1, 60), 0);
  assert.equal(dragShift(3, 3, 1, 60), 0);
  // auto-scroll near the edges
  assert.equal(autoScrollStep(300, 100, 500), 0);
  assert(autoScrollStep(105, 100, 500) < 0);
  assert(autoScrollStep(495, 100, 500) > 0);
  assert.equal(autoScrollStep(40, 100, 500), -14, 'capped');
});

// ---------------------------------------------------------------------------------------------------------
// Layout budget

test('Auto Mix placement per layout', () => {
  assert.deepEqual(automixPlacement('pp', 'decks', true), { where: 'row', show: true, row: true, tabToggle: true });
  assert.equal(automixPlacement('pp', 'mix', true).show, false, 'phone MIX / FX pages keep their height');
  assert.equal(automixPlacement('pp', 'decks', false).show, false);
  assert.equal(automixPlacement('tp', 'fx', true).row, true, 'tablet: decks always visible, strip on every page');
  assert.deepEqual(automixPlacement('pl', 'mix', false), { where: 'waves', show: true, row: false, tabToggle: false });
  assert.deepEqual(automixPlacement('console', 'songs', true), { where: 'xf', show: true, row: false, tabToggle: false });
});

test('the status strip row fits the phone and tablet budgets', () => {
  for (const [w, h, ins] of [[360, 560, {}], [320, 500, {}], [390, 844, { t: 47, b: 34 }], [430, 932, { t: 59, b: 34 }]]) {
    const plain = computeSizes('pp', w, h, ins);
    const s = computeSizes('pp', w, h, ins, { am: true });
    assert.equal(s.amH, AM_STRIP_H);
    const st = stackHeight(s);
    const usable = h - (ins.t || 0) - (ins.b || 0);
    assert(st.total <= usable + 0.5, `${w}x${h}: ${st.total} > ${usable}`);
    assert(st.decks <= s.page + 0.5, `${w}x${h}: decks ${st.decks} > page ${s.page}`);
    assert(s.P >= 96, `${w}x${h}: platter ${s.P}`);
    assert(s.P <= plain.P, 'the strip takes its height from the deck area');
    assert.equal(cssVars(s)['--am-h'], `${AM_STRIP_H}px`);
  }
  assert.equal(computeSizes('pp', 360, 560, {}).amH, 0);
  // 360 x 560: still a usable record next to the strip
  assert(computeSizes('pp', 360, 560, {}, { am: true }).P >= 100);
  for (const [w, h] of [[768, 950], [600, 900], [1024, 1300]]) {
    const s = computeSizes('tp', w, h, {}, { am: true });
    const st = stackHeight(s);
    assert(st.total <= h + 0.5, `${w}x${h} tp: ${st.total} > ${h}`);
    assert(s.page >= 150, `${w}x${h}: tablet page row ${s.page}`);
  }
});

test('console FX rows and the console / phone landscape choice', () => {
  // wide desks: two FX rows; narrow deck columns: three rows from the vertical slack
  const wide = computeSizes('console', 1366, 768, {});
  assert.equal(wide.fxRows, 2);
  assert(wide.fxInner >= FX_TWO_ROW_MIN);
  const ipad = computeSizes('console', 1024, 768, {});
  assert.equal(ipad.fxRows, 2);
  const small = computeSizes('console', 800, 600, {});
  assert.equal(small.fxRows, 3, '800 x 600: three FX rows so the pads are wide enough for their labels');
  assert(small.fxH >= 3 * 44 + 2 * 6 + 12, `fx row ${small.fxH}`);
  assert(small.P >= 120 && small.natP >= 120, `platter ${small.P}`);
  assert.equal(stackHeight(small).total <= 600 + 0.5, true);
  // pads of a three-row panel: four across the whole width
  assert((small.fxInner - 18) / 4 >= 40, 'pads at least ~40 px wide');
  // a two-row panel: pads share two thirds of the width
  assert(((wide.fxInner - 6) * 2 / 3 - 18) / 4 >= 50);
  assert.equal(pickLayout(800, 600), 'console');
  assert.equal(consoleFits(1024, 500), true);
  // narrow AND short windows would squeeze the console's records: phone landscape instead
  assert.equal(consoleFits(800, 500), false);
  assert.equal(pickLayout(800, 500), 'pl');
  assert.equal(pickLayout(900, 540), 'pl');
  assert.equal(pickLayout(960, 540), 'console');
});

// ---------------------------------------------------------------------------------------------------------
// App shell with the real Playlist and a fake AutoMix

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
    this.calls = [];
  }

  setEnabled(on) {
    this.calls.push(['setEnabled', on]);
    if (on && !(this.playlist.items.length)) {
      this.emit('error', 'Add songs to the set list first.');
      return;
    }
    this.enabled = !!on;
    this.state = on ? 'playing' : 'off';
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

function makeApp(w, h, { automix = true } = {}) {
  G.innerWidth = w;
  G.innerHeight = h;
  G.document = new FakeDocument();
  const root = new Element('div');
  root.setAttribute('id', 'app');
  G.document.body.append(root);
  const settings = new Settings(`ui-automix-${w}x${h}-${Math.random()}`);
  const engine = new FakeEngine();
  const decks = [new FakeDeck('A'), new FakeDeck('B')];
  const sync = new FakeSync(decks);
  const library = new FakeLibrary();
  const playlist = new Playlist({ settings, library });
  const am = automix ? new FakeAutoMix(playlist) : null;
  const ui = new AppUI({ root, engine, decks, sync, settings, library, playlist, automix: am });
  return { root, settings, engine, decks, sync, library, playlist, automix: am, ui };
}

async function startAudio(app) {
  $(app.root, '.btn-start').click();
  await sleep(50);
  assert.equal(app.ui.audioOn, true);
}

function pointer(el, type, y, id = 3) {
  el.dispatchEvent(new FakeEvent(type, { pointerId: id, pointerType: 'touch', button: 0, clientX: 20, clientY: y, isPrimary: true }));
}

test('set list: add with + and Add all, badges, reorder by drag and keys, remove, clear, A / B', async () => {
  const app = makeApp(360, 560);
  await startAudio(app);
  const toasts = () => $$(app.root, '.toast').map(textOf).join(' | ');
  $(app.root, '.tab-songs').click();
  await sleep(20);
  const songs = $(app.root, '.songs');
  assert.equal(songs.hidden, false);
  // the SET LIST section comes first, with the AUTO MIX switch and an empty state
  const sl = $(songs, '.sl');
  assert(sl && !sl.hidden, 'set list section');
  assert.equal($(songs, '.songs-scroll').children[0], sl, 'at the top of the songs list');
  assert.equal(textOf($(sl, '.am-switch-title')), 'AUTO MIX');
  assert.match(textOf($(sl, '.am-explain')), /mixes each song into the next/);
  assert.equal($(sl, '.sl-empty').hidden, false);
  assert.match(textOf($(sl, '.sl-empty')), /Add songs with \+ on any song below, or tap Add music/);
  // mix length 16 / 32 / 64 (32 by default)
  const lens = $$(sl, '.am-len .seg-btn');
  assert.deepEqual(lens.map(textOf), ['16', '32', '64']);
  assert.equal(lens[1].getAttribute('aria-checked'), 'true');
  lens[2].click();
  assert.equal(app.settings.get('mixBeats'), 64);
  assert.equal(lens[2].getAttribute('aria-checked'), 'true');

  // + on a demo row
  const demoRow = $$(songs, '.song-row').find((r) => /Spore Garden/.test(textOf(r)));
  $(demoRow, '.add-btn').click();
  await sleep(10);
  assert.equal(app.playlist.items.length, 1);
  assert.deepEqual([app.playlist.items[0].kind, app.playlist.items[0].id], ['demo', 1]);
  assert.match(toasts(), /Added “Spore Garden” to the set list/);
  let rows = $$(sl, '.sl-row');
  assert.equal(rows.length, 1);
  assert.match(textOf(rows[0]), /Spore Garden/);
  assert.match(textOf(rows[0]), /128 BPM/);
  assert.match(textOf(rows[0]), /1:36/, 'duration');
  assert.equal($(sl, '.sl-empty').hidden, true);
  assert.equal(textOf($(sl, '.songs-count')), '1');
  // Add all (demo header): both demos
  const addAll = $$(songs, '.add-all').find((b) => /demo/i.test(b.getAttribute('aria-label')));
  addAll.click();
  await sleep(10);
  assert.equal(app.playlist.items.length, 3);
  assert.match(toasts(), /Added 2 songs to the set list/);
  // Add music: files go to the library AND the end of the set list
  $(app.root, '.btn-add').click(); // the Add music sheet: This device holds the file input
  const input = $(app.root, '.add-device input');
  input.files = [{ name: 'four.mp3', size: 10, type: 'audio/mpeg' }];
  input.dispatchEvent(new FakeEvent('change'));
  await sleep(30);
  assert.equal(app.playlist.items.length, 4);
  assert.equal(app.playlist.items[3].kind, 'library');
  assert.match(toasts(), /to your songs and the set list/);
  rows = $$(sl, '.sl-row');
  assert.equal(rows.length, 4);
  const order = () => app.playlist.items.map((it) => it.title);
  assert.deepEqual(order(), ['Spore Garden', 'Neon Drift', 'Spore Garden', 'four']);

  // drag the first row down two places with its handle (fake rows are 48 px tall)
  const handle = $(rows[0], '.sl-handle');
  pointer(handle, 'pointerdown', 100);
  pointer(handle, 'pointermove', 130);
  assert(rows[0].classList.contains('dragging'));
  assert.match(rows[0].style.transform, /translateY\(30px\)/, 'the row follows the finger');
  assert.match(rows[1].style.transform, /translateY\(-48px\)/, 'the next row makes room');
  pointer(handle, 'pointermove', 100 + 2 * 48 + 5);
  pointer(handle, 'pointerup', 100 + 2 * 48 + 5);
  await sleep(10);
  assert.deepEqual(order(), ['Neon Drift', 'Spore Garden', 'Spore Garden', 'four']);
  rows = $$(sl, '.sl-row');
  assert.equal(rows[0].style.transform || '', '', 'transforms cleared after the drop');
  // a cancelled drag changes nothing
  const h2 = $(rows[3], '.sl-handle');
  pointer(h2, 'pointerdown', 300, 4);
  pointer(h2, 'pointermove', 100, 4);
  pointer(h2, 'pointercancel', 100, 4);
  await sleep(10);
  assert.deepEqual(order(), ['Neon Drift', 'Spore Garden', 'Spore Garden', 'four']);
  // keyboard: arrow up on a handle moves the song up by one
  rows = $$(sl, '.sl-row');
  $(rows[3], '.sl-handle').dispatchEvent(new FakeEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp' }));
  await sleep(10);
  assert.deepEqual(order(), ['Neon Drift', 'Spore Garden', 'four', 'Spore Garden']);

  // A / B load from the set list while Auto Mix is off
  rows = $$(sl, '.sl-row');
  $$(rows[0], '.sl-load')[1].click();
  await sleep(20);
  assert.deepEqual(app.decks[1].calls.find((c) => c[0] === 'loadDemo'), ['loadDemo', 0]);
  $$(rows[2], '.sl-load')[0].click(); // the library song
  await sleep(20);
  assert.equal(app.decks[0].count('loadFile') >= 1, true);

  // remove
  $(rows[3], '.sl-rm').click();
  await sleep(10);
  assert.equal(app.playlist.items.length, 3);
  // badges follow the playlist / Auto Mix
  app.playlist.setCurrent(1);
  await sleep(10);
  rows = $$(sl, '.sl-row');
  assert.equal(textOf($(rows[1], '.sl-badge')), '', 'no NOW badge while Auto Mix is off');
  assert(rows[0].classList.contains('is-played'));
  app.automix.enabled = true;
  app.automix.state = 'playing';
  app.automix.emit('change', 'state');
  await sleep(10);
  assert.equal(textOf($(rows[1], '.sl-badge')), 'NOW');
  assert.equal(textOf($(rows[2], '.sl-badge')), 'NEXT');
  assert(rows[1].classList.contains('is-now'));
  app.automix.enabled = false;
  app.automix.state = 'off';
  app.automix.emit('change', 'enabled');
  await sleep(10);
  // clear asks first
  $(sl, '.sl-clear').click();
  await sleep(10);
  const dlg = $(app.root, '.dialog-layer');
  assert.equal(dlg.hidden, false);
  assert.match(textOf(dlg), /Clear the set list\?/);
  $$(dlg, 'button').find((b) => textOf(b).trim() === 'Clear set list').click();
  await sleep(10);
  assert.equal(app.playlist.items.length, 0);
  assert.equal($(sl, '.sl-empty').hidden, false);
  assert.deepEqual(app.settings.get('setList'), []);
  app.ui.destroy();
});

test('AUTO MIX switch, tab toggle, status strip, MIX NOW, toasts and key M', async () => {
  const app = makeApp(360, 560);
  const am = app.automix;
  await startAudio(app);
  const toasts = () => $$(app.root, '.toast').map(textOf).join(' | ');
  const tab = $(app.root, '.tab-auto');
  assert(tab && !tab.hidden, 'AUTO switch in the tab bar');
  assert.equal(tab.getAttribute('role'), 'switch');
  const strip = $(app.root, '.am-strip');
  assert.equal(strip.hidden, true, 'no strip while Auto Mix is off');
  // empty set list: AutoMix explains, with a Songs button
  tab.click();
  await sleep(20);
  assert.equal(am.enabled, false);
  assert.match(toasts(), /Add songs to the set list first/);
  const songsAction = $$(app.root, '.toast-action').find((b) => textOf(b) === 'Songs');
  assert(songsAction, 'toast offers the Songs page');
  songsAction.click();
  assert.equal(app.root.dataset.page, 'songs');
  // add both demos, switch on from the Songs card
  $$(app.root, '.add-all').find((b) => /demo/i.test(b.getAttribute('aria-label'))).click();
  const sw = $(app.root, '.am-switch');
  sw.click();
  await sleep(40);
  assert.equal(am.enabled, true);
  assert.equal(sw.getAttribute('aria-checked'), 'true');
  assert.equal(tab.getAttribute('aria-checked'), 'true');
  assert.match(toasts(), /Auto Mix on/);
  // DECKS page: the strip shows and takes its row from the deck area
  $(app.root, '.tab-decks').click();
  await sleep(40);
  assert.equal(strip.hidden, false);
  assert.equal(strip.dataset.where, 'row');
  assert.equal(app.root.dataset.am, '1');
  assert.equal(G.document.documentElement.style['--am-h'], `${AM_STRIP_H}px`);
  const pOn = parseInt(G.document.documentElement.style['--P'], 10);
  // status line from the AutoMix state
  am.state = 'playing';
  am.currentDeck = 0;
  am.nextItem = app.playlist.items[1];
  am.nextReady = true;
  am.secondsToMix = 42;
  am.emit('change', 'plan');
  await sleep(40);
  assert.equal(textOf($(strip, '.am-title')), 'Next: Spore Garden');
  assert.equal(textOf($(strip, '.am-detail')), 'mix in 0:42');
  const mixNow = $(strip, '.am-mixnow');
  assert.equal(mixNow.hidden, false);
  assert.equal(mixNow.disabled, false);
  mixNow.click();
  assert.equal(am.count('mixNow'), 1);
  // NEXT badge in the set list, A / B hidden while on
  assert.equal(textOf($$(app.root, '.sl-row')[1].querySelector('.sl-badge')), 'NEXT');
  assert($(app.root, '.sl-list').classList.contains('auto-on'));
  // mixing: progress, no MIX NOW
  am.state = 'mixing';
  am.progress = 0.45;
  am.emit('change', 'state');
  await sleep(40);
  assert.equal(textOf($(strip, '.am-title')), 'Mixing into Spore Garden');
  assert.equal(textOf($(strip, '.am-detail')), '45%');
  assert.equal(mixNow.hidden, true);
  assert.equal($(strip, '.am-bar').hidden, false);
  // overview markers from the plan: mix-out on the current deck, mix-in on the next
  am.plan = { mode: 'match', out: { at: 60, beats: 32 }, in: { at: 8 } };
  am.emit('change', 'plan');
  await sleep(40);
  assert.equal(app.ui.overviews[0]._mark, 60);
  assert.equal(app.ui.overviews[1]._mark, 8);
  assert.equal(app.ui.overviews[1]._markKind, 1);
  // other phone pages keep their full height: no strip there
  $(app.root, '.tab-mix').click();
  await sleep(40);
  assert.equal(strip.hidden, true);
  assert.equal(app.root.dataset.am, '0');
  assert(parseInt(G.document.documentElement.style['--P'], 10) >= pOn);
  $(app.root, '.tab-decks').click();
  await sleep(20);
  // takeover and finished become toasts
  am.enabled = false;
  am.state = 'off';
  am.emit('takeover', 'Auto Mix off. You took over the mix.');
  await sleep(40);
  assert.match(toasts(), /You took over the mix/);
  assert.equal(strip.hidden, true);
  assert(Number.isNaN(app.ui.overviews[0]._mark), 'markers cleared when Auto Mix is off');
  const turnOn = $$(app.root, '.toast-action').find((b) => textOf(b) === 'Turn on');
  turnOn.click();
  await sleep(20);
  assert.equal(am.enabled, true);
  am.enabled = false;
  am.state = 'finished';
  am.emit('finished');
  await sleep(20);
  assert.match(toasts(), /Set list finished/);
  // key M toggles
  const before = am.count('setEnabled');
  G.document.body.dispatchEvent(new FakeEvent('keydown', { code: 'KeyM', key: 'm', target: G.document.body }));
  await sleep(10);
  assert.equal(am.count('setEnabled'), before + 1);
  assert.equal(am.enabled, true);
  app.ui.destroy();
});

test('crossfader follows the mixer and user moves reach Auto Mix first', async () => {
  const app = makeApp(360, 560);
  const am = app.automix;
  await startAudio(app);
  const mixer = app.engine.mixer;
  // a scheduled crossfade moves mixer.crossfader on its own: the thumb follows every frame
  mixer.crossfader = 0.5;
  await sleep(60);
  assert.closeTo(app.ui.xfade, 0.5, 1e-9);
  assert.closeTo(app.ui.mixer.xfader.value, 0.5, 1e-6);
  mixer.crossfader = -0.25;
  await sleep(60);
  assert.closeTo(app.ui.mixer.xfader.value, -0.25, 1e-6);
  // a user move (arrow key): Auto Mix hears it, then the mixer gets the value
  G.document.body.dispatchEvent(new FakeEvent('keydown', { code: 'ArrowRight', key: 'ArrowRight', target: G.document.body }));
  assert.equal(am.count('noteUserCrossfader'), 1);
  assert.closeTo(am.calls.find((c) => c[0] === 'noteUserCrossfader')[1], -0.15, 1e-9);
  assert(mixer.calls.some((c) => c[0] === 'xf' && Math.abs(c[1] + 0.15) < 1e-9));
  app.ui.destroy();
});

test('Auto Mix controls in phone landscape and on the console; songs drawer after the phone SONGS page', async () => {
  const app = makeApp(360, 560);
  await startAudio(app);
  $(app.root, '.tab-songs').click();
  assert.equal(app.settings.get('page'), 'songs');
  const strip = $(app.root, '.am-strip');
  // phone landscape: AUTO pill over the waveforms, even while off
  G.innerWidth = 844;
  G.innerHeight = 390;
  G.dispatchEvent(new FakeEvent('resize'));
  await sleep(40);
  assert.equal(G.document.documentElement.dataset.layout, 'pl');
  // (the songs sheet covers the centre in pl; back to the mixer view)
  app.ui.setPage('mix');
  await sleep(20);
  assert.equal(strip.parentNode, $(app.root, '.waves'));
  assert.equal(strip.hidden, false);
  assert.equal($(app.root, '.tab-auto').hidden, true);
  // console: inside the crossfader panel; the songs drawer stays shut
  app.ui.setPage('songs');
  G.innerWidth = 1366;
  G.innerHeight = 768;
  G.dispatchEvent(new FakeEvent('resize'));
  await sleep(40);
  assert.equal(G.document.documentElement.dataset.layout, 'console');
  assert.equal($(app.root, '.songs').hidden, true, 'no drawer left open from the phone SONGS page');
  assert.equal(app.settings.get('page'), 'mix');
  assert.equal(strip.parentNode, $(app.root, '.xf'));
  assert.equal(strip.hidden, false);
  assert.equal($(strip, '.am-toggle').getAttribute('aria-checked'), 'false');
  assert.equal(app.root.dataset.fxrows, '2');
  // opening the drawer in the console still works
  $(app.root, '.hb-songs').click();
  assert.equal($(app.root, '.songs').hidden, false);
  // narrow console: three FX rows
  G.innerWidth = 800;
  G.innerHeight = 600;
  G.dispatchEvent(new FakeEvent('resize'));
  await sleep(40);
  assert.equal(G.document.documentElement.dataset.layout, 'console');
  assert.equal(app.root.dataset.fxrows, '3');
  app.ui.destroy();
});

test('settings, help, FX labels and the app without Auto Mix', async () => {
  const app = makeApp(1280, 800);
  await startAudio(app);
  app.ui.openMenu();
  const sheet = $(app.root, '.sheet');
  $$(sheet, 'button').find((b) => /^Settings/.test(textOf(b))).click();
  const labels = $$(sheet, '.row-label').map(textOf);
  for (const l of ['Mix length', 'Ease back to the song’s own tempo', 'Bass swap']) assert(labels.includes(l), `settings row ${l}`);
  $$(sheet, '.row-switch').find((b) => /Bass swap/.test(textOf(b))).click();
  assert.equal(app.settings.get('automixBassSwap'), false);
  $$(sheet, '.row-switch').find((b) => /Ease back/.test(textOf(b))).click();
  assert.equal(app.settings.get('automixReturn'), false);
  $$(sheet, '.seg-btn').find((b) => textOf(b) === '16').click();
  assert.equal(app.settings.get('mixBeats'), 16);
  $(sheet, '.sheet-back').click();
  $$(sheet, 'button').find((b) => /^Help/.test(textOf(b))).click();
  assert($$(sheet, '.help-h').some((x) => /Auto Mix/.test(textOf(x))), 'help: Auto Mix section');
  // (the keyboard table, with M, is shown on computers only; the fake navigator is an Android phone)
  $(sheet, '.sheet-close').click();
  // FX labels break at soft hyphens in narrow pads; loop pads carry a LOOP caption for narrow panels
  assert.equal(textOf($(app.root, '.fx-a .pad-flanger .pad-label')), `FLAN${SHY}GER`);
  assert.equal(textOf($(app.root, '.fx-a .pad-reverb .pad-label')), `RE${SHY}VERB`);
  assert.equal($$(app.root, '.fx-a .loop-sub').length, 4);
  app.ui.destroy();

  // no AutoMix / Playlist: nothing of it shows, the rest works
  G.innerWidth = 360;
  G.innerHeight = 560;
  G.document = new FakeDocument();
  const root = new Element('div');
  G.document.body.append(root);
  const ui = new AppUI({ root, engine: new FakeEngine(), decks: [new FakeDeck('A'), new FakeDeck('B')], sync: new FakeSync([]),
    settings: new Settings(`ui-automix-none-${Math.random()}`), library: new FakeLibrary() });
  await sleep(40);
  assert.equal($(root, '.tab-auto').hidden, true);
  assert.equal($(root, '.am-strip').hidden, true);
  assert.equal($(root, '.sl').hidden, true);
  assert.equal($$(root, '.add-btn').length, 0);
  ui.destroy();
});

test('platter redraws when the deck changes (no stale SYNC badge)', async () => {
  const app = makeApp(1280, 800);
  await startAudio(app);
  const du = app.ui.deckUIs[1];
  let inval = 0;
  const orig = du.platter.invalidate.bind(du.platter);
  du.platter.invalidate = () => {
    inval++;
    orig();
  };
  const B = app.decks[1];
  await B.loadFile({ name: 'b.mp3', size: 1 });
  B.synced = true;
  B.emit('change', 'sync');
  await sleep(40);
  assert.equal(du.pstate.synced, true);
  const n = inval;
  B.synced = false;
  B.emit('change', 'sync');
  await sleep(40);
  assert.equal(du.pstate.synced, false, 'the record reads deck.synced live');
  assert(inval > n, 'and repaints');
  app.ui.destroy();
});

test('waveform beat ticks follow a beat map through the deck helpers', async () => {
  const app = makeApp(1280, 800);
  await startAudio(app);
  const A = app.decks[0];
  await A.loadFile({ name: 'drift.mp3', size: 1 });
  // a drifting song: beats 0.5 s apart, getting slower; the deck maps beat index <-> time
  const beats = new Float64Array(400);
  for (let k = 0; k < beats.length; k++) beats[k] = 0.1 + k * 0.5 + k * k * 0.0002;
  A.track = { ...A.track, beats, waveform: null };
  let asked = 0;
  A.beatsAt = (pos) => {
    let k = 0;
    while (k < beats.length - 1 && beats[k + 1] <= pos) k++;
    return k + (pos - beats[k]) / (beats[k + 1] - beats[k]);
  };
  A.timeOfBeat = (k) => {
    asked++;
    if (k < 0 || k >= beats.length) return null;
    return beats[Math.floor(k)];
  };
  A.position = 30;
  A.emit('change', 'analysis');
  await sleep(80);
  assert(asked > 0, 'ticks placed from deck.timeOfBeat');
  app.ui.destroy();
});

test('no errors were logged', () => {
  assert.equal(errors.length, 0, errors.join('\n'));
});
