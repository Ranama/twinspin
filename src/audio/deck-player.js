// Main-thread side of one deck: an AudioWorkletNode running DeckDSP (or a ScriptProcessor fallback running
// the same DeckDSP on the main thread), with optimistic transport state and a latency-compensated position.
//
//   const player = await DeckPlayer.create(ctx);       // loads the worklet module once per context
//   player.node.connect(mixer.channels[0].input);
//   player.load([int16L, int16R], 48000);              // the arrays are TRANSFERRED (do not reuse them)
//   player.play();  player.seek(30);  player.getPosition();   // seconds, what is audible right now
//   player.on('ended', () => ...);  player.on('loaded', (duration) => ...);
//   const t = ctx.currentTime + 0.1;                   // scheduling on the audio clock (sample-exact):
//   player.seekAt(other.positionAt(t), t);  player.playAt(t);  player.setRate(1.02, 8);  // 8 s tempo ramp
//
// Loading order of the processor: (1) Blob URL built from DeckDSP.toString(); (2) the module file
// deck-processor.js (CSP blocks blob:); (3) ScriptProcessor (no AudioWorklet: plain http on a LAN, very old
// browsers, or both module loads failed).
//
// Position model: one trajectory P(T) per deck on the AudioContext clock T (seconds; output frame T * sr is
// rendered at context time T and heard when getOutputTimestamp().contextTime reaches T). The worklet reports
// {pos, vel, frame} every ~11 ms (P(frame / sr) = pos); in between, P is extrapolated with the velocity and
// the tempo-ramp model (a running ramp is integrated, not treated as a constant rate). Scheduled commands
// (playAt, seekAt) are part of the trajectory from their time on.
//   getPosition()  = P(audibleTime()): the track time being HEARD now (what the waveform shows).
//   positionAt(t)  = P(t): where the deck will be (or was) at context time t. Use this, not getPosition(), to
//                    plan on the audio clock: getPosition() lags ctx.currentTime by the output latency, so
//                    `getPosition() + rate * (t - ctx.currentTime)` is off by rate * latency (10-40 ms, 200 ms
//                    over Bluetooth). Positions of two decks taken with the same call are always comparable.
// Commands update the estimate immediately (optimistic): after seek() it returns the new position (minus the
// audio latency while playing: the jump is planned from the render clock, so the value never jumps back),
// play() starts moving from the paused position, pause() glides to the exact stop position, playAt() /
// seekAt() keep the current trajectory until their time.

import { Emitter } from '../core/emitter.js';
import { env } from '../core/env.js';
import { DeckDSP } from './deck-dsp.js';
import { createWorkletUrl, PROCESSOR_NAME } from './deck-worklet-src.js';

const ADD_MODULE_TIMEOUT_MS = 8000;
const PRE_ROLL = 2;                 // seconds the head may sit before 0 while scratching

/** @type {WeakMap<object, Promise<'blob'|'file'|null>>} */
const workletModules = new WeakMap();

function withTimeout(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function addDeckModule(ctx) {
  const worklet = ctx.audioWorklet;
  if (!worklet || typeof worklet.addModule !== 'function') return null;
  let url = null;
  try {
    url = createWorkletUrl();
    await withTimeout(worklet.addModule(url), ADD_MODULE_TIMEOUT_MS, 'Worklet (blob)');
    return 'blob';
  } catch (err) {
    console.warn('[TwinSpin] blob worklet failed, trying the module file', err);
  } finally {
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    }
  }
  try {
    const fileUrl = new URL('./deck-processor.js', import.meta.url).href;
    await withTimeout(worklet.addModule(fileUrl), ADD_MODULE_TIMEOUT_MS, 'Worklet (file)');
    return 'file';
  } catch (err) {
    console.warn('[TwinSpin] worklet module file failed, using ScriptProcessor', err);
  }
  return null;
}

/**
 * Load the 'twinspin-deck' worklet module into ctx (once per context).
 * @returns {Promise<'blob'|'file'|null>} how it was loaded, or null when worklets are unusable
 */
export function loadDeckWorklet(ctx) {
  let p = workletModules.get(ctx);
  if (!p) {
    p = addDeckModule(ctx).catch(() => null);
    workletModules.set(ctx, p);
  }
  return p;
}

