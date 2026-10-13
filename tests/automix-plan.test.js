// Tests for the pure Auto Mix planner (src/deck/automix-plan.js): musical bounds from a synthetic waveform, in/out
// points on bars and phrases (grid and beat map), short songs, songs without a BPM, the tempo modes (match / meet /
// cut, incl. half and double time), return durations, the crossfade S-curve and whole transitions.
import {
  musicalBounds, chooseInPoint, chooseOutPoint, lateOutPoint, planTempo, returnSeconds, crossfadeAt, planTransition,
  MATCH_MAX, MEET_MAX, transitionStyleOf, crossfadeSecondsOf, isBeatMatched, quickTransition, GAPLESS_FADE, QUICK_FADE,
} from '../src/deck/automix-plan.js';
import { beatsAt, timeOfBeat } from '../src/deck/sync-math.js';

const RATE = 150; // waveform detail bins per second (waveform.js default)

/**
 * Detail waveform: `lead` s of near silence, music (peaks alternating 1.0 / 0.6 like beats) until `fadeAt`, a linear
 * fade to 0 over `fade` s, then silence until `duration`. Optional single loud clicks in the silence.
 */
function synthWaveform({ duration, lead = 2, fadeAt, fade = 10, clicks = [] }) {
  const n = Math.round(duration * RATE);
  const peak = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    let v = 0.0005;
    const music = (i % 20 < 10 ? 1 : 0.6);
    if (t >= lead && t < fadeAt) v = music;
    else if (t >= fadeAt && t < fadeAt + fade) v = music * (1 - (t - fadeAt) / fade);
    peak[i] = v;
  }
  for (const c of clicks) peak[Math.round(c * RATE)] = 1;
  return { detail: { rate: RATE, peak, low: peak, high: peak }, overview: null };
}

const grid = (bpm, firstBeat = 0, extra = {}) => ({ bpm, firstBeat, beats: null, duration: 300, ...extra });

test('musicalBounds: skips leading silence, clicks and the fade tail', () => {
  const wf = synthWaveform({ duration: 120, lead: 2, fadeAt: 107, fade: 10, clicks: [0.7, 118.5] });
  const b = musicalBounds(wf, 120);
  assert.closeTo(b.start, 2, 0.02, `start ${b.start}`);
  // loud level ~0.8 (smoothed), -30 dB = 0.0253: the fade (music * (1 - x)) gets there near its end
  assert(b.end > 115 && b.end < 117.2, `end ${b.end}`);
  // without a waveform: the whole song
  assert.deepEqual(musicalBounds(null, 200), { start: 0, end: 200 });
  assert.deepEqual(musicalBounds({ detail: { rate: 150, peak: new Float32Array(0) } }, 50), { start: 0, end: 50 });
  // all silence: the whole song
  const quiet = { detail: { rate: RATE, peak: new Float32Array(150 * 30) } };
  assert.deepEqual(musicalBounds(quiet, 30), { start: 0, end: 30 });
  // a song that starts right away keeps 0
  const full = synthWaveform({ duration: 60, lead: 0, fadeAt: 60 });
  const f = musicalBounds(full, 60);
  assert.closeTo(f.start, 0, 1e-9);
  assert.closeTo(f.end, 60, 0.01);
  // a higher threshold trims the fade more
  const strict = musicalBounds(wf, 120, { thresholdDb: -10 });
  assert(strict.end < b.end - 2, `strict end ${strict.end}`);
});

