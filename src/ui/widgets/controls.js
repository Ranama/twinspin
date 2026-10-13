// Touch-first controls for TwinSpin: Fader, Knob (rotary or bar), bindPress (buttons), MeterView and
// TempoField. All sliders use SliderCore: relative drag (no jump), 450 ms still press = fine mode,
// double-tap reset, value bubble, detent tick, keyboard + wheel, ARIA, one pointer per control.
// Styles live in css/widgets.css (classes prefixed `ts-`). Set `--accent` on an ancestor (or add the class
// `ts-deck-a` / `ts-deck-b`) to colour a control for its deck.
//
//   const vol = new Fader(strip, { min: 0, max: 1, value: 0.8, label: 'Volume A', onInput: (v) => deck.setVolume(v) });
//   const hi = new Knob(cell, { label: 'HI', kill: true, bar: true, onInput: (v) => deck.setEq('high', v) });
//   const off = bindPress(playBtn, { onPress: () => deck.togglePlay() });       // timing: pointerdown
//   bindPress(loadBtn, { onActivate: () => input.click() });                       // user activation: click
//   const m = new MeterView(box);  m.set(meter.read().peak);                      // every frame
//   const tf = new TempoField(row, { deck });  tf.render();                       // every frame

import { clamp, fmtBpm, fmtPercent } from '../../core/util.js';
import { haptic } from '../../core/env.js';
import { SliderCore } from './slider-core.js';
import { valueToFraction, meterThresholds, meterLitCount, peakToDb, HOLD_MS } from './gesture-math.js';
import { h, nowMs, capturePointer, releasePointer, isPrimaryPress, preventContextMenu } from './dom-util.js';

const noop = () => {};
const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, String(attrs[k]));
  return el;
}

function addClasses(el, className) {
  if (!className) return;
  for (const c of String(className).split(/\s+/)) if (c) el.classList.add(c);
}

// ---------------------------------------------------------------------------------------------------------
// Fader

/**
 * Vertical or horizontal slider with relative drag. `detent` adds a sticky centre (or any value) with a
 * haptic tick; the fill grows from `fillFrom` (default: the detent, else min).
 * Extra options beyond the contract: showLabel (false), fillFrom, doubleTapReset (true; turn off for a
 * scratch crossfader), absolute (false; jump-to-finger for cut scratching), step, detentWidth, onReset.
 */
export class Fader {
  constructor(container, {
    orientation = 'vertical', min = 0, max = 1, value = 0, defaultValue = value, detent = null, label = '',
    format = (v) => v.toFixed(2), onInput = noop, onRelease, className, travel, showLabel = false,
    fillFrom, doubleTapReset = true, absolute = false, step, detentWidth, onReset, bubbleText,
  } = {}) {
    this.min = min;
    this.max = max;
    this.orientation = orientation === 'horizontal' ? 'horizontal' : 'vertical';
    const vert = this.orientation === 'vertical';
    this.el = h('div', `ts-fader ${vert ? 'ts-fader--v' : 'ts-fader--h'}`);
    addClasses(this.el, className);
    this.rail = h('div', 'ts-fader__rail');
    this.fill = h('div', 'ts-fader__fill');
    this.thumb = h('div', 'ts-fader__thumb', null, [h('span', 'ts-fader__grip')]);
    this.rail.append(h('div', 'ts-fader__track'), h('div', 'ts-fader__scale'), this.fill);
    if (detent !== null && detent !== undefined) {
      const mark = h('div', 'ts-fader__detent');
      mark.style.setProperty('--d', String(valueToFraction(detent, min, max)));
      this.rail.append(mark);
    }
    this.rail.append(this.thumb);
    this.el.append(this.rail);
    if (showLabel && label) {
      this.el.classList.add('has-label');
      this.el.append(h('span', 'ts-fader__label', null, [label]));
    }
    this._fillFrom = valueToFraction(fillFrom ?? detent ?? min, min, max);
    container.appendChild(this.el);

    this.core = new SliderCore(this.el, {
      min, max, value, defaultValue, detent, detentWidth, label, format, onInput, onRelease, onReset, bubbleText,
      doubleTapReset, absolute, step, rail: this.rail, orientation: this.orientation,
      axis: vert ? 'y' : 'x',
      travel: travel || (() => {
        const r = this.rail.getBoundingClientRect();
        return vert ? r.height : r.width;
      }),
      render: (v) => this._paint(v),
    });
  }

