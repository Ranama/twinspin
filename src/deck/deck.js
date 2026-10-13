// Deck controller: the UI-agnostic state machine of one deck (A or B). It loads songs (file, library blob or
// demo), owns transport / CDJ cue / loops / tempo / bend / scratch / BPM state, and drives the deck player
// (engine.players[i]) and the mixer channel (engine.mixer.channels[i]). The UI reads the getters every animation
// frame and listens to 'change'.
//
//   const deck = new Deck('A', engine, settings);
//   deck.on('change', (what) => ...);   // 'track'|'loading'|'analysis'|'transport'|'tempo'|'cue'|'loop'|'sync'|
//                                       // 'fx'|'mix'|'bpm'|'vinyl'
//   deck.on('error', toast);  deck.on('ended', ...);  deck.on('tempoTouched', ...);  deck.on('analyzed', ...)
//   deck.on('userAction', (name) => ...)  // a user-facing control was used ('play'|'tempo'|'eq'|'seek'|...)
//   await deck.loadFile(file, { title, artist, fileName, libraryId });   deck.loadDemo(0);
//   deck.togglePlay();  deck.cueDown(); deck.cueUp();  deck.setTempo(0.25);  deck.toggleLoop(4);
//   deck.rampTempo(1, 12);  deck.playAt(ctxTime, { source: 'auto' });  deck.timeAtPosition(93.2);
//
// The state getters, engine attachment and loading live in deck-core.js (DeckCore); this file adds the controls.
// Tempo source: the deck remembers who set its tempo ('user' fader, 'sync', or 'auto' = Auto Mix ramps). Loading
// a new song resets a tempo the user did not set to 0 % (and the fader range to the user's range).
// Audio clock (Auto Mix, exact sync): rampTempo glides the rate on the audio clock, playAt / seekAt start / jump
// at an AudioContext time, positionAt / timeAtPosition predict the deck's trajectory on that clock.
// Beat helpers follow the track's beat map (track.beats) when the analysis made one, else the constant grid.
// User actions: every user-facing control emits 'userAction'(name) so Auto Mix can notice a takeover; Auto Mix
// passes { source: 'auto' } (sync passes { source: 'sync' }) so its own calls stay quiet.
// Contract: docs/CONTRACT.md section 4, docs/AUTOMIX.md section 4.1 (+ docs/CHANGES.md "deck").

import { clamp, wrap } from '../core/util.js';
import { cueReducer } from './cue-logic.js';
import {
  normalizeRange, rangeForRate, fitTaps, gridStart, loopBounds, beatPhase as phaseAt, doubleBeatMap, halveBeatMap,
  rateAt, travelDistance, travelTime, MIN_LOOP_BEATS, MAX_LOOP_BEATS, MIN_BPM, MAX_BPM,
} from './deck-math.js';
import { beatsAt as mapBeatsAt, timeOfBeat as mapTimeOfBeat, beatLengthAt } from './sync-math.js';
import { DeckCore, byUser, EQ_BANDS } from './deck-core.js';

const FX_NAMES = ['echo', 'reverb', 'flanger', 'crush'];
const TAP_RESET_SEC = 2;
const TAP_KEEP = 16;
const TAP_MIN_BPM = 40;
const TAP_MAX_BPM = 250;
const RAMP_STEP_MS = 40;              // tempo ramp steps when the player cannot ramp by itself

/**
 * One deck. `new Deck(id, engine, settings, deps?)`: id 'A' | 'B'; deps for tests (see DeckCore).
 */
export class Deck extends DeckCore {
  // ---------------------------------------------------------------------------------------------------
  // Transport

  /** PLAY/PAUSE button. opts { source: 'auto' } for Auto Mix (no 'userAction'). */
  togglePlay(opts) {
    this._transport(this.playing ? 'pause' : 'play', opts);
  }

  play(opts) {
    this._transport('play', opts);
  }

  pause(opts) {
    this._transport('pause', opts);
  }

  /**
   * Start playing exactly at AudioContext time `ctxTime` (Auto Mix). `playing` is true at once (the button
   * lights), the position stays put until then. A time already passed plays now.
   * @param {number} ctxTime
   * @param {{ source?: 'user'|'auto' }} [opts]
   */
  playAt(ctxTime, opts) {
    const now = this.audioTime;
    const at = Number.isFinite(ctxTime) && now !== null && ctxTime > now + 0.001 ? ctxTime : null;
    this._transport('play', opts, at);
  }

