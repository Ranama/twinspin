// Tests for the beat map of src/analysis/bpm.js (BeatInfo.beats): deterministic synthetic drum tracks rendered
// at 11025 Hz with a tempo curve (constant, 0.5 % wobble, 120 -> 124 ramp, drumless intros). The true beat times
// come from integrating the tempo curve; every map beat must lie within 10 ms of them (2 ms of the constant grid
// for steady tracks), beats[0] is firstBeat, and the map covers the track to its end.
// Run: tools/JsCheck/jscheck run tests/beatmap.test.js   (set globalThis.BPM_VERBOSE = true to print details)

import { detectBeats, beatSteps } from '../src/analysis/bpm.js';

const SR = 11025;
const VERBOSE = !!globalThis.BPM_VERBOSE;

// ---------------------------------------------------------------------------------------------------------
// tiny deterministic synth (same one-shots as tests/bpm.test.js) with a tempo curve
// ---------------------------------------------------------------------------------------------------------

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function biq(type, f0, q, fs) {
  const w0 = (2 * Math.PI * f0) / fs, c = Math.cos(w0), s = Math.sin(w0), al = s / (2 * q);
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
  else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
  else { b0 = al; b1 = 0; b2 = -al; }
  const a0 = 1 + al;
  return [b0 / a0, b1 / a0, b2 / a0, (-2 * c) / a0, (1 - al) / a0];
}

function filt(x, co) {
  const [b0, b1, b2, a1, a2] = co;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i], yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi; x[i] = yi;
  }
  return x;
}

let shots = null;
function oneShots() {
  if (shots) return shots;
  const sr = SR, rnd = rng(7);
  const mk = (sec) => new Float32Array(Math.round(sec * sr));
  const noise = (sec) => { const n = mk(sec); for (let i = 0; i < n.length; i++) n[i] = rnd() * 2 - 1; return n; };
  const kick = mk(0.35);
  let ph = 0;
  for (let i = 0; i < kick.length; i++) {
    const t = i / sr, f = 45 + 110 * Math.exp(-t / 0.025);
    ph += (2 * Math.PI * f) / sr;
    kick[i] = Math.sin(ph) * Math.exp(-t / 0.18) + (t < 0.002 ? 0.3 * (rnd() * 2 - 1) : 0);
  }
  const sn = filt(noise(0.25), biq('bp', 2000, 0.7, sr)), snare = mk(0.25);
  for (let i = 0; i < snare.length; i++) {
    const t = i / sr;
    snare[i] = 0.5 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t / 0.05) + 1.2 * sn[i] * Math.exp(-t / 0.07);
  }
  const cn = filt(noise(0.2), biq('bp', 1200, 0.8, sr)), clap = mk(0.2);
  for (let i = 0; i < clap.length; i++) {
    const t = i / sr;
    let env = 0;
    for (const o of [0, 0.01, 0.02]) if (t >= o) env = Math.max(env, Math.exp(-(t - o) / 0.008));
    env = Math.max(env, 0.4 * Math.exp(-t / 0.08));
    clap[i] = 1.5 * cn[i] * env;
  }
  const hn = filt(filt(noise(0.3), biq('hp', 4000, 0.7, sr)), biq('hp', 4000, 0.7, sr));
  const hat = mk(0.06), ohat = mk(0.3);
  for (let i = 0; i < hat.length; i++) hat[i] = hn[i] * Math.exp(-i / sr / 0.015);
  for (let i = 0; i < ohat.length; i++) ohat[i] = hn[i] * Math.exp(-i / sr / 0.12);
  const bass = mk(0.22);
  for (let i = 0; i < bass.length; i++) {
    const t = i / sr, env = Math.min(1, t / 0.008) * Math.min(1, (0.22 - t) / 0.03);
    bass[i] = Math.sin(2 * Math.PI * 55 * t) * env;
  }
  shots = { kick, snare, clap, hat, ohat, bass };
  return shots;
}