  _paint(v) {
    const f = valueToFraction(v, this.min, this.max);
    const ff = this._fillFrom;
    const s = this.el.style;
    s.setProperty('--v', f.toFixed(4));
    s.setProperty('--f0', Math.min(f, ff).toFixed(4));
    s.setProperty('--f1', Math.max(f, ff).toFixed(4));
  }

  get value() {
    return this.core.value;
  }

  /** Set the value; silent (default) only repaints and is ignored while the user drags. */
  set(v, { silent = true } = {}) {
    this.core.set(v, silent);
  }

  setDisabled(b) {
    this.core.setDisabled(b);
  }

  /** Jump-to-finger mode (useful for the crossfader with the 'cut' curve). */
  setAbsolute(b) {
    this.core.absolute = !!b;
  }

  setDoubleTapReset(b) {
    this.core.doubleTapReset = !!b;
  }

  destroy() {
    this.core.destroy();
    this.el.remove();
  }
}

// ---------------------------------------------------------------------------------------------------------
// Knob

const ARC_START = -135;
const ARC_END = 135;

function arcPoint(deg, r) {
  const a = (deg * Math.PI) / 180;
  return `${(50 + r * Math.sin(a)).toFixed(2)} ${(50 - r * Math.cos(a)).toFixed(2)}`;
}

function arcPath(d0, d1, r) {
  if (Math.abs(d1 - d0) < 0.01) return '';
  const a = Math.min(d0, d1);
  const b = Math.max(d0, d1);
  const large = b - a > 180 ? 1 : 0;
  return `M ${arcPoint(a, r)} A ${r} ${r} 0 ${large} 1 ${arcPoint(b, r)}`;
}

/**
 * Rotary knob (tablet/desktop) or compact bar slider (`bar: true`, phones). Vertical-or-horizontal drag
 * (dx - dy), 180 px = full range. Bipolar fill from the centre, 'KILL' state at min when `kill`, centre
 * dead-zone snap when `deadZone` (fraction of the range, e.g. 0.04 for the filter).
 */
export class Knob {
  constructor(container, {
    min = -1, max = 1, value = 0, defaultValue = 0, bipolar = true, kill = false, deadZone = 0, bar = false,
    label = '', size = 56, format, onInput = noop, onRelease, className, travel = 180, step, onReset,
  } = {}) {
    this.min = min;
    this.max = max;
    this.bipolar = bipolar;
    this.kill = kill;
    this.label = label;
    this.size = size;
    this.bar = !!bar;
    const range = max - min;
    this._centre = valueToFraction(bipolar ? defaultValue : min, min, max);
    this.el = h('div', 'ts-knob');
    addClasses(this.el, className);
    this.el.style.setProperty('--size', `${size}px`);
    this._build();
    container.appendChild(this.el);

    const fmt = format || (bipolar
      ? (v) => {
        const p = Math.round((v / (Math.max(Math.abs(min), Math.abs(max)) || 1)) * 100);
        return p === 0 ? '0' : (p > 0 ? '+' : '') + p;
      }
      : (v) => `${Math.round(valueToFraction(v, min, max) * 100)}%`);
    this._format = fmt;
    const detent = deadZone > 0 ? defaultValue : bipolar ? defaultValue : null;
    const detentWidth = deadZone > 0 ? deadZone * range : 0.015 * range;
    this.core = new SliderCore(this.el, {
      min, max, value, defaultValue, detent, detentWidth, snapMin: kill ? 0.02 * range : 0,
      axis: 'xy', travel, step: step ?? range / 50, label, onReset,
      format: (v) => (kill && v <= min ? 'KILL' : fmt(v)),
      onInput, onRelease,
      render: (v) => this._paint(v),
    });
    this._ro = null;
    this._observeAspect();
  }

