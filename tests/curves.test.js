// Tests for src/audio/curves.js (pure control mappings).
import { faderGain, xfadeGains, eqGain, filterParams, tempoToRate, rateToTempo, xfadeSCurve, mixCrossfader } from '../src/audio/curves.js';
import { dbToGain } from '../src/core/util.js';

test('scheduled crossfade S-curve: ends, symmetry, gentle at the ends, monotonic', () => {
  assert.equal(xfadeSCurve(0), 0);
  assert.equal(xfadeSCurve(1), 1);
  assert.closeTo(xfadeSCurve(0.5), 0.5, 1e-12);
  assert.equal(xfadeSCurve(-1), 0);
  assert.equal(xfadeSCurve(2), 1);
  assert.equal(xfadeSCurve(NaN), 0);
  for (let i = 0; i <= 100; i++) {
    const p = i / 100;
    assert.closeTo(xfadeSCurve(p) + xfadeSCurve(1 - p), 1, 1e-12, 'point symmetric');
    if (i > 0) assert(xfadeSCurve(p) >= xfadeSCurve(p - 0.01), 'monotonic');
  }
  // slope 0 at the ends, steepest (pi / 2) in the middle
  assert(xfadeSCurve(0.01) < 0.001 && 1 - xfadeSCurve(0.99) < 0.001);
  assert.closeTo((xfadeSCurve(0.501) - xfadeSCurve(0.499)) / 0.002, Math.PI / 2, 1e-4);
  assert.equal(mixCrossfader(-1, 1, 0), -1);
  assert.equal(mixCrossfader(-1, 1, 1), 1);
  assert.closeTo(mixCrossfader(-1, 1, 0.5), 0, 1e-12);
  assert.closeTo(mixCrossfader(1, -1, 0.25), 1 - 2 * xfadeSCurve(0.25), 1e-12);
  // with the equal-power law the mix never dips in power
  for (let i = 0; i <= 50; i++) {
    const [a, b] = xfadeGains(mixCrossfader(-1, 1, i / 50), 'smooth');
    assert.closeTo(a * a + b * b, 1, 1e-12);
  }
});

test('faderGain is v^2, clamped', () => {
  assert.equal(faderGain(0), 0);
  assert.equal(faderGain(1), 1);
  assert.closeTo(faderGain(0.5), 0.25, 1e-12);
  assert.closeTo(faderGain(0.8), 0.64, 1e-12);
  assert.equal(faderGain(-0.3), 0);
  assert.equal(faderGain(1.7), 1);
  assert.equal(faderGain(NaN), 0);
});

test('smooth crossfade is constant power', () => {
  for (let i = 0; i <= 200; i++) {
    const x = -1 + i / 100;
    const [a, b] = xfadeGains(x, 'smooth');
    assert.closeTo(a * a + b * b, 1, 1e-12, `sum of squares at x=${x}`);
    assert(a >= 0 && a <= 1 && b >= 0 && b <= 1);
  }
  assert.deepEqual(xfadeGains(-1, 'smooth'), [1, 0]);
  assert.deepEqual(xfadeGains(1, 'smooth'), [0, 1]);
  const [a0, b0] = xfadeGains(0, 'smooth');
  assert.closeTo(a0, Math.SQRT1_2, 1e-12);
  assert.closeTo(b0, Math.SQRT1_2, 1e-12);
  // monotonic: A falls, B rises
  let pa = 2;
  let pb = -1;
  for (let i = 0; i <= 50; i++) {
    const [a, b] = xfadeGains(-1 + i / 25);
    assert(a <= pa && b >= pb);
    pa = a;
    pb = b;
  }
  // default curve is smooth, out-of-range clamps
  assert.deepEqual(xfadeGains(0), xfadeGains(0, 'smooth'));
  assert.deepEqual(xfadeGains(-5, 'smooth'), [1, 0]);
});

test('cut crossfade: full across the middle, sharp at the ends', () => {
  assert.deepEqual(xfadeGains(0, 'cut'), [1, 1]);
  assert.deepEqual(xfadeGains(-1, 'cut'), [1, 0]);
  assert.deepEqual(xfadeGains(1, 'cut'), [0, 1]);
  assert.deepEqual(xfadeGains(0.88, 'cut').map((v) => Math.round(v * 1e9) / 1e9), [1, 1]);
  assert.closeTo(xfadeGains(0.94, 'cut')[0], 0.5, 1e-9);
  assert.closeTo(xfadeGains(-0.94, 'cut')[1], 0.5, 1e-9);
  assert.equal(xfadeGains(-0.94, 'cut')[0], 1);
});

