// DeckDSP: the sample-level core of one deck (pure JS: no Web Audio, no imports, no module-level helpers).
// It owns the PCM, a float64 read head, the motor (play/stop/brake/rate/bend), the hand on the platter
// (scratch follower), seamless loops, declicked jumps and the bit crusher. The same class runs inside the
// AudioWorklet (its source is shipped with DeckDSP.toString(), so the class must stay SELF-CONTAINED: no
// references to anything outside its own body) and on the main thread in the ScriptProcessor fallback.
//
//   const dsp = new DeckDSP(48000);
//   dsp.load([int16Left, int16Right], 48000);    // Int16Array (scaled by 1/32768) or Float32Array, 1-2 ch
//   dsp.setPlaying(true);
//   dsp.process(outL, outR, outL.length, currentFrame);   // fill one block (any length); the 4th argument is
//                                                         // the output frame of its first sample (optional)
//   dsp.seek(12.5);  dsp.scratchBegin();  dsp.scratchMove(12.6, 1.2);  dsp.scratchEnd();
//   dsp.setPlayingAt(frame);  dsp.seekAt(30, frame);      // sample-exact scheduled start / jump
//   dsp.setRate(1.03, 8);                                 // linear tempo ramp over 8 s (per sample)
//
// Units: positions in seconds of track time (the head itself is kept in source frames), velocity/rate in
// track-seconds per output second (1 = normal speed). Negative rates play backwards.
// Stops: `playing` turns false at once. A plain stop fades out over 3 ms and parks the head where STOP was
// pressed; a seek during any stop (fade, brake, coast) parks it exactly at the seek target. A still head is
// silent (output gain follows |speed| below 0.05), so a held platter makes no DC or crackle.
// Clock: the DSP counts output frames (`frame`, set from the 4th process() argument when given). Scheduled
// events (`setPlayingAt`, `seekAt`, a ramp's `atFrame`) fire on their exact frame inside a block; one that
// arrives late (its frame already rendered, up to MAX_LATE_SECONDS) still lands on its timeline: the head is
// advanced by the time it missed. An immediate seek, a pause or a load cancels a pending start; a pause, an
// immediate seek, a scratch or a load cancels a pending jump.
// process() never allocates; an idle deck (stopped, nothing pending) costs only a zero fill.

export class DeckDSP {
  static PLATTER_SECONDS_PER_TURN = 1.8;   // 33 1/3 rpm
  static XFADE_FRAMES = 256;               // ghost-head crossfade for seeks, loop wraps and scratch jumps
  static MAX_SPEED = 12;                   // |velocity| clamp while the hand drives the platter
  static FULL_GAIN_SPEED = 0.05;           // below this |speed| the output fades out (a held record is silent)
  static PRE_ROLL_SECONDS = 2;             // the head may sit this far before 0 / past the end while scratching
  static SCRATCH_TAU = 0.012;              // position-follow time constant (s)
  static SCRATCH_SMOOTH = 0.004;           // speed smoother time constant (s)
  static SCRATCH_EXTRAPOLATE = 0.03;       // target extrapolation limit (s)
  static SCRATCH_STALE = 0.06;             // no move for this long: the finger is still, target speed decays
  static SCRATCH_JUMP = 0.25;              // larger position errors jump (declicked) instead of sweeping
  static PULL_IN_TAU = 0.07;               // motor pull-in after the finger lets go (s)
  static GLIDE_TAU = 0.005;                // rate / bend changes glide with this time constant (s)
  static RAMP_SECONDS = 0.003;             // start / stop gain ramps
  static EDGE_FADE_SECONDS = 0.005;        // fade before running off either end of the track
  static MAX_LATE_SECONDS = 0.5;           // a scheduled event this late still lands on its timeline