test('chooseInPoint: first beat at the music, rounded down to a bar when that bar is close', () => {
  const t = grid(120, 0.1); // beats at 0.1 + 0.5 k, bars at k = 0, 4, 8 ...
  assert.closeTo(chooseInPoint(t, { start: 2.0, end: 200 }), 2.1, 1e-9); // beat 4 = a bar
  assert.closeTo(chooseInPoint(t, { start: 2.3, end: 200 }), 2.6, 1e-9); // beat 5; bar 4 (2.1) is too early
  assert.closeTo(chooseInPoint(t, { start: 2.15, end: 200 }), 2.1, 1e-9); // bar 4 is within 0.1 s
  assert.closeTo(chooseInPoint(t, { start: 0, end: 200 }), 0.1, 1e-9);
  assert.closeTo(chooseInPoint(t, null), 0.1, 1e-9);
  // no bpm: where the music starts
  assert.equal(chooseInPoint({ bpm: null, duration: 100 }, { start: 3.3, end: 90 }), 3.3);
  // a beat map: beats every 0.5 s but 20 ms late from beat 3 on
  const beats = Float64Array.from({ length: 40 }, (_, k) => 0.1 + 0.5 * k + (k >= 3 ? 0.02 : 0));
  const m = grid(120, 0.1, { beats });
  assert.closeTo(chooseInPoint(m, { start: 1.63, end: 100 }), beats[4], 1e-9); // beat 4 (2.12) is a bar
  assert.closeTo(chooseInPoint(m, { start: 1.55, end: 100 }), beats[3], 1e-9); // beat 3 at 1.62; bar 0 far away
});

test('chooseOutPoint: on a phrase within 8 beats of the latest bar, else on that bar', () => {
  const t = grid(128, 0, { duration: 300 });
  // music ends at 290 s: last beat 618; latest start for 32 beats = 586 -> bar 584 -> phrase 576 (8 beats away)
  let o = chooseOutPoint(t, 32, { start: 0, end: 290 });
  assert.equal(o.beats, 32);
  assert.equal(o.beat, 576);
  assert.closeTo(o.at, (576 * 60) / 128, 1e-9);
  assert(o.beat + o.beats <= beatsAt(290, 128, 0) + 1e-9, 'the mix ends before the music does');
  // music ends so that the latest bar is 12 beats past a phrase: the bar wins
  const end = (604 * 60) / 128 + 0.01; // last beat 604 -> latest 572 -> bar 572, phrase 560 (12 beats)
  o = chooseOutPoint(t, 32, { start: 0, end });
  assert.equal(o.beat, 572);
  assert.equal(o.beat % 4, 0);
  // 16 and 64 beats
  o = chooseOutPoint(t, 64, { start: 0, end: 290 });
  assert.equal(o.beats, 64);
  assert.equal(o.beat % 16, 0);
  assert(o.beat + 64 <= 618);
  o = chooseOutPoint(t, 16, { start: 0, end: 290 });
  assert.equal(o.beats, 16);
  assert(o.beat + 16 <= 618 && o.beat >= 618 - 16 - 12);
});

test('chooseOutPoint: short songs get shorter mixes, never before the in-point + 16 beats', () => {
  const t30 = grid(120, 0, { duration: 30 }); // 60 beats of music
  let o = chooseOutPoint(t30, 64, { start: 0, end: 30 });
  assert.equal(o.beats, 32);
  assert.equal(o.beat, 28); // latest 28 -> bar 28 (phrase 16 is 12 away)
  o = chooseOutPoint(grid(120, 0, { duration: 12 }), 32, { start: 0, end: 12 }); // 24 beats
  assert.equal(o.beats, 8);
  assert.equal(o.beat, 16);
  assert.closeTo(o.at, 8, 1e-9);
  o = chooseOutPoint(grid(120, 0, { duration: 10 }), 32, { start: 0, end: 10 }); // 20 beats: 16 + 4
  assert.equal(o.beat, 16);
  assert.equal(o.beats, 4);
  o = chooseOutPoint(grid(120, 0, { duration: 5 }), 32, { start: 0, end: 5 }); // shorter than 16 beats
  assert.equal(o.beat, 0);
  assert.equal(o.beats, 8);
  // the in-point counts: music from 60 s on, 70 s song at 120 BPM -> in at beat 120, out not before 136
  o = chooseOutPoint(grid(120, 0, { duration: 70 }), 32, { start: 60, end: 70 });
  assert(o.beat >= 136, `beat ${o.beat}`);
});

