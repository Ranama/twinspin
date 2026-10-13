// Tests for the CDJ cue reducer (src/deck/cue-logic.js): one test per rule plus edge cases.
import { cueReducer, initialCueState, snapToGrid, CUE_EPSILON } from '../src/deck/cue-logic.js';

const types = (actions) => actions.map((a) => a.type).join(',');
const grid = { bpm: 120, firstBeat: 0.1 }; // beats at 0.1, 0.6, 1.1, ...

function run(state, type, pos, extra = {}) {
  return cueReducer(state, { type, pos, duration: 200, grid, quantize: false, ...extra });
}

test('playing + CUE down: jump to the cue point and pause', () => {
  let s = { ...initialCueState(5), playing: true };
  const r = run(s, 'cueDown', 42);
  assert.equal(types(r.actions), 'seek,pause');
  assert.equal(r.actions[0].pos, 5);
  assert.equal(r.state.playing, false);
  assert.equal(r.state.previewing, false);
  // releasing afterwards does nothing
  const r2 = run(r.state, 'cueUp', 5);
  assert.equal(r2.actions.length, 0);
  assert.equal(r2.state.playing, false);
});

test('paused away from the cue + CUE down: sets the cue here, no playback', () => {
  const s = initialCueState(5);
  const r = run(s, 'cueDown', 33.33);
  assert.equal(types(r.actions), 'setCue');
  assert.equal(r.actions[0].pos, 33.33);
  assert.equal(r.state.cuePoint, 33.33);
  assert.equal(r.state.playing, false);
  const up = run(r.state, 'cueUp', 33.33);
  assert.equal(up.actions.length, 0);
});

test('setting the cue with quantize snaps to the nearest beat and moves the playhead there', () => {
  const s = initialCueState(0.1);
  const r = run(s, 'cueDown', 10.34, { quantize: true }); // beats ... 10.1, 10.6 -> 10.1 is nearer
  assert.equal(types(r.actions), 'setCue,seek');
  assert.closeTo(r.actions[0].pos, 10.1, 1e-9);
  assert.closeTo(r.actions[1].pos, 10.1, 1e-9);
  const r2 = run(s, 'cueDown', 10.36, { quantize: true });
  assert.closeTo(r2.state.cuePoint, 10.6, 1e-9);
  // quantize without a grid: exact position
  const r3 = run(s, 'cueDown', 10.36, { quantize: true, grid: null });
  assert.equal(r3.state.cuePoint, 10.36);
  assert.equal(types(r3.actions), 'setCue');
});

test('paused at the cue + CUE down previews while held, CUE up returns and pauses', () => {
  const s = initialCueState(5);
  const down = run(s, 'cueDown', 5);
  assert.equal(types(down.actions), 'play');
  assert.equal(down.state.playing, true);
  assert.equal(down.state.previewing, true);
  const up = run(down.state, 'cueUp', 7.5);
  assert.equal(types(up.actions), 'seek,pause');
  assert.equal(up.actions[0].pos, 5);
  assert.equal(up.state.playing, false);
  assert.equal(up.state.previewing, false);
});

test('"at the cue" tolerates the few ms the head drifts while stopping, and re-seeks exactly', () => {
  const s = initialCueState(5);
  const r = run(s, 'cueDown', 5 + 0.004);
  assert.equal(types(r.actions), 'seek,play');
  assert.equal(r.actions[0].pos, 5);
  const far = run(s, 'cueDown', 5 + CUE_EPSILON + 0.01);
  assert.equal(types(far.actions), 'setCue');
});

test('PLAY while holding CUE keeps playing after release', () => {
  const s = initialCueState(5);
  const down = run(s, 'cueDown', 5);
  const play = run(down.state, 'play', 6);
  assert.equal(play.actions.length, 0);
  assert.equal(play.state.latched, true);
  const up = run(play.state, 'cueUp', 7);
  assert.equal(up.actions.length, 0);
  assert.equal(up.state.playing, true);
  assert.equal(up.state.previewing, false);
  // and now CUE while playing goes back to the cue again
  const back = run(up.state, 'cueDown', 9);
  assert.equal(types(back.actions), 'seek,pause');
});

