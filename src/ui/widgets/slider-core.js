// SliderCore: the shared input engine behind Fader, Knob and TempoField. It turns pointer, keyboard and
// wheel input on one element into a value: RELATIVE drag (grab anywhere, no jump), 450 ms still press =
// fine mode x0.25, double-tap = reset, sticky detent with a haptic tick, value bubble above the finger,
// arrow keys / PageUp / Home / End / Delete, mouse wheel (Shift = fine), role=slider ARIA values, pointer
// capture, pointercancel / lostpointercapture handled as release, one tracked pointer per control (so two
// fingers can work two controls at once), contextmenu blocked.
//
//   const core = new SliderCore(el, { min: 0, max: 1, value: 0.8, axis: 'y', travel: () => railPx,
//     label: 'VOL', format: (v) => v.toFixed(2), onInput: (v) => deck.setVolume(v), render: (v) => paint(v) });
//   core.set(0.5);  core.value;  core.dragging;  core.setDisabled(true);  core.destroy();

import { clamp } from '../../core/util.js';
import { haptic } from '../../core/env.js';
import {
  RelativeDrag, isDoubleTap, keyAdjust, wheelPixels, wheelValueDelta, valueToFraction, fractionToValue,
  TAP_SLOP_PX, HOLD_MS, FINE_FACTOR, DOUBLE_TAP_MS,
} from './gesture-math.js';
import {
  ValueBubble, nowMs, capturePointer, releasePointer, isPrimaryPress, preventContextMenu,
} from './dom-util.js';

const noop = () => {};

export class SliderCore {
  /**
   * @param {HTMLElement} el  element receiving input (gets role=slider, tabindex, ARIA values)
   * @param {object} o
   * @param {number} [o.min=0] @param {number} [o.max=1] @param {number} [o.value] @param {number} [o.defaultValue]
   * @param {'x'|'y'|'xy'} [o.axis='y']  'y' = up increases, 'x' = right increases, 'xy' = dx - dy (knobs)
   * @param {number|function():number} [o.travel=200]  px for the full range
   * @param {number|null} [o.detent=null] @param {number} [o.detentWidth]  sticky zone (value units)
   * @param {number} [o.snapMin=0]  zone above min that snaps to min (EQ kill)
   * @param {boolean} [o.doubleTapReset=true]
   * @param {boolean} [o.absolute=false]  jump to the finger on press (needs o.rail)
   * @param {HTMLElement} [o.rail]  track element for absolute mode
   * @param {number|function():number} [o.step]  keyboard step (default 1 % of the range)
   * @param {string} [o.label] @param {function(number):string} [o.format]
   * @param {function(number):string} [o.bubbleText]  bubble value text (default format)
   * @param {function(number):void} [o.onInput] @param {function(number):void} [o.onRelease]
   * @param {function():void} [o.onReset]  replaces "set defaultValue + onInput" on double-tap / Delete
   * @param {function(number):void} [o.render]  paints the value
   * @param {'vertical'|'horizontal'} [o.orientation]  aria-orientation
   */
  constructor(el, o = {}) {
    this.el = el;
    this.min = o.min ?? 0;
    this.max = o.max ?? 1;
    this.defaultValue = o.defaultValue ?? o.value ?? this.min;
    this.axis = o.axis || 'y';
    this.travel = o.travel ?? 200;
    this.step = o.step ?? (this.max - this.min) / 100;
    this.label = o.label || '';
    this.format = o.format || ((v) => v.toFixed(2));
    this.bubbleText = o.bubbleText || null;
    this.onInput = o.onInput || noop;
    this.onRelease = o.onRelease || noop;
    this.onReset = o.onReset || null;
    this.paint = o.render || noop;
    this.doubleTapReset = o.doubleTapReset !== false;
    this.absolute = !!o.absolute;
    this.rail = o.rail || null;
    this.disabled = false;
    this.drag = new RelativeDrag({
      min: this.min,
      max: this.max,
      detent: o.detent ?? null,
      detentWidth: o.detentWidth ?? (this.max - this.min) * 0.02,
      snapMin: o.snapMin || 0,
      fineFactor: FINE_FACTOR,
    });
    this.bubble = new ValueBubble();
    this._value = clamp(Number.isFinite(o.value) ? o.value : this.defaultValue, this.min, this.max);
    this._pid = null;
    this._downT = 0;
    this._downX = 0;
    this._downY = 0;
    this._moved = 0;
    this._lastPx = 0;
    this._lastX = 0;
    this._lastY = 0;
    this._lastTap = null;
    this._holdTimer = 0;
    this._wheelTimer = 0;
    this._shiftFine = false;
    this._wasReset = false;

    el.classList.add('ts-ctl');
    el.setAttribute('role', 'slider');
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    el.setAttribute('aria-valuemin', String(this.min));
    el.setAttribute('aria-valuemax', String(this.max));
    if (o.orientation) el.setAttribute('aria-orientation', o.orientation);
    if (this.label) el.setAttribute('aria-label', this.label);

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onCancel = this._onCancel.bind(this);
    this._onKey = this._onKey.bind(this);
    this._onWheel = this._onWheel.bind(this);
    el.addEventListener('pointerdown', this._onDown);
    el.addEventListener('pointermove', this._onMove);
    el.addEventListener('pointerup', this._onUp);
    el.addEventListener('pointercancel', this._onCancel);
    el.addEventListener('lostpointercapture', this._onCancel);
    el.addEventListener('keydown', this._onKey);
    el.addEventListener('wheel', this._onWheel, { passive: false });
    this._offMenu = preventContextMenu(el);
    this._apply(this._value, false, true);
  }

