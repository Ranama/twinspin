// Pure gesture and drawing math for the TwinSpin widgets. No DOM, no canvas, no audio, so the JsCheck
// runner can test all of it (tests/widgets-math.test.js). The DOM widgets (controls.js, platter.js,
// waveview.js) only translate pointer events into calls on these helpers.
//
//   const drag = new RelativeDrag({ min: 0, max: 1, travel: 180, detent: 0.5, detentWidth: 0.02 });
//   drag.begin(value, px);  value = drag.move(px);  if (drag.entered) haptic();  drag.setFine(true, px);
//   const turn = new AngleTracker(8);  turn.begin(a, r);  turn.update(a2, r2);  angleToSeconds(turn.total)
//   bendFromAngularVelocity(omega)  pxPerSecond(cssWidth, zoom)  firstBeatIndex(t0, bpm, firstBeat)
//   needleLockMode({ playing, audible })  ->  'tap' | 'hold'
//
// Angles: radians, 0 = 12 o'clock, positive = clockwise on screen (canvas y grows downward, so
// Math.atan2(dy, dx) already increases clockwise). Times: seconds of track time. Pixels: CSS px unless named.

import { clamp, wrap, gainToDb } from '../../core/util.js';

export const TAU = Math.PI * 2;
/** Seconds of audio per platter revolution (33 1/3 rpm). Mirrors DeckDSP.PLATTER_SECONDS_PER_TURN. */
export const SECONDS_PER_TURN = 1.8;
/** Long-press time (ms) without moving that switches a slider into fine mode. */
export const HOLD_MS = 450;
/** Fine-mode sensitivity multiplier. */
export const FINE_FACTOR = 0.25;
/** Movement (px) below which a press still counts as a tap / still press. */
export const TAP_SLOP_PX = 6;
/** Two taps closer than this (ms and px) form a double tap. */
export const DOUBLE_TAP_MS = 320;
export const DOUBLE_TAP_PX = 36;
/** Needle-lock hold time (ms) on the overview strip while the deck is audible. */
export const NEEDLE_HOLD_MS = 350;
/** Platter bend decays to 0 within this many ms after release. */
export const BEND_RELEASE_MS = 150;
/** Maximum platter / waveform nudge bend (fraction of speed). */
export const MAX_BEND = 0.12;
/** Waveform zoom range (settings.waveZoom: 1 = 6 s phone / 8 s tablet / 10 s desktop). */
export const ZOOM_MIN = 0.33;
export const ZOOM_MAX = 3;

// ---------------------------------------------------------------------------------------------------------
// Angles and the platter

/** Shortest signed difference `to - from`, wrapped into (-PI, PI]. */
export function angleDelta(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d <= -Math.PI) d += TAU;
  return d;
}

/** Screen angle of point (x, y) around (cx, cy): 0 = 3 o'clock, clockwise positive (atan2 in y-down space). */
export function pointAngle(x, y, cx, cy) {
  return Math.atan2(y - cy, x - cx);
}

/**
 * Accumulates (unwraps) the finger angle around the platter centre. Samples closer to the centre than
 * `minRadius` are ignored (the angle is unstable there); the next sample outside re-anchors without a jump.
 */
export class AngleTracker {
  constructor(minRadius = 0) {
    this.minRadius = minRadius;
    this.total = 0;
    this.last = 0;
    this.valid = false;
  }

  /** Start a gesture at `angle` (radius r). Resets the accumulated total. */
  begin(angle, r = Infinity) {
    this.total = 0;
    this.last = angle;
    this.valid = r >= this.minRadius;
  }

  /** Feed one sample; returns the delta (radians) it added to `total`. */
  update(angle, r = Infinity) {
    if (r < this.minRadius) {
      this.valid = false;
      return 0;
    }
    if (!this.valid) {
      this.last = angle;
      this.valid = true;
      return 0;
    }
    const d = angleDelta(this.last, angle);
    this.last = angle;
    this.total += d;
    return d;
  }
}

