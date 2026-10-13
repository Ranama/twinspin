// Tests for the engine's audio-clock scheduling (Auto Mix, docs/AUTOMIX.md section 3): DeckPlayer.playAt /
// seekAt / setRate ramps / positionAt end to end through the real worklet processor (fake AudioContext with
// output latency, decks rendering in lock-step), the SYNC phase alignment (bug: ~15 ms off), and the mixer's
// scheduled crossfade and timed EQ on a small Web Audio AudioParam simulator that enforces the automation
// rules (setValueCurveAtTime may not overlap other events) and computes the values the params really take.

import { DeckDSP } from '../src/audio/deck-dsp.js';
import { processorMain } from '../src/audio/deck-worklet-src.js';
import { DeckPlayer } from '../src/audio/deck-player.js';
import { Mixer, AutoParam } from '../src/audio/mixer.js';
import { xfadeGains, eqGain, xfadeSCurve, mixCrossfader } from '../src/audio/curves.js';
import { mulberry32 } from '../src/core/util.js';

const SR = 8000;
const Q = 128;
const LAT = 0.03; // base + output latency of the fake context (what the listener hears lags the render clock)

function noise(seconds, seed) {
  const rnd = mulberry32(seed);
  const a = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < a.length; i++) a[i] = rnd() * 1.6 - 0.8;
  return a;
}

/** a - b wrapped into [-period/2, period/2). */
function wrapHalf(x, period) {
  let r = x % period;
  if (r < -period / 2) r += period;
  if (r >= period / 2) r -= period;
  return r;
}

// ------------------------------------------------------------------------------------------------ worklet rig

function installWorkletScope() {
  const registered = {};
  const scope = { frame: 0, registered };
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = { onmessage: null, peer: null, postMessage(m) { if (this.peer) this.peer(structuredClone(m)); } };
    }
  };
  globalThis.registerProcessor = (name, cls) => {
    if (!registered[name]) registered[name] = cls;
  };
  globalThis.sampleRate = SR;
  Object.defineProperty(globalThis, 'currentFrame', { configurable: true, get: () => scope.frame });
  return scope;
}

/**
 * One fake AudioContext with worklet decks rendering in lock-step. msgDelay: main -> worklet messages are
 * delivered that many render quanta late (a busy audio thread), so "now" commands land late.
 */
class Rig {
  constructor({ latency = LAT, msgDelay = 0 } = {}) {
    this.scope = installWorkletScope();
    processorMain(DeckDSP);
    this.ctx = { sampleRate: SR, currentTime: 0, baseLatency: latency / 2, outputLatency: latency / 2, state: 'running' };
    this.msgDelay = msgDelay;
    this.queue = [];
    this.procs = [];
    this.players = [];
    this.truth = [];
    this.L = new Float32Array(Q);
    this.R = new Float32Array(Q);
    this.quanta = 0;
  }

  addDeck(seconds = 20, seed = 1) {
    const Proc = this.scope.registered['twinspin-deck'];
    const proc = new Proc();
    const rig = this;
    const node = {
      port: {
        onmessage: null,
        postMessage(m) {
          const copy = structuredClone(m);
          if (rig.msgDelay > 0) rig.queue.push({ due: rig.quanta + rig.msgDelay, proc, m: copy });
          else proc.port.onmessage({ data: copy });
        },
      },
      connect() {},
      disconnect() {},
    };
    proc.port.peer = (m) => node.port.onmessage && node.port.onmessage({ data: m });
    const player = new DeckPlayer(this.ctx, { node, mode: 'blob' });
    this.procs.push(proc);
    this.players.push(player);
    this.truth.push([]);
    player.load([noise(seconds, seed)], SR);
    return player;
  }

  dsp(i) {
    return this.procs[i].dsp;
  }

  quantum() {
    const keep = [];
    for (const q of this.queue) {
      if (q.due <= this.quanta) q.proc.port.onmessage({ data: q.m });
      else keep.push(q);
    }
    this.queue = keep;
    this.procs.forEach((p, i) => {
      p.process([], [[this.L, this.R]], {});
      this.truth[i].push([this.scope.frame + Q, p.dsp.position]);
    });
    this.scope.frame += Q;
    this.quanta++;
    this.ctx.currentTime = this.scope.frame / SR;
  }

  run(seconds) {
    const n = Math.max(1, Math.round((seconds * SR) / Q));
    for (let i = 0; i < n; i++) this.quantum();
  }

  /** Render until the clock reaches frame f (a block boundary at or after it). */
  runToFrame(f) {
    while (this.scope.frame < f) this.quantum();
  }