  get value() {
    return this._value;
  }

  /** True while a pointer is dragging this control. */
  get dragging() {
    return this._pid !== null;
  }

  /**
   * Set the value from outside. Silent sets (the default) only repaint and are ignored while the user is
   * dragging, so a render loop can mirror model state without fighting the finger.
   */
  set(v, silent = true) {
    if (!Number.isFinite(v)) return;
    if (silent && this._pid !== null) return;
    const c = clamp(v, this.min, this.max);
    if (c === this._value) return;
    this._apply(c, !silent);
    if (this._pid !== null) {
      // a deliberate (non-silent) set during a drag: continue relative to the new value
      const fine = this.drag.fine;
      this.drag.begin(c, this._lastPx);
      this.drag.setFine(fine, this._lastPx);
    }
  }

  setDisabled(b) {
    this.disabled = !!b;
    this.el.classList.toggle('is-disabled', this.disabled);
    this.el.setAttribute('aria-disabled', this.disabled ? 'true' : 'false');
    if (this.disabled && this._pid !== null) this._end(true);
  }

  setLabel(label) {
    this.label = label || '';
    if (this.label) this.el.setAttribute('aria-label', this.label);
  }

  destroy() {
    if (this._pid !== null) this._end(true);
    clearTimeout(this._holdTimer);
    clearTimeout(this._wheelTimer);
    const el = this.el;
    el.removeEventListener('pointerdown', this._onDown);
    el.removeEventListener('pointermove', this._onMove);
    el.removeEventListener('pointerup', this._onUp);
    el.removeEventListener('pointercancel', this._onCancel);
    el.removeEventListener('lostpointercapture', this._onCancel);
    el.removeEventListener('keydown', this._onKey);
    el.removeEventListener('wheel', this._onWheel);
    this._offMenu();
    this.bubble.destroy();
  }

  // -------------------------------------------------------------------------------------------------------

  _travelPx() {
    const t = typeof this.travel === 'function' ? this.travel() : this.travel;
    return t > 8 ? t : 200;
  }

  _stepSize() {
    const s = typeof this.step === 'function' ? this.step() : this.step;
    return s > 0 ? s : (this.max - this.min) / 100;
  }

  _px(e) {
    if (this.axis === 'x') return e.clientX;
    if (this.axis === 'xy') return e.clientX - e.clientY;
    return -e.clientY;
  }

  _apply(v, notify, force = false) {
    if (!force && v === this._value) return;
    this._value = v;
    const el = this.el;
    el.setAttribute('aria-valuenow', String(Math.round(v * 1000) / 1000));
    el.setAttribute('aria-valuetext', this.format(v));
    this.paint(v);
    if (notify) this.onInput(v);
  }

  _bubbleValue() {
    return this.bubbleText ? this.bubbleText(this._value) : this.format(this._value);
  }

  _showBubble() {
    this.bubble.show(this._lastX, this._lastY, this.label, this._bubbleValue(), this.drag.fine);
  }

  _reset() {
    if (this.onReset) {
      this.onReset();
      this._apply(clamp(this.defaultValue, this.min, this.max), false);
    } else {
      this._apply(clamp(this.defaultValue, this.min, this.max), true);
    }
  }

  _absoluteValue(e, r) {
    const f = this.axis === 'x'
      ? (e.clientX - r.left) / (r.width || 1)
      : 1 - (e.clientY - r.top) / (r.height || 1);
    return fractionToValue(f, this.min, this.max);
  }