/** Platter rotation (radians) -> track seconds. */
export const angleToSeconds = (rad, secPerTurn = SECONDS_PER_TURN) => (rad / TAU) * secPerTurn;
/** Track seconds -> platter rotation (radians, unwrapped). */
export const secondsToAngle = (sec, secPerTurn = SECONDS_PER_TURN) => (sec / secPerTurn) * TAU;
/** Displayed platter angle for a track position, in [0, TAU). 0 puts the marker at 12 o'clock. */
export const platterAngle = (pos, secPerTurn = SECONDS_PER_TURN) =>
  wrap(secondsToAngle(Number.isFinite(pos) ? pos : 0, secPerTurn), TAU);

/**
 * Nudge bend from the finger's angular speed (rad/s): one revolution per 1.8 s (normal play speed) = 6 %,
 * clamped to +-12 % (contract 6.3).
 */
export function bendFromAngularVelocity(omega, secPerTurn = SECONDS_PER_TURN, gain = 0.06, max = MAX_BEND) {
  if (!Number.isFinite(omega)) return 0;
  return clamp((omega / (TAU / secPerTurn)) * gain, -max, max);
}

/** Linear release of a bend: `startBend` at 0 ms, exactly 0 from `durationMs` on. */
export function bendRelease(startBend, elapsedMs, durationMs = BEND_RELEASE_MS) {
  if (!(elapsedMs < durationMs)) return 0;
  if (elapsedMs <= 0) return startBend;
  return startBend * (1 - elapsedMs / durationMs);
}

/**
 * What a touch at distance `r` (CSS px) from the centre of a platter with radius `radius` does.
 * Returns 'outside' | 'scratch' | 'bend'. The outer nudge ring (30 % of the radius, at least 28 px) exists
 * only on platters >= 200 px; with vinyl off the whole disc bends.
 */
export function platterZone(r, radius, diameterCss, vinyl, ringFrac = 0.3, ringMinPx = 28, minRingDiameter = 200) {
  if (!(r <= radius * 1.06)) return 'outside';
  if (!vinyl) return 'bend';
  if (diameterCss >= minRingDiameter) {
    const ring = Math.max(radius * ringFrac, ringMinPx);
    if (r >= radius - ring) return 'bend';
  }
  return 'scratch';
}

/** Radius (fraction of the platter radius) where the nudge ring starts, or 0 when there is no ring. */
export function nudgeRingInner(radius, diameterCss, ringFrac = 0.3, ringMinPx = 28, minRingDiameter = 200) {
  if (!(diameterCss >= minRingDiameter) || !(radius > 0)) return 0;
  return clamp(1 - Math.max(radius * ringFrac, ringMinPx) / radius, 0, 1);
}

/** Track progress 0..1 (0 when the duration is unknown). */
export function progressFraction(pos, duration) {
  return duration > 0 && Number.isFinite(pos) ? clamp(pos / duration, 0, 1) : 0;
}

/** True inside the last `sec` seconds of a track (CDJ-style end warning). */
export function endWarning(pos, duration, sec = 30) {
  return duration > 0 && Number.isFinite(pos) && pos < duration && duration - pos <= sec;
}

// ---------------------------------------------------------------------------------------------------------
// Velocity

/**
 * Estimates the rate of change (units per second) of a sampled value over a short window. Times are ms.
 * Returns 0 once the newest sample is older than the window (the finger stopped).
 */
export class VelocityTracker {
  constructor(windowMs = 50, size = 32) {
    this.windowMs = windowMs;
    this.size = size;
    this.t = new Float64Array(size);
    this.v = new Float64Array(size);
    this.n = 0;
    this.head = 0;
  }

  reset() {
    this.n = 0;
    this.head = 0;
  }

