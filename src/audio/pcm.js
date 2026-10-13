// Decoded audio -> what a deck needs: Int16 PCM for the deck player (half the memory of float, transferred to
// the worklet) and a decimated mono copy for the analysis (tempo, waveform, loudness).
//   const { channels, mono, monoRate } = await preparePcm(audioBuffer);        // targetRate 11025 by default
//   player.load(channels, audioBuffer.sampleRate);   analyzeTrack(mono, monoRate);
// Runs on the main thread in ~8 ms slices and yields to the browser between them (MessageChannel, not nested
// setTimeout chains, which clamp to 4 ms and throttle in background tabs), so scratching and the UI stay smooth
// while a 10-minute song is converted. Works with any AudioBuffer-like object { sampleRate, length,
// numberOfChannels, getChannelData(c) } (demo tracks and tests use plain objects).

const SLICE_MS = 8;
const CHUNK = 16384; // frames converted between clock checks (rounded to whole decimation blocks)

/**
 * Convert an AudioBuffer to Int16 deck PCM plus decimated mono.
 * Samples are clamped to [-1, 1) before scaling, so +1.0 becomes 32767 and nothing wraps around.
 * Mono = mean of D consecutive frames of (L + R) / 2 with D = max(1, round(sampleRate / targetRate)).
 * @param {{ sampleRate: number, length: number, numberOfChannels: number, getChannelData(c: number): Float32Array }} audioBuffer
 * @param {{ targetRate?: number, mono?: boolean, sliceMs?: number }} [opts] mono: false skips the mono copy
 *   (used when re-loading a track whose analysis is already known)
 * @returns {Promise<{ channels: Int16Array[], mono: Float32Array, monoRate: number, sampleRate: number }>}
 */
export async function preparePcm(audioBuffer, { targetRate = 11025, mono = true, sliceMs = SLICE_MS } = {}) {
  const b = audioBuffer;
  const sr = b && b.sampleRate;
  const len = b && b.length;
  if (!b || !(sr > 0) || !(len > 0) || typeof b.getChannelData !== 'function') {
    throw new Error('This song has no audio in it.');
  }
  const nch = Math.max(1, Math.min(2, b.numberOfChannels || 1));
  const src = [];
  for (let c = 0; c < nch; c++) {
    const data = b.getChannelData(c);
    if (!data || data.length < len) throw new Error('The decoded audio is no longer available. Load the song again.');
    src.push(data);
  }
  const D = Math.max(1, Math.round(sr / (targetRate > 0 ? targetRate : 11025)));
  const monoLen = mono ? Math.floor(len / D) : 0;
  const out = src.map(() => new Int16Array(len));
  const m = new Float32Array(monoLen);
  const scale = nch === 2 ? 0.5 / D : 1 / D;
  const chunk = D * Math.max(1, Math.floor(CHUNK / D));
  const L = src[0];
  const R = nch === 2 ? src[1] : null;

  let i = 0;
  let deadline = now() + sliceMs;
  while (i < len) {
    const end = Math.min(len, i + chunk);
    for (let c = 0; c < nch; c++) toInt16(src[c], out[c], i, end);
    if (monoLen) {
      const jEnd = Math.min(monoLen, Math.floor(end / D));
      for (let j = i / D; j < jEnd; j++) {
        const k0 = j * D;
        let s = 0;
        if (R) for (let k = k0; k < k0 + D; k++) s += L[k] + R[k];
        else for (let k = k0; k < k0 + D; k++) s += L[k];
        m[j] = s * scale;
      }
    }
    i = end;
    if (i < len && now() >= deadline) {
      await yieldToMain();
      deadline = now() + sliceMs;
    }
  }
  return { channels: out, mono: m, monoRate: sr / D, sampleRate: sr };
}

/** Float [-1, 1] -> Int16 with rounding; clamps to [-32768, 32767]; NaN -> 0. */
function toInt16(a, o, from, to) {
  for (let k = from; k < to; k++) {
    const x = a[k] * 32768;
    if (x >= 0) {
      const y = x + 0.5;
      o[k] = y > 32767 ? 32767 : y; // Int16Array stores truncate toward zero: (x + 0.5) -> round
    } else {
      const y = x - 0.5;
      o[k] = y < -32768 ? -32768 : y; // NaN fails both tests and stores 0
    }
  }
}

function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

let channel = null;
const waiting = [];

/** Let the browser handle input and rendering, then continue. */
export function yieldToMain() {
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
      try {
        channel.port2.postMessage(0);
      } catch {
        waiting.pop();
        setTimeout(resolve, 0);
      }
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}