test('chooseOutPoint and lateOutPoint without a BPM, and lateOutPoint on bars', () => {
  assert.deepEqual(chooseOutPoint({ bpm: null, duration: 200 }, 32, { start: 1, end: 190 }), { at: 182, beats: 0, beat: null });
  assert.deepEqual(chooseOutPoint({ bpm: null, duration: 6 }, 32, { start: 1, end: 6 }), { at: 1, beats: 0, beat: null });
  assert.deepEqual(lateOutPoint({ bpm: null, duration: 200 }, 32, { start: 0, end: 200 }, 50.5), { at: 50.5, beats: 0, beat: null });
  const t = grid(120, 0.2, { duration: 200 });
  let o = lateOutPoint(t, 32, { start: 0, end: 200 }, 50.3); // beat 100.2 -> bar 104
  assert.equal(o.beat, 104);
  assert.closeTo(o.at, 0.2 + 52, 1e-9);
  assert.equal(o.beats, 32);
  o = lateOutPoint(t, 64, { start: 0, end: 200 }, 170); // ~ 60 beats left -> 32
  assert.equal(o.beats, 32);
  o = lateOutPoint(t, 32, { start: 0, end: 200 }, 196); // 7 beats left -> 4
  assert.equal(o.beats, 4);
});

test('planTempo: match, meet, cut and half / double time', () => {
  let p = planTempo(128, 125);
  assert.equal(p.mode, 'match');
  assert.equal(p.multiplier, 1);
  assert.closeTo(p.nextStartRate, 128 / 125, 1e-12);
  assert.equal(p.curTargetRate, 1);
  assert.equal(p.preRampBeats, 0);
  assert.closeTo(p.returnSeconds, returnSeconds(125, 128 / 125), 1e-12);
  // the current song plays at +2 %: its effective tempo counts, its rate is kept
  p = planTempo(128 * 1.02, 128, { curRate: 1.02 });
  assert.equal(p.mode, 'match');
  assert.closeTo(p.nextStartRate, 1.02, 1e-12);
  assert.closeTo(p.curTargetRate, 1.02, 1e-12);
  // 8.6 % apart: meet half way in log space
  p = planTempo(128, 140);
  assert.equal(p.mode, 'meet');
  const meet = Math.sqrt(128 * 140);
  assert.closeTo(p.meetBpm, meet, 1e-9);
  assert.closeTo(p.curTargetRate, meet / 128, 1e-12);
  assert.closeTo(p.nextStartRate, meet / 140, 1e-12);
  assert.equal(p.preRampBeats, 16);
  assert.closeTo(128 * p.curTargetRate, 140 * p.nextStartRate, 1e-9, 'both play the meet tempo');
  // no time for a pre-ramp: the next song simply matches
  p = planTempo(128, 140, { noPreRamp: true });
  assert.equal(p.mode, 'match');
  assert.closeTo(p.nextStartRate, 128 / 140, 1e-12);
  // too far apart (27 %) or unknown: cut, next at its own tempo
  for (const q of [planTempo(128, 175), planTempo(null, 128), planTempo(128, null), planTempo(128, 0)]) {
    assert.equal(q.mode, 'cut');
    assert.equal(q.nextStartRate, 1);
    assert.equal(q.returnSeconds, 0);
    assert.equal(q.meetBpm, null);
  }
  // half time: 140 into 72 -> the next song's beats run at half the rate (multiplier 0.5), 70/72 -> match
  p = planTempo(140, 72);
  assert.equal(p.mode, 'match');
  assert.equal(p.multiplier, 0.5);
  assert.closeTo(p.nextStartRate, 70 / 72, 1e-12);
  // double time: 87 into 174
  p = planTempo(87, 174);
  assert.equal(p.multiplier, 2);
  assert.closeTo(p.nextStartRate, 1, 1e-12);
  assert.equal(p.returnSeconds, 0);
  // meet across half time: 140 into 64 (64*2 = 128, 9 % apart)
  p = planTempo(140, 64);
  assert.equal(p.mode, 'meet');
  assert.equal(p.multiplier, 0.5);
  assert.closeTo(140 * p.curTargetRate, (64 * p.nextStartRate) / 0.5, 1e-9);
  // the borders
  assert.equal(planTempo(100, 100 / (1 + MATCH_MAX * 0.99)).mode, 'match');
  assert.equal(planTempo(100, 100 / (1 + MATCH_MAX * 1.05)).mode, 'meet');
  assert.equal(planTempo(100, 100 / (1 + MEET_MAX * 0.99)).mode, 'meet');
  assert.equal(planTempo(100, 100 / (1 + MEET_MAX * 1.05)).mode, 'cut');
});