export class DeckPlayer extends Emitter {
  /**
   * Create a player on ctx. Uses the AudioWorklet when allowed and loadable, else the ScriptProcessor.
   * @param {BaseAudioContext} ctx
   * @param {{ worklet?: boolean }} opts
   */
  static async create(ctx, { worklet = env.audioWorklet } = {}) {
    let mode = null;
    if (worklet && ctx.audioWorklet && typeof AudioWorkletNode === 'function') mode = await loadDeckWorklet(ctx);
    if (mode) {
      try {
        const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        return new DeckPlayer(ctx, { node, mode });
      } catch (err) {
        console.warn('[TwinSpin] deck worklet node failed, using ScriptProcessor', err);
      }
    }
    return new DeckPlayer(ctx, { mode: 'script' });
  }

  /** Use DeckPlayer.create(). */
  constructor(ctx, { node = null, mode = 'script' } = {}) {
    super();
    this.ctx = ctx;
    this._sr = ctx.sampleRate || 48000;
    this._disposed = false;
    this._seq = 0;
    this._loadSeq = 0;           // seq of the latest load/unload (track identity)
    this._posSeq = 0;            // seq of the latest command that moved the head (load, seek, play)
    this._motorSeq = 0;          // seq of the latest command that changed the motor (load, play, pause)
    this._loaded = false;
    this._duration = 0;
    this._playing = false;
    this._scratching = false;
    // tempo model: rate(T) = r0 before rs, linear to r1 over rd seconds (rd 0 = a step at rs)
    this._r0 = 1;
    this._r1 = 1;
    this._rs = 0;
    this._rd = 0;
    this._bend = 0;
    this._vel = 0;
    this._loop = null;
    // scheduled commands not yet confirmed by a report: { at (s), f (frame), seq, pos? }
    this._pStart = null;
    this._pJump = null;
    // position anchor in the audible timeline
    this._aPos = 0;
    this._aVel = 0;
    this._aTime = 0;
    this._cap = Infinity;
    this._floor = -Infinity;
    this._floorUntil = 0;
    this._blockEnd = 0;
    this._dsp = null;
    this._keepAlive = null;
    if (node) {
      this._mode = mode;
      this._node = node;
      this._bindWorklet();
    } else {
      this._mode = 'script';
      this._node = this._createScriptNode();
    }
  }

  /** Stereo output node (connect it to a ChannelStrip input). */
  get node() {
    return this._node;
  }

  get usingWorklet() {
    return this._mode !== 'script';
  }

  /** 'blob' | 'file' (worklet) or 'script' (ScriptProcessor fallback). */
  get mode() {
    return this._mode;
  }

  /** Motor on. After playAt(t) it turns true when ctx.currentTime reaches t. */
  get playing() {
    this._settle();
    return this._playing;
  }

  get velocity() {
    return this._vel;
  }

  /** Current tempo rate (follows a running setRate ramp; bend not included). */
  get rate() {
    return this._rd > 0 ? this._rateAt(this.ctx.currentTime) : this._r1;
  }

  /** The rate a running ramp ends at (= rate when no ramp runs). */
  get targetRate() {
    return this._r1;
  }

  /** True while a setRate ramp runs. */
  get ramping() {
    return this._rd > 0 && this.ctx.currentTime < this._rs + this._rd;
  }

  /** Context time of a pending playAt() start that has not happened yet, or null. */
  get scheduledStart() {
    this._settle();
    return this._pStart && !this._playing ? this._pStart.at : null;
  }

  /** { pos, at } of a pending seekAt() jump that has not happened yet (same object each call), or null. */
  get scheduledSeek() {
    const j = this._pJump;
    return j && this.ctx.currentTime < j.at ? j.info : null;
  }

  get duration() {
    return this._duration;
  }

  get loaded() {
    return this._loaded;
  }

  get scratching() {
    return this._scratching;
  }

  // ---------------------------------------------------------------------------------------------------
  // Setup

  _bindWorklet() {
    const node = this._node;
    node.port.onmessage = (e) => this._onMessage(e.data);
    node.onprocessorerror = (e) => {
      console.error('[TwinSpin] deck processor error', e);
      this.emit('error', 'The audio engine stopped. Open Settings and tap Restart audio.');
    };
  }