test('eqGain: kill, cut curve, boost to +6 dB', () => {
  assert.equal(eqGain(-1), 0);
  assert.equal(eqGain(-0.98), 0);
  assert(eqGain(-0.97) > 0);
  assert.closeTo(eqGain(-0.97), Math.pow(0.03, 2.5), 1e-12);
  assert.closeTo(eqGain(-0.5), Math.pow(0.5, 2.5), 1e-12);
  assert.equal(eqGain(0), 1);
  assert.closeTo(eqGain(1), dbToGain(6), 1e-12);
  assert.closeTo(eqGain(0.5), dbToGain(3), 1e-12);
  let prev = -1;
  for (let i = 0; i <= 100; i++) {
    const g = eqGain(-1 + i / 50);
    assert(g >= prev, 'monotonic');
    prev = g;
  }
});

test('filterParams: dead zone, sweeps, Q in dB', () => {
  for (const v of [0, 0.01, -0.039, 0.039]) assert.deepEqual(filterParams(v), { lp: 22000, hp: 10, qDb: 0 });
  const lpEnd = filterParams(-1);
  assert.closeTo(lpEnd.lp, 60, 1e-9);
  assert.equal(lpEnd.hp, 10);
  assert.closeTo(lpEnd.qDb, 6, 1e-12);
  const hpEnd = filterParams(1);
  assert.closeTo(hpEnd.hp, 8000, 1e-9);
  assert.equal(hpEnd.lp, 22000);
  assert.closeTo(hpEnd.qDb, 6, 1e-12);
  assert.closeTo(filterParams(-0.5).lp, 20000 * Math.sqrt(60 / 20000), 1e-9);
  assert.closeTo(filterParams(-0.5).qDb, 3.5, 1e-12);
  assert.closeTo(filterParams(0.5).hp, 20 * Math.sqrt(400), 1e-9);
  let prevLp = Infinity;
  let prevHp = 0;
  for (let i = 4; i <= 100; i++) {
    const lp = filterParams(-i / 100).lp;
    const hp = filterParams(i / 100).hp;
    assert(lp < prevLp && hp > prevHp, 'sweeps are monotonic');
    prevLp = lp;
    prevHp = hp;
  }
});

test('tempoToRate and rateToTempo are inverse', () => {
  assert.equal(tempoToRate(0, 0.08), 1);
  assert.closeTo(tempoToRate(1, 0.08), 1.08, 1e-12);
  assert.closeTo(tempoToRate(-1, 0.16), 0.84, 1e-12);
  assert.closeTo(tempoToRate(0.5, 0.5), 1.25, 1e-12);
  for (const range of [0.08, 0.16, 0.5]) {
    for (let i = 0; i <= 40; i++) {
      const v = -1 + i / 20;
      assert.closeTo(rateToTempo(tempoToRate(v, range), range), v, 1e-12);
    }
  }
  assert.equal(rateToTempo(1.5, 0.08), 1);
  assert.equal(rateToTempo(0.5, 0.16), -1);
  assert.equal(rateToTempo(1.1, 0), 0);
});

// ------------------------------------------------------------------------------------------------------------
// The mixer graph applies these curves. A minimal fake Web Audio implementation (JsCheck has no audio) lets the
// Mixer, FxRack, ReverbBus and AudioEngine run end to end and checks the parameter values they set.

class FakeParam {
  constructor(value) {
    this.value = value;
    this.automationRate = 'a-rate';
    this.events = [];
  }
  setTargetAtTime(v, t, tau) {
    this.events.push(['target', v, t, tau]);
    this.value = v;
    return this;
  }
  setValueAtTime(v, t) {
    this.events.push(['set', v, t]);
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v, t) {
    this.events.push(['ramp', v, t]);
    this.value = v;
    return this;
  }
  cancelScheduledValues(t) {
    this.events.push(['cancel', t]);
    return this;
  }
  cancelAndHoldAtTime(t) {
    this.events.push(['hold', t]);
    return this;
  }
}

