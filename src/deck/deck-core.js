// Deck core: the state, engine attachment and song loading of the Deck controller. src/deck/deck.js builds the
// public `Deck` on top of it (transport, tempo, platter, loops, BPM, FX and mixer channel); import Deck from
// there, not this class. Split out of deck.js only to keep both files readable; methods here call Deck methods
// (e.g. _seekTo, _setRate, setTrimDb) like any subclass hook.
//
// Loading: loading=true -> decodeFile -> preparePcm -> player.load (playable now, bpm null) -> analyzeTrack:
// waveform first, then beats + loudness (+ beat map): trim = gainDb, cue point = first beat. The AudioBuffer is
// dropped right after preparePcm. The File/Blob (or demo id) is kept so engine.restart() can re-load it: on the
// engine's 'restarted' event the deck re-attaches to the NEW player/channel, re-decodes the song (no re-analysis)
// and restores position, cue, loop, tempo, mixer and FX state (paused). A new song resets a tempo the user did not
// set (sync / Auto Mix) to 0 %.
// Contract: docs/CONTRACT.md section 4, docs/AUTOMIX.md section 4.1 (+ docs/CHANGES.md "deck").

import { Emitter } from '../core/emitter.js';
import { clamp, hashHue, uid } from '../core/util.js';
import { faderGain } from '../audio/curves.js';
import { decodeFile } from '../audio/decode.js';
import { preparePcm, yieldToMain } from '../audio/pcm.js';
import { DEMO_TRACKS, createDemoJob } from '../audio/demo-synth.js';
import { analyzeTrack } from '../analysis/analyzer.js';
import { cueReducer, initialCueState } from './cue-logic.js';
import { normalizeRange, rateAt } from './deck-math.js';
import { cleanBeatMap } from './sync-math.js';

const RACK_FX = ['echo', 'reverb', 'flanger'];
export const EQ_BANDS = Object.freeze(['low', 'mid', 'high']);
const DEFAULT_VOLUME = 0.8;           // matches the mixer UI's fader default
const AUDIBLE_GAIN = 0.01;            // -40 dB: needle lock / load lock threshold
const READY_TIMEOUT_MS = 20000;
const DEMO_SLICE_MS = 8;

const MSG_NOT_STARTED = 'Tap Start first so TwinSpin can play sound.';
const MSG_LOAD_FAILED = "That song couldn't be loaded. Try an MP3 or WAV file.";

function perfNow() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

const DEFAULT_DEPS = Object.freeze({
  decodeFile,
  preparePcm,
  analyzeTrack,
  createDemoJob,
  yieldToMain,
  now: perfNow,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
});

/** AudioBuffer look-alike over plain Float32Arrays (demo tracks). */
function bufferLike(channels, sampleRate) {
  return {
    sampleRate,
    length: channels[0].length,
    numberOfChannels: channels.length,
    duration: channels[0].length / sampleRate,
    getChannelData: (c) => channels[c],
  };
}

function demoBeats(id) {
  const d = DEMO_TRACKS.find((t) => t.id === id);
  // demo songs are synthesised on an exact grid: no beat map needed
  return d ? { bpm: d.bpm, firstBeat: 0, confidence: 1, variable: false, alternatives: [d.bpm / 2, d.bpm * 2], beats: null } : null;
}

/** True unless opts says the call comes from Auto Mix or sync ({ source: 'auto' | 'sync' }). */
export function byUser(opts) {
  const s = opts && opts.source;
  return s !== 'auto' && s !== 'sync';
}

/** A short user-facing message for a failed load. */
function loadMessage(err) {
  const msg = err && typeof err.message === 'string' ? err.message.trim() : '';
  const plain = !err || !err.name || err.name === 'Error';
  return plain && msg && msg.length < 240 ? msg : MSG_LOAD_FAILED;
}