  /** @param {number} outRate output sample rate (AudioContext.sampleRate) */
  constructor(outRate) {
    const sr = outRate > 0 && Number.isFinite(outRate) ? outRate : 48000;
    this.outRate = sr;
    this._kScr = 1 - Math.exp(-1 / (DeckDSP.SCRATCH_SMOOTH * sr));
    this._kGlide = 1 - Math.exp(-1 / (DeckDSP.GLIDE_TAU * sr));
    this._kPull = 1 - Math.exp(-1 / (DeckDSP.PULL_IN_TAU * sr));
    this._kStale = Math.exp(-1 / (0.01 * sr));
    this._envStep = 1 / (DeckDSP.RAMP_SECONDS * sr);
    this._extrapMax = Math.max(1, Math.round(DeckDSP.SCRATCH_EXTRAPOLATE * sr));
    this._staleAfter = Math.max(1, Math.round(DeckDSP.SCRATCH_STALE * sr));
    this._maxLate = Math.round(DeckDSP.MAX_LATE_SECONDS * sr);

    // output clock: frame of the next sample to render
    this._frame = 0;

    // track
    this._ch0 = null;
    this._ch1 = null;
    this._mono = true;
    this._len = 0;
    this._srcRate = sr;
    this._ratio = 1;
    this._scale = 1;
    this._loaded = false;
    this._invPosTau = 1 / (sr * DeckDSP.SCRATCH_TAU);
    this._tail = 1;
    this._jumpFrames = DeckDSP.SCRATCH_JUMP * sr;
    this._minPos = 0;
    this._maxPos = 0;

    // persistent controls (survive load/unload)
    this._rate = 1;
    this._rampLeft = 0;         // samples left in a linear tempo ramp (0 = none)
    this._rampDelay = 0;        // samples before a scheduled ramp starts
    this._rampStep = 0;
    this._rampTarget = 1;
    this._bend = 0;
    this._brakeMs = 0;
    this._crushOn = false;
    this._crushAmt = 0;
    this._crushHold = 1;
    this._crushQ = 32768;

    // interpolation output registers (avoid returning objects)
    this._oL = 0;
    this._oR = 0;

    // transport state
    this._pos = 0;
    this._speed = 0;
    this._motor = false;
    this._braking = false;
    this._brakeStep = 0;
    this._stopPending = false;
    this._rest = NaN;           // where the head must come to rest after a stop (NaN = wherever it stops)
    this._env = 1;
    this._envTarget = 1;
    this._glideK = this._kGlide;
    this._scr = false;
    this._tgt = 0;
    this._tgtVel = 0;
    this._since = 0;
    this._scrOff = 0;
    this._xf = 0;
    this._gPos = 0;
    this._loopOn = false;
    this._loopStart = 0;
    this._loopEnd = 0;
    this._ended = false;
    this._crushCount = 0;
    this._heldL = 0;
    this._heldR = 0;

    // scheduled events (output frames)
    this._startPending = false;
    this._startAt = 0;
    this._seekPending = false;
    this._seekAt = 0;
    this._seekPos = 0;
    this._seekDeclick = true;
  }

  // ---------------------------------------------------------------------------------------------------
  // Loading

  /**
   * Load PCM. channels: Int16Array[] or Float32Array[] (1 or 2; mono feeds both sides). The arrays are kept
   * by reference (never copied). Resets position to 0, loop off, motor off. Rate, bend, brake, crush stay.
   */
  load(channels, srcRate) {
    this.unload();
    if (!channels || !channels.length || !channels[0] || !channels[0].length) return;
    const a = channels[0];
    const b = channels.length > 1 && channels[1] && channels[1].length === a.length ? channels[1] : a;
    const rate = srcRate > 0 && Number.isFinite(srcRate) ? srcRate : this.outRate;
    this._ch0 = a;
    this._ch1 = b;
    this._mono = b === a;
    this._len = a.length;
    this._srcRate = rate;
    this._ratio = rate / this.outRate;
    this._scale = a instanceof Int16Array ? 1 / 32768 : 1;
    this._invPosTau = 1 / (rate * DeckDSP.SCRATCH_TAU);
    this._tail = Math.max(1, Math.round(DeckDSP.EDGE_FADE_SECONDS * rate));
    this._jumpFrames = DeckDSP.SCRATCH_JUMP * rate;
    this._minPos = -DeckDSP.PRE_ROLL_SECONDS * rate;
    this._maxPos = this._len + DeckDSP.PRE_ROLL_SECONDS * rate;
    this._loaded = true;
  }

  unload() {
    this._ch0 = null;
    this._ch1 = null;
    this._mono = true;
    this._len = 0;
    this._loaded = false;
    this._resetTransport();
  }

