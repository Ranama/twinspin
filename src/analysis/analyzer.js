// Track analysis front end (main thread): tempo + beat grid, waveform and loudness for a freshly loaded song.
//
// Usage:
//   import { analyzeTrack } from '../analysis/analyzer.js';
//   const { beats, waveform, loudness } = await analyzeTrack(mono, monoRate, {
//     onWaveform: (wf) => { ...draw it now, the BPM comes a moment later... },
//     signal,                     // optional AbortSignal: drop a stale job (new song loaded on the deck)
//   });
//
// The work runs in analyze-worker.js as a module worker, one job at a time (jobs queue up). `mono` is
// TRANSFERRED to the worker, so the caller must not use it afterwards. The waveform arrives first (through
// onWaveform), then the promise resolves with { beats, waveform, loudness } (see bpm.js, waveform.js,
// loudness.js for the shapes).
//
// When workers are unavailable (sandboxed preview frame, CSP, browsers without module workers) or the
// worker fails to start, the same analysis runs on the main thread, sliced into ~8 ms pieces with yields
// (scheduler.yield / MessageChannel), so scratching and the UI keep running. Failures reject with a short,
// friendly Error message (err.cause holds the technical reason); a cancelled job rejects with an Error whose
// name is 'AbortError'.

import { buildWaveform } from './waveform.js';
import { measureLoudness } from './loudness.js';
import { beatSteps } from './bpm.js';

const MSG_FAILED = "Couldn't work out this song's tempo. You can still play it and tap the tempo in.";
const MSG_BAD_INPUT = "This song couldn't be analysed.";
const PING_TIMEOUT_MS = 4000;   // module load (4 small files) before falling back to the main thread
const SLICE_MS = 8;             // main-thread fallback: work this long, then yield

let worker = null;              // { w, ok, ready: Promise<boolean>, settle, onJobMessage, onJobError }
let workerBroken = false;       // workers unusable in this page: always use the main thread
let crashes = 0;
let nextId = 1;
let queue = Promise.resolve();
let lastBackend = 'none';

/**
 * Analyse a track: beats (BPM, grid), waveform and loudness.
 * @param {Float32Array} mono decimated mono samples (transferred to the worker)
 * @param {number} sampleRate samples per second of `mono`
 * @param {{onWaveform?: (wf: object) => void, signal?: AbortSignal, beatOptions?: object}} [opts]
 * @returns {Promise<{beats: object, waveform: object, loudness: {rmsDb: number, peakDb: number, gainDb: number}}>}
 */
export function analyzeTrack(mono, sampleRate, { onWaveform, signal, beatOptions } = {}) {
  let data;
  try {
    data = toFloat32(mono);
  } catch (err) {
    return Promise.reject(friendly(MSG_BAD_INPUT, err));
  }
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) {
    return Promise.reject(friendly(MSG_BAD_INPUT, new TypeError('bad sampleRate')));
  }
  const job = { mono: data, sampleRate, onWaveform, signal, beatOptions: beatOptions || {} };
  const run = queue.then(() => runJob(job));
  queue = run.then(noop, noop);
  return run;
}

/** Which backend ran the last job: 'worker' | 'main' | 'none' (for the diagnostics panel). */
export function analysisBackend() {
  return lastBackend;
}

/** Terminate the worker and forget its state (tests, engine restart). The next job starts a new one. */
export function resetAnalyzer() {
  if (worker) dropWorker(worker);
  workerBroken = false;
  crashes = 0;
}

// ------------------------------------------------------------------------------------------------------------

function noop() {}

async function runJob(job) {
  throwIfAborted(job.signal);
  const rec = getWorker();
  if (rec) {
    const ok = rec.ok || (await rec.ready);
    throwIfAborted(job.signal);
    if (ok && rec.ok && worker === rec) {
      const r = await runInWorker(rec, job);
      if (r !== FALLBACK) {
        lastBackend = 'worker';
        return r;
      }
    }
  }
  lastBackend = 'main';
  return runOnMainThread(job);
}

const FALLBACK = { fallback: true };

function getWorker() {
  if (workerBroken) return null;
  if (worker) return worker;
  if (typeof Worker !== 'function' || typeof URL !== 'function') {
    workerBroken = true;
    return null;
  }
  let w;
  try {
    w = new Worker(new URL('./analyze-worker.js', import.meta.url), { type: 'module' });
  } catch (err) {
    workerBroken = true; // SecurityError in sandboxed frames, CSP, no module workers
    return null;
  }
  const rec = { w, ok: false, ready: null, settle: noop, onJobMessage: null, onJobError: null };
  rec.ready = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), PING_TIMEOUT_MS);
    rec.settle = (ok) => {
      clearTimeout(timer);
      resolve(ok);
    };
  });
  w.onmessage = (e) => {
    const d = e && e.data;
    if (d && d.t === 'pong') {
      rec.ok = true;
      rec.settle(true);
      return;
    }
    if (rec.onJobMessage) rec.onJobMessage(d);
  };
  w.onerror = (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (!rec.ok) {
      // never answered the ping: the module could not load here (old browser, CSP, sandbox)
      workerBroken = true;
      rec.settle(false);
      dropWorker(rec);
      return;
    }
    if (rec.onJobError) rec.onJobError(new Error((e && e.message) || 'worker error'));
    else dropWorker(rec);
  };
  w.onmessageerror = () => {
    if (rec.onJobError) rec.onJobError(new Error('worker message could not be decoded'));
  };
  try {
    w.postMessage({ t: 'ping' });
  } catch (err) {
    workerBroken = true;
    try {
      w.terminate();
    } catch {
      /* ignore */
    }
    return null;
  }
  worker = rec;
  return rec;
}