  push(t, v) {
    if (this.n > 0) {
      const last = (this.head - 1 + this.size) % this.size;
      if (t < this.t[last]) t = this.t[last];
    }
    this.t[this.head] = t;
    this.v[this.head] = v;
    this.head = (this.head + 1) % this.size;
    if (this.n < this.size) this.n++;
  }

  /** Units per second over the window ending at the newest sample (or 0 when stale at `now`). */
  velocity(now) {
    if (this.n < 2) return 0;
    const newest = (this.head - 1 + this.size) % this.size;
    const tN = this.t[newest];
    if (now !== undefined && now - tN > this.windowMs) return 0;
    let oldest = newest;
    for (let i = 1; i < this.n; i++) {
      const idx = (newest - i + this.size) % this.size;
      oldest = idx;
      if (tN - this.t[idx] >= this.windowMs) break;
    }
    const dt = tN - this.t[oldest];
    if (!(dt > 0)) return 0;
    return ((this.v[newest] - this.v[oldest]) / dt) * 1000;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Sliders: relative drag, fine mode, detents

/** Snap `raw` to `detent` when within +-width, and to `min` when within `snapMin` of it (EQ kill). */
export function snapValue(raw, min, detent, detentWidth, snapMin = 0) {
  if (snapMin > 0 && raw - min <= snapMin) return min;
  if (detent !== null && detent !== undefined && Math.abs(raw - detent) <= detentWidth) return detent;
  return raw;
}

/**
 * Relative drag ("grab anywhere, no jump"): the value moves by deltaPx / travel * range (x 0.25 in fine
 * mode). Pushing past an end re-anchors there, so reversing responds immediately. The raw value is kept
 * apart from the snapped output, so a detent is a sticky zone the finger has to leave.
 */
export class RelativeDrag {
  constructor({ min = 0, max = 1, travel = 200, fineFactor = FINE_FACTOR, detent = null, detentWidth = 0,
    snapMin = 0 } = {}) {
    this.min = min;
    this.max = max;
    this.travel = travel;
    this.fineFactor = fineFactor;
    this.detent = detent;
    this.detentWidth = detentWidth;
    this.snapMin = snapMin;
    this.fine = false;
    this.raw = min;
    this.value = min;
    this.basePx = 0;
    this.baseRaw = min;
    /** 0 = free, 1 = kill snap at min, 2 = detent. */
    this.zone = 0;
    this.inDetent = false;
    /** True when the last move() entered the detent (or the kill snap) zone: tick a haptic. */
    this.entered = false;
  }

  _zoneOf(raw) {
    if (this.snapMin > 0 && raw - this.min <= this.snapMin) return 1;
    if (this.detent !== null && this.detent !== undefined && Math.abs(raw - this.detent) <= this.detentWidth) return 2;
    return 0;
  }

  begin(value, px) {
    const v = clamp(Number.isFinite(value) ? value : this.min, this.min, this.max);
    this.raw = v;
    this.baseRaw = v;
    this.basePx = px;
    this.fine = false;
    this.value = snapValue(v, this.min, this.detent, this.detentWidth, this.snapMin);
    this.zone = this._zoneOf(v);
    this.inDetent = this.zone !== 0;
    this.entered = false;
    return this.value;
  }

  /** Switch fine mode on/off at finger position `px` (re-anchors so the value does not jump). */
  setFine(on, px) {
    on = !!on;
    if (on === this.fine) return;
    this.baseRaw = this.raw;
    this.basePx = px;
    this.fine = on;
  }

  move(px) {
    const range = this.max - this.min;
    const scale = (range / (this.travel > 1 ? this.travel : 1)) * (this.fine ? this.fineFactor : 1);
    let raw = this.baseRaw + (px - this.basePx) * scale;
    if (raw > this.max) {
      raw = this.max;
      this.baseRaw = raw;
      this.basePx = px;
    } else if (raw < this.min) {
      raw = this.min;
      this.baseRaw = raw;
      this.basePx = px;
    }
    this.raw = raw;
    const out = snapValue(raw, this.min, this.detent, this.detentWidth, this.snapMin);
    const zone = this._zoneOf(raw);
    this.entered = zone !== 0 && zone !== this.zone;
    this.zone = zone;
    this.inDetent = zone !== 0;
    this.value = out;
    return out;
  }
}

/** Value -> 0..1 position along the control. */
export const valueToFraction = (v, min, max) => (max === min ? 0 : clamp((v - min) / (max - min), 0, 1));
/** 0..1 position -> value. */
export const fractionToValue = (f, min, max) => min + clamp(f, 0, 1) * (max - min);

/** Double-tap test: `prev` is { t, x, y } of the previous TAP (or null). */
export function isDoubleTap(prev, t, x, y, maxMs = DOUBLE_TAP_MS, maxPx = DOUBLE_TAP_PX) {
  if (!prev) return false;
  const dt = t - prev.t;
  return dt >= 0 && dt <= maxMs && Math.hypot(x - prev.x, y - prev.y) <= maxPx;
}

/** Fine mode starts when a press was held `holdMs` while moving no more than `slopPx`. */
export function shouldEnterFine(elapsedMs, movedPx, holdMs = HOLD_MS, slopPx = TAP_SLOP_PX) {
  return elapsedMs >= holdMs && movedPx <= slopPx;
}

/**
 * Keyboard adjustment for a slider. Returns the new (clamped) value, or null when the key is not handled.
 * Arrows: +-step (x 0.25 with Shift), PageUp/Down: +-10 steps, Home/End: min/max, Delete/Backspace: default.
 */
export function keyAdjust(key, value, min, max, step, shift = false, defaultValue = min) {
  const s = shift ? step * 0.25 : step;
  let v;
  switch (key) {
    case 'ArrowUp':
    case 'ArrowRight':
      v = value + s;
      break;
    case 'ArrowDown':
    case 'ArrowLeft':
      v = value - s;
      break;
    case 'PageUp':
      v = value + step * 10;
      break;
    case 'PageDown':
      v = value - step * 10;
      break;
    case 'Home':
      v = min;
      break;
    case 'End':
      v = max;
      break;
    case 'Delete':
    case 'Backspace':
      v = defaultValue;
      break;
    default:
      return null;
  }
  return clamp(v, min, max);
}

/**
 * Normalised wheel movement in px where positive = increase (wheel up). deltaMode 1 = lines, 2 = pages.
 * Uses the dominant axis so Shift+wheel (which browsers turn into deltaX) keeps working.
 */
export function wheelPixels(deltaX, deltaY, deltaMode = 0) {
  const k = deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1;
  const dx = (deltaX || 0) * k;
  const dy = (deltaY || 0) * k;
  return -(Math.abs(dy) >= Math.abs(dx) ? dy : dx);
}

/** Wheel px -> value change: 3 % of the range per 100 px notch (x 0.25 when fine). */
export function wheelValueDelta(px, min, max, fine = false) {
  return (px / 100) * (max - min) * 0.03 * (fine ? FINE_FACTOR : 1);
}

// ---------------------------------------------------------------------------------------------------------
// Meters

/** dB thresholds (ascending) for an n-segment meter: floorDb .. 0 dB, denser near the top. */
export function meterThresholds(n, floorDb = -36) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = n === 1 ? 0 : floorDb * Math.pow((n - 1 - i) / (n - 1), 1.5);
  }
  return out;
}

