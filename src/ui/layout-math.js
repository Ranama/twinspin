// Layout selection and pixel budgets for the four TwinSpin layouts. Pure: no DOM, tested in
// tests/ui-layout.test.js. AppUI measures the viewport and safe-area insets, then:
//   const layout = pickLayout(innerWidth, innerHeight);          // 'pp' | 'pl' | 'tp' | 'console'
//   const s = computeSizes(layout, innerWidth, innerHeight, { t, r, b, l });
//   for (const [k, v] of Object.entries(cssVars(s))) html.style.setProperty(k, v);
// The budgets follow docs/research/research-ux.md (PHONE PORTRAIT, PHONE LANDSCAPE, TABLET, DESKTOP). CSS does
// the placement; these numbers only size the rows and the platter (--P) so nothing has to be solved with long
// calc() chains, and so the phone portrait layout fits 360 x 560 CSS px without scrolling, also with the Auto
// Mix status strip (computeSizes(..., { am: true }), automixPlacement). The console FX row has two or three rows
// of pads depending on the deck column width (fxRows -> #app[data-fxrows]). The music player page (docs/PLAYER.md)
// gets its box and arrangement from playerBox / playerLayout, and the strip's mini transport from stripFit.

import { clamp } from '../core/util.js';

/** Layout names, in the order of the research notes. */
export const LAYOUTS = Object.freeze(['pp', 'pl', 'tp', 'console']);

/** Shortest portrait viewport that gets the tablet layout. */
export const TP_MIN_H = 760;
/** Narrowest landscape viewport that gets the console layout. */
export const CONSOLE_MIN_W = 800;
/** Smallest platter the console layout may end up with; below it the window uses phone landscape (pl). */
export const CONSOLE_MIN_P = 120;
/**
 * Console FX panel content width (deck column minus padding and border) from which the panel uses two rows
 * ([4 FX pads | amount] / [loops | ECHO OUT, BRAKE]); narrower panels stack three rows so no pad gets narrower
 * than ~42 px (labels then wrap onto two lines at 11 px instead of spilling out of the pads).
 */
export const FX_TWO_ROW_MIN = 250;
/** Height of the Auto Mix status strip row on the phone / tablet portrait DECKS page (40 px strip + 4 px gap). */
export const AM_STRIP_H = 44;
/** Phone portrait with the Auto Mix strip: below this platter size the waveform lanes shrink a little. */
const AM_MIN_P = 112;

/**
 * Pick the layout for a viewport (CSS px), per research-ux LAYOUT SELECTION:
 * pp: phone portrait (width < 600, height >= width); pl: phone landscape (wider than tall, height < 500);
 * tp: tablet portrait (width >= 600, height >= width); console: tablet landscape / desktop.
 * Refinements keep every control usable in odd desktop windows: a portrait viewport shorter than 760 px uses
 * pp (the tp budget needs ~760 px of height), a landscape viewport narrower than 800 px uses pl (the console
 * needs two deck columns plus a 340 px mixer), and so does a landscape window where the console's platter would
 * end up smaller than CONSOLE_MIN_P (narrow AND short windows, where the FX row needs three rows).
 */
export function pickLayout(w, h) {
  if (!(w > 0) || !(h > 0)) return 'pp';
  if (h >= w) return w < 600 || h < TP_MIN_H ? 'pp' : 'tp';
  if (h < 500 || w < CONSOLE_MIN_W) return 'pl';
  return consoleFits(w, h) ? 'console' : 'pl';
}

/** Does the console layout fit a w x h window (16 px gutters, no insets) with a usable platter? */
export function consoleFits(w, h) {
  const s = consoleLayout(Math.max(240, Math.floor(w - 32)), Math.max(240, Math.floor(h)));
  return s.natP >= CONSOLE_MIN_P;
}

/** Which platter/knob style a layout uses: phones draw EQ/filter as bar sliders, tablets as rotary knobs. */
export function knobStyle(layout) {
  return layout === 'pp' || layout === 'pl' ? 'bar' : 'rotary';
}

/** Every page name the app knows ('player' is the music player page, docs/PLAYER.md section 5). */
export const PAGES = Object.freeze(['decks', 'mix', 'fx', 'songs', 'player']);