test('returnSeconds: about 1 % per 8 beats, 16..64 beats, at the start tempo', () => {
  assert.equal(returnSeconds(125, 1), 0);
  assert.closeTo(returnSeconds(125, 1.024), (19.2 * 60) / (125 * 1.024), 1e-9);
  assert.closeTo(returnSeconds(120, 1.005), (16 * 60) / (120 * 1.005), 1e-9); // min 16 beats
  assert.closeTo(returnSeconds(120, 0.9), (64 * 60) / (120 * 0.9), 1e-9); // max 64 beats
  assert.equal(returnSeconds(null, 1.1), 0);
});

test('crossfadeAt: an S-curve from -1 to +1', () => {
  assert.equal(crossfadeAt(0), -1);
  assert.equal(crossfadeAt(1), 1);
  assert.closeTo(crossfadeAt(0.5), 0, 1e-12);
  assert.closeTo(crossfadeAt(0.25), -Math.SQRT1_2, 1e-12);
  assert.equal(crossfadeAt(-3), -1);
  assert.equal(crossfadeAt(7), 1);
  let prev = -2;
  for (let i = 0; i <= 50; i++) {
    const x = crossfadeAt(i / 50);
    assert(x >= prev, 'monotonic');
    prev = x;
  }
  assert.closeTo(crossfadeAt(0.5, 1, -1), 0, 1e-12); // B -> A
  assert.equal(crossfadeAt(0, 1, -1), 1);
  // slow at the ends (an S): the first 10 % moves less than 3 % of the way
  assert(crossfadeAt(0.1) + 1 < 0.06);
});