const EIGHTHS = (g1, g2) => [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((p) => [p, 'hat', p % 1 ? g2 : g1]);
const HOUSE = [[0, 'kick', 1], [1, 'kick', 1], [2, 'kick', 1], [3, 'kick', 1], [1, 'clap', 0.6], [3, 'clap', 0.6],
  [0.5, 'ohat', 0.7], [1.5, 'ohat', 0.7], [2.5, 'ohat', 0.7], [3.5, 'ohat', 0.7],
  [0.25, 'hat', 0.25], [0.75, 'hat', 0.25], [1.25, 'hat', 0.25], [1.75, 'hat', 0.25],
  [2.25, 'hat', 0.25], [2.75, 'hat', 0.25], [3.25, 'hat', 0.25], [3.75, 'hat', 0.25]];
const PATTERNS = {
  house: HOUSE,
  houseBass: HOUSE.concat([[0.5, 'bass', 0.9], [1.5, 'bass', 0.9], [2.5, 'bass', 0.9], [3.5, 'bass', 0.9]]),
  dnb: [[0, 'kick', 1], [2.5, 'kick', 0.9], [1, 'snare', 0.9], [3, 'snare', 0.9]].concat(EIGHTHS(0.35, 0.3)),
  hiphop: [[0, 'kick', 1], [1.75, 'kick', 0.8], [2.5, 'kick', 0.9], [1, 'snare', 0.8], [3, 'snare', 0.8]]
    .concat(EIGHTHS(0.4, 0.3)),
};

/**
 * True beat times of a tempo curve: beat 0 at `start`, bpm(t) integrated with 1 ms steps (beats extend back
 * before `start` at the starting tempo, so hits before the first beat can be placed too).
 * tempo: { bpm, rampTo (linear over [start, dur]), wobblePct, wobblePeriod (s), stepAt (s), stepTo (bpm) }
 */
function beatTimes(o) {
  const bpmAt = (t) => {
    let b = o.rampTo ? o.bpm + (o.rampTo - o.bpm) * Math.min(1, Math.max(0, (t - o.start) / (o.dur - o.start))) : o.bpm;
    if (o.wobblePct) b *= 1 + (o.wobblePct / 100) * Math.sin((2 * Math.PI * (t - o.start)) / (o.wobblePeriod || 60));
    if (o.stepAt != null && t >= o.stepAt) b = o.stepTo;
    return b;
  };
  const out = [o.start];
  const dt = 0.001;
  let t = o.start, beats = 0;
  while (t < o.dur + 2) {
    const b0 = bpmAt(t), b1 = bpmAt(t + dt), inc = ((b0 + b1) / 2 / 60) * dt;
    if (Math.floor(beats + inc) > Math.floor(beats)) {
      const k = Math.floor(beats + inc);
      out.push(t + ((k - beats) / inc) * dt);
    }
    beats += inc;
    t += dt;
  }
  // index 0 = beat 0; also return the pre-start beats at the start tempo for completeness
  return out;
}

/**
 * Render a track; returns { y, truth (beat times >= 0 up to dur, beat 0 = start) }. o: tempo curve (see
 * beatTimes), pattern, start, dur, drumsFrom (s, no drums before), breaks ([[from, to]] s without drums), pad +
 * padFrom (sustained chords), humanizeMs, noiseDb, seed.
 */
function makeTrack(o) {
  o = Object.assign({ bpm: 128, pattern: 'house', start: 0.3, dur: 30, drumsFrom: 0, humanizeMs: 0, seed: 1,
    noiseDb: null }, o);
  const S = oneShots(), N = Math.floor(o.dur * SR), y = new Float32Array(N), pat = PATTERNS[o.pattern];
  const bt = beatTimes(o);
  const P0 = 60 / o.bpm;
  const timeOf = (b) => {
    if (b < 0) return o.start + b * P0;
    const k = Math.floor(b), f = b - k;
    if (k + 1 >= bt.length) return Infinity;
    return bt[k] + f * (bt[k + 1] - bt[k]);
  };
  const jit = rng(o.seed + 7), jitter = () => (o.humanizeMs * (jit() + jit() + jit() - 1.5)) / 500;
  for (let bar = 0; ; bar++) {
    const barT = timeOf(bar * 4);
    if (!(barT < o.dur)) break;
    for (const [pos, snd, g] of pat) {
      const t = timeOf(bar * 4 + pos) + (o.humanizeMs ? jitter() : 0);
      if (t < o.drumsFrom - 1e-9 || t >= o.dur) continue;
      if (o.breaks && o.breaks.some(([a, z]) => t >= a && t < z)) continue;
      const s0 = Math.max(0, Math.round(t * SR)), sm = S[snd], n = Math.min(sm.length, N - s0);
      for (let i = 0; i < n; i++) y[s0 + i] += g * sm[i];
    }
  }
  if (o.pad) {
    const P = 60 / o.bpm, chordLen = Math.round(8 * P * SR), freqs = [[220, 277.2, 329.6], [196, 246.9, 293.7]];
    for (let s0 = Math.round((o.padFrom || 0) * SR), ci = 0; s0 < N; s0 += chordLen, ci ^= 1) {
      const end = Math.min(N, s0 + chordLen), att = 0.6 * SR;
      for (const f of freqs[ci]) {
        const c = Math.cos((2 * Math.PI * f) / SR), s = Math.sin((2 * Math.PI * f) / SR);
        let re = 1, im = 0;
        for (let i = s0; i < end; i++) {
          const k = i - s0;
          y[i] += (k < att ? k / att : 1) * 0.12 * im;
          const t = re * c - im * s;
          im = re * s + im * c;
          re = t;
        }
      }
    }
  }
  if (o.noiseDb != null) {
    const g = Math.pow(10, o.noiseDb / 20), rnd = rng(o.seed + 99);
    for (let i = 0; i < N; i++) y[i] += g * (rnd() * 2 - 1);
  }
  // true beats inside the track (before `start`: extrapolated at the starting tempo)
  const truth = [];
  for (let k = -Math.floor(o.start / P0); ; k++) {
    const t = timeOf(k);
    if (!(t <= o.dur)) break;
    if (t >= 0) truth.push(t);
  }
  return { y, truth };
}

/** Distance (s) from t to the nearest time in a sorted array. */
function nearestDist(arr, t) {
  let lo = 0, hi = arr.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (arr[m] < t) lo = m;
    else hi = m;
  }
  return Math.min(Math.abs(arr[lo] - t), Math.abs(arr[hi] - t));
}