/**
 * Normalise the page the phone/tablet layouts show in their swappable area.
 * pp: decks | mix | fx | songs | player. tp and pl always show the decks (except on the player page, which takes
 * the whole screen), so 'decks' means the mixer there. console shows everything; only 'songs' (the library
 * drawer) and 'player' (the player drawer) are meaningful.
 */
export function effectivePage(layout, page) {
  const p = PAGES.includes(page) ? page : 'decks';
  if (layout === 'pp') return p;
  if (layout === 'console') return p === 'songs' || p === 'player' ? p : 'mix';
  return p === 'decks' ? 'mix' : p;
}

/**
 * The tabs a layout shows (empty when the layout has no tab bar). At most five: the PLAYER tab takes the place
 * the AUTO MIX switch had on phones (AppUI hides it when there is no Player, and the switch comes back).
 */
export function tabsFor(layout) {
  if (layout === 'pp') return ['decks', 'mix', 'fx', 'songs', 'player'];
  if (layout === 'tp') return ['mix', 'fx', 'songs', 'player'];
  return [];
}

/**
 * Compute the pixel budget for a layout.
 * @param {string} layout  one of LAYOUTS
 * @param {number} w  viewport width (CSS px)
 * @param {number} h  viewport height (CSS px)
 * @param {{t?:number,r?:number,b?:number,l?:number}} insets  safe-area insets (CSS px)
 * @param {{am?:boolean}} [opts]  am: the Auto Mix status strip row is shown (pp DECKS page, tp); its height
 *   comes out of the deck area (see automixPlacement)
 * @returns {object} sizes in CSS px plus flags; see cssVars() for the variables CSS reads
 */
export function computeSizes(layout, w, h, insets = {}, opts = {}) {
  const t = insets.t || 0;
  const r = insets.r || 0;
  const b = insets.b || 0;
  const l = insets.l || 0;
  const am = !!(opts && opts.am);
  const gl = Math.max(16, Math.round(l));
  const gr = Math.max(16, Math.round(r));
  const cw = Math.max(240, Math.floor(w - gl - gr));
  const ch = Math.max(240, Math.floor(h - t - b));
  let s;
  if (layout === 'pl') s = phoneLandscape(cw, ch);
  else if (layout === 'tp') s = tabletPortrait(cw, ch, am);
  else if (layout === 'console') s = consoleLayout(cw, ch);
  else s = phonePortrait(cw, ch, am);
  return { layout, gl, gr, cw, ch, amH: 0, fxRows: 0, ...s };
}

function phonePortrait(cw, ch, am) {
  const hdr = ch >= 640 ? 48 : 44;
  const waveO = ch >= 700 ? 18 : ch >= 520 ? 16 : 12;
  let waveZ = clamp(Math.round(44 + (ch - 560) * 0.1), 32, 72);
  const xf = ch >= 660 ? 76 : ch >= 540 ? 68 : 60;
  const tabs = ch >= 640 ? 56 : ch >= 540 ? 52 : 48;
  const tr = ch >= 720 ? 64 : ch >= 620 ? 56 : 52;
  const tempo = ch >= 620 ? 52 : ch >= 520 ? 48 : 44;
  const pad = 6;
  const gap = 6;
  const quickH = 44;
  const amH = am ? AM_STRIP_H : 0;
  const colW = Math.floor((cw - 8) / 2);
  let waves = 2 * (waveO + waveZ);
  let page = ch - hdr - waves - xf - tabs - amH;
  let room = page - 2 * pad - tr - tempo - 2 * gap;
  let P = Math.min(colW - 4, room);
  if (amH && P < AM_MIN_P) {
    // Auto Mix strip on a small phone: the zoomed waveform lanes give up to 2 x 12 px so the records stay usable
    const take = Math.min(2 * (waveZ - 32), 2 * Math.ceil((AM_MIN_P - P) / 2));
    if (take > 0) {
      waveZ -= take / 2;
      waves -= take;
      page += take;
      room += take;
      P = Math.min(colW - 4, room);
    }
  }
  let quick = false;
  if (P >= colW - 4) {
    // The platter fills its column; spend spare height on the quick row (PFL + filter), then on the waveforms.
    const need = quickH + gap;
    let spare = room - P;
    if (spare >= need) {
      quick = true;
      spare -= need;
    } else if (P - (need - spare) >= 150) {
      P -= need - spare;
      quick = true;
      spare = 0;
    }
    const grow = Math.max(0, Math.min(Math.floor((spare - 8) / 2), 96 - waveZ));
    if (grow > 0) {
      waveZ += grow;
      waves += 2 * grow;
      page -= 2 * grow;
      room -= 2 * grow;
    }
  }
  P = Math.max(96, Math.floor(P));
  return {
    hdr, waveO, waveZ, waves, xf, tabs, tr, tempo, page, P, quick, quickH, pad, gap, amH,
    deckW: colW, knob: 40, tempoFader: false, mixW: 0, fxH: 0, compact: ch < 520,
  };
}

