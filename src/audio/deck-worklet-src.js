// Source of the 'twinspin-deck' AudioWorkletProcessor, shipped as a Blob URL so the worklet needs no network
// fetch, no imports and no CORS (works from GitHub Pages, localhost and sandboxed previews alike).
//
//   const url = createWorkletUrl();            // Blob URL: DeckDSP.toString() + the processor below
//   await ctx.audioWorklet.addModule(url);  URL.revokeObjectURL(url);
//   new AudioWorkletNode(ctx, PROCESSOR_NAME, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
//
// deck-processor.js is the file fallback for pages whose CSP blocks blob: worklets; it imports DeckDSP and
// calls processorMain(DeckDSP) to register the identical processor.
//
// Protocol (main -> worklet): {t:'load', channels, srcRate} (buffers transferred), {t:'unload'}, {t:'play', on,
// at?}, {t:'rate', v, ramp?, at?}, {t:'bend', v}, {t:'brake', ms}, {t:'seek', pos, declick, at?},
// {t:'scratch', phase, pos, vel}, {t:'loop', start, end} | {t:'loop', off:true}, {t:'crush', v}, {t:'dispose'}.
// `at` is an output frame (contextTime * sampleRate, same clock as currentFrame): a scheduled start, jump or
// ramp start that DeckDSP fires on that exact sample. `ramp` is a linear tempo ramp length in seconds. Any
// message may carry `seq` (a counter of position-changing commands) which the worklet echoes in its reports.
// Worklet -> main: {t:'pos', pos, vel, playing, frame, seq} every 4 render quanta (frame = currentFrame at the
// end of the block), {t:'ended', seq}, {t:'loaded', duration, seq}.

/* global AudioWorkletProcessor, registerProcessor, sampleRate, currentFrame */

import { DeckDSP } from './deck-dsp.js';

export const PROCESSOR_NAME = 'twinspin-deck';

/**
 * Registers the 'twinspin-deck' processor. Runs inside the AudioWorkletGlobalScope only. Self-contained
 * apart from the DSP class passed in (it is stringified into the Blob source).
 * @param {typeof DeckDSP} DSP
 */
export function processorMain(DSP) {
  class TwinSpinDeckProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.dsp = new DSP(typeof sampleRate === 'number' ? sampleRate : 48000);
      this.alive = true;
      this.quanta = 0;
      this.seq = 0;
      this.posMsg = { t: 'pos', pos: 0, vel: 0, playing: false, frame: 0, seq: 0 };
      this.endMsg = { t: 'ended', seq: 0 };
      this.port.onmessage = (e) => this.onMessage(e.data);
    }

    onMessage(m) {
      if (!m || typeof m !== 'object') return;
      if (typeof m.seq === 'number') this.seq = m.seq;
      if (m.t === 'dispose') {
        this.alive = false;
        this.dsp.unload();
        this.port.onmessage = null;
        return;
      }
      this.dsp.handleMessage(m);
      if (m.t === 'load') this.port.postMessage({ t: 'loaded', duration: this.dsp.duration, seq: this.seq });
      if (typeof m.seq === 'number') this.quanta = 3; // report the new state on the next block
    }

    process(inputs, outputs) {
      if (!this.alive) return false;
      const out = outputs[0];
      if (!out || out.length === 0) return true;
      const L = out[0];
      const R = out.length > 1 ? out[1] : null;
      const n = L.length;
      const dsp = this.dsp;
      // currentFrame = output frame of this block's first sample: the clock scheduled messages refer to
      dsp.process(L, R, n, typeof currentFrame === 'number' ? currentFrame : undefined);
      if (dsp.consumeEnded()) {
        this.endMsg.seq = this.seq;
        this.port.postMessage(this.endMsg);
        this.quanta = 3;
      }
      if (++this.quanta >= 4) {
        this.quanta = 0;
        const msg = this.posMsg;
        msg.pos = dsp.position;
        msg.vel = dsp.velocity;
        msg.playing = dsp.playing;
        msg.frame = (typeof currentFrame === 'number' ? currentFrame : 0) + n;
        msg.seq = this.seq;
        this.port.postMessage(msg);
      }
      return true;
    }
  }

  try {
    registerProcessor('twinspin-deck', TwinSpinDeckProcessor);
  } catch (err) {
    // already registered in this scope (blob and file both loaded): keep the first
  }
}

/** The complete worklet module source: the DSP class followed by the processor registration. */
export function buildWorkletSource() {
  const dsp = DeckDSP.toString();
  const main = processorMain.toString();
  if (!/^class\s/.test(dsp) || dsp.includes('[native code]') || main.includes('[native code]')) {
    throw new Error('Function source text is unavailable in this environment');
  }
  return `${dsp};\n(${main})(DeckDSP);\n`;
}

/** Blob URL of the worklet module (revoke it after addModule). */
export function createWorkletUrl() {
  const blob = new Blob([buildWorkletSource()], { type: 'text/javascript' });
  return URL.createObjectURL(blob);
}
