// Pure helpers for the Deck controller (src/deck/deck.js): tempo ranges, tap-tempo regression, beat loops,
// beat phase (beat-map aware), beat-map x2 / ½ and tempo-ramp kinematics. No DOM, no Web Audio; tested in
// tests/deck.test.js.
//   const fit = fitTaps([0.0, 0.5, 1.0, 1.5]);           // { period: 0.5, anchor: 0, count: 4 } -> 120 BPM
//   const { start, end } = loopBounds(31.2, 4, 128, 0.05, 240, true);
//   beatPhase(10.3, 120, 0.1)  // 0.4
//   travelTime({ rate: 1, bend: 0, ramp: { c0: 0, c1: 4, r0: 1, r1: 1.04 } }, 0, 10)  // s until 10 track-s pass

import { wrap } from '../core/util.js';
import { beatsAt, timeOfBeat, mapFirstIndex } from './sync-math.js';

/** Tempo fader ranges (fraction of the original tempo). */
export const TEMPO_RANGES = Object.freeze([0.08, 0.16, 0.5]);
/** Loop sizes the halve/double buttons may reach (beats). */
export const MIN_LOOP_BEATS = 1 / 32;
export const MAX_LOOP_BEATS = 64;
/** Track BPMs the deck accepts from x2, /2 and TAP. */
export const MIN_BPM = 30;
export const MAX_BPM = 300;

/** The nearest allowed tempo range for any number (0.08 when invalid). */
export function normalizeRange(r) {
  if (!(r > 0)) return TEMPO_RANGES[0];
  let best = TEMPO_RANGES[0];
  for (const x of TEMPO_RANGES) if (Math.abs(Math.log(x / r)) < Math.abs(Math.log(best / r))) best = x;
  return best;
}

/**
 * The tempo range to use so `rate` fits on the fader: the current range when it already fits, else the
 * smallest wider one (0.5 at most).
 */
export function rangeForRate(rate, current) {
  const need = Math.abs(rate - 1);
  if (need <= current + 1e-9) return current;
  for (const r of TEMPO_RANGES) if (r >= current && need <= r + 1e-9) return r;
  return TEMPO_RANGES[TEMPO_RANGES.length - 1];
}

/**
 * Fit a beat grid to tap times (or to the track positions at the taps) with least squares.
 * Taps far closer together than the typical gap (double taps) are ignored, and a gap of about two or three
 * typical gaps counts as missed taps, so one sloppy tap does not ruin the result.
 * @param {number[]} times increasing seconds
 * @returns {{ period: number, anchor: number, count: number } | null} anchor = fitted time of beat 0 (the
 *   first tap); null with fewer than 4 usable taps
 */
export function fitTaps(times) {
  if (!Array.isArray(times) || times.length < 4) return null;
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  const g = median(gaps.filter((x) => x > 0));
  if (!(g > 0)) return null;
  // beat index per tap
  const ts = [times[0]];
  const ks = [0];
  let k = 0;
  let last = times[0];
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - last;
    if (gap < 0.4 * g) continue; // double tap / bounce
    k += Math.max(1, Math.round(gap / g));
    ts.push(times[i]);
    ks.push(k);
    last = times[i];
  }
  const n = ts.length;
  if (n < 4) return null;
  let sk = 0;
  let st = 0;
  for (let i = 0; i < n; i++) {
    sk += ks[i];
    st += ts[i];
  }
  const mk = sk / n;
  const mt = st / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (ks[i] - mk) * (ts[i] - mt);
    den += (ks[i] - mk) * (ks[i] - mk);
  }
  if (!(den > 0)) return null;
  const period = num / den;
  if (!(period > 0)) return null;
  return { period, anchor: mt - period * mk, count: n };
}

