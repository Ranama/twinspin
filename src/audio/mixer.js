// Two-channel DJ mixer built from native Web Audio nodes.
//
//   deck -> ChannelStrip: trim -> 3-band LR4 isolator -> filter (LP + HP) -> FxRack -> [PFL -> cue bus]
//           -> fader -> crossfader gain -> master bus ; crossfader gain -> reverb send -> shared reverb
//   master bus (+ reverb return) -> limiter (compressor + soft clip) -> master volume = masterOut
//   cue bus * (1 - cueMix) + limited master * cueMix -> soft clip -> cue volume = cueOut
//
//   const mixer = new Mixer(ctx);
//   player.node.connect(mixer.channels[0].input);
//   mixer.setCrossfader(-0.2);  mixer.channels[1].setEq('low', -1);  mixer.masterMeter.read().peak
//   mixer.scheduleCrossfade(-1, 1, t0, 15);   // Auto Mix: equal-power S-curve A -> B on the audio clock
//   mixer.crossfader;                         // follows the schedule (read it every frame for the UI)
//   mixer.channels[0].setEq('low', -1, { at: t0 + 7.5, ramp: 0.5 });   // bass swap, sample-exact
//   mixer.on('crossfader', ({ source }) => ...);   // 'user' moves vs 'auto' automation (takeover detection)
// The OutputRouter (outputs.js) connects masterOut / cueOut to the actual outputs.

import { Emitter } from '../core/emitter.js';
import { clamp, dbToGain } from '../core/util.js';
import { faderGain, xfadeGains, eqGain, filterParams, mixCrossfader } from './curves.js';
import { FxRack, ReverbBus, kRate, smoothParam } from './effects.js';

const BUTTERWORTH_Q_DB = -3.0103;   // BiquadFilter LP/HP Q is in dB: 20*log10(1/sqrt(2))
const LOW_XOVER = 250;
const HIGH_XOVER = 2500;
const FILTER_TAU = 0.015;
const FADER_TAU = 0.01;
const XFADE_TAU = 0.004;            // fast enough for cut-curve scratching
const CURVE_POINTS_PER_SEC = 32;    // scheduled crossfade curve resolution (linear in between)
const CURVE_MIN_POINTS = 65;
const CURVE_MAX_POINTS = 1025;
const PRE_GLIDE = 0.02;             // a crossfade that starts away from the current position glides there first
const AUTOMATION_MARGIN = 0.02;     // a param counts as automated this long after its automation ends

function gain(ctx, value = 1) {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

function biquad(ctx, type, freq, qDb = BUTTERWORTH_Q_DB) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = qDb;
  kRate(f.frequency, f.Q, f.gain);
  return f;
}

/** Chain nodes in series; returns [first, last]. */
function chain(...nodes) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return [nodes[0], nodes[nodes.length - 1]];
}

