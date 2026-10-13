// Tests for src/analysis/bpm.js: deterministic synthetic drum tracks rendered at 11025 Hz (the analysis rate
// src/audio/pcm.js produces), 20-40 s each. Asserts |bpm error| <= 0.02, |firstBeat error| <= 6 ms (mod one
// beat), the right octave for house / DnB / hip-hop, snapping rules, and null for noise.
// Run: tools/JsCheck/jscheck run tests/bpm.test.js   (set globalThis.BPM_VERBOSE = true to print details)

import { detectBeats, beatSteps } from '../src/analysis/bpm.js';

const SR = 11025;
const VERBOSE = !!globalThis.BPM_VERBOSE;

// ---------------------------------------------------------------------------------------------------------
// tiny deterministic synth
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

const shotsCache = new Map();
function oneShots(sr = SR) {
  if (shotsCache.has(sr)) return shotsCache.get(sr);
  const rnd = rng(7);
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
  // hats: noise high-passed at 4 kHz (the analysis rate's Nyquist is 5.5 kHz)
  const hn = filt(filt(noise(0.3), biq('hp', 4000, 0.7, sr)), biq('hp', 4000, 0.7, sr));
  const hat = mk(0.06), ohat = mk(0.3);
  for (let i = 0; i < hat.length; i++) hat[i] = hn[i] * Math.exp(-i / sr / 0.015);
  for (let i = 0; i < ohat.length; i++) ohat[i] = hn[i] * Math.exp(-i / sr / 0.12);
  const bass = mk(0.22);
  for (let i = 0; i < bass.length; i++) {
    const t = i / sr, env = Math.min(1, t / 0.008) * Math.min(1, (0.22 - t) / 0.03);
    bass[i] = Math.sin(2 * Math.PI * 55 * t) * env;
  }
  // chord stab: A major-ish triad + octave (440-880 Hz), 3 ms attack, organ-like decay
  const stab = mk(0.25);
  for (let i = 0; i < stab.length; i++) {
    const t = i / sr, env = Math.min(1, t / 0.003) * Math.exp(-t / 0.12);
    stab[i] = 0.35 * env * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 554.37 * t) +
      Math.sin(2 * Math.PI * 659.26 * t) + 0.6 * Math.sin(2 * Math.PI * 880 * t));
  }
  const shots = { kick, snare, clap, hat, ohat, bass, stab };
  shotsCache.set(sr, shots);
  return shots;
}