function median(a) {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

/** The first grid beat at or after 0 s for a grid through `anchor` with `period`. */
export function gridStart(anchor, period) {
  if (!(period > 0) || !Number.isFinite(anchor)) return 0;
  const t = wrap(anchor, period);
  return t >= period - 1e-9 ? 0 : t;
}

/**
 * Where a beat loop goes. Quantised: it starts on the nearest grid beat; otherwise exactly at `pos`. Loops that
 * would run past the end are moved back (by whole beats when quantised). With a beat map (`map`) the beats and
 * the loop length follow the map.
 * @returns {{ start: number, end: number } | null} null when the loop cannot fit in the track
 */
export function loopBounds(pos, beats, bpm, firstBeat, duration, quantize, map) {
  if (!(bpm > 0) || !(beats > 0)) return null;
  if (map && map.length >= 2) return mapLoopBounds(pos, beats, bpm, firstBeat, duration, quantize, map);
  const P = 60 / bpm;
  const len = beats * P;
  const fb = Number.isFinite(firstBeat) ? firstBeat : 0;
  let start = Number.isFinite(pos) ? Math.max(0, pos) : 0;
  if (quantize) {
    start = fb + Math.round((start - fb) / P) * P;
    if (start < 0) start += Math.ceil(-start / P - 1e-9) * P;
  }
  if (duration > 0 && start + len > duration + 1e-9) {
    if (len > duration) return null;
    const over = start + len - duration;
    start -= quantize ? Math.ceil(over / P - 1e-9) * P : over;
    if (start < 0) start = quantize ? start + Math.ceil(-start / P - 1e-9) * P : 0;
    if (start + len > duration + 1e-9) start = Math.max(0, duration - len);
  }
  return { start, end: start + len };
}

/** loopBounds() on a beat map: works in beat-index space (sync-math beatsAt / timeOfBeat). */
function mapLoopBounds(pos, beats, bpm, firstBeat, duration, quantize, map) {
  const fb = Number.isFinite(firstBeat) ? firstBeat : 0;
  const B = (t) => beatsAt(t, bpm, fb, map);
  const T = (k) => timeOfBeat(k, bpm, fb, map);
  const dur = duration > 0 ? duration : Infinity;
  let k = B(Number.isFinite(pos) ? Math.max(0, pos) : 0);
  if (quantize) {
    k = Math.round(k);
    if (T(k) < -1e-9) k = Math.ceil(B(0) - 1e-9);
  }
  if (T(k + beats) > dur + 1e-9) {
    const kEnd = B(dur);
    k = quantize ? Math.floor(kEnd - beats + 1e-9) : kEnd - beats;
    if (T(k) < -1e-9) {
      if (!quantize) return null;
      k = Math.ceil(B(0) - 1e-9);
      if (T(k + beats) > dur + 1e-9) return null;
    }
  }
  const start = Math.max(0, T(k));
  const end = T(k + beats);
  return end > start ? { start, end } : null;
}

/**
 * Position inside the current beat, 0..1 (0 = on the beat), or null without a tempo. With a beat map the
 * phase follows the map (sync-math.js beatsAt).
 * @param {number} pos track seconds
 * @param {number|null} bpm
 * @param {number} firstBeat
 * @param {ArrayLike<number>|null} [beats] beat map
 */
export function beatPhase(pos, bpm, firstBeat, beats) {
  if (!(bpm > 0) || !Number.isFinite(pos)) return null;
  const x = beatsAt(pos, bpm, Number.isFinite(firstBeat) ? firstBeat : 0, beats);
  const f = x - Math.floor(x);
  return f >= 1 ? 0 : f;
}

/** Beat map for a doubled BPM: a beat half way between every two beats. */
export function doubleBeatMap(beats) {
  if (!beats || beats.length < 2) return null;
  const n = beats.length;
  const out = new Float64Array(2 * n - 1);
  for (let i = 0; i < n; i++) {
    out[2 * i] = beats[i];
    if (i < n - 1) out[2 * i + 1] = 0.5 * (beats[i] + beats[i + 1]);
  }
  return out;
}

/**
 * Beat map for a halved BPM: every other beat, keeping the beats whose grid index (sync-math beatsAt) is even
 * so beat 0 (firstBeat) stays a beat.
 * @param {ArrayLike<number>} beats
 * @param {number} bpm the bpm BEFORE halving
 * @param {number} firstBeat
 */
export function halveBeatMap(beats, bpm, firstBeat) {
  if (!beats || beats.length < 2 || !(bpm > 0)) return null;
  const k0 = mapFirstIndex(beats, firstBeat || 0);
  const start = ((k0 % 2) + 2) % 2 === 0 ? 0 : 1;
  const n = Math.floor((beats.length - start + 1) / 2);
  if (n < 2) return null;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = beats[start + 2 * i];
  return out;
}

// ---- tempo ramps -------------------------------------------------------------------------------------------
// A motion is { rate, bend, ramp } where ramp (optional) is { c0, c1, r0, r1 }: the rate goes linearly from r0
// at time c0 to r1 at time c1 (AudioContext seconds), staying r0 before and r1 after; `rate` is used when there
// is no ramp. Speed = rate + bend (track seconds per second).

/** The tempo rate at time t. */
export function rateAt(motion, t) {
  const r = motion.ramp;
  if (!r) return motion.rate;
  if (t <= r.c0 || !(r.c1 > r.c0)) return t <= r.c0 ? r.r0 : r.r1;
  if (t >= r.c1) return r.r1;
  return r.r0 + ((r.r1 - r.r0) * (t - r.c0)) / (r.c1 - r.c0);
}

/** Track distance covered between times a and b (b >= a). */
export function travelDistance(motion, a, b) {
  if (!(b > a)) return 0;
  const bend = motion.bend || 0;
  const r = motion.ramp;
  if (!r || !(r.c1 > r.c0)) return (rateAt(motion, a) + bend) * (b - a);
  let d = 0;
  let t = a;
  if (t < r.c0) {
    const e = Math.min(b, r.c0);
    d += (r.r0 + bend) * (e - t);
    t = e;
  }
  if (t < b && t < r.c1) {
    const e = Math.min(b, r.c1);
    d += 0.5 * (rateAt(motion, t) + rateAt(motion, e) + 2 * bend) * (e - t);
    t = e;
  }
  if (t < b) d += (r.r1 + bend) * (b - t);
  return d;
}

/**
 * Seconds after time a until `dist` track seconds are covered (dist >= 0), or Infinity when the motion never
 * gets there (speed <= 0).
 */
export function travelTime(motion, a, dist) {
  if (!(dist > 0)) return 0;
  const bend = motion.bend || 0;
  const r = motion.ramp;
  const constant = (speed, d) => (speed > 1e-9 ? d / speed : Infinity);
  if (!r || !(r.c1 > r.c0)) return constant(rateAt(motion, a) + bend, dist);
  let left = dist;
  let t = a;
  if (t < r.c0) {
    const seg = (r.r0 + bend) * (r.c0 - t);
    if (seg >= left) return t + constant(r.r0 + bend, left) - a;
    left -= seg;
    t = r.c0;
  }
  if (t < r.c1) {
    const s = rateAt(motion, t) + bend;
    const k = (r.r1 - r.r0) / (r.c1 - r.c0); // speed change per second
    const span = r.c1 - t;
    const seg = s * span + 0.5 * k * span * span;
    if (seg >= left) {
      let dt;
      if (Math.abs(k) < 1e-12) dt = constant(s, left);
      else {
        const disc = s * s + 2 * k * left;
        dt = disc < 0 ? Infinity : (2 * left) / (s + Math.sqrt(disc)); // stable form of (-s + sqrt(disc)) / k
      }
      return t + dt - a;
    }
    left -= seg;
    t = r.c1;
  }
  return t + constant(r.r1 + bend, left) - a;
}