  _resetTransport() {
    this._pos = 0;
    this._speed = 0;
    this._motor = false;
    this._braking = false;
    this._brakeStep = 0;
    this._stopPending = false;
    this._rest = NaN;
    this._env = 1;
    this._envTarget = 1;
    this._glideK = this._kGlide;
    this._scr = false;
    this._tgt = 0;
    this._tgtVel = 0;
    this._since = 0;
    this._scrOff = 0;
    this._xf = 0;
    this._gPos = 0;
    this._loopOn = false;
    this._loopStart = 0;
    this._loopEnd = 0;
    this._ended = false;
    this._crushCount = 0;
    this._heldL = 0;
    this._heldR = 0;
    this._startPending = false;
    this._seekPending = false;
  }

  get loaded() {
    return this._loaded;
  }

  /** Track length in seconds. */
  get duration() {
    return this._loaded ? this._len / this._srcRate : 0;
  }

  /** Current read head in seconds (may be negative or past the end while scratching). */
  get position() {
    return this._loaded ? this._pos / this._srcRate : 0;
  }

  /** Current signed speed in track-seconds per output second. */
  get velocity() {
    return this._speed;
  }

  /** Motor on. False immediately after setPlaying(false), even while a brake or fade is still running. */
  get playing() {
    return this._motor;
  }

  get scratching() {
    return this._scr;
  }

  get looping() {
    return this._loopOn;
  }

  /** Current tempo rate (follows a running ramp sample by sample; bend not included). */
  get rate() {
    return this._rate;
  }

  /** True while a tempo ramp runs (or waits for its start frame). */
  get ramping() {
    return this._rampLeft > 0;
  }

  /** Output frame of the next sample to render (the DSP's clock). */
  get frame() {
    return this._frame;
  }

  /** Output frame of a pending scheduled start, or -1. */
  get pendingStartFrame() {
    return this._startPending ? this._startAt : -1;
  }

  /** Output frame of a pending scheduled jump, or -1. */
  get pendingSeekFrame() {
    return this._seekPending ? this._seekAt : -1;
  }

  // ---------------------------------------------------------------------------------------------------
  // Transport

  /**
   * Motor on/off. Start: 3 ms fade-in. Stop: brake 0 -> 3 ms fade-out then freeze; brake > 0 -> ramp.
   * Cancels a pending scheduled start; a stop also cancels a pending scheduled jump.
   */
  setPlaying(on) {
    this._startPending = false;
    if (!on) this._seekPending = false;
    this._motorSet(!!on);
  }

  /**
   * Start the motor exactly at output frame `frame` (sample-exact, inside a block). A frame that is already
   * rendered starts now, with the head advanced by the time it missed (up to MAX_LATE_SECONDS), so the deck
   * is where it would have been. Ignored while the motor already runs.
   */
  setPlayingAt(frame) {
    if (!this._loaded) return;
    if (typeof frame !== 'number' || !Number.isFinite(frame)) {
      this.setPlaying(true);
      return;
    }
    if (this._motor) {
      this._startPending = false;
      return;
    }
    const f = Math.round(frame);
    const late = this._frame - f;
    if (late >= 0) {
      this._startPending = false;
      this._startNow(late);
      return;
    }
    this._startAt = f;
    this._startPending = true;
  }

  _startNow(late) {
    const fromRest = !this._scr && !this._stopPending && !this._braking &&
      (this._speed === 0 || (this._speed < 1e-9 && this._speed > -1e-9));
    this._motorSet(true);
    if (late > 0 && fromRest && late <= this._maxLate && this._motor && this._speed !== 0) {
      // the start fades in from silence, so moving the head to where it should be by now is inaudible
      let p = this._pos + late * this._speed * this._ratio;
      if (p > this._len) p = this._len;
      else if (p < this._minPos) p = this._minPos;
      this._pos = p;
      this._xf = 0;
    }
  }

  _motorSet(on) {
    if (on) {
      if (!this._loaded) return;
      this._motor = true;
      this._ended = false;
      this._braking = false;
      this._rest = NaN;
      if (this._scr) return; // the hand holds the platter; the motor takes over on release
      if (this._stopPending) {
        this._stopPending = false;
        this._envTarget = 1;
        return;
      }
      if (this._speed === 0 || (this._speed < 1e-9 && this._speed > -1e-9)) {
        this._speed = this._rate + this._bend;
        this._env = 0;
        this._envTarget = 1;
      }
      this._glideK = this._kGlide;
      return;
    }
    if (!this._motor) return;
    this._motor = false;
    if (this._scr) return;
    const s = this._speed < 0 ? -this._speed : this._speed;
    if (s < 1e-9) {
      this._speed = 0;
      return;
    }
    if (this._brakeMs > 0) {
      this._braking = true;
      this._stopPending = false;
      this._rest = NaN;
      this._brakeStep = s / (this._brakeMs * 0.001 * this.outRate);
    } else {
      // the audio fades out over 3 ms while the head runs on, then the head returns to where STOP was
      // pressed (silently), so a later PLAY resumes exactly there and seek-then-stop lands exactly
      this._stopPending = true;
      this._envTarget = 0;
      this._rest = this._pos;
    }
  }

