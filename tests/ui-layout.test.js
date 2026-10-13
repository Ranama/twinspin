// Pure tests for the app shell's layout budgets (src/ui/layout-math.js) and UI text formatting
// (src/ui/format.js): layout selection, every layout fits its viewport (360 x 560 phone portrait without
// scrolling), touch-target minimums, page visibility per layout, and the readouts' wording.
import {
  pickLayout, computeSizes, cssVars, stackHeight, visibility, effectivePage, tabsFor, knobStyle, TP_MIN_H, CONSOLE_MIN_W,
} from '../src/ui/layout-math.js';
import {
  fmtEq, fmtFilter, fmtXfade, fmtPct, fmtCueMix, fmtAlign, fmtBytes, songMeta, songTitle, deckTime, bpmText,
  waveSeconds, stepZoom, ZOOM_STEPS, fmtRange,
} from '../src/ui/format.js';

const NO_INSETS = { t: 0, r: 0, b: 0, l: 0 };

/** The viewports the research budgets name, plus odd desktop windows. [w, h, insets, expected layout] */
const VIEWPORTS = [
  [360, 560, NO_INSETS, 'pp'], // Android phone in Chrome, URL bar shown
  [360, 640, NO_INSETS, 'pp'],
  [320, 500, NO_INSETS, 'pp'], // small / old phones
  [390, 660, NO_INSETS, 'pp'], // iPhone Safari tab
  [390, 844, { t: 47, r: 0, b: 34, l: 0 }, 'pp'], // iPhone Home Screen app
  [430, 932, { t: 59, r: 0, b: 34, l: 0 }, 'pp'],
  [640, 300, NO_INSETS, 'pl'], // Android landscape
  [844, 340, { t: 0, r: 59, b: 21, l: 59 }, 'pl'], // iPhone landscape
  [932, 400, { t: 0, r: 59, b: 21, l: 59 }, 'pl'],
  [700, 520, NO_INSETS, 'pl'], // narrow landscape desktop window
  [768, 950, NO_INSETS, 'tp'], // iPad portrait
  [600, 900, NO_INSETS, 'tp'], // small Android tablet
  [834, 1112, { t: 24, r: 0, b: 20, l: 0 }, 'tp'],
  [1024, 1300, NO_INSETS, 'tp'],
  [700, 740, NO_INSETS, 'pp'], // short portrait desktop window
  [1024, 700, NO_INSETS, 'console'], // iPad landscape / laptop
  [960, 540, NO_INSETS, 'console'],
  [800, 600, NO_INSETS, 'console'], // smallest console: three FX rows under narrow deck columns
  [900, 540, NO_INSETS, 'pl'], // narrow and short: the console's records would be too small
  [800, 520, NO_INSETS, 'pl'],
  [1280, 720, NO_INSETS, 'console'],
  [1920, 1080, NO_INSETS, 'console'],
  [2560, 1300, NO_INSETS, 'console'],
];

test('pickLayout follows the research selection rules', () => {
  assert.equal(pickLayout(360, 640), 'pp');
  assert.equal(pickLayout(599, 900), 'pp');
  assert.equal(pickLayout(640, 360), 'pl');
  assert.equal(pickLayout(1000, 499), 'pl');
  assert.equal(pickLayout(768, 1024), 'tp');
  assert.equal(pickLayout(1024, 768), 'console');
  assert.equal(pickLayout(1024, 500), 'console');
  assert.equal(pickLayout(0, 0), 'pp');
  assert.equal(pickLayout(NaN, 800), 'pp');
  // refinements for odd windows
  assert.equal(pickLayout(700, TP_MIN_H - 1), 'pp');
  assert.equal(pickLayout(700, TP_MIN_H), 'tp');
  assert.equal(pickLayout(CONSOLE_MIN_W - 1, 600), 'pl');
  assert.equal(pickLayout(CONSOLE_MIN_W, 600), 'console');
  for (const [w, h, , want] of VIEWPORTS) assert.equal(pickLayout(w, h), want, `${w}x${h}`);
});

test('every layout fits its viewport height', () => {
  for (const [w, h, ins, want] of VIEWPORTS) {
    const layout = pickLayout(w, h);
    assert.equal(layout, want);
    const s = computeSizes(layout, w, h, ins);
    const usable = h - (ins.t || 0) - (ins.b || 0);
    const st = stackHeight(s);
    assert(st.total <= usable + 0.5, `${w}x${h} ${layout}: needs ${st.total}px of ${usable}px`);
    if (layout === 'pp') {
      // the DECKS page fits the page row
      assert(st.decks <= s.page + 0.5, `${w}x${h}: decks ${st.decks} > page ${s.page}`);
    }
    if (layout === 'tp') assert(s.page >= 150, `${w}x${h}: tablet page row only ${s.page}px`);
    if (layout === 'console') assert(s.page >= s.P + s.tr + s.tempo + 2 * s.gap - 0.5, `${w}x${h}: console decks clipped`);
  }
});