  /** CUE pressed (CDJ semantics, see cue-logic.js). */
  cueDown(opts) {
    this._transport('cueDown', opts);
  }

  /** CUE released. */
  cueUp(opts) {
    this._transport('cueUp', opts);
  }

  _transport(type, opts, at = null) {
    if (!this._track || !this._player || this._restoring) return;
    this._serial++;
    const serial = this._serial;
    const wasPlaying = this._cue.playing;
    const oldCue = this._cue.cuePoint;
    const r = cueReducer(this._cue, {
      type, pos: this.position, duration: this.duration, grid: this._grid(), quantize: this._quantize(), ended: this._ended,
    });
    this._cue = r.state;
    for (const a of r.actions) {
      if (a.type === 'seek') this._seekTo(a.pos, 'user');
      else if (a.type === 'play') {
        this._ended = false;
        this._startPlayer(at, serial);
      } else if (a.type === 'pause') {
        this._pendingAt = null;
        this._safe(() => this._player.pause());
      } else if (a.type === 'setCue') this._cueMoved = true;
    }
    if (this._cue.cuePoint !== oldCue) this._emit('cue');
    if (this._cue.playing !== wasPlaying || r.actions.length) this._emit('transport');
    if (byUser(opts) && type !== 'cueUp') this._userAction(type === 'cueDown' ? 'cue' : type);
  }

  /** player.play() now, or at AudioContext time `at` (player.playAt, else a timer as a fallback). */
  _startPlayer(at, serial) {
    const p = this._player;
    if (at === null) {
      this._pendingAt = null;
      this._safe(() => p.play());
      return;
    }
    this._pendingAt = at;
    if (typeof p.playAt === 'function') {
      this._safe(() => p.playAt(at));
      return;
    }
    const now = this.audioTime;
    this._later(() => {
      if (serial === this._serial && this._player === p && this._cue.playing) this._safe(() => p.play());
    }, Math.max(0, (at - (now === null ? at : now)) * 1000));
  }

  /**
   * Jump to `sec` (declicked). A user seek outside an active loop exits the loop. opts.source 'sync' (used by
   * SyncController) keeps the loop and wraps the target into it; 'auto' (Auto Mix) jumps quietly.
   * @param {number} sec
   * @param {{ source?: 'user'|'sync'|'auto' }} [opts]
   */
  seek(sec, opts) {
    if (!this._track || !this._player || this._restoring || !Number.isFinite(sec)) return;
    const source = opts && (opts.source === 'sync' || opts.source === 'auto') ? opts.source : 'user';
    this._pendingAt = null;
    this._seekTo(sec, source);
    if (source === 'user') this._userAction('seek');
  }

  /**
   * Jump to `sec` exactly at AudioContext time `ctxTime` (declicked), e.g. so a playing deck lands on the
   * leader's beat. Falls back to a timer + seek() when the player cannot schedule jumps.
   * @param {number} sec
   * @param {number} ctxTime
   * @param {{ source?: 'user'|'sync'|'auto' }} [opts]
   */
  seekAt(sec, ctxTime, opts) {
    if (!this._track || !this._player || this._restoring || !Number.isFinite(sec)) return;
    const now = this.audioTime;
    if (!Number.isFinite(ctxTime) || now === null || ctxTime <= now + 0.001) {
      this.seek(sec, opts);
      return;
    }
    const source = opts && (opts.source === 'sync' || opts.source === 'auto') ? opts.source : 'user';
    const p = this._player;
    const target = this._seekTarget(sec, source);
    this._ended = false;
    this._pendingAt = ctxTime;
    // phase correction waits for the jump plus the settle time
    this._lastJumpAt = this._deps.now() + (ctxTime - now) * 1000;
    if (typeof p.seekAt === 'function') {
      this._safe(() => p.seekAt(target, ctxTime));
    } else {
      const serial = this._serial;
      this._later(() => {
        if (serial === this._serial && this._player === p) this._seekTo(target, 'auto');
      }, (ctxTime - now) * 1000);
    }
    if (source === 'user') this._userAction('seek');
  }

  /** Jump to a fraction 0..1 of the song. */
  seekFraction(f) {
    if (!Number.isFinite(f)) return;
    this.seek(clamp(f, 0, 1) * this.duration);
  }