export class DeckCore extends Emitter {
  /**
   * @param {'A'|'B'} id
   * @param {import('../audio/engine.js').AudioEngine} engine
   * @param {import('../core/settings.js').Settings} settings
   * @param {object} [deps] dependency injection for tests: { decodeFile, preparePcm, analyzeTrack, createDemoJob,
   *   yieldToMain, now, setTimeout, clearTimeout } (defaults: the real modules and timers)
   */
  constructor(id, engine, settings, deps = {}) {
    super();
    this.id = id === 'B' ? 'B' : 'A';
    this.index = this.id === 'B' ? 1 : 0;
    this._engine = engine || null;
    this._settings = settings || null;
    this._deps = { ...DEFAULT_DEPS, ...(deps || {}) };

    this._player = null;
    this._channel = null;
    this._offs = [];
    this._ready = false;
    this._waiters = [];

    this._track = null;
    this._source = null;              // { kind: 'file', blob, meta } | { kind: 'demo', id, meta }
    this._loading = false;
    this._restoring = false;
    this._analyzing = false;
    this._loadToken = 0;
    this._analysisCtrl = null;

    this._cue = initialCueState(0);
    this._cueMoved = false;
    this._ended = false;
    this._lastPos = 0;
    this._lastJumpAt = -Infinity;
    this._serial = 0;                 // bumps on every transport command (cancels a pending echo-out pause)
    this._timers = new Set();

    this._tempoRange = normalizeRange(this._setting('tempoRange', 0.08));
    this._userRange = this._tempoRange; // the range the user picked (sync / Auto Mix may widen it for a while)
    this._tempo = 0;
    this._rate = 1;                     // target rate (the end of a running ramp)
    this._tempoSource = 'user';         // who set the tempo: 'user' | 'sync' | 'auto'
    this._ramp = null;                  // { c0, c1, r0, r1 } AudioContext seconds while a tempo ramp runs
    this._pendingAt = null;             // AudioContext time of a scheduled start / jump that has not happened yet
    this._userBend = 0;
    this._syncBend = 0;
    this._synced = false;
    this._scratching = false;
    this._scratchRef = 0;
    this._vinyl = this._setting('vinyl', true) !== false;
    this._loop = { active: false, beats: 4, start: 0, end: 0 };
    this._taps = [];
    this._tapMode = '';
    this._fx = { echo: false, reverb: false, flanger: false, crush: false, amount: 0.5 };
    this._mix = { volume: DEFAULT_VOLUME, eq: { low: 0, mid: 0, high: 0 }, filter: 0, trimDb: 0, cue: false };

    if (engine && typeof engine.on === 'function') {
      engine.on('ready', () => this._onEngine());
      engine.on('restarted', () => this._onEngine());
    }
    if (engine && engine.ready) this._attach();
  }

  // ---------------------------------------------------------------------------------------------------
  // State (read every frame by the UI)

  /** Engine ready and this deck attached to its player and channel. */
  get ready() {
    return this._ready;
  }

  /** @returns {object|null} Track (contract section 4) */
  get track() {
    return this._track;
  }

  /** Decoding / preparing PCM (also while re-loading after an audio restart). */
  get loading() {
    return this._loading;
  }

  /** Re-loading the same song after engine.restart() (sync is kept). */
  get restoring() {
    return this._restoring;
  }

  /** BPM / waveform analysis running. */
  get analyzing() {
    return this._analyzing;
  }

  get playing() {
    return !!this._track && !this._restoring && this._cue.playing;
  }

  /** Seconds of track time being heard now. */
  get position() {
    const p = this._player;
    if (p && this._track && !this._restoring && p.loaded) {
      const v = p.getPosition();
      if (Number.isFinite(v)) this._lastPos = v;
    }
    return this._lastPos;
  }

  get duration() {
    return this._track ? this._track.duration : 0;
  }

  /** Playing and loud enough in the master to matter: channel volume x crossfader gain above -40 dB. */
  get audible() {
    if (!this.playing) return false;
    const ch = this._channel;
    const st = ch && ch.state;
    const xf = st && Number.isFinite(st.xfade) ? st.xfade : 1;
    return faderGain(this._mix.volume) * xf > AUDIBLE_GAIN;
  }

  /** Tempo fader value -1..1 (follows a running tempo ramp). */
  get tempo() {
    if (!this._liveRamp()) return this._tempo;
    return clamp((this.rate - 1) / this._tempoRange, -1, 1);
  }

  /** 0.08 | 0.16 | 0.5 */
  get tempoRange() {
    return this._tempoRange;
  }