function phoneLandscape(cw, ch) {
  const hdr = 44; // the header buttons stay 44 px touch targets
  const waveO = ch >= 340 ? 12 : 10;
  const waveZ = clamp(Math.round(ch * 0.11), 28, 48);
  const waves = 2 * (waveO + waveZ);
  const xf = ch >= 340 ? 56 : 48;
  const tr = ch >= 360 ? 56 : 48;
  const tempo = ch >= 360 ? 48 : 44;
  const gap = 6;
  const colGap = 8;
  const minCentre = 280;
  let P = Math.min(ch - tr - tempo - 2 * gap - 8, Math.floor((cw - minCentre - 2 * colGap) / 2));
  P = clamp(Math.floor(P), 110, 340);
  const deckW = Math.max(P, 150);
  const centre = cw - 2 * deckW - 2 * colGap;
  const mixH = ch - hdr - waves - xf - 3 * gap;
  const knob = clamp(Math.floor((mixH - gap) / 2), 36, 64);
  return {
    hdr, waveO, waveZ, waves, xf, tabs: 0, tr, tempo, page: mixH, P, quick: false, quickH: 0, pad: 4, gap,
    deckW, centre, knob, tempoFader: false, mixW: centre, fxH: 0, compact: ch < 320,
  };
}

function tabletPortrait(cw, ch, am) {
  const small = ch < 900; // small tablets, foldables, short desktop windows
  const hdr = small ? 48 : 56;
  const waveO = ch >= 1100 ? 20 : small ? 14 : 18;
  const waveZ = clamp(Math.round(ch * 0.07), small ? 44 : 52, 96);
  const waves = 2 * (waveO + waveZ);
  const tr = small ? 56 : 64;
  const tempo = small ? 48 : 52;
  const xf = small ? 64 : 72;
  const tabs = small ? 48 : 52;
  const gap = small ? 6 : 8;
  const fader = 56;
  const amH = am ? AM_STRIP_H : 0;
  const half = Math.floor((cw - 24) / 2);
  // 5 row gaps in the shell grid + 2 inside the deck (platter / transport / tempo) + the mixer's 2 x 2 px margin
  // (+ the Auto Mix strip row and its gap while Auto Mix is on)
  const fixed = hdr + waves + tr + tempo + xf + tabs + 7 * gap + 4 + (amH ? amH + gap : 0);
  const pageMin = small ? 184 : 216;
  let P = Math.min(half - fader - 8, ch - fixed - pageMin, 440);
  P = Math.max(140, Math.floor(P));
  const page = Math.max(0, ch - fixed - P);
  // mixer page: 2 x 2 knobs under the 44 px headphone button (10 px panel padding, 17 px knob labels)
  const knob = clamp(Math.floor((page - 20 - 44 - 6 - 4) / 2) - 17, 36, 64);
  return {
    hdr, waveO, waveZ, waves, xf, tabs, tr, tempo, page, P, quick: false, quickH: 0, pad: 0, gap, amH,
    deckW: half, knob, tempoFader: true, mixW: 0, fxH: 0, compact: small,
  };
}

/** Console FX row height for 2 or 3 rows of 44 px pads (6 px gaps, 6 / 8 px padding, 1 px border). */
export function consoleFxHeight(rows, compact) {
  if (rows >= 3) return compact ? 158 : 164;
  return compact ? 108 : 116;
}