class FakeNode {
  constructor(ctx, kind) {
    this.context = ctx;
    this.kind = kind;
    this.outs = new Set();
    this.channelCount = 2;
    this.channelCountMode = 'max';
    ctx.nodes.push(this);
  }
  connect(dest) {
    if (!dest) throw new TypeError('connect() needs a destination');
    this.outs.add(dest);
    return dest;
  }
  disconnect(dest) {
    if (dest) this.outs.delete(dest);
    else this.outs.clear();
  }
}

class FakeAudioContext {
  constructor(opts = {}) {
    this.opts = opts;
    this.sampleRate = 8000;
    this.currentTime = 0;
    this.baseLatency = 0.005;
    this.outputLatency = 0;
    this.state = 'suspended';
    this.nodes = [];
    this.listeners = {};
    this.destination = new FakeNode(this, 'destination');
    this.destination.maxChannelCount = 2;
    this.decodes = 0;
    this.maxConcurrentDecodes = 0;
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  fire(type) {
    for (const fn of this.listeners[type] || []) fn({ type });
  }
  resume() {
    this.state = 'running';
    this.fire('statechange');
    return Promise.resolve();
  }
  close() {
    this.state = 'closed';
    this.fire('statechange');
    return Promise.resolve();
  }
  createGain() {
    const n = new FakeNode(this, 'gain');
    n.gain = new FakeParam(1);
    return n;
  }
  createBiquadFilter() {
    const n = new FakeNode(this, 'biquad');
    n.type = 'lowpass';
    n.frequency = new FakeParam(350);
    n.Q = new FakeParam(1);
    n.gain = new FakeParam(0);
    return n;
  }
  createDelay(max = 1) {
    const n = new FakeNode(this, 'delay');
    n.maxDelayTime = max;
    n.delayTime = new FakeParam(0);
    return n;
  }
  createOscillator() {
    const n = new FakeNode(this, 'osc');
    n.frequency = new FakeParam(440);
    n.started = false;
    n.start = () => {
      n.started = true;
    };
    n.stop = () => {
      n.started = false;
    };
    return n;
  }
  createConvolver() {
    const n = new FakeNode(this, 'convolver');
    n.normalize = true;
    n.buffer = null;
    return n;
  }
  createWaveShaper() {
    const n = new FakeNode(this, 'shaper');
    n.curve = null;
    n.oversample = 'none';
    return n;
  }
  createDynamicsCompressor() {
    const n = new FakeNode(this, 'compressor');
    for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = new FakeParam(0);
    n.reduction = -1.5;
    return n;
  }
  createAnalyser() {
    const n = new FakeNode(this, 'analyser');
    n.fftSize = 2048;
    n.smoothingTimeConstant = 0.8;
    n.level = 0.25;
    n.getFloatTimeDomainData = (arr) => {
      for (let i = 0; i < arr.length; i++) arr[i] = i % 2 ? -n.level : n.level;
    };
    return n;
  }
  createChannelMerger() {
    return new FakeNode(this, 'merger');
  }
  createChannelSplitter() {
    return new FakeNode(this, 'splitter');
  }
  createMediaStreamDestination() {
    const n = new FakeNode(this, 'streamdest');
    n.stream = { getTracks: () => [], getAudioTracks: () => [] };
    return n;
  }
  createBuffer(channels, length, sampleRate) {
    const data = [];
    for (let c = 0; c < channels; c++) data.push(new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: (c) => data[c] };
  }
  createScriptProcessor(size) {
    const n = new FakeNode(this, 'script');
    n.bufferSize = size;
    n.onaudioprocess = null;
    return n;
  }
  decodeAudioData(ab, ok) {
    this.decodes++;
    this.maxConcurrentDecodes = Math.max(this.maxConcurrentDecodes, this.decodes);
    return new Promise((resolve) => {
      setTimeout(() => {
        this.decodes--;
        const buf = this.createBuffer(2, ab.byteLength, this.sampleRate);
        if (ok) ok(buf);
        resolve(buf);
      }, 20);
    });
  }
}

const { Mixer, softClipCurve } = await import('../src/audio/mixer.js');
const { FxRack, ReverbBus, makeReverbIR, FX_TYPES } = await import('../src/audio/effects.js');

test('mixer applies the curves to its gains and filters', () => {
  const ctx = new FakeAudioContext();
  const m = new Mixer(ctx);
  const [a, b] = m.channels;
  // crossfader
  m.setCrossfader(-1);
  assert.equal(a._xfade.gain.value, 1);
  assert.equal(b._xfade.gain.value, 0);
  m.setCrossfader(0.94);
  m.setCrossfaderCurve('cut');
  assert.equal(m.crossfaderCurve, 'cut');
  assert.closeTo(a._xfade.gain.value, 0.5, 1e-9);
  assert.equal(b._xfade.gain.value, 1);
  m.setCrossfaderCurve('smooth');
  const [ga, gb] = xfadeGains(0.94, 'smooth');
  assert.closeTo(a._xfade.gain.value, ga, 1e-12);
  assert.closeTo(b._xfade.gain.value, gb, 1e-12);
  // channel controls
  a.setVolume(0.5);
  assert.closeTo(a._fader.gain.value, 0.25, 1e-12);
  a.setEq('low', -1);
  assert.equal(a._low.gain.value, 0, 'kill');
  a.setEq('high', 1);
  assert.closeTo(a._high.gain.value, dbToGain(6), 1e-12);
  a.setEq('bogus', 1);
  a.setTrimDb(-6);
  assert.closeTo(a.input.gain.value, dbToGain(-6), 1e-12);
  a.setTrimDb(40);
  assert.closeTo(a.input.gain.value, dbToGain(12), 1e-12);
  a.setFilter(-1);
  assert.closeTo(a._lp.frequency.value, 60, 1e-9);
  assert.closeTo(a._lp.Q.value, 6, 1e-12);
  assert.closeTo(a._hp.Q.value, -3.0103, 1e-12);
  a.setFilter(1);
  assert.closeTo(a._hp.frequency.value, 8000, 1e-9);
  assert.closeTo(a._lp.frequency.value, 3950, 1e-9, 'open LP is kept below Nyquist');
  a.setFilter(0);
  assert.closeTo(a._hp.frequency.value, 10, 1e-12);
  a.setCue(true);
  assert.equal(a.pfl.gain.value, 1);
  // isolator: LR4 Butterworth biquads with Q in dB, k-rate
  const eq = a._eqFilters;
  assert.equal(eq.length, 8);
  for (const f of eq) {
    assert.closeTo(f.Q.value, -3.0103, 1e-12);
    assert.equal(f.frequency.automationRate, 'k-rate');
  }
  // master / cue
  m.setMasterVolume(0.5);
  assert.closeTo(m.masterOut.gain.value, 0.25, 1e-12);
  m.setCueVolume(1);
  assert.equal(m.cueOut.gain.value, 1);
  m.setCueMix(0.25);
  assert.closeTo(m._cueDry.gain.value, 0.75, 1e-12);
  assert.closeTo(m._cueMaster.gain.value, 0.25, 1e-12);
  const comp = ctx.nodes.find((n) => n.kind === 'compressor');
  assert.equal(comp.threshold.value, -3);
  assert.equal(comp.ratio.value, 20);
  assert.equal(comp.knee.value, 0);
  assert.equal(comp.attack.value, 0.002);
  assert.equal(comp.release.value, 0.15);
  assert.equal(m.limiterReductionDb, -1.5);
  const shaper = ctx.nodes.find((n) => n.kind === 'shaper');
  assert.equal(shaper.oversample, '2x');
  // meters
  const r = m.masterMeter.read();
  assert.closeTo(r.peak, 0.25, 1e-6);
  assert.closeTo(r.rms, 0.25, 1e-6);
  assert.closeTo(a.meter.read().peak, 0.25, 1e-6);
  // routing: strip output -> master bus, pfl -> cue bus, reverb return -> master bus
  assert(a.output.outs.has(m.masterBus) && a.pfl.outs.has(m.cueBus) && m.reverb.output.outs.has(m.masterBus));
  assert.equal(m.masterOut.outs.size, 0, 'masterOut is left for the router to connect');
  m.dispose();
});

test('soft clip curve: linear to 0.9, never above 1', () => {
  const c = softClipCurve(4097, 2);
  const at = (x) => c[Math.round(((x / 2 + 1) / 2) * 4096)] * 2;
  assert.equal(c[2048], 0, 'no DC offset');
  assert.closeTo(at(0.5), 0.5, 1e-6);
  assert.closeTo(at(-0.9), -0.9, 1e-3);
  assert(at(1) > 0.95 && at(1) < 1);
  assert(at(2) <= 1 && at(2) > 0.99);
  for (let i = 0; i < c.length; i++) assert(Math.abs(c[i] * 2) <= 1, 'never above full scale');
  for (let i = 1; i < c.length; i++) assert(c[i] >= c[i - 1], 'monotonic');
});

test('fx rack: sends, amount, beat timing, echo out', async () => {
  const ctx = new FakeAudioContext();
  const send = ctx.createGain();
  send.gain.value = 0;
  const fx = new FxRack(ctx, { reverbSend: send });
  assert.deepEqual(FX_TYPES, ['echo', 'reverb', 'flanger', 'crush']);
  fx.setAmount(0.6);
  fx.set('echo', true);
  assert.closeTo(fx._echoSend.gain.value, 0.6, 1e-12);
  assert.equal(fx._flWet.gain.value, 0);
  fx.set('flanger', true);
  assert.closeTo(fx._flWet.gain.value, 0.6, 1e-12);
  fx.set('reverb', true);
  assert.closeTo(send.gain.value, 0.6, 1e-12);
  fx.set('echo', false);
  assert.equal(fx._echoSend.gain.value, 0, 'echo send closes');
  assert.closeTo(fx._echoFb.gain.value, 0.45, 1e-12, 'feedback keeps ringing');
  fx.set('crush', true); // handled by the DSP, ignored here
  fx.setBeatSeconds(0.5);
  assert.closeTo(fx._echoDelay.delayTime.value, 0.375, 1e-12);
  assert.closeTo(fx._lfo.frequency.value, 0.25, 1e-12);
  fx.setBeatSeconds(10);
  assert.equal(fx._echoDelay.delayTime.value, 2);
  assert(fx._lfo.started, 'LFO running');
  const secs = fx.echoOut(0.5);
  assert.equal(secs, 2);
  assert.closeTo(fx._echoFb.gain.value, 0.6, 1e-12);
  assert(fx._echoSend.gain.value >= 0.75);
  assert.equal(fx._dry.gain.value, 0, 'dry ramps to silence');
  const ramp = fx._dry.gain.events.find((e) => e[0] === 'ramp');
  assert.closeTo(ramp[2], 2, 1e-9);
  await new Promise((r) => setTimeout(r, 2100));
  assert.equal(fx._dry.gain.value, 1, 'dry restored after the echo out');
  assert.equal(fx._echoSend.gain.value, 0, 'echo send back to its switch state');
  assert.closeTo(fx._echoFb.gain.value, 0.45, 1e-12);
  fx.dispose();
});

test('reverb impulse: stereo, decorrelated, normalised, decaying', () => {
  const ctx = new FakeAudioContext();
  const ir = makeReverbIR(ctx, 2.2, 0.4);
  assert.equal(ir.numberOfChannels, 2);
  assert.equal(ir.length, Math.round(2.2 * 8000));
  const l = ir.getChannelData(0);
  const r = ir.getChannelData(1);
  let e = 0;
  let cross = 0;
  let early = 0;
  let late = 0;
  for (let i = 0; i < l.length; i++) {
    e += l[i] * l[i] + r[i] * r[i];
    cross += l[i] * r[i];
    if (i < 1600) early += l[i] * l[i];
    else if (i > l.length - 1600) late += l[i] * l[i];
  }
  assert.closeTo(e, 0.8, 1e-3);
  assert(Math.abs(cross) < 0.1 * e, 'decorrelated L/R');
  assert(late < early * 1e-3, 'decays');
  assert.equal(l[0], 0, 'fades in');
  const bus = new ReverbBus(ctx);
  assert.equal(bus._conv.normalize, false);
  assert(bus._conv.buffer && bus._conv.buffer.length === ir.length);
  assert.equal(bus.input.channelCount, 1);
  bus.dispose();
});

test('engine: start, settings, decode queue, state, restart', async () => {
  globalThis.AudioContext = FakeAudioContext;
  const { AudioEngine } = await import('../src/audio/engine.js');
  const { Settings } = await import('../src/core/settings.js');
  const settings = new Settings('engine.test');
  settings.set('masterVolume', 0.5);
  settings.set('xfadeCurve', 'cut');
  const engine = new AudioEngine({ settings });
  assert.equal(engine.state, 'idle');
  assert.deepEqual(engine.players, []);
  const states = [];
  engine.on('statechange', (s) => states.push(s));
  let ready = 0;
  engine.on('ready', () => ready++);
  const p = engine.start();
  assert.equal(engine.start(), p, 'idempotent');
  const ctx = engine.ctx;
  assert(ctx instanceof FakeAudioContext, 'context created synchronously');
  assert.equal(ctx.opts.latencyHint, 'interactive');
  assert.equal(ctx.opts.sampleRate, undefined, 'never forces the sample rate');
  assert.equal(ctx.state, 'running', 'resumed synchronously');
  await p;
  assert.equal(ready, 1);
  assert.equal(engine.ready, true);
  assert.equal(engine.state, 'running');
  assert(states.includes('starting') && states[states.length - 1] === 'running');
  assert.equal(engine.players.length, 2);
  assert.equal(engine.usingWorklet, false, 'no AudioWorklet in the fake: ScriptProcessor fallback');
  const m = engine.mixer;
  assert.closeTo(m.masterOut.gain.value, 0.25, 1e-12, 'masterVolume applied');
  assert.equal(m.crossfaderCurve, 'cut', 'xfadeCurve applied');
  assert(engine.outputs, 'output router created');
  assert.equal(engine.outputs.mode, 'single');
  assert(m.masterOut.outs.size >= 1, 'router connected the master bus');
  // players feed the strips
  assert(engine.players[0].node.outs.has(m.channels[0].input));
  assert(engine.players[1].node.outs.has(m.channels[1].input));
  // live settings
  settings.set('cueVolume', 0.5);
  assert.closeTo(m.cueOut.gain.value, 0.25, 1e-12);
  settings.set('cueMix', 1);
  assert.equal(m._cueMaster.gain.value, 1);
  settings.set('xfadeCurve', 'smooth');
  assert.equal(m.crossfaderCurve, 'smooth');
  // decode: one at a time, promise and callback forms
  const order = [];
  const d1 = engine.decode(new ArrayBuffer(10)).then((b) => order.push(b.length));
  let cb = 0;
  engine.decode(new ArrayBuffer(20), (b) => {
    cb = b.length;
  });
  const d3 = engine.decode(new ArrayBuffer(30)).then((b) => order.push(b.length));
  await Promise.all([d1, d3]);
  assert.deepEqual(order, [10, 30]);
  assert.equal(cb, 20);
  assert.equal(ctx.maxConcurrentDecodes, 1, 'never two decodes at once');
  await assert.rejects(engine.decode(new ArrayBuffer(0)), /empty/);
  // state changes are reported
  ctx.state = 'interrupted';
  ctx.fire('statechange');
  assert.equal(engine.state, 'interrupted');
  await engine.resume();
  assert.equal(engine.state, 'running');
  const diag = engine.diagnostics();
  assert.equal(diag.sampleRate, 8000);
  assert.equal(diag.usingWorklet, false);
  assert.equal(diag.deckEngine, 'script, script');
  assert.equal(diag.outputMode, 'single');
  // restart: new context, old one closed, 'restarted' instead of 'ready'
  let restarted = 0;
  engine.on('restarted', () => restarted++);
  const oldPlayers = engine.players;
  await engine.restart();
  assert.equal(restarted, 1);
  assert.equal(ready, 1);
  assert.equal(ctx.state, 'closed', 'old context closed');
  assert(engine.ctx !== ctx && engine.ctx.state === 'running');
  assert(engine.players[0] !== oldPlayers[0], 'new players');
  assert.closeTo(engine.mixer.cueOut.gain.value, 0.25, 1e-12, 'settings re-applied');
  delete globalThis.AudioContext;
});

test('engine: a failing AudioContext reports an error and can retry', async () => {
  globalThis.AudioContext = class {
    constructor() {
      throw new Error('no audio device');
    }
  };
  const { AudioEngine } = await import('../src/audio/engine.js');
  const { Settings } = await import('../src/core/settings.js');
  const engine = new AudioEngine({ settings: new Settings('engine.test2') });
  const errors = [];
  engine.on('error', (m) => errors.push(m));
  await assert.rejects(engine.start());
  assert.equal(errors.length, 1);
  assert.equal(engine.state, 'idle');
  globalThis.AudioContext = FakeAudioContext;
  await engine.start();
  assert.equal(engine.ready, true, 'retry works');
  delete globalThis.AudioContext;
});