  /** True position of deck i at context time T (DSP head at block ends, linear in between). */
  truthAt(i, T) {
    const tr = this.truth[i];
    const f = T * SR;
    for (let k = 1; k < tr.length; k++) {
      if (tr[k][0] >= f) {
        const [f0, p0] = tr[k - 1];
        const [f1, p1] = tr[k];
        return p0 + ((p1 - p0) * (f - f0)) / (f1 - f0);
      }
    }
    return NaN;
  }

  get audible() {
    return this.ctx.currentTime - LAT;
  }
}

/** The next block boundary at least `ahead` seconds from now (so the event frame ends a block exactly). */
function blockTime(rig, ahead) {
  return (Math.ceil(((rig.ctx.currentTime + ahead) * SR) / Q) * Q) / SR;
}

// ------------------------------------------------------------------------------------------------ SYNC bug

test('SYNC alignment: an immediate seek from heard positions lands one output latency late (the bug)', () => {
  const rig = new Rig();
  const leader = rig.addDeck(20, 1);
  const slave = rig.addDeck(20, 2);
  const beat = 0.5; // both 120 BPM, grid at 0
  slave.seek(3.37);
  leader.play();
  slave.play();
  rig.run(1);
  // what sync.js did before this round: phase from the two heard positions, then seek "now"
  const off = wrapHalf(leader.getPosition() - slave.getPosition(), beat);
  slave.seek(slave.getPosition() + off);
  rig.run(1);
  const err = wrapHalf(rig.dsp(1).position - rig.dsp(0).position, beat);
  assert.closeTo(err, -LAT, 2 / SR, `slave behind by the latency: ${err}`);
  // the two heard positions show the same error, so the bend loop then pulls it in slowly
  assert.closeTo(wrapHalf(slave.getPosition() - leader.getPosition(), beat), -LAT, 2 / SR);
});

test('SYNC alignment with positionAt + seekAt lands exactly (also with a ramping leader and late messages)', () => {
  for (const msgDelay of [0, 2]) {
    const rig = new Rig({ msgDelay });
    const leader = rig.addDeck(20, 3);
    const slave = rig.addDeck(20, 4);
    // leader: 120 BPM at +4 % = 124.8 effective; slave: a 124.8 BPM song at rate 1 (sync matched)
    const lBeat = 60 / 120;
    const sBeat = 60 / 124.8;
    leader.setRate(1.04);
    slave.seek(5.111);
    leader.play();
    slave.play();
    rig.run(1);
    leader.setRate(1.02, 4); // a meet-in-the-middle ramp is running while we align
    rig.run(0.5);
    const t = blockTime(rig, 0.1);
    const lp = leader.positionAt(t);
    const sp = slave.positionAt(t);
    // beat phase of the leader at t, expressed in slave beats
    const phase = wrapHalf((lp / lBeat - sp / sBeat) * sBeat, sBeat);
    const target = sp + phase;
    slave.seekAt(target, t);
    assert.deepEqual(slave.scheduledSeek, { pos: target, at: t });
    rig.runToFrame(Math.round(t * SR));
    // at frame t both heads are exactly where they were planned
    assert.closeTo(rig.dsp(1).position, target, 1e-9, `delay ${msgDelay}: slave on target`);
    assert.closeTo(rig.dsp(0).position, lp, 2e-5, `delay ${msgDelay}: leader prediction through the ramp`);
    const beatErr = wrapHalf(rig.dsp(0).position / lBeat - rig.dsp(1).position / sBeat, 1);
    assert(Math.abs(beatErr) < 1e-4, `delay ${msgDelay}: in phase at t (${beatErr} beats)`);
    rig.run(0.2);
    assert.equal(slave.scheduledSeek, null, 'confirmed by a report');
    // heard positions agree too (comparable between decks), up to the drift of the ramp since t
    const hl = leader.getPosition();
    const hs = slave.getPosition();
    const drift = (rig.audible - t) * Math.abs(leader.rate - 1.04);
    const heardErr = wrapHalf(hl / lBeat - hs / sBeat, 1) * sBeat;
    assert(Math.abs(heardErr) <= drift + 1e-4, `delay ${msgDelay}: heard phase ${heardErr} s`);
  }
});

// ------------------------------------------------------------------------------------------------ player

