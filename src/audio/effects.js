// Per-channel FX rack (echo, flanger, reverb send) and the shared reverb, built from native Web Audio nodes.
// The bit crusher runs inside the deck DSP (Deck.setFx('crush') -> player.setCrush).
//
//   const reverb = new ReverbBus(ctx);  reverb.output.connect(masterBus);
//   const rack = new FxRack(ctx, { reverbSend });     // reverbSend: GainNode owned by the ChannelStrip
//   eqOut.connect(rack.input);  rack.output.connect(fader);
//   rack.setBeatSeconds(60 / 128);  rack.set('echo', true);  rack.setAmount(0.6);
//   const secs = rack.echoOut(60 / 128);   // dry fades over 4 beats; pause the deck after `secs`
//
// Signal: output = dry (unity) + echo wet + flanger wet. Echo and reverb tails ring out after switching off
// (only their sends close); the flanger closes fully.

import { clamp, mulberry32 } from '../core/util.js';

export const FX_TYPES = ['echo', 'reverb', 'flanger', 'crush'];

const RAMP = 0.02;              // on/off ramps (s)
const SMOOTH_TAU = 0.015;       // knob smoothing time constant (s)
const ECHO_FEEDBACK = 0.45;
const ECHO_OUT_FEEDBACK = 0.6;
const FLANGER_BASE = 0.004;     // s
const FLANGER_DEPTH = 0.002;    // s (the bottom of the sweep is clamped to one render quantum in a cycle)
const FLANGER_FEEDBACK = 0.55;

/** Set automationRate = 'k-rate' where supported (Chrome, Safari); Firefox ignores it harmlessly. */
export function kRate(...params) {
  for (const p of params) {
    try {
      p.automationRate = 'k-rate';
    } catch {
      /* not supported */
    }
  }
}

/** Glide an AudioParam to `value` with a time constant (no zipper noise). */
export function smoothParam(param, value, ctx, tau = SMOOTH_TAU) {
  if (!Number.isFinite(value)) return;
  const now = ctx.currentTime;
  try {
    param.cancelScheduledValues(now);
    param.setTargetAtTime(value, now, tau);
  } catch {
    try {
      param.value = value;
    } catch {
      /* ignore */
    }
  }
}

/** Freeze an AudioParam at its current value (cancels ramps without a jump). Returns the hold time. */
export function holdParam(param, ctx) {
  const now = ctx.currentTime;
  try {
    if (typeof param.cancelAndHoldAtTime === 'function') {
      param.cancelAndHoldAtTime(now);
      return now;
    }
  } catch {
    /* fall through */
  }
  try {
    const v = param.value;
    param.cancelScheduledValues(now);
    param.setValueAtTime(v, now);
  } catch {
    /* ignore */
  }
  return now;
}

/** Like smoothParam, but first freezes any ramp in progress (use on params that also get linear ramps). */
export function glideParam(param, value, ctx, tau = SMOOTH_TAU) {
  if (!Number.isFinite(value)) return;
  const t = holdParam(param, ctx);
  try {
    param.setTargetAtTime(value, t, tau);
  } catch {
    try {
      param.value = value;
    } catch {
      /* ignore */
    }
  }
}

/** Linear ramp from the current value to `value` over `seconds`. */
export function rampParam(param, value, ctx, seconds = RAMP) {
  const t = holdParam(param, ctx);
  try {
    param.linearRampToValueAtTime(value, t + seconds);
  } catch {
    try {
      param.value = value;
    } catch {
      /* ignore */
    }
  }
}

function gainNode(ctx, value = 1) {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

function biquad(ctx, type, freq, qDb) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = qDb;
  kRate(f.frequency, f.Q, f.gain);
  return f;
}

