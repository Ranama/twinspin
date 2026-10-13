// Pure beat-sync math used by SyncController (src/deck/sync.js), the Deck (beat helpers) and Auto Mix. No DOM,
// no Web Audio.
//   const { rate, multiplier } = matchTempo(slave.bpm, leader.effectiveBpm);   // slave.applySyncRate(rate)
//   const err = phaseError(slaveGrid, leaderGrid, multiplier);                 // beats, slave ahead > 0
//   slave.setBend(correctionBend(err), 'sync');  slave.seek(pos + alignOffset(slaveGrid, leaderGrid, m));
// A "grid" is { pos, bpm, firstBeat, beats? }: track position (s), ORIGINAL track bpm, the first grid beat (s)
// and optionally the beat map (BeatInfo.beats: the track time of every beat, following tempo drift).
// Positions are track time, so phase math does not depend on the playback rate.
//
// Beat indices: beat 0 is `firstBeat`, beat k is k beats later (fractional in between, negative before it).
// With a beat map the index follows the map; map beat i has index k0 + i where k0 = the number of beats from
// firstBeat to beats[0] (the map may start later than firstBeat, e.g. after a drumless intro). Outside the map
// the index is extrapolated with the local beat length at that end of the map (averaged over 16 beats).

import { clamp, wrapPhase } from '../core/util.js';

/** The tempo multipliers sync may use: the slave plays at half, the same or double the leader's beat rate. */
export const SYNC_MULTIPLIERS = Object.freeze([1, 0.5, 2]);

/**
 * Choose the playback rate that makes the slave's effective tempo match the leader, allowing half/double time.
 * multiplier is the slave's beats per leader beat; it is picked so the rate is closest to 1 (log distance);
 * ties keep 1.
 * @param {number} slaveBpm original bpm of the slave track
 * @param {number} leaderEffectiveBpm leader bpm * leader rate
 * @returns {{ rate: number, multiplier: number }}
 */
export function matchTempo(slaveBpm, leaderEffectiveBpm) {
  if (!(slaveBpm > 0) || !(leaderEffectiveBpm > 0)) return { rate: 1, multiplier: 1 };
  let best = 1;
  let bestDist = Infinity;
  for (const m of SYNC_MULTIPLIERS) {
    const d = Math.abs(Math.log((leaderEffectiveBpm * m) / slaveBpm));
    if (d < bestDist - 1e-12) {
      bestDist = d;
      best = m;
    }
  }
  return { rate: (leaderEffectiveBpm * best) / slaveBpm, multiplier: best };
}

/**
 * A usable beat map, or null: an array-like of at least 2 finite, strictly increasing times.
 * Cheap enough for every call (checks the ends only); use cleanBeatMap() once when storing a map.
 * @param {ArrayLike<number>|null|undefined} beats
 */
function usableMap(beats) {
  return beats && beats.length >= 2 && beats[beats.length - 1] > beats[0] ? beats : null;
}

/**
 * Validate a beat map once (when the analysis delivers it): a Float64Array of strictly increasing finite
 * times, or null when it is missing, too short or broken.
 * @param {ArrayLike<number>|null|undefined} beats
 * @returns {Float64Array|null}
 */
export function cleanBeatMap(beats) {
  if (!beats || typeof beats.length !== 'number' || beats.length < 2) return null;
  const n = beats.length;
  const out = new Float64Array(n);
  let prev = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = beats[i];
    if (!Number.isFinite(v) || v <= prev) return null;
    out[i] = v;
    prev = v;
  }
  return out;
}