  /** Playback rate including sync (bend not included); the current value while a tempo ramp runs. */
  get rate() {
    const r = this._liveRamp();
    if (!r) return this._rate;
    const p = this._player;
    const live = p ? p.rate : undefined; // the player's ramp estimate when it ramps by itself
    return typeof live === 'number' && Number.isFinite(live) && live > 0 ? live : rateAt({ rate: this._rate, ramp: r }, this.audioTime);
  }

  /** The rate a running tempo ramp ends at (= rate when no ramp runs). */
  get targetRate() {
    return this._rate;
  }

  /** True while rampTempo() is changing the rate. */
  get ramping() {
    return !!this._liveRamp();
  }

  /** Who set the current tempo: 'user' | 'sync' | 'auto'. */
  get tempoSource() {
    return this._tempoSource;
  }

  /** AudioContext time now (the render clock), or null when audio is not running. */
  get audioTime() {
    const ctx = this._engine && this._engine.ctx;
    const t = ctx ? ctx.currentTime : NaN;
    return Number.isFinite(t) ? t : null;
  }

  /** AudioContext time of a scheduled start or jump (playAt / seekAt) still to come, else null. */
  get scheduledAt() {
    const now = this.audioTime;
    const p = this._player;
    let at = this._pendingAt;
    if (p && ('scheduledStart' in p || 'scheduledSeek' in p)) {
      // the player knows best (a pause or seek there cancels a pending start)
      const s = p.scheduledStart;
      const j = p.scheduledSeek;
      at = Number.isFinite(s) ? s : null;
      if (j && Number.isFinite(j.at) && (at === null || j.at > at)) at = j.at;
    }
    if (at === null || now === null || now >= at) {
      this._pendingAt = null;
      return null;
    }
    return at;
  }

  /** Current temporary bend (user nudge + sync phase correction). */
  get bend() {
    return this._userBend + this._syncBend;
  }

  /** Track BPM (original tempo of the song; the user may have changed it with x2 / ½ / TAP), or null. */
  get bpm() {
    const t = this._track;
    return t && t.bpm > 0 ? t.bpm : null;
  }

  get effectiveBpm() {
    const b = this.bpm;
    return b ? b * this.rate : null;
  }

  /** Seconds of track time per beat. */
  get beatLength() {
    const b = this.bpm;
    return b ? 60 / b : null;
  }

  get cuePoint() {
    return this._cue.cuePoint;
  }

  /** { active, beats, start, end } (a new object whenever it changes). */
  get loop() {
    return this._loop;
  }

  get synced() {
    return this._synced;
  }

  get scratching() {
    return this._scratching;
  }

  get vinyl() {
    return this._vinyl;
  }

  /** { echo, reverb, flanger, crush, amount } */
  get fx() {
    return this._fx;
  }

  /** { volume, eq: { low, mid, high }, filter, trimDb, cue } */
  get mix() {
    return this._mix;
  }

  /** performance.now() of the last seek, loop jump or scratch (SyncController skips phase correction after it). */
  get lastJumpAt() {
    return this._lastJumpAt;
  }

  // ---------------------------------------------------------------------------------------------------
  // Engine attachment

  _onEngine() {
    const eng = this._engine;
    if (!eng || !eng.ready) return;
    const next = (eng.players || [])[this.index];
    if (next && next === this._player) {
      this._attach();
      return;
    }
    const hadPlayer = !!this._player;
    this._cancelTimers();
    this._scratching = false;
    this._userBend = 0;
    this._syncBend = 0;
    this._ended = false;
    this._cue = initialCueState(this._cue.cuePoint); // a new context starts paused
    this._detach();
    if (!this._attach()) return;
    const src = this._source;
    if (!src) return;
    if (!this._track) {
      // a load was decoding in the old (now closed) context: start it over in the new one
      if (hadPlayer && this._loading) this._startLoad(src).catch(() => {});
      return;
    }
    this._restore(src, this._lastPos);
  }