test('planTransition: a matched mix on a phrase, bars aligned, bass swap half way', () => {
  const curWf = synthWaveform({ duration: 240, lead: 0, fadeAt: 228, fade: 6 });
  const nextWf = synthWaveform({ duration: 200, lead: 1.3, fadeAt: 190, fade: 6 });
  const cur = { bpm: 128, firstBeat: 0.05, duration: 240, waveform: curWf, rate: 1 };
  const next = { bpm: 125, firstBeat: 0.2, duration: 200, waveform: nextWf };
  const plan = planTransition(cur, next, { mixBeats: 32, automixReturn: true, automixBassSwap: true });
  assert.equal(plan.mode, 'match');
  assert.equal(plan.multiplier, 1);
  assert.equal(plan.beats, 32);
  assert.equal(plan.out.beats, 32);
  assert.equal(plan.out.beat % 4, 0, 'out on a bar');
  assert.closeTo(plan.out.at, 0.05 + (plan.out.beat * 60) / 128, 1e-9);
  assert(plan.out.at + (32 * 60) / 128 <= plan.curBounds.end + 1e-6, 'the mix is over before the music ends');
  assert.equal(plan.in.beat % 4, 0, 'in on a bar');
  assert.closeTo(plan.in.at, 0.2 + (plan.in.beat * 60) / 125, 1e-9);
  // the music starts on beat 3: the next song starts at the bar before (beat 0) so the bars line up
  assert(plan.in.at >= plan.nextBounds.start - (4 * 60) / 125 && plan.in.at <= plan.nextBounds.start + 0.1, `in ${plan.in.at}`);
  assert.closeTo(plan.fadeSec, (32 * 60) / 128, 1e-9);
  assert.equal(plan.bassSwap, true);
  assert.equal(plan.bassSwapBeat, 16);
  assert.equal(plan.echoOut, false);
  assert.equal(plan.late, false);
  assert.closeTo(plan.tempo.nextStartRate, 128 / 125, 1e-12);
  assert(plan.tempo.returnSeconds > 0);
  // settings: no ease back, no bass swap, 16 beats; also a Settings-like object with get()
  const s = new Map([['mixBeats', 16], ['automixReturn', false], ['automixBassSwap', false]]);
  const p2 = planTransition(cur, next, { get: (k) => s.get(k) });
  assert.equal(p2.beats, 16);
  assert.equal(p2.tempo.returnSeconds, 0);
  assert.equal(p2.bassSwap, false);
  assert.closeTo(p2.fadeSec, (16 * 60) / 128, 1e-9);
  // an odd mix length falls back to 32
  assert.equal(planTransition(cur, next, { mixBeats: 20 }).beats, 32);
});

test('planTransition: meet, cut, no-BPM and late plans', () => {
  const cur = { bpm: 128, firstBeat: 0, duration: 240, rate: 1 };
  // meet: the mix length is measured at the meet tempo
  const meet = planTransition(cur, { bpm: 140, firstBeat: 0, duration: 200 }, { mixBeats: 32 });
  assert.equal(meet.mode, 'meet');
  assert.equal(meet.tempo.preRampBeats, 16);
  assert.closeTo(meet.fadeSec, (32 * 60) / 128 / meet.tempo.curTargetRate, 1e-9);
  // cut: tempos too far apart -> an 8-beat blend with an echo out, next at rate 1, no bass swap
  const cut = planTransition(cur, { bpm: 90, firstBeat: 0, duration: 200 }, { mixBeats: 64 });
  assert.equal(cut.mode, 'cut');
  assert.equal(cut.beats, 8);
  assert.equal(cut.echoOut, true);
  assert.equal(cut.bassSwap, false);
  assert.equal(cut.tempo.nextStartRate, 1);
  assert(cut.out.beat + 8 <= beatsAt(240, 128, 0) + 1e-9);
  // the next song has no BPM: cut, in-point where its music starts
  const nb = planTransition(cur, { bpm: null, duration: 200, waveform: synthWaveform({ duration: 200, lead: 3, fadeAt: 195 }) }, {});
  assert.equal(nb.mode, 'cut');
  assert.equal(nb.in.beat, null);
  assert.closeTo(nb.in.at, 3, 0.02);
  // the current song has no BPM: a 6 s blend 8 s before its end
  const cb = planTransition({ bpm: null, duration: 180, rate: 1 }, { bpm: 128, firstBeat: 0, duration: 200 }, {});
  assert.equal(cb.mode, 'cut');
  assert.equal(cb.beats, 0);
  assert.equal(cb.fadeSec, 6);
  assert.equal(cb.echoOut, false);
  assert.closeTo(cb.out.at, 172, 1e-9);
  // late (MIX NOW): first bar from `earliest`, no pre-ramp even for an 8 % gap
  const late = planTransition(cur, { bpm: 140, firstBeat: 0, duration: 200 }, { mixBeats: 32 }, { earliest: 61 });
  assert.equal(late.late, true);
  assert.equal(late.mode, 'match');
  assert.equal(late.out.beat, 132); // 61 s = beat 130.1 -> bar 132
  assert.equal(late.tempo.preRampBeats, 0);
});