  /** The clamped seek target; a 'sync' target is wrapped into an active loop, a 'user' one outside exits it. */
  _seekTarget(sec, source) {
    let p = clamp(sec, 0, this.duration);
    const L = this._loop;
    if (L.active) {
      const len = L.end - L.start;
      if (source === 'sync') {
        if ((p < L.start || p >= L.end) && len > 0) p = L.start + wrap(p - L.start, len);
      } else if (source === 'user' && (p < L.start - 1e-6 || p >= L.end + 1e-6)) {
        this._exitLoop();
      }
    }
    return p;
  }

  _seekTo(sec, source) {
    const p = this._seekTarget(sec, source);
    const player = this._player;
    // the player drops a pending scheduled start on seek(); the deck still counts as playing, so keep it
    const pending = this._cue.playing ? player.scheduledStart : null;
    const start = typeof pending === 'number' && Number.isFinite(pending) ? pending : null;
    this._ended = false;
    this._safe(() => player.seek(p, true));
    if (start !== null && typeof player.playAt === 'function') this._safe(() => player.playAt(start));
    this._lastPos = p;
    this._lastJumpAt = this._deps.now();
  }

  /** One-shot vinyl stop over one beat (FX page). */
  brake(opts) {
    if (!this.playing || !this._player) return;
    const eff = this.effectiveBpm;
    const ms = Math.round(eff ? 60000 / eff : 500);
    this._safe(() => this._player.setBrake(ms));
    this._transport('pause', { source: 'auto' });
    this._safe(() => this._player.setBrake(0)); // the DSP fixed the brake slope at the stop; next stops are instant
    if (byUser(opts)) this._userAction('brake');
  }

  /** One-shot echo out (FxRack.echoOut over 4 beats), then pause. */
  echoOut(opts) {
    const fx = this._channel && this._channel.fx;
    if (!this.playing || !fx) return;
    if (byUser(opts)) this._userAction('echo');
    const eff = this.effectiveBpm;
    const beat = eff ? 60 / eff : 0.5;
    let secs = 0;
    try {
      secs = fx.echoOut(beat);
    } catch {
      secs = 0;
    }
    if (!(secs > 0)) secs = 4 * beat;
    const serial = ++this._serial;
    this._later(() => {
      if (serial === this._serial && this.playing) this._transport('pause', { source: 'auto' });
    }, secs * 1000);
  }

  // ---------------------------------------------------------------------------------------------------
  // Tempo

  /** User tempo move (fader -1..1). Emits 'tempoTouched' (SyncController drops sync) and 'userAction'. */
  setTempo(v) {
    const t = clamp(Number.isFinite(v) ? v : 0, -1, 1);
    this.emit('tempoTouched');
    this._setRate(1 + t * this._tempoRange, t, 'user');
    this._userAction('tempo');
  }

  /** Tempo back to 0 % (original BPM). opts { source: 'auto' } for Auto Mix (no 'tempoTouched'/'userAction'). */
  resetTempo(opts) {
    if (!byUser(opts)) {
      this.rampTempo(1, 0);
      return;
    }
    this.emit('tempoTouched');
    this._setRate(1, 0, 'user');
    this._userAction('tempo');
  }

  /** 0.08 | 0.16 | 0.5. Keeps the playing speed (the fader moves) unless it no longer fits the range. */
  setTempoRange(r) {
    const range = normalizeRange(r);
    this._userRange = range;
    if (range === this._tempoRange) return;
    this._tempoRange = range;
    const t = (this._rate - 1) / range;
    if (Math.abs(t) > 1 + 1e-9) {
      const s = t > 0 ? 1 : -1;
      this.emit('tempoTouched');
      this._setRate(1 + s * range, s, 'user');
      this._userAction('tempo');
    } else {
      this._tempo = clamp(t, -1, 1);
      this._emit('tempo');
    }
  }

  /** SyncController: set the rate, move the tempo value (widening the range when needed). No 'tempoTouched'. */
  applySyncRate(rate) {
    if (!Number.isFinite(rate) || !(rate > 0)) return;
    const r = clamp(rate, 0.25, 4);
    const range = rangeForRate(r, this._tempoRange);
    const widened = range !== this._tempoRange;
    this._tempoRange = range;
    const t = clamp((r - 1) / range, -1, 1);
    if (!widened && !this._ramp && Math.abs(r - this._rate) < 1e-12 && Math.abs(t - this._tempo) < 1e-12) {
      this._tempoSource = 'sync';
      return;
    }
    this._setRate(r, t, 'sync');
  }

