// Tempo (BPM), beat grid and beat map detection. Pure: no DOM, no Web Audio, safe in workers and JsCheck tests.
//
// Usage:
//   import { detectBeats } from './bpm.js';
//   const info = detectBeats(mono, 11025);   // mono: Float32Array, decimated mono (~11-12 kHz, src/audio/pcm.js)
//   // -> { bpm: 124 | null, firstBeat: 0.231, confidence: 0.93, variable: false, alternatives: [62, 248, ...],
//   //      beats: Float64Array [0.231, 0.715, ...] | null }
//   beatSteps(mono, sampleRate, opts) is the same analysis as a generator: every next() does a bounded slice
//   of work (a few ms in V8), so analyzer.js can time-slice it on the main thread when workers are missing.
//
// BeatInfo.beats (the beat map): the time (s, track time) of every beat from the first beat >= 0 to the end of
// the track; beats[0] === firstBeat. Steady tracks: exactly the constant grid firstBeat + k * 60 / bpm.
// Variable tracks (tempo drift): the tracked beats, following the drift (bpm is then the average tempo: beats
// per minute over the tracked stretch); before the first / after the last stretch with a beat (drumless intro,
// outro) the map continues as a straight grid at the local tempo. null when there is no bpm. The map belongs to
// the detected tempo: when the user changes the bpm (x2, /2, tap), use the plain grid instead.
//
// Pipeline (docs/research/research-bpm.md stages 1-6, prototype docs/research/proto/analyzer.js, plus the
// verified fix from docs/research/verify-bpm.md):
//   1. Onset strength without an FFT: 3 bands (LP 150 x2 | HP 200 -> LP 2500 | HP 2500), energy per hop of
//      ~5.8 ms, 2-hop energy, log1p(100 * E / mean(E)), lag-2 half-wave-rectified flux. ossT = low + mid +
//      0.5 high (tempo), ossP = low + mid (phase: no hats, so off-beat open hats cannot pull the grid).
//      Both have a centred +-0.25 s moving average subtracted and are half-wave rectified.
//   2. Tempo candidates: ossT pair-summed (~86 Hz), Gaussian-smoothed (sigma 1 frame, fixes the frame
//      quantisation that made the plain comb prefer 2/3 tempo), global autocorrelation, harmonic comb
//      A(t) + A(2t) + A(4t) with a per-harmonic parabolic peak, log-normal prior around 120 BPM.
//   3. The top 4 distinct candidates (folded into [minBpm, 2 * minBpm)) each go through the fine stages: a
//      zoomed whole-track DFT (harmonics 1 + 2, phasor recursion, +-1 % then a fine pass, grid step scaled
//      to the track length), windowed Fourier phase regression (8 s Hann windows, 4 s hop, twice) and the
//      folded beat profile. The winner has the best foldContrast * coverage * peakFrac (verify-bpm.md: the raw
//      comb score alone picks 2/3 tempo on house with off-beat stabs or bass; peakFrac, the share of onset
//      mass within 1/16 beat of the fold peak, also separates 4:5 relatives that saturate contrast).
//   4. Octave: when 2 * bpm <= maxBpm, fold the LINEAR >2.5 kHz energy flux on the fast grid into 4 slots;
//      a backbeat on opposite slots (rho > 0.5) means the fast tempo (DnB 174, not 87; hip-hop stays 88).
//   5. Steady or variable (stage 7 builds the map first): a track whose map stays within a few ms of one
//      straight grid (residuals smoothed over +-8 beats: RMS <= 6 ms, 95th percentile <= 12 ms) is steady. The
//      map decides only when it covers >= 20 s and followed the beat in >= 50 % (steady) / 75 % (variable) of
//      the windows with music, and a bending map must line the onsets up better than the straight grid (warped
//      fold contrast); otherwise the old rule decides (Fourier phase residual RMS > 12 ms or max > 40 ms,
//      unless the per-beat onset regression keeps >= 85 % of the hits within 15 ms of one line). Steady
//      tracks get the per-beat refinement (onset nearest every predicted beat, +-10 % then +-6 % of a beat,
//      weighted line), then snap to an integer or half BPM only when that moves the grid by < 8 ms over a
//      confident span of >= 20 s. 126.37 stays 126.37. BPM is never rounded otherwise.
//   6. Grid anchor from synchronous averaging (ossP folded modulo the beat period, 128 bins, circular
//      Gaussian, parabolic peak), minus the measured onset-detector latency. Never the Fourier angle
//      (biased by syncopation). firstBeat is the first grid beat >= 0 s (variable: the first map beat >= 0).
//   7. Beat map: 16-beat Hann windows every 4 beats, each folded like stage 6 but in the beat coordinate of
//      the current map, so the fold peak is the map's local phase error, attributed to the window's onset
//      centroid. Pass 1 follows the phase outward from the strongest window (+-0.22 beat around the
//      extrapolated phase), two passes refine it in the warped coordinate (+-0.1 beat). Windows without a
//      beat (low onset mass, < 8 effective onset frames, fold contrast < 0.5, or an off-beat peak) are bridged
//      by interpolation. About 3 % of the analysis time (3 cheap passes over the onset signal).
//   Confidence = clamp((contrast - 0.3) / 0.5) * min(1, coverage / 0.5) * (variable ? 0.8 with a usable map,
//   else 0.5 : 1); for a mapped variable track the contrast is measured in the map's coordinate. No rhythm
//   (noise, pads, silence) gives bpm null, confidence 0 and beats null.

const TARGET_RATE = 11025;      // analysis rate the hop size is tuned for
const HOP_AT_TARGET = 64;       // 5.8 ms hops at 11025 Hz (~172 frames per second)
const LATENCY_BIAS_SEC = 0.0026; // onset detector delay (hop alignment + LP group delay), click-calibrated
const WIN_SEC = 8;              // phase regression window
const WIN_HOP_SEC = 4;
const FOLD_BINS = 128;
const WIN_R_MIN = 0.15;         // phase window: coherence |z| / sum(v)
const WIN_Z_STRONG = 2.5;       // phase window: sqrt(Rayleigh Z) of a window that stands on its own
const WIN_Z_WEAK = 1.6;         // phase window: weaker windows count only on the others' phase line
const WIN_NEFF_MIN = 8;         // phase window: effective onset frames (1-2 isolated hits are no rhythm)
const PHASE_TOL_SEC = 0.03;     // phase line inlier tolerance
const STEADY_KEPT = 0.85;       // steady: share of beat hits within 15 ms of one straight grid line
const STEADY_RMS_MS = 5;        // steady: RMS (ms) of those hits around the line
const MAP_DECIDE_SPAN = 20;     // s: the beat map decides steady vs variable when it covers at least this
const VAR_RMS_MS = 6;           // variable: map strays from one straight grid by more than this RMS (ms) ...
const VAR_P95_MS = 12;          // ... or more than this on 5 % of its beats (ms)
const MAP_MIN_TRACKED = 0.75;   // a bending map is used when it followed the beat in this share of the music windows
const MAP_MIN_TRACKED_STEADY = 0.5; // ... a straight one proves a steady tempo from this share on (long breakdowns)
const MAP_MIN_WARPED = 0.6;     // ... and the fold in its coordinate is at least this sharp
const VAR_CONF = 0.5;           // confidence factor for variable tempo without a usable beat map
const VAR_CONF_MAP = 0.8;       // ... and with a beat map that follows the drift
const ONSET_CHUNK_FRAMES = 2048; // ~12 s of audio per generator step
const ACF_CHUNK_OPS = 600000;    // multiply-adds per generator step
const ZOOM_CHUNK_OPS = 300000;   // DFT samples (2 harmonics each) per generator step

/** Default options (contract: fold range 78..180). */
export const BEAT_DEFAULTS = Object.freeze({
  minBpm: 78,          // fold range [minBpm, 2 * minBpm); the octave test may double up to maxBpm
  maxBpm: 180,
  searchMinBpm: 60,    // comb search range (stage 2)
  searchMaxBpm: 200,
  priorCenter: 120,    // log-normal tempo prior (octaves)
  priorSigma: 1,
  candidates: 4,       // distinct folded candidates refined in stage 3
  rhoFast: 0.5,        // octave test threshold
  snap: true,
  debug: false,        // attach a `debug` object to the result
});

function nullResult(debug) {
  const r = { bpm: null, firstBeat: 0, confidence: 0, variable: false, alternatives: [], beats: null };
  if (debug) r.debug = debug;
  return r;
}

/**
 * Detect tempo and beat grid of a whole track.
 * @param {Float32Array} mono decimated mono samples (any rate works; ~11-12 kHz is the design point)
 * @param {number} sampleRate samples per second of `mono`
 * @param {{minBpm?: number, maxBpm?: number, snap?: boolean, debug?: boolean}} [opts]
 * @returns {{bpm: number|null, firstBeat: number, confidence: number, variable: boolean, alternatives: number[],
 *   beats: Float64Array|null}}
 */