test('planTransition: half-time songs and bar alignment of the in-point', () => {
  // the next song's music starts at beat 5: the in-point moves back to its bar (beat 4)
  const next = { bpm: 72, firstBeat: 0.3, duration: 200, bounds: { start: 0.3 + (4.6 * 60) / 72, end: 190 } };
  const plan = planTransition({ bpm: 140, firstBeat: 0, duration: 240, rate: 1 }, next, { mixBeats: 32 });
  assert.equal(plan.multiplier, 0.5);
  assert.equal(plan.mode, 'match');
  assert.equal(plan.in.beat, 4);
  assert.closeTo(plan.in.at, 0.3 + (4 * 60) / 72, 1e-9);
  // an in-point bar before the start of the file moves forward instead
  const early = { bpm: 120, firstBeat: 0.4, duration: 100, bounds: { start: 0.95, end: 95 } }; // first beat >= 0.95 = 1 (1.4 s)
  const p2 = planTransition({ bpm: 120, firstBeat: 0, duration: 240, rate: 1 }, early, { mixBeats: 32 });
  assert.equal(p2.in.beat, 0);
  assert.closeTo(p2.in.at, 0.4, 1e-9);
});

test('planTransition follows a beat map (tempo drift)', () => {
  // 120 -> 124 BPM ramp over the song: map beats integrate the tempo
  const beats = [];
  let t = 0.1;
  for (let k = 0; t < 230; k++) {
    beats.push(t);
    const bpm = 120 + (4 * t) / 230;
    t += 60 / bpm;
  }
  const map = Float64Array.from(beats);
  const cur = { bpm: 122, firstBeat: 0.1, beats: map, duration: 232, rate: 1, bounds: { start: 0, end: 228 } };
  const plan = planTransition(cur, { bpm: 124, firstBeat: 0, duration: 200 }, { mixBeats: 32 });
  assert.equal(plan.out.beat % 4, 0);
  assert.closeTo(plan.out.at, map[plan.out.beat], 1e-9, 'the out-point is a real (map) beat');
  assert(map[plan.out.beat + 32] <= 228 + 1e-9);
  assert.closeTo(plan.fadeSec, map[plan.out.beat + 32] - map[plan.out.beat], 1e-9);
  // the constant grid would be off by more than a beat there
  const gridAt = timeOfBeat(plan.out.beat, 122, 0.1, null);
  assert(Math.abs(gridAt - plan.out.at) > 0.1, `grid ${gridAt} vs map ${plan.out.at}`);
});

// ---- transition styles and the player's quick fade (docs/PLAYER.md section 3) ----------------------------------

test('style settings: transitionStyleOf, crossfadeSecondsOf, isBeatMatched', () => {
  assert.equal(transitionStyleOf(null), 'dj');
  assert.equal(transitionStyleOf({}), 'dj');
  assert.equal(transitionStyleOf({ transitionStyle: 'crossfade' }), 'crossfade');
  assert.equal(transitionStyleOf({ get: (k) => (k === 'transitionStyle' ? 'gapless' : undefined) }), 'gapless');
  assert.equal(transitionStyleOf({ transitionStyle: 'disco' }), 'dj');
  assert.equal(crossfadeSecondsOf({}), 6);
  assert.equal(crossfadeSecondsOf({ crossfadeSec: 9 }), 9);
  assert.equal(crossfadeSecondsOf({ crossfadeSec: 30 }), 12);
  assert.equal(crossfadeSecondsOf({ crossfadeSec: 0.5 }), 2);
  assert.equal(crossfadeSecondsOf({ crossfadeSec: 'x' }), 6);
  assert.equal(isBeatMatched({ mode: 'match' }), true);
  assert.equal(isBeatMatched({ mode: 'meet' }), true);
  for (const m of ['cut', 'crossfade', 'gapless']) assert.equal(isBeatMatched({ mode: m }), false, m);
  assert.equal(isBeatMatched(null), false);
});