  /**
   * Auto Mix: glide the rate to `rate` over `seconds` (0 = at once) on the audio clock. Tempo source 'auto',
   * widens the fader range like applySyncRate (and goes back to the user's range when the rate fits it), no
   * 'tempoTouched'. A user tempo move, sync or a new song ends the ramp.
   * @param {number} rate 0.25..4
   * @param {number} [seconds=0]
   */
  rampTempo(rate, seconds = 0) {
    if (!Number.isFinite(rate) || !(rate > 0)) return;
    const r = clamp(rate, 0.25, 4);
    const from = this.rate;
    const sec = Number.isFinite(seconds) && seconds > 0.02 ? seconds : 0;
    const now = this.audioTime;
    const p = this._player;
    // the range must hold both ends of the ramp so the fader never pins while it moves
    this._tempoRange = rangeForRate(Math.abs(from - 1) > Math.abs(r - 1) && sec > 0 ? from : r, this._userRange);
    if (!(sec > 0) || now === null || !p || Math.abs(from - r) < 1e-9) {
      this._setRate(r, clamp((r - 1) / this._tempoRange, -1, 1), 'auto');
      return;
    }
    const ramp = { c0: now, c1: now + sec, r0: from, r1: r };
    this._ramp = ramp;
    this._rate = r;
    this._tempo = clamp((r - 1) / this._tempoRange, -1, 1);
    this._tempoSource = 'auto';
    if (typeof p.rate === 'number') {
      this._safe(() => p.setRate(r, sec)); // the player ramps per sample on the audio clock
    } else {
      this._stepRamp(ramp); // older players: small steps from a timer
    }
    this._later(() => this._endRamp(ramp), sec * 1000 + 30);
    this._updateBeat();
    this._emit('tempo');
  }

  _stepRamp(ramp) {
    if (this._ramp !== ramp || !this._player) return;
    const now = this.audioTime;
    const r = now === null ? ramp.r1 : rateAt({ rate: ramp.r1, ramp }, now);
    this._safe(() => this._player.setRate(r));
    if (now !== null && now < ramp.c1) this._later(() => this._stepRamp(ramp), RAMP_STEP_MS);
  }

  _endRamp(ramp) {
    if (this._ramp !== ramp) return;
    this._ramp = null;
    if (this._player && typeof this._player.rate !== 'number') this._safe(() => this._player.setRate(this._rate));
    const range = rangeForRate(this._rate, this._userRange);
    if (range < this._tempoRange) this._tempoRange = range;
    this._tempo = clamp((this._rate - 1) / this._tempoRange, -1, 1);
    this._updateBeat();
    this._emit('tempo');
  }

  /** The running ramp, or null (a finished one is dropped). */
  _liveRamp() {
    const r = this._ramp;
    if (!r) return null;
    const now = this.audioTime;
    if (now === null || now >= r.c1) return null;
    return r;
  }

  _setRate(rate, tempo, source) {
    this._ramp = null; // any direct change ends a ramp (the player starts from its current value)
    this._rate = rate;
    this._tempo = tempo;
    if (source) this._tempoSource = source;
    this._safe(() => this._player && this._player.setRate(rate));
    this._updateBeat();
    this._emit('tempo');
  }

  /** Speed model for position predictions: { rate, bend, ramp }. */
  _motion() {
    return { rate: this._rate, bend: this._userBend + this._syncBend, ramp: this._liveRamp() };
  }

  /** AudioContext time of the sample being heard now (what `position` refers to), or null without audio. */
  _audibleNow() {
    const now = this.audioTime;
    if (now === null) return null;
    const p = this._player;
    for (const name of ['audibleTime', '_audibleNow']) {
      if (p && typeof p[name] === 'function') {
        const v = this._safe(() => p[name]());
        if (Number.isFinite(v)) return v;
      }
    }
    const ctx = this._engine.ctx;
    return now - (ctx.baseLatency || 0) - (ctx.outputLatency || 0);
  }