function consoleLayout(cw0, ch) {
  const cw = Math.min(cw0, 1360);
  const compact = ch < 640;
  const hdr = compact ? 48 : 56;
  const waveO = compact ? 10 : ch >= 800 ? 20 : 16;
  const waveZ = compact ? clamp(Math.round(ch * 0.06), 30, 40) : clamp(Math.round(ch * 0.085), 44, 96);
  const waves = 2 * (waveO + waveZ);
  const gap = compact ? 8 : 10;
  const mixW = clamp(Math.round(cw * 0.3), 340, 420);
  const deckW = Math.floor((cw - mixW - 2 * gap) / 2);
  // FX row under each deck: two rows of 44 px pads, or three when the deck column is narrow (FX_TWO_ROW_MIN).
  // The crossfader panel between them shares the row (Auto Mix strip + crossfader).
  const fxInner = deckW - 2 * (compact ? 6 : 8) - 2;
  const fxRows = fxInner >= FX_TWO_ROW_MIN ? 2 : 3;
  const fxH = consoleFxHeight(fxRows, compact);
  const tr = compact ? 52 : 60;
  const tempo = compact ? 44 : 48;
  const main = ch - hdr - waves - fxH - 3 * gap;
  const natP = Math.floor(Math.min(deckW - 64, main - tr - tempo - 2 * gap, 400));
  const P = Math.max(CONSOLE_MIN_P, natP);
  // mixer: four knobs stacked under the 44 px headphone button (10 px panel padding, 4 px gaps, 17 px labels)
  const knob = clamp(Math.floor((main - 20 - 44 - 6 - 12) / 4) - 17, 30, 60);
  return {
    hdr, waveO, waveZ, waves, xf: fxH, tabs: 0, tr, tempo, page: main, P, natP, quick: false, quickH: 0, pad: 0, gap,
    deckW, knob, tempoFader: true, mixW, fxH, fxRows, fxInner, compact,
  };
}

/** CSS custom properties for a sizes object (values with units). */
export function cssVars(s) {
  const px = (v) => `${Math.round(v)}px`;
  return {
    '--gl': px(s.gl),
    '--gr': px(s.gr),
    '--hdr-h': px(s.hdr),
    '--wo': px(s.waveO),
    '--wz': px(s.waveZ),
    '--xf-h': px(s.xf),
    '--tabs-h': px(s.tabs),
    '--tr-h': px(s.tr),
    '--tempo-h': px(s.tempo),
    '--quick-h': px(s.quickH),
    '--P': px(s.P),
    '--deck-w': px(s.deckW),
    '--knob': px(s.knob),
    '--mix-w': px(s.mixW || 0),
    '--fx-h': px(s.fxH || 0),
    '--gap': px(s.gap),
    '--pad': px(s.pad),
    '--am-h': px(s.amH || 0),
  };
}

/** Total height the fixed rows of a layout need (used by tests and the diagnostics panel). */
export function stackHeight(s) {
  const amH = s.amH || 0;
  if (s.layout === 'pp') {
    const decks = 2 * s.pad + s.P + s.tr + s.tempo + 2 * s.gap + (s.quick ? s.quickH + s.gap : 0);
    return { total: s.hdr + s.waves + s.xf + s.tabs + amH + Math.max(decks, s.page), decks, page: s.page };
  }
  if (s.layout === 'pl') {
    const deckCol = s.P + s.tr + s.tempo + 2 * s.gap;
    const centre = s.hdr + s.waves + s.page + s.xf + 3 * s.gap;
    return { total: Math.max(deckCol, centre), decks: deckCol, page: s.page };
  }
  if (s.layout === 'tp') {
    const total = s.hdr + s.waves + s.P + s.tr + s.tempo + s.page + s.xf + s.tabs + 7 * s.gap + 4 + (amH ? amH + s.gap : 0);
    return { total, decks: s.P + s.tr + s.tempo + 2 * s.gap, page: s.page };
  }
  const deckCol = s.P + s.tr + s.tempo + 2 * s.gap;
  const total = s.hdr + s.waves + Math.max(deckCol, s.page) + s.fxH + 3 * s.gap;
  return { total, decks: deckCol, page: s.page };
}