export function detectBeats(mono, sampleRate, opts = {}) {
  const it = beatSteps(mono, sampleRate, opts);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/**
 * Generator form of detectBeats: yields (a progress number 0..1) between bounded slices of work and returns
 * the BeatInfo. Drive it with `it.next()` until `done`.
 * @param {Float32Array} mono
 * @param {number} sampleRate
 * @param {object} [opts]
 */
export function* beatSteps(mono, sampleRate, opts = {}) {
  const o = resolveOptions(opts);
  if (!mono || typeof mono.length !== 'number') throw new TypeError('detectBeats: mono must be a Float32Array');
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) throw new TypeError('detectBeats: bad sampleRate');
  const debug = o.debug ? {} : null;

  // ---- Stage 1: onset strength -------------------------------------------------------------------------
  const on = createOnset(mono, sampleRate);
  const fps = on.fps;
  if (on.nf < fps * 4) return nullResult(debug); // under ~4 s: not enough to find a beat
  while (on.n < on.nf) {
    onsetChunk(on, Math.min(on.nf, on.n + ONSET_CHUNK_FRAMES));
    yield 0.4 * (on.n / on.nf);
  }
  const fLow = logFlux(on.eLow), fMid = logFlux(on.eMid), fHigh = logFlux(on.eHigh);
  const nf = on.nf;
  const ossT = new Float32Array(nf), ossP = new Float32Array(nf);
  for (let n = 0; n < nf; n++) {
    const p = fLow[n] + fMid[n];
    ossP[n] = p;
    ossT[n] = p + 0.5 * fHigh[n];
  }
  const half = Math.round(0.25 * fps);
  const oT = subtractLocalMean(ossT, half);
  const oP = subtractLocalMean(ossP, half);
  yield 0.45;

  // ---- Stage 2: tempo candidates from the comb over the global ACF ---------------------------------------
  const x2T = pairSum(oT, true);
  smoothGauss1(x2T);
  const fps2 = fps / 2;
  const maxLag = Math.min(x2T.length - 1, Math.ceil(4 * 60 * fps2 / o.searchMinBpm) + 3);
  if (maxLag < 8) return nullResult(debug);
  const A = new Float64Array(maxLag + 1);
  const lagsPerStep = Math.max(1, Math.floor(ACF_CHUNK_OPS / Math.max(1, x2T.length)));
  for (let L0 = 0; L0 <= maxLag; L0 += lagsPerStep) {
    acfRange(x2T, A, L0, Math.min(maxLag, L0 + lagsPerStep - 1));
    yield 0.45 + 0.15 * Math.min(1, (L0 + lagsPerStep) / (maxLag + 1));
  }
  const cands = combCandidates(A, fps2, o);
  if (debug) debug.comb = cands.map((c) => ({ bpm: c.bpm, score: c.score }));
  if (!cands.length) return nullResult(debug);

  // fold into [minBpm, 2*minBpm) and keep the strongest distinct ones
  const seeds = [];
  for (const c of cands) {
    const b = foldBpm(c.bpm, o.minBpm);
    if (seeds.some((s) => Math.abs(Math.log(s.bpm / b)) < 0.012)) continue;
    seeds.push({ bpm: b, score: c.score });
    if (seeds.length >= o.candidates) break;
  }

  // ---- Stages 3 + 4: refine every candidate, settle its octave, keep the best score --------------------------
  // The octave (backbeat) test runs per candidate, BEFORE scoring: at the wrong (slow) level a DnB groove has
  // little phase coherence (its backbeat snare sits on the slow grid's off-beat and cancels the kick), so a
  // slow-level score would be ~0 and could never compete with (or even reach) the octave test.
  const x2P = pairSum(oP, false);
  const ctx = { oP, x2P, fps, o, hiFlux: null, eHigh: on.eHigh };
  const evals = [];
  for (const s of seeds) {
    const ev = yield* evaluateCandidate(ctx, s.bpm, 0.6 + 0.3 * (evals.length / seeds.length));
    if (ev) evals.push(ev);
    yield 0.6 + 0.3 * (evals.length / seeds.length);
  }
  if (debug) {
    debug.candidates = evals.map((e) => ({ seed: e.seed, bpm: e.bpm, contrast: e.fold.contrast,
      coverage: e.pf.coverage, coherence: e.pf.coherence, peakFrac: e.fold.peakFrac, score: e.score,
      octave: e.octave }));
  }
  if (!evals.length) return nullResult(debug);
  let best = evals[0];
  for (const e of evals) {
    const tie = Math.abs(e.score - best.score) <= 0.03 * Math.max(e.score, best.score);
    if ((!tie && e.score > best.score) || (tie && e.pf.coherence > best.pf.coherence)) {
      best = e;
    }
  }
  if (debug) debug.octave = best.octave;
  const pf = best.pf;
  let bpm = pf.bpm;
  yield 0.95;

  // ---- Stage 5: beat map, steady vs variable tempo, per-beat refinement, snapping --------------------------
  // The beat map (stage 7) tracks the beat through the song with local folds (synchronous averaging, immune to
  // the arrangement bias of the Fourier phase: a syncopated bass or arp entering or leaving moves the windowed
  // Fourier phase by 10-60 ms between sections of a perfectly steady track). The map decides: when it stays
  // within a few ms of one straight grid the track is steady (constant grid, refined and snapped below), else it
  // is variable and the map itself is the grid (bpm = its average tempo). Without a usable map (short clips,
  // sparse rhythm) the old rule decides: phase residuals are only a suspicion, the per-beat onset regression
  // (onsets at every predicted beat on one straight line) settles it. The regression also refines the tempo of
  // steady tracks (+-0.005 BPM instead of +-0.02, up to a 1 % correction).
  const duration = mono.length / sampleRate;
  const fold0 = foldPhase(oP, fps, bpm);
  const hb0 = resolveHalfBeat(fold0, fLow, fMid, fps, bpm, half);
  const mapTrace = debug ? [] : null;
  const map = yield* trackBeatMap(oP, fps, bpm, (hb0.pos / FOLD_BINS) * (60 / bpm), 0.96, mapTrace);
  const mapTimes = map ? mapBeatTimes(map, duration) : null;
  const dev = map && mapTimes.length ? mapDeviation(mapTimes, map) : null;
  // the map decides when it covers enough of the song and followed the beat through most of the music (half of it
  // is enough to prove a steady tempo); a map that bends away from a straight grid must also line the onsets up
  // better than that grid does
  const drifts = !!dev && (dev.rmsMs > VAR_RMS_MS || dev.p95Ms > VAR_P95_MS);
  const minTracked = drifts ? MAP_MIN_TRACKED : MAP_MIN_TRACKED_STEADY;
  let mapDecides = !!dev && dev.span >= MAP_DECIDE_SPAN && map.tracked >= minTracked;
  const warped = mapDecides && drifts ? mapContrast(oP, fps, map) : 0;
  if (mapDecides && drifts && warped < Math.max(MAP_MIN_WARPED, fold0.contrast)) mapDecides = false;
  const reg = beatRegression(oP, fps, bpm, fold0.t0);
  const steadyBeats = !!reg && reg.kept >= STEADY_KEPT && reg.rmsMs <= STEADY_RMS_MS;
  const suspect = pf.nUsed >= 3 && (pf.residRmsMs > 12 || pf.residMaxMs > 40);
  const variable = mapDecides ? drifts : suspect && !steadyBeats;
  const useMap = variable && mapDecides;
  let refined = null;
  if (!variable && reg && Math.abs(reg.bpm - bpm) < (steadyBeats ? 0.01 : 0.002) * bpm) {
    refined = reg;
    bpm = reg.bpm;
  }
  let snapped = null;
  if (o.snap && !variable && pf.span >= 19.5) {
    const tol = (bpm * 0.008) / pf.span;
    for (const q of [1, 2]) {
      const c = Math.round(bpm * q) / q;
      if (Math.abs(c - bpm) < tol) {
        snapped = c;
        break;
      }
    }
    if (snapped !== null) bpm = snapped;
  }

  // ---- Stage 6: grid anchor, beats, confidence ---------------------------------------------------------------
  let firstBeat, beats, contrast, coverage, hb = null;
  if (useMap) {
    // drifting tempo: the map is the grid; firstBeat = its first beat >= 0; contrast once the drift is out
    bpm = dev.bpm;
    beats = mapTimes;
    firstBeat = beats[0];
    contrast = warped;
    coverage = Math.max(pf.coverage, map.nOk / map.nWin);
  } else {
    const fold = foldPhase(oP, fps, bpm);
    hb = resolveHalfBeat(fold, fLow, fMid, fps, bpm, half);
    const P = 60 / bpm;
    firstBeat = wrapPos((hb.pos / FOLD_BINS) * P - LATENCY_BIAS_SEC, P);
    beats = gridBeatTimes(bpm, firstBeat, duration);
    contrast = fold.contrast;
    coverage = pf.coverage;
  }
  const varFactor = useMap ? VAR_CONF_MAP : VAR_CONF;
  let confidence = clamp01((contrast - 0.3) / 0.5) * Math.min(1, coverage / 0.5) * (variable ? varFactor : 1);
  if (!(confidence > 0.001)) confidence = 0;
  if (debug) {
    Object.assign(debug, { fps, contrast, foldContrast: fold0.contrast, coverage, coherence: pf.coherence,
      residRmsMs: pf.residRmsMs, residMaxMs: pf.residMaxMs, span: pf.span, snapped, unsnapped: pf.bpm, refined,
      beats: reg, suspect, mapDecides,
      map: map ? { nOk: map.nOk, nWin: map.nWin, first: map.first, last: map.last, hopSec: map.hopSec,
        tracked: map.tracked } : null, warped,
      mapDev: dev, mapTimes, mapTrace,
      nWin: pf.nWin, nUsed: pf.nUsed, harmonic: pf.harmonic, halfBeat: hb || hb0 });
  }
  if (confidence === 0) return nullResult(debug);

  const alternatives = [];
  const addAlt = (b) => {
    if (!(b > 0) || !Number.isFinite(b)) return;
    if (Math.abs(Math.log(b / bpm)) < 0.01) return;
    if (alternatives.some((a) => Math.abs(Math.log(a / b)) < 0.01)) return;
    alternatives.push(b);
  };
  addAlt(bpm / 2);
  addAlt(bpm * 2);
  addAlt((bpm * 2) / 3);
  addAlt((bpm * 3) / 2);
  for (const e of evals) if (e !== best && e.score > 0.05) addAlt(e.bpm);

  const result = { bpm, firstBeat, confidence, variable, alternatives, beats };
  if (debug) result.debug = debug;
  return result;
}

