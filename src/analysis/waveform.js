// Waveform data for the deck displays (scrolling detail lanes and the whole-track overview). Pure: no DOM,
// no Web Audio, safe in workers and JsCheck tests.
//
// Usage:
//   import { buildWaveform } from './waveform.js';
//   const wf = buildWaveform(mono, 11025);   // mono: decimated mono Float32Array (src/audio/pcm.js)
//   wf.detail   -> { rate: 150, peak, low, high }  bin i covers track time [i / rate, (i + 1) / rate)
//   wf.overview -> { bins: 1000, peak, low, high } bin j covers [j, j + 1) * duration / bins
//   peak: Float32Array, loudest |sample| per bin, scaled so the loudest bin of the track is 1.
//   low / high: Float32Array 0..1, share of the bin's energy below ~200 Hz / above ~2.5 kHz (2nd-order IIR
//   splits), so a renderer can colour kicks/bass apart from hats. low + high <= 1; the rest is mids.
//
// One pass over the samples, two biquads per sample: ~4 M samples (6 min at 11 kHz) in ~20 ms in V8.

const LOW_HZ = 200;
const HIGH_HZ = 2500;

/**
 * Build detail and overview waveforms.
 * @param {Float32Array} mono decimated mono samples
 * @param {number} sampleRate samples per second of `mono`
 * @param {{detailRate?: number, overviewBins?: number}} [opts]
 * @returns {{detail: {rate: number, peak: Float32Array, low: Float32Array, high: Float32Array},
 *            overview: {bins: number, peak: Float32Array, low: Float32Array, high: Float32Array}}}
 */
export function buildWaveform(mono, sampleRate, { detailRate = 150, overviewBins = 1000 } = {}) {
  if (!mono || typeof mono.length !== 'number') throw new TypeError('buildWaveform: mono must be a Float32Array');
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) throw new TypeError('buildWaveform: bad sampleRate');
  const rate = detailRate > 0 && Number.isFinite(detailRate) ? Math.min(detailRate, sampleRate) : 150;
  const N = mono.length;
  const nDetail = N > 0 ? Math.ceil((N * rate) / sampleRate) : 0;
  let nOver = Math.max(1, Math.round(overviewBins > 0 && Number.isFinite(overviewBins) ? overviewBins : 1000));
  if (N === 0) nOver = 0;
  else if (nOver > N) nOver = N;

  const dPeak = new Float32Array(nDetail), dLow = new Float32Array(nDetail), dHigh = new Float32Array(nDetail);
  const oPeak = new Float32Array(nOver), oLow = new Float32Array(nOver), oHigh = new Float32Array(nOver);
  // energy accumulators: [total, low, high] per bin
  const dE = new Float64Array(nDetail * 3), oE = new Float64Array(nOver * 3);

  // Butterworth biquads, transposed direct form II. RBJ LP/HP: b0 = b2 = k, b1 = +-2k.
  const lp = coeffs('lp', LOW_HZ, sampleRate);
  const hp = coeffs('hp', HIGH_HZ, sampleRate);
  const lk = lp[0], la1 = lp[1], la2 = lp[2], hk = hp[0], ha1 = hp[1], ha2 = hp[2];
  let l1 = 0, l2 = 0, h1 = 0, h2 = 0;

  let maxAbs = 0;
  let di = 0, dEnd = nDetail > 0 ? binEnd(0, sampleRate, rate, N) : N;
  let oi = 0, oEnd = nOver > 0 ? Math.floor(N / nOver) : N;
  let dMax = 0, dT = 0, dL = 0, dH = 0;
  let oMax = 0, oT = 0, oL = 0, oH = 0;
  for (let i = 0; i < N; i++) {
    const x = mono[i] || 0; // NaN -> 0
    let kx = lk * x;
    const yl = kx + l1;
    l1 = 2 * kx - la1 * yl + l2;
    l2 = kx - la2 * yl;
    kx = hk * x;
    const yh = kx + h1;
    h1 = h2 - 2 * kx - ha1 * yh;
    h2 = kx - ha2 * yh;
    const a = x < 0 ? -x : x;
    const e = x * x, el = yl * yl, eh = yh * yh;
    if (a > dMax) dMax = a;
    dT += e; dL += el; dH += eh;
    if (a > oMax) oMax = a;
    oT += e; oL += el; oH += eh;
    if (i + 1 >= dEnd) {
      dPeak[di] = dMax;
      dE[di * 3] = dT; dE[di * 3 + 1] = dL; dE[di * 3 + 2] = dH;
      if (dMax > maxAbs) maxAbs = dMax;
      dMax = 0; dT = 0; dL = 0; dH = 0;
      di++;
      dEnd = di < nDetail ? binEnd(di, sampleRate, rate, N) : N + 1;
    }
    if (i + 1 >= oEnd) {
      oPeak[oi] = oMax;
      oE[oi * 3] = oT; oE[oi * 3 + 1] = oL; oE[oi * 3 + 2] = oH;
      oMax = 0; oT = 0; oL = 0; oH = 0;
      oi++;
      oEnd = oi < nOver ? Math.floor(((oi + 1) * N) / nOver) : N + 1;
    }
  }

  finish(dPeak, dLow, dHigh, dE, maxAbs);
  finish(oPeak, oLow, oHigh, oE, maxAbs);
  return {
    detail: { rate, peak: dPeak, low: dLow, high: dHigh },
    overview: { bins: nOver, peak: oPeak, low: oLow, high: oHigh },
  };
}

/** Last sample index (exclusive) of detail bin b: bins follow track time exactly, not a rounded hop. */
function binEnd(b, sampleRate, rate, N) {
  const e = Math.ceil(((b + 1) * sampleRate) / rate);
  return e < N ? e : N;
}

/** Normalise peaks to the track max and turn band energies into 0..1 shares (low + high <= 1). */
function finish(peak, low, high, E, maxAbs) {
  const n = peak.length;
  const inv = maxAbs > 0 ? 1 / maxAbs : 0;
  for (let i = 0; i < n; i++) {
    peak[i] = Math.min(1, peak[i] * inv);
    const t = E[i * 3];
    if (!(t > 1e-12)) continue; // silence: no colour
    let l = E[i * 3 + 1] / t, h = E[i * 3 + 2] / t;
    if (l > 1) l = 1;
    if (h > 1) h = 1;
    const s = l + h;
    if (s > 1) {
      l /= s;
      h /= s;
    }
    low[i] = l;
    high[i] = h;
  }
}

/** RBJ Butterworth (Q = 1/sqrt 2) LP/HP -> [k, a1, a2] with b0 = b2 = k, b1 = +-2k. */
function coeffs(type, f0, fs) {
  const w0 = (2 * Math.PI * Math.min(f0, fs * 0.45)) / fs;
  const c = Math.cos(w0), al = Math.sin(w0) / (2 * Math.SQRT1_2), a0 = 1 + al;
  const k = (type === 'lp' ? (1 - c) / 2 : (1 + c) / 2) / a0;
  return [k, (-2 * c) / a0, (1 - al) / a0];
}
