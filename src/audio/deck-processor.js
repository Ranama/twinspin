// AudioWorklet module file (fallback when a Content-Security-Policy blocks the Blob URL worklet).
// Loaded with ctx.audioWorklet.addModule(new URL('./deck-processor.js', import.meta.url)); it registers the
// same 'twinspin-deck' processor as the Blob source built by deck-worklet-src.js. This module's only purpose
// is that registration side effect, and it only ever runs inside an AudioWorkletGlobalScope.

import { DeckDSP } from './deck-dsp.js';
import { processorMain } from './deck-worklet-src.js';

processorMain(DeckDSP);
