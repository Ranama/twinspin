// Control curves: pure mappings from UI control values to audio parameters (no Web Audio, tested).
//   faderGain(0.7) -> 0.49         xfadeGains(0, 'smooth') -> [0.707, 0.707]
//   eqGain(-1) -> 0 (kill)         filterParams(-0.5) -> { lp: 1095, hp: 10, qDb: 3.5 }
//   tempoToRate(0.5, 0.08) -> 1.04 rateToTempo(1.04, 0.08) -> 0.5
//   xfadeSCurve(0.25) -> 0.146     mixCrossfader(-1, 1, 0.5) -> 0   (scheduled Auto Mix crossfades)

import { clamp, dbToGain } from '../core/util.js';

/** Channel fader 0..1 -> linear gain (v * v, an audio taper). */
export function faderGain(v) {
  const x = clamp(Number.isFinite(v) ? v : 0, 0, 1);
  return x * x;
}

/**
 * Crossfader x = -1 (deck A) .. +1 (deck B) -> [gainA, gainB].
 * 'smooth': constant power (gA^2 + gB^2 = 1). 'cut': both full across the middle, a sharp cut within the
 * last 6 % at either end (scratch curve).
 */
export function xfadeGains(x, curve = 'smooth') {
  const v = clamp(Number.isFinite(x) ? x : 0, -1, 1);
  if (curve === 'cut') {
    return [clamp((1 - v) / 0.12, 0, 1), clamp((1 + v) / 0.12, 0, 1)];
  }
  const a = ((v + 1) * Math.PI) / 4;
  let gA = Math.cos(a);
  let gB = Math.sin(a);
  if (v <= -1) gB = 0;
  if (v >= 1) gA = 0;
  return [gA, gB];
}

/** EQ knob -1..1 -> band gain: <= -0.98 kills (0), below centre (1+v)^2.5, above centre up to +6 dB. */
export function eqGain(v) {
  const x = clamp(Number.isFinite(v) ? v : 0, -1, 1);
  if (x <= -0.98) return 0;
  if (x < 0) return Math.pow(1 + x, 2.5);
  if (x > 0) return dbToGain(6 * x);
  return 1;
}

/**
 * Filter knob -1..1 -> { lp, hp, qDb }. Left = low-pass sweep 20 kHz -> 60 Hz, right = high-pass sweep
 * 20 Hz -> 8 kHz, centre dead zone (|v| < 0.04) = open. qDb is in dB (BiquadFilter LP/HP Q unit).
 */
export function filterParams(v) {
  const x = clamp(Number.isFinite(v) ? v : 0, -1, 1);
  if (Math.abs(x) < 0.04) return { lp: 22000, hp: 10, qDb: 0 };
  const qDb = 1 + 5 * Math.abs(x);
  if (x < 0) return { lp: 20000 * Math.pow(60 / 20000, -x), hp: 10, qDb };
  return { lp: 22000, hp: 20 * Math.pow(8000 / 20, x), qDb };
}

/** Tempo fader value -1..1 with a range (0.08 = +-8 %) -> playback rate. */
export function tempoToRate(value, range) {
  return 1 + (Number.isFinite(value) ? value : 0) * range;
}

/** Inverse of tempoToRate, clamped to -1..1. */
export function rateToTempo(rate, range) {
  if (!(range > 0) || !Number.isFinite(rate)) return 0;
  return clamp((rate - 1) / range, -1, 1);
}

/**
 * S-curve for a scheduled crossfade: progress 0..1 -> 0..1, raised cosine (0.5 - 0.5 cos(pi p)): it leaves
 * and reaches the ends gently and moves fastest through the middle. Clamped outside 0..1.
 */
export function xfadeSCurve(p) {
  const x = Number.isFinite(p) ? (p < 0 ? 0 : p > 1 ? 1 : p) : 0;
  return 0.5 - 0.5 * Math.cos(Math.PI * x);
}

/** Crossfader position at progress p (0..1) of a scheduled crossfade from `from` to `to` (S-curve). */
export function mixCrossfader(from, to, p) {
  return from + (to - from) * xfadeSCurve(p);
}