/**
 * Which sections are shown for a layout, page and FX target. AppUI applies this with the `hidden` attribute;
 * CSS only places what is visible. The player page takes the whole screen between the header and the tab bar
 * on phones and tablets (pl: the header spans the width); on the console it is a drawer like the songs.
 * @returns {{decks:boolean, mixer:boolean, fxA:boolean, fxB:boolean, songs:boolean, player:boolean,
 *            waves:boolean, tabs:boolean, xf:boolean}}
 */
export function visibility(layout, page, fxDeck) {
  const p = effectivePage(layout, page);
  const fx = fxDeck === 'B' ? 'B' : 'A';
  if (layout === 'console') {
    return {
      decks: true, mixer: true, fxA: true, fxB: true, songs: p === 'songs', player: p === 'player', waves: true, tabs: false,
      xf: true,
    };
  }
  const pl = p === 'player';
  return {
    decks: !pl && (layout !== 'pp' || p === 'decks'),
    mixer: p === 'mix',
    fxA: p === 'fx' && fx === 'A',
    fxB: p === 'fx' && fx === 'B',
    songs: p === 'songs',
    player: pl,
    waves: !pl && (layout !== 'pl' || p === 'mix'),
    tabs: layout === 'pp' || layout === 'tp',
    xf: !pl,
  };
}

/**
 * Where the Auto Mix controls go in a layout.
 *   pp / tp: while Auto Mix is on, a status strip row (AM_STRIP_H) shows above the crossfader (pp: on the DECKS
 *            page only, so the MIX / FX pages keep their height; never on the player page, which shows it all).
 *            The AUTO switch sits in the tab bar: always on tablets; on phones only without a Player (with one,
 *            the PLAYER tab takes its place and Auto Mix is two taps away: PLAYER, then play or AUTO MIX).
 *   pl:      AUTO (with a Player: PLAYER) / MIX NOW pills over the left end of the waveforms.
 *   console: a status row with the AUTO switch inside the crossfader panel, always shown.
 * @param {{player?:boolean}} [opts]  player: a Player exists (the PLAYER tab is shown)
 * @returns {{where:'row'|'waves'|'xf', show:boolean, row:boolean, tabToggle:boolean}}
 *   show: the strip element is visible; row: it takes a row of the page stack (computeSizes opts.am).
 */
export function automixPlacement(layout, page, enabled, opts = {}) {
  const on = !!enabled;
  const player = !!(opts && opts.player);
  if (layout === 'console') return { where: 'xf', show: true, row: false, tabToggle: false };
  if (layout === 'pl') return { where: 'waves', show: true, row: false, tabToggle: false };
  const p = effectivePage(layout, page);
  const show = on && p !== 'player' && (layout !== 'pp' || p === 'decks');
  return { where: 'row', show, row: show, tabToggle: layout === 'tp' || !player };
}

// ---- Auto Mix strip: the mini transport ------------------------------------------------------------------------

/** Widths (CSS px) of the Auto Mix strip parts; css/app.css sizes the same parts with these numbers. */
export const STRIP = Object.freeze({
  pad: 14, gap: 6, btn: 38, btnGap: 2, mixNow: 76, toggle: 84, toggleMini: 44, infoMin: 90,
});

/**
 * The content width of the Auto Mix status strip for a sizes object (computeSizes), or 0 where the strip is a
 * pair of pills (pl) with no room for a transport.
 */
export function stripWidth(s) {
  if (!s) return 0;
  if (s.layout === 'pp' || s.layout === 'tp') return Math.max(0, s.cw - STRIP.pad - 2);
  if (s.layout === 'console') return Math.max(0, (s.mixW || 0) - 2 - 20 - 8);
  return 0;
}

/**
 * What fits in the strip next to the status text (which keeps at least STRIP.infoMin px): the mini transport
 * 'full' (previous / play-pause / next), 'compact' (play-pause / next) or 'none', and whether the AUTO switch
 * keeps its label (console) or shrinks to the bare switch. MIX NOW always keeps its place (no jump when a mix
 * starts). 360 x 560 phones (314 px) get the full transport.
 * @param {number} width  stripWidth()
 * @param {{toggle?:boolean}} [o]  toggle: the strip shows the AUTO switch (console)
 * @returns {{transport:'full'|'compact'|'none', toggleLabel:boolean, info:number}}
 */