// ------------------------------------------------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------------------------------------------------

function resolveOptions(opts) {
  const o = Object.assign({}, BEAT_DEFAULTS, opts || {});
  o.minBpm = clampNum(o.minBpm, 30, 200, BEAT_DEFAULTS.minBpm);
  o.maxBpm = clampNum(o.maxBpm, o.minBpm * 1.2, 400, Math.max(BEAT_DEFAULTS.maxBpm, o.minBpm * 2));
  o.searchMinBpm = Math.min(clampNum(o.searchMinBpm, 20, 200, 60), o.minBpm * 0.95);
  o.searchMaxBpm = Math.max(clampNum(o.searchMaxBpm, 60, 400, 200), o.minBpm * 2.1);
  o.candidates = Math.round(clampNum(o.candidates, 1, 6, 4));
  return o;
}

function clampNum(v, lo, hi, dflt) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  return v < lo ? lo : v > hi ? hi : v;
}

const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
const wrapPos = (x, m) => ((x % m) + m) % m;

function foldBpm(bpm, minBpm) {
  let b = bpm;
  while (b < minBpm) b *= 2;
  while (b >= 2 * minBpm) b /= 2;
  return b;
}

/** RBJ lowpass/highpass -> [k, a1, a2] (normalised by a0; b0 = b2 = k, b1 = +2k for LP, -2k for HP). */
function biquad(type, f0, q, fs) {
  const w0 = (2 * Math.PI * Math.min(f0, fs * 0.45)) / fs;
  const c = Math.cos(w0), al = Math.sin(w0) / (2 * q);
  const a0 = 1 + al;
  const k = (type === 'lp' ? (1 - c) / 2 : (1 + c) / 2) / a0;
  return [k, (-2 * c) / a0, (1 - al) / a0];
}

// ---- Stage 1 ---------------------------------------------------------------------------------------------

function createOnset(mono, sampleRate) {
  const D = Math.max(1, Math.round(sampleRate / TARGET_RATE));
  const fsd = sampleRate / D;
  const H = Math.max(16, Math.round((HOP_AT_TARGET * fsd) / TARGET_RATE));
  const nf = Math.floor(Math.floor(mono.length / D) / H);
  const q = Math.SQRT1_2;
  // RBJ lowpass/highpass have b2 = b0 and b1 = +-2 b0, so each section needs only [k = b0, a1, a2]
  const co = new Float64Array(12);
  co.set(biquad('lp', 150, q, fsd), 0);
  co.set(biquad('hp', 200, q, fsd), 3);
  co.set(biquad('lp', 2500, q, fsd), 6);
  co.set(biquad('hp', 2500, q, fsd), 9);
  return {
    mono, D, H, fsd, fps: fsd / H, nf, n: 0, co,
    st: new Float64Array(10), // transposed direct form II states: 5 sections x [s1, s2]
    eLow: new Float64Array(nf), eMid: new Float64Array(nf), eHigh: new Float64Array(nf),
  };
}

/** Band energies for frames [o.n, end). Filter states persist in o.st between chunks. */
function onsetChunk(o, end) {
  const H = o.H, co = o.co, st = o.st;
  const eLow = o.eLow, eMid = o.eMid, eHigh = o.eHigh;
  const lk = co[0], la1 = co[1], la2 = co[2];
  const mk = co[3], ma1 = co[4], ma2 = co[5];
  const nk = co[6], na1 = co[7], na2 = co[8];
  const hk = co[9], ha1 = co[10], ha2 = co[11];
  let a1 = st[0], a2 = st[1], b1 = st[2], b2 = st[3], c1 = st[4], c2 = st[5];
  let d1 = st[6], d2 = st[7], e1 = st[8], e2 = st[9];
  let src = o.mono, idx = o.n * H;
  if (o.D > 1) {
    // full-rate input: box-car decimate this chunk first (pcm.js normally hands over ~11 kHz already)
    const D = o.D, len = (end - o.n) * H, buf = new Float32Array(len);
    let j = idx * D;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let d = 0; d < D; d++) s += src[j++];
      buf[i] = s / D;
    }
    src = buf;
    idx = 0;
  }
  for (let n = o.n; n < end; n++) {
    let el = 0, em = 0, eh = 0;
    for (let k = 0; k < H; k++) {
      const x = src[idx++] || 0; // NaN (corrupt decode) -> 0
      // low: LP150 -> LP150
      let kx = lk * x;
      const ya = kx + a1;
      a1 = 2 * kx - la1 * ya + a2;
      a2 = kx - la2 * ya;
      kx = lk * ya;
      const yb = kx + b1;
      b1 = 2 * kx - la1 * yb + b2;
      b2 = kx - la2 * yb;
      el += yb * yb;
      // mid: HP200 -> LP2500
      kx = mk * x;
      const yc = kx + c1;
      c1 = c2 - 2 * kx - ma1 * yc;
      c2 = kx - ma2 * yc;
      kx = nk * yc;
      const yd = kx + d1;
      d1 = 2 * kx - na1 * yd + d2;
      d2 = kx - na2 * yd;
      em += yd * yd;
      // high: HP2500
      kx = hk * x;
      const ye = kx + e1;
      e1 = e2 - 2 * kx - ha1 * ye;
      e2 = kx - ha2 * ye;
      eh += ye * ye;
    }
    eLow[n] = el; eMid[n] = em; eHigh[n] = eh;
  }
  st[0] = a1; st[1] = a2; st[2] = b1; st[3] = b2; st[4] = c1;
  st[5] = c2; st[6] = d1; st[7] = d2; st[8] = e1; st[9] = e2;
  o.n = end;
}

/** 2-hop energy, log1p(100 E / mean E), lag-2 half-wave-rectified difference. */
function logFlux(s) {
  const nf = s.length;
  const E = new Float64Array(nf);
  let mean = 0;
  for (let n = 0; n < nf; n++) {
    E[n] = s[n] + (n ? s[n - 1] : 0);
    mean += E[n];
  }
  mean = mean / Math.max(1, nf);
  const out = new Float32Array(nf);
  if (!(mean > 1e-20)) return out; // digital silence in this band
  const g = 100 / mean;
  for (let n = 0; n < nf; n++) E[n] = Math.log1p(g * E[n]);
  for (let n = 2; n < nf; n++) {
    const d = E[n] - E[n - 2];
    out[n] = d > 0 ? d : 0;
  }
  return out;
}

/** Linear (not log) energy flux: keeps loud-vs-quiet hits apart for the backbeat test. */
function linFlux(s) {
  const n = s.length, d = new Float32Array(n);
  let prev2 = 0, prev1 = 0;
  for (let i = 0; i < n; i++) {
    const E = s[i] + (i ? s[i - 1] : 0);
    if (i >= 2) {
      const v = E - prev2;
      d[i] = v > 0 ? v : 0;
    }
    prev2 = prev1;
    prev1 = E;
  }
  return d;
}

/** x minus its centred moving average (+-half frames), half-wave rectified. */
function subtractLocalMean(x, half) {
  const n = x.length, c = new Float64Array(n + 1), y = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i + 1] = c[i] + x[i];
  for (let i = 0; i < n; i++) {
    const a = i - half > 0 ? i - half : 0;
    const b = i + half + 1 < n ? i + half + 1 : n;
    const v = x[i] - (c[b] - c[a]) / (b - a);
    y[i] = v > 0 ? v : 0;
  }
  return y;
}

// ---- Stage 2 ---------------------------------------------------------------------------------------------

/** Sum frames in pairs (halves the frame rate); optionally remove the mean. */
function pairSum(x, removeMean) {
  const n2 = x.length >> 1, y = new Float32Array(n2);
  let mean = 0;
  for (let i = 0; i < n2; i++) {
    const v = x[2 * i] + x[2 * i + 1];
    y[i] = v;
    mean += v;
  }
  if (removeMean && n2) {
    mean /= n2;
    for (let i = 0; i < n2; i++) y[i] -= mean;
  }
  return y;
}

