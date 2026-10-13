// AudioEngine: owns the AudioContext, the two deck players, the mixer and the output router; keeps the
// screen awake while performing; watches suspension / interruption; decodes files one at a time.
//
//   const engine = new AudioEngine({ settings });
//   startButton.addEventListener('click', () => engine.start());      // MUST run inside a click
//   engine.on('ready', () => { decks attach to engine.players[i] and engine.mixer.channels[i] });
//   engine.on('statechange', (state) => show "Tap to resume audio" when state is suspended/interrupted);
//   resumeButton.onclick = () => engine.resume();   restartButton.onclick = () => engine.restart();
//   const buffer = await engine.decode(arrayBuffer);
//
// After restart() the engine emits 'restarted' (not 'ready' again): the decks re-attach to the NEW players /
// channels and re-load their tracks.

import { Emitter } from '../core/emitter.js';
import { env } from '../core/env.js';
import { DeckPlayer } from './deck-player.js';
import { Mixer } from './mixer.js';
import { OutputRouter } from './outputs.js';

const RESUME_WAIT_MS = 1500;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AudioEngine extends Emitter {
  /** @param {{ settings: import('../core/settings.js').Settings }} opts */
  constructor({ settings } = {}) {
    super();
    this.settings = settings || null;
    this._ctx = null;
    this._mixer = null;
    this._outputs = null;
    this._players = [];
    this._ready = false;
    this._building = false;
    this._state = 'idle';
    this._startPromise = null;
    this._gen = 0;
    this._decodeChain = Promise.resolve();
    this._decodesPending = 0;
    this._wakeLock = null;
    this._wakePending = false;
    this._listening = false;
    this._lastError = '';
    this._onCtxState = () => this._syncState();
    this._onVisibility = () => this._visibilityChanged();
    this._onSessionState = () => this._syncState();
    this._onPlayerPlay = () => this._requestWakeLock();
    this._onPlayerError = (msg) => this.emit('error', msg);
    if (this.settings && typeof this.settings.on === 'function') {
      this.settings.on('change', (key, value) => this._settingChanged(key, value));
    }
  }

  get ready() {
    return this._ready;
  }

  get ctx() {
    return this._ctx;
  }

  get mixer() {
    return this._mixer;
  }

  get outputs() {
    return this._outputs;
  }

  /** [deck A player, deck B player] once ready, else []. */
  get players() {
    return this._ready ? this._players : [];
  }

  get usingWorklet() {
    return this._players.length > 0 && this._players.every((p) => p.usingWorklet);
  }

  /**
   * AudioContext time now (0 before start): the clock of player.playAt / seekAt / positionAt and
   * mixer.scheduleCrossfade / ChannelStrip.setEq({ at }).
   */
  get currentTime() {
    const ctx = this._ctx;
    return ctx && Number.isFinite(ctx.currentTime) ? ctx.currentTime : 0;
  }

  /**
   * Context time of the sample being heard right now (the clock of player.getPosition() / deck.position).
   * It lags currentTime by the output latency (10-40 ms, ~200 ms over Bluetooth).
   */
  audibleTime() {
    const p = this._players[0];
    if (p && typeof p.audibleTime === 'function') return p.audibleTime();
    const ctx = this._ctx;
    if (!ctx) return 0;
    return ctx.currentTime - (ctx.baseLatency || 0) - (ctx.outputLatency || 0);
  }

  /** 'idle' | 'starting' | 'running' | 'suspended' | 'interrupted' | 'closed' */
  get state() {
    return this._state;
  }

  // ---------------------------------------------------------------------------------------------------
  // Start / restart

  /**
   * Create and resume the AudioContext (synchronously, so call this from a click), then build the players,
   * mixer and outputs and emit 'ready'. Idempotent: returns the same promise while it is running or done.
   */
  start() {
    if (this._startPromise) return this._startPromise;
    return this._boot('ready');
  }

  /**
   * From a click: close the old context and rebuild everything (the iOS "audio died" escape hatch).
   * Emits 'restarted' so decks re-attach and re-load their tracks.
   */
  restart() {
    if (!this._ctx && !this._startPromise) return this.start();
    this._teardown();
    return this._boot('restarted');
  }

  _boot(eventName) {
    const gen = ++this._gen;
    this._ready = false;
    this._building = true;
    // --- synchronous part: must stay inside the user gesture ---
    this._setAudioSession();
    let ctx;
    try {
      ctx = this._createContext();
    } catch (err) {
      console.error('[TwinSpin] AudioContext failed', err);
      this._building = false;
      this._ctx = null;
      this._setState('idle');
      const msg = 'Audio could not start in this browser. Close other tabs that play sound and try again.';
      this._fail(msg);
      const p = Promise.reject(new Error(msg));
      p.catch(() => {});
      this._startPromise = null;
      return p;
    }
    this._ctx = ctx;
    let resumed = null;
    try {
      resumed = ctx.resume();
      if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {});
    } catch {
      resumed = null;
    }
    try {
      ctx.addEventListener('statechange', this._onCtxState);
    } catch {
      ctx.onstatechange = this._onCtxState;
    }
    this._listen();
    this._requestWakeLock();
    this._setState('starting');
    // --- asynchronous part ---
    const p = this._build(ctx, gen, resumed, eventName);
    this._startPromise = p;
    p.catch(() => {});
    return p;
  }

  _createContext() {
    const g = globalThis;
    const Ctor = g.AudioContext || g.webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio is not supported');
    try {
      return new Ctor({ latencyHint: 'interactive' });
    } catch (err) {
      return new Ctor();
    }
  }

  _setAudioSession() {
    try {
      const s = globalThis.navigator && globalThis.navigator.audioSession;
      if (s && s.type !== 'playback') s.type = 'playback';
    } catch {
      /* not supported */
    }
  }

  async _build(ctx, gen, resumed, eventName) {
    try {
      if (resumed) await Promise.race([resumed.catch(() => {}), delay(RESUME_WAIT_MS)]);
      if (gen !== this._gen) return;
      const a = await DeckPlayer.create(ctx);
      if (gen !== this._gen) {
        a.dispose();
        return;
      }
      const b = await DeckPlayer.create(ctx);
      if (gen !== this._gen) {
        a.dispose();
        b.dispose();
        return;
      }
      const players = [a, b];
      const mixer = new Mixer(ctx);
      players.forEach((p, i) => {
        p.node.connect(mixer.channels[i].input);
        p.on('play', this._onPlayerPlay);
        p.on('error', this._onPlayerError);
      });
      this._players = players;
      this._mixer = mixer;
      this._applyMixSettings();

      let router = null;
      try {
        // (router 'error' events are not re-emitted here: the UI listens to engine.outputs directly)
        router = new OutputRouter(ctx, mixer, this.settings);
      } catch (err) {
        console.error('[TwinSpin] output router failed, playing to the default output', err);
        router = null;
        try {
          mixer.masterOut.connect(ctx.destination);
        } catch {
          /* ignore */
        }
      }
      this._outputs = router;
      if (router) {
        try {
          await router.setMode(this._setting('outputMode', 'single'));
        } catch (err) {
          console.warn('[TwinSpin] output mode failed, using single', err);
          try {
            await router.setMode('single');
          } catch {
            /* ignore */
          }
        }
      }
      if (gen !== this._gen) return;
      this._building = false;
      this._ready = true;
      this._syncState(true);
      this.emit(eventName);
    } catch (err) {
      if (gen !== this._gen) return;
      console.error('[TwinSpin] audio engine start failed', err);
      this._building = false;
      this._startPromise = null;
      this._teardown();
      this._setState('idle');
      this._fail('Audio could not start. Reload the page and tap start again.');
      throw err;
    }
  }

  _teardown() {
    this._gen++;
    this._ready = false;
    this._building = false;
    this._startPromise = null;
    const ctx = this._ctx;
    for (const p of this._players) {
      try {
        p.dispose();
      } catch {
        /* ignore */
      }
    }
    this._players = [];
    if (this._outputs && typeof this._outputs.dispose === 'function') {
      try {
        this._outputs.dispose();
      } catch {
        /* ignore */
      }
    }
    this._outputs = null;
    if (this._mixer) {
      try {
        this._mixer.dispose();
      } catch {
        /* ignore */
      }
    }
    this._mixer = null;
    this._ctx = null;
    if (ctx) {
      try {
        ctx.removeEventListener('statechange', this._onCtxState);
      } catch {
        /* ignore */
      }
      try {
        const closing = ctx.close();
        if (closing && typeof closing.catch === 'function') closing.catch(() => {});
      } catch {
        /* ignore */
      }
    }
  }

  _fail(message) {
    this._lastError = message;
    this.emit('error', message);
  }

  // ---------------------------------------------------------------------------------------------------
  // State

  _setState(state) {
    if (state === this._state) return;
    this._state = state;
    this.emit('statechange', state);
  }

  _syncState(force = false) {
    const ctx = this._ctx;
    let state;
    if (!ctx) state = this._building ? 'starting' : 'idle';
    else if (this._building && !force) state = 'starting';
    else {
      state = ctx.state === 'running' || ctx.state === 'suspended' || ctx.state === 'interrupted' || ctx.state === 'closed'
        ? ctx.state : 'suspended';
      try {
        const s = globalThis.navigator && globalThis.navigator.audioSession;
        if (s && s.state === 'interrupted' && state !== 'closed') state = 'interrupted';
      } catch {
        /* ignore */
      }
    }
    this._setState(state);
  }

  /**
   * From a click when state is suspended / interrupted: resume the context (or rebuild it when closed).
   */
  resume() {
    const ctx = this._ctx;
    if (!ctx) return this.start();
    if (ctx.state === 'closed') return this.restart();
    this._setAudioSession();
    this._requestWakeLock();
    let p;
    try {
      p = ctx.resume();
    } catch (err) {
      p = Promise.reject(err);
    }
    // iOS can leave resume() pending while the session is interrupted: never wait more than 2 s
    const settled = Promise.resolve(p).catch((err) => {
      console.warn('[TwinSpin] resume failed', err);
    });
    return Promise.race([settled, delay(RESUME_WAIT_MS + 500)]).then(() => this._syncState());
  }

  _listen() {
    if (this._listening) return;
    this._listening = true;
    try {
      if (globalThis.document && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', this._onVisibility);
      }
    } catch {
      /* ignore */
    }
    try {
      const s = globalThis.navigator && globalThis.navigator.audioSession;
      if (s && typeof s.addEventListener === 'function') s.addEventListener('statechange', this._onSessionState);
    } catch {
      /* ignore */
    }
  }

  _visible() {
    try {
      return !globalThis.document || document.visibilityState !== 'hidden';
    } catch {
      return true;
    }
  }

  _visibilityChanged() {
    if (!this._visible()) return; // the browser drops the wake lock itself while hidden
    this._requestWakeLock();
    const ctx = this._ctx;
    if (ctx && this._ready && (ctx.state === 'suspended' || ctx.state === 'interrupted')) {
      // may succeed without a gesture after an earlier activation (Chrome); otherwise the UI banner asks
      try {
        const p = ctx.resume();
        if (p && typeof p.then === 'function') p.then(() => this._syncState(), () => this._syncState());
      } catch {
        /* ignore */
      }
    }
    this._syncState();
  }

  // ---------------------------------------------------------------------------------------------------
  // Settings

  _setting(key, fallback) {
    try {
      const v = this.settings ? this.settings.get(key) : undefined;
      return v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  }

  _applyMixSettings() {
    const m = this._mixer;
    if (!m) return;
    m.setMasterVolume(this._setting('masterVolume', 0.8));
    m.setCueVolume(this._setting('cueVolume', 0.8));
    m.setCueMix(this._setting('cueMix', 0));
    m.setCrossfaderCurve(this._setting('xfadeCurve', 'smooth'));
  }

  _settingChanged(key, value) {
    if (key === 'keepAwake') {
      if (value) this._requestWakeLock();
      else this._releaseWakeLock();
      return;
    }
    const m = this._mixer;
    if (!m) return;
    if (key === 'masterVolume') m.setMasterVolume(value);
    else if (key === 'cueVolume') m.setCueVolume(value);
    else if (key === 'cueMix') m.setCueMix(value);
    else if (key === 'xfadeCurve') m.setCrossfaderCurve(value);
  }

  // ---------------------------------------------------------------------------------------------------
  // Screen wake lock

  /** Keep the screen on (settings.keepAwake). Called in the start click, on every play and when visible. */
  keepAwake() {
    this._requestWakeLock();
  }

  _requestWakeLock() {
    try {
      if (!this._setting('keepAwake', true) || !this._visible()) return;
      const wl = globalThis.navigator && globalThis.navigator.wakeLock;
      if (!wl || typeof wl.request !== 'function') return;
      if ((this._wakeLock && !this._wakeLock.released) || this._wakePending) return;
      this._wakePending = true;
      wl.request('screen').then(
        (lock) => {
          this._wakePending = false;
          if (!this._setting('keepAwake', true)) {
            lock.release().catch(() => {});
            return;
          }
          this._wakeLock = lock;
          try {
            lock.addEventListener('release', () => {
              if (this._wakeLock === lock) this._wakeLock = null;
            });
          } catch {
            /* ignore */
          }
        },
        () => {
          this._wakePending = false; // denied (iframe policy, battery saver): not fatal
        },
      );
    } catch {
      this._wakePending = false;
    }
  }

  _releaseWakeLock() {
    const lock = this._wakeLock;
    this._wakeLock = null;
    if (lock) {
      try {
        lock.release().catch(() => {});
      } catch {
        /* ignore */
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------
  // Decoding

  /**
   * Decode an encoded file (one decode at a time: decoding is memory hungry on phones). The ArrayBuffer is
   * detached by the browser. Promise form, or callback form decode(ab, onSuccess, onError).
   * @returns {Promise<AudioBuffer>}
   */
  decode(arrayBuffer, onSuccess, onError) {
    this._decodesPending++;
    const run = () => this._decodeOne(arrayBuffer);
    const p = this._decodeChain.then(run, run);
    const done = () => {
      this._decodesPending--;
    };
    this._decodeChain = p.then(done, done);
    if (typeof onSuccess === 'function' || typeof onError === 'function') {
      p.then(
        (buf) => {
          if (typeof onSuccess === 'function') onSuccess(buf);
        },
        (err) => {
          if (typeof onError === 'function') onError(err);
        },
      );
    }
    return p;
  }

  async _decodeOne(arrayBuffer) {
    if (!this._ctx && this._startPromise) {
      try {
        await this._startPromise;
      } catch {
        /* handled below */
      }
    }
    const ctx = this._ctx;
    if (!ctx) throw new Error('Audio is not started yet. Tap start first.');
    if (!arrayBuffer || !(arrayBuffer.byteLength > 0)) throw new Error('This file is empty.');
    return new Promise((resolve, reject) => {
      let settled = false;
      const ok = (buf) => {
        if (settled) return;
        settled = true;
        if (buf && buf.length > 0) resolve(buf);
        else reject(new Error('This file has no audio in it.'));
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error((err && err.message) || 'Decoding failed'));
      };
      try {
        const r = ctx.decodeAudioData(arrayBuffer, ok, fail);
        if (r && typeof r.then === 'function') r.then(ok, fail);
      } catch (err) {
        fail(err);
      }
    });
  }

  // ---------------------------------------------------------------------------------------------------
  // Diagnostics

  /** Plain object for the Settings > About panel. */
  diagnostics() {
    const ctx = this._ctx;
    const nav = globalThis.navigator || {};
    const d = {
      state: this._state,
      ready: this._ready,
      contextState: ctx ? ctx.state : null,
      sampleRate: ctx ? ctx.sampleRate : null,
      baseLatency: ctx && typeof ctx.baseLatency === 'number' ? ctx.baseLatency : null,
      outputLatency: ctx && typeof ctx.outputLatency === 'number' ? ctx.outputLatency : null,
      usingWorklet: this.usingWorklet,
      deckEngine: this._players.map((p) => p.mode).join(', ') || null,
      secure: env.secure,
      audioWorkletAvailable: env.audioWorklet,
      maxChannelCount: ctx && ctx.destination ? ctx.destination.maxChannelCount : null,
      renderQuantumSize: ctx && typeof ctx.renderQuantumSize === 'number' ? ctx.renderQuantumSize : null,
      audioSession: null,
      wakeLock: !!(this._wakeLock && !this._wakeLock.released),
      wakeLockSupported: env.wakeLock,
      outputMode: this._outputs ? this._outputs.mode : null,
      decodesPending: this._decodesPending,
      lastError: this._lastError || null,
      playbackStats: null,
      userAgent: nav.userAgent || '',
    };
    try {
      if (nav.audioSession) d.audioSession = { type: nav.audioSession.type, state: nav.audioSession.state };
    } catch {
      /* ignore */
    }
    try {
      const st = ctx && ctx.playbackStats;
      if (st) {
        d.playbackStats = {
          underrunEvents: st.underrunEvents,
          underrunDuration: st.underrunDuration,
          averageLatency: st.averageLatency,
          maximumLatency: st.maximumLatency,
          totalDuration: st.totalDuration,
        };
      }
    } catch {
      /* ignore */
    }
    return d;
  }
}