test('playAt: still until its time, then moves from exactly that frame', () => {
  const rig = new Rig();
  const p = rig.addDeck(10, 5);
  let plays = 0;
  p.on('play', () => plays++);
  p.seek(2);
  rig.run(0.2);
  const t = rig.ctx.currentTime + 0.2537;
  p.playAt(t);
  assert.equal(plays, 1, "'play' event (wake lock)");
  const tq = Math.round(t * SR) / SR;
  assert.equal(p.playing, false);
  assert.equal(p.scheduledStart, tq);
  assert.closeTo(p.positionAt(tq + 1), 3, 1e-9, 'planned trajectory');
  assert.closeTo(p.positionAt(tq - 0.1), 2, 1e-12);
  while (rig.ctx.currentTime + Q / SR <= tq) {
    rig.quantum();
    assert.equal(p.playing, false, 'not before its time');
    assert.equal(p.getPosition(), 2, 'position stays put');
  }
  rig.quantum(); // renders the start frame
  assert.equal(p.playing, true);
  assert.equal(p.scheduledStart, null);
  assert.closeTo(rig.dsp(0).position, 2 + (rig.scope.frame - Math.round(t * SR)) / SR, 1e-12, 'DSP started on the frame');
  // the start is heard LAT later: the heard position stays at 2 until then (never goes backwards)
  for (let i = 0; i < 6; i++) {
    rig.quantum();
    const heard = p.getPosition();
    const want = rig.audible < tq ? 2 : 2 + (rig.audible - tq);
    assert.closeTo(heard, want, 1e-9, `heard position at ${rig.audible}`);
  }
  rig.run(0.5);
  assert.closeTo(p.getPosition(), 2 + (rig.audible - tq), 1e-9);
  // already playing: no effect
  p.playAt(rig.ctx.currentTime + 1);
  assert.equal(p.scheduledStart, null);
});

test('playAt: pause and seek cancel it, seekAt keeps it, a past time starts on its timeline', () => {
  const rig = new Rig();
  const p = rig.addDeck(10, 6);
  rig.run(0.1);
  p.playAt(rig.ctx.currentTime + 0.2);
  p.pause();
  rig.run(0.5);
  assert.equal(p.playing, false, 'pause cancelled it');
  assert.equal(rig.dsp(0).playing, false);
  p.playAt(rig.ctx.currentTime + 0.2);
  p.seek(4);
  rig.run(0.5);
  assert.equal(p.playing, false, 'seek cancelled it');
  assert.equal(rig.dsp(0).position, 4);
  assert.equal(p.getPosition(), 4);
  // cued start: seekAt + playAt on the same time
  const t = blockTime(rig, 0.15);
  p.seekAt(7, t);
  p.playAt(t);
  assert.closeTo(p.positionAt(t + 0.5), 7.5, 1e-9);
  assert.equal(p.getPosition(), 4, 'still the old position');
  rig.runToFrame(Math.round(t * SR) + 4 * Q);
  assert.closeTo(rig.dsp(0).position, 7 + (4 * Q) / SR, 1e-12);
  rig.run(0.2);
  assert.closeTo(p.getPosition(), 7 + (rig.audible - t), 1e-9);
  // a time in the past: starts at once, as if it had started then
  p.pause();
  rig.run(0.2);
  const parked = rig.dsp(0).position;
  const past = rig.ctx.currentTime - 0.05;
  p.playAt(past);
  assert.equal(p.playing, true);
  rig.quantum();
  assert.closeTo(rig.dsp(0).position, parked + (rig.ctx.currentTime - Math.round(past * SR) / SR), 1e-9);
});

test('seekAt on a playing deck: old trajectory until its time, then the new one; scratch cancels it', () => {
  const rig = new Rig();
  const p = rig.addDeck(20, 7);
  p.play();
  rig.run(1);
  const t = blockTime(rig, 0.3);
  const before = p.positionAt(t - 0.01);
  p.seekAt(10, t);
  assert.closeTo(p.positionAt(t - 0.01), before, 1e-12, 'unchanged before the jump');
  assert.closeTo(p.positionAt(t + 0.25), 10.25, 1e-12);
  let last = p.getPosition();
  while (rig.ctx.currentTime + Q / SR < t) {
    rig.quantum();
    const now = p.getPosition();
    assert(now > last && now < 5, 'old trajectory, smooth');
    assert.closeTo(now, rig.truthAt(0, rig.audible), 1e-9, 'what is heard');
    last = now;
  }
  // once rendered, the jump shows like a seek(): the new position minus the latency until it is heard
  rig.quantum();
  assert.closeTo(p.getPosition(), 10 - LAT, 1e-9);
  last = p.getPosition();
  for (let i = 0; i < 8; i++) {
    rig.quantum();
    const now = p.getPosition();
    assert(now > last, 'moves on smoothly (never back) when the report confirms it');
    last = now;
  }
  rig.run(0.1);
  assert.closeTo(p.getPosition(), 10 + (rig.audible - t), 1e-9);
  assert.closeTo(rig.truthAt(0, rig.audible), p.getPosition(), 1e-9, 'matches the DSP');
  // scratching cancels a pending jump (the hand owns the record)
  const t2 = rig.ctx.currentTime + 0.3;
  p.seekAt(2, t2);
  p.scratchBegin();
  assert.equal(p.scheduledSeek, null);
  p.scratchEnd();
  rig.run(0.5);
  assert(rig.dsp(0).position > 10, 'no jump to 2');
  // pause cancels it too
  p.seekAt(2, rig.ctx.currentTime + 0.3);
  p.pause();
  rig.run(0.5);
  assert(rig.dsp(0).position > 10);
});