test('360 x 560 phone portrait matches the research budget', () => {
  const s = computeSizes('pp', 360, 560, NO_INSETS);
  assert.equal(s.cw, 328); // 16 px gutters
  assert.equal(s.hdr, 44);
  assert.equal(s.waves, 120); // 16 + 44 + 44 + 16
  assert(s.P >= 140 && s.P <= 156, `platter ${s.P}`);
  assert(s.tr >= 48, 'transport row >= 48');
  assert(s.tempo >= 44, 'tempo row >= 44');
  assert(s.xf >= 56, 'crossfader row >= 56');
  assert(s.tabs >= 48, 'tabs >= 48');
  assert.equal(stackHeight(s).total, 560);
});

test('touch targets and platters stay usable everywhere', () => {
  for (const [w, h, ins] of VIEWPORTS) {
    const layout = pickLayout(w, h);
    const s = computeSizes(layout, w, h, ins);
    assert(s.gl >= 16 && s.gr >= 16, `${w}x${h}: edge gutters (OS back gesture)`);
    assert(s.tr >= 48, `${w}x${h}: transport ${s.tr}`);
    assert(s.tempo >= 44, `${w}x${h}: tempo row ${s.tempo}`);
    assert(s.P >= 96, `${w}x${h}: platter ${s.P}`);
    if (layout === 'pp') {
      // two deck columns: the platter never overflows its column
      assert(s.P <= s.deckW, `${w}x${h}: platter ${s.P} wider than column ${s.deckW}`);
      // three transport buttons of >= 44 px fit a column
      assert(s.deckW >= 3 * 44 + 8, `${w}x${h}: column ${s.deckW}`);
    }
    if (layout === 'pl') {
      assert(s.centre >= 200, `${w}x${h}: centre column ${s.centre}`);
      assert(s.deckW >= s.P, `${w}x${h}: deck column narrower than its platter`);
    }
    if (layout === 'tp' || layout === 'console') {
      assert(s.deckW >= s.P + 56 + 8, `${w}x${h}: deck column fits tempo fader + platter`);
    }
    if (layout === 'console') {
      assert(s.mixW >= 340 && s.mixW <= 420, `${w}x${h}: mixer ${s.mixW}`);
      assert(s.fxH >= 2 * 44 + 6 + 12, `${w}x${h}: FX row fits two rows of pads (${s.fxH})`);
    }
  }
});

test('the phone platter grows with the phone and the quick row appears on tall phones', () => {
  const small = computeSizes('pp', 360, 560, NO_INSETS);
  const tall = computeSizes('pp', 390, 844, { t: 47, b: 34 });
  assert(tall.P >= small.P);
  assert.equal(small.quick, false);
  assert.equal(tall.quick, true);
  assert(tall.waveZ > small.waveZ, 'spare height goes to the waveforms');
});

test('cssVars emits px values for every budget variable', () => {
  const v = cssVars(computeSizes('pp', 360, 560, NO_INSETS));
  for (const k of ['--gl', '--gr', '--hdr-h', '--wo', '--wz', '--xf-h', '--tabs-h', '--tr-h', '--tempo-h', '--quick-h',
    '--P', '--deck-w', '--knob', '--mix-w', '--fx-h', '--gap', '--pad']) {
    assert.match(v[k], /^-?\d+px$/, k);
  }
  assert.equal(v['--P'], `${computeSizes('pp', 360, 560, NO_INSETS).P}px`);
});