  _createScriptNode() {
    const ctx = this.ctx;
    const size = env.mobile ? 2048 : 1024;
    let sp;
    try {
      sp = ctx.createScriptProcessor(size, 0, 2);
    } catch {
      sp = ctx.createScriptProcessor(size, 1, 2);
    }
    this._dsp = new DeckDSP(this._sr);
    sp.onaudioprocess = (e) => this._onScript(e);
    // A ScriptProcessor only fires while it is pulled towards the destination: keep a silent path there.
    try {
      const keep = ctx.createGain();
      keep.gain.value = 0;
      sp.connect(keep);
      keep.connect(ctx.destination);
      this._keepAlive = keep;
    } catch {
      /* the strip connection still pulls it */
    }
    return sp;
  }

  _onScript(e) {
    const out = e.outputBuffer;
    const L = out.getChannelData(0);
    const R = out.numberOfChannels > 1 ? out.getChannelData(1) : null;
    const dsp = this._dsp;
    if (this._disposed || !dsp) {
      L.fill(0);
      if (R) R.fill(0);
      return;
    }
    const start = e.playbackTime > 0 ? e.playbackTime : this.ctx.currentTime;
    const startFrame = Math.round(start * this._sr);
    dsp.process(L, R, L.length, startFrame);
    const endFrame = startFrame + L.length;
    const end = endFrame / this._sr;
    this._blockEnd = end;
    this._report(dsp.position, dsp.velocity, dsp.playing, endFrame, Infinity);
    if (dsp.consumeEnded()) {
      this._playing = false;
      this.emit('ended');
    }
  }

  _onMessage(m) {
    if (!m || this._disposed) return;
    // The worklet echoes the seq of the latest command it has processed: ignore what predates ours.
    const seq = typeof m.seq === 'number' ? m.seq : Infinity;
    if (m.t === 'pos') {
      this._report(m.pos, m.vel, !!m.playing, m.frame, seq);
    } else if (m.t === 'ended') {
      if (seq < this._motorSeq) return; // PLAY/PAUSE was pressed after the end: moot
      this._playing = false;
      this.emit('ended');
    } else if (m.t === 'loaded') {
      if (seq !== this._loadSeq) return;
      this.emit('loaded', m.duration);
    }
  }

  /**
   * A position report: the head is at `pos` at output frame `frame` (end of the rendered block). Scheduled
   * commands count as done once a report from after their frame has seen them (seq).
   */
  _report(pos, vel, playing, frame, seq) {
    // (DeckDSP fires an event due on a block's end frame at the end of that block: frame >= f means done)
    const s = this._pStart;
    if (s && seq >= s.seq && frame >= s.f) {
      // the scheduled start has happened: before it the deck stood still at its base position
      this._floor = this._startBase(s);
      this._floorUntil = s.at;
      this._pStart = null;
    }
    const j = this._pJump;
    if (j && seq >= j.seq && frame >= j.f) {
      this._pJump = null;
      // a play() floor that the jump lands inside is void (a cued start's floor IS the jump target)
      if (this._floorUntil > j.at && this._floor !== j.pos) this._floor = -Infinity;
    }
    if (seq >= this._motorSeq && !this._pStart) this._playing = playing;
    if (seq >= this._posSeq) this._accept(pos, vel, frame / this._sr);
  }

  _send(msg, transfer) {
    if (this._disposed) return;
    if (this._dsp) {
      this._dsp.handleMessage(msg);
      return;
    }
    const port = this._node.port;
    if (transfer && transfer.length) {
      try {
        port.postMessage(msg, transfer);
        return;
      } catch (err) {
        console.warn('[TwinSpin] buffer transfer failed, copying instead', err);
      }
    }
    port.postMessage(msg);
  }

  // ---------------------------------------------------------------------------------------------------
  // Position estimate

  /** Context time of the sample being heard right now. */
  _audibleNow() {
    const ctx = this.ctx;
    if (typeof ctx.getOutputTimestamp === 'function') {
      try {
        const ts = ctx.getOutputTimestamp();
        if (ts && ts.contextTime > 0 && ts.performanceTime > 0 && typeof performance !== 'undefined') {
          let lag = (performance.now() - ts.performanceTime) / 1000;
          if (lag < 0) lag = 0;
          else if (lag > 0.1) lag = 0.1;
          return ts.contextTime + lag;
        }
      } catch {
        /* fall back */
      }
    }
    return ctx.currentTime - (ctx.baseLatency || 0) - (ctx.outputLatency || 0);
  }

  /** Context time at which a command sent now takes effect in the rendered audio. */
  _applyTime() {
    const now = this.ctx.currentTime;
    return this._dsp ? Math.max(now, this._blockEnd) : now;
  }

