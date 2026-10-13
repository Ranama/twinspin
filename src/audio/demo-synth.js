// Two deterministic demo house grooves, so a new user can mix right away without picking files.
//   const { channels: [L, R], sampleRate } = synthDemo(0, ctx.sampleRate);        // 'Neon Drift', 124 BPM
//   const job = createDemoJob(1, ctx.sampleRate); while (!job.step(8)) await yieldToMain(); job.result();
// Pure (no DOM, no Web Audio). Arrangement per track (bars of 4 beats):
//   0-7 drums-only intro | 8-15 groove (+ bass) | 16-23 build (+ chord stabs, filter opening) |
//   24-27 breakdown (no kick: pad, arp, riser, snare roll) | 28.. drop (everything + arp) | exit (filter closing) |
//   last 8 full bars: drums-only outro | a final kick + crash ringing out.
// The first kick starts at exactly 0.0 s, every kick starts at round(k * 60 / bpm * sampleRate) and the output
// is peak-normalised to -1 dBFS. Speed: every drum hit and note is a precomputed one-shot copied into place,
// the sidechain is one precomputed gain curve, and the only full-length passes are a peak scan and the
// combined soft clip + normalisation.
// 'Neon Drift' (124 BPM, A minor): deep-house saw stabs Am9-Fmaj9-Dm9-Em7, rolling off-beat bass, 16th pluck
// arp. 'Spore Garden' (128 BPM, D minor, next to A minor on the Camelot wheel): swung hats, congas, shaker,
// organ stabs Dm9-Bbmaj9-Gm9-A7sus4, 16th rolling bass, dotted-8th kalimba arp.

import { mulberry32 } from '../core/util.js';

/** Demo track list (ids are what Deck.loadDemo takes). */
export const DEMO_TRACKS = Object.freeze([
  Object.freeze({ id: 0, title: 'Neon Drift', artist: 'TwinSpin demo', bpm: 124 }),
  Object.freeze({ id: 1, title: 'Spore Garden', artist: 'TwinSpin demo', bpm: 128 }),
]);

const PEAK = Math.pow(10, -1 / 20); // -1 dBFS
const DRIVE = 1.5; // where the loudest raw sample lands on the soft-clip curve
const DUCK_SHIFT = 2; // sidechain curve resolution: 4 samples

const SPECS = [
  {
    bpm: 124,
    seed: 0x5eed0124,
    style: 'neon',
    swing: 0.5,
    kickF0: 48,
    duck: 0.5,
    roots: [45, 41, 38, 40], // A2 F2 D2 E2 (sub an octave below)
    chords: [[60, 64, 67, 71], [57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 64]], // Am9 Fmaj9 Dm9 Em7
    // [16th step, semitones above the root, length in 16ths, velocity]
    bass: [[2, 0, 1.6, 1], [6, 0, 1.6, 1], [7, 12, 0.7, 0.55], [10, 0, 1.6, 1], [14, 0, 1.2, 0.9], [15, 7, 0.7, 0.55]],
    stabs: [[2, 5, 10, 13], [2, 5, 8, 11, 14]], // two-bar call and response
    arpEvery: 1,
    arpSeq: [0, 1, 2, 3, 4, 3, 2, 1],
    arpVel: [1, 0.55, 0.75, 0.55, 0.9, 0.55, 0.75, 0.55],
  },
  {
    bpm: 128,
    seed: 0x5eed0128,
    style: 'spore',
    swing: 0.57,
    kickF0: 52,
    duck: 0.42,
    roots: [50, 46, 43, 45], // D3 Bb2 G2 A2 (sub an octave below)
    chords: [[53, 57, 60, 64], [57, 60, 62, 65], [58, 62, 65, 69], [55, 57, 62, 64]], // Dm9 Bbmaj9 Gm9 A7sus4
    bass: [[2, 0, 0.85, 1], [3, 0, 0.8, 0.62], [6, 0, 0.85, 1], [7, 12, 0.8, 0.6], [10, 0, 0.85, 1], [11, 0, 0.8, 0.62], [14, 0, 0.85, 1], [15, 10, 0.8, 0.6]],
    stabs: [[3, 6, 11, 14], [3, 6, 8, 11]],
    arpEvery: 3,
    arpSeq: [0, 2, 4, 3, 1, 2, 0, 3, 4, 2, 1],
    arpVel: [1, 0.7, 0.85, 0.7, 0.8, 0.7, 0.9, 0.7, 0.85, 0.7, 0.75],
  },
];

/**
 * Render a demo track synchronously.
 * @param {number} id 0 | 1 (DEMO_TRACKS)
 * @param {number} sampleRate output rate (use the AudioContext rate; 8000+ works)
 * @param {number} [seconds=96]
 * @returns {{ channels: [Float32Array, Float32Array], sampleRate: number }}
 */