  _onDown(e) {
    if (this.disabled || this._pid !== null || !isPrimaryPress(e)) return;
    if (e.pointerType === 'mouse') {
      e.preventDefault(); // no text selection / native drag; keep keyboard focus on the control
      try {
        this.el.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }
    const t = nowMs();
    this._pid = e.pointerId;
    capturePointer(this.el, e.pointerId);
    this._downT = t;
    this._downX = this._lastX = e.clientX;
    this._downY = this._lastY = e.clientY;
    this._moved = 0;
    this._shiftFine = false;
    this._wasReset = false;
    if (this.doubleTapReset && isDoubleTap(this._lastTap, t, e.clientX, e.clientY)) {
      this._lastTap = null;
      this._wasReset = true;
      this._reset();
      haptic(10);
    }
    const px = this._px(e);
    this._lastPx = px;
    if (this.absolute && this.rail && !this._wasReset) {
      const rr = this.rail.getBoundingClientRect();
      const v = this._absoluteValue(e, rr);
      this.drag.travel = this.axis === 'x' ? rr.width : rr.height;
      this.drag.begin(v, px);
      this._apply(this.drag.value, true);
    } else {
      this.drag.travel = this._travelPx();
      this.drag.begin(this._value, px);
    }
    clearTimeout(this._holdTimer);
    const id = e.pointerId;
    this._holdTimer = setTimeout(() => {
      if (this._pid !== id || this._moved > TAP_SLOP_PX || this.drag.fine) return;
      this.drag.setFine(true, this._lastPx);
      haptic(6);
      this.el.classList.add('is-fine');
      this._showBubble();
    }, HOLD_MS);
    this.el.classList.add('is-dragging');
    this._showBubble();
  }

  _onMove(e) {
    if (e.pointerId !== this._pid) return;
    this._lastX = e.clientX;
    this._lastY = e.clientY;
    const d = Math.hypot(e.clientX - this._downX, e.clientY - this._downY);
    if (d > this._moved) this._moved = d;
    const px = this._px(e);
    this._lastPx = px;
    if (e.pointerType === 'mouse' && !!e.shiftKey !== this._shiftFine) {
      this._shiftFine = !!e.shiftKey;
      this.drag.setFine(this._shiftFine, px);
      this.el.classList.toggle('is-fine', this._shiftFine);
    }
    const v = this.drag.move(px);
    if (this.drag.entered) haptic(8);
    if (v !== this._value) this._apply(v, true);
    this._showBubble();
  }

  _onUp(e) {
    if (e.pointerId !== this._pid) return;
    const t = nowMs();
    const tap = this._moved <= TAP_SLOP_PX && t - this._downT < DOUBLE_TAP_MS && !this._wasReset;
    this._lastTap = tap ? { t, x: e.clientX, y: e.clientY } : null;
    this._end(false);
  }

  _onCancel(e) {
    if (e.pointerId !== this._pid) return;
    this._lastTap = null;
    this._end(true);
  }

  _end() {
    const id = this._pid;
    this._pid = null;
    clearTimeout(this._holdTimer);
    releasePointer(this.el, id);
    this.drag.fine = false;
    this.el.classList.remove('is-dragging', 'is-fine');
    this.bubble.hide();
    this.onRelease(this._value);
  }

  _onKey(e) {
    if (this.disabled || e.altKey || e.ctrlKey || e.metaKey) return;
    const reset = e.key === 'Delete' || e.key === 'Backspace';
    const v = keyAdjust(e.key, this._value, this.min, this.max, this._stepSize(), e.shiftKey, this.defaultValue);
    if (v === null) return;
    e.preventDefault();
    if (reset) {
      this._reset();
    } else if (v !== this._value) {
      this._apply(v, true);
    }
    this.onRelease(this._value);
    this.bubble.flash(this.el, this.label, this._bubbleValue());
  }

  _onWheel(e) {
    if (this.disabled) return;
    e.preventDefault();
    const dv = wheelValueDelta(wheelPixels(e.deltaX, e.deltaY, e.deltaMode), this.min, this.max, e.shiftKey);
    if (!dv || this._pid !== null) return;
    const v = clamp(this._value + dv, this.min, this.max);
    const snapped = this.drag.detent !== null && Math.abs(v - this.drag.detent) <= this.drag.detentWidth * 0.5
      ? this.drag.detent : v;
    if (snapped !== this._value) this._apply(snapped, true);
    this.bubble.flash(this.el, this.label, this._bubbleValue());
    clearTimeout(this._wheelTimer);
    this._wheelTimer = setTimeout(() => this.onRelease(this._value), 250);
  }
}

/** Fraction helper re-exported for widgets that paint from the value. */
export { valueToFraction };
