// DOM helpers shared by the widgets: element factory, the floating value bubble and hold ring, canvas
// sizing for devicePixelRatio, resize observation, theme (CSS custom properties) reading and change
// notification. Browser-only, but nothing runs at import time: observers are created on first use.
//
//   const el = h('div', 'ts-fader ts-ctl', { role: 'slider' });
//   const bubble = new ValueBubble();  bubble.show(x, y, 'VOL', '0.80');  bubble.hide();
//   const { dpr, changed } = fitCanvas(canvas, 3);
//   const off = observeResize(canvas, () => view.resize());
//   const theme = readTheme(canvas);  const offTheme = onThemeChange(() => rebuildLayers());

import { clamp } from '../../core/util.js';
import { parseColor } from './color-math.js';

/** Create an element: h('button', 'cls a', { type: 'button', 'aria-label': 'Play' }, ['text' | Node]). */
export function h(tag, className, attrs, children) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (children) {
    for (const c of children) el.append(c);
  }
  return el;
}

/** Monotonic ms clock in the same timebase as event.timeStamp in current browsers. */
export const nowMs = () => (globalThis.performance ? performance.now() : Date.now());

/** Event time in the performance.now() timebase (old engines used epoch ms; fall back to now). */
export function eventTime(e) {
  const t = e && e.timeStamp;
  return t > 0 && t < 1e11 ? t : nowMs();
}

/** Coalesced pointer samples when supported (not Baseline, secure contexts only), else [e]. */
export function coalesced(e) {
  if (typeof e.getCoalescedEvents === 'function') {
    try {
      const list = e.getCoalescedEvents();
      if (list && list.length) return list;
    } catch {
      /* ignore */
    }
  }
  return [e];
}

export function capturePointer(el, id) {
  try {
    el.setPointerCapture(id);
  } catch {
    /* pointer already gone */
  }
}

export function releasePointer(el, id) {
  try {
    if (el.hasPointerCapture && el.hasPointerCapture(id)) el.releasePointerCapture(id);
  } catch {
    /* ignore */
  }
}

/** Primary-button check: touch/pen always, mouse only the left button. */
export const isPrimaryPress = (e) => e.pointerType !== 'mouse' || e.button === 0;

const preventDefault = (e) => e.preventDefault();

/** Block the long-press / right-click menu on a control. Returns an unbind function. */
export function preventContextMenu(el) {
  el.addEventListener('contextmenu', preventDefault);
  return () => el.removeEventListener('contextmenu', preventDefault);
}

function viewport() {
  const vv = globalThis.visualViewport;
  return {
    w: (vv && vv.width) || globalThis.innerWidth || 360,
    h: (vv && vv.height) || globalThis.innerHeight || 640,
  };
}

/**
 * The value bubble shown about 56 px above the finger while a slider is dragged (the finger hides the
 * control). Fixed-position in <body> so overflow:hidden parents cannot clip it; one per control so two
 * fingers on two faders each get their own.
 */
export class ValueBubble {
  constructor() {
    this.el = null;
    this._label = null;
    this._value = null;
    this._timer = 0;
    this._lastL = '';
    this._lastV = '';
  }

  _ensure() {
    if (this.el) return;
    this.el = h('div', 'ts-bubble', { 'aria-hidden': 'true' });
    this._label = h('span', 'ts-bubble__label');
    this._value = h('span', 'ts-bubble__value');
    this.el.append(h('div', 'ts-bubble__box', null, [this._label, this._value]));
    (document.body || document.documentElement).appendChild(this.el);
  }

  /** Show above client point (x, y). `fine` adds the FINE badge. */
  show(x, y, label, value, fine = false) {
    this._ensure();
    clearTimeout(this._timer);
    if (label !== this._lastL) this._label.textContent = this._lastL = label || '';
    if (value !== this._lastV) this._value.textContent = this._lastV = value;
    this.el.classList.toggle('is-fine', !!fine);
    const vp = viewport();
    const bx = clamp(x, 48, vp.w - 48);
    const above = y - 58 > 52;
    const by = above ? y - 58 : y + 58;
    this.el.classList.toggle('is-below', !above);
    this.el.style.transform = `translate3d(${Math.round(bx)}px, ${Math.round(by)}px, 0)`;
    this.el.classList.add('is-on');
  }

