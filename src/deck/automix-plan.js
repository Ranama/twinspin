// Auto Mix planner: pure functions that decide HOW one song is mixed into the next, from track data only (beat
// grid / beat map, waveform, duration, tempo). No DOM, no audio, no clock: src/deck/automix.js turns a plan into
// audio-clock events. Tested in tests/automix-plan.test.js.
//   const bounds = musicalBounds(track.waveform, track.duration);      // { start, end } of the music
//   const plan = planTransition(curInfo, nextInfo, settings);          // Transition (below)
//   crossfadeAt(0.5)  // 0: the crossfader position half way through a mix (S-curve from -1 to +1)
//
// Beats are counted from the track's first beat (index 0 = firstBeat, sync-math beatsAt; beat-map aware). A bar
// is 4 beats and a phrase 16 beats from the first beat (there is no downbeat detection, so that is the best
// guess). Track info objects: { bpm, firstBeat, beats?, duration, waveform?, rate?, bounds? } where `rate` is the
// current deck's playback rate (1 for the next song) and `bounds` overrides musicalBounds().
//
// Transition = {
//   mode: 'match' | 'meet' | 'cut',   multiplier: 0.5 | 1 | 2 (next-song beats per current-song beat),
//   beats,                            // mix length in current-song beats (0 = a timed blend, no beat grid)
//   fadeSec,                          // mix length in seconds at the planned tempo (display; the scheduler
//                                     // recomputes it from the live tempo)
//   out: { at, beat, beats },         // current song: track time (and beat index) where the mix starts
//   in: { at, beat },                 // next song: track time (and beat index, null without a grid) it starts at
//   tempo: { mode, multiplier, nextStartRate, curTargetRate, meetBpm, preRampBeats, returnSeconds },
//   bassSwap: boolean, bassSwapBeat,  // swap the low EQ at this beat of the mix (beats / 2)
//   echoOut: boolean,                 // 'cut' from a song with a beat grid: echo the old song out
//   late: boolean,                    // planned from opts.earliest (mix as soon as possible)
//   curBounds, nextBounds,            // musicalBounds() of both songs
// }
// Contract: docs/AUTOMIX.md section 4.4.

import { clamp } from '../core/util.js';
import { matchTempo, beatsAt, timeOfBeat } from './sync-math.js';

/** Mix lengths the user can pick (beats). */
export const MIX_LENGTHS = Object.freeze([16, 32, 64]);
/** Mix lengths tried for short songs, longest first. */
const FALLBACK_LENGTHS = Object.freeze([64, 32, 16, 8]);
export const BAR = 4;
export const PHRASE = 16;
/** Tempo gaps up to this match directly; up to MEET_MAX the tempos meet half way; beyond that: cut. */
export const MATCH_MAX = 0.04;
export const MEET_MAX = 0.2;
/** Beats over which the current song ramps toward the meet tempo before the mix. */
export const PRE_RAMP_BEATS = 16;
/** 'cut' transitions: an 8-beat blend (with a beat grid) or 6 s (without). */
export const CUT_BEATS = 8;
export const CUT_SECONDS = 6;
/** Songs without a beat grid mix out this long before their musical end. */
export const NO_BPM_OUT_SECONDS = 8;
/** A song plays at least this many beats after its in-point before it is mixed out. */
export const MIN_PLAY_BEATS = 16;

const EPS = 1e-6;

function hasGrid(t) {
  return !!t && t.bpm > 0;
}

function B(t, pos) {
  return beatsAt(pos, t.bpm, t.firstBeat || 0, t.beats);
}

function T(t, k) {
  return timeOfBeat(k, t.bpm, t.firstBeat || 0, t.beats);
}

function posMod(x, m) {
  return ((x % m) + m) % m;
}

/**
 * Where the music starts and ends: the first / last time the waveform's detail peak envelope (moving average
 * over ~0.5 s) exceeds -30 dB relative to the track's loud level (95th percentile of the envelope), refined to
 * the first / last raw peak above that level. Skips leading / trailing silence and fade tails. Without a
 * waveform: the whole track.
 * @param {{ detail?: { rate: number, peak: ArrayLike<number> } }|null} waveform
 * @param {number} duration seconds
 * @param {{ thresholdDb?: number, smoothSec?: number, percentile?: number }} [opts]
 * @returns {{ start: number, end: number }}
 */