/** Index of the last map beat at or before t (0 when t is before the map, n-1 after it). */
function mapIndex(beats, t) {
  let lo = 0;
  let hi = beats.length - 1;
  if (t <= beats[0]) return 0;
  if (t >= beats[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Beats averaged for the local beat length at an end of the map (smooths out per-beat jitter of the map). */
const EDGE_BEATS = 16;

/** Local beat length at the start (end = false) or the end of the map. */
function edgeLength(beats, end) {
  const n = beats.length;
  const m = Math.min(n - 1, EDGE_BEATS);
  return end ? (beats[n - 1] - beats[n - 1 - m]) / m : (beats[m] - beats[0]) / m;
}

/**
 * Grid index of the first map beat: beats from firstBeat, counted with the map's own local beat length (the
 * average bpm may be off there on a drifting song).
 */
export function mapFirstIndex(beats, firstBeat) {
  return Math.round((beats[0] - (firstBeat || 0)) / edgeLength(beats, false));
}

/**
 * Beats elapsed since the grid anchor (fractional, may be negative before firstBeat). With a beat map the
 * count follows the map (see the header); without one it is (pos - firstBeat) / (60 / bpm).
 * @param {number} pos track seconds
 * @param {number} bpm original bpm
 * @param {number} firstBeat seconds
 * @param {ArrayLike<number>|null} [beats] beat map
 */
export function beatsAt(pos, bpm, firstBeat, beats) {
  const map = usableMap(beats);
  if (!map) return ((pos - (firstBeat || 0)) * bpm) / 60;
  const n = map.length;
  const k0 = mapFirstIndex(map, firstBeat);
  if (pos <= map[0]) return k0 - (map[0] - pos) / edgeLength(map, false);
  if (pos >= map[n - 1]) return k0 + n - 1 + (pos - map[n - 1]) / edgeLength(map, true);
  const i = mapIndex(map, pos);
  return k0 + i + (pos - map[i]) / (map[i + 1] - map[i]);
}

/**
 * Inverse of beatsAt: the track time of (fractional) beat index k.
 * @param {number} k beat index (0 = firstBeat)
 * @param {number} bpm
 * @param {number} firstBeat
 * @param {ArrayLike<number>|null} [beats]
 */
export function timeOfBeat(k, bpm, firstBeat, beats) {
  const map = usableMap(beats);
  if (!map) return (firstBeat || 0) + (k * 60) / bpm;
  const n = map.length;
  const j = k - mapFirstIndex(map, firstBeat);
  if (j <= 0) return map[0] + j * edgeLength(map, false);
  if (j >= n - 1) return map[n - 1] + (j - (n - 1)) * edgeLength(map, true);
  const i = Math.floor(j);
  return map[i] + (j - i) * (map[i + 1] - map[i]);
}

/**
 * Local beat length (s of track time) around pos: the map interval there (outside the map the local length at
 * that end), else 60 / bpm.
 * @param {number} pos
 * @param {number} bpm
 * @param {ArrayLike<number>|null} [beats]
 */
export function beatLengthAt(pos, bpm, beats) {
  const map = usableMap(beats);
  if (!map) return 60 / bpm;
  const n = map.length;
  if (pos <= map[0]) return edgeLength(map, false);
  if (pos >= map[n - 1]) return edgeLength(map, true);
  const i = mapIndex(map, pos);
  return map[i + 1] - map[i];
}

/** beatsAt() for a grid object { pos, bpm, firstBeat, beats? } (at `pos`, default grid.pos). */
export function gridBeatsAt(grid, pos = grid.pos) {
  return beatsAt(pos, grid.bpm, grid.firstBeat, grid.beats);
}

/** timeOfBeat() for a grid object. */
export function gridTimeOfBeat(grid, k) {
  return timeOfBeat(k, grid.bpm, grid.firstBeat, grid.beats);
}

/**
 * Phase error of the slave against the leader, in slave beats, wrapped into [-0.5, 0.5).
 * Positive means the slave is ahead (its beat comes early). Target: frac(slaveBeats) = frac(leaderBeats * m).
 * @param {{pos:number,bpm:number,firstBeat:number,beats?:ArrayLike<number>|null}} slave
 * @param {{pos:number,bpm:number,firstBeat:number,beats?:ArrayLike<number>|null}} leader
 * @param {number} [multiplier=1]
 */
export function phaseError(slave, leader, multiplier = 1) {
  const s = gridBeatsAt(slave);
  const l = gridBeatsAt(leader) * multiplier;
  return wrapPhase(s - l);
}

/**
 * Seconds of SLAVE track time to add to the slave position so its beat phase matches the leader.
 * |offset| <= about half a slave beat (exactly half on a constant grid).
 */
export function alignOffset(slave, leader, multiplier = 1) {
  const err = phaseError(slave, leader, multiplier);
  if (!usableMap(slave.beats)) return (-err * 60) / slave.bpm;
  const k = gridBeatsAt(slave);
  return gridTimeOfBeat(slave, k - err) - slave.pos;
}

/**
 * Proportional phase correction: the temporary bend (additive speed offset) that pulls the slave back in phase.
 * Slave ahead (error > 0) -> negative bend. Clamped to +-max so corrections stay inaudible.
 * @param {number} errorBeats from phaseError()
 * @param {number} [kp=0.25] bend per beat of error
 * @param {number} [max=0.015]
 */
export function correctionBend(errorBeats, kp = 0.25, max = 0.015) {
  if (!Number.isFinite(errorBeats)) return 0;
  const b = clamp(-kp * errorBeats, -max, max);
  return b === 0 ? 0 : b; // no -0
}