  _setAnchor(pos, vel, time) {
    this._aPos = pos;
    this._aVel = vel;
    this._aTime = time;
    this._cap = Infinity;
    this._vel = vel;
  }

  _accept(pos, vel, time) {
    this._vel = vel;
    if (vel === 0 && this._aVel > 0 && !this._scratching) {
      // The render head stopped, but the audio already rendered keeps playing for the output latency:
      // keep moving on screen and stop exactly at the stop position.
      const now = this._audibleNow();
      const proj = this._aPos + this._aVel * Math.min(now - this._aTime, 1);
      if (pos >= proj - 1e-6 && pos - proj < 1) {
        this._cap = pos;
        return;
      }
    }
    this._setAnchor(pos, vel, time);
  }

  /**
   * Context time of the sample being heard right now (the clock getPosition() uses). It lags
   * ctx.currentTime by the output latency.
   */
  audibleTime() {
    return this._audibleNow();
  }

  /** Seconds of track time being heard right now (extrapolated between reports). */
  getPosition() {
    if (!this._loaded) return 0;
    const now = this._audibleNow();
    return this._positionAt(now, now, true);
  }

  /**
   * Track position (s) at context time `ctxTime` on this deck's trajectory: extrapolated from the latest
   * report with the current speed and tempo ramp, including scheduled playAt()/seekAt() commands. Exact for
   * planning on the audio clock (seekAt / playAt / Mixer.scheduleCrossfade use the same clock).
   * @param {number} ctxTime AudioContext time (s)
   */
  positionAt(ctxTime) {
    if (!this._loaded) return 0;
    const now = this._audibleNow();
    if (typeof ctxTime !== 'number' || !Number.isFinite(ctxTime)) return this._positionAt(now, now, false);
    return this._positionAt(ctxTime, now, false);
  }

  /**
   * P(T); `now` = audible time (staleness limits). commit (getPosition): may settle a stop glide, and a
   * scheduled jump the render clock has reached already counts (like seek(): the new position minus the
   * latency until it is heard, so the value never jumps back when the confirming report comes in).
   */
  _positionAt(T, now, commit) {
    const s = this._pStart;
    const j = this._pJump;
    let p;
    let ref;
    let moving;
    const jumpOn = !!j && (T >= j.at || (commit && this.ctx.currentTime >= j.at));
    if (jumpOn && !(s && T >= s.at && s.at > j.at)) {
      // the scheduled jump is the latest event at T
      ref = j.pos;
      if (s) {
        // started at s.at (no earlier than that) or still waiting for its start
        moving = s.at <= j.at;
        p = moving ? ref + this._started(j.at, T > s.at ? T : s.at) : ref;
      } else {
        moving = this._playing && !this._scratching;
        p = moving ? ref + this._started(j.at, T) : ref;
      }
    } else if (s && T >= s.at) {
      // the scheduled start is the latest event at T
      ref = this._startBase(s);
      moving = true;
      p = ref + this._started(s.at, T);
    } else {
      const capped = this._cap !== Infinity;
      const maxDt = capped ? 1 : 0.25;
      // reports stop while the context is suspended: never extrapolate more than maxDt past "now"
      const lim = maxDt + (T > now ? T - now : 0);
      let dt = T - this._aTime;
      if (dt > lim) dt = lim;
      else if (dt < -1) dt = -1;
      p = this._aPos + this._aVel * dt + this._rampExcess(dt);
      if (capped && (p >= this._cap || dt >= maxDt)) {
        p = this._cap;
        if (commit) this._setAnchor(p, 0, now);
      }
      ref = this._aPos;
      moving = this._aVel > 0;
      if (p < this._floor && T < this._floorUntil) p = this._floor;
    }
    const loop = this._loop;
    if (loop && moving && !this._scratching && ref >= loop.start && ref < loop.end && p >= loop.end) {
      const len = loop.end - loop.start;
      p = loop.start + ((p - loop.start) % len);
    }
    if (p < -PRE_ROLL) return -PRE_ROLL;
    return p > this._duration ? this._duration : p;
  }

  /** Where a scheduled start begins: the target of a jump at or before it, else the (paused) position. */
  _startBase(s) {
    const j = this._pJump;
    if (j && j.at <= s.at) return j.pos;
    const capped = this._cap !== Infinity;
    let p = this._aPos + this._aVel * Math.min(Math.max(s.at - this._aTime, -1), capped ? 1 : 0.25);
    if (capped && p > this._cap) p = this._cap;
    return p;
  }