export function synthDemo(id, sampleRate, seconds = 96) {
  const job = createDemoJob(id, sampleRate, seconds);
  while (!job.step(Infinity)) {
    /* run to completion */
  }
  return job.result();
}

/**
 * The same render split into small tasks so the main thread stays responsive: `step(budgetMs)` works for
 * about budgetMs and returns true when finished; `progress` is 0..1; `result()` once finished.
 * @param {number} id
 * @param {number} sampleRate
 * @param {number} [seconds=96]
 */
export function createDemoJob(id, sampleRate, seconds = 96) {
  const spec = SPECS[id];
  if (!spec) throw new RangeError(`Unknown demo track ${id}`);
  if (!(sampleRate >= 3000)) throw new RangeError('Sample rate too low');
  const len = Math.max(1, Math.round(Math.max(0.1, seconds) * sampleRate));
  const ctx = makeContext(spec, sampleRate, len);
  const tasks = [() => buildSounds(ctx), () => schedule(ctx, tasks)];
  let i = 0;
  let done = false;
  const now = () => (globalThis.performance && performance.now ? performance.now() : Date.now());
  return {
    step(budgetMs = 8) {
      const t0 = now();
      while (i < tasks.length) {
        tasks[i++]();
        if (now() - t0 >= budgetMs) break;
      }
      if (i >= tasks.length) done = true;
      return done;
    },
    get progress() {
      return done ? 1 : tasks.length > 2 ? Math.min(0.99, i / tasks.length) : 0;
    },
    result() {
      if (!done) throw new Error('Demo render not finished');
      return { channels: [ctx.L, ctx.R], sampleRate };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Context, arrangement and sidechain

function makeContext(spec, sr, len) {
  const beat = (60 / spec.bpm) * sr; // samples per beat (fractional)
  const bars = Math.floor(len / (4 * beat) + 1e-9);
  const ctx = {
    spec,
    sr,
    len,
    beat,
    step: beat / 4,
    bars,
    introEnd: Math.min(8, bars),
    outroStart: Math.max(Math.min(8, bars), bars - 8),
    L: new Float32Array(len),
    R: new Float32Array(len),
    duck: null,
    rng: mulberry32(spec.seed),
    s: null,
  };
  // The closing kick + crash only when there is room for them to ring out.
  ctx.tailHit = len - kickAt(ctx, bars * 4) >= 1.2 * sr;
  return ctx;
}

/** Sidechain gain, one value per DUCK_BLOCK samples: dips under each kick (4 ms attack, 100 ms recovery). */
function buildDuck(ctx) {
  const { len, sr, spec } = ctx;
  const duck = new Float32Array((len >> DUCK_SHIFT) + 2).fill(1);
  const a = Math.max(1, 0.004 * sr);
  const r = 0.1 * sr;
  const B = 1 << DUCK_SHIFT;
  for (let k = 0; kickAt(ctx, k) < len; k++) {
    if (!kickOn(ctx, Math.floor(k / 4), k % 4)) continue;
    const s = kickAt(ctx, k);
    const e = Math.min(len, kickAt(ctx, k + 1));
    for (let b = Math.ceil(s / B); b * B < e; b++) {
      const i = b * B - s;
      duck[b] = 1 - spec.duck * (i < a ? i / a : Math.exp(-(i - a) / r));
    }
  }
  ctx.duck = duck;
}

function section(ctx, bar) {
  if (bar >= ctx.bars && ctx.bars > 0) return 'tail';
  if (bar < ctx.introEnd) return 'intro';
  if (bar >= ctx.outroStart) return 'outro';
  const m = bar - 8;
  if (m < 8) return 'groove';
  if (m < 16) return 'build';
  if (m < 20) return 'break';
  if (bar >= ctx.outroStart - 2) return 'exit';
  return 'drop';
}

function kickOn(ctx, bar, beatInBar) {
  const s = section(ctx, bar);
  if (s === 'break') return false;
  if (s === 'tail') return bar === ctx.bars && beatInBar === 0 && ctx.tailHit;
  return true;
}

const kickAt = (ctx, k) => Math.round(k * ctx.beat);
const chordIndex = (bar) => Math.floor(bar / 2) % 4;

/** Only the hats and the shaker swing: swung bass/percussion makes beat trackers think the tempo drifts. */
const SWUNG = new Set(['hat', 'ohat', 'shaker']);

/** Sample index of a 16th step (swing delays the odd 16ths). Kicks land exactly on kickAt(). */
function posOf(ctx, bar, step, swung = false) {
  if (step % 4 === 0) return kickAt(ctx, bar * 4 + step / 4);
  const swing = swung && step % 2 === 1 ? (ctx.spec.swing - 0.5) * 2 : 0;
  return Math.round((bar * 16 + step + swing) * ctx.step);
}

// ---------------------------------------------------------------------------------------------------------
// Mixing helpers

function addMono(ctx, src, at, gL, gR) {
  const { L, R } = ctx;
  const n = Math.min(src.length, ctx.len - at);
  for (let i = 0; i < n; i++) {
    const v = src[i];
    L[at + i] += v * gL;
    R[at + i] += v * gR;
  }
}

function addStereo(ctx, srcL, srcR, at, g) {
  const { L, R } = ctx;
  const n = Math.min(srcL.length, ctx.len - at);
  for (let i = 0; i < n; i++) {
    L[at + i] += srcL[i] * g;
    R[at + i] += srcR[i] * g;
  }
}

/** Add `src` into one channel through the sidechain curve. */
function addDucked(ctx, out, src, at, g) {
  const duck = ctx.duck;
  const n = Math.min(src.length, ctx.len - at);
  for (let i = 0; i < n; i++) out[at + i] += src[i] * g * duck[(at + i) >> DUCK_SHIFT];
}

/** Music event: dry left, Haas-delayed right, two ping-pong echoes (dotted 8th) of a darker copy. */
function addMusic(ctx, dry, wet, at, g, haas = 0.012) {
  addDucked(ctx, ctx.L, dry, at, g);
  addDucked(ctx, ctx.R, dry, at + Math.round(haas * ctx.sr), g * 0.88);
  const d = Math.round(ctx.beat * 0.75);
  addDucked(ctx, ctx.R, wet, at + d, g * 0.34);
  addDucked(ctx, ctx.L, wet, at + 2 * d, g * 0.14);
}

// ---------------------------------------------------------------------------------------------------------
// DSP helpers (one-shot generation only)

const TWO_PI = Math.PI * 2;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** Soft saturation: rational tanh approximation, monotonic on [-3, 3] and clamped to +-1 beyond. */
function sat(x) {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

/** PolyBLEP residual for band-limited saws. */
function blep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

function peakOf(b) {
  let m = 0;
  for (let i = 0; i < b.length; i++) if (Math.abs(b[i]) > m) m = Math.abs(b[i]);
  return m;
}

function scale(bufs, peak = 1) {
  const m = Math.max(...bufs.map(peakOf));
  if (m > 0) for (const b of bufs) for (let i = 0; i < b.length; i++) b[i] *= peak / m;
  return bufs;
}
const normalize = (b) => scale([b])[0];

/** Length after which `b` stays below -60 dB of its peak (plus 2 ms, at least 10 ms). */
function tailLen(b, sr) {
  const th = peakOf(b) * 0.001;
  let end = b.length;
  while (end > 1 && Math.abs(b[end - 1]) < th) end--;
  return Math.min(b.length, Math.max(end + Math.round(0.002 * sr), Math.round(0.01 * sr)));
}

/** First m samples of b with a 5 ms fade-out so nothing clicks. */
function cut(b, m, sr) {
  const out = b.length === m ? b : b.slice(0, m);
  const f = Math.min(out.length, Math.max(1, Math.round(0.005 * sr)));
  for (let i = 0; i < f; i++) out[out.length - 1 - i] *= i / f;
  return out;
}
const trim = (b, sr) => cut(b, tailLen(b, sr), sr);

function onePoleLP(src, fc, sr) {
  const out = new Float32Array(src.length);
  const a = 1 - Math.exp((-TWO_PI * Math.min(fc, 0.45 * sr)) / sr);
  let y = 0;
  for (let i = 0; i < src.length; i++) out[i] = y += a * (src[i] - y);
  return out;
}

function highpass2(buf, fc, sr) {
  const a = 1 - Math.exp((-TWO_PI * Math.min(fc, 0.45 * sr)) / sr);
  let l1 = 0;
  let l2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const h1 = buf[i] - (l1 += a * (buf[i] - l1));
    buf[i] = h1 - (l2 += a * (h1 - l2));
  }
  return buf;
}

/**
 * TPT state-variable filter (mode 0 low-pass, 1 band-pass). Cutoff: base * (1 + envAmt * exp(-t / envTau)),
 * or an exponential glide from base to endHz when endHz > 0. Coefficients update every 16 samples.
 */
function svf(src, sr, base, q, mode = 0, envAmt = 0, envTau = 0.05, endHz = 0) {
  const n = src.length;
  const out = new Float32Array(n);
  const k = 1 / q;
  let ic1 = 0;
  let ic2 = 0;
  for (let i = 0; i < n; i += 16) {
    let fc = endHz > 0 ? base * Math.pow(endHz / base, i / n) : base * (1 + envAmt * Math.exp(-i / sr / envTau));
    fc = Math.max(10, Math.min(fc, 0.45 * sr));
    const g = Math.tan((Math.PI * fc) / sr);
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const end = Math.min(n, i + 16);
    for (let j = i; j < end; j++) {
      const v3 = src[j] - ic2;
      const v1 = a1 * ic1 + a2 * v3;
      const v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1;
      ic2 = 2 * v2 - ic2;
      out[j] = mode === 0 ? v2 : v1;
    }
  }
  return out;
}

function noise(n, rng) {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = rng() * 2 - 1;
  return b;
}

/** TR-808-style metallic source: six detuned square waves plus noise, high-passed. */
function metal(n, sr, rng, mul = 1.9) {
  const freqs = [205.3, 304.4, 369.6, 522.7, 540, 800];
  const out = new Float32Array(n);
  const ph = new Float64Array(6);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let j = 0; j < 6; j++) {
      ph[j] += (freqs[j] * mul) / sr;
      if (ph[j] >= 1) ph[j] -= 1;
      v += ph[j] < 0.5 ? 1 : -1;
    }
    out[i] = v / 6 + (rng() * 2 - 1) * 0.8;
  }
  return highpass2(highpass2(out, 6500, sr), 6500, sr);
}

/** Sum of decaying sine partials [[ratio, level, tau]] using rotating phasors (no per-sample Math.sin). */
function partials(n, sr, f, parts, out = new Float32Array(n)) {
  for (const [ratio, level, tau] of parts) {
    const w = (TWO_PI * f * ratio) / sr;
    if (w >= Math.PI * 0.9) continue;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const dec = tau > 0 ? Math.exp(-1 / (tau * sr)) : 1;
    let c = 1;
    let s = 0;
    let a = level;
    for (let i = 0; i < n; i++) {
      out[i] += s * a;
      const c2 = c * cw - s * sw;
      s = s * cw + c * sw;
      c = c2;
      a *= dec;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// One-shots

function makeKick(sr, f0, rng) {
  const n = Math.round(0.42 * sr);
  const out = new Float32Array(n);
  const att = Math.max(1, Math.round(0.0005 * sr));
  const clickHz = Math.min(2800, 0.4 * sr);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const body = Math.sin(ph) * (i < att ? i / att : 1) * Math.exp(-t / 0.26);
    ph += (TWO_PI * (f0 + (165 - f0) * Math.exp(-t / 0.03))) / sr;
    const click = t < 0.006 ? (Math.sin(TWO_PI * clickHz * t) * 0.4 + (rng() * 2 - 1) * 0.12) * Math.exp(-t / 0.0015) : 0;
    out[i] = sat((body + click) * 1.35) / sat(1.35);
  }
  return trim(out, sr);
}

/** Clap (and for 'spore' a clap layered with a snare body): four noise bursts plus a short room, stereo. */
function makeClap(sr, rng, snare) {
  const n = Math.round(0.42 * sr);
  const offs = [0, 0.008, 0.017, 0.027];
  const side = () => {
    const bp = svf(noise(n, rng), sr, 1250, 1.1, 1);
    const room = svf(noise(n, rng), sr, 1900, 0.9, 1);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let e = 0;
      for (const o of offs) if (t >= o) e = Math.max(e, Math.exp(-(t - o) / 0.0035));
      if (t >= 0.027) e = Math.max(e, 0.55 * Math.exp(-(t - 0.027) / 0.09));
      out[i] = bp[i] * e + room[i] * 0.35 * Math.exp(-t / 0.2);
    }
    if (snare) partials(n, sr, 185, [[1, 0.9, 0.06], [1.6, 0.3, 0.03]], out);
    return out;
  };
  const [L, R] = scale([side(), side()]);
  const m = Math.max(tailLen(L, sr), tailLen(R, sr));
  return [cut(L, m, sr), cut(R, m, sr)];
}

function makeHats(sr, rng) {
  const src = normalize(metal(Math.round(0.45 * sr), sr, rng));
  const closed = src.slice(0, Math.round(0.12 * sr)).map((v, i) => v * Math.exp(-i / sr / 0.028));
  const open = src.map((v, i) => v * (1 - Math.exp(-i / sr / 0.002)) * Math.exp(-i / sr / 0.17));
  return { closed: trim(closed, sr), open: trim(open, sr) };
}

function makeRim(sr) {
  const n = Math.round(0.07 * sr);
  return trim(normalize(partials(n, sr, 470, [[1, 1, 0.011], [Math.min(1700, 0.4 * sr) / 470, 0.6, 0.011]])), sr);
}

function makeConga(sr, f0, rng) {
  const n = Math.round(0.34 * sr);
  const out = new Float32Array(n);
  const slap = svf(noise(n, rng), sr, 2200, 1.2, 1);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    ph += (TWO_PI * f0 * (1 + 0.22 * Math.exp(-t / 0.014))) / sr;
    out[i] = Math.sin(ph) * Math.exp(-t / 0.13) + slap[i] * 0.5 * Math.exp(-t / 0.004);
  }
  return trim(normalize(out), sr);
}

function makeShaker(sr, rng) {
  const bp = svf(noise(Math.round(0.12 * sr), rng), sr, 6000, 1.4, 1);
  for (let i = 0; i < bp.length; i++) bp[i] *= (1 - Math.exp(-i / sr / 0.006)) * Math.exp(-i / sr / 0.045);
  return trim(normalize(bp), sr);
}

function makeCrash(sr, rng) {
  const n = Math.round(2.6 * sr);
  const fade = 0.6 * sr;
  const side = () => {
    const m = metal(n, sr, rng, 2.6);
    const nz = highpass2(noise(n, rng), 4500, sr);
    for (let i = 0; i < n; i++) {
      const env = (1 - Math.exp(-i / sr / 0.002)) * Math.exp(-i / sr / 0.8) * Math.min(1, (n - i) / fade);
      m[i] = (m[i] * 0.5 + nz[i]) * env;
    }
    return m;
  };
  return scale([side(), side()]);
}

/** Rising filtered-noise sweep over `seconds`, louder towards the end (breakdown build-up). */
function makeRiser(sr, seconds, rng) {
  const n = Math.round(seconds * sr);
  const side = () => {
    const out = svf(noise(n, rng), sr, 300, 2.4, 1, 0, 0.05, 8000);
    for (let i = 0; i < n; i++) out[i] *= (i / n) * (i / n) * (i > n - 64 ? (n - i) / 64 : 1);
    return out;
  };
  return scale([side(), side()]);
}

function makeBass(sr, midi, lenSec, neon) {
  const f = mtof(midi);
  const rel = 0.03;
  const n = Math.round((lenSec + rel) * sr);
  const raw = new Float32Array(n);
  const dt = f / sr;
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const saw = 2 * ph - 1 - blep(ph, dt);
    let ph2 = ph + 0.5;
    if (ph2 >= 1) ph2 -= 1;
    raw[i] = neon ? saw : 0.6 * saw + 0.2 * (saw - (2 * ph2 - 1 - blep(ph2, dt)));
    if ((ph += dt) >= 1) ph -= 1;
  }
  const filt = neon ? svf(raw, sr, 160, 1.1, 0, 6.2, 0.08) : svf(raw, sr, 140, 1.6, 0, 13.5, 0.045);
  const sub = partials(n, sr, f / 2, [[1, 1, 0]]);
  const att = Math.max(1, 0.003 * sr);
  const relStart = lenSec * sr;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let env = i < att ? i / att : neon ? 0.75 + 0.25 * Math.exp(-t / 0.15) : Math.exp(-t / 0.25);
    if (i > relStart) env *= Math.max(0, 1 - (i - relStart) / (rel * sr));
    const v = neon ? sub[i] * 0.75 + filt[i] * 0.55 : sub[i] * 0.6 + filt[i] * 0.65;
    raw[i] = sat(v * env * 1.4);
  }
  return normalize(raw);
}