test('setRate ramp: rate estimate, positionAt and getPosition integrate the ramp', () => {
  const rig = new Rig();
  const p = rig.addDeck(30, 8);
  p.play();
  rig.run(0.5);
  assert.equal(p.rate, 1);
  p.setRate(1.08, 2);
  assert.equal(p.ramping, true);
  assert.equal(p.targetRate, 1.08);
  const t0 = rig.ctx.currentTime;
  // prediction made at the start of the ramp for a time well inside and after it
  const in1 = p.positionAt(t0 + 1.5);
  const after = p.positionAt(t0 + 3);
  rig.run(1);
  assert.closeTo(p.rate, 1.04, 1e-3, 'half way');
  let worst = 0;
  for (let i = 0; i < 120; i++) {
    rig.quantum();
    const err = Math.abs(p.getPosition() - rig.truthAt(0, rig.audible));
    if (err > worst) worst = err;
  }
  assert(worst < 2e-5, `heard position follows the ramp (worst ${worst})`);
  rig.runToFrame(Math.round((t0 + 3) * SR));
  assert.closeTo(rig.truthAt(0, t0 + 1.5), in1, 2e-5, 'positionAt inside the ramp');
  assert.closeTo(rig.truthAt(0, t0 + 3), after, 2e-5, 'positionAt after the ramp');
  assert.equal(p.ramping, false);
  assert.equal(p.rate, 1.08);
  // a constant-rate extrapolation would have been off by ~ (0.08 / 2) * 1.5^2 / 2 = 45 ms
  assert(Math.abs(in1 - (rig.truthAt(0, t0) + 1.5)) > 0.04);
  // a new ramp during a ramp starts from where it is
  p.setRate(1.0, 1);
  rig.run(0.5);
  p.setRate(1.1, 1);
  const r0 = p.rate;
  assert.closeTo(r0, 1.04, 2e-3);
  rig.run(0.5);
  assert.closeTo(p.rate, (r0 + 1.1) / 2, 2e-3);
  // an immediate change while playing: positions follow at once (step model) and match the DSP
  rig.run(1);
  p.setRate(0.9);
  assert.equal(p.rate, 0.9);
  rig.run(0.3);
  assert.closeTo(p.getPosition(), rig.truthAt(0, rig.audible), 2e-4);
});

test('ScriptProcessor fallback: playAt / seekAt / ramps behave the same', async () => {
  const ctx = {
    sampleRate: SR,
    currentTime: 0,
    baseLatency: 0.01,
    outputLatency: 0.01,
    destination: { connect() {}, disconnect() {} },
    procs: [],
    createGain() {
      return { gain: { value: 1 }, connect() {}, disconnect() {} };
    },
    createScriptProcessor(size) {
      const node = { bufferSize: size, onaudioprocess: null, connect() {}, disconnect() {} };
      ctx.procs.push(node);
      return node;
    },
  };
  const p = await DeckPlayer.create(ctx, { worklet: false });
  const sp = ctx.procs[0];
  const size = sp.bufferSize;
  const bufs = [new Float32Array(size), new Float32Array(size)];
  const tick = () => {
    sp.onaudioprocess({ outputBuffer: { numberOfChannels: 2, getChannelData: (c) => bufs[c] }, playbackTime: ctx.currentTime + size / SR });
    ctx.currentTime += size / SR;
  };
  p.load([noise(20, 9)], SR);
  tick();
  // the processor renders one buffer ahead: a start inside the next buffer lands on its frame
  const t = ctx.currentTime + size / SR + 0.0375;
  p.playAt(t);
  assert.equal(p.playing, false);
  tick();
  tick();
  assert.equal(p.playing, true);
  const dsp = p._dsp;
  assert.closeTo(dsp.position, dsp.frame / SR - Math.round(t * SR) / SR, 1e-12, 'started on its frame');
  const t2 = ctx.currentTime + 3 * (size / SR) + 0.01;
  p.seekAt(5, t2);
  p.setRate(1.1, 1);
  const pred = p.positionAt(t2 + 0.2);
  while (ctx.currentTime < t2 + 0.6) tick();
  // truth at t2 + 0.2: ramp from the setRate frame (rate model) through the jump
  const rs = p._rs;
  const g = (T) => {
    const x = T - rs; // integral of the 1 -> 1.1 ramp over 1 s, then 1.1
    if (x <= 0) return x;
    if (x >= 1) return 1.05 + 1.1 * (x - 1);
    return x + 0.05 * x * x;
  };
  const tq2 = Math.round(t2 * SR) / SR;
  const expect = 5 + g(tq2 + 0.2) - g(tq2);
  assert.closeTo(pred, expect, 1e-9, 'prediction = model');
  // the DSP agrees with the model to well under a millisecond
  const nowT = dsp.frame / SR;
  assert.closeTo(dsp.position, 5 + g(nowT) - g(tq2), 2e-5);
  p.dispose();
});

