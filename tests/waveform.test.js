// Tests for src/analysis/waveform.js (bins, normalisation, band shares) and src/analysis/analyzer.js (worker
// protocol through a fake Worker, main-thread fallback, waveform-first ordering, errors, abort).
// Run: tools/JsCheck/jscheck run tests/waveform.test.js

import { buildWaveform } from '../src/analysis/waveform.js';
import { analyzeTrack, analysisBackend, resetAnalyzer } from '../src/analysis/analyzer.js';
import { handleMessage } from '../src/analysis/analyze-worker.js';

const SR = 11025;

function sine(freq, amp, seconds, sr = SR) {
  const n = Math.round(seconds * sr), y = new Float32Array(n);
  const c = Math.cos((2 * Math.PI * freq) / sr), s = Math.sin((2 * Math.PI * freq) / sr);
  let re = 1, im = 0;
  for (let i = 0; i < n; i++) {
    y[i] = amp * im;
    const t = re * c - im * s;
    im = re * s + im * c;
    re = t;
  }
  return y;
}

function mean(arr, from, to) {
  let s = 0;
  for (let i = from; i < to; i++) s += arr[i];
  return s / (to - from);
}

// ---------------------------------------------------------------------------------------------------------
// waveform
// ---------------------------------------------------------------------------------------------------------

test('detail and overview sizes, defaults', () => {
  const wf = buildWaveform(new Float32Array(SR * 2), SR);
  assert.equal(wf.detail.rate, 150);
  assert.equal(wf.detail.peak.length, 300);
  assert.equal(wf.detail.low.length, 300);
  assert.equal(wf.detail.high.length, 300);
  assert(wf.detail.peak instanceof Float32Array && wf.overview.high instanceof Float32Array);
  assert.equal(wf.overview.bins, 1000);
  assert.equal(wf.overview.peak.length, 1000);
  // silence: all zero, no NaN
  assert.equal(Math.max(...wf.detail.peak), 0);
  assert.equal(Math.max(...wf.overview.low), 0);
  // partial last bin
  const odd = buildWaveform(new Float32Array(1000), SR, { detailRate: 100, overviewBins: 64 });
  assert.equal(odd.detail.rate, 100);
  assert.equal(odd.detail.peak.length, Math.ceil((1000 * 100) / SR));
  assert.equal(odd.overview.bins, 64);
  // fewer samples than overview bins
  const tiny = buildWaveform(new Float32Array(10), SR);
  assert.equal(tiny.overview.bins, 10);
  const empty = buildWaveform(new Float32Array(0), SR);
  assert.equal(empty.detail.peak.length, 0);
  assert.equal(empty.overview.bins, 0);
  assert.throws(() => buildWaveform(null, SR), TypeError);
  assert.throws(() => buildWaveform(new Float32Array(4), NaN), TypeError);
});

test('bins follow track time exactly (73.5 samples per bin at 11025 Hz)', () => {
  const y = new Float32Array(SR * 3);
  const times = [0, 0.5, 1.2345, 2.0001, 2.99];
  const wf0 = buildWaveform(y, SR);
  for (const t of times) {
    y.fill(0);
    const s = Math.round(t * SR);
    y[s] = -0.25;
    const wf = buildWaveform(y, SR);
    const bin = Math.floor((s * 150) / SR);
    assert.equal(wf.detail.peak[bin], 1, 'normalised impulse at ' + t);
    let others = 0;
    for (let i = 0; i < wf.detail.peak.length; i++) if (i !== bin) others += wf.detail.peak[i];
    assert.equal(others, 0, 'only one bin lit for ' + t);
    const ob = Math.floor((s * wf.overview.bins) / y.length);
    assert.equal(wf.overview.peak[ob], 1, 'overview bin for ' + t);
  }
  assert.equal(wf0.detail.peak.length, 450);
});

test('peaks are normalised to the track maximum', () => {
  const a = sine(440, 0.2, 1), b = sine(440, 0.8, 1);
  const y = new Float32Array(a.length + b.length);
  y.set(a, 0);
  y.set(b, a.length);
  const wf = buildWaveform(y, SR);
  const half = wf.detail.peak.length / 2;
  assert.closeTo(Math.max(...wf.detail.peak), 1, 1e-6);
  assert.closeTo(mean(wf.detail.peak, 5, half - 5), 0.25, 0.01, 'quiet half at 1/4');
  assert.closeTo(mean(wf.detail.peak, half + 5, 2 * half - 5), 1, 0.01, 'loud half at 1');
  assert.closeTo(Math.max(...wf.overview.peak), 1, 1e-6);
});