  /**
   * Tempo rate (0.25..4 in the app; negative values play backwards). Without a ramp it glides over ~5 ms.
   * rampSec > 0: linear ramp per sample from the current value (a ramp in progress continues from where it
   * is) to `r` over rampSec seconds; the bend still adds on top. atFrame (optional): the output frame where
   * the ramp starts (a past frame starts it now, already advanced by the samples it missed).
   */
  setRate(r, rampSec = 0, atFrame) {
    if (typeof r !== 'number' || !Number.isFinite(r)) return;
    const v = r < -4 ? -4 : r > 4 ? 4 : r;
    const n = typeof rampSec === 'number' && rampSec > 0 && Number.isFinite(rampSec) ? Math.round(rampSec * this.outRate) : 0;
    this._rampDelay = 0;
    if (n < 1 || v === this._rate) {
      this._rate = v;
      this._rampLeft = 0;
      return;
    }
    this._rampTarget = v;
    this._rampStep = (v - this._rate) / n;
    this._rampLeft = n;
    if (typeof atFrame === 'number' && Number.isFinite(atFrame)) {
      const d = Math.round(atFrame) - this._frame;
      if (d > 0) this._rampDelay = d;
      else if (d < 0) this._advanceRamp(-d > this._maxLate ? 0 : -d);
    }
  }

  /** Move a ramp forward by k samples without rendering (idle blocks, late starts). */
  _advanceRamp(k) {
    if (this._rampLeft <= 0 || !(k > 0)) return;
    if (this._rampDelay > 0) {
      const d = k < this._rampDelay ? k : this._rampDelay;
      this._rampDelay -= d;
      k -= d;
      if (k <= 0) return;
    }
    if (k >= this._rampLeft) {
      this._rate = this._rampTarget;
      this._rampLeft = 0;
    } else {
      this._rate += this._rampStep * k;
      this._rampLeft -= k;
    }
  }

  /** Additive temporary speed offset (nudge / sync correction), -0.9..0.9. */
  setBend(b) {
    if (!Number.isFinite(b)) return;
    this._bend = b < -0.9 ? -0.9 : b > 0.9 ? 0.9 : b;
  }

  /** Vinyl brake time in ms for the next stop (0 = instant CDJ stop). */
  setBrake(ms) {
    if (!Number.isFinite(ms)) return;
    this._brakeMs = ms < 0 ? 0 : ms > 10000 ? 10000 : ms;
  }

  /**
   * Jump to `sec` now. declick: crossfade from a ghost head over 256 frames when audible. Cancels a pending
   * scheduled start and a pending scheduled jump.
   */
  seek(sec, declick = true) {
    if (!this._loaded || typeof sec !== 'number' || !Number.isFinite(sec)) return;
    this._startPending = false;
    this._seekPending = false;
    this._seekNow(sec, declick, 0);
  }

  /**
   * Jump to `sec` exactly at output frame `frame` (declicked like seek). A frame that is already rendered
   * jumps now to where the head would be by now (sec + the time it missed, up to MAX_LATE_SECONDS). Replaces
   * an earlier pending jump; a pending start stays.
   */
  seekAt(sec, frame, declick = true) {
    if (!this._loaded || typeof sec !== 'number' || !Number.isFinite(sec)) return;
    if (typeof frame !== 'number' || !Number.isFinite(frame)) {
      this.seek(sec, declick);
      return;
    }
    const f = Math.round(frame);
    const late = this._frame - f;
    if (late >= 0) {
      this._seekPending = false;
      this._seekNow(sec, declick, late);
      return;
    }
    this._seekPending = true;
    this._seekAt = f;
    this._seekPos = sec;
    this._seekDeclick = declick !== false;
  }