/**
 * Compare the map with the truth over [from, to] (s): every truth beat has a map beat within tol, and every map
 * beat a truth beat (no extra or missing beats). Returns the worst error (ms).
 */
function checkMap(name, r, truth, { tolMs, from = 0, to = Infinity }) {
  const b = r.beats;
  assert(b instanceof Float64Array, `${name}: beats is a Float64Array`);
  assert(b.length > 4, `${name}: beats present`);
  assert.equal(b[0], r.firstBeat, `${name}: beats[0] is firstBeat`);
  for (let k = 1; k < b.length; k++) assert(b[k] > b[k - 1], `${name}: beats increase`);
  let worst = 0, worstAt = 0;
  for (const t of truth) {
    if (t < from || t > to) continue;
    const e = nearestDist(b, t);
    if (e > worst) {
      worst = e;
      worstAt = t;
    }
  }
  for (const t of b) {
    if (t < from || t > to) continue;
    const e = nearestDist(truth, t);
    if (e > worst) {
      worst = e;
      worstAt = t;
    }
  }
  if (VERBOSE) {
    console.log(name, JSON.stringify({ bpm: r.bpm, variable: r.variable, conf: r.confidence, n: b.length,
      nTruth: truth.length, worstMs: +(worst * 1000).toFixed(2), worstAt: +worstAt.toFixed(2),
      dev: r.debug && r.debug.mapDev, map: r.debug && r.debug.map }));
  }
  assert(worst * 1000 <= tolMs, `${name}: worst beat error ${(worst * 1000).toFixed(2)} ms at ${worstAt.toFixed(2)} s`);
  // no beat lost or added anywhere: the map index of the beat nearest to each true beat keeps one offset
  const shift = new Set();
  for (let i = 0; i < truth.length; i++) {
    if (truth[i] < from || truth[i] > to) continue;
    let k = 0;
    while (k + 1 < b.length && Math.abs(b[k + 1] - truth[i]) < Math.abs(b[k] - truth[i])) k++;
    shift.add(k - i);
  }
  assert(shift.size <= 1, `${name}: beats lost or added (index shifts ${Array.from(shift)})`);
  return worst * 1000;
}

const opts = { debug: VERBOSE };