test('band shares: bass is low, hats are high, mids are neither', () => {
  const bass = buildWaveform(sine(60, 0.5, 1), SR).detail;
  const mid = buildWaveform(sine(1000, 0.5, 1), SR).detail;
  const hat = buildWaveform(sine(4000, 0.5, 1), SR).detail;
  const n = bass.low.length;
  assert(mean(bass.low, 10, n) > 0.9, 'bass low share ' + mean(bass.low, 10, n));
  assert(mean(bass.high, 10, n) < 0.01, 'bass high share');
  assert(mean(mid.low, 10, n) < 0.05, 'mid low share ' + mean(mid.low, 10, n));
  assert(mean(mid.high, 10, n) < 0.1, 'mid high share ' + mean(mid.high, 10, n));
  assert(mean(hat.high, 10, n) > 0.8, 'hat high share ' + mean(hat.high, 10, n));
  assert(mean(hat.low, 10, n) < 0.01, 'hat low share');
  for (const wf of [bass, mid, hat]) {
    for (let i = 0; i < n; i++) {
      assert(wf.low[i] >= 0 && wf.high[i] >= 0 && wf.low[i] + wf.high[i] <= 1 + 1e-6, 'shares within 0..1');
    }
  }
});

test('NaN samples do not poison the waveform', () => {
  const y = sine(100, 0.5, 1);
  y[100] = NaN;
  const wf = buildWaveform(y, SR);
  assert(wf.detail.peak.every((v) => Number.isFinite(v)) && wf.detail.low.every((v) => Number.isFinite(v)));
});

// ---------------------------------------------------------------------------------------------------------
// analyzer: worker protocol and main-thread fallback
// ---------------------------------------------------------------------------------------------------------

/** 8 s of kick-like thumps at 120 BPM, first beat at 0.25 s. */
function clickTrack(seconds = 8, bpm = 120, start = 0.25) {
  const y = new Float32Array(Math.round(seconds * SR));
  const kick = new Float32Array(Math.round(0.2 * SR));
  let ph = 0;
  for (let i = 0; i < kick.length; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (50 + 100 * Math.exp(-t / 0.03))) / SR;
    kick[i] = Math.sin(ph) * Math.exp(-t / 0.06);
  }
  for (let t = start; t < seconds; t += 60 / bpm) {
    const s0 = Math.round(t * SR);
    for (let i = 0; i < kick.length && s0 + i < y.length; i++) y[s0 + i] += 0.8 * kick[i];
  }
  return y;
}

const TRACK = clickTrack();

function checkResult(r) {
  assert(r && r.beats && r.waveform && r.loudness, 'result shape');
  assert(Math.abs(r.beats.bpm - 120) < 0.5, 'bpm ' + r.beats.bpm);
  assert(r.beats.beats instanceof Float64Array && r.beats.beats.length > 10, 'beat map');
  assert.equal(r.beats.beats[0], r.beats.firstBeat);
  assert.equal(r.waveform.detail.peak.length, Math.ceil((TRACK.length * 150) / SR));
  assert(Number.isFinite(r.loudness.gainDb), 'gain');
}

class FakeWorker {
  constructor(url, opts) {
    FakeWorker.created.push({ url: String(url), opts });
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
  }

  postMessage(data, transfer) {
    if (this.terminated) return;
    FakeWorker.log.push({ type: data && data.t === 'ping' ? 'ping' : 'job', data, transfer });
    setTimeout(() => {
      handleMessage(data, (msg) => setTimeout(() => {
        if (msg.waveform) FakeWorker.log.push({ type: 'waveform', id: msg.id });
        if (msg.result) FakeWorker.log.push({ type: 'result', id: msg.id });
        if (!this.terminated && this.onmessage) this.onmessage({ data: msg });
      }, 0));
    }, 0);
  }

  terminate() {
    this.terminated = true;
  }
}
FakeWorker.created = [];
FakeWorker.log = [];

test('main-thread fallback when there is no Worker: waveform first, then the result', async () => {
  delete globalThis.Worker;
  resetAnalyzer();
  const order = [];
  const mono = TRACK.slice();
  const r = await analyzeTrack(mono, SR, { onWaveform: (wf) => order.push(['waveform', wf]) }).then((res) => {
    order.push(['result', res]);
    return res;
  });
  checkResult(r);
  assert.equal(analysisBackend(), 'main');
  assert.deepEqual(order.map((o) => o[0]), ['waveform', 'result']);
  assert.equal(order[0][1], r.waveform, 'same waveform object');
  assert.equal(mono.length, TRACK.length, 'main thread keeps the samples');
});

test('module worker: transfers mono, posts the waveform first, one job at a time', async () => {
  globalThis.Worker = FakeWorker;
  FakeWorker.created = [];
  FakeWorker.log = [];
  resetAnalyzer();
  const seen = [];
  let firstWf = null;
  const a = analyzeTrack(TRACK.slice(), SR, { onWaveform: (wf) => { seen.push('wfA'); firstWf = wf; } });
  const b = analyzeTrack(TRACK.slice(0, SR * 6), SR, { onWaveform: () => seen.push('wfB') });
  const [ra, rb] = await Promise.all([a, b]);
  checkResult(ra);
  assert(rb.beats && rb.waveform.detail.peak.length === 900, 'second job result');
  assert.equal(analysisBackend(), 'worker');
  assert.equal(FakeWorker.created.length, 1, 'one worker reused');
  assert.match(FakeWorker.created[0].url, /analyze-worker\.js$/);
  assert.equal(FakeWorker.created[0].opts.type, 'module');
  const jobs = FakeWorker.log.filter((e) => e.type === 'job');
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].transfer[0], jobs[0].data.mono.buffer, 'mono buffer transferred');
  const types = FakeWorker.log.map((e) => e.type);
  assert.deepEqual(types, ['ping', 'job', 'waveform', 'result', 'job', 'waveform', 'result'], 'serialised jobs');
  assert.deepEqual(seen, ['wfA', 'wfB']);
  assert.equal(ra.waveform, firstWf, 'result carries the waveform from the first message');
});