function dropWorker(rec) {
  if (worker === rec) worker = null;
  rec.onJobMessage = null;
  rec.onJobError = null;
  rec.settle(false);
  try {
    rec.w.terminate();
  } catch {
    /* ignore */
  }
}

function runInWorker(rec, job) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const seconds = job.mono.length / job.sampleRate;
    let waveform = null, done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      if (job.signal) job.signal.removeEventListener('abort', onAbort);
      rec.onJobMessage = null;
      rec.onJobError = null;
      fn(value);
    };
    // a hung or killed worker must not leave the deck "analysing" forever
    const watchdog = setTimeout(() => {
      dropWorker(rec);
      finish(reject, friendly(MSG_FAILED, new Error('analysis timed out')));
    }, 45000 + seconds * 100);
    const onAbort = () => {
      dropWorker(rec); // the only way to stop a running job; the next job starts a fresh worker
      finish(reject, abortError());
    };
    rec.onJobMessage = (d) => {
      if (!d || d.id !== id) return;
      if (d.waveform) {
        waveform = d.waveform;
        safeCall(job.onWaveform, waveform);
      } else if (d.result) {
        crashes = 0;
        finish(resolve, { beats: d.result.beats, waveform: d.result.waveform || waveform, loudness: d.result.loudness });
      } else if ('error' in d) {
        finish(reject, friendly(MSG_FAILED, new Error(String(d.error))));
      }
    };
    rec.onJobError = (err) => {
      dropWorker(rec);
      if (++crashes >= 2) workerBroken = true;
      finish(reject, friendly(MSG_FAILED, err));
    };
    if (job.signal) job.signal.addEventListener('abort', onAbort);
    const msg = { id, mono: job.mono, sampleRate: job.sampleRate, beatOptions: job.beatOptions };
    const buf = job.mono.buffer;
    const transfer = typeof ArrayBuffer === 'function' && buf instanceof ArrayBuffer ? [buf] : [];
    try {
      rec.w.postMessage(msg, transfer);
    } catch (err) {
      // nothing was transferred (DataCloneError): analyse here instead
      finish(resolve, FALLBACK);
    }
  });
}

async function runOnMainThread(job) {
  const { mono, sampleRate, signal } = job;
  try {
    await yieldToMain();
    throwIfAborted(signal);
    const waveform = buildWaveform(mono, sampleRate);
    safeCall(job.onWaveform, waveform);
    await yieldToMain();
    throwIfAborted(signal);
    const loudness = measureLoudness(mono, sampleRate);
    await yieldToMain();
    const it = beatSteps(mono, sampleRate, job.beatOptions);
    let deadline = now() + SLICE_MS;
    let beats;
    for (;;) {
      const r = it.next();
      if (r.done) {
        beats = r.value;
        break;
      }
      if (now() >= deadline) {
        await yieldToMain();
        throwIfAborted(signal);
        deadline = now() + SLICE_MS;
      }
    }
    return { beats, waveform, loudness };
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw friendly(MSG_FAILED, err);
  }
}

// ---- helpers -----------------------------------------------------------------------------------------------

/** A Float32Array that owns its whole buffer (safe to transfer without taking a neighbour's data along). */
function toFloat32(mono) {
  if (mono instanceof Float32Array) {
    const buf = mono.buffer;
    const whole = mono.byteOffset === 0 && mono.byteLength === buf.byteLength;
    return whole ? mono : mono.slice();
  }
  if (mono && typeof mono.length === 'number' && (ArrayBuffer.isView(mono) || Array.isArray(mono))) {
    return Float32Array.from(mono);
  }
  throw new TypeError('mono must be a Float32Array');
}

function friendly(message, cause) {
  const err = new Error(message);
  if (cause !== undefined) err.cause = cause;
  return err;
}

function abortError() {
  const err = new Error('Analysis cancelled.');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

function safeCall(fn, arg) {
  if (typeof fn !== 'function') return;
  try {
    fn(arg);
  } catch (err) {
    console.error('analyzeTrack onWaveform callback failed', err);
  }
}

function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

let channel = null;
const waiting = [];
/** Let the browser handle input and rendering, then continue (no 4 ms nested-timer clamp). */
function yieldToMain() {
  const sched = globalThis.scheduler;
  if (sched && typeof sched.yield === 'function') {
    try {
      return sched.yield();
    } catch {
      /* fall through */
    }
  }
  if (channel === null) {
    try {
      channel = typeof MessageChannel === 'function' ? new MessageChannel() : false;
      if (channel) {
        channel.port1.onmessage = () => {
          const r = waiting.shift();
          if (r) r();
        };
      }
    } catch {
      channel = false;
    }
  }
  if (channel) {
    return new Promise((resolve) => {
      waiting.push(resolve);
      channel.port2.postMessage(0);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}