export function musicalBounds(waveform, duration, opts = {}) {
  const dur = duration > 0 ? duration : 0;
  const full = { start: 0, end: dur };
  const d = waveform && waveform.detail;
  const peak = d && d.peak;
  const rate = d && d.rate;
  if (!peak || !(peak.length > 1) || !(rate > 0)) return full;
  const n = peak.length;
  const thresholdDb = Number.isFinite(opts.thresholdDb) ? opts.thresholdDb : -30;
  const smoothSec = opts.smoothSec > 0 ? opts.smoothSec : 0.5;
  const pct = opts.percentile > 0 && opts.percentile <= 1 ? opts.percentile : 0.95;

  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const v = peak[i];
    cum[i + 1] = cum[i] + (Number.isFinite(v) && v > 0 ? v : 0);
  }
  const win = Math.max(1, Math.round(smoothSec * rate));
  const half = win >> 1;
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i - half + win);
    env[i] = b > a ? (cum[b] - cum[a]) / (b - a) : 0;
  }
  const sorted = Float32Array.from(env).sort();
  const loud = sorted[Math.min(n - 1, Math.floor(pct * (n - 1)))];
  if (!(loud > 0)) return full;
  const thr = loud * Math.pow(10, thresholdDb / 20);
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (env[i] > thr) {
      first = i;
      break;
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    if (env[i] > thr) {
      last = i;
      break;
    }
  }
  if (first < 0 || last < first) return full;
  // the moving average smears edges by up to half a window: move to the first / last real peak above the level
  let s = first;
  while (s < last && !(peak[s] > thr)) s++;
  let e = last;
  while (e > s && !(peak[e] > thr)) e--;
  const start = clamp(s / rate, 0, dur);
  const end = clamp((e + 1) / rate, 0, dur);
  return end - start > 0.5 ? { start, end } : full;
}

/**
 * The next song's in-point: the first beat (map or grid) at or after bounds.start, rounded DOWN to a bar (4 beats
 * from firstBeat) when that bar is still >= bounds.start - 0.1 s; bounds.start for songs without a BPM.
 * @param {{ bpm?: number|null, firstBeat?: number, beats?: ArrayLike<number>|null, duration?: number }} track
 * @param {{ start: number, end: number }} [bounds]
 */
export function chooseInPoint(track, bounds) {
  const start = bounds && Number.isFinite(bounds.start) ? Math.max(0, bounds.start) : 0;
  if (!hasGrid(track)) return start;
  let k = Math.ceil(B(track, start) - EPS);
  const bar = Math.floor(k / BAR) * BAR;
  if (bar !== k) {
    const tb = T(track, bar);
    if (tb >= start - 0.1 - EPS && tb >= -EPS) k = bar;
  }
  let t = T(track, k);
  if (t < -EPS) t = T(track, Math.ceil(B(track, 0) - EPS));
  return Math.max(0, t);
}

/**
 * The current song's out-point: the track time where the mix starts so that `beats` (normally mixBeats) end at
 * or before bounds.end, snapped DOWN to a bar, preferring a 16-beat phrase boundary when one is within 8 beats.
 * Short songs get shorter mixes (64 -> 32 -> 16 -> 8 beats); the mix never starts before the in-point + 16 beats
 * (unless the song is shorter than that). No BPM: { at: bounds.end - 8 s, beats: 0 }.
 * @param {{ bpm?: number|null, firstBeat?: number, beats?: ArrayLike<number>|null, duration?: number }} track
 * @param {number} mixBeats
 * @param {{ start: number, end: number }} [bounds]
 * @returns {{ at: number, beats: number, beat: number|null }}
 */
export function chooseOutPoint(track, mixBeats, bounds) {
  const dur = track && track.duration > 0 ? track.duration : 0;
  const b = bounds || { start: 0, end: dur };
  if (!hasGrid(track)) {
    return { at: Math.max(0, b.start, b.end - NO_BPM_OUT_SECONDS), beats: 0, beat: null };
  }
  const want = mixBeats > 0 ? mixBeats : 32;
  const kIn = Math.round(B(track, chooseInPoint(track, b)));
  const minK = kIn + MIN_PLAY_BEATS;
  const kEnd = Math.floor(B(track, b.end) + EPS);
  const sizes = [want, ...FALLBACK_LENGTHS.filter((x) => x < want)];
  for (const beats of sizes) {
    const latest = kEnd - beats;
    const kBar = Math.floor(latest / BAR) * BAR;
    const kPhrase = Math.floor(latest / PHRASE) * PHRASE;
    const k = kBar - kPhrase <= 8 && kPhrase >= minK ? kPhrase : kBar;
    if (k >= minK) return { at: T(track, k), beats, beat: k };
  }
  // a very short song: mix out right after its minimum play time, or over whatever is left
  if (kEnd - minK >= 1) return { at: T(track, minK), beats: Math.min(CUT_BEATS, kEnd - minK), beat: minK };
  return { at: Math.max(0, T(track, kIn)), beats: clamp(kEnd - kIn, 1, CUT_BEATS), beat: kIn };
}