/** Raw (unfiltered) chord stab; each placement gets its own filter sweep. */
function makeStab(sr, notes, neon) {
  const n = Math.round(0.42 * sr);
  const out = new Float32Array(n);
  if (neon) {
    // Two detuned band-limited saws per note, plucky envelope.
    const oscs = [];
    for (const m of notes) for (const det of [-0.1, 0.1]) oscs.push({ dt: mtof(m + det) / sr, ph: (m * 0.137 + det + 1) % 1 });
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (const o of oscs) {
        v += 2 * o.ph - 1 - blep(o.ph, o.dt);
        if ((o.ph += o.dt) >= 1) o.ph -= 1;
      }
      out[i] = v * Math.min(1, i / (0.002 * sr)) * Math.exp(-i / sr / 0.17);
    }
  } else {
    // Drawbar organ: additive partials, percussion on the 3rd harmonic, key click.
    for (const m of notes) partials(n, sr, mtof(m), [[0.5, 0.35, 0], [1, 1, 0], [2, 0.7, 0], [3, 0.45, 0], [3, 0.55, 0.09], [4, 0.3, 0], [6, 0.18, 0]], out);
    const rng = mulberry32(notes[0] * 7919);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let env = Math.min(1, i / (0.003 * sr)) * (0.6 + 0.4 * Math.exp(-t / 0.2));
      if (t > 0.3) env *= Math.max(0, 1 - (t - 0.3) / 0.1);
      out[i] = out[i] * env + (t < 0.0015 ? (rng() * 2 - 1) * 0.6 : 0);
    }
  }
  return trim(normalize(out), sr);
}