// ------------------------------------------------------------------------------------------------ mixer

/**
 * AudioParam simulator: keeps the event list like Web Audio does, refuses events that overlap a
 * setValueCurveAtTime (NotSupportedError), and computes the value at any time.
 */
class SimParam {
  constructor(ctx, value, { hold = true } = {}) {
    this.ctx = ctx;
    this.defaultValue = value;
    this.events = [];
    this.calls = [];
    this.automationRate = 'a-rate';
    if (!hold) this.cancelAndHoldAtTime = undefined; // e.g. Firefox
  }
  get value() {
    return this.valueAt(this.ctx.currentTime);
  }
  set value(v) {
    this.calls.push(['value', v]);
    this.defaultValue = v;
  }
  _insert(ev) {
    for (const e of this.events) {
      if (e.type === 'curve' && ev.time > e.time && ev.time < e.time + e.duration) {
        throw new Error(`NotSupportedError: ${ev.type} at ${ev.time} inside a curve`);
      }
      if (ev.type === 'curve' && (e.time === ev.time || (e.time > ev.time && e.time < ev.time + ev.duration))) {
        throw new Error(`NotSupportedError: curve at ${ev.time} overlaps ${e.type} at ${e.time}`);
      }
    }
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].time > ev.time) i--;
    this.events.splice(i, 0, ev);
  }
  setValueAtTime(v, t) {
    this.calls.push(['set', v, t]);
    this._insert({ type: 'set', time: t, value: v });
    return this;
  }
  linearRampToValueAtTime(v, t) {
    this.calls.push(['ramp', v, t]);
    this._insert({ type: 'ramp', time: t, value: v });
    return this;
  }
  setTargetAtTime(v, t, tau) {
    this.calls.push(['target', v, t, tau]);
    this._insert({ type: 'target', time: t, value: v, tau });
    return this;
  }
  setValueCurveAtTime(values, t, d) {
    if (!(values.length >= 2) || !(d > 0)) throw new Error('InvalidStateError');
    this.calls.push(['curve', values.length, t, d]);
    this._insert({ type: 'curve', time: t, duration: d, values: Float32Array.from(values) });
    return this;
  }
  cancelScheduledValues(t) {
    if (!Number.isFinite(t) || t < 0) throw new RangeError('bad time');
    this.calls.push(['cancel', t]);
    this.events = this.events.filter((e) => e.time < t && !(e.type === 'curve' && e.time + e.duration > t));
    return this;
  }
  cancelAndHoldAtTime(t) {
    const v = this.valueAt(t);
    this.calls.push(['hold', t]);
    this.events = this.events.filter((e) => e.time <= t && !(e.type === 'curve' && e.time + e.duration > t));
    this.events.push({ type: 'set', time: t, value: v });
    return this;
  }
  valueAt(t) {
    let v = this.defaultValue;
    let vt = 0;
    const ev = this.events;
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (e.time > t) {
        if (e.type === 'ramp') return v + ((e.value - v) * (t - vt)) / (e.time - vt);
        break;
      }
      if (e.type === 'set' || e.type === 'ramp') {
        v = e.value;
        vt = e.time;
      } else if (e.type === 'target') {
        const next = ev[i + 1];
        const until = next && next.time <= t ? next.time : t;
        v = e.value + (v - e.value) * Math.exp(-(until - e.time) / e.tau);
        vt = until;
      } else if (e.type === 'curve') {
        const end = e.time + e.duration;
        const c = e.values;
        if (t < end) {
          const u = ((t - e.time) / e.duration) * (c.length - 1);
          const k = Math.floor(u);
          return c[k] + (c[k + 1] - c[k]) * (u - k);
        }
        v = c[c.length - 1];
        vt = end;
      }
    }
    return v;
  }
}

class SimNode {
  constructor(ctx) {
    this.outs = new Set();
    this.ctx = ctx;
  }
  connect(d) {
    this.outs.add(d);
    return d;
  }
  disconnect() {
    this.outs.clear();
  }
}