  /** Distance travelled from t0 to t1 by a running motor (tempo model + bend). */
  _started(t0, t1) {
    return this._bend * (t1 - t0) + this._rateG(t1) - this._rateG(t0);
  }

  /** Extra distance a tempo ramp adds over dt seconds after the anchor (0 unless the motor drives). */
  _rampExcess(dt) {
    if (dt === 0 || this._aVel === 0 || !this._playing || this._scratching || this._cap !== Infinity) return 0;
    const t0 = this._aTime;
    if (this._rd > 0) {
      const end = this._rs + this._rd;
      if ((t0 >= end && t0 + dt >= end) || (t0 <= this._rs && t0 + dt <= this._rs)) return 0;
    } else if ((t0 >= this._rs) === (t0 + dt >= this._rs)) {
      return 0;
    }
    return this._rateG(t0 + dt) - this._rateG(t0) - this._rateAt(t0) * dt;
  }

  /** Tempo model value at context time T. */
  _rateAt(T) {
    const rd = this._rd;
    if (!(rd > 0)) return T < this._rs ? this._r0 : this._r1;
    const u = (T - this._rs) / rd;
    if (u <= 0) return this._r0;
    if (u >= 1) return this._r1;
    return this._r0 + (this._r1 - this._r0) * u;
  }

  /** Antiderivative of the tempo model (relative to its start time): integral of rate dT. */
  _rateG(T) {
    const x = T - this._rs;
    const rd = this._rd;
    const r0 = this._r0;
    const r1 = this._r1;
    if (!(rd > 0)) return x < 0 ? r0 * x : r1 * x;
    if (x <= 0) return r0 * x;
    if (x >= rd) return ((r0 + r1) * rd) / 2 + r1 * (x - rd);
    return r0 * x + ((r1 - r0) * x * x) / (2 * rd);
  }

  /** Commit a scheduled start whose time has come (the worklet has started; its report may still be due). */
  _settle() {
    const s = this._pStart;
    if (s && !this._playing && this.ctx.currentTime >= s.at) {
      this._playing = true;
      this._vel = this._rateAt(s.at) + this._bend;
    }
  }

  // ---------------------------------------------------------------------------------------------------
  // Commands

  /**
   * Load PCM (Int16Array[] or Float32Array[], 1-2 channels). The buffers are TRANSFERRED to the worklet.
   * Resets position to 0, loop off, motor off.
   */
  load(channels, srcRate) {
    if (this._disposed) return;
    if (!channels || !channels.length || !channels[0] || !channels[0].length) throw new Error('No audio data to load');
    const rate = srcRate > 0 && Number.isFinite(srcRate) ? srcRate : this._sr;
    const seq = ++this._seq;
    this._loadSeq = seq;
    this._posSeq = seq;
    this._motorSeq = seq;
    this._loaded = true;
    this._duration = channels[0].length / rate;
    this._playing = false;
    this._scratching = false;
    this._loop = null;
    this._pStart = null;
    this._pJump = null;
    this._floor = -Infinity;
    this._setAnchor(0, 0, this.ctx.currentTime);
    const list = Array.from(channels).slice(0, 2);
    const msg = { t: 'load', channels: list, srcRate: rate, seq };
    if (this._dsp) {
      this._dsp.handleMessage(msg);
      Promise.resolve().then(() => {
        if (seq === this._loadSeq && !this._disposed) this.emit('loaded', this._duration);
      });
      return;
    }
    const transfer = [];
    for (const c of list) {
      const b = c && c.buffer;
      const shared = typeof SharedArrayBuffer !== 'undefined' && b instanceof SharedArrayBuffer;
      if (b && !shared && !transfer.includes(b)) transfer.push(b);
    }
    this._send(msg, transfer);
  }

  unload() {
    this._seq++;
    this._loadSeq = this._seq;
    this._posSeq = this._seq;
    this._motorSeq = this._seq;
    this._loaded = false;
    this._duration = 0;
    this._playing = false;
    this._scratching = false;
    this._loop = null;
    this._pStart = null;
    this._pJump = null;
    this._floor = -Infinity;
    this._setAnchor(0, 0, this.ctx.currentTime);
    this._send({ t: 'unload', seq: this._seq });
  }

