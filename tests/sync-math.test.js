// Tests for src/deck/sync-math.js: tempo match (incl. half/double), phase error wrap, align offset, bend clamp, and the
// beat-map helpers (beatsAt / timeOfBeat / phase on drifting tracks).
import {
  matchTempo, beatsAt, phaseError, alignOffset, correctionBend, timeOfBeat, gridBeatsAt, gridTimeOfBeat, beatLengthAt, cleanBeatMap,
} from '../src/deck/sync-math.js';

test('matchTempo: plain match', () => {
  const r = matchTempo(124, 128);
  assert.equal(r.multiplier, 1);
  assert.closeTo(r.rate, 128 / 124, 1e-12);
});

test('matchTempo: half and double time', () => {
  const d = matchTempo(70, 140); // hip-hop 70 against house 140: slave runs double -> rate 1
  assert.equal(d.multiplier, 0.5);
  assert.closeTo(d.rate, 1, 1e-12);
  const h = matchTempo(174, 87);
  assert.equal(h.multiplier, 2);
  assert.closeTo(h.rate, 1, 1e-12);
  const near = matchTempo(128, 66); // 66*2/128 = 1.031 beats 66/128 = 0.516
  assert.equal(near.multiplier, 2);
  assert.closeTo(near.rate, 132 / 128, 1e-12);
  // for tempo ratios up to 2*sqrt2 the chosen rate is always within [1/sqrt2, sqrt2]
  for (let s = 70; s <= 190; s += 7) {
    for (let l = 70; l <= 190; l += 11) {
      const { rate } = matchTempo(s, l);
      assert(rate >= Math.SQRT1_2 - 1e-9 && rate <= Math.SQRT2 + 1e-9, `rate ${rate} for ${s}/${l}`);
    }
  }
});

test('matchTempo: tie keeps multiplier 1; bad input -> rate 1', () => {
  const t = matchTempo(100, 100 * Math.SQRT2); // equal log distance for m=1 and m=0.5
  assert.equal(t.multiplier, 1);
  assert.deepEqual(matchTempo(0, 128), { rate: 1, multiplier: 1 });
  assert.deepEqual(matchTempo(128, null), { rate: 1, multiplier: 1 });
});

test('beatsAt', () => {
  assert.closeTo(beatsAt(10.5, 120, 0.5), 20, 1e-12);
  assert.closeTo(beatsAt(0, 120, 0.25), -0.5, 1e-12);
});

test('phaseError sign and wrap', () => {
  const leader = { pos: 10, bpm: 120, firstBeat: 0 }; // exactly on a beat
  assert.closeTo(phaseError({ pos: 20.1, bpm: 120, firstBeat: 0 }, leader), 0.2, 1e-9); // slave ahead
  assert.closeTo(phaseError({ pos: 19.9, bpm: 120, firstBeat: 0 }, leader), -0.2, 1e-9); // slave behind
  // 0.75 beat ahead wraps to 0.25 beat behind
  assert.closeTo(phaseError({ pos: 20.375, bpm: 120, firstBeat: 0 }, leader), -0.25, 1e-9);
  // exactly half a beat -> -0.5 (range is [-0.5, 0.5))
  assert.closeTo(phaseError({ pos: 20.25, bpm: 120, firstBeat: 0 }, leader), -0.5, 1e-9);
  // different bpms and anchors: slave 128 bpm on beat 7 + 0.1, leader 124 bpm on beat 3
  const sl = { pos: 0.2 + (7.1 * 60) / 128, bpm: 128, firstBeat: 0.2 };
  const ld = { pos: 0.05 + (3 * 60) / 124, bpm: 124, firstBeat: 0.05 };
  assert.closeTo(phaseError(sl, ld), 0.1, 1e-9);
});