test('PLAY at the end of the track starts again from the cue point', () => {
  const s = initialCueState(3);
  const r = run(s, 'play', 199.99);
  assert.equal(types(r.actions), 'seek,play');
  assert.equal(r.actions[0].pos, 3);
  const flagged = run(s, 'play', 150, { ended: true });
  assert.equal(types(flagged.actions), 'seek,play');
  const normal = run(s, 'play', 150);
  assert.equal(types(normal.actions), 'play');
  assert.equal(normal.state.playing, true);
});

test('play/pause are idempotent', () => {
  const s = initialCueState(0);
  assert.equal(run(s, 'pause', 1).actions.length, 0);
  const playing = run(s, 'play', 1).state;
  assert.equal(run(playing, 'play', 1).actions.length, 0);
  const p = run(playing, 'pause', 2);
  assert.equal(types(p.actions), 'pause');
  assert.equal(p.state.playing, false);
});

test('pause during a preview ends it; the later CUE up does nothing', () => {
  const down = run(initialCueState(5), 'cueDown', 5);
  const paused = run(down.state, 'pause', 6);
  assert.equal(types(paused.actions), 'pause');
  assert.equal(paused.state.previewing, false);
  const up = run(paused.state, 'cueUp', 6);
  assert.equal(up.actions.length, 0);
});

test('stray CUE up and a double CUE down while previewing are ignored', () => {
  const s = initialCueState(5);
  assert.equal(run(s, 'cueUp', 5).actions.length, 0);
  const down = run(s, 'cueDown', 5);
  const again = run(down.state, 'cueDown', 5.2);
  assert.equal(again.actions.length, 0);
  assert.equal(again.state.previewing, true);
});

test('stopped resets transport flags', () => {
  const down = run(initialCueState(5), 'cueDown', 5);
  const st = run(down.state, 'stopped', 200);
  assert.equal(st.state.playing, false);
  assert.equal(st.state.previewing, false);
  assert.equal(st.actions.length, 0);
});

test('the reducer never mutates its input', () => {
  const s = Object.freeze(initialCueState(5));
  assert.doesNotThrow(() => run(s, 'cueDown', 5));
  assert.doesNotThrow(() => run(s, 'cueDown', 50));
  assert.equal(s.cuePoint, 5);
});

test('snapToGrid stays inside the track', () => {
  assert.closeTo(snapToGrid(0.01, { bpm: 120, firstBeat: 0.3 }), 0.3, 1e-12);
  assert.closeTo(snapToGrid(5.26, { bpm: 120, firstBeat: 0 }), 5.5, 1e-12);
  assert.closeTo(snapToGrid(9.9, { bpm: 120, firstBeat: 0 }, 9.8), 9.5, 1e-12);
  assert.equal(snapToGrid(4.2, null), 4.2);
  // cue set past the end is clamped to the duration (then snapped inside)
  const r = cueReducer(initialCueState(0), { type: 'cueDown', pos: 250, duration: 200, grid: null, quantize: false });
  assert.equal(r.state.cuePoint, 200);
});

test('snapToGrid follows a beat map', () => {
  const beats = Float64Array.from({ length: 50 }, (_, k) => 0.1 + 0.5 * k + (k >= 10 ? 0.03 : 0));
  const g = { bpm: 120, firstBeat: 0.1, beats };
  assert.closeTo(snapToGrid(5.2, g), beats[10], 1e-12); // 5.13 on the map (5.1 on the grid)
  assert.closeTo(snapToGrid(5.45, g), beats[11], 1e-12);
  assert.closeTo(snapToGrid(0.02, g), 0.1, 1e-12);
  assert.closeTo(snapToGrid(30, g, 24.9), beats[49], 1e-12, 'stays inside the track');
  // the cue reducer uses it when quantize is on
  const r = cueReducer(initialCueState(0), { type: 'cueDown', pos: 5.2, duration: 100, grid: g, quantize: true });
  assert.closeTo(r.state.cuePoint, beats[10], 1e-12);
});