function simCtx({ hold = true } = {}) {
  const ctx = { sampleRate: SR, currentTime: 1, params: [] };
  const P = (v) => {
    const p = new SimParam(ctx, v, { hold });
    ctx.params.push(p);
    return p;
  };
  const node = (extra) => Object.assign(new SimNode(ctx), extra);
  Object.assign(ctx, {
    createGain: () => node({ gain: P(1) }),
    createBiquadFilter: () => node({ type: 'lowpass', frequency: P(350), Q: P(1), gain: P(0) }),
    createDelay: () => node({ delayTime: P(0) }),
    createOscillator: () => node({ frequency: P(1), start() {}, stop() {} }),
    createConvolver: () => node({ buffer: null, normalize: true }),
    createWaveShaper: () => node({ curve: null, oversample: 'none' }),
    createDynamicsCompressor: () => node({ threshold: P(0), knee: P(0), ratio: P(0), attack: P(0), release: P(0), reduction: 0 }),
    createAnalyser: () => node({ fftSize: 2048, getFloatTimeDomainData(a) { a.fill(0); } }),
    createBuffer: (ch, len) => {
      const d = [];
      for (let c = 0; c < ch; c++) d.push(new Float32Array(len));
      return { numberOfChannels: ch, length: len, getChannelData: (c) => d[c] };
    },
  });
  return ctx;
}

function gainsAt(m, t) {
  return [m.channels[0]._xfade.gain.valueAt(t), m.channels[1]._xfade.gain.valueAt(t)];
}

test('scheduleCrossfade: equal-power S-curve on both gains, live crossfader, events', () => {
  const ctx = simCtx();
  const m = new Mixer(ctx);
  const events = [];
  m.on('crossfader', (e) => events.push(e));
  m.setCrossfaderCurve('cut'); // the schedule ignores the user's curve
  m.setCrossfader(-1, { source: 'auto' });
  assert.equal(events[0].source, 'auto');
  ctx.currentTime = 2;
  const t0 = 4;
  assert.equal(m.scheduleCrossfade(-1, 1, t0, 8), true);
  assert.equal(m.crossfadeScheduled, true);
  assert.deepEqual(m.crossfadeSchedule, { from: -1, to: 1, start: 4, duration: 8 });
  const e = events[events.length - 1];
  assert.equal(e.source, 'auto');
  assert.equal(e.scheduled, true);
  const ga = m.channels[0]._xfade.gain;
  const curveCall = ga.calls.find((c) => c[0] === 'curve');
  assert(curveCall && curveCall[1] >= 64, `curve with ${curveCall && curveCall[1]} points`);
  assert.equal(curveCall[2], 4);
  assert.equal(curveCall[3], 8);
  // values along the mix: equal power, S-shaped, exact ends
  for (let i = 0; i <= 80; i++) {
    const t = t0 + (8 * i) / 80;
    const [a, b] = gainsAt(m, t);
    assert.closeTo(a * a + b * b, 1, 2e-3, `power at ${t}`);
    const [wa, wb] = xfadeGains(mixCrossfader(-1, 1, (t - t0) / 8), 'smooth');
    assert.closeTo(a, wa, 2e-3);
    assert.closeTo(b, wb, 2e-3);
  }
  const pre = gainsAt(m, 3.9);
  assert(Math.abs(pre[0] - 1) < 1e-9 && pre[1] < 1e-9, 'holds before the start');
  const post = gainsAt(m, 12.5);
  assert(post[0] < 1e-6 && Math.abs(post[1] - 1) < 1e-6, 'holds the end');
  // the crossfader getter follows the clock
  assert.equal(m.crossfader, -1);
  ctx.currentTime = 6;
  assert.closeTo(m.crossfader, -1 + 2 * xfadeSCurve(0.25), 1e-12);
  ctx.currentTime = 8;
  assert.closeTo(m.crossfader, 0, 1e-12);
  assert.closeTo(m.channels[1].state.xfade, Math.SQRT1_2, 2e-3, 'strip state is live (deck audible check)');
  ctx.currentTime = 12.01;
  assert.equal(m.crossfader, 1);
  assert.equal(m.crossfadeScheduled, false);
  assert.equal(m.crossfadeSchedule, null);
  // after the schedule a user move glides from the end values without a jump
  ctx.currentTime = 13;
  m.setCrossfader(0.5);
  assert.equal(events[events.length - 1].source, 'user');
  const [a13, b13] = gainsAt(m, 13);
  assert.closeTo(a13, 0, 1e-9);
  assert.closeTo(b13, 1, 1e-9);
  const [ac, bc] = xfadeGains(0.5, 'cut');
  const [a2, b2] = gainsAt(m, 13.2);
  assert.closeTo(a2, ac, 1e-6);
  assert.closeTo(b2, bc, 1e-6);
});

