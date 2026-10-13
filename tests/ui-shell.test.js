// Headless smoke test of the whole app shell (src/ui/app-ui.js with the real widgets, sheets, overlays and
// remote panel) on a small fake DOM, with fake engine / decks / sync / library objects that follow the
// contract APIs. It builds the UI in all four layouts, starts audio from the overlay click, renders frames,
// switches pages, opens every sheet, presses transport buttons, uses keyboard shortcuts, drops files, loads
// from the Songs list (with the load-lock confirm), fires 'error' events from every source, and checks that
// nothing logged an error (the UI guards widget failures with console.error, so a clean log means no
// exceptions anywhere).

import { installFakeDom, FakeEvent, Element, FakeDocument } from './helpers/fake-dom.js';
import { FakeEngine, FakeDeck, FakeSync, FakeLibrary } from './helpers/fake-models.js';

const G = globalThis;
const errors = [];
const origError = console.error.bind(console);
console.error = (...args) => {
  errors.push(args.map((a) => (a && a.stack) || String(a)).join(' '));
  origError(...args);
};

installFakeDom();
const { Settings } = await import('../src/core/settings.js');

// ---------------------------------------------------------------------------------------------------------
// Helpers

const { AppUI } = await import('../src/ui/app-ui.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $$ = (root, sel) => root.querySelectorAll(sel);
const $ = (root, sel) => root.querySelector(sel);
const textOf = (el) => (el ? el.textContent : '');

function press(el, type = 'touch') {
  const init = { pointerId: 7, pointerType: type, button: 0, clientX: 20, clientY: 20, isPrimary: true };
  el.dispatchEvent(new FakeEvent('pointerdown', { ...init }));
  el.dispatchEvent(new FakeEvent('pointerup', { ...init }));
  el.dispatchEvent(new FakeEvent('click', { ...init }));
}

function key(code, keyName, type = 'keydown', target = G.document.body) {
  const ev = new FakeEvent(type, { code, key: keyName, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target });
  target.dispatchEvent(ev);
  return ev;
}

function findButton(root, text) {
  return $$(root, 'button').find((b) => textOf(b).trim() === text) || $$(root, 'label').find((b) => textOf(b).trim() === text) || null;
}

function makeApp(w, h) {
  G.innerWidth = w;
  G.innerHeight = h;
  // a fresh document per app so listeners from earlier runs never fire
  G.document = new FakeDocument();
  const root = new Element('div');
  root.setAttribute('id', 'app');
  G.document.body.append(root);
  const settings = new Settings(`ui-shell-${w}x${h}-${Math.random()}`);
  const engine = new FakeEngine();
  const decks = [new FakeDeck('A'), new FakeDeck('B')];
  const sync = new FakeSync(decks);
  const library = new FakeLibrary();
  const ui = new AppUI({ root, engine, decks, sync, settings, library });
  return { root, settings, engine, decks, sync, library, ui };
}

async function startAudio(app, demo = false) {
  const btn = demo ? $(app.root, '.btn-demo') : $(app.root, '.btn-start');
  assert(btn, 'start button');
  btn.click();
  assert.equal(app.engine.startCalls, 1, 'engine.start() runs inside the click');
  await sleep(50);
  assert.equal(app.ui.audioOn, true);
  assert.equal($(app.root, '.start-layer').hidden, true, 'overlay closed');
}

// ---------------------------------------------------------------------------------------------------------
// Tests

test('builds the shell in all four layouts and renders frames', async () => {
  for (const [w, h, layout] of [[360, 560, 'pp'], [844, 390, 'pl'], [768, 1000, 'tp'], [1280, 720, 'console']]) {
    const app = makeApp(w, h);
    const html = G.document.documentElement;
    assert.equal(html.dataset.layout, layout, `${w}x${h}`);
    assert(html.style['--P'] && /px$/.test(html.style['--P']), 'platter size variable');
    assert.equal(html.style['--app-h'], `${h}px`);
    // start overlay first, shell inert behind it
    assert.equal($(app.root, '.start-layer').hidden, false);
    assert.equal($(app.root, '.shell').inert, true);
    assert.match(textOf($(app.root, '.start-tag')), /Two decks in your pocket/);
    await startAudio(app);
    assert.equal($(app.root, '.shell').inert, false);
    await sleep(200); // frames
    // header chips + PFL buttons with the headphone icon, never the word CUE
    assert.equal($$(app.root, '.chip').length, 2);
    for (const b of $$(app.root, '.pfl')) assert(!/\bCUE\b/.test(textOf(b)), 'PFL is not labelled CUE');
    assert($$(app.root, '.pfl').length >= 4);
    // tabs per layout
    const tabs = $$(app.root, '.tab').filter((t) => !t.hidden && t.dataset.page).map((t) => t.dataset.page); // (+ the AUTO MIX switch)
    if (layout === 'pp') assert.deepEqual(tabs, ['decks', 'mix', 'fx', 'songs']);
    if (layout === 'tp') assert.deepEqual(tabs, ['mix', 'fx', 'songs']);
    if (layout === 'pl' || layout === 'console') assert.equal($(app.root, '.tabs').hidden, true);
    app.ui.destroy();
  }
});

test('phone portrait pages show one panel at a time', async () => {
  const app = makeApp(360, 560);
  await startAudio(app);
  const deckA = $(app.root, '.deck.deck-a');
  const mixer = $(app.root, '.mixer');
  const songs = $(app.root, '.songs');
  for (const page of ['mix', 'fx', 'songs', 'decks']) {
    press($(app.root, `.tab-${page}`), 'mouse');
    await sleep(40);
    assert.equal(app.root.dataset.page, page);
    assert.equal(deckA.hidden, page !== 'decks');
    assert.equal(mixer.hidden, page !== 'mix');
    assert.equal(songs.hidden, page !== 'songs');
  }
  // FX target switch
  press($(app.root, '.tab-fx'), 'mouse');
  const fxB = $(app.root, '.fx.fx-b');
  assert.equal(fxB.hidden, true);
  $$(app.root, '.fx-tgt').find((b) => textOf(b) === 'B').click();
  assert.equal(fxB.hidden, false);
  assert.equal(app.settings.get('fxDeck'), 'B');
  app.ui.destroy();
});

test('transport, FX pads, loops, PFL and keyboard reach the decks', async () => {
  const app = makeApp(1280, 720);
  await startAudio(app);
  const [A, B] = app.decks;
  // no song yet: PLAY explains instead of playing
  press($(app.root, '.deck-a .t-play'));
  assert.equal(A.count('togglePlay'), 0);
  await A.loadFile({ name: 'a.mp3', size: 1 });
  await B.loadFile({ name: 'b.mp3', size: 1 });
  await sleep(40);
  press($(app.root, '.deck-a .t-play'));
  assert.equal(A.count('togglePlay'), 1);
  press($(app.root, '.deck-b .t-cue'));
  assert.equal(B.count('cueDown'), 1);
  assert.equal(B.count('cueUp'), 1);
  press($(app.root, '.deck-b .t-sync'));
  assert.deepEqual(app.sync.calls[0], ['toggle', 1]);
  // FX pad latch, loops, one-shots (deck A is playing)
  press($(app.root, '.fx-a .pad-echo'));
  assert.equal(A.fx.echo, true);
  press($(app.root, '.fx-a .pad-echo'));
  assert.equal(A.fx.echo, false);
  press($$(app.root, '.fx-a .loop-pad')[2]);
  assert.deepEqual(A.calls.filter((c) => c[0] === 'toggleLoop')[0], ['toggleLoop', 4]);
  press($(app.root, '.fx-a .shot-echo'));
  assert.equal(A.count('echoOut'), 1);
  // headphone pre-listen (single output: the hint toast with an Outputs button)
  press($(app.root, '.strip-a .strip-pfl'));
  assert.equal(A.mix.cue, true);
  await sleep(20);
  assert($$(app.root, '.toast').some((t) => /second output/.test(textOf(t))), 'PFL hint toast');
  // keyboard: Q play A, O cue B (hold), I sync B, 3 = 4-beat loop A, arrows move the crossfader
  key('KeyQ', 'q');
  assert.equal(A.count('togglePlay'), 2);
  key('KeyO', 'o');
  key('KeyO', 'o', 'keyup');
  assert.equal(B.count('cueDown'), 2);
  assert.equal(B.count('cueUp'), 2);
  key('KeyI', 'i');
  assert.deepEqual(app.sync.calls[app.sync.calls.length - 1], ['toggle', 1]);
  key('Digit3', '3');
  assert.equal(A.calls.filter((c) => c[0] === 'toggleLoop').length, 2);
  key('ArrowRight', 'ArrowRight');
  assert.closeTo(app.ui.xfade, 0.1, 1e-9);
  assert(app.engine.mixer.calls.some((c) => c[0] === 'xf' && Math.abs(c[1] - 0.1) < 1e-9), 'crossfader reached the mixer');
  // keys are ignored while typing
  const input = new Element('input');
  input.setAttribute('type', 'text');
  G.document.body.append(input);
  key('KeyQ', 'q', 'keydown', input);
  assert.equal(A.count('togglePlay'), 2);
  // keyboard-focused button: Space presses it (bindPress keys)
  const syncA = $(app.root, '.deck-a .t-sync');
  syncA.dispatchEvent(new FakeEvent('keydown', { key: ' ', code: 'Space' }));
  syncA.dispatchEvent(new FakeEvent('keyup', { key: ' ', code: 'Space' }));
  assert.deepEqual(app.sync.calls[app.sync.calls.length - 1], ['toggle', 0]);
  await sleep(100);
  app.ui.destroy();
});

test('every sheet opens, and the outputs sheet drives the router', async () => {
  const app = makeApp(360, 560);
  await startAudio(app);
  const r = app.engine.outputs;
  $(app.root, '.hb-menu').click();
  const sheet = $(app.root, '.sheet');
  assert.equal($(app.root, '.sheet-layer').hidden, false);
  assert.equal(textOf($(sheet, '.sheet-title')), 'Menu');
  assert.equal($(app.root, '.shell').inert, true, 'shell inert under a sheet');
  // Outputs from the menu
  findButton(sheet, 'Outputs and headphonesPhone speaker').click();
  assert.equal(textOf($(sheet, '.sheet-title')), 'Outputs');
  const cards = $$(sheet, '.mode-card');
  assert.equal(cards.length, 4);
  assert.match(textOf(cards[1]), /Phones can only play to one output/);
  // split cable
  cards[2].click();
  await sleep(20);
  assert.equal(r.mode, 'split');
  assert($(sheet, '.split-diagram'), 'split diagram');
  findButton(sheet, 'Test speaker').click();
  assert.deepEqual(r.calls[r.calls.length - 1], ['test', 'master']);
  // second device: shows the remote panel without switching the router yet
  $$(sheet, '.mode-card')[3].click();
  await sleep(20);
  assert.equal(r.mode, 'split');
  assert($(sheet, '.remote-slot .rp'), 'remote panel mounted');
  // back to one output
  $$(sheet, '.mode-card')[0].click();
  await sleep(20);
  assert.equal(r.mode, 'single');
  assert(!$(sheet, '.remote-slot'));
  // levels
  assert.equal($$(sheet, '.fader-level').length, 3);
  // back -> menu -> settings
  $(sheet, '.sheet-back').click();
  findButton(sheet, 'SettingsTempo range, scratch, crossfader, screen').click();
  assert.equal(textOf($(sheet, '.sheet-title')), 'Settings');
  const labels = $$(sheet, '.row-label').map(textOf);
  for (const l of ['Tempo range', 'Scratch on the record', 'Snap to the beat', 'Auto sync', 'Time display', 'Crossfader',
    'Waveform zoom', 'Outdoor contrast', 'Keep the screen on', 'Vibration ticks', 'Restart audio']) {
    assert(labels.includes(l), `settings row ${l}`);
  }
  // outdoor contrast flips the attribute on <html>
  $$(sheet, '.row-switch').find((b) => /Outdoor contrast/.test(textOf(b))).click();
  assert.equal(G.document.documentElement.getAttribute('data-outdoor'), '1');
  // crossfader curve: cut
  $$(sheet, '.seg-btn').find((b) => textOf(b) === 'Cut').click();
  assert.equal(app.settings.get('xfadeCurve'), 'cut');
  // tempo range reaches the decks
  $$(sheet, '.seg-btn').find((b) => textOf(b) === '±16%').click();
  assert.equal(app.decks[0].tempoRange, 0.16);
  // diagnostics text
  await sleep(20);
  assert.match(textOf($(sheet, '.diag')), /layout: pp/);
  // restart audio
  findButton(sheet, 'Restart audioUse this if the sound stops or stutters. Songs stay loaded.').click();
  await sleep(30);
  assert.equal(app.engine.restartCalls, 1);
  assert.equal($(app.root, '.resume-banner').hidden, true, 'no banner flash during a restart');
  // help
  $(sheet, '.sheet-back').click();
  findButton(sheet, 'HelpHow everything works, in plain words').click();
  assert.equal(textOf($(sheet, '.sheet-title')), 'Help');
  assert($$(sheet, '.help-sec').length >= 8);
  $(sheet, '.sheet-close').click();
  assert.equal($(app.root, '.sheet-layer').hidden, true);
  // deck sheet from the chip
  $(app.root, '.chip-a').click();
  assert.equal(textOf($(sheet, '.sheet-title')), 'Deck A');
  await app.decks[0].loadFile({ name: 'x.mp3', size: 2 });
  await sleep(10);
  assert.match(textOf($(sheet, '.ds-bpm')), /124\.0/);
  findButton(sheet, '×2').click();
  assert.equal(app.decks[0].count('doubleBpm'), 1);
  press($(sheet, '.btn-tap'));
  assert.equal(app.decks[0].count('tapTempo'), 1);
  key('Escape', 'Escape', 'keydown', sheet);
  assert.equal($(app.root, '.sheet-layer').hidden, true);
  app.ui.destroy();
});

test('songs: add, load from the list with the load lock, demos, remove, drag and drop', async () => {
  const app = makeApp(360, 560);
  await startAudio(app);
  const [A, B] = app.decks;
  press($(app.root, '.tab-songs'), 'mouse');
  // add music through the label-wrapped input
  const input = $(app.root, '.btn-add input');
  assert(input, 'file input inside the Add music label');
  assert.match(input.getAttribute('accept'), /\.mp3/);
  input.files = [{ name: 'one.mp3', size: 100, type: 'audio/mpeg' }, { name: 'notes.pdf', size: 5, type: 'application/pdf' }];
  input.dispatchEvent(new FakeEvent('change'));
  await sleep(30);
  assert.equal(A.count('loadFile'), 1, 'first song loads on the empty deck A');
  assert.equal(A.calls[0][1].name, 'one.mp3', 'the PDF is never loaded on a deck');
  assert(app.library.calls.some((c) => c[0] === 'add'));
  // the list shows the song with big A / B buttons (demo rows separate)
  app.ui.songs.render();
  const rows = $$(app.root, '.songs .song-row');
  assert(rows.length >= 3, 'song + 2 demos');
  // deck A playing and audible: loading onto it asks first
  A.playing = true;
  A.audible = true;
  const songRow = rows.find((r) => /one/.test(textOf(r)));
  const btnA = $$(songRow, '.load-btn')[0];
  btnA.click();
  await sleep(10);
  const dlg = $(app.root, '.dialog-layer');
  assert.equal(dlg.hidden, false, 'load lock confirm');
  assert.match(textOf(dlg), /Deck A is playing\. Replace the song\?/);
  findButton(dlg, 'Keep playing').click();
  await sleep(10);
  assert.equal(A.count('loadFile'), 1);
  btnA.click();
  await sleep(10);
  findButton($(app.root, '.dialog-layer'), 'Replace').click();
  await sleep(20);
  assert.equal(A.count('loadFile'), 2);
  assert(app.library.calls.some((c) => c[0] === 'update' && c[2].lastUsedAt), 'library use stamp');
  // demo B
  const demoRow = $$(app.root, '.songs .song-row').find((r) => /Spore Garden/.test(textOf(r)));
  $$(demoRow, '.load-btn')[1].click();
  await sleep(10);
  assert.deepEqual(B.calls.find((c) => c[0] === 'loadDemo'), ['loadDemo', 1]);
  // two-step remove
  app.ui.songs.render();
  let rm = $(app.root, '.song-rm');
  rm.click();
  rm = $(app.root, '.song-rm.armed');
  assert(rm, 'armed remove');
  rm.click();
  await sleep(10);
  assert.equal(app.library.entries.length, 0);
  // drag and drop a file onto the window
  const files = [{ name: 'drop.wav', size: 9, type: 'audio/wav' }];
  const drop = new FakeEvent('drop', { dataTransfer: { files, types: ['Files'] } });
  G.dispatchEvent(drop);
  assert.equal(drop.defaultPrevented, true);
  await sleep(10);
  assert(app.library.calls.filter((c) => c[0] === 'add').length >= 2);
  app.ui.destroy();
});

test('errors from every source become toasts; resume banner and update toast', async () => {
  const app = makeApp(360, 560);
  await startAudio(app);
  const toasts = () => $$(app.root, '.toast').map(textOf).join(' | ');
  const sources = [
    [app.decks[0], "This file can't be played in this browser. Try an MP3 or WAV.", /can't be played/],
    [app.sync, 'Deck B has no tempo yet. Wait for the BPM or tap it in.', /no tempo yet/],
    [app.library, 'This device is out of storage for songs.', /out of storage/],
    [app.engine.outputs, 'Your headphones output was disconnected.', /headphones output/],
    [app.engine, 'Audio stopped unexpectedly.', /Audio stopped unexpectedly/],
  ];
  for (const [src, msg, re] of sources) {
    src.emit('error', msg);
    await sleep(5);
    assert.match(toasts(), re);
  }
  assert($$(app.root, '.toast').length <= 3, 'at most three toasts at once');
  // suspended -> banner with Resume + Restart audio
  app.engine.state = 'suspended';
  app.engine.emit('statechange', 'suspended');
  const banner = $(app.root, '.resume-banner');
  assert.equal(banner.hidden, false);
  findButton(banner, 'Tap to resume audio').click();
  await sleep(10);
  assert.equal(banner.hidden, true);
  // service worker update toast
  let reloaded = 0;
  app.ui.showUpdateReady(() => reloaded++);
  await sleep(5);
  const upd = $$(app.root, '.toast').find((t) => /Update ready/.test(textOf(t)));
  assert(upd, 'update toast');
  $(upd, '.toast-action').click();
  assert.equal(reloaded, 1);
  app.ui.destroy();
});

test('demo shortcut starts audio and loads both demos; coach marks run', async () => {
  const app = makeApp(390, 760);
  await startAudio(app, true);
  await sleep(200);
  assert.equal(app.decks[0].calls.find((c) => c[0] === 'loadDemo')[1], 0);
  assert.equal(app.decks[1].calls.find((c) => c[0] === 'loadDemo')[1], 1);
  await sleep(700);
  // first-run tips (decks are loaded, so the bubble has moved past "Tap a record")
  const coach = $(app.root, '.coach');
  assert.equal(coach.hidden, false, 'coach bubble shown');
  findButton(coach, 'Skip tips').click();
  assert.equal(coach.hidden, true);
  assert.equal(app.settings.get('tipsSeen'), true);
  app.ui.destroy();
});

test('crossfader cut curve switches to absolute drag without double-tap reset', async () => {
  const app = makeApp(360, 560);
  await startAudio(app);
  const xf = app.ui.mixer.xfader;
  assert(xf, 'crossfader widget');
  assert.equal(xf.core.absolute, false);
  assert.equal(xf.core.doubleTapReset, true);
  app.settings.set('xfadeCurve', 'cut');
  assert(app.engine.mixer.calls.some((c) => c[0] === 'curve' && c[1] === 'cut'));
  assert.equal(xf.core.absolute, true, 'cut: jump to the finger');
  assert.equal(xf.core.doubleTapReset, false, 'cut: rapid taps are cuts, not resets');
  app.settings.set('xfadeCurve', 'smooth');
  assert.equal(xf.core.absolute, false);
  app.ui.destroy();
});

test('resizing switches layouts; landscape and console pages; knob style follows', async () => {
  const app = makeApp(360, 640);
  await startAudio(app);
  const html = G.document.documentElement;
  const knob = () => $(app.root, '.strip-a .k-high .ts-knob');
  assert(knob().classList.contains('ts-knob--bar'), 'bar sliders on phones');
  // rotate to landscape
  G.innerWidth = 640;
  G.innerHeight = 360;
  G.dispatchEvent(new FakeEvent('resize'));
  await sleep(40);
  assert.equal(html.dataset.layout, 'pl');
  assert.equal($(app.root, '.deck.deck-a').hidden, false, 'landscape: decks always visible');
  // FX opens over the centre column from the header button, a second tap closes it
  $(app.root, '.hb-fx').click();
  assert.equal($(app.root, '.waves').hidden, true);
  assert.equal($(app.root, '.fx.fx-a').hidden, false);
  $(app.root, '.hb-fx').click();
  assert.equal($(app.root, '.waves').hidden, false);
  assert.equal($(app.root, '.mixer').hidden, false);
  // desktop console: everything visible, rotary knobs, songs drawer toggles
  G.innerWidth = 1366;
  G.innerHeight = 768;
  G.dispatchEvent(new FakeEvent('resize'));
  await sleep(40);
  assert.equal(html.dataset.layout, 'console');
  assert(knob().classList.contains('ts-knob--rotary'), 'rotary knobs on the console');
  for (const sel of ['.deck.deck-a', '.deck.deck-b', '.mixer', '.fx.fx-a', '.fx.fx-b', '.xf', '.waves']) {
    assert.equal($(app.root, sel).hidden, false, sel);
  }
  assert.equal($(app.root, '.songs').hidden, true);
  $(app.root, '.hb-songs').click();
  assert.equal($(app.root, '.songs').hidden, false);
  $(app.root, '.songs-close').click();
  assert.equal($(app.root, '.songs').hidden, true);
  await sleep(40);
  app.ui.destroy();
});

test('audio start failure is explained on the start overlay', async () => {
  const app = makeApp(360, 560);
  const logError = console.error;
  console.error = () => {}; // the failure is expected here
  app.engine.start = function start() {
    this.startCalls++;
    this.emit('error', 'Audio could not start in this browser. Close other tabs that play sound and try again.');
    return Promise.reject(new Error('Audio could not start'));
  };
  $(app.root, '.btn-start').click();
  await sleep(20);
  assert.equal($(app.root, '.start-layer').hidden, false);
  assert.match(textOf($(app.root, '.start-status')), /Close other tabs/);
  assert($(app.root, '.start-status').classList.contains('error'));
  assert.equal($(app.root, '.btn-start').disabled, false, 'can try again');
  assert.equal(app.ui.audioOn, false);
  app.ui.destroy();
  console.error = logError;
});

test('settings reset keeps the outputs and asks first', async () => {
  const app = makeApp(1280, 800);
  await startAudio(app);
  app.settings.set('outputMode', 'split');
  app.settings.set('tempoRange', 0.5);
  app.ui.openMenu();
  const sheet = $(app.root, '.sheet');
  findButton(sheet, 'SettingsTempo range, scratch, crossfader, screen').click();
  $$(sheet, '.row-nav').find((b) => /Reset all settings/.test(textOf(b))).click();
  await sleep(5);
  findButton($(app.root, '.dialog-layer'), 'Reset').click();
  await sleep(10);
  assert.equal(app.settings.get('tempoRange'), 0.08);
  assert.equal(app.settings.get('outputMode'), 'split');
  assert.equal(app.decks[0].tempoRange, 0.08);
  app.ui.destroy();
});

test('the real module graph boots (startApp) and renders before audio starts', async () => {
  G.innerWidth = 390;
  G.innerHeight = 700;
  G.document = new FakeDocument();
  const root = new Element('div');
  root.setAttribute('id', 'app');
  root.classList.add('booting');
  G.document.body.append(root);
  const { startApp } = await import('../src/ui/boot-app.js');
  const app = startApp(root);
  assert.equal(root.classList.contains('booting'), false);
  assert.equal(app.decks.length, 2);
  assert.equal(app.decks[1].id, 'B');
  // the set list and Auto Mix are built too (Auto Mix starts off) and exposed for the console
  assert(app.playlist && Array.isArray(app.playlist.items), 'playlist');
  assert(app.automix && app.automix.enabled === false, 'automix, off after boot');
  assert.equal(G.window.twinspin.automix, app.automix);
  assert.equal(G.window.twinspin.playlist, app.playlist);
  await sleep(300); // frames with the real Deck getters, library init, songs list
  assert.equal(G.document.documentElement.dataset.layout, 'pp');
  assert.equal($(app.ui.root, '.start-layer').hidden, false);
  assert($$(root, '.song-row').length >= 2, 'demo tracks listed');
  // + on a demo row reaches the real Playlist, which persists it and the set list shows it
  const demoRow = $$(root, '.song-row').find((r) => /Neon Drift/.test(textOf(r)));
  $(demoRow, '.add-btn').click();
  await sleep(10);
  assert.equal(app.playlist.items.length, 1);
  assert.deepEqual(app.settings.get('setList'), [{ kind: 'demo', id: 0 }]);
  assert.equal($$(root, '.sl-row').length, 1);
  app.playlist.clear();
  // a deck error from the real Deck reaches a toast
  app.decks[0].doubleBpm(); // no BPM yet: the deck explains
  await sleep(10);
  assert($$(root, '.toast').length >= 1);
  app.ui.destroy();
});

test('no errors were logged', () => {
  assert.equal(errors.length, 0, errors.join('\n'));
});