/** In-place Gaussian smoothing, sigma = 1 sample (7 taps). */
function smoothGauss1(x) {
  const n = x.length;
  if (n < 7) return;
  const g0 = 0.39894, g1 = 0.24197, g2 = 0.05399, g3 = 0.00443;
  const src = Float32Array.from(x);
  for (let i = 0; i < n; i++) {
    let s = g0 * src[i];
    s += g1 * ((i >= 1 ? src[i - 1] : 0) + (i + 1 < n ? src[i + 1] : 0));
    s += g2 * ((i >= 2 ? src[i - 2] : 0) + (i + 2 < n ? src[i + 2] : 0));
    s += g3 * ((i >= 3 ? src[i - 3] : 0) + (i + 3 < n ? src[i + 3] : 0));
    x[i] = s;
  }
}

function acfRange(x, A, L0, L1) {
  const n = x.length;
  for (let L = L0; L <= L1; L++) {
    let s = 0;
    const end = n - L;
    for (let i = 0; i < end; i++) s += x[i] * x[i + L];
    A[L] = s;
  }
}

/**
 * Harmonic comb over the (normalised) ACF with a log-normal tempo prior. Each harmonic reads the parabolic
 * peak of A within +-1 lag of k * tau (robust to frame quantisation). Returns the top 6 local maxima.
 */
function combCandidates(A, fps2, o) {
  const maxLag = A.length - 1;
  const a0 = A[0];
  if (!(a0 > 0)) return [];
  const An = new Float64Array(maxLag + 1);
  for (let L = 0; L <= maxLag; L++) An[L] = A[L] / a0;
  const lin = (t) => {
    const i = Math.floor(t), f = t - i;
    if (i < 0 || i + 1 > maxLag) return 0;
    return An[i] * (1 - f) + An[i + 1] * f;
  };
  // value of the ACF peak nearest to lag t (searching +-1 lag), parabolic vertex when inside the window
  const peakNear = (t) => {
    const c = Math.round(t);
    if (c < 1 || c + 1 > maxLag) return lin(t);
    let bi = c;
    if (An[c - 1] > An[bi]) bi = c - 1;
    if (c + 1 <= maxLag && An[c + 1] > An[bi]) bi = c + 1;
    if (bi < 1 || bi + 1 > maxLag) return Math.max(An[bi], lin(t));
    const y0 = An[bi - 1], y1 = An[bi], y2 = An[bi + 1];
    const den = y0 - 2 * y1 + y2;
    if (!(den < 0)) return Math.max(y1, lin(t));
    const off = (0.5 * (y0 - y2)) / den;
    if (Math.abs(bi + off - t) > 1) return lin(t);
    return y1 - 0.25 * (y0 - y2) * off;
  };
  const tMin = (60 * fps2) / o.searchMaxBpm;
  const tMax = Math.min((60 * fps2) / o.searchMinBpm, (maxLag - 1) / 4);
  const step = 0.05;
  const taus = [], score = [];
  for (let t = tMin; t <= tMax; t += step) {
    const c = peakNear(t) + peakNear(2 * t) + peakNear(4 * t);
    const bpm = (60 * fps2) / t;
    const lp = Math.log2(bpm / o.priorCenter) / o.priorSigma;
    taus.push(t);
    score.push(Math.max(0, c) * Math.exp(-0.5 * lp * lp));
  }
  const cands = [];
  for (let i = 1; i < score.length - 1; i++) {
    if (score[i] > score[i - 1] && score[i] >= score[i + 1] && score[i] > 0) {
      const y0 = score[i - 1], y1 = score[i], y2 = score[i + 1], den = y0 - 2 * y1 + y2;
      const off = den !== 0 ? (0.5 * (y0 - y2)) / den : 0;
      const t = taus[i] + (off > -1 && off < 1 ? off : 0) * step;
      cands.push({ bpm: (60 * fps2) / t, score: y1 });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  return cands.slice(0, 6);
}

// ---- Stage 3 ---------------------------------------------------------------------------------------------

/**
 * Refine one folded candidate: zoomed DFT, phase regression, then (stage 4) when its double is still in range,
 * the backbeat test on the double-time grid; a backbeat on opposite slots moves the candidate up an octave
 * and it is refined again there. Scored at its final octave: foldContrast * coverage * peakFrac.
 */
function* evaluateCandidate(ctx, seedBpm, prog) {
  const { oP, x2P, fps, o } = ctx;
  const zb = yield* zoomTempo(x2P, fps / 2, seedBpm, true, prog);
  let pf = fitPhase(oP, fps, zb);
  if (!pf) return null;
  let octave = null;
  if (2 * pf.bpm <= o.maxBpm) {
    const fast = 2 * pf.bpm;
    if (!ctx.hiFlux) ctx.hiFlux = linFlux(ctx.eHigh);
    const bb = backbeatRatio(ctx.hiFlux, fps, fast, foldPhase(oP, fps, fast).t0);
    octave = { rho: bb.rho, slots: bb.v, fast: bb.rho > o.rhoFast };
    if (octave.fast) {
      const zf = yield* zoomTempo(x2P, fps / 2, fast, false, prog);
      const pf2 = fitPhase(oP, fps, zf);
      // no coherent windows at the fast level: keep the slow level's phase statistics at the fast tempo
      pf = pf2 && pf2.nUsed > 0 ? pf2 : Object.assign({}, pf, { bpm: zf });
    }
  }
  const fold = foldPhase(oP, fps, pf.bpm);
  return { seed: seedBpm, bpm: pf.bpm, pf, fold, octave, score: fold.contrast * pf.coverage * fold.peakFrac };
}

/**
 * Phase regression, two passes at the beat frequency. When that fundamental is weak (off-beats as strong as
 * the beats cancel it: loud off-beat bass, stabs, skank), the beat harmonic 2 (half-beat pulse) carries the
 * tempo instead, but only when the fold shows a clear beat structure (contrast >= 0.5): weak periodic
 * ripples (beating pad partials) must not pass as rhythm. The fold still decides on-beat vs off-beat.
 */
function fitPhase(x, fps, bpm) {
  let pf = phaseFit(x, fps, bpm, 1);
  if (pf) pf = phaseFit(x, fps, pf.bpm, 1) || pf;
  if (!pf || pf.coverage < 0.5) {
    let p2 = phaseFit(x, fps, bpm, 2);
    if (p2) p2 = phaseFit(x, fps, p2.bpm, 2) || p2;
    if (p2 && (!pf || p2.coverage > pf.coverage) && foldPhase(x, fps, p2.bpm).contrast >= 0.5) pf = p2;
  }
  return pf;
}

/** Power of harmonics 1 and 2 of the whole-track DFT at fHz (phasor recursion, renormalised). */
function combPower(x, fps, fHz) {
  const w1 = (2 * Math.PI * fHz) / fps, w2 = 2 * w1;
  const c1 = Math.cos(w1), s1 = Math.sin(w1), c2 = Math.cos(w2), s2 = Math.sin(w2);
  let pr = 1, pi = 0, qr = 1, qi = 0, re1 = 0, im1 = 0, re2 = 0, im2 = 0;
  const n = x.length;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    re1 += v * pr; im1 -= v * pi;
    re2 += v * qr; im2 -= v * qi;
    const t1 = pr * c1 - pi * s1; pi = pr * s1 + pi * c1; pr = t1;
    const t2 = qr * c2 - qi * s2; qi = qr * s2 + qi * c2; qr = t2;
    if ((i & 1023) === 1023) {
      const m1 = 1 / Math.sqrt(pr * pr + pi * pi), m2 = 1 / Math.sqrt(qr * qr + qi * qi);
      pr *= m1; pi *= m1; qr *= m2; qi *= m2;
    }
  }
  return re1 * re1 + im1 * im1 + re2 * re2 + im2 * im2;
}

/**
 * Maximise the harmonic-1+2 DFT power around bpm. The grid step is half the main-lobe width of harmonic 2 for
 * this track length (fine for long tracks, few evaluations for short ones); `wide` first scans +-1 %, then a
 * fine pass covers +-1 step in 13 evaluations with a parabolic vertex.
 */
function* zoomTempo(x, fps2, bpm, wide, prog) {
  const T = x.length / fps2;
  const lobe = 60 / (Math.max(1, T) * 2 * bpm);
  const step = Math.min(0.0025, Math.max(0.0002, lobe * 0.5));
  let b = bpm;
  if (wide) {
    const steps = Math.max(3, Math.min(48, Math.ceil(0.01 / step)));
    b = yield* zoomRefine(x, fps2, b, steps * step, steps, prog);
  }
  return yield* zoomRefine(x, fps2, b, step, 6, prog);
}

function* zoomRefine(x, fps, bpm, frac, steps, prog) {
  let best = -1, bi = 0, work = 0;
  const vals = new Float64Array(2 * steps + 1);
  for (let i = -steps; i <= steps; i++) {
    const p = combPower(x, fps, (bpm * (1 + (frac * i) / steps)) / 60);
    vals[i + steps] = p;
    if (p > best) {
      best = p;
      bi = i + steps;
    }
    work += x.length;
    if (work >= ZOOM_CHUNK_OPS) {
      work = 0;
      yield prog;
    }
  }
  let off = 0;
  if (bi > 0 && bi < vals.length - 1) {
    const y0 = vals[bi - 1], y1 = vals[bi], y2 = vals[bi + 1], den = y0 - 2 * y1 + y2;
    off = den !== 0 ? (0.5 * (y0 - y2)) / den : 0;
    if (!(off > -1 && off < 1)) off = 0;
  }
  return bpm * (1 + (frac * (bi - steps + off)) / steps);
}

const hannCache = new Map();
function hann(W) {
  let h = hannCache.get(W);
  if (!h) {
    h = new Float64Array(W);
    for (let j = 0; j < W; j++) h[j] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (j + 0.5)) / W);
    if (hannCache.size > 8) hannCache.clear();
    hannCache.set(W, h);
  }
  return h;
}