test('cancelCrossfade and setCrossfader freeze a running crossfade without a jump', () => {
  for (const hold of [true, false]) {
    const ctx = simCtx({ hold });
    const m = new Mixer(ctx);
    const events = [];
    m.on('crossfader', (e) => events.push(e));
    m.setCrossfader(-1);
    m.scheduleCrossfade(-1, 1, 2, 4);
    ctx.currentTime = 3; // a quarter in
    const x = m.crossfader;
    const g = gainsAt(m, 3);
    assert.equal(m.cancelCrossfade(), true);
    const ev = events[events.length - 1];
    assert.equal(ev.cancelled, true);
    assert.equal(ev.source, 'auto');
    assert.closeTo(ev.x, x, 1e-12);
    for (const t of [3, 3.5, 5, 9]) {
      const [a, b] = gainsAt(m, t);
      assert.closeTo(a, g[0], 2e-3, `hold ${hold}: A frozen at ${t}`);
      assert.closeTo(b, g[1], 2e-3, `hold ${hold}: B frozen at ${t}`);
    }
    ctx.currentTime = 4;
    assert.closeTo(m.crossfader, x, 1e-12, 'position stays');
    assert.equal(m.crossfadeScheduled, false);
    assert.equal(m.cancelCrossfade(), false, 'nothing to cancel');
    // a user move during a schedule: cancels it, glides from the frozen value (no jump)
    m.scheduleCrossfade(x, 1, 5, 4);
    ctx.currentTime = 7;
    const g7 = gainsAt(m, 7);
    const x7 = m.crossfader;
    m.setCrossfader(-0.5);
    const mv = events[events.length - 1];
    assert.equal(mv.source, 'user');
    assert.equal(mv.cancelled, true);
    const [a7, b7] = gainsAt(m, 7);
    assert.closeTo(a7, g7[0], 2e-3, `hold ${hold}: no jump`);
    assert.closeTo(b7, g7[1], 2e-3);
    const [wa, wb] = xfadeGains(-0.5);
    const [a8, b8] = gainsAt(m, 7.1);
    assert.closeTo(a8, wa, 1e-6, `hold ${hold}: then the user value`);
    assert.closeTo(b8, wb, 1e-6);
    assert.equal(m.crossfadeScheduled, false);
    assert(x7 > x, 'it was moving');
    // the fallback never cancels from a negative / non-finite time (SimParam throws RangeError then)
    m.dispose();
  }
});

test('scheduleCrossfade: late start begins part way, an off position glides first, replace and edge cases', () => {
  const ctx = simCtx();
  const m = new Mixer(ctx);
  m.setCrossfader(-1);
  ctx.currentTime = 10;
  // started 2 s ago (8 s mix): the curve picks up at 25 %
  m.scheduleCrossfade(-1, 1, 8, 8);
  const ga = m.channels[0]._xfade.gain;
  const call = ga.calls.filter((c) => c[0] === 'curve').pop();
  assert(call[2] > 10 && call[2] < 10.02, `curve starts just after now (${call[2]})`);
  assert.closeTo(call[2] + call[3], 16, 1e-9, 'and ends on time');
  const t = 12;
  const [a, b] = gainsAt(m, t);
  const [wa, wb] = xfadeGains(mixCrossfader(-1, 1, 0.5));
  assert.closeTo(a, wa, 2e-3);
  assert.closeTo(b, wb, 2e-3);
  // replacing a running schedule (no overlap errors, the new one wins)
  m.scheduleCrossfade(m.crossfader, -1, 13, 2);
  assert.closeTo(gainsAt(m, 15.5)[0], 1, 1e-6);
  assert.deepEqual(m.crossfadeSchedule, { from: m.crossfadeSchedule.from, to: -1, start: 13, duration: 2 });
  // crossfader away from `from`: a 20 ms glide to it, then the curve
  ctx.currentTime = 20;
  m.setCrossfader(0);
  ctx.currentTime = 21;
  m.scheduleCrossfade(-1, 1, 22, 4);
  assert.closeTo(gainsAt(m, 21.03)[0], 1, 1e-6, 'glided to A');
  assert.closeTo(gainsAt(m, 21.03)[1], 0, 1e-6);
  ctx.currentTime = 21.01;
  assert(m.crossfader > -1 && m.crossfader < 0, 'gliding');
  ctx.currentTime = 21.5;
  assert.equal(m.crossfader, -1);
  // nothing left to automate: just goes to the end
  ctx.currentTime = 40;
  assert.equal(m.scheduleCrossfade(-1, 1, 30, 4), false);
  assert.equal(m.crossfader, 1);
  assert.equal(m.crossfadeScheduled, false);
  assert.equal(m.scheduleCrossfade(1, -1, 41, 0), false, 'zero duration');
  assert.equal(m.crossfader, -1);
  // curve change during a schedule keeps the equal-power shape
  ctx.currentTime = 50;
  m.scheduleCrossfade(-1, 1, 51, 4);
  m.setCrossfaderCurve('cut');
  const [a53, b53] = gainsAt(m, 53);
  assert.closeTo(a53 * a53 + b53 * b53, 1, 2e-3);
  assert.equal(m.crossfadeScheduled, true);
});

