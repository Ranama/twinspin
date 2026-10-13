// Tests for src/analysis/loudness.js: RMS / peak in dBFS and the auto-gain rule (90th percentile of 400 ms RMS
// windows to -13 dBFS RMS, boost capped so peakDb + gainDb <= +2 dB, clamped -12..+6 dB, silence-gated).
// Run: tools/JsCheck/jscheck run tests/loudness.test.js

import {
  measureLoudness, SILENCE_DB, TARGET_RMS_DB, PEAK_CEILING_DB, GAIN_MIN_DB, GAIN_MAX_DB,
} from '../src/analysis/loudness.js';

const SR = 11025;

function sine(freq, amp, seconds) {
  const n = Math.round(seconds * SR), y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return y;
}

function concat(...parts) {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const db = (g) => 20 * Math.log10(g);

test('constants', () => {
  assert.equal(TARGET_RMS_DB, -13);
  assert.equal(PEAK_CEILING_DB, 2);
  assert.equal(GAIN_MIN_DB, -12);
  assert.equal(GAIN_MAX_DB, 6);
});

test('full-scale sine: -3 dB RMS, 0 dB peak, gain -10 dB', () => {
  const r = measureLoudness(sine(441, 1, 3), SR);
  assert.closeTo(r.rmsDb, -3.01, 0.02);
  assert.closeTo(r.peakDb, 0, 0.05);
  assert.closeTo(r.gainDb, -13 + 3.01, 0.02);
});

test('quieter sine gets boosted to -13 dBFS RMS (peak stays under the ceiling)', () => {
  const r = measureLoudness(sine(220, 0.25, 3), SR);
  assert.closeTo(r.rmsDb, db(0.25 / Math.SQRT2), 0.02);
  assert.closeTo(r.gainDb, -13 - db(0.25 / Math.SQRT2), 0.02);
  assert(r.gainDb > 0);
  assert(r.peakDb + r.gainDb <= 2 + 1e-9, 'peak after gain <= +2 dB');
});

test('boost is capped so the peak ends at +2 dB at most', () => {
  // quiet body (sine at -26 dB RMS) with a few full-scale clicks: the RMS rule wants +13 dB, the peak allows +2
  const y = sine(200, 0.07, 6);
  for (let k = 1; k < 6; k++) y[k * SR] = 1;
  const r = measureLoudness(y, SR);
  assert.closeTo(r.peakDb, 0, 0.01);
  assert.closeTo(r.gainDb, 2, 1e-9, 'capped at +2 dB - peak');
  // a peak at -3 dBFS allows +5 dB
  const z = sine(200, 0.07, 6);
  for (let k = 1; k < 6; k++) z[k * SR] = Math.pow(10, -3 / 20);
  const r2 = measureLoudness(z, SR);
  assert.closeTo(r2.gainDb, 5, 1e-6);
  assert.closeTo(r2.peakDb + r2.gainDb, 2, 1e-6);
});

test('gain is clamped to -12..+6 dB', () => {
  const square = new Float32Array(SR * 2).map((_, i) => (i % 50 < 25 ? 1 : -1));
  assert.equal(measureLoudness(square, SR).gainDb, -12, 'loud square: -12 floor');
  // quiet sine: RMS rule +33 dB, peak cap +42 dB, ceiling +6
  assert.equal(measureLoudness(sine(300, 0.01, 2), SR).gainDb, 6, 'quiet: +6 ceiling');
  // a quiet song never gets more than +6 dB (the old rule gave +6.6 and drove the limiter)
  const r = measureLoudness(sine(300, 0.25, 2), SR);
  assert(r.gainDb <= 6);
});

test('the loud parts set the gain: 90th percentile, silence ignored', () => {
  // 85 % at -20 dB RMS-ish, 15 % at 0.5 amplitude: the 90th percentile window sits in the loud part
  const quiet = sine(330, 0.1 * Math.SQRT2, 17), loud = sine(330, 0.5, 3);
  const r = measureLoudness(concat(quiet, loud), SR);
  assert.closeTo(r.gainDb, -13 - db(0.5 / Math.SQRT2), 0.1);
  // long silence before the music does not change the gain or the RMS of the music
  const music = sine(330, 0.5, 4);
  const withSilence = measureLoudness(concat(new Float32Array(SR * 10), music), SR);
  const alone = measureLoudness(music, SR);
  assert.closeTo(withSilence.gainDb, alone.gainDb, 0.05);
  assert.closeTo(withSilence.rmsDb, alone.rmsDb, 0.5);
});

test('silence, empty and very short input', () => {
  const s = measureLoudness(new Float32Array(SR * 2), SR);
  assert.deepEqual(s, { rmsDb: SILENCE_DB, peakDb: SILENCE_DB, gainDb: 0 });
  assert.deepEqual(measureLoudness(new Float32Array(0), SR), { rmsDb: SILENCE_DB, peakDb: SILENCE_DB, gainDb: 0 });
  const short = measureLoudness(sine(441, 1, 0.2), SR);
  assert.closeTo(short.rmsDb, -3.01, 0.1, 'shorter than one window still measured');
  const nan = sine(441, 1, 1);
  nan[10] = NaN;
  const r = measureLoudness(nan, SR);
  assert(Number.isFinite(r.rmsDb) && Number.isFinite(r.gainDb), 'NaN ignored');
  assert.throws(() => measureLoudness(undefined, SR), TypeError);
  assert.throws(() => measureLoudness(new Float32Array(4), -1), TypeError);
});

test('works at other analysis rates (48 kHz / 4)', () => {
  const sr = 12000, n = sr * 2, y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = 0.5 * Math.sin((2 * Math.PI * 500 * i) / sr);
  const r = measureLoudness(y, sr);
  assert.closeTo(r.rmsDb, db(0.5 / Math.SQRT2), 0.02);
  assert.closeTo(r.gainDb, -13 - db(0.5 / Math.SQRT2), 0.02);
});