/** Number of lit segments for a level in dB. */
export function meterLitCount(db, thresholds) {
  let lit = 0;
  for (let i = 0; i < thresholds.length; i++) {
    if (db >= thresholds[i] - 1e-6) lit = i + 1;
    else break;
  }
  return lit;
}

/** Linear peak -> dB with a floor (no -Infinity). */
export function peakToDb(peak, floorDb = -90) {
  const db = gainToDb(peak > 0 ? peak : 0);
  return db > floorDb ? db : floorDb;
}

// ---------------------------------------------------------------------------------------------------------
// Waveforms

/** Seconds shown across the zoomed waveform at zoom 1, by canvas width (phone 6 / tablet 8 / desktop 10). */
export function baseVisibleSeconds(cssWidth) {
  return cssWidth < 600 ? 6 : cssWidth < 1000 ? 8 : 10;
}

export function clampZoom(z) {
  return clamp(Number.isFinite(z) && z > 0 ? z : 1, ZOOM_MIN, ZOOM_MAX);
}

export function visibleSeconds(cssWidth, zoom) {
  return baseVisibleSeconds(cssWidth) * clampZoom(zoom);
}

/** The ONE pixels-per-second shared by both decks' zoomed waveforms. */
export function pxPerSecond(cssWidth, zoom) {
  return cssWidth > 0 ? cssWidth / visibleSeconds(cssWidth, zoom) : 1;
}