test('planTransition dj style is the beat-matched plan (style field), whatever else is set', () => {
  const cur = { bpm: 128, firstBeat: 0, duration: 240, rate: 1 };
  const next = { bpm: 125, firstBeat: 0.2, duration: 200 };
  const dj = planTransition(cur, next, { mixBeats: 32 });
  assert.equal(dj.style, 'dj');
  assert.equal(dj.mode, 'match');
  const same = planTransition(cur, next, { mixBeats: 32, transitionStyle: 'dj', crossfadeSec: 3 });
  assert.deepEqual({ ...same, curBounds: null, nextBounds: null }, { ...dj, curBounds: null, nextBounds: null });
});

test('planTransition crossfade style: crossfadeSec ending at the musical end, own tempos, first beat in', () => {
  const cur = { bpm: 128, firstBeat: 0, duration: 200, rate: 1, bounds: { start: 1, end: 190 } };
  const next = { bpm: 120, firstBeat: 0.3, duration: 180, bounds: { start: 2, end: 175 } };
  const p = planTransition(cur, next, { transitionStyle: 'crossfade', crossfadeSec: 8, mixBeats: 64 });
  assert.equal(p.style, 'crossfade');
  assert.equal(p.mode, 'crossfade');
  assert.closeTo(p.out.at, 182, 1e-9, '8 s before the musical end (190 s)');
  assert.closeTo(p.fadeSec, 8, 1e-9);
  assert.closeTo(p.out.at + p.fadeSec, cur.bounds.end, 1e-9, 'the fade ends with the music');
  assert.equal(p.beats, 0);
  assert.equal(p.out.beat, null);
  assert.closeTo(p.in.at, 2.3, 1e-9, 'the next song starts on its first beat (beats at 0.3 + 0.5 k)');
  assert.equal(p.in.beat, 4);
  assert.equal(p.tempo.nextStartRate, 1);
  assert.equal(p.tempo.curTargetRate, 1);
  assert.equal(p.tempo.preRampBeats, 0);
  assert.equal(p.tempo.returnSeconds, 0);
  assert.equal(p.multiplier, 1);
  assert.equal(p.bassSwap, false);
  assert.equal(p.echoOut, false);
  assert.equal(p.late, false);
  // the current song plays faster: the out-point moves back so the fade still lasts 8 s
  const fast = planTransition({ ...cur, rate: 1.05 }, next, { transitionStyle: 'crossfade', crossfadeSec: 8 });
  assert.closeTo(fast.out.at, 190 - 8 * 1.05, 1e-9);
  assert.closeTo(fast.fadeSec, 8, 1e-9);
  // tempos far apart or unknown make no difference
  const nb = planTransition({ bpm: null, duration: 100, rate: 1 }, { bpm: null, duration: 100, bounds: { start: 1.7, end: 99 } },
    { transitionStyle: 'crossfade' });
  assert.equal(nb.mode, 'crossfade');
  assert.closeTo(nb.out.at, 94, 1e-9, 'default 6 s');
  assert.closeTo(nb.in.at, 1.7, 1e-9, 'no BPM: where the music starts');
  assert.equal(nb.in.beat, null);
  // a short song: at most half of its music is crossfaded
  const short = planTransition({ bpm: 120, firstBeat: 0, duration: 10, rate: 1, bounds: { start: 0, end: 10 } }, next,
    { transitionStyle: 'crossfade', crossfadeSec: 8 });
  assert.closeTo(short.out.at, 5, 1e-9);
  assert.closeTo(short.fadeSec, 5, 1e-9);
  // late (MIX NOW / missed): from `earliest`, at most crossfadeSec and never past the music
  const late = planTransition(cur, next, { transitionStyle: 'crossfade', crossfadeSec: 8 }, { earliest: 100 });
  assert.equal(late.late, true);
  assert.closeTo(late.out.at, 100, 1e-9);
  assert.closeTo(late.fadeSec, 8, 1e-9);
  assert.closeTo(planTransition(cur, next, { transitionStyle: 'crossfade', crossfadeSec: 8 }, { earliest: 187 }).fadeSec, 3, 1e-9);
  assert.closeTo(planTransition(cur, next, { transitionStyle: 'crossfade' }, { earliest: 195 }).fadeSec, GAPLESS_FADE, 1e-12);
});