/**
 * Windowed Fourier phase of harmonic h of the beat frequency: 8 s Hann windows, unwrapped outward from the
 * strongest window, weighted line fit u = a + s t with outlier rejection. Returns the corrected tempo,
 * residuals (ms), coherence and coverage (share of windows that carry the beat).
 *
 * Window tiers. A window qualifies when its coherence r = |z| / sum(v) > 0.15, its |z| is >= 10 % of the
 * strongest window's, it holds more than a couple of onsets (neff) and sqrt(Rayleigh Z) = |z| / sqrt(sum v^2)
 * >= WIN_Z_WEAK. STRONG windows (Z >= WIN_Z_STRONG) stand on their own: their residuals reveal tempo drift.
 * WEAK windows count only where they agree with the phase line of the others: a slow, syncopated groove
 * (hip-hop at 84: ~11 beats per window, r ~ 0.5) rarely reaches the strong level, while random onsets in a
 * spoken intro or a breakdown reach the weak level with random phases and must neither count as beat
 * coverage nor flag a steady track as variable.
 */
function phaseFit(x, fps, bpm, h = 1) {
  const f = bpm / 60, fh = h * f; // beat frequency and the analysed harmonic
  const N = x.length;
  let W = Math.round(WIN_SEC * fps);
  if (W > N) W = N;
  if (W < Math.round(3 * fps)) return null;
  const Hh = Math.max(1, Math.round(WIN_HOP_SEC * fps));
  const win = hann(W);
  const w = (2 * Math.PI * fh) / fps, cw = Math.cos(w), sw = Math.sin(w);
  const wins = [];
  for (let s = 0; s + W <= N; s += Hh) {
    let cr = Math.cos(w * s), ci = Math.sin(w * s), re = 0, im = 0, S = 0, S2 = 0;
    for (let j = 0; j < W; j++) {
      const v = x[s + j] * win[j];
      re += v * cr;
      im -= v * ci;
      S += v;
      S2 += v * v;
      const t = cr * cw - ci * sw;
      ci = cr * sw + ci * cw;
      cr = t;
    }
    const mag = Math.sqrt(re * re + im * im);
    wins.push({
      t: (s + W / 2) / fps, beta: -Math.atan2(im, re) / (2 * Math.PI), mag, S,
      r: S > 0 ? mag / S : 0,
      z: S2 > 0 ? mag / Math.sqrt(S2) : 0,   // random phases give ~1-1.5 (onsets span a few frames)
      neff: S2 > 0 ? (S * S) / S2 : 0,       // effective number of onset frames in the window
      tier: 0, ok: false, u: 0,
    });
  }
  if (!wins.length) return null;
  let maxMag = 0;
  for (const v of wins) if (v.mag > maxMag) maxMag = v.mag;
  let top = 0;
  for (const v of wins) {
    if (maxMag > 0 && v.r > WIN_R_MIN && v.mag > 0.1 * maxMag && v.neff >= WIN_NEFF_MIN && v.z >= WIN_Z_WEAK) {
      v.tier = v.z >= WIN_Z_STRONG ? 2 : 1;
      if (v.tier > top) top = v.tier;
    }
  }
  const tol = PHASE_TOL_SEC * fh; // inlier tolerance in cycles of the analysed harmonic
  let a = 0, sl = 0, use = [];
  if (top > 0) {
    // unwrap the top tier outward from its strongest window, each relative to the previous top-tier window
    let anchor = -1;
    for (let i = 0; i < wins.length; i++) {
      if (wins[i].tier === top && (anchor < 0 || wins[i].mag > wins[anchor].mag)) anchor = i;
    }
    wins[anchor].u = wins[anchor].beta;
    for (const dir of [1, -1]) {
      let ref = wins[anchor].u;
      for (let i = anchor + dir; i >= 0 && i < wins.length; i += dir) {
        let d = wins[i].beta - ref;
        d -= Math.round(d);
        wins[i].u = ref + d;
        if (wins[i].tier === top) ref = wins[i].u;
      }
    }
    let fit = fitLine(wins.filter((v) => v.tier === top), tol);
    // strong windows always count; weak ones only on the line (unwrapped against it, not their neighbours)
    let nOk = 0;
    for (const v of wins) {
      if (v.tier === 2) {
        v.ok = true;
      } else if (v.tier === 1) {
        const p = fit.a + fit.sl * v.t;
        let d = v.beta - p;
        d -= Math.round(d);
        v.u = p + d;
        v.ok = Math.abs(d) < tol;
      }
      if (v.ok) nOk++;
    }
    if (top === 1 && nOk < 3) {
      // a couple of agreeing weak windows is not evidence of a beat (two points always fit a line)
      for (const v of wins) v.ok = false;
      nOk = 0;
    }
    if (nOk) fit = fitLine(wins.filter((v) => v.ok), tol);
    a = fit.a;
    sl = fit.sl;
    use = nOk ? fit.use : [];
  }
  // a tempo correction beyond 3 % means the fit latched onto something else: keep the input tempo
  if (Math.abs(sl) > 0.03 * fh) sl = 0;
  let rw = 0, rs = 0, rmax = 0, magSum = 0, sSum = 0, nOk = 0, tFirst = 0, tLast = 0;
  for (const v of wins) {
    if (!v.ok) continue;
    const res = ((v.u - a - sl * v.t) / fh) * 1000;
    rw += v.mag;
    rs += v.mag * res * res;
    if (Math.abs(res) > rmax) rmax = Math.abs(res);
    magSum += v.mag;
    sSum += v.S;
    if (!nOk) tFirst = v.t;
    tLast = v.t;
    nOk++;
  }
  const fNew = f - sl / h;
  return {
    bpm: 60 * fNew,
    harmonic: h,
    residRmsMs: Math.sqrt(rs / (rw || 1)),
    residMaxMs: rmax,
    coherence: sSum > 0 ? magSum / sSum : 0,
    coverage: nOk / wins.length,
    span: nOk ? tLast - tFirst : 0,
    nWin: wins.length,
    nUsed: use.length,
  };
}

/**
 * Weighted (by |z|) least squares u = a + s t over the windows `use`, with up to 3 passes that drop windows
 * further than `tol` cycles from the line (never below 3 windows). Returns { a, sl, use }.
 */
function fitLine(use, tol) {
  let a = use.length ? use[0].u : 0, sl = 0;
  for (let it = 0; it < 3 && use.length; it++) {
    let s0 = 0, st = 0, su = 0, stt = 0, stu = 0;
    for (const v of use) {
      const wt = v.mag;
      s0 += wt; st += wt * v.t; su += wt * v.u; stt += wt * v.t * v.t; stu += wt * v.t * v.u;
    }
    if (!(s0 > 0)) break;
    const den = s0 * stt - st * st;
    sl = use.length >= 2 && den > 1e-12 * s0 * s0 ? (s0 * stu - st * su) / den : 0;
    a = (su - sl * st) / s0;
    const keep = use.filter((v) => Math.abs(v.u - a - sl * v.t) < tol);
    if (keep.length === use.length || keep.length < 3) break;
    use = keep;
  }
  return { a, sl, use };
}

/**
 * Per-beat onset regression: at every predicted beat t0 + kP pick the strongest onset frame within a small
 * window (parabolic sub-frame position), then weighted least squares t = a + kP with outlier rejection
 * (> 15 ms). Two passes (window +-10 % of a beat, then +-6 % around the first fit). Picks below 25 % of the
 * mean pick strength (beats without a hit) are ignored. Returns null when fewer than 8 beats remain, else
 * { bpm, rmsMs (inliers), n (inliers), strong (picks with a hit), kept (n / strong) }: on a steady track the
 * line holds nearly every hit, on a drifting one the hits walk away from it.
 */