/** Two-finger pinch: fingers apart -> fewer seconds visible (zoom in). */
export function pinchZoom(startZoom, startDist, dist) {
  return clampZoom(clampZoom(startZoom) * (Math.max(startDist, 1) / Math.max(dist, 1)));
}

/** +/- buttons: dir +1 zooms in (fewer seconds), -1 zooms out; snaps to 1 when passing near it. */
export function stepZoom(zoom, dir, factor = 1.5) {
  const z = clampZoom(clampZoom(zoom) * Math.pow(factor, -dir));
  return Math.abs(z - 1) < 0.08 ? 1 : z;
}

/** Wheel over a waveform: wheel down / pinch-out on trackpads zooms out. */
export function wheelZoom(zoom, deltaPx) {
  return clampZoom(clampZoom(zoom) * Math.exp(deltaPx * 0.0015));
}

export const timeToX = (t, centreT, centreX, pps) => centreX + (t - centreT) * pps;
export const xToTime = (x, centreT, centreX, pps) => centreT + (x - centreX) / pps;

/** Index of the first beat at or after `t0` (beat k sits at firstBeat + k * 60 / bpm; k may be negative). */
export function firstBeatIndex(t0, bpm, firstBeat) {
  const len = 60 / bpm;
  return Math.ceil((t0 - firstBeat) / len - 1e-9);
}

/** Bars are every `beatsPerBar` beats counted from the grid anchor (beat 0 is a downbeat). */
export const isBarIndex = (k, beatsPerBar = 4) => wrap(k, beatsPerBar) === 0;

/**
 * Beat ticks between t0 and t1 (inclusive) as [{ t, bar, index }]. For tests and sparse use; the
 * per-frame renderer loops with firstBeatIndex() instead of allocating.
 */
export function beatTicks(t0, t1, bpm, firstBeat, beatsPerBar = 4) {
  const out = [];
  if (!(bpm > 0) || !(t1 >= t0)) return out;
  const len = 60 / bpm;
  const fb = Number.isFinite(firstBeat) ? firstBeat : 0;
  for (let k = firstBeatIndex(t0, bpm, fb), guard = 0; guard < 100000; k++, guard++) {
    const t = fb + k * len;
    if (t > t1 + 1e-9) break;
    out.push({ t, bar: isBarIndex(k, beatsPerBar), index: k });
  }
  return out;
}

/** Which ticks are worth drawing at this zoom: 'all' | 'bars' | 'none'. */
export function tickDensity(pxPerBeat, beatsPerBar = 4) {
  if (pxPerBeat >= 5) return 'all';
  if (pxPerBeat * beatsPerBar >= 6) return 'bars';
  return 'none';
}

/**
 * Aggregates waveform bins for one pixel column covering track time [t0, t1). Wide columns take the max
 * peak and mean band shares; narrow columns (zoomed in past the data rate) interpolate linearly.
 * Writes { peak, low, high } into `out` (no allocation) and returns it.
 */