// ---------------------------------------------------------------------------------------------------------

test('constant house 128: the map is the constant grid (within 2 ms) and covers the whole track', () => {
  const { y, truth } = makeTrack({ bpm: 128, start: 0.11, dur: 30 });
  const r = detectBeats(y, SR, opts);
  assert.equal(r.variable, false);
  const P = 60 / r.bpm, b = r.beats;
  for (let k = 0; k < b.length; k++) {
    assert(Math.abs(b[k] - (r.firstBeat + k * P)) <= 0.002, `beat ${k} on the grid`);
  }
  assert(b[b.length - 1] <= 30 && b[b.length - 1] > 30 - P, 'map runs to the end of the track');
  assert(b[0] >= 0 && b[0] < P, 'first beat >= 0');
  checkMap('house128', r, truth, { tolMs: 6 });
});

test('constant DnB 174, hip-hop 88 and house with off-beat bass: map on the grid', () => {
  for (const [name, o] of [['dnb174', { bpm: 174, pattern: 'dnb', start: 0.4, dur: 20 }],
    ['hiphop88', { bpm: 88, pattern: 'hiphop', start: 0.25, dur: 24 }],
    ['bass126', { bpm: 126, pattern: 'houseBass', start: 0.42, dur: 24 }]]) {
    const { y, truth } = makeTrack(o);
    const r = detectBeats(y, SR, opts);
    assert.equal(r.variable, false, name + ' steady');
    const P = 60 / r.bpm;
    for (let k = 0; k < r.beats.length; k++) {
      assert(Math.abs(r.beats[k] - (r.firstBeat + k * P)) <= 0.002, `${name}: beat ${k} on the grid`);
    }
    checkMap(name, r, truth, { tolMs: 6 });
  }
});

test('10 ms humanize stays steady (the map does not chase random timing)', () => {
  const { y, truth } = makeTrack({ bpm: 126, start: 0.2, dur: 30, humanizeMs: 10, seed: 5 });
  const r = detectBeats(y, SR, opts);
  assert.equal(r.variable, false, 'steady');
  checkMap('humanize', r, truth, { tolMs: 8 });
});

test('0.5 % tempo wobble: variable, every map beat within 10 ms of the true beat', () => {
  const { y, truth } = makeTrack({ bpm: 124, wobblePct: 0.5, wobblePeriod: 60, start: 0.3, dur: 60 });
  const r = detectBeats(y, SR, opts);
  assert.equal(r.variable, true, 'variable');
  assert(Math.abs(r.bpm - 124) < 0.4, 'average bpm ' + r.bpm);
  checkMap('wobble', r, truth, { tolMs: 10 });
});

test('tempo ramp 120 -> 124: variable, every map beat within 10 ms of the true beat', () => {
  const { y, truth } = makeTrack({ bpm: 120, rampTo: 124, start: 0.2, dur: 30 });
  const r = detectBeats(y, SR, opts);
  assert.equal(r.variable, true, 'variable');
  assert(r.bpm > 120.5 && r.bpm < 123.5, 'average tempo ' + r.bpm);
  checkMap('ramp', r, truth, { tolMs: 10 });
});

test('steady track with a drumless intro: firstBeat stays on the grid extrapolation through the intro', () => {
  const { y, truth } = makeTrack({ bpm: 122, start: 2.2, drumsFrom: 8.2, pad: true, padFrom: 2.2, dur: 26 });
  const r = detectBeats(y, SR, opts);
  assert.equal(r.variable, false);
  const P = 60 / 122;
  assert(r.firstBeat < P, 'firstBeat is the first grid beat >= 0, not the drum entry');
  checkMap('intro', r, truth, { tolMs: 6 });
});