  /**
   * Track position the deck plays at AudioContext time `ctxTime` (render clock), from the heard position, the
   * speed (incl. bend and a running tempo ramp) and a scheduled start; the current position when it is not
   * moving. null when audio is not running.
   * @param {number} ctxTime
   */
  positionAt(ctxTime) {
    const aN = this._audibleNow();
    if (aN === null) return null;
    const pos = this.position;
    if (!Number.isFinite(ctxTime) || !this._track || this._restoring) return pos;
    const p = this._player;
    if (p && p.loaded && typeof p.positionAt === 'function') {
      // the player's own trajectory: reports, tempo ramp, scheduled start / jump, all on the audio clock
      const v = this._safe(() => p.positionAt(ctxTime));
      if (Number.isFinite(v)) return clamp(v, 0, this.duration);
    }
    if (!this.playing || this._scratching) return pos;
    const start = this.scheduledAt;
    const from = start !== null && !p.playing ? start : aN; // a scheduled start: still until then
    const m = this._motion();
    if (ctxTime >= from) return Math.min(this.duration, pos + travelDistance(m, from, ctxTime));
    return Math.max(0, pos - travelDistance(m, ctxTime, aN));
  }

  /**
   * AudioContext time at which the deck will play track position `pos` (render clock), or null when it is not
   * moving towards it (paused, scratching, looping, already past it, no audio). Includes a running tempo ramp
   * and a scheduled start.
   * @param {number} pos
   */
  timeAtPosition(pos) {
    const aN = this._audibleNow();
    if (aN === null || !Number.isFinite(pos) || !this.playing || this._scratching || this._loop.active) return null;
    const p = this._player;
    const start = this.scheduledAt;
    const from = start !== null && !p.playing ? start : aN;
    const cur = this.positionAt(from);
    if (cur === null || pos < cur - 1e-9) return null;
    const m = this._motion();
    const dt = travelTime(m, from, pos - cur);
    if (!Number.isFinite(dt)) return null;
    let t = from + dt;
    if (typeof p.positionAt === 'function') {
      // refine on the player's own trajectory (a few Newton steps; it is linear between ramp ends)
      for (let i = 0; i < 3; i++) {
        const err = pos - this.positionAt(t);
        const speed = rateAt(m, t) + m.bend;
        if (!(speed > 1e-6) || Math.abs(err) < 1e-7) break;
        t += err / speed;
      }
    }
    return t;
  }

  /**
   * Temporary speed offset (nudge buttons, platter edge, waveform drag): -0.9..0.9, 0 on release.
   * source 'sync' is the SyncController's phase correction; both add up.
   */
  setBend(v, source = 'user') {
    const b = clamp(Number.isFinite(v) ? v : 0, -0.9, 0.9);
    if (source === 'sync') {
      if (b === this._syncBend) return;
      this._syncBend = b;
    } else {
      if (b === this._userBend) return;
      this._userBend = b;
    }
    this._safe(() => this._player && this._player.setBend(this._userBend + this._syncBend));
  }

  /** SyncController only: mark this deck synced or not. */
  setSynced(on) {
    const v = !!on;
    if (v === this._synced) return;
    this._synced = v;
    if (!v) this.setBend(0, 'sync');
    this._emit('sync');
  }

  // ---------------------------------------------------------------------------------------------------
  // Platter

  /** Finger down on the record. */
  scratchBegin() {
    const p = this._player;
    if (!this._track || !p || this._restoring || this._scratching) return;
    this._scratching = true;
    this._scratchRef = this.position;
    this._safe(() => p.scratchBegin());
    this._lastJumpAt = this._deps.now();
    this._emit('transport');
    this._userAction('scratch');
  }

  /**
   * Finger moved: deltaSec = track seconds relative to the position at scratchBegin (from the unwrapped finger
   * angle), vel = finger speed in track seconds per second.
   */
  scratchMove(deltaSec, vel) {
    if (!this._scratching || !this._player || !Number.isFinite(deltaSec)) return;
    const p = this._player;
    const v = Number.isFinite(vel) ? vel : 0;
    this._safe(() => p.scratchMove(this._scratchRef + deltaSec, v));
  }

  /** Finger up: the motor pulls the record back to speed (or it stays where it is when paused). */
  scratchEnd() {
    if (!this._scratching) return;
    this._scratching = false;
    const p = this._player;
    if (p) this._safe(() => p.scratchEnd());
    this._ended = false;
    this._lastJumpAt = this._deps.now();
    this._emit('transport');
  }

  /** Touching the record: true = scratch, false = nudge/bend. */
  setVinyl(on) {
    const v = !!on;
    if (v === this._vinyl) return;
    this._vinyl = v;
    this._emit('vinyl');
  }