test('phaseError with multipliers', () => {
  // leader at beat 2.5; slave double-time (m=2) should sit at frac(5.0) = 0
  const leader = { pos: 1.25, bpm: 120, firstBeat: 0 };
  assert.closeTo(phaseError({ pos: 3, bpm: 140, firstBeat: 0 }, leader, 2), 0, 1e-9);
  // half-time: leader beat 3 -> target frac(1.5) = 0.5
  const l3 = { pos: 1.5, bpm: 120, firstBeat: 0 };
  const e = phaseError({ pos: 0, bpm: 60, firstBeat: 0 }, l3, 0.5);
  assert.closeTo(Math.abs(e), 0.5, 1e-9);
});

test('alignOffset brings the phase error to zero and stays within half a beat', () => {
  const leader = { pos: 33.37, bpm: 126, firstBeat: 0.31 };
  for (const p of [10, 10.1, 10.2, 10.33, 10.47, 50.01]) {
    const slave = { pos: p, bpm: 122, firstBeat: 0.07 };
    const off = alignOffset(slave, leader, 1);
    assert(Math.abs(off) <= 30 / 122 + 1e-9);
    const after = phaseError({ ...slave, pos: p + off }, leader, 1);
    assert(Math.abs(after) < 1e-9 || Math.abs(Math.abs(after) - 1) < 1e-9, `after ${after}`);
  }
  const half = alignOffset({ pos: 0, bpm: 60, firstBeat: 0 }, { pos: 1.5, bpm: 120, firstBeat: 0 }, 0.5);
  assert(Math.abs(half) <= 0.5 + 1e-9);
});

test('correctionBend: proportional, opposite sign, clamped', () => {
  assert.closeTo(correctionBend(0.02), -0.005, 1e-12);
  assert.closeTo(correctionBend(-0.02), 0.005, 1e-12);
  assert.equal(correctionBend(0.4), -0.015);
  assert.equal(correctionBend(-0.4), 0.015);
  assert.equal(correctionBend(0), 0);
  assert.equal(Object.is(correctionBend(0), -0), false);
  assert.equal(correctionBend(0.1, 0.5, 0.02), -0.02);
  assert.equal(correctionBend(NaN), 0);
});

// ---- beat maps (docs/AUTOMIX.md 4.2) ---------------------------------------------------------------------------

/** A beat map for a tempo that ramps linearly from bpm0 to bpm1 over `seconds` (beats integrate the tempo). */
function rampMap(first, bpm0, bpm1, seconds) {
  const out = [];
  let t = first;
  while (t < seconds) {
    out.push(t);
    t += 60 / (bpm0 + ((bpm1 - bpm0) * t) / seconds);
  }
  return Float64Array.from(out);
}

test('beatsAt / timeOfBeat follow a beat map and extrapolate past its ends', () => {
  const map = rampMap(0.2, 120, 124, 200);
  const g = { bpm: 122, firstBeat: 0.2, beats: map };
  for (const k of [0, 1, 17, 100, map.length - 1]) {
    assert.closeTo(beatsAt(map[k], g.bpm, g.firstBeat, map), k, 1e-9);
    assert.closeTo(timeOfBeat(k, g.bpm, g.firstBeat, map), map[k], 1e-9);
  }
  // fractional in between
  assert.closeTo(beatsAt(0.5 * (map[10] + map[11]), 122, 0.2, map), 10.5, 1e-9);
  assert.closeTo(timeOfBeat(10.25, 122, 0.2, map), map[10] + 0.25 * (map[11] - map[10]), 1e-12);
  // before the map: the first beat length; after it: the last one
  const L0 = (map[16] - map[0]) / 16; // the local beat length at the start (16-beat average)
  assert.closeTo(beatsAt(0.2 - L0, 122, 0.2, map), -1, 1e-9);
  assert.closeTo(timeOfBeat(-2, 122, 0.2, map), 0.2 - 2 * L0, 1e-12);
  const n = map.length;
  const Ln = (map[n - 1] - map[n - 17]) / 16;
  assert.closeTo(timeOfBeat(n + 2, 122, 0.2, map), map[n - 1] + 3 * Ln, 1e-9);
  assert.closeTo(beatsAt(map[n - 1] + 0.5 * Ln, 122, 0.2, map), n - 0.5, 1e-9);
  // round trips anywhere
  for (let t = -1; t < 205; t += 3.7) assert.closeTo(timeOfBeat(beatsAt(t, 122, 0.2, map), 122, 0.2, map), t, 1e-9);
  // a map that starts later (drumless intro): indices continue the grid from firstBeat
  const late = map.subarray(40);
  assert.closeTo(beatsAt(map[50], 122, 0.2, late), 50, 1e-9);
  assert.closeTo(timeOfBeat(45, 122, 0.2, late), map[45], 1e-9);
  // no map (or a useless one): the constant grid
  assert.closeTo(beatsAt(10.5, 120, 0.5, null), 20, 1e-12);
  assert.closeTo(beatsAt(10.5, 120, 0.5, new Float64Array([3])), 20, 1e-12);
  assert.closeTo(timeOfBeat(20, 120, 0.5), 10.5, 1e-12);
  assert.closeTo(gridBeatsAt({ pos: 10.5, bpm: 120, firstBeat: 0.5 }), 20, 1e-12);
  assert.closeTo(gridTimeOfBeat({ bpm: 120, firstBeat: 0.5 }, 20), 10.5, 1e-12);
  assert.closeTo(beatLengthAt(map[30] + 0.01, 122, map), map[31] - map[30], 1e-12);
  assert.closeTo(beatLengthAt(5, 120, null), 0.5, 1e-12);
});