function makeArpNote(sr, midi, neon) {
  const f = mtof(midi);
  if (neon) {
    // Pluck: saw + square through a resonant low-pass with a fast envelope.
    const n = Math.round(0.24 * sr);
    const raw = new Float32Array(n);
    const dt = f / sr;
    let ph = 0;
    for (let i = 0; i < n; i++) {
      let ph2 = ph + 0.5;
      if (ph2 >= 1) ph2 -= 1;
      const saw = 2 * ph - 1 - blep(ph, dt);
      raw[i] = 0.6 * saw + 0.2 * (saw - (2 * ph2 - 1 - blep(ph2, dt)));
      if ((ph += dt) >= 1) ph -= 1;
    }
    const out = svf(raw, sr, 500, 2, 0, 8.4, 0.035);
    for (let i = 0; i < n; i++) out[i] *= Math.min(1, i / (0.001 * sr)) * Math.exp(-i / sr / 0.11);
    return trim(normalize(out), sr);
  }
  // Kalimba / mallet: decaying fundamental plus fast inharmonic overtones.
  const n = Math.round(0.6 * sr);
  const out = partials(n, sr, f, [[1, 1, 0.3], [4.02, 0.35, 0.05], [10.1, 0.18, 0.015]]);
  for (let i = 0; i < n; i++) out[i] *= Math.min(1, i / (0.0015 * sr));
  return trim(normalize(out), sr);
}