test('worker that fails to load falls back to the main thread', async () => {
  class BrokenWorker {
    postMessage() {
      setTimeout(() => this.onerror && this.onerror({ message: 'SyntaxError: import', preventDefault() {} }), 0);
    }

    terminate() {}
  }
  globalThis.Worker = BrokenWorker;
  resetAnalyzer();
  checkResult(await analyzeTrack(TRACK.slice(), SR));
  assert.equal(analysisBackend(), 'main');
  // stays on the main thread for later jobs without retrying
  globalThis.Worker = class Throws {
    constructor() {
      throw new Error('should not be constructed again');
    }
  };
  const r = await analyzeTrack(TRACK.slice(0, SR * 5), SR);
  assert(r.waveform, 'second job ok');
});

test('worker constructor throwing (sandboxed frame) falls back', async () => {
  globalThis.Worker = class {
    constructor() {
      throw new Error('SecurityError');
    }
  };
  resetAnalyzer();
  const r = await analyzeTrack(TRACK.slice(0, SR * 5), SR);
  assert(r.waveform && r.loudness, 'fallback result');
  assert.equal(analysisBackend(), 'main');
});

test('errors are friendly; abort rejects with AbortError', async () => {
  resetAnalyzer();
  await assert.rejects(analyzeTrack('nope', SR), /couldn't be analysed/);
  await assert.rejects(analyzeTrack(new Float32Array(10), 0), /couldn't be analysed/);
  const signal = { aborted: true, addEventListener() {}, removeEventListener() {} };
  await assert.rejects(analyzeTrack(new Float32Array(SR), SR, { signal }), { name: 'AbortError' });
  // a worker that reports an error
  globalThis.Worker = class {
    postMessage(d) {
      setTimeout(() => this.onmessage({ data: d.t === 'ping' ? { t: 'pong' } : { id: d.id, error: 'boom' } }), 0);
    }

    terminate() {}
  };
  resetAnalyzer();
  await assert.rejects(analyzeTrack(new Float32Array(SR), SR), /tap the tempo/);
  // abort while the worker is busy: rejects, the worker is replaced for the next job
  let terminated = 0;
  const listeners = [];
  const live = { aborted: false, addEventListener: (t, f) => listeners.push(f), removeEventListener() {} };
  globalThis.Worker = class Hanging {
    postMessage(d) {
      if (d.t === 'ping') setTimeout(() => this.onmessage({ data: { t: 'pong' } }), 0);
      // the job arrived and "runs" forever: the user loads another song
      else setTimeout(() => {
        live.aborted = true;
        listeners.forEach((f) => f());
      }, 0);
    }

    terminate() {
      terminated++;
    }
  };
  resetAnalyzer();
  const p = analyzeTrack(TRACK.slice(), SR, { signal: live });
  await assert.rejects(p, { name: 'AbortError' });
  assert.equal(terminated, 1, 'busy worker terminated');
  globalThis.Worker = FakeWorker;
  checkResult(await analyzeTrack(TRACK.slice(), SR));
  delete globalThis.Worker;
  resetAnalyzer();
});

test('worker protocol: waveform first, then beats + loudness (all arrays transferred, the beat map too)', () => {
  const out = [];
  handleMessage({ id: 7, mono: TRACK.slice(), sampleRate: SR }, (msg, transfer) => out.push({ msg, transfer }));
  assert.equal(out.length, 2);
  assert.equal(out[0].msg.id, 7);
  assert(out[0].msg.waveform && out[0].transfer.length === 6, 'waveform + its 6 buffers');
  const { beats, loudness } = out[1].msg.result;
  assert(Math.abs(beats.bpm - 120) < 0.5 && Number.isFinite(loudness.gainDb), 'result');
  assert(beats.beats instanceof Float64Array, 'beat map');
  assert.deepEqual(out[1].transfer, [beats.beats.buffer], 'beat map buffer transferred');
  // no rhythm: beats null, nothing to transfer
  const quiet = [];
  const silent = new Float32Array(SR * 5);
  handleMessage({ id: 8, mono: silent, sampleRate: SR }, (msg, transfer) => quiet.push({ msg, transfer }));
  assert.equal(quiet[1].msg.result.beats.beats, null);
  assert.deepEqual(quiet[1].transfer, []);
  // bad input: an error message, never a throw
  const bad = [];
  handleMessage({ id: 9, mono: null, sampleRate: SR }, (msg) => bad.push(msg));
  assert(bad.length === 1 && bad[0].id === 9 && typeof bad[0].error === 'string');
  handleMessage({ t: 'ping' }, (msg) => bad.push(msg));
  assert.deepEqual(bad[1], { t: 'pong' });
});