  _attach() {
    const eng = this._engine;
    if (!eng || !eng.ready) return false;
    const player = (eng.players || [])[this.index];
    const mixer = eng.mixer;
    const channel = mixer && mixer.channels ? mixer.channels[this.index] : null;
    if (!player || !channel) return false;
    if (player !== this._player) {
      this._detach();
      this._player = player;
      if (typeof player.on === 'function') this._offs.push(player.on('ended', () => this._onEnded()));
    }
    this._channel = channel;
    this._applyState();
    this._ready = true;
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) w.resolve();
    this._emit('transport');
    return true;
  }

  _detach() {
    for (const off of this._offs) this._safe(off);
    this._offs = [];
    this._player = null;
    this._channel = null;
    this._ready = false;
  }

  /** Push the deck's tempo, FX and mixer state into the (new) player and channel. */
  _applyState() {
    const p = this._player;
    const ch = this._channel;
    this._ramp = null; // a new player starts at the target rate
    this._pendingAt = null;
    if (p) {
      this._safe(() => p.setRate(this._rate));
      this._safe(() => p.setBend(this._userBend + this._syncBend));
      this._safe(() => p.setBrake(0));
      this._safe(() => p.setCrush(this._fx.crush ? this._fx.amount : 0));
    }
    if (ch) {
      const m = this._mix;
      this._safe(() => ch.setTrimDb(m.trimDb));
      for (const b of EQ_BANDS) this._safe(() => ch.setEq(b, m.eq[b]));
      this._safe(() => ch.setFilter(m.filter));
      this._safe(() => ch.setVolume(m.volume));
      this._safe(() => ch.setCue(m.cue));
      const fx = ch.fx;
      if (fx) {
        this._safe(() => fx.setAmount(this._fx.amount));
        for (const n of RACK_FX) this._safe(() => fx.set(n, this._fx[n]));
      }
    }
    this._updateBeat();
  }

  /** Resolves once attached; rejects when audio was never started (or takes far too long). */
  _whenReady() {
    if (this._ready && this._player) return Promise.resolve();
    const eng = this._engine;
    if (!eng) return Promise.reject(new Error('Audio is not available in this browser.'));
    if (eng.ready && this._attach()) return Promise.resolve();
    if (!eng.ctx && eng.state !== 'starting') return Promise.reject(new Error(MSG_NOT_STARTED));
    return new Promise((resolve, reject) => {
      const w = {
        resolve: () => {
          this._deps.clearTimeout(timer);
          resolve();
        },
      };
      const timer = this._deps.setTimeout(() => {
        this._waiters = this._waiters.filter((x) => x !== w);
        reject(new Error('Audio is taking too long to start. Open Settings and tap Restart audio.'));
      }, READY_TIMEOUT_MS);
      this._waiters.push(w);
    });
  }

  // ---------------------------------------------------------------------------------------------------
  // Loading

  /**
   * Load a song file (File or library Blob). meta (optional) overrides the tags: { title, artist, fileName,
   * libraryId }. Resolves when the song is playable (analysis continues in the background); rejects after
   * emitting 'error' when it cannot be loaded. A newer load on this deck makes an older one resolve quietly.
   * @param {Blob} fileOrBlob
   * @param {{ title?: string, artist?: string, fileName?: string, libraryId?: string }} [meta]
   * @param {{ source?: 'user'|'auto' }} [opts] Auto Mix passes { source: 'auto' } (no 'userAction')
   */
  loadFile(fileOrBlob, meta, opts) {
    if (!fileOrBlob) {
      const msg = 'No song file was picked.';
      this.emit('error', msg);
      return Promise.reject(new Error(msg));
    }
    const m = meta && typeof meta === 'object' ? meta : {};
    const src = {
      kind: 'file',
      blob: fileOrBlob,
      meta: {
        title: typeof m.title === 'string' ? m.title : '',
        artist: typeof m.artist === 'string' ? m.artist : '',
        fileName: typeof m.fileName === 'string' && m.fileName ? m.fileName : String(fileOrBlob.name || ''),
        libraryId: m.libraryId != null ? m.libraryId : null,
      },
    };
    return this._startLoad(src, opts);
  }

  /**
   * Load demo track 0 or 1 (DEMO_TRACKS), synthesised at the context's sample rate.
   * @param {number} id
   * @param {{ source?: 'user'|'auto' }} [opts]
   */
  loadDemo(id, opts) {
    const d = DEMO_TRACKS.find((t) => t.id === Number(id));
    if (!d) {
      const msg = 'That demo track does not exist.';
      this.emit('error', msg);
      return Promise.reject(new Error(msg));
    }
    return this._startLoad({ kind: 'demo', id: d.id, meta: { title: d.title, artist: d.artist, fileName: '', libraryId: null } }, opts);
  }

  /** Stop and remove the song. */
  eject(opts) {
    this._loadToken++;
    this._abortAnalysis();
    this._cancelTimers();
    this._unloadPlayer();
    this._track = null;
    this._source = null;
    this._loading = false;
    this._restoring = false;
    this._resetTrackState();
    this._emit('loading');
    this._emit('track');
    this._emit('transport');
    if (byUser(opts)) this._userAction('eject');
  }

  async _startLoad(src, opts) {
    const token = ++this._loadToken;
    this._abortAnalysis();
    this._cancelTimers();
    this._unloadPlayer(); // frees the old PCM before decoding the next song (phone memory)
    const hadTrack = !!this._track;
    this._track = null;
    this._source = src;
    this._loading = true;
    this._restoring = false;
    this._resetTrackState();
    this._resetAutoTempo();
    this._emit('loading');
    if (hadTrack) this._emit('track');
    if (byUser(opts)) this._userAction('load');
    try {
      await this._whenReady();
      if (token !== this._loadToken) return;
      const pcm = await this._renderPcm(src, token, true);
      if (!pcm || token !== this._loadToken) return;
      this._install(src, pcm);
    } catch (err) {
      if (token !== this._loadToken) return;
      console.warn(`[TwinSpin] deck ${this.id}: load failed`, err);
      this._loading = false;
      this._source = null;
      this._emit('loading');
      const msg = src.kind === 'demo' && loadMessage(err) === MSG_LOAD_FAILED
        ? "The demo track couldn't be made. Reload the page and try again." : loadMessage(err);
      this.emit('error', msg);
      const e = new Error(msg);
      e.cause = err;
      throw e;
    }
  }

  /** Decode (file) or synthesise (demo), then convert to deck PCM. Returns null when superseded. */
  async _renderPcm(src, token, withMono) {
    const d = this._deps;
    if (src.kind === 'demo') {
      const sr = this._sampleRate();
      const job = d.createDemoJob(src.id, sr);
      while (!job.step(DEMO_SLICE_MS)) {
        await d.yieldToMain();
        if (token !== this._loadToken) return null;
      }
      const r = job.result();
      const pcm = await d.preparePcm(bufferLike(r.channels, r.sampleRate), { mono: withMono });
      return { ...pcm, sampleRate: r.sampleRate, meta: src.meta, warning: null };
    }
    const name = src.meta.fileName || String(src.blob.name || '');
    const res = await d.decodeFile(src.blob, this._engine, name);
    if (token !== this._loadToken) return null;
    const buffer = res.buffer;
    const pcm = await d.preparePcm(buffer, { mono: withMono });
    return { ...pcm, sampleRate: buffer.sampleRate, meta: res.meta || {}, warning: res.warning || null };
  }

  _install(src, pcm) {
    const tags = pcm.meta || {};
    const own = src.meta || {};
    const title = own.title || tags.title || own.fileName || 'Untitled';
    const artist = own.artist || tags.artist || '';
    const sr = pcm.sampleRate;
    const len = pcm.channels[0].length;
    const track = {
      id: uid('track'),
      title,
      artist,
      fileName: own.fileName || tags.fileName || '',
      source: src.kind === 'demo' ? 'demo' : 'file',
      duration: len / sr,
      sampleRate: sr,
      bpm: null,
      bpmDetected: null,
      firstBeat: 0,
      confidence: 0,
      variable: false,
      alternatives: [],
      waveform: null,
      gainDb: 0,
      hue: hashHue(`${title}|${artist}`),
    };
    if (own.libraryId != null) track.libraryId = own.libraryId;
    if (src.kind === 'demo') track.demoId = src.id;
    this._player.load(pcm.channels, sr); // transferred: do not touch pcm.channels afterwards
    this._track = track;
    this._loading = false;
    this._lastPos = 0;
    this._lastJumpAt = this._deps.now();
    this._emit('loading');
    this._emit('track');
    if (pcm.warning) this.emit('error', pcm.warning);
    this._analyze(track, pcm.mono, pcm.monoRate);
  }

  /** Re-load the kept song into a new player after engine.restart(); keeps the analysis. */
  async _restore(src, pos) {
    const token = ++this._loadToken;
    const track = this._track;
    this._restoring = true;
    this._loading = true;
    this._emit('loading');
    this._emit('transport');
    try {
      const pcm = await this._renderPcm(src, token, false);
      if (!pcm || token !== this._loadToken || this._track !== track) return;
      const sr = pcm.sampleRate;
      const len = pcm.channels[0].length;
      this._player.load(pcm.channels, sr);
      track.duration = len / sr;
      track.sampleRate = sr;
      const p = clamp(Number.isFinite(pos) ? pos : 0, 0, track.duration);
      this._lastPos = p;
      if (p > 0) this._player.seek(p, false);
      const L = this._loop;
      if (L.active) {
        if (L.end <= track.duration && L.end > L.start) this._player.setLoop(L.start, L.end);
        else this._loop = { ...L, active: false };
      }
      this._lastJumpAt = this._deps.now();
      this._restoring = false;
      this._loading = false;
      this._emit('loading');
      this._emit('transport');
      this._emit('loop');
    } catch (err) {
      if (token !== this._loadToken) return;
      console.warn(`[TwinSpin] deck ${this.id}: reload after audio restart failed`, err);
      this._restoring = false;
      this._loading = false;
      this._abortAnalysis();
      this._track = null;
      this._source = null;
      this._resetTrackState();
      this._emit('loading');
      this._emit('track');
      this.emit('error', `Deck ${this.id}'s song could not be reloaded after the audio restart. Load it again.`);
    }
  }

  _analyze(track, mono, monoRate) {
    if (!mono || !mono.length) {
      if (track.source === 'demo') this._applyBeats(track, demoBeats(track.demoId) || {});
      return;
    }
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    this._analysisCtrl = ctrl;
    this._analyzing = true;
    this._emit('analysis');
    let p;
    try {
      p = this._deps.analyzeTrack(mono, monoRate, {
        signal: ctrl ? ctrl.signal : undefined,
        onWaveform: (wf) => {
          if (this._track !== track || !wf) return;
          track.waveform = wf;
          this._emit('analysis');
        },
      });
    } catch (err) {
      p = Promise.reject(err);
    }
    Promise.resolve(p).then(
      (res) => this._applyAnalysis(track, res, ctrl),
      (err) => {
        if (this._track !== track) return;
        if (this._analysisCtrl === ctrl) this._analysisCtrl = null;
        this._analyzing = false;
        if (track.source === 'demo') this._applyBeats(track, demoBeats(track.demoId) || {});
        this._emit('analysis');
        if (err && err.name === 'AbortError') return;
        console.warn(`[TwinSpin] deck ${this.id}: analysis failed`, err);
        if (track.source !== 'demo') {
          this.emit('error', loadMessage(err) === MSG_LOAD_FAILED
            ? "Couldn't work out this song's tempo. You can still play it and tap the tempo in." : loadMessage(err));
        }
      },
    );
  }

  _applyAnalysis(track, res, ctrl) {
    if (this._track !== track) return;
    if (this._analysisCtrl === ctrl) this._analysisCtrl = null;
    this._analyzing = false;
    const r = res || {};
    if (r.waveform) track.waveform = r.waveform;
    let beats = r.beats || {};
    if (track.source === 'demo') {
      const known = demoBeats(track.demoId);
      if (known) beats = { ...beats, ...known };
    }
    this._applyBeats(track, beats);
    const g = r.loudness && r.loudness.gainDb;
    if (Number.isFinite(g)) {
      track.gainDb = g;
      this.setTrimDb(g);
    }
    this._emit('analysis');
    this.emit('analyzed', track);
  }

  _applyBeats(track, beats) {
    const bpm = Number.isFinite(beats.bpm) && beats.bpm > 0 ? beats.bpm : null;
    track.bpm = bpm;
    track.bpmDetected = bpm;
    track.firstBeat = Number.isFinite(beats.firstBeat) && beats.firstBeat >= 0 ? beats.firstBeat : 0;
    track.confidence = Number.isFinite(beats.confidence) ? clamp(beats.confidence, 0, 1) : 0;
    track.variable = !!beats.variable;
    track.alternatives = Array.isArray(beats.alternatives) ? beats.alternatives.filter((x) => Number.isFinite(x) && x > 0) : [];
    track.beats = bpm ? cleanBeatMap(beats.beats) : null;
    track.beatAnchor = track.firstBeat;
    if (bpm) this._autoCue(track.firstBeat);
    this._loopFollowBpm();
    this._updateBeat();
    this._emit('bpm');
  }

  /** Cue point = first beat, unless the user already set one; a paused, untouched deck moves there too. */
  _autoCue(firstBeat) {
    if (this._cueMoved) return;
    const old = this._cue.cuePoint;
    if (Math.abs(firstBeat - old) < 1e-9) return;
    const parked = !this.playing && !this._scratching && Math.abs(this.position - old) < 0.03;
    this._cue = { ...this._cue, cuePoint: firstBeat };
    if (parked && this._player) this._seekTo(firstBeat, 'auto');
    this._emit('cue');
  }

  _abortAnalysis() {
    const c = this._analysisCtrl;
    this._analysisCtrl = null;
    this._analyzing = false;
    if (c) this._safe(() => c.abort());
  }

  _unloadPlayer() {
    const p = this._player;
    if (!p) return;
    this._safe(() => p.setBrake(0));
    this._safe(() => p.unload());
  }

  /** Per-song state back to defaults (tempo, FX and mixer settings stay). */
  _resetTrackState() {
    this._loop = { active: false, beats: this._loop.beats || 4, start: 0, end: 0 };
    this._cue = initialCueState(0);
    this._cueMoved = false;
    this._ended = false;
    this._pendingAt = null;
    this._lastPos = 0;
    this._lastJumpAt = this._deps.now();
    this._scratching = false;
    this._taps = [];
    if (this._userBend || this._syncBend) {
      this._userBend = 0;
      this._syncBend = 0;
      this._safe(() => this._player && this._player.setBend(0));
    }
    if (this._synced) this.setSynced(false);
    if (this._mix.trimDb !== 0) this.setTrimDb(0);
  }

  /** A new song: a tempo set by sync or Auto Mix goes back to 0 % (and the fader to the user's range). */
  _resetAutoTempo() {
    if (this._tempoSource === 'user') return;
    this._tempoRange = this._userRange;
    this._setRate(1, 0, 'user');
  }

  _sampleRate() {
    const eng = this._engine;
    const sr = eng && eng.ctx && eng.ctx.sampleRate;
    return sr > 0 ? sr : 48000;
  }

  _onEnded() {
    if (!this._track) return;
    const r = cueReducer(this._cue, { type: 'stopped', pos: this.duration });
    this._cue = r.state;
    this._ended = true;
    this._emit('transport');
    this.emit('ended');
  }


  // ---------------------------------------------------------------------------------------------------
  // Helpers

  _emit(what) {
    this.emit('change', what);
  }

  /** A user-facing control was used (Auto Mix watches these to notice a takeover). */
  _userAction(name) {
    this.emit('userAction', name);
  }

  _setting(key, fallback) {
    try {
      const v = this._settings && typeof this._settings.get === 'function' ? this._settings.get(key) : undefined;
      return v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  }

  _quantize() {
    return this._setting('quantize', true) !== false;
  }

  _grid() {
    const b = this.bpm;
    return b ? { bpm: b, firstBeat: this._track.firstBeat, beats: this._track.beats || null } : null;
  }

  /** Echo time and flanger speed follow the tempo. */
  _updateBeat() {
    const fx = this._channel && this._channel.fx;
    if (!fx) return;
    const eff = this.effectiveBpm;
    this._safe(() => fx.setBeatSeconds(60 / (eff || 120)));
  }

  _later(fn, ms) {
    const id = this._deps.setTimeout(() => {
      this._timers.delete(id);
      fn();
    }, ms);
    this._timers.add(id);
  }

  _cancelTimers() {
    for (const id of this._timers) this._deps.clearTimeout(id);
    this._timers.clear();
    this._serial++;
  }

  _safe(fn) {
    try {
      return fn();
    } catch (err) {
      console.warn(`[TwinSpin] deck ${this.id}:`, err);
      return undefined;
    }
  }
}