test('drifting track with a drumless intro: the map follows the drums, the intro is extrapolated', () => {
  const { y, truth } = makeTrack({ bpm: 120, rampTo: 124, start: 0.2, drumsFrom: 6, pad: true, padFrom: 0, dur: 36 });
  const r = detectBeats(y, SR, opts);
  assert.equal(r.variable, true, 'variable');
  // where the drums play the map is exact
  checkMap('rampIntro', r, truth, { tolMs: 10, from: 6.5 });
  // the intro has no beat to follow: the map continues backwards as a straight grid at the tempo of the first
  // drum bars (within 1 %), without a jump at the drum entry, down to the first beat >= 0
  const b = r.beats;
  let k6 = 0;
  while (b[k6] < 6) k6++;
  const Pin = b[k6 + 1] - b[k6];
  if (VERBOSE) {
    const iv = Array.from(b.slice(0, k6 + 6)).map((t, k) => (k ? ((t - b[k - 1]) * 1000).toFixed(1) : t.toFixed(3)));
    console.log('intro intervals (ms)', iv.join(' '));
  }
  for (let k = 1; k < k6 - 1; k++) {
    const iv = b[k] - b[k - 1];
    assert(Math.abs(iv - (b[k + 1] - b[k])) < 0.0015, `intro beat ${k}: straight grid`);
    assert(Math.abs(iv / Pin - 1) < 0.01, `intro beat ${k}: tempo of the first drum bars`);
  }
  assert(r.firstBeat >= 0 && r.firstBeat < Pin * 1.01, 'firstBeat = first map beat >= 0: ' + r.firstBeat);
  assert(Math.abs(nearestDist(truth, r.firstBeat)) < 0.1, 'intro extrapolation stays near the true beats');
});

test('steady track with a beatless breakdown (pads only): steady, the grid runs straight through it', () => {
  const { y, truth } = makeTrack({ bpm: 124, start: 0.4, dur: 48, breaks: [[18, 30]], pad: true, padFrom: 17 });
  const r = detectBeats(y, SR, opts);
  assert.equal(r.variable, false, 'steady');
  checkMap('breakdown', r, truth, { tolMs: 6 });
});

test('drifting track with a breakdown: the map bridges it without losing a beat and is exact again after it', () => {
  const { y, truth } = makeTrack({ bpm: 122, wobblePct: 0.5, wobblePeriod: 50, start: 0.3, dur: 60,
    breaks: [[24, 32]], pad: true, padFrom: 23 });
  const r = detectBeats(y, SR, opts);
  assert.equal(r.variable, true, 'variable');
  checkMap('wobbleBreak', r, truth, { tolMs: 10 });
});

test('abrupt tempo change (120 -> 127 at 16 s): variable, and the beats stay usable', () => {
  const { y, truth } = makeTrack({ bpm: 120, stepAt: 16, stepTo: 127, start: 0.2, dur: 34 });
  const r = detectBeats(y, SR, opts);
  assert(r.bpm > 118 && r.bpm < 129, 'bpm ' + r.bpm);
  assert.equal(r.variable, true, 'variable');
  const b = r.beats;
  assert(b instanceof Float64Array && b[0] === r.firstBeat && b[0] >= 0, 'map starts at firstBeat');
  for (let k = 1; k < b.length; k++) assert(b[k] - b[k - 1] > 0.4 && b[k] - b[k - 1] < 0.56, 'sane beat ' + k);
  assert(b[b.length - 1] > 33, 'covers the track');
  if (VERBOSE) {
    let worst = 0;
    for (const t of truth) worst = Math.max(worst, nearestDist(b, t));
    console.log('step: worst beat error (ms)', (worst * 1000).toFixed(1), 'map used', r.debug.mapDecides);
  }
});

test('generator form returns the same map; no-rhythm input has beats null', () => {
  const { y } = makeTrack({ bpm: 120, rampTo: 124, start: 0.2, dur: 20 });
  const a = detectBeats(y, SR);
  const it = beatSteps(y, SR);
  let s;
  while (!(s = it.next()).done);
  assert.deepEqual(Array.from(s.value.beats), Array.from(a.beats));
  const silent = detectBeats(new Float32Array(SR * 6), SR);
  assert.equal(silent.beats, null);
  const tiny = detectBeats(new Float32Array(100), SR);
  assert.equal(tiny.beats, null);
});

test('short steady track (under a few map windows) still gets a grid map', () => {
  const { y } = makeTrack({ bpm: 128, start: 0.05, dur: 7 });
  const r = detectBeats(y, SR, opts);
  assert(r.bpm !== null, 'bpm found');
  assert(r.beats instanceof Float64Array && r.beats.length >= 13, 'map present');
  assert.equal(r.beats[0], r.firstBeat);
});