function buildSounds(ctx) {
  const { sr, spec, rng } = ctx;
  const neon = spec.style === 'neon';
  buildDuck(ctx);
  const hats = makeHats(sr, rng);
  const s = {
    kick: makeKick(sr, spec.kickF0, rng),
    clap: makeClap(sr, rng, !neon),
    hat: hats.closed,
    ohat: hats.open,
    crash: makeCrash(sr, rng),
    riser: makeRiser(sr, (8 * ctx.beat) / sr, rng),
    stabs: spec.chords.map((c) => makeStab(sr, c, neon)),
    bass: new Map(),
    arp: new Map(),
  };
  if (neon) s.rim = makeRim(sr);
  else {
    s.congaHi = makeConga(sr, 262, rng);
    s.congaLo = makeConga(sr, 191, rng);
    s.shaker = makeShaker(sr, rng);
  }
  ctx.s = s;
}

function cached(map, key, make) {
  let v = map.get(key);
  if (!v) map.set(key, (v = make()));
  return v;
}

// ---------------------------------------------------------------------------------------------------------
// Arrangement -> tasks

/** Stab filter cutoff (Hz): closed at the start of the build, open in the drop, closing on the exit. */
function stabCutoff(ctx, bar, step) {
  const sec = section(ctx, bar);
  if (sec === 'build') return 320 * Math.pow(5200 / 320, (bar - 16 + step / 16) / 8);
  if (sec === 'break') return 2400;
  if (sec === 'exit') return 5200 * Math.pow(380 / 5200, Math.min(1, (bar - (ctx.outroStart - 2) + step / 16) / 2));
  return 5200;
}