const EIGHTHS = (g1, g2) => [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((p) => [p, 'hat', p % 1 ? g2 : g1]);
const HOUSE = [[0, 'kick', 1], [1, 'kick', 1], [2, 'kick', 1], [3, 'kick', 1], [1, 'clap', 0.6], [3, 'clap', 0.6],
  [0.5, 'ohat', 0.7], [1.5, 'ohat', 0.7], [2.5, 'ohat', 0.7], [3.5, 'ohat', 0.7],
  [0.25, 'hat', 0.25], [0.75, 'hat', 0.25], [1.25, 'hat', 0.25], [1.75, 'hat', 0.25],
  [2.25, 'hat', 0.25], [2.75, 'hat', 0.25], [3.25, 'hat', 0.25], [3.75, 'hat', 0.25]];
const PATTERNS = {
  house: HOUSE,
  houseStabs: HOUSE.concat([[0.5, 'stab', 1], [1.5, 'stab', 1], [2.5, 'stab', 1], [3.5, 'stab', 1]]),
  houseBass: HOUSE.concat([[0.5, 'bass', 0.9], [1.5, 'bass', 0.9], [2.5, 'bass', 0.9], [3.5, 'bass', 0.9]]),
  dnb: [[0, 'kick', 1], [2.5, 'kick', 0.9], [1, 'snare', 0.9], [3, 'snare', 0.9]].concat(EIGHTHS(0.35, 0.3)),
  hiphop: [[0, 'kick', 1], [1.75, 'kick', 0.8], [2.5, 'kick', 0.9], [1, 'snare', 0.8], [3, 'snare', 0.8]]
    .concat(EIGHTHS(0.4, 0.3)),
  none: [],
};

/**
 * Render a track. o: { sr, bpm, pattern, start (time of beat 0 = grid anchor), dur, drumsFrom (s, no drums
 * before), pad (sustained chords from padFrom), noiseDb (null = none), swing (0.5 straight), humanizeMs (sd
 * of a random per-hit timing offset), seed }
 */
function makeTrack(o) {
  o = Object.assign({ sr: SR, bpm: 128, pattern: 'house', start: 0.3, dur: 30, drumsFrom: 0, pad: false, padFrom: 0,
    noiseDb: null, swing: 0.5, humanizeMs: 0, seed: 1 }, o);
  const sr = o.sr, S = oneShots(sr), N = Math.floor(o.dur * sr), y = new Float32Array(N), pat = PATTERNS[o.pattern];
  const P = 60 / o.bpm;
  // optional linear tempo ramp: the beat period changes linearly with the beat index
  const dP = o.rampTo ? (60 / o.rampTo - P) / (o.dur / P) : 0;
  // optional humanize: every hit moves by a seeded, roughly Gaussian offset (sum of 3 uniforms, sd humanizeMs)
  const jit = rng(o.seed + 7), jitter = () => (o.humanizeMs * (jit() + jit() + jit() - 1.5)) / 500;
  const beatTime = (b) => o.start + P * b + 0.5 * dP * b * b;
  for (let bar = 0; ; bar++) {
    const barT = beatTime(bar * 4);
    if (barT > o.dur) break;
    for (const [pos, snd, g] of pat) {
      const sw = pos % 1 === 0.5 ? Math.floor(pos) + o.swing : pos;
      const t = beatTime(bar * 4 + sw) + (o.humanizeMs ? jitter() : 0);
      if (t < o.drumsFrom - 1e-9 || t >= o.dur) continue;
      const s0 = Math.max(0, Math.round(t * sr)), sm = S[snd], n = Math.min(sm.length, N - s0);
      for (let i = 0; i < n; i++) y[s0 + i] += g * sm[i];
    }
  }
  if (o.pad) {
    // sustained chords (slow 0.6 s attack, changing every 2 bars) built from rotating phasors, no Math.sin
    const chordLen = Math.round(8 * P * sr), freqs = [[220, 277.2, 329.6], [196, 246.9, 293.7]];
    for (let s0 = Math.round(o.padFrom * sr), ci = 0; s0 < N; s0 += chordLen, ci ^= 1) {
      const end = Math.min(N, s0 + chordLen), att = 0.6 * sr;
      for (const f of freqs[ci]) {
        const c = Math.cos((2 * Math.PI * f) / sr), s = Math.sin((2 * Math.PI * f) / sr);
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
  return y;
}

/** Signed grid error in seconds, wrapped to [-P/2, P/2). */
function gridError(firstBeat, start, P) {
  let e = (((firstBeat - start) % P) + P) % P;
  if (e >= P / 2) e -= P;
  return e;
}

// Runs the analysis (through the generator when expect.steps, counting its yields) and checks the result.
function check(name, o, expect) {
  const y = makeTrack(o);
  let r;
  if (expect.steps) {
    const it = beatSteps(y, o.sr || SR, { debug: VERBOSE });
    let n = 0, s;
    while (!(s = it.next()).done) n++;
    assert(n >= 5, `${name}: generator yields between stages (${n})`);
    r = s.value;
  } else {
    r = detectBeats(y, o.sr || SR, { debug: VERBOSE });
  }
  const trueBpm = expect.bpm ?? o.bpm;
  const phaseMs = r.bpm ? gridError(r.firstBeat, o.start, 60 / trueBpm) * 1000 : NaN;
  if (VERBOSE) {
    console.log(name, JSON.stringify({ bpm: r.bpm, err: r.bpm && r.bpm - trueBpm, phaseMs, conf: r.confidence,
      variable: r.variable, alts: r.alternatives.map((a) => +a.toFixed(2)), debug: r.debug }));
  }
  assert(r.bpm !== null, `${name}: bpm detected`);
  assert(Math.abs(r.bpm - trueBpm) <= 0.02, `${name}: bpm ${r.bpm} vs ${trueBpm}`);
  assert(Math.abs(phaseMs) <= 6, `${name}: firstBeat off by ${phaseMs.toFixed(2)} ms`);
  assert(r.firstBeat >= 0 && r.firstBeat < 60 / r.bpm, `${name}: firstBeat ${r.firstBeat} inside the first beat`);
  assert(r.confidence > 0.5, `${name}: confidence ${r.confidence}`);
  assert.equal(r.variable, false, `${name}: steady tempo`);
  if (expect.exact != null) assert.equal(r.bpm, expect.exact, `${name}: snapped to ${expect.exact}`);
  if (expect.notSnapped) assert(r.bpm !== Math.round(r.bpm * 2) / 2, `${name}: not snapped (${r.bpm})`);
  return r;
}

// ---------------------------------------------------------------------------------------------------------

test('house 124 with off-beat open hats', () => {
  check('house124', { bpm: 124, pattern: 'house', start: 0.37, dur: 28.5 }, { exact: 124 });
});

test('house 128 with off-beat open hats (generator form, alternatives)', () => {
  const r = check('house128', { bpm: 128, pattern: 'house', start: 0.11, dur: 20 }, { steps: true });
  for (const a of [r.bpm / 2, r.bpm * 2, (r.bpm * 2) / 3, (r.bpm * 3) / 2]) {
    assert(r.alternatives.some((x) => Math.abs(x - a) < 1e-9), 'alternative ' + a);
  }
});

test('house 125 with off-beat chord stabs (plain comb picks 2/3 tempo)', () => {
  check('stabs125', { bpm: 125, pattern: 'houseStabs', start: 0.2, dur: 20 }, {});
});

test('house 127 with off-beat chord stabs', () => {
  check('stabs127', { bpm: 127, pattern: 'houseStabs', start: 0.05, dur: 20 }, {});
});

test('house 132 with off-beat bass', () => {
  check('bass132', { bpm: 132, pattern: 'houseBass', start: 0.42, dur: 20 }, {});
});

test('127.5 snaps to 127.5, 126.37 stays unsnapped', () => {
  check('h127.5', { bpm: 127.5, pattern: 'house', start: 0.25, dur: 28.5 }, { exact: 127.5 });
  check('h126.37', { bpm: 126.37, pattern: 'house', start: 0.31, dur: 28.5 }, { notSnapped: true });
});

test('DnB 174: octave is 174, not 87', () => {
  check('dnb174', { bpm: 174, pattern: 'dnb', start: 0.4, dur: 20 }, {});
});

test('hip-hop 88 with swing: 88, not 176', () => {
  check('hiphop88', { bpm: 88, pattern: 'hiphop', start: 0.25, dur: 20, swing: 0.62 }, {});
});

test('silence + drumless pad intro, then drums: grid still right', () => {
  check('intro', { bpm: 122, pattern: 'house', start: 2.2, drumsFrom: 8.2, pad: true, padFrom: 2.2, dur: 26 }, {});
});

test('white noise, pads only, silence: bpm null, confidence 0', () => {
  const noise = makeTrack({ pattern: 'none', noiseDb: -10, dur: 10, seed: 3 });
  const r = detectBeats(noise, SR);
  assert.equal(r.bpm, null, 'noise has no bpm');
  assert.equal(r.confidence, 0, 'noise confidence 0');
  assert.equal(r.firstBeat, 0);
  assert.deepEqual(r.alternatives, []);
  const pads = detectBeats(makeTrack({ bpm: 120, pattern: 'none', pad: true, dur: 10 }), SR);
  assert.equal(pads.bpm, null, 'drumless pads have no bpm');
  assert.equal(pads.confidence, 0, 'pads confidence 0');
  const silent = detectBeats(new Float32Array(SR * 6), SR);
  assert.equal(silent.bpm, null, 'silence has no bpm');
  const tiny = detectBeats(new Float32Array(100), SR);
  assert.equal(tiny.bpm, null, 'too short');
});


test('tempo ramp 120 -> 124 is flagged variable', () => {
  const r = detectBeats(makeTrack({ bpm: 120, rampTo: 124, pattern: 'house', start: 0.2, dur: 20 }), SR);
  assert(r.bpm > 120 && r.bpm < 124, 'average tempo ' + r.bpm);
  assert.equal(r.variable, true, 'variable');
  assert(r.confidence > 0.3 && r.confidence <= 0.8 + 1e-9, 'variable lowers the confidence: ' + r.confidence);
});

test('options and bad input', () => {
  assert.throws(() => detectBeats(null, SR), TypeError);
  assert.throws(() => detectBeats(new Float32Array(10), 0), TypeError);
  const r = detectBeats(new Float32Array(SR * 5), SR, { minBpm: 'x', maxBpm: -1 });
  assert.equal(r.bpm, null);
});