  // ---------------------------------------------------------------------------------------------------
  // Loops

  /** Beat loop 1 | 2 | 4 | 8 (any positive size works): starts one, resizes a running one, same size = exit. */
  toggleLoop(beats) {
    const n = Number(beats);
    if (!this._track || !this._player || !(n > 0)) return;
    if (!this.bpm) {
      this.emit('error', `Loops need the tempo. Wait for the BPM on deck ${this.id} or tap it in.`);
      return;
    }
    const L = this._loop;
    if (L.active && Math.abs(L.beats - n) < 1e-9) {
      this.exitLoop();
      return;
    }
    if (L.active) {
      this._resizeLoop(n);
      this._userAction('loop');
      return;
    }
    const t = this._track;
    const b = loopBounds(this.position, n, this.bpm, t.firstBeat, this.duration, this._quantize(), t.beats);
    if (!b) {
      this.emit('error', 'This song is too short for that loop.');
      return;
    }
    this._setLoop(n, b.start, b.end);
    this._userAction('loop');
  }

  loopHalve() {
    const L = this._loop;
    if (!L.active || !this.bpm) return;
    const n = Math.max(MIN_LOOP_BEATS, L.beats / 2);
    if (n !== L.beats) this._resizeLoop(n);
    this._userAction('loop');
  }

  loopDouble() {
    const L = this._loop;
    if (!L.active || !this.bpm) return;
    const n = Math.min(MAX_LOOP_BEATS, L.beats * 2);
    if (n !== L.beats) this._resizeLoop(n);
    this._userAction('loop');
  }

  exitLoop() {
    if (!this._loop.active) return;
    this._exitLoop();
    this._userAction('loop');
  }

  /** End of a loop of n beats starting at `start` (follows the beat map). */
  _loopEnd(start, n) {
    const t = this._track;
    if (!t || !t.beats) return start + (n * 60) / this.bpm;
    return mapTimeOfBeat(mapBeatsAt(start, this.bpm, t.firstBeat, t.beats) + n, this.bpm, t.firstBeat, t.beats);
  }

  _resizeLoop(n) {
    const L = this._loop;
    const end = this._loopEnd(L.start, n);
    if (end > this.duration + 1e-9) {
      this.emit('error', 'That loop would run past the end of the song.');
      return;
    }
    this._setLoop(n, L.start, end);
  }

  _setLoop(beats, start, end) {
    this._loop = { active: true, beats, start, end };
    this._safe(() => this._player.setLoop(start, end));
    this._lastJumpAt = this._deps.now();
    this._emit('loop');
  }

  _exitLoop() {
    this._loop = { ...this._loop, active: false };
    this._safe(() => this._player && this._player.clearLoop());
    this._emit('loop');
  }

  /** Keep an active loop the same number of beats after a BPM change. */
  _loopFollowBpm() {
    const L = this._loop;
    if (!L.active) return;
    const end = this.bpm ? this._loopEnd(L.start, L.beats) : NaN;
    if (!(end > L.start) || end > this.duration + 1e-9) this._exitLoop();
    else if (Math.abs(end - L.end) > 1e-9) this._setLoop(L.beats, L.start, end);
  }

  // ---------------------------------------------------------------------------------------------------
  // BPM and beats

  doubleBpm() {
    const b = this.bpm;
    if (!b) {
      this.emit('error', 'No BPM yet. Tap TAP along with the beat first.');
      return;
    }
    const t = this._track;
    this._setBpm(b * 2, undefined, t.beats ? doubleBeatMap(t.beats) : null);
    this._userAction('bpm');
  }

  halveBpm() {
    const b = this.bpm;
    if (!b) {
      this.emit('error', 'No BPM yet. Tap TAP along with the beat first.');
      return;
    }
    const t = this._track;
    // keep the beats in phase with the analysed (or tapped) grid, not the off-beats a x2 added
    const anchor = Number.isFinite(t.beatAnchor) ? t.beatAnchor : t.firstBeat;
    this._setBpm(b / 2, gridStart(anchor, 120 / b), t.beats ? halveBeatMap(t.beats, b, anchor) : null);
    this._userAction('bpm');
  }