function beatRegression(x, fps, bpm, t0) {
  const N = x.length;
  let P = 60 / bpm, a = t0, fit = null;
  for (const win of [0.1, 0.06]) {
    const half = Math.max(1, Math.round(win * P * fps));
    const ks = [], ts = [], ws = [];
    const kFirst = Math.ceil((half / fps - a) / P), kLast = Math.floor(((N - 1 - half) / fps - a) / P);
    let peakSum = 0;
    for (let k = kFirst; k <= kLast; k++) {
      const c = Math.round((a + k * P) * fps);
      let bi = -1, bv = 0;
      for (let i = c - half; i <= c + half; i++) {
        if (x[i] > bv) {
          bv = x[i];
          bi = i;
        }
      }
      if (bi <= 0 || bi >= N - 1) continue;
      const y0 = x[bi - 1], y2 = x[bi + 1], den = y0 - 2 * bv + y2;
      const off = den < 0 ? (0.5 * (y0 - y2)) / den : 0;
      ks.push(k);
      ts.push((bi + off) / fps);
      ws.push(bv);
      peakSum += bv;
    }
    if (ks.length < 8) return null;
    const minW = 0.25 * (peakSum / ks.length);
    const strong = [];
    for (let i = 0; i < ks.length; i++) if (ws[i] >= minW) strong.push(i);
    let use = strong;
    fit = null;
    for (let it = 0; it < 4; it++) {
      if (use.length < 8) return null;
      let s0 = 0, sk = 0, st = 0, skk = 0, skt = 0;
      for (const i of use) {
        const w = ws[i], k = ks[i];
        s0 += w; sk += w * k; st += w * ts[i]; skk += w * k * k; skt += w * k * ts[i];
      }
      const den = s0 * skk - sk * sk;
      if (!(den > 0)) return null;
      const slope = (s0 * skt - sk * st) / den;
      const icpt = (st - slope * sk) / s0;
      const keep = strong.filter((i) => Math.abs(ts[i] - icpt - slope * ks[i]) < 0.015);
      let rs = 0, rw = 0;
      for (const i of keep) {
        rs += ws[i] * (ts[i] - icpt - slope * ks[i]) ** 2;
        rw += ws[i];
      }
      fit = { P: slope, a: icpt, rmsMs: rw > 0 ? Math.sqrt(rs / rw) * 1000 : Infinity, n: keep.length, strong: strong.length };
      if (keep.length === use.length && keep.every((v, j) => v === use[j])) break;
      use = keep;
    }
    if (!fit || !(fit.P > 0) || fit.n < 8) return null;
    P = fit.P;
    a = fit.a;
  }
  return { bpm: 60 / fit.P, rmsMs: fit.rmsMs, n: fit.n, strong: fit.strong, kept: fit.n / fit.strong };
}

// ---- Stage 4 ---------------------------------------------------------------------------------------------

/** Fold linear high-band flux on a 4-fast-beat cycle: rho = opposite slot / strongest slot. */
function backbeatRatio(x, fps, fastBpm, t0) {
  const f = fastBpm / 60, v = [0, 0, 0, 0];
  for (let n = 0; n < x.length; n++) {
    const pos = (n / fps - t0) * f, k = Math.round(pos);
    if (Math.abs(pos - k) < 0.12) v[((k % 4) + 4) % 4] += x[n];
  }
  let sm = 0;
  for (let i = 1; i < 4; i++) if (v[i] > v[sm]) sm = i;
  return { rho: v[sm] > 0 ? v[(sm + 2) % 4] / v[sm] : 0, v };
}

// ---- Stage 6 ---------------------------------------------------------------------------------------------

const FOLD_KERNEL = (() => {
  const g = [];
  for (let k = -4; k <= 4; k++) g.push(Math.exp(-0.5 * (k / 1.5) ** 2));
  return g;
})();

/** Beat-synchronous profile of x: raw (128 bins, linear splatting) and circularly Gaussian-smoothed. */
function foldProfile(x, fps, bpm) {
  const B = FOLD_BINS, prof = new Float64Array(B + 1);
  const dp = bpm / 60 / fps;
  let p = 0;
  for (let n = 0; n < x.length; n++) {
    const v = x[n];
    if (v !== 0) {
      const q = p * B, i = q < B ? q | 0 : B - 1, fr = q - i;
      prof[i] += v * (1 - fr);
      prof[i + 1] += v * fr;
    }
    p += dp;
    if (p >= 1) p -= Math.floor(p);
    // re-sync the running phase periodically to avoid accumulated rounding
    if ((n & 4095) === 4095) {
      p = (n + 1) * dp;
      p -= Math.floor(p);
    }
  }
  prof[0] += prof[B];
  const sm = new Float64Array(B);
  for (let i = 0; i < B; i++) {
    let s = 0;
    for (let k = -4; k <= 4; k++) s += prof[(i + k + B) % B] * FOLD_KERNEL[k + 4];
    sm[i] = s;
  }
  return { prof, sm };
}

/** Highest bin of a circular profile within +-radius bins of `center`, with a parabolic sub-bin position. */
function peakAround(sm, center, radius) {
  const B = sm.length;
  let bi = ((Math.round(center) % B) + B) % B;
  for (let d = -radius; d <= radius; d++) {
    const i = (((Math.round(center) + d) % B) + B) % B;
    if (sm[i] > sm[bi]) bi = i;
  }
  const y0 = sm[(bi - 1 + B) % B], y1 = sm[bi], y2 = sm[(bi + 1) % B], den = y0 - 2 * y1 + y2;
  const off = den < 0 ? (0.5 * (y0 - y2)) / den : 0;
  return { bin: bi, pos: wrapPos(bi + off, B), value: y1 };
}

/**
 * Synchronous average of x modulo the beat period: peak phase (t0 in [0, P)), contrast, peakFrac (share of
 * the onset mass within +-1/16 beat of the peak: separates the true period from 2:3 / 4:5 relatives whose
 * folds spread the same hits over several phases), plus the smoothed profile and its peak bin.
 */
function foldPhase(x, fps, bpm) {
  const B = FOLD_BINS, f = bpm / 60;
  const { prof, sm } = foldProfile(x, fps, bpm);
  let bi = 0;
  for (let i = 1; i < B; i++) if (sm[i] > sm[bi]) bi = i;
  const pk = peakAround(sm, bi, 0);
  const sorted = Array.from(sm).sort((a, b) => a - b);
  const med = sorted[B >> 1];
  let total = 0, near = 0;
  for (let i = 0; i < B; i++) {
    total += prof[i];
    let d = Math.abs(i - bi);
    if (d > B / 2) d = B - d;
    if (d <= B / 16) near += prof[i];
  }
  const y1 = sm[bi];
  return { t0: pk.pos / B / f, contrast: y1 > 0 ? (y1 - med) / y1 : 0, peakFrac: total > 0 ? near / total : 0, sm, bi };
}

/**
 * Half-beat check for the grid anchor. When the fold of ossP has a second peak half a beat from the main one
 * (>= 50 % of it: loud off-beat bass, stabs, organ, skank), the plain argmax is a coin flip. The beat is
 * where a kick is: an onset in BOTH the low band (body) and the mid band (click). Off-beat bass is low only,
 * stabs are mid only. Returns the anchor phase in bins and the evidence (for debug).
 */
function resolveHalfBeat(fold, fLow, fMid, fps, bpm, half) {
  const B = FOLD_BINS;
  const alt = peakAround(fold.sm, fold.bi + B / 2, B / 16);
  const main = peakAround(fold.sm, fold.bi, 0);
  if (!(alt.value >= 0.5 * main.value)) return { pos: main.pos, switched: false };
  const pl = foldProfile(subtractLocalMean(fLow, half), fps, bpm).sm;
  const pm = foldProfile(subtractLocalMean(fMid, half), fps, bpm).sm;
  const kick = (bin) => {
    const l = peakAround(pl, bin, 3).value, m = peakAround(pm, bin, 3).value;
    return Math.sqrt(Math.max(0, l) * Math.max(0, m));
  };
  const kMain = kick(main.bin), kAlt = kick(alt.bin);
  const switched = kAlt > 1.25 * kMain;
  return { pos: switched ? alt.pos : main.pos, switched, kMain, kAlt };
}

// ---- Stage 7: beat map ---------------------------------------------------------------------------------------

const MAP_WIN_BEATS = 16;       // local fold window (Hann), beats
const MAP_HOP_BEATS = 4;        // knot spacing, beats
const MAP_BINS = FOLD_BINS;     // fold bins per beat and smoothing as the global fold (same calibration)
const MAP_SEARCH_TRACK = 0.22;  // beats: first pass, peak search around the predicted phase (at most) ...
const MAP_SEARCH_STEP = 0.1;    // ... next to the last accepted window (+0.04 per window in between)
const MAP_SEARCH_REFINE = 0.1;  // beats: refinement passes
const MAP_MIN_CONTRAST = 0.7;   // window fold (peak - median) / peak (real music >= 0.84, pads and vocals 0.4-0.56)
const MAP_MIN_REL = 0.5;        // local peak / window max (an off-beat dominated window is not a beat)
const MAP_MIN_MASS = 0.25;      // window onset mass / median window mass (breakdowns carry no beat)
const MAP_MIN_NEFF = 8;         // effective onset frames per window (a few pad or vocal onsets are no beat)
const MAP_REFINE_PASSES = 2;

/**
 * Track the beat through the song: windows of 16 beats every 4 beats, each folded (synchronous averaging, not
 * the Fourier angle, which syncopation biases) in the coordinate of the current map, so the fold peak is the
 * local phase error of the map. The first pass follows the phase outward from the strongest window (search
 * +-0.22 beat around the extrapolated phase), refinement passes re-fold in the warped coordinate (+-0.1 beat).
 * Unreliable windows (breakdowns, off-beat dominated sections) are bridged by interpolation; the ends are
 * extrapolated with the local tempo of the nearest reliable stretch.
 * The map is the piecewise linear beat-index function u(t) given by knots U[j] at t = j * hopSec (onset time,
 * i.e. before the detector latency correction).
 * @returns {{U: Float64Array, hopSec: number, first: number, last: number, nOk: number, nWin: number,
 *   tFirst: number, tLast: number}|null} first/last: reliable windows, tFirst/tLast: their onset centroids (s)
 */