function drumEvents(ctx, bar, sec, ev, vel) {
  const neon = ctx.spec.style === 'neon';
  for (let beat = 0; beat < 4; beat++) if (kickOn(ctx, bar, beat)) ev.push(['mono', 'kick', 4 * beat, 1, 0]);
  if ((bar === 8 || bar === 16 || bar === 28 || bar === ctx.outroStart) && bar >= ctx.introEnd && sec !== 'tail') ev.push(['stereo', 'crash', 0, 0.3]);
  if (sec === 'tail') {
    if (ctx.tailHit) ev.push(['stereo', 'crash', 0, 0.3]);
    return;
  }
  const fullKit = sec !== 'intro' || bar >= 4;
  const breakBar = bar - 24;
  const evenBar = bar % 2 === 0;
  for (let st = 0; st < 16; st++) {
    const inBeat = st % 4;
    if (sec === 'break') {
      if (breakBar < 2 && inBeat === 2) ev.push(['mono', 'hat', st, vel(0.18), -0.2]);
      if (breakBar < 2 && !neon && (inBeat === 1 || inBeat === 3)) ev.push(['mono', 'hat', st, vel(0.12), 0.25]);
      continue;
    }
    if (neon) {
      if (inBeat === 1 || inBeat === 3) ev.push(['mono', 'hat', st, vel(0.3), 0.25]);
      if (inBeat === 0 && bar >= 2) ev.push(['mono', 'hat', st, vel(0.14), -0.25]);
      if (inBeat === 2) ev.push(fullKit ? ['mono', 'ohat', st, vel(0.32), 0.12] : ['mono', 'hat', st, vel(0.36), 0.1]);
      if ((st === 7 || st === 15) && sec !== 'intro' && sec !== 'outro') ev.push(['mono', 'rim', st, vel(st === 15 && !evenBar ? 0.3 : 0.2), -0.35]);
    } else {
      if (inBeat === 2 && fullKit) ev.push(['mono', 'ohat', st, vel(0.3), 0.15]);
      else ev.push(['mono', 'hat', st, vel([0.13, 0.22, 0.3, 0.22][inBeat]), 0.3]);
      if (bar >= 2) ev.push(['mono', 'shaker', st, vel(st % 2 ? 0.16 : 0.24), -0.45]);
    }
    if ((st === 4 || st === 12) && fullKit) ev.push(['stereo', 'clap', st, neon ? 0.55 : 0.6]);
  }
  if (!neon && fullKit) {
    const pat = evenBar ? [[3, 'congaHi'], [6, 'congaLo'], [11, 'congaHi'], [14, 'congaLo']] : [[3, 'congaHi'], [7, 'congaHi'], [10, 'congaLo'], [13, 'congaLo']];
    for (const [st, name] of pat) ev.push(['mono', name, st, vel(sec === 'break' ? 0.22 : 0.3), name === 'congaHi' ? 0.35 : -0.3]);
  }
  if (sec === 'break' && breakBar === 3) {
    for (let st = 0; st < 16; st += st < 8 ? 2 : 1) ev.push(['stereo', 'clap', st, 0.18 + 0.4 * (st / 15)]);
  }
  if (sec === 'break' && breakBar === 2) ev.push(['stereo', 'riser', 0, 0.3]);
}