  _seekNow(sec, declick, late) {
    let p = sec * this._srcRate;
    if (late > 0 && late <= this._maxLate && !this._scr && this._motor && !this._stopPending && !this._braking) {
      p += late * this._speed * this._ratio; // land on the timeline the caller planned
    }
    if (p < this._minPos) p = this._minPos;
    else if (p > this._len) p = this._len;
    const d = p - this._pos;
    if (this._scr) {
      this._tgt += d;
      this._scrOff += d / this._srcRate;
    }
    const audible = this._speed !== 0 && this._env > 0;
    if (declick && audible) this._jump(p);
    else {
      this._pos = p;
      this._xf = 0;
    }
    // stopping (fade, brake or coast): the head must end up exactly here once it is at rest
    if (!this._motor && !this._scr && (this._stopPending || this._braking || this._speed !== 0)) this._rest = p;
  }

  _jump(p) {
    // Keep whichever head currently dominates the mix as the ghost (smallest step on rapid double jumps).
    if (!(this._xf > DeckDSP.XFADE_FRAMES / 2)) this._gPos = this._pos;
    this._xf = DeckDSP.XFADE_FRAMES;
    this._pos = p;
  }

  // ---------------------------------------------------------------------------------------------------
  // Platter (hand)

  /**
   * Finger down: the platter is held. Optional refSec = the caller's idea of the current position; later
   * scratchMove targets are then taken relative to it, which cancels the message latency offset.
   */
  scratchBegin(refSec) {
    if (!this._loaded) return;
    this._seekPending = false; // the hand takes over: a scheduled jump would yank the record away
    this._scr = true;
    this._braking = false;
    this._stopPending = false;
    this._rest = NaN;
    this._envTarget = 1;
    this._tgt = this._pos;
    this._tgtVel = 0;
    this._since = 0;
    this._scrOff = typeof refSec === 'number' && Number.isFinite(refSec) ? this._pos / this._srcRate - refSec : 0;
  }

  /** Absolute target position (s) and finger speed (track-s per s). */
  scratchMove(targetSec, targetVel) {
    if (!this._scr || !this._loaded || !Number.isFinite(targetSec)) return;
    let p = (targetSec + this._scrOff) * this._srcRate;
    if (p < this._minPos) p = this._minPos;
    else if (p > this._maxPos) p = this._maxPos;
    let v = Number.isFinite(targetVel) ? targetVel : 0;
    const m = DeckDSP.MAX_SPEED;
    v = v < -m ? -m : v > m ? m : v;
    this._tgt = p;
    this._tgtVel = v;
    this._since = 0;
  }

  /** Finger up: speed returns to (playing ? rate + bend : 0) with a 70 ms time-constant pull-in. */
  scratchEnd() {
    if (!this._scr) return;
    this._scr = false;
    this._tgtVel = 0;
    this._glideK = this._kPull;
  }

  // ---------------------------------------------------------------------------------------------------
  // Loops and FX

  /** Seamless loop between two positions (s). A head up to one loop length past the end jumps back in. */
  setLoop(startSec, endSec) {
    if (!this._loaded || !Number.isFinite(startSec) || !Number.isFinite(endSec)) return;
    let s = startSec * this._srcRate;
    let e = endSec * this._srcRate;
    if (s < 0) s = 0;
    if (e > this._len) e = this._len;
    const minLen = Math.max(DeckDSP.XFADE_FRAMES, 0.008 * this._srcRate);
    if (!(e - s >= minLen)) return;
    this._loopStart = s;
    this._loopEnd = e;
    this._loopOn = true;
    const len = e - s;
    if (!this._scr && this._pos >= e && this._pos < e + len) {
      const p = this._pos - len;
      if (this._speed !== 0 && this._env > 0) this._jump(p);
      else this._pos = p;
    }
  }

  clearLoop() {
    this._loopOn = false;
  }

  /** Bit crusher, 0 = off (bypassed). 0..1: sample-hold factor 1..16, bit depth 16..3. */
  setCrush(amount) {
    const a = Number.isFinite(amount) ? (amount < 0 ? 0 : amount > 1 ? 1 : amount) : 0;
    this._crushAmt = a;
    if (a <= 0) {
      this._crushOn = false;
      return;
    }
    const hold = 1 + Math.round(a * 15);
    const bits = Math.round(16 - a * 13);
    this._crushQ = Math.pow(2, bits - 1);
    if (!this._crushOn) this._crushCount = hold - 1; // capture the very next sample
    this._crushHold = hold;
    this._crushOn = true;
  }

