// Track loudness and auto-gain. Pure: no DOM, no Web Audio, safe in workers and JsCheck tests.
//
// Usage:
//   import { measureLoudness } from './loudness.js';
//   const { rmsDb, peakDb, gainDb } = measureLoudness(mono, 11025);
//   channelStrip.setTrimDb(gainDb + userTrimDb);
//
// rmsDb:  RMS of the audible part of the track (400 ms windows above -60 dBFS), dBFS.
// peakDb: largest |sample| of the analysis signal, dBFS. The decimated mono copy slightly under-reads true
//         stereo peaks; it is for display and the boost cap below, not for clip protection (the master limiter
//         does that).
// gainDb: brings the loud parts (90th percentile of 400 ms RMS windows, 100 ms hop) to -13 dBFS RMS, but never
//         lifts the peak above +2 dBFS (peakDb + gainDb <= 2: a quiet but spiky master is not pushed into the
//         limiter), then clamped to -12..+6 dB. Silence gets 0.
// Values are finite: silence reports SILENCE_DB (-100) instead of -Infinity, so results survive JSON storage.

export const SILENCE_DB = -100;
export const TARGET_RMS_DB = -13;
export const PEAK_CEILING_DB = 2;   // peakDb + gainDb never exceeds this
export const GAIN_MIN_DB = -12;
export const GAIN_MAX_DB = 6;
const GATE_DB = -60;          // windows quieter than this are silence, not "the track"
const WINDOW_SEC = 0.4;
const HOP_SEC = 0.1;

/**
 * Measure loudness and the auto-gain for a track.
 * @param {Float32Array} mono decimated mono samples
 * @param {number} sampleRate samples per second of `mono`
 * @returns {{rmsDb: number, peakDb: number, gainDb: number}}
 */
export function measureLoudness(mono, sampleRate) {
  if (!mono || typeof mono.length !== 'number') throw new TypeError('measureLoudness: mono must be a Float32Array');
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) throw new TypeError('measureLoudness: bad sampleRate');
  const N = mono.length;
  const hop = Math.max(1, Math.round(HOP_SEC * sampleRate));
  const blocksPerWin = Math.max(1, Math.round(WINDOW_SEC / HOP_SEC));
  const nBlocks = Math.ceil(N / hop);

  // energy per 100 ms block + peak
  const blockE = new Float64Array(nBlocks);
  let peak = 0;
  for (let b = 0, i = 0; b < nBlocks; b++) {
    const end = Math.min(N, i + hop);
    let s = 0;
    for (; i < end; i++) {
      const x = mono[i] || 0;
      s += x * x;
      const a = x < 0 ? -x : x;
      if (a > peak) peak = a;
    }
    blockE[b] = s;
  }

  // 400 ms windows (4 blocks) every 100 ms; a track shorter than one window is one window
  const nWin = nBlocks >= blocksPerWin ? nBlocks - blocksPerWin + 1 : nBlocks > 0 ? 1 : 0;
  const powers = [];
  const gate = Math.pow(10, GATE_DB / 10);
  let sumP = 0;
  for (let w = 0; w < nWin; w++) {
    const b1 = Math.min(nBlocks, w + blocksPerWin);
    let e = 0;
    for (let b = w; b < b1; b++) e += blockE[b];
    const samples = Math.min(N, b1 * hop) - w * hop;
    const p = samples > 0 ? e / samples : 0;
    if (p > gate) {
      powers.push(p);
      sumP += p;
    }
  }

  const peakDb = peak > 0 && Number.isFinite(peak) ? Math.max(SILENCE_DB, 20 * Math.log10(peak)) : SILENCE_DB;
  if (!powers.length) return { rmsDb: SILENCE_DB, peakDb, gainDb: 0 };
  const rmsDb = Math.max(SILENCE_DB, 10 * Math.log10(sumP / powers.length));
  powers.sort((a, b) => a - b);
  const p90 = powers[Math.min(powers.length - 1, Math.max(0, Math.ceil(0.9 * powers.length) - 1))];
  const loudDb = 10 * Math.log10(p90);
  let gainDb = TARGET_RMS_DB - loudDb;
  if (gainDb > PEAK_CEILING_DB - peakDb) gainDb = PEAK_CEILING_DB - peakDb;
  gainDb = gainDb < GAIN_MIN_DB ? GAIN_MIN_DB : gainDb > GAIN_MAX_DB ? GAIN_MAX_DB : gainDb;
  if (!Number.isFinite(gainDb)) gainDb = 0;
  return { rmsDb, peakDb, gainDb };
}