  /**
   * Motor on/off now (brake setting applies to the stop). Cancels a pending playAt(); a stop also cancels a
   * pending seekAt().
   */
  setPlaying(on) {
    const want = !!on;
    if (!this._loaded) {
      this._playing = false;
      this._pStart = null;
      this._pJump = null;
      return;
    }
    this._settle();
    const pos = this.getPosition();
    const was = this._playing;
    const seq = ++this._seq;
    this._motorSeq = seq;
    if (want) this._posSeq = seq;
    if (this._pStart && was) {
      // the scheduled start already happened (its report is still on the way): continue from its trajectory
      const t = this._applyTime();
      this._setAnchor(this._positionAt(t, t, false), this._rateAt(t) + this._bend, t);
    }
    this._pStart = null;
    if (!want) this._pJump = null;
    this._playing = want;
    this._send({ t: 'play', on: want, seq });
    if (want) {
      if (!was && !this._scratching) {
        const t = this._applyTime();
        this._setAnchor(pos, this._rateAt(t) + this._bend, t);
        this._floor = pos;
        this._floorUntil = t + 0.1;
      }
      this.emit('play');
    }
  }

  play() {
    this.setPlaying(true);
  }

  pause() {
    this.setPlaying(false);
  }

  /**
   * Start the motor exactly at context time `ctxTime` (sample-exact on the audio clock, same clock as
   * ctx.currentTime and AudioParam automation). Until then `playing` stays false and the position stays put;
   * from then on it moves as if play() had been pressed at that instant (a time already rendered starts at
   * once, as if it had started on time). pause() or seek() before that time cancels the start; seekAt() does
   * not. No effect while the deck already plays.
   * @param {number} ctxTime AudioContext time (s)
   */
  playAt(ctxTime) {
    if (this._disposed) return;
    if (!this._loaded) {
      this._playing = false;
      return;
    }
    if (typeof ctxTime !== 'number' || !Number.isFinite(ctxTime)) {
      this.setPlaying(true);
      return;
    }
    this._settle();
    if (this._playing) return;
    const f = Math.round(ctxTime * this._sr);
    const seq = ++this._seq;
    this._motorSeq = seq;
    this._pStart = { at: f / this._sr, f, seq };
    this._send({ t: 'play', on: true, at: f, seq });
    this.emit('play');
  }

  /**
   * Tempo rate (1 = normal). rampSec > 0: a linear ramp (sample by sample on the audio clock) from the
   * current rate to `r` over rampSec seconds; a new call during a ramp starts a new ramp from where it is.
   * The bend still adds on top. getPosition() / positionAt() integrate the ramp.
   * @param {number} r
   * @param {number} [rampSec=0]
   */
  setRate(r, rampSec = 0) {
    if (typeof r !== 'number' || !Number.isFinite(r)) return;
    const v = r < -4 ? -4 : r > 4 ? 4 : r;
    const dur = typeof rampSec === 'number' && rampSec > 0 && Number.isFinite(rampSec) ? rampSec : 0;
    if (dur > 0) {
      // the ramp starts at the frame of ctx.currentTime: the DSP starts it there (or advanced by the frames
      // it already rendered), so this model and the audio agree to the sample
      const f = Math.round(this.ctx.currentTime * this._sr);
      const t = f / this._sr;
      // a ramp in progress continues from where it is; after a step the DSP starts from the step's value
      this._r0 = this._rd > 0 ? this._rateAt(t) : this._r1;
      this._r1 = v;
      this._rs = t;
      this._rd = Math.max(1, Math.round(dur * this._sr)) / this._sr;
      this._send({ t: 'rate', v, ramp: dur, at: f });
      return;
    }
    const t = this._applyTime();
    this._r0 = this._rd > 0 ? this._rateAt(t) : this._r1;
    this._r1 = v;
    this._rs = t;
    this._rd = 0;
    this._send({ t: 'rate', v });
  }

  /** Temporary additive speed offset (nudge / sync phase correction), -0.9..0.9. */
  setBend(b) {
    if (!Number.isFinite(b)) return;
    this._bend = b < -0.9 ? -0.9 : b > 0.9 ? 0.9 : b;
    this._send({ t: 'bend', v: this._bend });
  }

  /** Brake time in ms for the next stop (0 = instant stop with a 3 ms fade). */
  setBrake(ms) {
    if (!Number.isFinite(ms)) return;
    this._send({ t: 'brake', ms: Math.max(0, ms) });
  }

