// CDJ-style CUE button logic as a pure reducer (no DOM, no audio). The Deck feeds it button events with the
// current position and executes the returned actions in order.
//   let s = initialCueState();
//   const { state, actions } = cueReducer(s, { type: 'cueDown', pos: 12.3, duration: 200, grid, quantize: true });
//   s = state; for (const a of actions) run(a);   // a = {type:'seek',pos} | {type:'play'} | {type:'pause'} |
//                                                 //     {type:'setCue',pos}
// Rules (CDJ):
//   * Playing + CUE down: jump to the cue point and pause.
//   * Paused, not at the cue point + CUE down: set the cue point here (snapped to the nearest beat when quantize
//     is on and a grid exists); no playback.
//   * Paused at the cue point + CUE down: play while held (preview); CUE up returns to the cue point and pauses,
//     unless PLAY was pressed while holding (then it keeps playing).
//   * PLAY at the end of the track: start again from the cue point.
// Events: 'cueDown' | 'cueUp' | 'play' | 'pause' | 'stopped' (the deck stopped by itself: track end, eject,
// brake). Every event carries { pos, duration?, grid?: { bpm, firstBeat, beats? } | null, quantize?, ended? }.

import { beatsAt, timeOfBeat } from './sync-math.js';

/** Positions closer than this to the cue point count as "at the cue point" (covers the 3 ms stop fade). */
export const CUE_EPSILON = 0.025;
/** PLAY within this distance of the end restarts from the cue point. */
export const END_EPSILON = 0.05;

/**
 * @param {number} [cuePoint=0]
 * @returns {{ cuePoint: number, playing: boolean, previewing: boolean, latched: boolean, held: boolean }}
 */
export function initialCueState(cuePoint = 0) {
  return { cuePoint, playing: false, previewing: false, latched: false, held: false };
}

/**
 * Nearest grid beat to `pos` that lies inside the track (>= 0 and < duration when known). A grid with a beat
 * map (`beats`) snaps to the map's beats.
 * @param {number} pos
 * @param {{ bpm: number, firstBeat: number, beats?: ArrayLike<number>|null }|null} grid
 * @param {number} [duration]
 */
export function snapToGrid(pos, grid, duration = Infinity) {
  if (!grid || !(grid.bpm > 0)) return pos;
  if (grid.beats && grid.beats.length >= 2) return snapToMap(pos, grid, duration);
  const P = 60 / grid.bpm;
  const fb = grid.firstBeat || 0;
  let k = Math.round((pos - fb) / P);
  let t = fb + k * P;
  if (t < 0) t = fb + Math.ceil(-fb / P - 1e-9) * P;
  const limit = duration > 0 ? duration : Infinity;
  while (t >= limit && t - P >= 0) {
    k--;
    t -= P;
  }
  return t;
}

function snapToMap(pos, grid, duration) {
  const fb = grid.firstBeat || 0;
  const limit = duration > 0 ? duration : Infinity;
  let k = Math.round(beatsAt(pos, grid.bpm, fb, grid.beats));
  let t = timeOfBeat(k, grid.bpm, fb, grid.beats);
  if (t < 0) {
    k = Math.ceil(beatsAt(0, grid.bpm, fb, grid.beats) - 1e-9);
    t = timeOfBeat(k, grid.bpm, fb, grid.beats);
  }
  while (t >= limit) {
    const prev = timeOfBeat(k - 1, grid.bpm, fb, grid.beats);
    if (prev < 0) break;
    k--;
    t = prev;
  }
  return t;
}

/**
 * The cue reducer. Never mutates `state`.
 * @param {ReturnType<typeof initialCueState>} state
 * @param {{ type: string, pos: number, duration?: number, grid?: {bpm:number, firstBeat:number}|null,
 *           quantize?: boolean, ended?: boolean }} event
 * @returns {{ state: ReturnType<typeof initialCueState>, actions: Array<{type:string, pos?:number}> }}
 */
export function cueReducer(state, event) {
  const s = { ...state };
  const actions = [];
  const pos = Number.isFinite(event.pos) ? event.pos : 0;
  const duration = event.duration > 0 ? event.duration : Infinity;

  switch (event.type) {
    case 'cueDown': {
      if (s.held && s.previewing) break; // a second press while previewing changes nothing
      s.held = true;
      if (s.playing && !s.previewing) {
        actions.push({ type: 'seek', pos: s.cuePoint }, { type: 'pause' });
        s.playing = false;
        s.latched = false;
      } else if (Math.abs(pos - s.cuePoint) <= CUE_EPSILON) {
        if (Math.abs(pos - s.cuePoint) > 0.001) actions.push({ type: 'seek', pos: s.cuePoint });
        actions.push({ type: 'play' });
        s.playing = true;
        s.previewing = true;
        s.latched = false;
      } else {
        let c = Math.min(Math.max(pos, 0), duration === Infinity ? pos : duration);
        if (event.quantize && event.grid) c = snapToGrid(c, event.grid, duration);
        actions.push({ type: 'setCue', pos: c });
        if (Math.abs(c - pos) > 1e-9) actions.push({ type: 'seek', pos: c });
        s.cuePoint = c;
      }
      break;
    }
    case 'cueUp': {
      if (!s.held) break;
      s.held = false;
      if (s.previewing) {
        s.previewing = false;
        if (s.latched) {
          s.latched = false; // PLAY was pressed while holding: keep playing
        } else {
          actions.push({ type: 'seek', pos: s.cuePoint }, { type: 'pause' });
          s.playing = false;
        }
      }
      break;
    }
    case 'play': {
      if (s.previewing) {
        s.latched = true;
        break;
      }
      if (s.playing) break;
      const atEnd = !!event.ended || (duration !== Infinity && pos >= duration - END_EPSILON);
      if (atEnd) actions.push({ type: 'seek', pos: s.cuePoint });
      actions.push({ type: 'play' });
      s.playing = true;
      break;
    }
    case 'pause': {
      if (!s.playing) break;
      actions.push({ type: 'pause' });
      s.playing = false;
      s.previewing = false;
      s.latched = false;
      break;
    }
    case 'stopped': {
      s.playing = false;
      s.previewing = false;
      s.latched = false;
      break;
    }
    default:
      break;
  }
  return { state: s, actions };
}