  /** True once after the head ran off the end while the motor was on. */
  consumeEnded() {
    const e = this._ended;
    this._ended = false;
    return e;
  }

  /**
   * Apply one control message of the worklet protocol ({ t: 'play' | 'rate' | ... }). Shared by the worklet
   * processor and the ScriptProcessor fallback so both behave identically. O(1).
   */
  handleMessage(m) {
    if (!m) return;
    switch (m.t) {
      case 'load': this.load(m.channels, m.srcRate); break;
      case 'unload': this.unload(); break;
      case 'play':
        if (m.on && typeof m.at === 'number') this.setPlayingAt(m.at);
        else this.setPlaying(!!m.on);
        break;
      case 'rate': this.setRate(m.v, m.ramp, m.at); break;
      case 'bend': this.setBend(m.v); break;
      case 'brake': this.setBrake(m.ms); break;
      case 'seek':
        if (typeof m.at === 'number') this.seekAt(m.pos, m.at, m.declick !== false);
        else this.seek(m.pos, m.declick !== false);
        break;
      case 'scratch':
        if (m.phase === 'begin') this.scratchBegin(m.pos);
        else if (m.phase === 'move') this.scratchMove(m.pos, m.vel);
        else if (m.phase === 'end') this.scratchEnd();
        break;
      case 'loop':
        if (m.off) this.clearLoop();
        else this.setLoop(m.start, m.end);
        break;
      case 'crush': this.setCrush(m.v); break;
      default: break;
    }
  }

  // ---------------------------------------------------------------------------------------------------
  // Rendering

  _at(a, k) {
    return k >= 0 && k < this._len ? a[k] : 0;
  }

  _herm(p0, p1, p2, p3, t) {
    // 4-point cubic Hermite (Catmull-Rom). t = 0 returns p1 exactly.
    const c1 = 0.5 * (p2 - p0);
    const c2 = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
    const c3 = 0.5 * (p3 - p0) + 1.5 * (p1 - p2);
    return ((c3 * t + c2) * t + c1) * t + p1;
  }

  /** Interpolated raw sample values at source frame x into this._oL / this._oR (0 outside the track). */
  _tap(x) {
    const len = this._len;
    const i = Math.floor(x);
    if (i < -2 || i > len) {
      this._oL = 0;
      this._oR = 0;
      return;
    }
    const t = x - i;
    const a = this._ch0;
    if (i >= 1 && i + 2 < len) {
      this._oL = this._herm(a[i - 1], a[i], a[i + 1], a[i + 2], t);
      if (this._mono) {
        this._oR = this._oL;
        return;
      }
      const b = this._ch1;
      this._oR = this._herm(b[i - 1], b[i], b[i + 1], b[i + 2], t);
      return;
    }
    this._oL = this._herm(this._at(a, i - 1), this._at(a, i), this._at(a, i + 1), this._at(a, i + 2), t);
    if (this._mono) {
      this._oR = this._oL;
      return;
    }
    const b = this._ch1;
    this._oR = this._herm(this._at(b, i - 1), this._at(b, i), this._at(b, i + 1), this._at(b, i + 2), t);
  }

  /**
   * Fill `frames` samples of outL/outR (outR may be null for mono output). Uses the frames argument, never a
   * fixed block size. startFrame (optional): the output frame of the first sample (worklet `currentFrame`),
   * which sets the clock scheduled events use; without it the DSP keeps counting by itself. Scheduled
   * events split the block at their exact frame. No allocations.
   */
  process(outL, outR, frames, startFrame) {
    if (!outL) return;
    let n = frames === undefined ? outL.length : frames | 0;
    if (n > outL.length) n = outL.length;
    const two = !!outR && outR !== outL;
    if (two && outR.length < n) n = outR.length;
    if (n <= 0) return;
    if (typeof startFrame === 'number' && Number.isFinite(startFrame)) this._frame = Math.round(startFrame);
    const f0 = this._frame;
    let i = 0;
    for (;;) {
      // next scheduled event (index relative to the block start); one due on the frame right after the
      // block fires at its end, so the state between blocks (and the worklet report) already includes it
      let ev = n + 1;
      if (this._seekPending) {
        const k = this._seekAt - f0;
        if (k < ev) ev = k < i ? i : k;
      }
      if (this._startPending) {
        const k = this._startAt - f0;
        if (k < ev) ev = k < i ? i : k;
      }
      const stop = ev < n ? ev : n;
      if (stop > i) {
        this._render(outL, outR, i, stop, two);
        i = stop;
      }
      if (ev > n) break;
      // fire what is due on this exact frame: the jump first, then the start (a cued start lands on target);
      // an overdue one (the clock jumped past it) still lands on its timeline
      const now = f0 + i;
      this._frame = now;
      if (this._seekPending && this._seekAt <= now) {
        this._seekPending = false;
        this._seekNow(this._seekPos, this._seekDeclick, now - this._seekAt);
      }
      if (this._startPending && this._startAt <= now) {
        const late = now - this._startAt;
        this._startPending = false;
        this._startNow(late);
      }
    }
    this._frame = f0 + n;
  }