  /**
   * One tap along with the beat. From the 4th tap (gaps under 2 s) a least-squares line through the taps gives
   * the BPM, and, while the deck plays, the beat grid anchor (taps are matched against the heard position).
   * A tapped tempo replaces the analysed beat map (constant grid).
   */
  tapTempo() {
    const t = this._track;
    if (!t) return;
    this._userAction('bpm');
    const now = this._deps.now() / 1000;
    const playing = this.playing && !this._scratching;
    const mode = playing ? 'pos' : 'time';
    const pos = this.position;
    const last = this._taps[this._taps.length - 1];
    if (!last || now - last.t > TAP_RESET_SEC || this._tapMode !== mode || (mode === 'pos' && !(pos > last.pos))) {
      this._taps = [];
      this._tapMode = mode;
    }
    this._taps.push({ t: now, pos });
    if (this._taps.length > TAP_KEEP) this._taps.shift();
    if (this._taps.length < 4) return;
    const fit = fitTaps(this._taps.map((x) => (mode === 'pos' ? x.pos : x.t)));
    if (!fit) return;
    const bpm = 60 / fit.period;
    if (!(bpm >= TAP_MIN_BPM && bpm <= TAP_MAX_BPM)) return;
    this._setBpm(bpm, mode === 'pos' ? gridStart(fit.anchor, fit.period) : undefined, null);
  }

  _setBpm(bpm, firstBeat, beats) {
    const t = this._track;
    if (!t) return;
    if (!(bpm >= MIN_BPM && bpm <= MAX_BPM)) {
      this.emit('error', `${Math.round(bpm)} BPM is out of range.`);
      return;
    }
    t.bpm = bpm;
    t.firstBeat = Number.isFinite(firstBeat) ? firstBeat : gridStart(t.firstBeat, 60 / bpm);
    if (Number.isFinite(firstBeat)) t.beatAnchor = firstBeat; // a real beat (x2 alone may move firstBeat onto an off-beat)
    t.beats = beats || null;
    this._loopFollowBpm();
    this._updateBeat();
    this._emit('bpm');
  }

  /** Position inside the current beat, 0..1, or null without a BPM (follows the beat map). */
  beatPhase(pos = this.position) {
    const t = this._track;
    return t ? phaseAt(pos, this.bpm, t.firstBeat, t.beats) : null;
  }

  /**
   * Fractional beat index at track position `pos` (0 = the first beat; from the beat map when there is one,
   * else the constant grid), or null without a BPM.
   */
  beatsAt(pos = this.position) {
    const t = this._track;
    const bpm = this.bpm;
    return t && bpm && Number.isFinite(pos) ? mapBeatsAt(pos, bpm, t.firstBeat, t.beats) : null;
  }

  /** Track time of (fractional) beat index k (inverse of beatsAt; extrapolates past the map), or null. */
  timeOfBeat(k) {
    const t = this._track;
    const bpm = this.bpm;
    return t && bpm && Number.isFinite(k) ? mapTimeOfBeat(k, bpm, t.firstBeat, t.beats) : null;
  }

  /** Seconds of track time of the beat around `pos` (the beat map's local beat), or null without a BPM. */
  beatLengthAt(pos = this.position) {
    const t = this._track;
    const bpm = this.bpm;
    return t && bpm ? beatLengthAt(pos, bpm, t.beats) : null;
  }

  // ---------------------------------------------------------------------------------------------------
  // FX and mixer channel (state kept here for the UI; forwarded to the channel / player)

  /** 'echo' | 'reverb' | 'flanger' | 'crush' on/off. */
  setFx(name, on) {
    if (!FX_NAMES.includes(name)) return;
    const v = !!on;
    if (this._fx[name] === v) return;
    this._fx[name] = v;
    if (name === 'crush') this._safe(() => this._player && this._player.setCrush(v ? this._fx.amount : 0));
    else this._safe(() => this._channel && this._channel.fx && this._channel.fx.set(name, v));
    this._emit('fx');
  }

  /** Shared FX amount 0..1. */
  setFxAmount(v) {
    const a = clamp(Number.isFinite(v) ? v : 0, 0, 1);
    if (a === this._fx.amount) return;
    this._fx.amount = a;
    this._safe(() => this._channel && this._channel.fx && this._channel.fx.setAmount(a));
    if (this._fx.crush) this._safe(() => this._player && this._player.setCrush(a));
    this._emit('fx');
  }