test('timed EQ: hold until `at`, linear ramp of the band gain, later moves never jump', () => {
  for (const hold of [true, false]) {
    const ctx = simCtx({ hold });
    const m = new Mixer(ctx);
    const ch = m.channels[1];
    const g = ch._low.gain;
    ch.setEq('low', -1); // plain move: unchanged behaviour (15 ms glide)
    assert.equal(ch.state.eq.low, -1);
    assert.equal(g.calls[g.calls.length - 1][0], 'target');
    ctx.currentTime = 2;
    assert(g.valueAt(2) < 1e-6, 'killed');
    ch.setEq('low', 0, { at: 5, ramp: 0.5 });
    assert.equal(ch.state.eq.low, 0, 'state at once');
    assert(g.valueAt(4.99) < 1e-6, `hold ${hold}: holds until at`);
    assert.closeTo(g.valueAt(5.25), 0.5, 1e-9, `hold ${hold}: linear ramp`);
    assert.closeTo(g.valueAt(5.5), eqGain(0), 1e-9);
    assert.closeTo(g.valueAt(9), 1, 1e-9);
    // a user move in the middle of the ramp: glides on from where it is
    ctx.currentTime = 5.25;
    ch.setEq('low', 0.5);
    assert.closeTo(g.valueAt(5.25), 0.5, 1e-6, `hold ${hold}: no jump`);
    assert.closeTo(g.valueAt(5.5), eqGain(0.5), 1e-3);
    // a step at a time (ramp 0), and a ramp that starts now
    ctx.currentTime = 6;
    ch.setEq('mid', -1, { at: 7 });
    const gm = ch._mid.gain;
    assert.closeTo(gm.valueAt(6.99), 1, 1e-9);
    assert.equal(gm.valueAt(7), 0);
    ch.setEq('high', 1, { ramp: 1 });
    const gh = ch._high.gain;
    assert.closeTo(gh.valueAt(6.5), (1 + eqGain(1)) / 2, 1e-9);
    // a new timed change replaces a pending one
    ch.setEq('mid', 0, { at: 8, ramp: 1 });
    assert.closeTo(gm.valueAt(7.5), 1, 1e-9, `hold ${hold}: the pending step is gone`);
    ch.setEq('bogus', 1, { at: 9 });
    m.dispose();
  }
});

test('AutoParam: value bookkeeping without param.value; legal event lists', () => {
  const ctx = simCtx({ hold: false });
  const p = new SimParam(ctx, 1, { hold: false });
  const ap = new AutoParam(ctx, p, 1);
  ctx.currentTime = 1;
  ap.smooth(0.2, 0.01);
  assert.equal(ap.current(), 0.2, 'reports the target of a glide');
  assert.closeTo(ap.valueAt(1.05), p.valueAt(1.05), 1e-9);
  ap.rampTo(0.8, 2, 1);
  assert.closeTo(ap.valueAt(2.5), p.valueAt(2.5), 1e-9);
  assert.equal(ap.automated, true);
  ctx.currentTime = 2.5;
  // the ramp was planned at t = 1 while the 0.2 glide had only just begun: it ramps 1 -> 0.8 over [2, 3]
  assert.closeTo(ap.current(), 0.9, 1e-6, 'live value of automation');
  const curve = new Float32Array([0.5, 0, 1]);
  ap.curve(curve, 3, 2, 0.25);
  for (const t of [2.5, 2.51, 2.52, 2.9, 3, 3.5, 4, 4.9, 5, 6]) {
    assert.closeTo(ap.valueAt(t), p.valueAt(t), 1e-6, `curve at ${t}`);
  }
  assert.closeTo(p.valueAt(2.6), 0.5, 1e-9, 'a 20 ms glide to the first curve value');
  assert.equal(p.valueAt(6), 0.25, 'holds `after` past the end');
  ctx.currentTime = 3.5;
  const v = ap.freeze();
  assert.closeTo(v, 0.25, 1e-6);
  assert.closeTo(p.valueAt(10), 0.25, 1e-6);
  assert.equal(ap.automated, false);
});

test('engine: currentTime and audibleTime clocks', async () => {
  const { AudioEngine } = await import('../src/audio/engine.js');
  const engine = new AudioEngine({});
  assert.equal(engine.currentTime, 0);
  assert.equal(engine.audibleTime(), 0);
  engine._ctx = { currentTime: 5, baseLatency: 0.01, outputLatency: 0.02 };
  assert.equal(engine.currentTime, 5);
  assert.closeTo(engine.audibleTime(), 4.97, 1e-12);
  const rig = new Rig();
  rig.addDeck(2, 1);
  rig.run(0.5);
  engine._ctx = rig.ctx;
  engine._players = rig.players;
  assert.closeTo(engine.audibleTime(), rig.ctx.currentTime - LAT, 1e-12, 'from the deck player clock');
  engine._players = [];
  engine._ctx = null;
});