function* trackBeatMap(x, fps, bpm, t0, prog, trace = null) {
  const N = x.length, dur = N / fps;
  const P = 60 / bpm, hopSec = MAP_HOP_BEATS * P, half = (MAP_WIN_BEATS / 2) * P;
  const J = Math.ceil(dur / hopSec) + 1;
  if (J < 4) return null;
  const U = new Float64Array(J);
  for (let j = 0; j < J; j++) U[j] = (j * hopSec - t0) / P;
  const B = MAP_BINS;
  const sm = new Float64Array(J * B), mass = new Float64Array(J), gmax = new Float64Array(J), med = new Float64Array(J);
  const prof = new Float64Array(B), sortBuf = new Float64Array(B), mc = new Float64Array(4);
  const off = new Float64Array(J), wt = new Float64Array(J), ok = new Uint8Array(J), tc = new Float64Array(J);
  const neff = new Float64Array(J), pfrac = new Float64Array(J);

  // one fold pass over all windows (a generator: yields every 48 windows for the main-thread fallback)
  const foldAll = function* () {
    for (let j = 0; j < J; j++) {
      if (j && j % 48 === 0) yield prog;
      mapFold(x, fps, U, hopSec, j * hopSec, half, prof, sm, j * B, mc);
      mass[j] = mc[0];
      tc[j] = mc[1];
      neff[j] = mc[2];
      pfrac[j] = mc[3];
      let mx = 0;
      for (let i = 0; i < B; i++) {
        const v = sm[j * B + i];
        sortBuf[i] = v;
        if (v > mx) mx = v;
      }
      sortBuf.sort();
      gmax[j] = mx;
      med[j] = sortBuf[B >> 1];
    }
  };
  // windows with too little onset mass (breakdown, silence) never count
  const massRef = () => {
    const m = Array.from(mass).filter((v) => v > 0).sort((a, b) => a - b);
    return m.length ? m[m.length >> 1] : 0;
  };
  // local peak of window j near phase p (beats), within +-radius beats
  const localPeak = (j, p, radius) => {
    const o = j * B, c = Math.round(p * B), r = Math.max(1, Math.round(radius * B));
    let bi = c, bv = -1;
    for (let d = -r; d <= r; d++) {
      const v = sm[o + (((c + d) % B) + B) % B];
      if (v > bv) {
        bv = v;
        bi = c + d;
      }
    }
    const y0 = sm[o + (((bi - 1) % B) + B) % B], y2 = sm[o + (((bi + 1) % B) + B) % B], den = y0 - 2 * bv + y2;
    const fr = den < 0 ? (0.5 * (y0 - y2)) / den : 0;
    const contrast = gmax[j] > 0 ? (gmax[j] - med[j]) / gmax[j] : 0;
    const rel = gmax[j] > 0 ? bv / gmax[j] : 0;
    return { pos: (bi + (fr > -1 && fr < 1 ? fr : 0)) / B, contrast, rel, edge: Math.abs(bi - c) >= r };
  };
  const judge = (j, pk, mRef) => {
    const m = mRef > 0 ? mass[j] / mRef : 0;
    // debug trace: [window, mass ratio, effective onsets, contrast, rel, peak position]
    if (trace) trace.push([j, m, neff[j], pk.contrast, pk.rel, pk.pos, pfrac[j]]);
    const good = m >= MAP_MIN_MASS && neff[j] >= MAP_MIN_NEFF && pk.contrast >= MAP_MIN_CONTRAST &&
      pk.rel >= MAP_MIN_REL && !pk.edge;
    return good ? pk.contrast * pk.rel * Math.min(1, m) : 0;
  };

  // ---- pass 1: follow the phase outward from the strongest window
  yield* foldAll();
  yield prog;
  let mRef = massRef();
  let anchor = -1, best = 0;
  for (let j = 0; j < J; j++) {
    const w = judge(j, localPeak(j, 0, 0.25), mRef);
    if (w > best) {
      best = w;
      anchor = j;
    }
  }
  if (anchor < 0) return null;
  off[anchor] = localPeak(anchor, 0, 0.25).pos;
  wt[anchor] = best;
  ok[anchor] = 1;
  for (const dir of [1, -1]) {
    const hist = [anchor];
    for (let j = anchor + dir; j >= 0 && j < J; j += dir) {
      // the beat drifts by a few hundredths of a beat per window: a neighbour must stay close to the prediction
      // (a pad or vocal fold elsewhere in a breakdown must not pull the track away), wider across gaps
      const gap = Math.abs(j - hist[hist.length - 1]);
      const radius = Math.min(MAP_SEARCH_TRACK, MAP_SEARCH_STEP + 0.04 * (gap - 1));
      const pk = localPeak(j, predictOffset(hist, off, j), radius);
      const w = judge(j, pk, mRef);
      if (w > 0) {
        off[j] = pk.pos;
        wt[j] = w;
        ok[j] = 1;
        hist.push(j);
        if (hist.length > 4) hist.shift();
      }
    }
  }
  applyOffsets(U, off, wt, ok, tc, hopSec, bpm);

  // ---- refinement: fold in the warped coordinate, the peak is the remaining phase error
  for (let pass = 0; pass < MAP_REFINE_PASSES; pass++) {
    yield prog;
    yield* foldAll();
    mRef = massRef();
    for (let j = 0; j < J; j++) {
      const pk = localPeak(j, 0, MAP_SEARCH_REFINE);
      const w = judge(j, pk, mRef);
      off[j] = pk.pos;
      wt[j] = w;
      ok[j] = w > 0 ? 1 : 0;
    }
    applyOffsets(U, off, wt, ok, tc, hopSec, bpm);
  }
  let first = -1, last = -1, nOk = 0, nMusic = 0;
  for (let j = 0; j < J; j++) {
    if (mRef > 0 && mass[j] >= MAP_MIN_MASS * mRef) nMusic++;
    if (!ok[j]) continue;
    if (first < 0) first = j;
    last = j;
    nOk++;
  }
  if (nOk < 3) return null;
  straightenEdges(U, hopSec, tc[first], tc[last]);
  // tracked: share of the windows with music in them (not breakdowns or silence) that follow the beat
  return { U, hopSec, first, last, nOk, nWin: J, tFirst: tc[first], tLast: tc[last],
    tracked: nMusic > 0 ? Math.min(1, nOk / nMusic) : 0 };
}

/**
 * Before the first and after the last reliable window there is no beat to follow (drumless intro, fade-out):
 * continue the map there as a straight grid from the edge of the reliable stretch (the onset centroid of its
 * outermost window) with the tempo of the 8 beats next to it (limited to +-3 % of the fold tempo), so the
 * refinement passes cannot leave it bent.
 */
function straightenEdges(U, hopSec, tA, tB) {
  const J = U.length, nominal = MAP_HOP_BEATS / hopSec; // beats per second at the fold tempo
  const uAt = (t) => {
    let j = Math.floor(t / hopSec);
    j = j < 0 ? 0 : j > J - 2 ? J - 2 : j;
    return U[j] + (U[j + 1] - U[j]) * (t / hopSec - j);
  };
  const clampRate = (s) => (s < 0.97 * nominal ? 0.97 * nominal : s > 1.03 * nominal ? 1.03 * nominal : s);
  const span = Math.min(2 * hopSec, tB - tA);
  if (!(span > 0.25 * hopSec)) return;
  const uA = uAt(tA), uB = uAt(tB);
  const sA = clampRate((uAt(tA + span) - uA) / span), sB = clampRate((uB - uAt(tB - span)) / span);
  for (let j = 0; j < J && j * hopSec < tA; j++) U[j] = uA - sA * (tA - j * hopSec);
  for (let j = J - 1; j >= 0 && j * hopSec > tB; j--) U[j] = uB + sB * (j * hopSec - tB);
}

/** Phase prediction for window j from the last accepted windows `hist` (in order of acceptance). */
function predictOffset(hist, off, j) {
  const n = hist.length, jl = hist[n - 1];
  if (n < 2) return off[jl];
  // least-squares slope over the accepted history, damped and limited to 1.5 % tempo
  let s0 = 0, sj = 0, so = 0, sjj = 0, sjo = 0;
  for (const h of hist) {
    s0++;
    sj += h;
    so += off[h];
    sjj += h * h;
    sjo += h * off[h];
  }
  const den = s0 * sjj - sj * sj;
  let slope = den > 0 ? (s0 * sjo - sj * so) / den : 0;
  const lim = 0.015 * MAP_HOP_BEATS;
  slope = slope > lim ? lim : slope < -lim ? -lim : slope;
  // the slope is not carried further than 3 windows (across a breakdown the phase is searched more widely)
  const d = j - jl;
  return off[jl] + 0.7 * slope * (d > 3 ? 3 : d < -3 ? -3 : d);
}

/**
 * Knots minus the smoothed phase errors. A window's error belongs to the centroid of its onset mass (the
 * window centre for a full window; a window half in an intro or past the end measures the drums inside it).
 * Reliable windows are smoothed with their neighbours ([1 2 1], by weight), interpolated linearly in time
 * between centroids, and extrapolated past the first / last reliable window with the slope of the nearest
 * reliable stretch (local tempo, at most 1 % away from the fold tempo). Keeps U strictly increasing.
 */