test('pages, tabs and visibility per layout', () => {
  assert.deepEqual(tabsFor('pp'), ['decks', 'mix', 'fx', 'songs']);
  assert.deepEqual(tabsFor('tp'), ['mix', 'fx', 'songs']);
  assert.deepEqual(tabsFor('pl'), []);
  assert.deepEqual(tabsFor('console'), []);
  assert.equal(effectivePage('pp', 'fx'), 'fx');
  assert.equal(effectivePage('pp', 'bogus'), 'decks');
  assert.equal(effectivePage('tp', 'decks'), 'mix');
  assert.equal(effectivePage('pl', 'decks'), 'mix');
  assert.equal(effectivePage('console', 'fx'), 'mix');
  assert.equal(effectivePage('console', 'songs'), 'songs');
  assert.equal(knobStyle('pp'), 'bar');
  assert.equal(knobStyle('pl'), 'bar');
  assert.equal(knobStyle('tp'), 'rotary');
  assert.equal(knobStyle('console'), 'rotary');

  // phone portrait: exactly one page in the middle, waveforms, crossfader and tabs always
  const pp = visibility('pp', 'decks', 'A');
  assert.deepEqual(pp, { decks: true, mixer: false, fxA: false, fxB: false, songs: false, waves: true, tabs: true, xf: true });
  assert.equal(visibility('pp', 'fx', 'B').fxB, true);
  assert.equal(visibility('pp', 'fx', 'B').fxA, false);
  assert.equal(visibility('pp', 'mix', 'A').decks, false);
  // phone landscape: decks always; FX/SONGS replace the waveforms + mixer of the centre column
  assert.equal(visibility('pl', 'fx', 'A').decks, true);
  assert.equal(visibility('pl', 'fx', 'A').waves, false);
  assert.equal(visibility('pl', 'mix', 'A').waves, true);
  assert.equal(visibility('pl', 'songs', 'A').mixer, false);
  // console: everything, songs as a drawer
  const c = visibility('console', 'songs', 'A');
  assert.equal(c.decks && c.mixer && c.fxA && c.fxB && c.songs && c.waves && c.xf, true);
  assert.equal(c.tabs, false);
});

test('control readouts', () => {
  assert.equal(fmtEq(-1), 'KILL');
  assert.equal(fmtEq(0), '0 dB');
  assert.equal(fmtEq(1), '+6.0 dB');
  assert.match(fmtEq(-0.5), /^-\d+\.\d dB$/);
  assert.equal(fmtFilter(0.02), 'OFF');
  assert.equal(fmtFilter(-0.5), 'LOW-PASS 50%');
  assert.equal(fmtFilter(0.4), 'HIGH-PASS 40%');
  assert.equal(fmtXfade(0), 'CENTRE');
  assert.equal(fmtXfade(-0.4), 'A 40%');
  assert.equal(fmtXfade(1), 'B 100%');
  assert.equal(fmtPct(0.8), '80%');
  assert.equal(fmtCueMix(0), 'CUE ONLY');
  assert.equal(fmtCueMix(1), 'MASTER ONLY');
  assert.equal(fmtCueMix(0.3), 'CUE 70 / MST 30');
  assert.equal(fmtAlign(0), '0 ms');
  assert.equal(fmtAlign(120), '+120 ms (speaker later)');
  assert.equal(fmtAlign(-80), '-80 ms (headphones later)');
  assert.equal(fmtRange(0.08), '±8%');
  assert.equal(fmtRange(0.5), '±50%');
});

test('song list wording', () => {
  assert.equal(fmtBytes(0), '0 MB');
  assert.equal(fmtBytes(500 * 1024), '500 KB');
  assert.equal(fmtBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(fmtBytes(42 * 1024 * 1024), '42 MB');
  assert.equal(fmtBytes(1.5 * 1024 * 1024 * 1024), '1.5 GB');
  assert.equal(songMeta({ artist: 'Ana', bpm: 124.04, duration: 225 }), 'Ana · 124 BPM · 3:45');
  assert.equal(songMeta({ bpm: null, duration: 0 }), '');
  assert.equal(songTitle({ title: 'Neon Drift' }), 'Neon Drift');
  assert.equal(songTitle({ title: '', fileName: 'my_best_track.mp3' }), 'my best track');
  assert.equal(songTitle(null), 'Untitled');
  assert.equal(deckTime(10, 70, 'remain'), '-1:00');
  assert.equal(deckTime(65, 70, 'elapsed'), '1:05');
  assert.equal(deckTime(0, 0, 'remain'), '-0:00');
  assert.equal(bpmText(null, true), '…');
  assert.equal(bpmText(null, false), '--.-');
  assert.equal(bpmText(127.96, false), '128.0');
});

test('waveform zoom steps', () => {
  assert.equal(waveSeconds('pp', 1), 6);
  assert.equal(waveSeconds('tp', 1), 8);
  assert.equal(waveSeconds('console', 2), 20);
  assert.equal(waveSeconds(328, 1), 6); // by canvas width, like WaveView
  assert.equal(waveSeconds(728, 1), 8);
  assert.equal(waveSeconds(1248, 0.5), 5);
  assert.equal(stepZoom(1, 1), 1.5);
  assert.equal(stepZoom(1, -1), 0.67);
  assert.equal(stepZoom(3, 1), 3);
  assert.equal(stepZoom(0.33, -1), 0.33);
  assert.equal(stepZoom(1.4, 1), 2); // snaps to the nearest step first
  assert.equal(ZOOM_STEPS[0], 0.33);
  assert.equal(ZOOM_STEPS[ZOOM_STEPS.length - 1], 3);
});