function disconnectAll(nodes) {
  for (const n of nodes) {
    try {
      if (n) n.disconnect();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Soft-clip curve over the input domain [-domain, domain] (scaled into the shaper's [-1, 1] range):
 * linear up to 0.9, tanh knee approaching 1.0. Use with a 1/domain pre-gain and a domain post-gain.
 */
export function softClipCurve(points = 4097, domain = 2) {
  const c = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const x = ((i / (points - 1)) * 2 - 1) * domain;
    const a = Math.abs(x);
    const y = a <= 0.9 ? a : 0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1);
    c[i] = (x < 0 ? -y : y) / domain;
  }
  return c;
}

/** Soft clipper: pre-gain -> WaveShaper (2x oversampled) -> post-gain. Returns { input, output, nodes }. */
function makeSoftClip(ctx, curve) {
  const DOMAIN = 2;
  const pre = gain(ctx, 1 / DOMAIN);
  const shaper = ctx.createWaveShaper();
  shaper.curve = curve;
  try {
    shaper.oversample = '2x';
  } catch {
    /* ignore */
  }
  const post = gain(ctx, DOMAIN);
  chain(pre, shaper, post);
  return { input: pre, output: post, nodes: [pre, shaper, post] };
}

/**
 * One AudioParam that gets both smooth user moves and scheduled automation (crossfade curves, timed EQ
 * ramps). It knows the value the param has at any context time without reading param.value (Firefox does
 * not update it during automation), freezes it mid-automation without a jump (cancelAndHoldAtTime where
 * available, else the computed value), and keeps the event list legal (setValueCurveAtTime refuses
 * overlapping events). Without automation in play, smooth() is exactly the old smoothParam() behaviour.
 */
export class AutoParam {
  /**
   * @param {BaseAudioContext} ctx
   * @param {AudioParam} param
   * @param {number} value the param's current value
   */
  constructor(ctx, param, value) {
    this.ctx = ctx;
    this.param = param;
    this._kind = 'set';         // 'set' | 'target' | 'ramp' | 'curve'
    this._t0 = 0;               // when the current segment starts (target: start; ramp: ramp start)
    this._v0 = value;           // value at _t0 (target), or the held value before a ramp / curve
    this._v1 = value;           // target value (set / target / ramp end)
    this._tau = 0;
    this._t1 = 0;               // ramp end
    this._tPre = 0;             // curve: when it was scheduled (the hold)
    this._glideEnd = 0;         // curve: end of the quick glide to the first curve value (= _tPre: none)
    this._curve = null;
    this._dur = 0;
    this._after = value;        // curve: value after its end
    this._autoStart = -Infinity; // time of the first event the current automation added (fallback cancel)
    this._autoEnd = -Infinity;   // automation (ramp / curve) is in play until this time
    this._heldAt = -Infinity;    // last freeze (its events at that time must survive the next move)
  }

  /** True while scheduled automation (ramp or curve) is pending or running. */
  get automated() {
    return this.ctx.currentTime < this._autoEnd;
  }

  /** The value the param has at context time t (as far as this object scheduled it). */
  valueAt(t) {
    switch (this._kind) {
      case 'target':
        return t <= this._t0 ? this._v0 : this._v1 + (this._v0 - this._v1) * Math.exp(-(t - this._t0) / this._tau);
      case 'ramp': {
        if (t <= this._t0) return this._v0;
        if (t >= this._t1) return this._v1;
        return this._v0 + ((this._v1 - this._v0) * (t - this._t0)) / (this._t1 - this._t0);
      }
      case 'curve': {
        const c = this._curve;
        const n = c.length;
        if (t < this._t0) {
          if (this._glideEnd <= this._tPre || t <= this._tPre) return this._v0;
          if (t >= this._glideEnd) return c[0];
          return this._v0 + ((c[0] - this._v0) * (t - this._tPre)) / (this._glideEnd - this._tPre);
        }
        if (t >= this._t0 + this._dur) return this._after;
        const u = ((t - this._t0) / this._dur) * (n - 1);
        const i = Math.floor(u);
        if (i >= n - 1) return c[n - 1];
        return c[i] + (c[i + 1] - c[i]) * (u - i);
      }
      default:
        return this._v1;
    }
  }

  /** The value to report as "the setting": the target of a smooth move, the live value of automation. */
  current() {
    return this._kind === 'ramp' || this._kind === 'curve' ? this.valueAt(this.ctx.currentTime) : this._v1;
  }

  /** Freeze the param at its current value (cancels pending and running automation). Returns the value. */
  freeze() {
    return this._hold(this.ctx.currentTime);
  }

  _hold(now) {
    const p = this.param;
    const v = this.valueAt(now);
    let held = false;
    if (typeof p.cancelAndHoldAtTime === 'function') {
      try {
        p.cancelAndHoldAtTime(now);
        held = true;
      } catch {
        held = false;
      }
    }
    if (!held) {
      // no cancelAndHoldAtTime (Firefox): drop the automation events (from the first one, so a running curve
      // goes too and nothing overlaps) and pin the computed value at `now`
      const from = Number.isFinite(this._autoStart) && this._autoStart < now ? this._autoStart : now;
      try {
        p.cancelScheduledValues(from);
      } catch {
        /* ignore */
      }
      try {
        p.setValueAtTime(v, now);
      } catch {
        try {
          p.value = v;
        } catch {
          /* ignore */
        }
      }
    }
    this._kind = 'set';
    this._v0 = v;
    this._v1 = v;
    this._t0 = now;
    this._autoStart = -Infinity;
    this._autoEnd = -Infinity;
    this._heldAt = now;
    return v;
  }

  /** Glide to `value` with time constant tau (user moves). Freezes running automation first. */
  smooth(value, tau) {
    if (!Number.isFinite(value)) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const from = this.valueAt(now);
    if (now < this._autoEnd || now - this._heldAt < AUTOMATION_MARGIN) {
      // automation in play (or just frozen): a plain cancelScheduledValues(now) would drop the hold and let
      // the value jump back, so freeze again and glide from there
      this._hold(now);
      try {
        this.param.setTargetAtTime(value, now, tau);
      } catch {
        try {
          this.param.value = value;
        } catch {
          /* ignore */
        }
      }
    } else {
      smoothParam(this.param, value, ctx, tau);
    }
    this._kind = 'target';
    this._t0 = now;
    this._v0 = from;
    this._v1 = value;
    this._tau = tau > 0 ? tau : 1e-3;
  }

  /**
   * Linear ramp to `value` starting at context time `at` (now when earlier) over `seconds` (0 = a step at
   * `at`). Until `at` the param holds its current value. Replaces earlier automation.
   */
  rampTo(value, at, seconds) {
    if (!Number.isFinite(value)) return;
    const p = this.param;
    const now = this.ctx.currentTime;
    const ts = Number.isFinite(at) && at > now ? at : now;
    const dur = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    const v0 = this._hold(now);
    try {
      if (ts > now) p.setValueAtTime(v0, ts);
      if (dur > 0) p.linearRampToValueAtTime(value, ts + dur);
      else p.setValueAtTime(value, ts);
    } catch {
      try {
        p.value = value;
      } catch {
        /* ignore */
      }
    }
    this._kind = 'ramp';
    this._t0 = ts;
    this._t1 = ts + dur;
    this._v0 = v0;
    this._v1 = value;
    this._autoStart = ts > now ? ts : now;
    this._autoEnd = ts + dur + AUTOMATION_MARGIN;
  }

  /**
   * Follow `values` (Float32Array, uniformly spaced) from context time `start` (must be later than now) for
   * `duration` seconds, then hold `after`. A first value away from the current one is reached by a quick
   * glide (PRE_GLIDE) before the curve starts. Replaces earlier automation.
   */
  curve(values, start, duration, after) {
    const p = this.param;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const sr = ctx.sampleRate > 0 ? ctx.sampleRate : 48000;
    const v0 = this._hold(now);
    const c0 = values[0];
    const last = values[values.length - 1];
    const tail = Number.isFinite(after) ? after : last;
    let glideEnd = now;
    if (Math.abs(c0 - v0) > 1e-4) {
      const g = Math.min(now + PRE_GLIDE, start - 1 / sr);
      if (g > now) glideEnd = g;
    }
    try {
      if (glideEnd > now) p.linearRampToValueAtTime(c0, glideEnd);
      p.setValueCurveAtTime(values, start, duration);
      if (Math.abs(tail - last) > 1e-6) p.setValueAtTime(tail, start + duration);
    } catch (err) {
      // an engine that refuses the curve: the same shape as a chain of linear ramps
      console.warn('[TwinSpin] crossfade curve refused, using ramps', err);
      try {
        p.cancelScheduledValues(now);
        p.setValueAtTime(v0, now);
        if (glideEnd > now) p.linearRampToValueAtTime(c0, glideEnd);
        p.setValueAtTime(c0, start);
        const n = values.length;
        for (let k = 1; k < n; k++) p.linearRampToValueAtTime(values[k], start + (duration * k) / (n - 1));
        if (Math.abs(tail - last) > 1e-6) p.setValueAtTime(tail, start + duration);
      } catch {
        try {
          p.value = tail;
        } catch {
          /* ignore */
        }
      }
    }
    this._kind = 'curve';
    this._tPre = now;
    this._glideEnd = glideEnd;
    this._t0 = start;
    this._dur = duration;
    this._curve = values;
    this._v0 = v0;
    this._v1 = tail;
    this._after = tail;
    this._autoStart = now;
    this._autoEnd = start + duration + AUTOMATION_MARGIN;
  }
}

export class Meter {
  /** AnalyserNode tap (fftSize 512). read() once per animation frame. */
  constructor(ctx, sourceNode) {
    this.ctx = ctx;
    this._an = ctx.createAnalyser();
    this._an.fftSize = 512;
    this._an.smoothingTimeConstant = 0;
    this._buf = new Float32Array(this._an.fftSize);
    this._out = { peak: 0, rms: 0 };
    if (sourceNode) sourceNode.connect(this._an);
  }

  get node() {
    return this._an;
  }

  /** Linear { peak, rms } of the last 512 samples (0..1+). The returned object is reused. */
  read() {
    const b = this._buf;
    try {
      this._an.getFloatTimeDomainData(b);
    } catch {
      this._out.peak = 0;
      this._out.rms = 0;
      return this._out;
    }
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < b.length; i++) {
      const v = b[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sum += v * v;
    }
    this._out.peak = peak;
    this._out.rms = Math.sqrt(sum / b.length);
    return this._out;
  }

  dispose() {
    disconnectAll([this._an]);
  }
}

export class ChannelStrip {
  /**
   * @param {BaseAudioContext} ctx
   * @param {'A'|'B'} name
   * @param {{ reverbInput?: AudioNode, masterInput?: AudioNode, cueInput?: AudioNode }} opts
   *   reverbInput = ReverbBus.input; masterInput / cueInput are connected by the Mixer when omitted here.
   */
  constructor(ctx, name, { reverbInput = null, masterInput = null, cueInput = null } = {}) {
    this.ctx = ctx;
    this.name = name;
    this._state = { trimDb: 0, eq: { low: 0, mid: 0, high: 0 }, filter: 0, volume: 1, xfade: 1, cue: false };

    // trim (input)
    this.input = gain(ctx, 1);

    // 3-band isolator from Linkwitz-Riley 4th-order crossovers (two cascaded Butterworth biquads each)
    this._low = gain(ctx, 1);
    this._mid = gain(ctx, 1);
    this._high = gain(ctx, 1);
    this._eqSum = gain(ctx, 1);
    const lowChain = [biquad(ctx, 'lowpass', LOW_XOVER), biquad(ctx, 'lowpass', LOW_XOVER)];
    const midChain = [biquad(ctx, 'highpass', LOW_XOVER), biquad(ctx, 'highpass', LOW_XOVER),
      biquad(ctx, 'lowpass', HIGH_XOVER), biquad(ctx, 'lowpass', HIGH_XOVER)];
    const highChain = [biquad(ctx, 'highpass', HIGH_XOVER), biquad(ctx, 'highpass', HIGH_XOVER)];
    chain(this.input, ...lowChain, this._low, this._eqSum);
    chain(this.input, ...midChain, this._mid, this._eqSum);
    chain(this.input, ...highChain, this._high, this._eqSum);
    this._eqFilters = [...lowChain, ...midChain, ...highChain];

    // DJ filter: low-pass then high-pass, both open at the centre
    this._lp = biquad(ctx, 'lowpass', Math.min(22000, ctx.sampleRate / 2 - 50));
    this._hp = biquad(ctx, 'highpass', 10);
    chain(this._eqSum, this._lp, this._hp);

    // FX rack (pre-fader) and the post-fader reverb send it controls
    this._reverbSend = gain(ctx, 0);
    this.fx = new FxRack(ctx, { reverbSend: this._reverbSend });
    this._hp.connect(this.fx.input);

    // PFL tap: post-FX, pre-fader
    this.pfl = gain(ctx, 0);
    this.fx.output.connect(this.pfl);

    // fader -> crossfader gain -> output
    this._fader = gain(ctx, 1);
    this._xfade = gain(ctx, 1);
    this.output = this._xfade;
    chain(this.fx.output, this._fader, this._xfade);
    this._xfade.connect(this._reverbSend);
    if (reverbInput) this._reverbSend.connect(reverbInput);
    if (masterInput) this.output.connect(masterInput);
    if (cueInput) this.pfl.connect(cueInput);

    this.meter = new Meter(ctx, this._fader);

    // params that also get scheduled automation (Auto Mix crossfades, bass swaps)
    this._xf = new AutoParam(ctx, this._xfade.gain, 1);
    this._eqP = {
      low: new AutoParam(ctx, this._low.gain, 1),
      mid: new AutoParam(ctx, this._mid.gain, 1),
      high: new AutoParam(ctx, this._high.gain, 1),
    };
    // state.xfade is live: the crossfader gain right now, also while a scheduled crossfade moves it
    Object.defineProperty(this._state, 'xfade', {
      enumerable: true,
      configurable: true,
      get: () => clamp(this._xf.current(), 0, 1),
    });
  }

  /** Read-only snapshot of the strip settings (`xfade` follows a scheduled crossfade live). */
  get state() {
    return this._state;
  }

  /** Auto gain + manual trim in dB, -24..+12. */
  setTrimDb(db) {
    const v = clamp(Number.isFinite(db) ? db : 0, -24, 12);
    this._state.trimDb = v;
    smoothParam(this.input.gain, dbToGain(v), this.ctx, FADER_TAU);
  }

  /**
   * band 'low' | 'mid' | 'high', v -1..1 (kill at the bottom, +6 dB at the top). Without options the band
   * glides there now (15 ms). opts.at (context time) and/or opts.ramp (seconds): the band gain holds until
   * `at` (now when omitted or past), then ramps linearly to the new gain over `ramp` (0 = a step at `at`),
   * sample-exact on the audio clock (Auto Mix bass swap). state.eq[band] takes the new value at once. A later
   * call (timed or not) replaces a pending or running timed change without a jump.
   * @param {'low'|'mid'|'high'} band
   * @param {number} v
   * @param {{ at?: number, ramp?: number }} [opts]
   */
  setEq(band, v, opts) {
    const ap = band === 'low' || band === 'mid' || band === 'high' ? this._eqP[band] : null;
    if (!ap) return;
    const x = clamp(Number.isFinite(v) ? v : 0, -1, 1);
    this._state.eq[band] = x;
    const at = opts && typeof opts.at === 'number' && Number.isFinite(opts.at) ? opts.at : null;
    const ramp = opts && typeof opts.ramp === 'number' && opts.ramp > 0 && Number.isFinite(opts.ramp) ? opts.ramp : 0;
    if (at === null && ramp === 0) ap.smooth(eqGain(x), FILTER_TAU);
    else ap.rampTo(eqGain(x), at === null ? this.ctx.currentTime : at, ramp);
  }

  /** Filter knob -1 (low-pass) .. 0 (open) .. 1 (high-pass). */
  setFilter(v) {
    const x = clamp(Number.isFinite(v) ? v : 0, -1, 1);
    this._state.filter = x;
    const p = filterParams(x);
    const ctx = this.ctx;
    smoothParam(this._lp.frequency, Math.min(p.lp, ctx.sampleRate / 2 - 50), ctx, FILTER_TAU);
    smoothParam(this._hp.frequency, p.hp, ctx, FILTER_TAU);
    // resonance only on the active filter; the parked one stays Butterworth-flat
    smoothParam(this._lp.Q, x < -0.04 ? p.qDb : BUTTERWORTH_Q_DB, ctx, FILTER_TAU);
    smoothParam(this._hp.Q, x > 0.04 ? p.qDb : BUTTERWORTH_Q_DB, ctx, FILTER_TAU);
  }

  /** Channel fader 0..1 (audio taper). */
  setVolume(v) {
    const x = clamp(Number.isFinite(v) ? v : 0, 0, 1);
    this._state.volume = x;
    smoothParam(this._fader.gain, faderGain(x), this.ctx, FADER_TAU);
  }

  /** Crossfader gain for this channel (set by the Mixer). Freezes a scheduled crossfade first. */
  setXfadeGain(g) {
    const x = clamp(Number.isFinite(g) ? g : 0, 0, 1);
    this._xf.smooth(x, XFADE_TAU);
  }

  /**
   * Mixer only: schedule this channel's crossfader gain along `values` (uniform points) from context time
   * `start` for `duration` s, then hold `after`.
   */
  scheduleXfadeGain(values, start, duration, after) {
    this._xf.curve(values, start, duration, after);
  }

  /** Mixer only: stop a scheduled crossfader gain where it is now. Returns the frozen gain. */
  freezeXfadeGain() {
    return this._xf.freeze();
  }

  /** Crossfader gain at context time t (follows scheduled automation). */
  xfadeGainAt(t) {
    return this._xf.valueAt(t);
  }

  /** Headphone pre-listen (PFL) on/off. */
  setCue(on) {
    this._state.cue = !!on;
    smoothParam(this.pfl.gain, on ? 1 : 0, this.ctx, 0.005);
  }

  dispose() {
    this.fx.dispose();
    this.meter.dispose();
    disconnectAll([this.input, this._low, this._mid, this._high, this._eqSum, ...this._eqFilters, this._lp, this._hp,
      this.pfl, this._fader, this._xfade, this._reverbSend]);
  }
}

export class Mixer extends Emitter {
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this._x = 0;
    this._sched = null;         // scheduled crossfade { from, to, start, duration, end, t0, x0, glideEnd }
    this._curve = 'smooth';
    this._masterVolume = 0.8;
    this._cueVolume = 0.8;
    this._cueMix = 0;

    this.reverb = new ReverbBus(ctx);
    this.masterBus = gain(ctx, 1);
    this.cueBus = gain(ctx, 1);
    this.reverb.output.connect(this.masterBus);

    this.channels = [
      new ChannelStrip(ctx, 'A', { reverbInput: this.reverb.input, masterInput: this.masterBus, cueInput: this.cueBus }),
      new ChannelStrip(ctx, 'B', { reverbInput: this.reverb.input, masterInput: this.masterBus, cueInput: this.cueBus }),
    ];

    // master: brick-ish limiter (compressor) then a soft clip that guarantees |x| < 1
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -3;
    comp.knee.value = 0;
    comp.ratio.value = 20;
    comp.attack.value = 0.002;
    comp.release.value = 0.15;
    this._limiter = comp;
    const curve = softClipCurve();
    this._masterClip = makeSoftClip(ctx, curve);
    this._masterVol = gain(ctx, faderGain(this._masterVolume));
    this.masterBus.connect(comp);
    comp.connect(this._masterClip.input);
    this._masterClip.output.connect(this._masterVol);
    this.masterOut = this._masterVol;

    // headphones: cue bus and the limited master blended by cueMix
    this._cueDry = gain(ctx, 1);
    this._cueMaster = gain(ctx, 0);
    this._cueSum = gain(ctx, 1);
    this.cueBus.connect(this._cueDry);
    this._masterClip.output.connect(this._cueMaster);
    this._cueDry.connect(this._cueSum);
    this._cueMaster.connect(this._cueSum);
    this._cueClip = makeSoftClip(ctx, curve);
    this._cueSum.connect(this._cueClip.input);
    this._cueVol = gain(ctx, faderGain(this._cueVolume));
    this._cueClip.output.connect(this._cueVol);
    this.cueOut = this._cueVol;

    // meters: master after the limiter (before the volume), cue mix before the cue volume
    this.masterMeter = new Meter(ctx, this._masterClip.output);
    this.cueMeter = new Meter(ctx, this._cueClip.output);

    this._applyXfade();
  }

  /** Crossfader position -1 (A) .. +1 (B); while a scheduled crossfade runs, its value at ctx.currentTime. */
  get crossfader() {
    const s = this._sched;
    if (!s) return this._x;
    const t = this.ctx.currentTime;
    if (t >= s.end) {
      this._x = s.to;
      this._sched = null;
      return this._x;
    }
    return this._schedX(s, t);
  }

  /** True from scheduleCrossfade() until that crossfade has ended (or was cancelled). */
  get crossfadeScheduled() {
    const s = this._sched;
    return !!s && this.ctx.currentTime < s.end;
  }

  /** { from, to, start, duration } of the scheduled crossfade until it ends (same object each call), or null. */
  get crossfadeSchedule() {
    const s = this._sched;
    if (!s || this.ctx.currentTime >= s.end) return null;
    return s.info;
  }

  get crossfaderCurve() {
    return this._curve;
  }

  /** Current limiter gain reduction in dB (<= 0), for a clip/limit indicator. */
  get limiterReductionDb() {
    const r = this._limiter.reduction;
    return typeof r === 'number' ? r : r && typeof r.value === 'number' ? r.value : 0;
  }

  /**
   * Crossfader -1 (A) .. +1 (B), now (4 ms glide). Cancels a scheduled crossfade first (no jump: the move
   * starts from where the automation is). Emits 'crossfader' { source, x, scheduled: false, cancelled }
   * where source is opts.source (default 'user'; Auto Mix passes 'auto').
   * @param {number} x
   * @param {{ source?: string }} [opts]
   */
  setCrossfader(x, opts) {
    const source = opts && typeof opts.source === 'string' ? opts.source : 'user';
    const cancelled = this._stopSchedule();
    this._x = clamp(Number.isFinite(x) ? x : 0, -1, 1);
    this._applyXfade();
    this.emit('crossfader', { source, x: this._x, scheduled: false, cancelled });
  }

  /**
   * Auto Mix: move the crossfader from `fromX` to `toX` on the audio clock, starting at context time
   * `startTime` for `duration` seconds, along an equal-power S-curve (mixCrossfader / xfadeSCurve in
   * curves.js) whatever the user's crossfader curve is. Both channel gains get a setValueCurveAtTime (>= 65
   * points). Before the start the gains hold (a crossfader that is not at `fromX` glides there in 20 ms);
   * a start in the past begins part way through (the curve keeps its timing). Replaces an earlier schedule.
   * `crossfader` reports the live position meanwhile. Emits 'crossfader' { source: 'auto', scheduled: true,
   * x, from, to, start, duration }. A zero duration, or a crossfade already over, just sets toX now.
   * @returns {boolean} false when nothing was left to schedule (the crossfader was simply set to toX)
   */
  scheduleCrossfade(fromX, toX, startTime, duration) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const sr = ctx.sampleRate > 0 ? ctx.sampleRate : 48000;
    const x0 = this.crossfader;
    const from = clamp(Number.isFinite(fromX) ? fromX : x0, -1, 1);
    const to = clamp(Number.isFinite(toX) ? toX : from, -1, 1);
    const start = Number.isFinite(startTime) ? startTime : now;
    const dur = Number.isFinite(duration) && duration > 0 ? duration : 0;
    const end = start + dur;
    // the freeze sits at `now`; the curve may not share its time, so it begins a render quantum later
    const minStart = now + 128 / sr;
    if (!(dur > 0) || !(end > minStart + 1 / sr)) {
      this._stopSchedule();
      this._x = to;
      this._applyXfade();
      this.emit('crossfader', { source: 'auto', x: to, scheduled: false, cancelled: false });
      return false;
    }
    const cs = start > minStart ? start : minStart;
    const cdur = end - cs;
    const p0 = dur > 0 ? (cs - start) / dur : 0;
    let n = Math.ceil(cdur * CURVE_POINTS_PER_SEC) + 1;
    n = n < CURVE_MIN_POINTS ? CURVE_MIN_POINTS : n > CURVE_MAX_POINTS ? CURVE_MAX_POINTS : n;
    const ga = new Float32Array(n);
    const gb = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const u = p0 + ((1 - p0) * k) / (n - 1);
      const g = xfadeGains(mixCrossfader(from, to, u), 'smooth');
      ga[k] = g[0];
      gb[k] = g[1];
    }
    // after the mix the gains follow the user's curve at `to` (identical at the ends)
    const after = xfadeGains(to, this._curve);
    this._sched = null;
    this.channels[0].scheduleXfadeGain(ga, cs, cdur, after[0]);
    this.channels[1].scheduleXfadeGain(gb, cs, cdur, after[1]);
    const glide = Math.abs(from - x0) > 1e-4 ? Math.min(now + PRE_GLIDE, cs - 1 / sr) : now;
    this._sched = {
      from, to, start, duration: dur, end, t0: now, x0, glideEnd: glide > now ? glide : now,
      info: Object.freeze({ from, to, start, duration: dur }),
    };
    this.emit('crossfader', { source: 'auto', x: x0, scheduled: true, from, to, start, duration: dur });
    return true;
  }

  /**
   * Stop a scheduled crossfade where it is: both gains freeze at their current values and `crossfader`
   * stays at the current position. Emits 'crossfader' { source, x, scheduled: false, cancelled: true }
   * (source = opts.source, default 'auto') when a schedule was running. Returns true when one was.
   * @param {{ source?: string }} [opts]
   */
  cancelCrossfade(opts) {
    const source = opts && typeof opts.source === 'string' ? opts.source : 'auto';
    if (!this._stopSchedule()) return false;
    this.emit('crossfader', { source, x: this._x, scheduled: false, cancelled: true });
    return true;
  }

  /** Freeze a running schedule (no event). Returns true when one was pending or running. */
  _stopSchedule() {
    const s = this._sched;
    if (!s) return false;
    this._sched = null;
    const t = this.ctx.currentTime;
    if (t >= s.end) {
      this._x = s.to;
      return false;
    }
    this._x = this._schedX(s, t);
    for (const ch of this.channels) ch.freezeXfadeGain();
    return true;
  }

  /** Crossfader position of schedule `s` at context time t. */
  _schedX(s, t) {
    if (t < s.start) {
      if (s.glideEnd <= s.t0) return s.x0;
      if (t >= s.glideEnd) return s.from;
      return t <= s.t0 ? s.x0 : s.x0 + ((s.from - s.x0) * (t - s.t0)) / (s.glideEnd - s.t0);
    }
    return mixCrossfader(s.from, s.to, s.duration > 0 ? (t - s.start) / s.duration : 1);
  }

  /**
   * 'smooth' (constant power) | 'cut' (scratch). A running scheduled crossfade keeps its equal-power
   * shape; the new curve applies from the next crossfader move.
   */
  setCrossfaderCurve(curve) {
    this._curve = curve === 'cut' ? 'cut' : 'smooth';
    if (!this.crossfadeScheduled) this._applyXfade();
  }

  _applyXfade() {
    const [a, b] = xfadeGains(this._x, this._curve);
    this.channels[0].setXfadeGain(a);
    this.channels[1].setXfadeGain(b);
  }

  /** Master volume 0..1 (audio taper), after the limiter. */
  setMasterVolume(v) {
    this._masterVolume = clamp(Number.isFinite(v) ? v : 0, 0, 1);
    smoothParam(this._masterVol.gain, faderGain(this._masterVolume), this.ctx, FADER_TAU);
  }

  /** Headphone volume 0..1 (audio taper). */
  setCueVolume(v) {
    this._cueVolume = clamp(Number.isFinite(v) ? v : 0, 0, 1);
    smoothParam(this._cueVol.gain, faderGain(this._cueVolume), this.ctx, FADER_TAU);
  }

  /** Headphone blend: 0 = cue (PFL) only ... 1 = master only. */
  setCueMix(v) {
    this._cueMix = clamp(Number.isFinite(v) ? v : 0, 0, 1);
    smoothParam(this._cueDry.gain, 1 - this._cueMix, this.ctx, FADER_TAU);
    smoothParam(this._cueMaster.gain, this._cueMix, this.ctx, FADER_TAU);
  }

  dispose() {
    for (const ch of this.channels) ch.dispose();
    this.reverb.dispose();
    this.masterMeter.dispose();
    this.cueMeter.dispose();
    disconnectAll([this.masterBus, this.cueBus, this._limiter, ...this._masterClip.nodes, this._masterVol,
      this._cueDry, this._cueMaster, this._cueSum, ...this._cueClip.nodes, this._cueVol]);
  }
}