  /** Channel fader 0..1. opts { source: 'auto' } for Auto Mix (no 'userAction'). */
  setVolume(v, opts) {
    const x = clamp(Number.isFinite(v) ? v : 0, 0, 1);
    if (x !== this._mix.volume) {
      this._mix.volume = x;
      this._safe(() => this._channel && this._channel.setVolume(x));
      this._emit('mix');
    }
    if (byUser(opts)) this._userAction('volume');
  }

  /**
   * EQ band 'low' | 'mid' | 'high', -1 (kill) .. 1. opts { at, ramp } (AudioContext time, seconds) schedules a
   * linear glide on the audio clock (Auto Mix bass swap); the deck state shows the new value at once.
   * opts.source 'auto' for Auto Mix: no 'userAction', and the value is always re-sent to the channel (which also
   * cancels a glide scheduled earlier).
   * @param {'low'|'mid'|'high'} band
   * @param {number} v
   * @param {{ at?: number, ramp?: number, source?: 'user'|'auto' }} [opts]
   */
  /** The EQ as heard right now: like mix.eq, but timed changes (Auto Mix) appear only when they happen. */
  get eqShown() {
    const p = this._eqPending;
    if (!p) return this._mix.eq;
    const ctx = this._engine && this._engine.ctx;
    const now = ctx && Number.isFinite(ctx.currentTime) ? ctx.currentTime : Infinity;
    const out = { ...this._mix.eq };
    for (const band of EQ_BANDS) {
      const q = p[band];
      if (!q) continue;
      if (now < q.at) out[band] = q.from;
      else if (now < q.at + q.ramp) out[band] = q.from + (q.to - q.from) * ((now - q.at) / q.ramp);
      else delete p[band];
    }
    return out;
  }

  /** True while a timed EQ change is still on its way (the UI then refreshes the knobs every frame). */
  get eqAnimating() {
    const p = this._eqPending;
    if (!p) return false;
    this.eqShown; // drops finished entries
    return EQ_BANDS.some((b) => p[b]);
  }

  setEq(band, v, opts) {
    if (!EQ_BANDS.includes(band)) return;
    const x = clamp(Number.isFinite(v) ? v : 0, -1, 1);
    const o = opts || {};
    const user = byUser(o);
    const timed = Number.isFinite(o.at) || o.ramp > 0;
    const changed = x !== this._mix.eq[band];
    if (changed || timed || !user) {
      // A change scheduled on the audio clock (Auto Mix bass swap) is SHOWN when it is heard: eqShown keeps the old
      // value until `at` and follows the ramp, while mix.eq holds the target at once for the controller logic.
      const ctx = this._engine && this._engine.ctx;
      const now = ctx && Number.isFinite(ctx.currentTime) ? ctx.currentTime : null;
      if (timed && now !== null && Number.isFinite(o.at) && o.at > now) {
        const from = this.eqShown[band];
        this._eqPending = this._eqPending || {};
        this._eqPending[band] = { from, to: x, at: o.at, ramp: o.ramp > 0 ? o.ramp : 0 };
      } else if (this._eqPending) {
        delete this._eqPending[band];
      }
      this._mix.eq[band] = x;
      const ch = this._channel;
      if (ch && timed) this._safe(() => ch.setEq(band, x, { at: o.at, ramp: o.ramp }));
      else if (ch) this._safe(() => ch.setEq(band, x));
      if (changed) this._emit('mix');
    }
    if (user) this._userAction('eq');
  }

  /** Filter -1 (low-pass) .. 0 (off) .. 1 (high-pass). opts { source: 'auto' } for Auto Mix. */
  setFilter(v, opts) {
    const x = clamp(Number.isFinite(v) ? v : 0, -1, 1);
    if (x !== this._mix.filter) {
      this._mix.filter = x;
      this._safe(() => this._channel && this._channel.setFilter(x));
      this._emit('mix');
    }
    if (byUser(opts)) this._userAction('filter');
  }

  /** Gain trim in dB, -24..+12 (set automatically from the song's loudness). */
  setTrimDb(db) {
    const x = clamp(Number.isFinite(db) ? db : 0, -24, 12);
    if (x === this._mix.trimDb) return;
    this._mix.trimDb = x;
    this._safe(() => this._channel && this._channel.setTrimDb(x));
    this._emit('mix');
  }

  /** Headphone pre-listen (PFL). */
  setCue(on) {
    const v = !!on;
    if (v === this._mix.cue) return;
    this._mix.cue = v;
    this._safe(() => this._channel && this._channel.setCue(v));
    this._emit('mix');
  }

}