export class FxRack {
  /**
   * @param {BaseAudioContext} ctx
   * @param {{ reverbSend?: GainNode }} opts reverbSend: post-fader send gain owned by the ChannelStrip
   */
  constructor(ctx, { reverbSend = null } = {}) {
    this.ctx = ctx;
    this._reverbSend = reverbSend;
    this._on = { echo: false, flanger: false, reverb: false };
    this._amount = 0.5;
    this._beat = 0.5;
    this._echoOutTimer = 0;
    this._echoOutActive = false;

    this.input = gainNode(ctx, 1);
    this.output = gainNode(ctx, 1);
    this._dry = gainNode(ctx, 1);
    this.input.connect(this._dry);
    this._dry.connect(this.output);

    // Echo: send -> delay -> HP 250 -> LP 4.5k -> wet; filtered signal feeds back into the delay.
    this._echoSend = gainNode(ctx, 0);
    this._echoDelay = ctx.createDelay(2);
    this._echoDelay.delayTime.value = clamp(0.75 * this._beat, 0.06, 2);
    this._echoHp = biquad(ctx, 'highpass', 250, -3.0103);
    this._echoLp = biquad(ctx, 'lowpass', 4500, -3.0103);
    this._echoFb = gainNode(ctx, ECHO_FEEDBACK);
    this._echoWet = gainNode(ctx, 1);
    this.input.connect(this._echoSend);
    this._echoSend.connect(this._echoDelay);
    this._echoDelay.connect(this._echoHp);
    this._echoHp.connect(this._echoLp);
    this._echoLp.connect(this._echoFb);
    this._echoFb.connect(this._echoDelay);
    this._echoLp.connect(this._echoWet);
    this._echoWet.connect(this.output);

    // Flanger: send -> modulated short delay (with feedback) -> wet.
    this._flSend = gainNode(ctx, 0);
    this._flDelay = ctx.createDelay(0.05);
    this._flDelay.delayTime.value = FLANGER_BASE;
    this._flFb = gainNode(ctx, FLANGER_FEEDBACK);
    this._flWet = gainNode(ctx, 0);
    this._lfo = ctx.createOscillator();
    this._lfo.type = 'sine';
    this._lfo.frequency.value = 1 / (8 * this._beat);
    this._lfoDepth = gainNode(ctx, FLANGER_DEPTH);
    this._lfo.connect(this._lfoDepth);
    this._lfoDepth.connect(this._flDelay.delayTime);
    this.input.connect(this._flSend);
    this._flSend.connect(this._flDelay);
    this._flDelay.connect(this._flFb);
    this._flFb.connect(this._flDelay);
    this._flDelay.connect(this._flWet);
    this._flWet.connect(this.output);
    try {
      this._lfo.start();
    } catch {
      /* ignore */
    }
  }

  /** Is an effect switched on? */
  isOn(name) {
    return !!this._on[name];
  }

  get amount() {
    return this._amount;
  }

  /** Switch 'echo' | 'flanger' | 'reverb' on or off (20 ms ramps; tails ring out). 'crush' is ignored here. */
  set(name, on) {
    if (!(name in this._on)) return;
    this._on[name] = !!on;
    this._applyLevels(RAMP);
  }

  /** 0..1 shared wet amount for all active effects of this rack. */
  setAmount(v) {
    this._amount = clamp(Number.isFinite(v) ? v : 0, 0, 1);
    this._applyLevels(0);
  }

  /** Musical timing: echo = 3/4 beat (0.06..2 s), flanger LFO period = 8 beats. */
  setBeatSeconds(sec) {
    if (!(sec > 0) || !Number.isFinite(sec)) return;
    this._beat = sec;
    smoothParam(this._echoDelay.delayTime, clamp(0.75 * sec, 0.06, 2), this.ctx, 0.05);
    smoothParam(this._lfo.frequency, clamp(1 / (8 * sec), 0.02, 5), this.ctx, 0.1);
  }

  /**
   * One-shot echo out: echo on with feedback 0.6 while the dry signal fades out over 4 beats. Returns the
   * seconds until the dry signal is silent (pause the deck then). The dry path and the echo settings restore
   * automatically 50 ms after that (the tail keeps ringing).
   */
  echoOut(beatSec) {
    const ctx = this.ctx;
    const beat = clamp(beatSec > 0 && Number.isFinite(beatSec) ? beatSec : this._beat, 0.2, 2);
    const secs = 4 * beat;
    this._clearEchoOut();
    this._echoOutActive = true;
    smoothParam(this._echoDelay.delayTime, clamp(0.75 * beat, 0.06, 2), ctx, 0.02);
    smoothParam(this._echoFb.gain, ECHO_OUT_FEEDBACK, ctx, 0.01);
    rampParam(this._echoSend.gain, Math.max(this._amount, 0.75), ctx, RAMP);
    const t = holdParam(this._dry.gain, ctx);
    try {
      this._dry.gain.linearRampToValueAtTime(0, t + secs);
    } catch {
      this._dry.gain.value = 0;
    }
    this._echoOutTimer = setTimeout(() => this._restoreAfterEchoOut(), Math.round((secs + 0.05) * 1000));
    return secs;
  }