test('planTransition gapless style: the next song at its musical start exactly at the musical end, 15 ms fades', () => {
  const cur = { bpm: 128, firstBeat: 0, duration: 200, rate: 1, bounds: { start: 1, end: 190 } };
  const next = { bpm: 120, firstBeat: 0.3, duration: 180, bounds: { start: 2, end: 175 } };
  const p = planTransition(cur, next, { transitionStyle: 'gapless', crossfadeSec: 8 });
  assert.equal(p.style, 'gapless');
  assert.equal(p.mode, 'gapless');
  assert.closeTo(p.out.at, 190, 1e-12);
  assert.equal(p.fadeSec, GAPLESS_FADE);
  assert.equal(GAPLESS_FADE, 0.015);
  assert.closeTo(p.in.at, 2, 1e-12, 'its musical start, not snapped to a beat');
  assert.equal(p.tempo.nextStartRate, 1);
  assert.equal(p.bassSwap, false);
  assert.equal(p.echoOut, false);
  // from a waveform: the fade tail and the leading silence are skipped
  const wf = planTransition({ bpm: null, duration: 120, rate: 1, waveform: synthWaveform({ duration: 120, lead: 2, fadeAt: 107 }) },
    { bpm: null, duration: 60, waveform: synthWaveform({ duration: 60, lead: 1.5, fadeAt: 55 }) }, { transitionStyle: 'gapless' });
  assert(wf.out.at > 115 && wf.out.at < 117.2, `musical end ${wf.out.at}`);
  assert.closeTo(wf.in.at, 1.5, 0.02);
  // late: a quick fade (1.5 s) while there is music left, 15 ms once it is over
  const late = planTransition(cur, next, { transitionStyle: 'gapless' }, { earliest: 100 });
  assert.closeTo(late.out.at, 100, 1e-12);
  assert.closeTo(late.fadeSec, QUICK_FADE, 1e-12);
  assert.closeTo(planTransition(cur, next, { transitionStyle: 'gapless' }, { earliest: 189.5 }).fadeSec, 0.5, 1e-9);
  assert.closeTo(planTransition(cur, next, { transitionStyle: 'gapless' }, { earliest: 191 }).fadeSec, GAPLESS_FADE, 1e-12);
});

test('quickTransition: the player skip fade (no beat matching)', () => {
  const q = quickTransition({ outAt: 42.5, inAt: 0.3, curRate: 1.02 });
  assert.equal(q.style, 'quick');
  assert.equal(q.mode, 'cut');
  assert.equal(q.quick, true);
  assert.equal(q.late, true);
  assert.equal(q.fadeSec, QUICK_FADE);
  assert.equal(QUICK_FADE, 1.5);
  assert.equal(q.beats, 0);
  assert.deepEqual(q.out, { at: 42.5, beat: null, beats: 0 });
  assert.deepEqual(q.in, { at: 0.3, beat: null });
  assert.equal(q.tempo.nextStartRate, 1);
  assert.equal(q.tempo.curTargetRate, 1.02);
  assert.equal(q.bassSwap, false);
  assert.equal(q.echoOut, false);
  assert.equal(isBeatMatched(q), false);
  const odd = quickTransition({ outAt: NaN, inAt: -3, fadeSec: 0 });
  assert.equal(odd.out.at, 0);
  assert.equal(odd.in.at, 0);
  assert.equal(odd.fadeSec, QUICK_FADE);
});