function applyOffsets(U, off, wt, ok, tc, hopSec, bpm) {
  const J = U.length, pt = [], pd = [];
  for (let j = 0; j < J; j++) {
    if (!ok[j]) continue;
    let s = 2 * wt[j] * off[j], w = 2 * wt[j];
    if (j > 0 && ok[j - 1]) {
      s += wt[j - 1] * off[j - 1];
      w += wt[j - 1];
    }
    if (j + 1 < J && ok[j + 1]) {
      s += wt[j + 1] * off[j + 1];
      w += wt[j + 1];
    }
    const t = tc[j];
    if (pt.length && t < pt[pt.length - 1] + 0.1) continue; // centroids must increase
    pt.push(t);
    pd.push(w > 0 ? s / w : off[j]);
  }
  const n = pt.length;
  if (!n) return;
  const lim = (0.01 * bpm) / 60; // beats per second
  const edge = (from, dir) => {
    // slope (beats/s) over up to 4 reliable windows from the edge inward (the local tempo there)
    let s0 = 0, st = 0, sd = 0, stt = 0, std = 0;
    for (let i = from, c = 0; i >= 0 && i < n && c < 4; i += dir, c++) {
      s0++;
      st += pt[i];
      sd += pd[i];
      stt += pt[i] * pt[i];
      std += pt[i] * pd[i];
    }
    const den = s0 * stt - st * st;
    const sl = s0 >= 2 && den > 1e-9 ? (s0 * std - st * sd) / den : 0;
    return sl > lim ? lim : sl < -lim ? -lim : sl;
  };
  const sFirst = edge(0, 1), sLast = edge(n - 1, -1);
  let p = 0;
  for (let j = 0; j < J; j++) {
    const t = j * hopSec;
    let d;
    if (t <= pt[0]) d = pd[0] + sFirst * (t - pt[0]);
    else if (t >= pt[n - 1]) d = pd[n - 1] + sLast * (t - pt[n - 1]);
    else {
      while (p + 2 < n && pt[p + 1] < t) p++;
      d = pd[p] + ((pd[p + 1] - pd[p]) * (t - pt[p])) / (pt[p + 1] - pt[p]);
    }
    U[j] -= d;
  }
  const minStep = 0.5 * MAP_HOP_BEATS;
  for (let j = 1; j < J; j++) if (U[j] < U[j - 1] + minStep) U[j] = U[j - 1] + minStep;
}

/**
 * Hann-weighted fold of x over [c - half, c + half] in the beat coordinate u(t) of the knots U, circularly
 * smoothed into out[o .. o + MAP_BINS). res = [onset mass, its centroid time (s), effective onset frames].
 */
function mapFold(x, fps, U, hopSec, c, half, prof, out, o, res) {
  const B = MAP_BINS, J = U.length;
  prof.fill(0);
  const n0 = Math.max(0, Math.ceil((c - half) * fps)), n1 = Math.min(x.length - 1, Math.floor((c + half) * fps));
  // Hann weight 0.5 + 0.5 cos(pi (t - c) / half) by phasor rotation (no Math.cos per frame)
  const dw = Math.PI / half / fps, cd = Math.cos(dw), sd = Math.sin(dw);
  let cr = Math.cos((Math.PI / half) * (n0 / fps - c)), ci = Math.sin((Math.PI / half) * (n0 / fps - c));
  let mass = 0, mt = 0, m2 = 0;
  for (let n = n0; n <= n1; n++) {
    const v = x[n], hw = 0.5 + 0.5 * cr;
    const r = cr * cd - ci * sd;
    ci = cr * sd + ci * cd;
    cr = r;
    if (!(v > 0)) continue;
    const t = n / fps;
    let j = Math.floor(t / hopSec);
    if (j > J - 2) j = J - 2;
    const u = U[j] + (U[j + 1] - U[j]) * (t / hopSec - j);
    const w = v * (hw > 0 ? hw : 0);
    const q = (u - Math.floor(u)) * B;
    let i = q | 0;
    if (i >= B) i = B - 1;
    const fr = q - i;
    prof[i] += w * (1 - fr);
    prof[i + 1 < B ? i + 1 : 0] += w * fr;
    mass += w;
    mt += w * t;
    m2 += w * w;
  }
  for (let i = 0; i < B; i++) {
    let s = 0;
    for (let k = -4; k <= 4; k++) s += prof[(i + k + B) % B] * FOLD_KERNEL[k + 4];
    out[o + i] = s;
  }
  res[0] = mass;
  res[1] = mass > 0 ? mt / mass : c;
  res[2] = m2 > 0 ? (mass * mass) / m2 : 0;
  // share of the fold within +-1/16 beat of its peak (onsets: a narrow peak; pads and vocals: a broad hump)
  let bi = 0, tot = 0, near = 0;
  for (let i = 1; i < B; i++) if (out[o + i] > out[o + bi]) bi = i;
  for (let i = 0; i < B; i++) {
    tot += prof[i];
    let d = Math.abs(i - bi);
    if (d > B / 2) d = B - d;
    if (d <= B / 16) near += prof[i];
  }
  res[3] = tot > 0 ? near / tot : 0;
}

/** Beat times (s, detector latency removed) where the map's u(t) crosses an integer, from the first >= 0. */
function mapBeatTimes(map, duration) {
  const { U, hopSec } = map, J = U.length, out = [];
  for (let j = 0; j + 1 < J; j++) {
    const u0 = U[j], u1 = U[j + 1];
    for (let k = Math.ceil(u0); k < u1; k++) {
      const t = (j + (k - u0) / (u1 - u0)) * hopSec - LATENCY_BIAS_SEC;
      if (t >= 0 && t <= duration) out.push(t);
    }
  }
  return Float64Array.from(out);
}

/** Constant grid firstBeat + k * 60 / bpm over [0, duration]. */
function gridBeatTimes(bpm, firstBeat, duration) {
  const P = 60 / bpm, n = Math.max(0, Math.floor((duration - firstBeat) / P) + 1), out = new Float64Array(n);
  for (let k = 0; k < n; k++) out[k] = firstBeat + k * P;
  return out;
}

/**
 * How far the map strays from one straight grid over its reliable stretch: least-squares line through the
 * map beats there; RMS, 95th percentile and max distance (ms) of the residuals smoothed over +-8 beats.
 * bpm = beats per minute over that stretch (beat count / time, the average tempo of a drifting track),
 * lineBpm = the slope of the line.
 */
function mapDeviation(times, map) {
  const tA = map.tFirst - LATENCY_BIAS_SEC, tB = map.tLast - LATENCY_BIAS_SEC;
  let k0 = -1, k1 = -1;
  for (let k = 0; k < times.length; k++) {
    if (times[k] < tA) continue;
    if (times[k] > tB) break;
    if (k0 < 0) k0 = k;
    k1 = k;
  }
  if (k0 < 0 || k1 - k0 < 8) return null;
  let s0 = 0, sk = 0, st = 0, skk = 0, skt = 0;
  for (let k = k0; k <= k1; k++) {
    s0++;
    sk += k;
    st += times[k];
    skk += k * k;
    skt += k * times[k];
  }
  const den = s0 * skk - sk * sk;
  if (!(den > 0)) return null;
  const P = (s0 * skt - sk * st) / den, a = (st - P * sk) / s0;
  // residuals smoothed over +-8 beats: a drift is slow, window noise (humanized hits, arrangement) is not
  const n = k1 - k0 + 1, res = new Float64Array(n), cum = new Float64Array(n + 1), ad = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    res[k] = times[k0 + k] - a - P * (k0 + k);
    cum[k + 1] = cum[k] + res[k];
  }
  let rs = 0;
  for (let k = 0; k < n; k++) {
    const lo = Math.max(0, k - 8), hi = Math.min(n, k + 9), r = (cum[hi] - cum[lo]) / (hi - lo);
    rs += r * r;
    ad[k] = Math.abs(r);
  }
  ad.sort();
  const span = times[k1] - times[k0];
  return { bpm: (60 * (k1 - k0)) / span, lineBpm: 60 / P, rmsMs: Math.sqrt(rs / s0) * 1000,
    p95Ms: ad[Math.min(ad.length - 1, Math.floor(0.95 * ad.length))] * 1000, maxMs: ad[ad.length - 1] * 1000, span,
    n: k1 - k0 + 1 };
}

/** Contrast of the whole-track fold in the map's beat coordinate (how sharp the beat is once the drift is out). */
function mapContrast(x, fps, map) {
  const B = FOLD_BINS, prof = new Float64Array(B + 1), { U, hopSec } = map, J = U.length;
  for (let n = 0; n < x.length; n++) {
    const v = x[n];
    if (!(v > 0)) continue;
    const t = n / fps;
    let j = Math.floor(t / hopSec);
    if (j > J - 2) j = J - 2;
    const u = U[j] + (U[j + 1] - U[j]) * (t / hopSec - j);
    const q = (u - Math.floor(u)) * B;
    const i = q < B ? q | 0 : B - 1, fr = q - i;
    prof[i] += v * (1 - fr);
    prof[i + 1] += v * fr;
  }
  prof[0] += prof[B];
  const sm = new Float64Array(B);
  let bi = 0;
  for (let i = 0; i < B; i++) {
    let s = 0;
    for (let k = -4; k <= 4; k++) s += prof[(i + k + B) % B] * FOLD_KERNEL[k + 4];
    sm[i] = s;
    if (s > sm[bi]) bi = i;
  }
  const sorted = Array.from(sm).sort((a, b) => a - b);
  const y1 = sm[bi], md = sorted[B >> 1];
  return y1 > 0 ? (y1 - md) / y1 : 0;
}