  _restoreAfterEchoOut() {
    this._echoOutTimer = 0;
    if (!this._echoOutActive) return;
    this._echoOutActive = false;
    rampParam(this._dry.gain, 1, this.ctx, RAMP);
    smoothParam(this._echoFb.gain, ECHO_FEEDBACK, this.ctx, 0.8);
    this._applyLevels(RAMP);
  }

  _clearEchoOut() {
    if (this._echoOutTimer) clearTimeout(this._echoOutTimer);
    this._echoOutTimer = 0;
  }

  _applyLevels(rampSec) {
    const ctx = this.ctx;
    const a = this._amount;
    const set = (param, v) => {
      if (rampSec > 0) rampParam(param, v, ctx, rampSec);
      else glideParam(param, v, ctx);
    };
    if (!this._echoOutActive) set(this._echoSend.gain, this._on.echo ? a : 0);
    set(this._flSend.gain, this._on.flanger ? 1 : 0);
    set(this._flWet.gain, this._on.flanger ? a : 0);
    if (this._reverbSend) set(this._reverbSend.gain, this._on.reverb ? a : 0);
  }

  dispose() {
    this._clearEchoOut();
    try {
      this._lfo.stop();
    } catch {
      /* ignore */
    }
    const nodes = [this.input, this.output, this._dry, this._echoSend, this._echoDelay, this._echoHp, this._echoLp,
      this._echoFb, this._echoWet, this._flSend, this._flDelay, this._flFb, this._flWet, this._lfo, this._lfoDepth];
    for (const n of nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Generate a stereo reverb impulse response: decorrelated noise per channel, exponential decay to -60 dB at
 * `seconds`, high frequencies dying faster (time-varying one-pole low-pass), 4 ms fade-in, normalised energy.
 */
export function makeReverbIR(ctx, seconds = 2.2, energy = 0.4) {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.round(seconds * sr));
  const buf = ctx.createBuffer(2, len, sr);
  const fadeIn = Math.max(1, Math.round(0.004 * sr));
  const eStep = Math.exp(-Math.log(1000) / seconds / sr);   // amplitude -60 dB at `seconds`
  let sumSq = 0;
  const chans = [];
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    chans.push(d);
    const rnd = mulberry32(0x7e57 + c * 7919);
    let lp = 0;
    let e = 1;
    let k = 0;
    for (let i = 0; i < len; i++) {
      if ((i & 31) === 0) {
        const fc = 9000 * Math.pow(1200 / 9000, i / sr / seconds);
        k = 1 - Math.exp((-2 * Math.PI * fc) / sr);
      }
      lp += (rnd() * 2 - 1 - lp) * k;
      const v = i < fadeIn ? (lp * e * i) / fadeIn : lp * e;
      e *= eStep;
      d[i] = v;
      sumSq += v * v;
    }
  }
  const scale = sumSq > 0 ? Math.sqrt((2 * energy) / sumSq) : 1;
  for (const d of chans) for (let i = 0; i < len; i++) d[i] *= scale;
  return buf;
}

export class ReverbBus {
  /** One shared ConvolverNode fed by every channel's post-fader reverb send. */
  constructor(ctx) {
    this.ctx = ctx;
    this.input = biquad(ctx, 'highpass', 200, -3.0103);
    try {
      this.input.channelCount = 1;
      this.input.channelCountMode = 'explicit';
    } catch {
      /* keep stereo */
    }
    this._conv = ctx.createConvolver();
    this._conv.normalize = false;
    try {
      this._conv.buffer = makeReverbIR(ctx);
    } catch (err) {
      console.warn('[TwinSpin] reverb impulse failed', err);
    }
    this.output = gainNode(ctx, 1);
    this.input.connect(this._conv);
    this._conv.connect(this.output);
  }

  dispose() {
    for (const n of [this.input, this._conv, this.output]) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
  }
}