test('cleanBeatMap keeps good maps and drops broken ones', () => {
  const ok = cleanBeatMap([0.1, 0.6, 1.1]);
  assert(ok instanceof Float64Array);
  assert.equal(ok.length, 3);
  assert.equal(cleanBeatMap([0.1]), null);
  assert.equal(cleanBeatMap([0.1, 0.1, 0.5]), null);
  assert.equal(cleanBeatMap([0.1, NaN, 0.5]), null);
  assert.equal(cleanBeatMap(null), null);
  assert.equal(cleanBeatMap('abc'), null);
});

test('phase error and align offset on beat maps (drifting tracks)', () => {
  const lm = rampMap(0.1, 140, 141, 300); // leader drifts 140 -> 141
  const sm = rampMap(0.3, 139.5, 140.5, 300); // slave drifts too
  const leader = { pos: lm[200] + 0.3 * (lm[201] - lm[200]), bpm: 140.5, firstBeat: 0.1, beats: lm };
  for (const p of [20.01, 50.4, 111.11, 250.2]) {
    const slave = { pos: p, bpm: 140, firstBeat: 0.3, beats: sm };
    const off = alignOffset(slave, leader, 1);
    const after = phaseError({ ...slave, pos: p + off }, leader, 1);
    assert(Math.abs(after) < 1e-9, `after ${after}`);
    assert(Math.abs(off) <= 0.5 * 60 / 139 + 1e-9);
  }
  // the constant grid would be far off on these tracks; the map keeps the error near 0 at matching beats
  const slaveOnBeat = { pos: sm[150] + 0.3 * (sm[151] - sm[150]), bpm: 140, firstBeat: 0.3, beats: sm };
  assert(Math.abs(phaseError(slaveOnBeat, leader, 1)) < 1e-9);
  const gridErr = phaseError({ ...slaveOnBeat, beats: null }, { ...leader, beats: null }, 1);
  assert(Math.abs(gridErr) > 0.02, `grid error ${gridErr}`);
});

test('a jittery beat map that starts late still counts its beats from firstBeat', () => {
  // 141 BPM with +-8 ms jitter per beat, the map starts at beat 70 (after a drumless intro)
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const P = 60 / 141;
  const all = Float64Array.from({ length: 400 }, (_, k) => 0.12 + k * P + (k ? 0.008 * rnd() : 0));
  const map = all.subarray(70);
  for (const k of [70, 71, 200, 399]) assert.closeTo(beatsAt(all[k], 141, 0.12, map), k, 1e-9);
  assert.closeTo(beatsAt(0.12, 141, 0.12, map), 0, 0.05, 'the intro extrapolates back to beat 0');
});