function musicEvents(ctx, bar, sec, ev) {
  const { spec } = ctx;
  const neon = spec.style === 'neon';
  const ci = chordIndex(bar);
  if (sec === 'groove' || sec === 'build' || sec === 'drop' || sec === 'exit') {
    for (const [st, semi, lenSteps, v] of spec.bass) ev.push(['bass', spec.roots[ci] + semi, st, lenSteps, (neon ? 0.5 : 0.48) * v]);
  }
  if (sec === 'build' || sec === 'break' || sec === 'drop' || sec === 'exit') {
    const g = sec === 'break' ? 0.3 : neon ? 0.3 : 0.27;
    for (const st of spec.stabs[bar % 2]) ev.push(['stab', ci, st, g, stabCutoff(ctx, bar, st)]);
  }
  if (sec === 'break' || (sec === 'drop' && bar < 36)) {
    const chord = spec.chords[ci];
    const tones = neon ? [...chord, ...chord.map((m) => m + 12)] : [...chord.map((m) => m + 12), chord[0] + 24];
    const lvl = (neon ? 0.16 : 0.2) * (sec === 'break' ? 1.3 : 1);
    for (let st = 0; st < 16; st++) {
      const abs = (bar % 2) * 16 + st;
      if (abs % spec.arpEvery !== 0) continue;
      const idx = abs / spec.arpEvery;
      ev.push(['arp', tones[spec.arpSeq[idx % spec.arpSeq.length] % tones.length], st, lvl * spec.arpVel[idx % spec.arpVel.length]]);
    }
  }
  if (sec === 'break' && (bar - 24) % 2 === 0) ev.push(['pad', ci]);
}

function schedule(ctx, tasks) {
  const rng = mulberry32(ctx.spec.seed ^ 0x9e3779b9);
  const vel = (v) => v * (0.88 + 0.24 * rng());
  for (let bar = 0; bar <= ctx.bars; bar++) {
    const sec = section(ctx, bar);
    const ev = [];
    drumEvents(ctx, bar, sec, ev, vel);
    musicEvents(ctx, bar, sec, ev);
    if (ev.length) tasks.push(() => renderBar(ctx, bar, ev));
  }
  // A short raised-cosine fade at the very end, so a render that stops mid-sound never clicks.
  tasks.push(() => {
    const n = Math.min(Math.round(0.4 * ctx.sr), Math.floor(ctx.len / 4));
    for (let i = 0; i < n; i++) {
      const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
      ctx.L[ctx.len - 1 - i] *= g;
      ctx.R[ctx.len - 1 - i] *= g;
    }
  });
  // Master: find the raw peak, then one pass of soft clip + normalisation. sat() is monotonic, so the output
  // peak is exactly sat(DRIVE) * gain = -1 dBFS.
  const stats = { pre: 1 };
  const chunk = 2 * ctx.sr;
  let raw = 0;
  for (let start = 0; start < ctx.len; start += chunk) {
    tasks.push(() => {
      const end = Math.min(ctx.len, start + chunk);
      for (const ch of [ctx.L, ctx.R]) {
        for (let i = start; i < end; i++) {
          const a = ch[i] < 0 ? -ch[i] : ch[i];
          if (a > raw) raw = a;
        }
      }
      stats.pre = raw > 0 ? DRIVE / raw : 1;
    });
  }
  const gain = PEAK / sat(DRIVE);
  for (let start = 0; start < ctx.len; start += chunk) {
    tasks.push(() => {
      const end = Math.min(ctx.len, start + chunk);
      const pre = stats.pre;
      for (const ch of [ctx.L, ctx.R]) {
        for (let i = start; i < end; i++) {
          const x = ch[i] * pre;
          const x2 = x * x;
          ch[i] = x > 3 ? gain : x < -3 ? -gain : ((x * (27 + x2)) / (27 + 9 * x2)) * gain;
        }
      }
    });
  }
}