  _build() {
    const el = this.el;
    el.textContent = '';
    el.classList.toggle('ts-knob--bar', this.bar);
    el.classList.toggle('ts-knob--rotary', !this.bar);
    this._valueEl = null;
    if (this.bar) {
      this._labelEl = h('span', 'ts-knob__label', null, [this.label]);
      this._valueEl = h('span', 'ts-knob__value');
      this._fillEl = h('span', 'ts-knob__fill');
      const track = h('span', 'ts-knob__bar', null, [this._fillEl, h('span', 'ts-knob__centre')]);
      if (!this.bipolar) track.classList.add('is-unipolar');
      el.append(h('span', 'ts-knob__head', null, [this._labelEl, this._valueEl]), track);
    } else {
      const s = svg('svg', { viewBox: '0 0 100 100', class: 'ts-knob__svg', 'aria-hidden': 'true' });
      s.append(svg('path', { class: 'ts-knob__track', d: arcPath(ARC_START, ARC_END, 41) }));
      this._arcEl = svg('path', { class: 'ts-knob__arc', d: '' });
      s.append(this._arcEl);
      s.append(svg('circle', { class: 'ts-knob__cap', cx: 50, cy: 50, r: 30 }));
      this._ptrEl = svg('g', { class: 'ts-knob__ptr' });
      this._ptrEl.append(svg('line', { x1: 50, y1: 26, x2: 50, y2: 40 }));
      s.append(this._ptrEl);
      if (this.bipolar) s.append(svg('circle', { class: 'ts-knob__tick', cx: 50, cy: 3.5, r: 2.4 }));
      this._labelEl = h('span', 'ts-knob__label', null, [this.label]);
      el.append(h('span', 'ts-knob__dial', null, [s]), this._labelEl);
    }
  }

  _observeAspect() {
    if (this._ro) this._ro.disconnect();
    this._ro = null;
    if (!this.bar || typeof ResizeObserver !== 'function') return;
    this._ro = new ResizeObserver(() => {
      const r = this.el.getBoundingClientRect();
      this.el.classList.toggle('is-tall', r.height > r.width * 1.25);
    });
    this._ro.observe(this.el);
  }

  _paint(v) {
    const f = valueToFraction(v, this.min, this.max);
    const killed = this.kill && v <= this.min;
    this.el.classList.toggle('is-kill', killed);
    this.el.classList.toggle('is-off', !killed && Math.abs(f - this._centre) < 0.001);
    if (this.bar) {
      const c = this._centre;
      const s = this.el.style;
      s.setProperty('--f0', Math.min(f, c).toFixed(4));
      s.setProperty('--f1', Math.max(f, c).toFixed(4));
      s.setProperty('--v', f.toFixed(4));
      const text = killed ? 'KILL' : this._format(v);
      if (this._valueEl.textContent !== text) this._valueEl.textContent = text;
    } else {
      const deg = ARC_START + f * (ARC_END - ARC_START);
      const from = ARC_START + this._centre * (ARC_END - ARC_START);
      this._arcEl.setAttribute('d', arcPath(from, deg, 41));
      this._ptrEl.setAttribute('transform', `rotate(${deg.toFixed(1)} 50 50)`);
      const text = killed ? 'KILL' : this.label;
      if (this._labelEl.textContent !== text) this._labelEl.textContent = text;
    }
  }

  get value() {
    return this.core.value;
  }

  set(v, { silent = true } = {}) {
    this.core.set(v, silent);
  }

  setDisabled(b) {
    this.core.setDisabled(b);
  }

  /** Switch between bar (phones) and rotary drawing in place (deferred while dragging). */
  setBar(b) {
    b = !!b;
    if (b === this.bar) return;
    if (this.core.dragging) {
      clearTimeout(this._barTimer);
      this._barTimer = setTimeout(() => this.setBar(b), 300);
      return;
    }
    this.bar = b;
    this._build();
    this._observeAspect();
    this._paint(this.core.value);
  }

  destroy() {
    clearTimeout(this._barTimer);
    if (this._ro) this._ro.disconnect();
    this.core.destroy();
    this.el.remove();
  }
}

// ---------------------------------------------------------------------------------------------------------
// bindPress