export function columnStats(peak, low, high, rate, t0, t1, out) {
  const n = peak.length;
  out.peak = 0;
  out.low = 0;
  out.high = 0;
  if (n === 0 || !(rate > 0) || t1 <= 0) return out;
  const f0 = t0 * rate;
  const f1 = t1 * rate;
  if (f1 - f0 < 1) {
    const f = (f0 + f1) * 0.5 - 0.5;
    if (f < -0.5 || f > n - 0.5) return out;
    const i = Math.floor(f);
    const a = f - i;
    const i0 = i < 0 ? 0 : i;
    const i1 = i + 1 >= n ? n - 1 : i + 1;
    out.peak = peak[i0] + (peak[i1] - peak[i0]) * a;
    if (low) out.low = low[i0] + (low[i1] - low[i0]) * a;
    if (high) out.high = high[i0] + (high[i1] - high[i0]) * a;
    return out;
  }
  let b0 = Math.floor(f0);
  let b1 = Math.ceil(f1);
  if (b0 < 0) b0 = 0;
  if (b1 > n) b1 = n;
  if (b1 <= b0) return out;
  let p = 0;
  let l = 0;
  let h = 0;
  for (let b = b0; b < b1; b++) {
    const v = peak[b];
    if (v > p) p = v;
    if (low) l += low[b];
    if (high) h += high[b];
  }
  const cnt = b1 - b0;
  out.peak = p;
  out.low = l / cnt;
  out.high = h / cnt;
  return out;
}

/** Paused-lane scrub: dragging the waveform right moves back in the track (paper follows the finger). */
export function scrubTarget(startPos, dxCss, ppsCss, duration) {
  const t = startPos - dxCss / (ppsCss > 0 ? ppsCss : 1);
  return clamp(t, 0, duration > 0 ? duration : 0);
}

/**
 * Playing-lane nudge: finger speed (CSS px/s) -> temporary bend. Pushing the waveform left (toward the
 * past) speeds the track up. `gear` 0.3 = the track moves 30 % as far as the finger dragged.
 */
export function nudgeBend(velPxPerSec, ppsCss, gear = 0.3, max = MAX_BEND) {
  if (!Number.isFinite(velPxPerSec) || !(ppsCss > 0)) return 0;
  return clamp((-velPxPerSec / ppsCss) * gear, -max, max);
}

// ---------------------------------------------------------------------------------------------------------
// Overview strip / needle lock

/** Needle lock: 'tap' seeks immediately (deck paused or not audible); 'hold' needs a 350 ms hold. */
export function needleLockMode(state) {
  return !state || !state.playing || !state.audible ? 'tap' : 'hold';
}

export const holdProgress = (elapsedMs, holdMs = NEEDLE_HOLD_MS) => clamp(elapsedMs / holdMs, 0, 1);

/** x (px from the strip's left edge) -> 0..1 track fraction. */
export const xToFraction = (x, width) => (width > 0 ? clamp(x / width, 0, 1) : 0);

// ---------------------------------------------------------------------------------------------------------
// Redraw skipping

/**
 * Per-frame change detector for canvas views: put() the values a frame depends on; `same` stays true when
 * none changed since the previous frame. No allocation.
 *   sig.begin(); sig.put(pos); sig.put(zoom); if (sig.same) return;
 */
export class ChangeSig {
  constructor(n = 32) {
    this.a = new Float64Array(n);
    this.a.fill(NaN);
    this.i = 0;
    this.same = true;
  }

  begin() {
    this.i = 0;
    this.same = true;
  }

  put(v) {
    const x = typeof v === 'number' ? (Number.isFinite(v) ? v : -7.25) : v ? 1 : v === null || v === undefined ? -3.5 : 0;
    if (this.i >= this.a.length) {
      this.same = false;
      return;
    }
    if (this.a[this.i] !== x) {
      this.a[this.i] = x;
      this.same = false;
    }
    this.i++;
  }

  /** Force the next frame to count as changed. */
  invalidate() {
    this.a[0] = NaN;
  }
}