/**
 * Out-point for a mix that must start as soon as possible (MIX NOW, a missed mix point, a next song that was
 * late): the first bar at or after `earliest`, with the longest mix (mixBeats, 32, 16, 8) that still ends by
 * bounds.end (4 beats when even 8 do not fit). No BPM: { at: earliest, beats: 0 }.
 * @returns {{ at: number, beats: number, beat: number|null }}
 */
export function lateOutPoint(track, mixBeats, bounds, earliest) {
  const dur = track && track.duration > 0 ? track.duration : 0;
  const b = bounds || { start: 0, end: dur };
  const from = Math.max(0, Number.isFinite(earliest) ? earliest : 0);
  if (!hasGrid(track)) return { at: from, beats: 0, beat: null };
  const k = Math.ceil((B(track, from) - EPS) / BAR) * BAR;
  const kEnd = Math.floor(B(track, Math.max(b.end, from)) + EPS);
  const want = mixBeats > 0 ? mixBeats : 32;
  const sizes = [want, ...FALLBACK_LENGTHS.filter((x) => x < want)];
  let beats = BAR;
  for (const s of sizes) {
    if (k + s <= kEnd) {
      beats = s;
      break;
    }
  }
  return { at: T(track, k), beats, beat: k };
}

/**
 * How long the next song takes to ease back to its own tempo after the mix: about 1 % tempo per 8 beats,
 * 16..64 beats, in seconds at its start tempo. 0 when it already plays at rate 1.
 * @param {number} nextBpm
 * @param {number} startRate
 */
export function returnSeconds(nextBpm, startRate) {
  if (!(nextBpm > 0) || !(startRate > 0)) return 0;
  const pct = Math.abs(startRate - 1) * 100;
  if (pct < 0.01) return 0;
  const beats = clamp(pct * 8, 16, 64);
  return (beats * 60) / (nextBpm * startRate);
}

/**
 * The tempo side of a transition.
 *   |gap| <= 4 %: 'match' - the next song starts at the current song's tempo, the current one is unchanged.
 *   4 %..20 %: 'meet' - during the 16 beats before the mix the current song ramps half way (log space) toward
 *     the next song's tempo; the next song starts at that meet tempo. (opts.noPreRamp: no time for that, so
 *     the next song simply matches the current tempo: mode 'match'.)
 *   > 20 % or a BPM unknown: 'cut' - no beat matching, the next song starts at rate 1.
 * The gap is measured after picking half/double time (sync-math matchTempo).
 * @param {number|null} curEffBpm current song bpm * its rate
 * @param {number|null} nextBpm next song's original bpm
 * @param {{ curRate?: number, noPreRamp?: boolean, preRampBeats?: number }} [opts]
 * @returns {{ mode: 'match'|'meet'|'cut', multiplier: number, nextStartRate: number, curTargetRate: number,
 *   meetBpm: number|null, preRampBeats: number, returnSeconds: number }}
 */
export function planTempo(curEffBpm, nextBpm, opts = {}) {
  const curRate = opts.curRate > 0 ? opts.curRate : 1;
  const preRamp = opts.noPreRamp ? 0 : Number.isFinite(opts.preRampBeats) ? Math.max(0, opts.preRampBeats) : PRE_RAMP_BEATS;
  const cut = {
    mode: 'cut', multiplier: 1, nextStartRate: 1, curTargetRate: curRate, meetBpm: null, preRampBeats: 0, returnSeconds: 0,
  };
  if (!(curEffBpm > 0) || !(nextBpm > 0)) return cut;
  const { rate, multiplier } = matchTempo(nextBpm, curEffBpm);
  const gap = Math.abs(rate - 1);
  if (gap > MEET_MAX + 1e-9) return cut;
  if (gap <= MATCH_MAX + 1e-9 || preRamp <= 0) {
    return {
      mode: 'match', multiplier, nextStartRate: rate, curTargetRate: curRate, meetBpm: curEffBpm, preRampBeats: 0,
      returnSeconds: returnSeconds(nextBpm, rate),
    };
  }
  const meetBpm = Math.sqrt(curEffBpm * (nextBpm / multiplier)); // in current-song beats per minute
  const nextStartRate = (meetBpm * multiplier) / nextBpm;
  return {
    mode: 'meet', multiplier, nextStartRate, curTargetRate: (curRate * meetBpm) / curEffBpm, meetBpm,
    preRampBeats: preRamp, returnSeconds: returnSeconds(nextBpm, nextStartRate),
  };
}