const NATIVE_ACTIVATE = new Set(['BUTTON', 'A', 'INPUT', 'LABEL', 'SUMMARY', 'SELECT', 'TEXTAREA']);

/**
 * Button behaviour for touch and mouse (pointer events), plus `click` for user activation.
 *  onPress(e)    pointerdown: timing-critical actions (PLAY, CUE, SYNC, pads)
 *  onRelease(e)  pointerup / pointercancel / lostpointercapture: CUE release, momentary pads
 *  onTap(e)      released before the hold time
 *  onHold(e)     still pressed after `holdMs` (a click right after a hold is swallowed)
 *  onActivate(e) click: carries user activation (file picker, AudioContext, fullscreen, setSinkId)
 * Adds .is-pressed while down, a haptic tick on press, blocks the long-press menu. Returns unbind().
 * Keyboard: a native <button> reaches onActivate through its own click. Pass `keys: true` to also run
 * onPress / onRelease / onTap / onHold from Enter and Space (off by default so callers that handle keys
 * themselves do not fire twice); with `keys` a non-native element (role=button) also gets onActivate.
 */
export function bindPress(el, {
  onPress, onRelease, onTap, onHold, onActivate, holdMs = HOLD_MS, haptics = true, keys = false,
} = {}) {
  let pid = null;
  let key = null;
  let held = false;
  let holdTimer = 0;
  let swallowClickUntil = 0;
  const call = (fn, e) => {
    if (!fn) return;
    try {
      fn(e);
    } catch (err) {
      console.error('[TwinSpin] button handler failed', err);
    }
  };
  const disabled = () => !!el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('is-disabled');
  const startHold = (e) => {
    held = false;
    clearTimeout(holdTimer);
    if (!onHold) return;
    holdTimer = setTimeout(() => {
      if (pid === null && key === null) return;
      held = true;
      swallowClickUntil = nowMs() + 800;
      if (haptics) haptic(12);
      call(onHold, e);
    }, holdMs);
  };
  const down = (e) => {
    if (pid !== null || key !== null || disabled() || !isPrimaryPress(e)) return;
    pid = e.pointerId;
    capturePointer(el, pid);
    el.classList.add('is-pressed');
    if (haptics) haptic(15);
    startHold(e);
    call(onPress, e);
  };
  const end = (e, cancelled) => {
    if (e.pointerId !== pid) return;
    const id = pid;
    pid = null;
    clearTimeout(holdTimer);
    releasePointer(el, id);
    el.classList.remove('is-pressed');
    call(onRelease, e);
    if (!cancelled && !held) call(onTap, e);
  };
  const up = (e) => end(e, false);
  const cancel = (e) => end(e, true);
  const click = (e) => {
    if (nowMs() < swallowClickUntil) {
      swallowClickUntil = 0;
      return;
    }
    if (disabled()) return;
    call(onActivate, e);
  };
  // Optional keyboard (keys: true): native buttons fire `click` themselves on Enter / Space (-> onActivate);
  // other elements get onActivate on Enter down / Space up. Press handlers run on key down / up.
  const pressHandlers = !!(onPress || onRelease || onTap || onHold);
  let spaceDown = false;
  const keydown = (e) => {
    if (e.repeat || disabled() || (e.key !== 'Enter' && e.key !== ' ')) return;
    const native = NATIVE_ACTIVATE.has(el.tagName);
    if (!native) {
      e.preventDefault();
      if (e.key === 'Enter') call(onActivate, e);
      else spaceDown = true;
    }
    if (!pressHandlers || pid !== null || key !== null) return;
    key = e.key;
    el.classList.add('is-pressed');
    startHold(e);
    call(onPress, e);
  };
  const keyup = (e) => {
    if (e.key === ' ' && spaceDown) {
      spaceDown = false;
      call(onActivate, e);
    }
    if (key === null || e.key !== key) return;
    key = null;
    clearTimeout(holdTimer);
    el.classList.remove('is-pressed');
    call(onRelease, e);
    if (!held) call(onTap, e);
  };
  const blur = (e) => {
    spaceDown = false;
    if (key === null) return;
    key = null;
    clearTimeout(holdTimer);
    el.classList.remove('is-pressed');
    call(onRelease, e);
  };
  el.classList.add('ts-press');
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('lostpointercapture', cancel);
  el.addEventListener('click', click);
  if (keys) {
    el.addEventListener('keydown', keydown);
    el.addEventListener('keyup', keyup);
    el.addEventListener('blur', blur);
  }
  const offMenu = preventContextMenu(el);
  return () => {
    clearTimeout(holdTimer);
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', cancel);
    el.removeEventListener('lostpointercapture', cancel);
    el.removeEventListener('click', click);
    el.removeEventListener('keydown', keydown);
    el.removeEventListener('keyup', keyup);
    el.removeEventListener('blur', blur);
    offMenu();
    el.classList.remove('is-pressed');
  };
}