  /** Render samples [from, to) of the output arrays. */
  _render(outL, outR, from, to, two) {
    const idle = this._speed === 0 && !this._motor && !this._scr && !this._braking && !this._stopPending &&
      this._xf === 0 && this._rest !== this._rest;
    if (!this._loaded || idle) {
      // nothing moves: silence without running the per-sample engine (an idle deck costs ~nothing)
      for (let i = from; i < to; i++) {
        outL[i] = 0;
        if (two) outR[i] = 0;
      }
      this._advanceRamp(to - from);
      return;
    }

    const len = this._len;
    const ratio = this._ratio;
    const scale = this._scale;
    const kScr = this._kScr;
    const kGlide = this._kGlide;
    const kStale = this._kStale;
    const envStep = this._envStep;
    const exMax = this._extrapMax;
    const staleAfter = this._staleAfter;
    const invTau = this._invPosTau;
    const jumpFrames = this._jumpFrames;
    const tail = this._tail;
    const minPos = this._minPos;
    const maxPos = this._maxPos;
    const xfLen = DeckDSP.XFADE_FRAMES;
    const xfHalf = xfLen / 2;
    const invXf = 1 / xfLen;
    const maxSp = DeckDSP.MAX_SPEED;
    const fullSp = DeckDSP.FULL_GAIN_SPEED;
    const invFull = 1 / fullSp;
    const scr = this._scr;
    const loopOn = this._loopOn && !scr;
    const ls = this._loopStart;
    const le = this._loopEnd;
    const ll = le - ls;
    const bend = this._bend;
    let rate = this._rate;
    let rampLeft = this._rampLeft;
    let rampDelay = this._rampDelay;
    const rampStep = this._rampStep;
    const rampTarget = this._rampTarget;
    let motorTarget = rate + bend;
    const brakeStep = this._brakeStep;
    const crush = this._crushOn;
    const crushHold = this._crushHold;
    const cq = this._crushQ;

    let pos = this._pos;
    let sp = this._speed;
    let env = this._env;
    let envT = this._envTarget;
    let xf = this._xf;
    let gPos = this._gPos;
    let motor = this._motor;
    let braking = this._braking;
    let stopPending = this._stopPending;
    let glideK = this._glideK;
    let since = this._since;
    const tgt = this._tgt;
    let tgtVel = this._tgtVel;
    let crushCount = this._crushCount;
    let heldL = this._heldL;
    let heldR = this._heldR;
    let rest = this._rest;

    for (let i = from; i < to; i++) {
      // 0) tempo ramp (runs on the audio clock whatever the transport does); a running motor moves with
      //    the ramp sample by sample (the glide below only settles other differences, e.g. a bend change)
      if (rampLeft > 0) {
        if (rampDelay > 0) rampDelay--;
        else {
          const prevTarget = motorTarget;
          rampLeft--;
          rate = rampLeft === 0 ? rampTarget : rate + rampStep;
          motorTarget = rate + bend;
          if (motor && !scr && !braking && !stopPending) sp += motorTarget - prevTarget;
        }
      }

      // 1) speed: hand, brake or motor
      if (scr) {
        since++;
        if (since > staleAfter && tgtVel !== 0) {
          tgtVel *= kStale;
          if (tgtVel < 1e-4 && tgtVel > -1e-4) tgtVel = 0;
        }
        const pred = tgt + tgtVel * ratio * (since < exMax ? since : exMax);
        const err = pred - pos;
        if (err > jumpFrames || err < -jumpFrames) {
          if (!(xf > xfHalf)) gPos = pos;
          xf = xfLen;
          pos = pred;
          sp = tgtVel;
        } else {
          sp += (tgtVel + err * invTau - sp) * kScr;
          if (sp > maxSp) sp = maxSp;
          else if (sp < -maxSp) sp = -maxSp;
        }
      } else if (braking) {
        if (sp > brakeStep) sp -= brakeStep;
        else if (sp < -brakeStep) sp += brakeStep;
        else {
          sp = 0;
          braking = false;
        }
      } else if (!stopPending) {
        const target = motor ? motorTarget : 0;
        if (sp !== target) {
          sp += (target - sp) * glideK;
          const d = target - sp;
          if (d < 1e-6 && d > -1e-6) {
            sp = target;
            glideK = kGlide;
          }
        }
      }

      // 2) start / stop gain ramp
      if (env !== envT) {
        if (env < envT) {
          env += envStep;
          if (env > envT) env = envT;
        } else {
          env -= envStep;
          if (env < envT) env = envT;
        }
        if (env === 0 && stopPending) {
          // the stop fade finished: freeze the head; a still head is silent through the speed gain
          stopPending = false;
          sp = 0;
          env = 1;
          envT = 1;
          glideK = kGlide;
        }
      }

      // the head just came to rest after a stop: park it exactly where it was meant to stop (silent: speed 0)
      if (sp === 0 && rest === rest && !scr) {
        pos = rest;
        xf = 0;
        rest = NaN;
      }

      // 3) read, ghost crossfade, gains
      let yL = 0;
      let yR = 0;
      const a = sp < 0 ? -sp : sp;
      let g = a >= fullSp ? env : env * a * invFull;
      if (g > 0) {
        if (!loopOn) {
          if (sp > 0) {
            const r = len - pos;
            if (r < tail) g *= r > 0 ? r / tail : 0;
          } else if (pos < tail) {
            g *= pos > 0 ? pos / tail : 0;
          }
        }
        if (g > 0) {
          this._tap(pos);
          yL = this._oL;
          yR = this._oR;
          if (xf > 0) {
            this._tap(gPos);
            const w = xf * invXf;
            yL += (this._oL - yL) * w;
            yR += (this._oR - yR) * w;
          }
          g *= scale;
          yL *= g;
          yR *= g;
        }
      }

      // 4) crusher (after interpolation)
      if (crush) {
        if (++crushCount >= crushHold) {
          crushCount = 0;
          heldL = Math.round(yL * cq) / cq;
          heldR = Math.round(yR * cq) / cq;
        }
        yL = heldL;
        yR = heldR;
      }

      outL[i] = yL;
      if (two) outR[i] = yR;

      // 5) advance the heads, loop wrap, track edges
      if (sp !== 0) {
        const inc = sp * ratio;
        const prev = pos;
        pos += inc;
        if (xf > 0) gPos += inc;
        if (loopOn) {
          if (inc > 0) {
            if (prev < le && pos >= le) {
              if (!(xf > xfHalf)) gPos = pos;
              xf = xfLen + 1;
              pos -= ll;
            }
          } else if (prev >= ls && pos < ls) {
            if (!(xf > xfHalf)) gPos = pos;
            xf = xfLen + 1;
            pos += ll;
          }
        }
        if (!scr) {
          if (inc > 0 && pos >= len) {
            if (motor) {
              motor = false;
              this._ended = true;
            }
            pos = len;
            sp = 0;
            braking = false;
            stopPending = false;
            env = 1;
            envT = 1;
            glideK = kGlide;
          } else if (inc < 0 && pos <= 0 && motor && motorTarget < 0) {
            motor = false;
            pos = 0;
            sp = 0;
            stopPending = false;
            env = 1;
            envT = 1;
            glideK = kGlide;
          }
        }
        if (pos < minPos) {
          pos = minPos;
          if (sp < 0) sp = 0;
        } else if (pos > maxPos) {
          pos = maxPos;
          if (sp > 0) sp = 0;
        }
      }
      if (xf > 0) xf--;
    }

    this._pos = pos;
    this._speed = sp;
    this._env = env;
    this._envTarget = envT;
    this._xf = xf;
    this._gPos = gPos;
    this._motor = motor;
    this._braking = braking;
    this._stopPending = stopPending;
    this._glideK = glideK;
    this._since = since;
    this._tgtVel = tgtVel;
    this._crushCount = crushCount;
    this._heldL = heldL;
    this._heldR = heldR;
    this._rest = rest;
    this._rate = rate;
    this._rampLeft = rampLeft;
    this._rampDelay = rampDelay;
  }
}