/**
 * The crossfader position at `progress` 0..1 of a mix: an S-curve from `from` (-1 = deck A) to `to` (+1 = B).
 * With the mixer's constant-power law the middle is -3 dB on both decks.
 */
export function crossfadeAt(progress, from = -1, to = 1) {
  const p = clamp(Number.isFinite(progress) ? progress : 0, 0, 1);
  return from + ((to - from) * (1 - Math.cos(Math.PI * p))) / 2;
}

function readSetting(settings, key, fallback) {
  if (!settings) return fallback;
  try {
    const v = typeof settings.get === 'function' ? settings.get(key) : settings[key];
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * Plan the transition from the current song to the next one (pure, from track data).
 * @param {object} cur  { bpm, firstBeat, beats?, duration, waveform?, rate, bounds? } of the playing song
 * @param {object} next { bpm, firstBeat, beats?, duration, waveform?, bounds? } of the next song
 * @param {object} settings a Settings object or plain { mixBeats, automixReturn, automixBassSwap }
 * @param {{ earliest?: number, noPreRamp?: boolean }} [opts] earliest: the mix may not start before this
 *   track time of the current song (MIX NOW / late: start at the first bar from there, no pre-ramp)
 * @returns {object} Transition (see the header)
 */
export function planTransition(cur, next, settings, opts = {}) {
  const mb = Number(readSetting(settings, 'mixBeats', 32));
  const mixBeats = MIX_LENGTHS.includes(mb) ? mb : 32;
  const easeBack = readSetting(settings, 'automixReturn', true) !== false;
  const swapOn = readSetting(settings, 'automixBassSwap', true) !== false;
  const curRate = cur && cur.rate > 0 ? cur.rate : 1;
  const curBounds = (cur && cur.bounds) || musicalBounds(cur && cur.waveform, cur ? cur.duration : 0);
  const nextBounds = (next && next.bounds) || musicalBounds(next && next.waveform, next ? next.duration : 0);
  const late = Number.isFinite(opts.earliest);
  const curGrid = hasGrid(cur);
  const nextGrid = hasGrid(next);

  const tempo = planTempo(curGrid ? cur.bpm * curRate : null, nextGrid ? next.bpm : null, {
    curRate, noPreRamp: late || !!opts.noPreRamp,
  });
  const cut = tempo.mode === 'cut';
  const length = cut ? CUT_BEATS : mixBeats;
  const out = late ? lateOutPoint(cur, length, curBounds, opts.earliest) : chooseOutPoint(cur, length, curBounds);

  // in-point; for beat-matched mixes on a bar of the next song so the bars line up with the out-point's bar
  let inAt = chooseInPoint(next, nextBounds);
  let inBeat = null;
  if (nextGrid) {
    inBeat = Math.round(B(next, inAt));
    if (!cut) {
      const r = posMod(inBeat, BAR);
      if (r) {
        inBeat = T(next, inBeat - r) >= -EPS ? inBeat - r : inBeat + (BAR - r);
        inAt = Math.max(0, T(next, inBeat));
      }
    }
  }

  const beats = out.beats;
  let fadeSec = CUT_SECONDS;
  if (beats > 0 && curGrid && out.beat !== null) {
    fadeSec = (T(cur, out.beat + beats) - out.at) / (tempo.curTargetRate > 0 ? tempo.curTargetRate : curRate);
  }
  return {
    mode: tempo.mode,
    multiplier: tempo.multiplier,
    beats,
    fadeSec,
    out: { at: out.at, beat: out.beat, beats },
    in: { at: inAt, beat: inBeat },
    tempo: { ...tempo, returnSeconds: easeBack ? tempo.returnSeconds : 0 },
    bassSwap: swapOn && !cut && beats >= 8,
    bassSwapBeat: beats / 2,
    echoOut: cut && curGrid,
    late,
    curBounds,
    nextBounds,
  };
}
