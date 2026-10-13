// Analysis worker (module worker). analyzer.js starts it with
//   new Worker(new URL('./analyze-worker.js', import.meta.url), { type: 'module' })
// and talks to it one job at a time:
//   in:  { t: 'ping' }                                     out: { t: 'pong' }
//   in:  { id, mono: Float32Array, sampleRate, beatOptions? }
//   out: { id, waveform }        first, with the waveform's arrays transferred
//        { id, result: { beats, loudness } }               (the main thread already holds the waveform;
//                                                           beats.beats, the beat map, is transferred)
//        or { id, error: message }
// handleMessage() is exported so tests can drive the protocol without a real Worker. Importing this file
// outside a worker has no side effects.
/* global WorkerGlobalScope */

import { buildWaveform } from './waveform.js';
import { measureLoudness } from './loudness.js';
import { detectBeats } from './bpm.js';

/**
 * Handle one message from the main thread.
 * @param {any} data message payload
 * @param {(msg: object, transfer?: Transferable[]) => void} post reply function
 */
export function handleMessage(data, post) {
  if (!data || typeof data !== 'object') return;
  if (data.t === 'ping') {
    post({ t: 'pong' });
    return;
  }
  const { id, mono, sampleRate } = data;
  try {
    const waveform = buildWaveform(mono, sampleRate);
    const d = waveform.detail, o = waveform.overview;
    post({ id, waveform }, [d.peak.buffer, d.low.buffer, d.high.buffer, o.peak.buffer, o.low.buffer, o.high.buffer]);
    const loudness = measureLoudness(mono, sampleRate);
    const beats = detectBeats(mono, sampleRate, data.beatOptions || {});
    const map = beats && beats.beats;
    post({ id, result: { beats, loudness } }, map && map.buffer ? [map.buffer] : []);
  } catch (err) {
    post({ id, error: String((err && err.message) || err || 'analysis failed') });
  }
}

const scope = typeof self !== 'undefined' ? self : null;
const inWorker = !!scope && typeof WorkerGlobalScope !== 'undefined' && scope instanceof WorkerGlobalScope;
if (inWorker) {
  scope.onmessage = (e) => handleMessage(e.data, (msg, transfer) => scope.postMessage(msg, transfer || []));
}