  /** Show above an element (keyboard / wheel input), hiding again after `ms`. */
  flash(el, label, value, ms = 900) {
    const r = el.getBoundingClientRect();
    this.show(r.left + r.width / 2, r.top + 4, label, value, false);
    this._timer = setTimeout(() => this.hide(), ms);
  }

  hide() {
    clearTimeout(this._timer);
    if (this.el) this.el.classList.remove('is-on');
  }

  destroy() {
    clearTimeout(this._timer);
    if (this.el) this.el.remove();
    this.el = null;
  }
}

/** Press-and-hold progress ring (needle lock), fixed-position above the finger. */
export class HoldRing {
  constructor(text = 'HOLD') {
    this.text = text;
    this.el = null;
    this._p = -1;
  }

  _ensure() {
    if (this.el) return;
    this.el = h('div', 'ts-holdring', { 'aria-hidden': 'true' },
      [h('span', 'ts-holdring__ring', null, [h('span', 'ts-holdring__text', null, [this.text])])]);
    (document.body || document.documentElement).appendChild(this.el);
  }

  show(x, y) {
    this._ensure();
    const vp = viewport();
    const above = y - 64 > 40;
    this.el.style.transform = `translate3d(${Math.round(clamp(x, 36, vp.w - 36))}px, ${Math.round(above ? y - 64 : y + 64)}px, 0)`;
    this.el.classList.add('is-on');
  }

  progress(p) {
    if (!this.el) return;
    const q = Math.round(clamp(p, 0, 1) * 100) / 100;
    if (q === this._p) return;
    this._p = q;
    this.el.style.setProperty('--p', String(q));
    this.el.classList.toggle('is-done', q >= 1);
  }

  hide() {
    if (!this.el) return;
    this.el.classList.remove('is-on', 'is-done');
    this._p = -1;
  }

  destroy() {
    if (this.el) this.el.remove();
    this.el = null;
  }
}

/**
 * Match a canvas backing store to its CSS size x devicePixelRatio (capped). Returns the CSS size, the
 * effective scale (backing px per CSS px) and whether the backing store changed (which clears it).
 */
export function fitCanvas(canvas, maxDpr = 3) {
  const w = canvas.clientWidth || 0;
  const hgt = canvas.clientHeight || 0;
  const dpr = clamp(globalThis.devicePixelRatio || 1, 1, maxDpr);
  // capped so a canvas without a CSS size (intrinsic sizing) can never grow without bound
  const bw = clamp(Math.round(w * dpr), 1, 4096);
  const bh = clamp(Math.round(hgt * dpr), 1, 4096);
  const changed = canvas.width !== bw || canvas.height !== bh;
  if (changed) {
    canvas.width = bw;
    canvas.height = bh;
  }
  return { w, h: hgt, dpr, bw, bh, sx: w > 0 ? bw / w : dpr, sy: hgt > 0 ? bh / hgt : dpr, changed };
}

/** Call `fn` when the element's size changes (ResizeObserver, else window resize). Returns unsubscribe. */
export function observeResize(el, fn) {
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => fn());
    ro.observe(el);
    return () => ro.disconnect();
  }
  const handler = () => fn();
  globalThis.addEventListener('resize', handler);
  return () => globalThis.removeEventListener('resize', handler);
}

// ---------------------------------------------------------------------------------------------------------
// Theme

const FALLBACK = {
  bg: '#0b0c12',
  panel: '#14151d',
  raised: '#1d1f2a',
  line: '#2b2e3c',
  text: '#f1f2f8',
  dim: '#a9aec0',
  faint: '#7c8296',
  deckA: '#3da5ff',
  deckB: '#ff8a2a',
  play: '#5be38a',
  cue: '#ffd447',
  warn: '#ff4d5e',
  focus: '#ffe36e',
};
const VARS = {
  bg: '--bg', panel: '--panel', raised: '--raised', line: '--line', text: '--text', dim: '--dim',
  faint: '--faint', deckA: '--deck-a', deckB: '--deck-b', play: '--play', cue: '--cue', warn: '--warn',
  focus: '--focus',
};