function renderBar(ctx, bar, events) {
  const { s, sr, spec } = ctx;
  const neon = spec.style === 'neon';
  for (const e of events) {
    const kind = e[0];
    if (kind === 'mono') {
      const pan = e[4];
      addMono(ctx, s[e[1]], posOf(ctx, bar, e[2], SWUNG.has(e[1])), e[3] * (1 - Math.max(0, pan)), e[3] * (1 + Math.min(0, pan)));
    } else if (kind === 'stereo') {
      addStereo(ctx, s[e[1]][0], s[e[1]][1], posOf(ctx, bar, e[2]), e[3]);
    } else if (kind === 'bass') {
      const [, midi, st, lenSteps, g] = e;
      const src = cached(s.bass, midi * 100 + Math.round(lenSteps * 10), () => makeBass(sr, midi, (lenSteps * ctx.step) / sr, neon));
      const at = posOf(ctx, bar, st);
      addDucked(ctx, ctx.L, src, at, g);
      addDucked(ctx, ctx.R, src, at, g);
    } else if (kind === 'stab') {
      const dry = svf(s.stabs[e[1]], sr, e[4], 1.5, 0, 1.8, 0.06);
      addMusic(ctx, dry, onePoleLP(dry, 2600, sr), posOf(ctx, bar, e[2]), e[3]);
    } else if (kind === 'arp') {
      const note = cached(s.arp, e[1], () => {
        const dry = makeArpNote(sr, e[1], neon);
        return [dry, onePoleLP(dry, 2600, sr)];
      });
      addMusic(ctx, note[0], note[1], posOf(ctx, bar, e[2]), e[3], 0.007);
    } else if (kind === 'pad') {
      renderPad(ctx, e[1], bar);
    }
  }
}

/** Two-bar pad chord (breakdown), rendered in place: one detuned saw per note and side, two one-pole LPs. */
function renderPad(ctx, ci, bar) {
  const { sr, L, R } = ctx;
  const notes = ctx.spec.chords[ci];
  const at = posOf(ctx, bar, 0);
  const segLen = Math.round(8 * ctx.beat);
  const n = Math.min(segLen + Math.round(0.8 * sr), ctx.len - at);
  if (n <= 0) return;
  const oscL = notes.map((m, j) => ({ dt: mtof(m + 0.06) / sr, ph: (j * 0.31) % 1 }));
  const oscR = notes.map((m, j) => ({ dt: mtof(m - 0.06) / sr, ph: (j * 0.53 + 0.2) % 1 }));
  const a = 1 - Math.exp((-TWO_PI * Math.min(1500, 0.45 * sr)) / sr);
  const att = 0.35 * sr;
  const relDecay = Math.exp(-1 / (0.25 * sr));
  const g = 0.5 / notes.length;
  let l1 = 0;
  let l2 = 0;
  let r1 = 0;
  let r2 = 0;
  let env = 0;
  for (let i = 0; i < n; i++) {
    let vl = 0;
    let vr = 0;
    for (let j = 0; j < notes.length; j++) {
      const o = oscL[j];
      vl += 2 * o.ph - 1 - blep(o.ph, o.dt);
      if ((o.ph += o.dt) >= 1) o.ph -= 1;
      const p = oscR[j];
      vr += 2 * p.ph - 1 - blep(p.ph, p.dt);
      if ((p.ph += p.dt) >= 1) p.ph -= 1;
    }
    l2 += a * ((l1 += a * (vl - l1)) - l2);
    r2 += a * ((r1 += a * (vr - r1)) - r2);
    env = i < att ? i / att : i > segLen ? env * relDecay : 1;
    L[at + i] += l2 * env * g;
    R[at + i] += r2 * env * g;
  }
}