  /**
   * Jump to `sec` now (declicked by default): the jump is heard as soon as possible and starts exactly at
   * `sec`. Cancels a pending playAt() (the deck stays paused) and a pending seekAt().
   */
  seek(sec, declick = true) {
    if (!this._loaded || typeof sec !== 'number' || !Number.isFinite(sec)) return;
    this._settle();
    const p = sec < -PRE_ROLL ? -PRE_ROLL : sec > this._duration ? this._duration : sec;
    const seq = ++this._seq;
    this._posSeq = seq;
    this._pStart = null;
    this._pJump = null;
    this._send({ t: 'seek', pos: p, declick: declick !== false, seq });
    const t = this._applyTime();
    const vel = this._scratching ? this._vel : this._playing ? this._rateAt(t) + this._bend : 0;
    this._setAnchor(p, vel, t);
    this._floor = -Infinity;
  }

  /**
   * Jump to `sec` exactly at context time `ctxTime` (declicked), e.g. to line a deck up with where another
   * deck WILL be: `b.seekAt(slavePosFor(a.positionAt(t)), t)`. Until then the position follows the current
   * trajectory; from then on positionAt(T) = sec + the distance travelled since ctxTime. A time already
   * rendered jumps at once to where the head would be by now. Replaces an earlier pending seekAt(); seek(),
   * pause() and scratching cancel it.
   * @param {number} sec track position (s)
   * @param {number} ctxTime AudioContext time (s)
   * @param {boolean} [declick=true]
   */
  seekAt(sec, ctxTime, declick = true) {
    if (!this._loaded || typeof sec !== 'number' || !Number.isFinite(sec)) return;
    if (typeof ctxTime !== 'number' || !Number.isFinite(ctxTime)) {
      this.seek(sec, declick);
      return;
    }
    this._settle();
    const p = sec < -PRE_ROLL ? -PRE_ROLL : sec > this._duration ? this._duration : sec;
    const f = Math.round(ctxTime * this._sr);
    const at = f / this._sr;
    const seq = ++this._seq;
    this._pJump = { at, f, pos: p, seq, info: Object.freeze({ pos: p, at }) };
    this._send({ t: 'seek', pos: p, declick: declick !== false, at: f, seq });
  }

  /** Finger down on the platter (cancels a pending seekAt()). */
  scratchBegin() {
    if (!this._loaded) return;
    const ref = this.getPosition();
    this._pJump = null;
    this._scratching = true;
    this._floor = -Infinity;
    this._cap = Infinity;
    this._send({ t: 'scratch', phase: 'begin', pos: ref, vel: 0 });
  }

  /** Absolute target position (s) and finger speed (track-s per s). */
  scratchMove(sec, vel) {
    if (!this._scratching || !Number.isFinite(sec)) return;
    this._send({ t: 'scratch', phase: 'move', pos: sec, vel: Number.isFinite(vel) ? vel : 0 });
  }

  /** Finger up: the motor pulls the platter back to speed (or to a stop when paused). */
  scratchEnd() {
    if (!this._scratching) return;
    this._scratching = false;
    this._send({ t: 'scratch', phase: 'end', pos: 0, vel: 0 });
  }

  /** Seamless loop (seconds). */
  setLoop(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) return;
    this._loop = { start, end };
    this._send({ t: 'loop', start, end });
  }

  clearLoop() {
    this._loop = null;
    this._send({ t: 'loop', off: true });
  }

  /** Bit crusher amount 0 (off) .. 1. */
  setCrush(v) {
    this._send({ t: 'crush', v: Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0 });
  }

  dispose() {
    if (this._disposed) return;
    if (!this._dsp) {
      try {
        this._node.port.postMessage({ t: 'dispose' });
      } catch {
        /* ignore */
      }
    }
    this._disposed = true;
    this._loaded = false;
    try {
      if (this._dsp) this._node.onaudioprocess = null;
      else {
        this._node.port.onmessage = null;
        this._node.onprocessorerror = null;
      }
    } catch {
      /* ignore */
    }
    for (const n of [this._node, this._keepAlive]) {
      try {
        if (n) n.disconnect();
      } catch {
        /* ignore */
      }
    }
    if (this._dsp) this._dsp.unload();
    this._dsp = null;
    this._listeners.clear();
  }
}