function mq(query) {
  try {
    return globalThis.matchMedia ? globalThis.matchMedia(query) : null;
  } catch {
    return null;
  }
}

/** True when the user asked for reduced motion. */
export function reducedMotion() {
  const m = mq('(prefers-reduced-motion: reduce)');
  return !!(m && m.matches);
}

/** True in the "Outdoor contrast" look (html[data-outdoor] / .outdoor) or with prefers-contrast: more. */
export function outdoorMode() {
  const root = document.documentElement;
  const v = root.getAttribute('data-outdoor');
  if (v !== null && v !== 'false' && v !== '0') return true;
  if (root.classList.contains('outdoor') || (document.body && document.body.classList.contains('outdoor'))) return true;
  const m = mq('(prefers-contrast: more)');
  return !!(m && m.matches);
}

/**
 * Colours ([r, g, b] plus the CSS string), fonts and flags for canvas drawing, read from the CSS custom
 * properties in effect at `el` (falls back to the contract palette).
 */
export function readTheme(el) {
  let cs = null;
  try {
    cs = getComputedStyle(el || document.documentElement);
  } catch {
    cs = null;
  }
  const t = { rgb: {}, css: {} };
  for (const k of Object.keys(VARS)) {
    const raw = cs ? cs.getPropertyValue(VARS[k]).trim() : '';
    const c = parseColor(raw) || parseColor(FALLBACK[k]);
    t.rgb[k] = c;
    t.css[k] = raw && parseColor(raw) ? raw : FALLBACK[k];
  }
  const fd = cs ? cs.getPropertyValue('--font-display').trim() : '';
  const fu = cs ? cs.getPropertyValue('--font-ui').trim() : '';
  t.fontDisplay = fd || "'Unbounded', 'Arial Black', system-ui, sans-serif";
  t.fontUi = fu || "'Barlow Condensed', 'Roboto Condensed', 'Arial Narrow', system-ui, sans-serif";
  t.outdoor = outdoorMode();
  t.reducedMotion = reducedMotion();
  t.key = Object.keys(VARS).map((k) => t.css[k]).join('|') + '|' + t.outdoor + '|' + t.fontDisplay + '|' +
    t.fontUi + '|' + fontEpoch;
  return t;
}

const themeListeners = new Set();
let themeWired = false;
let fontEpoch = 0;

function fontsChanged() {
  fontEpoch++;
  notifyTheme();
}

function notifyTheme() {
  for (const fn of [...themeListeners]) {
    try {
      fn();
    } catch (err) {
      console.error('[TwinSpin] theme listener failed', err);
    }
  }
}

function wireTheme() {
  if (themeWired) return;
  themeWired = true;
  try {
    if (typeof MutationObserver === 'function') {
      const mo = new MutationObserver((records) => {
        for (const r of records) {
          if (r.attributeName !== 'style') {
            notifyTheme();
            return;
          }
        }
      });
      mo.observe(document.documentElement, { attributes: true });
      if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-outdoor', 'data-theme'] });
    }
    for (const q of ['(prefers-reduced-motion: reduce)', '(prefers-contrast: more)', '(prefers-color-scheme: dark)']) {
      const m = mq(q);
      if (m && m.addEventListener) m.addEventListener('change', notifyTheme);
    }
    const fonts = document.fonts;
    if (fonts) {
      if (fonts.addEventListener) fonts.addEventListener('loadingdone', fontsChanged);
      if (fonts.ready && fonts.ready.then) fonts.ready.then(fontsChanged, () => {});
    }
  } catch {
    /* theme changes just will not be picked up live */
  }
}

/**
 * Notify when colours, fonts or motion preferences may have changed (attribute changes on <html>, media
 * query changes, web fonts finishing). Returns unsubscribe.
 */
export function onThemeChange(fn) {
  wireTheme();
  themeListeners.add(fn);
  return () => themeListeners.delete(fn);
}

/** Deck colour for 'A' / 'B' from a theme. */
export const deckRgb = (theme, deckId) => (deckId === 'B' ? theme.rgb.deckB : theme.rgb.deckA);

/** Offscreen canvas element of the given backing size (device px). */
export function makeCanvas(w, hgt) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(hgt));
  return c;
}