export function stripFit(width, { toggle = false } = {}) {
  const W = Number.isFinite(width) ? width : 0;
  const tw = (n) => (n ? n * STRIP.btn + (n - 1) * STRIP.btnGap : 0);
  const tries = toggle ? [[true, 3], [false, 3], [false, 2], [false, 0]] : [[false, 3], [false, 2], [false, 0]];
  let last = null;
  for (const [label, n] of tries) {
    const parts = [tw(n), STRIP.mixNow, toggle ? (label ? STRIP.toggle : STRIP.toggleMini) : 0].filter((x) => x > 0);
    const info = W - parts.reduce((a, b) => a + b, 0) - parts.length * STRIP.gap;
    last = { transport: n === 3 ? 'full' : n === 2 ? 'compact' : 'none', toggleLabel: label, info: Math.max(0, Math.floor(info)) };
    if (info >= STRIP.infoMin) return last;
  }
  return last;
}

// ---- Player page --------------------------------------------------------------------------------------------

/**
 * Fixed heights (CSS px) inside the player page that css/app.css uses too: seek row, transport row (64 px play
 * button), options row (transition + volume), the inline transition chooser (two-column layouts), the title
 * block under a big cover, the head row (pl / console: title + close), the gap, and the room phones keep for the
 * Up next list under the fixed part. Two columns from TWO_COL_MIN px.
 */
export const PLAYER_GEOM = Object.freeze({
  seek: 46, transport: 68, opts: 44, chooser: 104, meta: 60, head: 44, gap: 8, pad: 8, listMin: 220, twoColMin: 640,
});

/** The player page's content box (CSS px) for a sizes object (computeSizes) in each layout. */
export function playerBox(s) {
  if (!s) return { w: 0, h: 0 };
  const G = PLAYER_GEOM;
  let w = s.cw;
  let h;
  if (s.layout === 'pp') h = s.ch - s.hdr - s.tabs - 2 * G.pad;
  else if (s.layout === 'tp') h = s.ch - s.hdr - s.tabs - 2 * s.gap - 2 * G.pad;
  else if (s.layout === 'pl') h = s.ch - s.hdr - s.gap - G.head - G.pad;
  else {
    // console: the bottom drawer (css: width min(100% - 32px, 980px), height min(66%, 640px), 14 / 18 px padding)
    const vw = s.cw + (s.gl || 0) + (s.gr || 0);
    w = Math.min(vw - 32, 980) - 36;
    h = Math.min(Math.round(s.ch * 0.66), 640) - 22 - G.head;
  }
  return { w: Math.max(0, Math.floor(w)), h: Math.max(0, Math.floor(h)) };
}

/**
 * How the player page arranges itself in a w x h box (playerBox):
 *   cols 1 (phones): now playing, seek, transport and the options row stay put; Up next / History scroll below
 *     and keep PLAYER_GEOM.listMin px. cols 2 (>= twoColMin px: tablets, phone landscape, the desktop drawer):
 *     now playing + transport + transition chooser + volume on the left (colW wide), the queue on the right.
 *   stack: a big cover with the title under it (when there is room for a >= 140 px cover), else a small cover
 *     beside the title (art 64..96 px).
 * @returns {{cols:1|2, colW:number, stack:boolean, art:number}}
 */
export function playerLayout(w, h) {
  const G = PLAYER_GEOM;
  const W = Number.isFinite(w) ? Math.max(0, w) : 0;
  const H = Number.isFinite(h) ? Math.max(0, h) : 0;
  const cols = W >= G.twoColMin ? 2 : 1;
  const colW = cols === 2 ? clamp(Math.round(W * 0.46), 300, 440) : W;
  const below = cols === 2
    ? G.seek + G.transport + G.chooser + G.opts + 4 * G.gap
    : G.seek + G.transport + G.opts + 4 * G.gap + G.listMin;
  const room = H - below - G.meta - G.gap;
  const big = Math.floor(Math.min(room, colW - 64, 280));
  const stack = big >= 140;
  const art = stack ? big : clamp(Math.round(H * 0.18), 64, 96);
  return { cols, colW, stack, art };
}