// ---------------------------------------------------------------------------------------------------------
// MeterView

/**
 * Segment level meter (dB scale -36..0 dBFS, denser at the top): green, two yellow, red clip segment.
 * Instant attack, 24 dB/s release, 1 s peak hold. DOM is touched only when a segment changes.
 */
export class MeterView {
  constructor(container, { orientation = 'vertical', segments = 12, className } = {}) {
    const n = Math.max(2, segments | 0);
    this.el = h('div', `ts-meter ${orientation === 'horizontal' ? 'ts-meter--h' : 'ts-meter--v'}`, { 'aria-hidden': 'true' });
    addClasses(this.el, className);
    this._th = meterThresholds(n);
    this._segs = [];
    for (let i = 0; i < n; i++) {
      const zone = i === n - 1 ? 'is-clip' : i >= n - 3 ? 'is-hot' : 'is-ok';
      const s = h('span', `ts-meter__seg ${zone}`);
      this._segs.push(s);
      this.el.appendChild(s);
    }
    this._db = -90;
    this._t = 0;
    this._lit = 0;
    this._hold = -1;
    this._holdT = 0;
    container.appendChild(this.el);
  }

  /** Feed the current linear peak (0..1+), once per animation frame. */
  set(peak) {
    const now = nowMs();
    const dt = this._t ? clamp((now - this._t) / 1000, 0, 0.25) : 0;
    this._t = now;
    const db = peakToDb(Number.isFinite(peak) ? Math.abs(peak) : 0);
    this._db = Math.max(db, this._db - 24 * dt);
    const lit = meterLitCount(this._db, this._th);
    let hold = this._hold;
    if (lit - 1 >= hold) {
      hold = lit - 1;
      this._holdT = now;
    } else if (now - this._holdT > 1000) {
      hold = lit - 1;
      this._holdT = now;
    }
    if (lit === this._lit && hold === this._hold) return;
    for (let i = 0; i < this._segs.length; i++) {
      const on = i < lit;
      const pk = i === hold && i >= lit;
      const s = this._segs[i];
      if (s._on !== on) {
        s._on = on;
        s.classList.toggle('is-on', on);
      }
      if (s._pk !== pk) {
        s._pk = pk;
        s.classList.toggle('is-peak', pk);
      }
    }
    this._lit = lit;
    this._hold = hold;
  }

  destroy() {
    this.el.remove();
  }
}

// ---------------------------------------------------------------------------------------------------------
// TempoField

const NUDGE_BEND = 0.04;

/**
 * Tempo row: [ - ][ tempo % + effective BPM drag field ][ + ].
 * Field: relative horizontal drag, 300 px = full tempo range (deck.setTempo), centre detent, fine mode,
 * double-tap = deck.resetTempo(). Nudge buttons: hold = deck.setBend(-/+0.04), release = 0.
 * Call render() every frame; it only touches the DOM when the text changes.
 */
