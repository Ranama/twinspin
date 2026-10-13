// Persistent user settings (localStorage, key "twinspin.settings.v1"). Missing or broken storage just means
// defaults every session. Every write emits ('change', key, value).
//   settings.get('tempoRange')  settings.set('xfadeCurve', 'cut')  settings.on('change', (k, v) => ...)

import { Emitter } from './emitter.js';
import { storageGet, storageSet } from './util.js';

const STORAGE_KEY = 'twinspin.settings.v1';

export const DEFAULTS = Object.freeze({
  tempoRange: 0.08,        // pitch fader range: 0.08 | 0.16 | 0.5
  xfadeCurve: 'smooth',    // crossfader curve: 'smooth' (constant power) | 'cut' (scratch)
  quantize: true,          // snap cue points and loops to the beat grid
  vinyl: true,             // touching the platter top scratches (false: it bends/nudges)
  keepAwake: true,         // screen wake lock while the app is open
  haptics: true,           // navigator.vibrate ticks on buttons
  timeMode: 'remain',      // deck time display: 'remain' | 'elapsed'
  waveZoom: 1,             // scrolling waveform zoom 0.33..3 (1 = 6 s phone / 8 s tablet / 10 s desktop)
  page: 'decks',           // phone layouts: which page the centre area shows: 'decks' | 'mix' | 'fx' | 'songs'
  fxDeck: 'A',             // phone FX page: which deck the pads control: 'A' | 'B'
  autoSync: true,          // a stopped deck syncs to the playing one as soon as its BPM is known
  outdoor: false,          // high-contrast "outdoor" look
  outputMode: 'single',    // 'single' | 'dual' | 'split' | 'remote'
  masterDeviceId: 'default',
  cueDeviceId: '',
  alignmentMs: 0,          // dual mode: + delays the master path, - delays the headphone path (-300..300)
  splitSwap: false,        // split cable: false = speaker LEFT / headphones RIGHT
  remoteBus: 'cue',        // remote mode: which bus the other device plays: 'cue' | 'master'
  masterVolume: 0.8,
  cueVolume: 0.8,
  cueMix: 0,               // headphones: 0 = cue only ... 1 = master only
  tipsSeen: false,
  setList: [],             // Auto Mix set list: [{ kind: 'library'|'demo', id }] in play order
  mixBeats: 32,            // Auto Mix transition length in beats: 16 | 32 | 64
  automixReturn: true,     // after a mix, ease the new song back to its own tempo
  automixBassSwap: true,   // swap the bass (low EQ) half way through a mix, like a DJ
});

export class Settings extends Emitter {
  constructor(storageKey = STORAGE_KEY) {
    super();
    this._key = storageKey;
    const saved = storageGet(storageKey, {});
    this._values = { ...DEFAULTS };
    if (saved && typeof saved === 'object') {
      for (const k of Object.keys(DEFAULTS)) {
        if (k in saved && typeof saved[k] === typeof DEFAULTS[k]) this._values[k] = saved[k];
      }
    }
  }

  get(key) {
    return this._values[key];
  }

  set(key, value) {
    if (!(key in DEFAULTS)) throw new Error(`Unknown setting "${key}"`);
    if (this._values[key] === value) return;
    this._values[key] = value;
    storageSet(this._key, this._values);
    this.emit('change', key, value);
  }

  all() {
    return { ...this._values };
  }

  reset() {
    this._values = { ...DEFAULTS };
    storageSet(this._key, this._values);
    for (const k of Object.keys(DEFAULTS)) this.emit('change', k, this._values[k]);
  }
}