export class TempoField {
  constructor(container, { deck, className } = {}) {
    this.deck = deck;
    const id = (deck && deck.id) || '';
    this.el = h('div', 'ts-tempo');
    addClasses(this.el, className);
    this.minus = h('button', 'ts-nudge ts-nudge--minus', { type: 'button', 'aria-label': `Nudge deck ${id} slower` },
      [h('span', 'ts-nudge__glyph', { 'aria-hidden': 'true' }, ['−'])]);
    this.plus = h('button', 'ts-nudge ts-nudge--plus', { type: 'button', 'aria-label': `Nudge deck ${id} faster` },
      [h('span', 'ts-nudge__glyph', { 'aria-hidden': 'true' }, ['+'])]);
    this.pctEl = h('span', 'ts-tempo__pct', null, ['±0.0%']);
    this.bpmNum = h('span', 'ts-tempo__bpmnum', null, ['--.-']);
    this.bpmEl = h('span', 'ts-tempo__bpm', null, [this.bpmNum, h('span', 'ts-tempo__unit', null, ['BPM'])]);
    this.mark = h('span', 'ts-tempo__mark');
    this.field = h('div', 'ts-tempo__field', null, [
      this.pctEl, this.bpmEl, h('span', 'ts-tempo__scale', { 'aria-hidden': 'true' }, [h('span', 'ts-tempo__zero'), this.mark]),
    ]);
    this.el.append(this.minus, this.field, this.plus);
    container.appendChild(this.el);

    this._held = { '-1': false, 1: false };
    this._pct = '';
    this._bpm = '';
    this._flags = '';
    const range = () => (deck && deck.tempoRange > 0 ? deck.tempoRange : 0.08);
    this.core = new SliderCore(this.field, {
      min: -1, max: 1, value: deck && Number.isFinite(deck.tempo) ? deck.tempo : 0, defaultValue: 0,
      axis: 'x', travel: 300, detent: 0, detentWidth: 0.03, orientation: 'horizontal',
      step: () => 0.001 / range(),
      label: `Tempo deck ${id}`,
      format: (v) => fmtPercent(v * range()),
      bubbleText: (v) => {
        const bpm = deck && deck.bpm > 0 ? fmtBpm(deck.bpm * (1 + v * range())) : '--.-';
        return `${fmtPercent(v * range())}  ${bpm}`;
      },
      onInput: (v) => deck && deck.setTempo(v),
      onReset: () => deck && deck.resetTempo(),
      render: (v) => this.mark.style.setProperty('--v', ((v + 1) / 2).toFixed(4)),
    });
    this.core.label = 'TEMPO';
    this._offMinus = bindPress(this.minus, {
      onPress: () => this._nudge(-1, true),
      onRelease: () => this._nudge(-1, false),
    });
    this._offPlus = bindPress(this.plus, {
      onPress: () => this._nudge(1, true),
      onRelease: () => this._nudge(1, false),
    });
    this.render();
  }

  _nudge(dir, on) {
    this._held[dir] = on;
    const b = NUDGE_BEND * ((this._held[1] ? 1 : 0) - (this._held[-1] ? 1 : 0));
    this.el.classList.toggle('is-bending', b !== 0);
    if (this.deck) this.deck.setBend(b);
  }

  /** Mirror deck state (tempo value, rate %, effective BPM, sync). Cheap; call every frame. */
  render() {
    const d = this.deck;
    if (!d) return;
    if (Number.isFinite(d.tempo)) this.core.set(d.tempo, true);
    const rate = Number.isFinite(d.rate) && d.rate > 0 ? d.rate : 1;
    const pct = fmtPercent(rate - 1);
    if (pct !== this._pct) {
      this._pct = pct;
      this.pctEl.textContent = pct;
    }
    const bpm = fmtBpm(d.effectiveBpm);
    if (bpm !== this._bpm) {
      this._bpm = bpm;
      this.bpmNum.textContent = bpm;
      this.field.setAttribute('aria-valuetext', `${pct}, ${bpm} BPM`);
    }
    const flags = `${d.synced ? 1 : 0}${d.track ? 1 : 0}${Math.abs(rate - 1) < 0.0005 ? 1 : 0}`;
    if (flags !== this._flags) {
      this._flags = flags;
      this.el.classList.toggle('is-synced', !!d.synced);
      this.el.classList.toggle('has-track', !!d.track);
      this.el.classList.toggle('is-zero', flags[2] === '1');
    }
  }

  destroy() {
    if (this._held[1] || this._held[-1]) {
      this._held[1] = this._held[-1] = false;
      if (this.deck) this.deck.setBend(0);
    }
    this._offMinus();
    this._offPlus();
    this.core.destroy();
    this.el.remove();
  }
}
