// OutputRouter: sends the mixer's two buses (masterOut = speaker mix, cueOut = headphone mix) to the outputs this
// device can use. The mixer and decks never know which mode is active; only the wiring after the buses changes.
//
//   const router = new OutputRouter(ctx, mixer, settings);   // engine.js, once the Mixer exists
//   router.modes.dual.ok / .reason                            // what this device can do (routing-plan.js)
//   await router.setMode('split');                           // from a click; falls back to 'single' on failure
//   await router.requestDeviceAccess('cue');                 // desktop only, from a click
//   await router.listOutputs();                              // [{ deviceId, label, hint }]
//   await router.setCueDevice(id); router.test('cue');       // two outputs: pick + identify
//   router.describe() -> 'Speaker + Headphones'              // chip text
//   router.on('change', what => ...); router.on('error', message => toast(message));
//
// Modes (settings.outputMode, restored at construction):
//   single  masterOut -> ctx.destination. The headphone bus goes nowhere (PFL still drives the cue meter).
//   dual    desktop only. Headphones: cueOut -> MediaStreamDestination -> hidden <audio> -> setSinkId(cue) -> play().
//           Speaker: ctx.setSinkId(master) where available (Chrome/Edge), else its own MediaStreamDestination ->
//           <audio>.setSinkId(master) when a non-default device is chosen (Firefox, Safari macOS), else
//           ctx.destination. The cue never touches ctx.destination here, and it is connected only after its <audio>
//           reached its device. Signed alignment: +ms delays the speaker path, -ms the headphone path.
//   split   one output: mono speaker mix on one side, mono headphone mix on the other (ChannelMerger), swappable.
//   remote  this device plays one bus, getRemoteStream() carries the other (RemoteHost sends it over WebRTC). The
//           stream is fed by BOTH buses through gains, so setRemoteBus() is a gain change, never a renegotiation.
// Graph: mixer.masterOut -> masterIn -> masterDelay -> taps (GainNodes) -> destination | merger | stream dests;
// the same for the cue. Only the taps' outputs are rewired (with a 12 ms fade), never the mixer's nodes.
// Never calls getUserMedia on phones (dual is refused there before any device call).

import { Emitter } from '../core/emitter.js';
import { env as defaultEnv } from '../core/env.js';
import {
  availableModes, dedupeOutputs, deviceLabelHint, friendlySinkError, friendlyAccessError, alignmentDelays, splitSides,
  describeRouting, formFactorOf, sameOutput, sinkIdOf, MODES, SINGLE_HINT, UNLOCK_LABEL,
} from './routing-plan.js';
import { peekSharedHost } from '../remote/remote-host.js';

const FADE_S = 0.012;
const FADE_WAIT_MS = 30;
const SINK_TIMEOUT_MS = 8000;
const ENUM_TIMEOUT_MS = 3000;
const BEEP_LEVEL = 0.22;
const MAX_DELAY_S = 0.35;

const MSG = Object.freeze({
  restoreDual: 'Couldn\'t reopen your two outputs. Open Outputs and pick the speaker and headphones again.',
  restoreRemote: 'Second device sharing stopped when TwinSpin restarted. Open Outputs to share again.',
  chooseCue: 'Choose which output your headphones are on first.',
  same: 'Speaker and headphones are set to the same output. Pick two different outputs, or use Split cable.',
  noCueOutput: 'There is no separate headphone output right now. Pick Two outputs, Split cable or Second device first.',
  lostCue: 'Your headphones output was disconnected. Switched back to one output.',
  lostMaster: 'Your speaker output was disconnected. Switched back to one output.',
  noLabels: 'The browser still hides your speakers. Check that this site may use the microphone, then try again.',
  noAccessApi: 'This browser can\'t show your speaker names. Use Split cable instead.',
  pickAgain: 'Tap the button again to choose an output.',
});

function makeErr(name, message = '') {
  const e = new Error(message || name);
  e.name = name;
  return e;
}

function withTimeout(promise, ms) {
  let timer = null;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => reject(makeErr('TimeoutError', 'timed out')), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

/** Run fn and swallow errors (cleanup paths where a failure is harmless). */
function quiet(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Call fn and always get a promise (a synchronous throw becomes a rejection). */
function promised(fn) {
  try {
    return Promise.resolve(fn());
  } catch (e) {
    return Promise.reject(e);
  }
}

function tagRole(err, role) {
  const e = err instanceof Error ? err : makeErr((err && err.name) || 'Error', String((err && err.message) || err));
  if (!e.role) quiet(() => { e.role = role; });
  return e;
}

const safePlay = (el) => promised(() => el.play());
const stopStream = (stream) => quiet(() => stream.getTracks().forEach((tr) => tr.stop()));
const screenShort = () => quiet(() => Math.min(globalThis.screen.width || 0, globalThis.screen.height || 0)) || 0;

export class OutputRouter extends Emitter {
  /**
   * @param {AudioContext} ctx
   * @param {{ masterOut: AudioNode, cueOut: AudioNode }} mixer
   * @param {import('../core/settings.js').Settings} settings
   * @param {{ env?: object, document?: Document|null, mediaDevices?: MediaDevices|null, topLevel?: boolean,
   *           formFactor?: 'phone'|'tablet'|'computer' }} [opts]  overrides for tests
   */
  constructor(ctx, mixer, settings, opts = {}) {
    super();
    const g = globalThis;
    this.ctx = ctx;
    this.mixer = mixer;
    this.settings = settings;
    this._env = opts.env || defaultEnv;
    this._doc = 'document' in opts ? opts.document : (g.document || null);
    this._md = 'mediaDevices' in opts ? opts.mediaDevices : ((g.navigator && g.navigator.mediaDevices) || null);
    this._ff = opts.formFactor || formFactorOf(this._env, screenShort());
    const topLevel = 'topLevel' in opts ? !!opts.topLevel : !this._env.embedded;
    this._modes = Object.freeze(availableModes(this._env, { topLevel, formFactor: this._ff }));
    this._mode = 'single';
    this._gen = 0;
    this._pending = null;
    this._pendingMode = null;
    this._access = false;
    this._devices = [];
    this._outputs = null;
    this._granted = new Map();
    this._masterVia = 'dest';
    this._els = { master: null, cue: null };
    this._remote = null;
    this._merger = null;
    this._mergerOn = false;
    this._tapTo = new Map();
    this._disposed = false;

    this._masterIn = ctx.createGain();
    this._cueIn = ctx.createGain();
    this._masterDelay = ctx.createDelay(MAX_DELAY_S);
    this._cueDelay = ctx.createDelay(MAX_DELAY_S);
    mixer.masterOut.connect(this._masterIn);
    mixer.cueOut.connect(this._cueIn);
    this._masterIn.connect(this._masterDelay);
    this._cueIn.connect(this._cueDelay);
    const tap = (src) => {
      const t = ctx.createGain();
      src.connect(t);
      this._tapTo.set(t, { to: null, input: 0 });
      return t;
    };
    this._t = {
      mDest: tap(this._masterDelay), cDest: tap(this._cueDelay),
      mSplit: tap(this._masterDelay), cSplit: tap(this._cueDelay),
      mEl: tap(this._masterDelay), cEl: tap(this._cueDelay),
      mRemote: tap(this._masterDelay), cRemote: tap(this._cueDelay),
    };
    this._wire();

    this._onDeviceChange = () => {
      this._deviceChanged();
    };
    if (this._md && typeof this._md.addEventListener === 'function') {
      this._md.addEventListener('devicechange', this._onDeviceChange);
    }

    // Restore the saved mode on the next task, so 'change'/'error' reach listeners attached right after
    // construction. A setMode(saved) call before then (e.g. from the engine) takes the restore's place.
    this._restoreMode = null;
    this._restoreTimer = null;
    const saved = settings.get('outputMode');
    if (saved && saved !== 'single' && MODES.includes(saved)) {
      this._restoreMode = saved;
      this._restoreTimer = setTimeout(() => {
        this._restoreTimer = null;
        const mode = this._restoreMode;
        this._restoreMode = null;
        if (mode && !this._disposed) this._restore(mode);
      }, 0);
    }
  }

  // ------------------------------------------------------------------------------------------------ state

  /** availableModes(env): { single, dual: {ok, reason}, split: {ok, note}, remote: {ok, reason} } */
  get modes() {
    return this._modes;
  }

  /** 'single' | 'dual' | 'split' | 'remote' */
  get mode() {
    return this._mode;
  }

  /** 'phone' | 'tablet' | 'computer' */
  get formFactor() {
    return this._ff;
  }

  /** True when the headphone bus reaches an output (every mode but 'single'). */
  get headphonesRouted() {
    return this._mode !== 'single';
  }

  /** Hint for the PFL buttons in single mode, else null. */
  get hint() {
    return this._mode === 'single' ? SINGLE_HINT : null;
  }

  get masterDeviceId() {
    return this.settings.get('masterDeviceId') || 'default';
  }

  get cueDeviceId() {
    return this.settings.get('cueDeviceId') || '';
  }

  get alignmentMs() {
    return alignmentDelays(this.settings.get('alignmentMs')).ms;
  }

  get splitSwap() {
    return !!this.settings.get('splitSwap');
  }

  get remoteBus() {
    return this.settings.get('remoteBus') === 'master' ? 'master' : 'cue';
  }

  /** Chip text: 'Phone speaker' | 'Tablet speaker' | 'Speakers' | 'Speaker + Headphones' | 'Split cable' | 'Second device' */
  describe() {
    return describeRouting(this._mode, { formFactor: this._ff });
  }

  // ------------------------------------------------------------------------------------------------ modes

  /**
   * Switch the output mode (call from a click: dual mode starts its outputs inside the gesture). On failure the
   * router falls back to 'single' and emits 'error'. Never rejects.
   * @param {'single'|'dual'|'split'|'remote'} mode
   */
  setMode(mode, opts = {}) {
    if (this._disposed) return Promise.resolve();
    if (!MODES.includes(mode)) {
      console.warn(`[TwinSpin] unknown output mode "${mode}"`);
      return Promise.resolve();
    }
    if (this._restoreMode !== null) {
      // the first explicit call replaces the pending start-up restore
      const restoring = this._restoreMode === mode;
      clearTimeout(this._restoreTimer);
      this._restoreTimer = null;
      this._restoreMode = null;
      if (restoring && !opts.restoring) {
        if (mode === 'remote') {
          this._restore(mode);
          return this._pending || Promise.resolve();
        }
        opts = { ...opts, restoring: true };
      }
    }
    if (this._pending && this._pendingMode === mode) return this._pending;
    if (!this._pending && mode === this._mode && !opts.force) return Promise.resolve();
    const gen = ++this._gen;
    const p = this._apply(mode, gen, !!opts.restoring);
    this._pending = p;
    this._pendingMode = mode;
    const clear = () => {
      if (this._pending === p) {
        this._pending = null;
        this._pendingMode = null;
      }
    };
    p.then(clear, clear);
    return p;
  }

  async _apply(mode, gen, restoring) {
    try {
      const check = this._modes[mode];
      if (!check.ok) {
        this._fallback(check.reason, gen, restoring);
        return;
      }
      let sinks = null;
      if (mode === 'dual') {
        const problem = this._dualProblem();
        if (problem) {
          this._fallback(restoring ? MSG.restoreDual : problem, gen, restoring);
          return;
        }
        sinks = this._startDualSinks(); // synchronous part runs inside the caller's click
      }
      // settle into a value right away, so a quick rejection is never reported as unhandled during the fade
      const sinkError = sinks ? sinks.then(() => null, (err) => err || makeErr('Error')) : null;
      await this._fadeOut();
      if (gen !== this._gen) return;
      if (sinkError) {
        const err = await sinkError;
        if (gen !== this._gen) return;
        if (err) {
          this._fallback(restoring ? MSG.restoreDual : friendlySinkError(err, err.role), gen, restoring);
          return;
        }
      }
      const prev = this._mode;
      this._mode = mode;
      this._wire();
      this._releaseDual(); // idempotent: pauses unused hidden outputs, resets the context sink outside dual
      this._applyAlignment();
      this._fadeIn();
      this._persistMode(mode);
      if (prev === 'remote' && mode !== 'remote') this._stopRemoteHost();
      this.emit('change', 'mode');
    } catch (err) {
      console.error('[TwinSpin] output switch failed', err);
      if (gen === this._gen) this._fallback(friendlySinkError(err, err && err.role), gen);
    }
  }

  _restore(mode) {
    if (mode === 'remote') {
      const host = peekSharedHost();
      if (this._modes.remote.ok && host && host.active) {
        // engine restart while sharing: keep sharing, with the new context's stream
        this.setMode('remote', { restoring: true }).then(() => {
          if (this._mode === 'remote' && host.active) host.start(this.getRemoteStream());
        });
        return;
      }
      setTimeout(() => {
        if (this._disposed || this._mode !== 'single') return;
        this._persistMode('single');
        this.emit('error', MSG.restoreRemote);
      }, 0);
      return;
    }
    this.setMode(mode, { restoring: true });
  }

  _persistMode(mode) {
    quiet(() => this.settings.set('outputMode', mode));
  }

  /**
   * Back to 'single' and tell the user. `defer` (start-up restore): the message goes out one task later, after
   * the engine's 'ready' (it awaits setMode before emitting it), when the UI listens.
   */
  _fallback(message, gen, defer = false) {
    if (gen !== undefined && gen !== this._gen) return;
    const prev = this._mode;
    this._mode = 'single';
    this._wire();
    this._releaseDual();
    this._applyAlignment();
    this._fadeIn();
    this._persistMode('single');
    if (prev === 'remote') this._stopRemoteHost();
    this.emit('change', 'mode');
    if (!message) return;
    if (defer) {
      setTimeout(() => {
        if (!this._disposed) this.emit('error', message);
      }, 0);
    } else {
      this.emit('error', message);
    }
  }

  _stopRemoteHost() {
    const host = peekSharedHost();
    if (host && host.active) host.stop();
  }

  // ------------------------------------------------------------------------------------------------ wiring

  _connectTap(tap, target, input = 0) {
    const cur = this._tapTo.get(tap);
    if (cur.to === target && cur.input === input) return;
    quiet(() => tap.disconnect());
    cur.to = null;
    if (target) {
      tap.connect(target, 0, input);
      cur.to = target;
      cur.input = input;
    }
  }

  _ensureMerger() {
    if (!this._merger) this._merger = this.ctx.createChannelMerger(2);
    return this._merger;
  }

  _wire() {
    const m = this._mode;
    const t = this._t;
    const d = this.ctx.destination;
    const viaEl = m === 'dual' && this._masterVia === 'el' && !!this._els.master;
    const sides = splitSides(this.splitSwap);
    this._connectTap(t.mDest, m === 'single' || m === 'remote' || (m === 'dual' && !viaEl) ? d : null);
    this._connectTap(t.cDest, m === 'remote' ? d : null);
    const merger = m === 'split' ? this._ensureMerger() : null;
    this._connectTap(t.mSplit, merger, sides.master);
    this._connectTap(t.cSplit, merger, sides.cue);
    if (this._merger && this._mergerOn !== !!merger) {
      quiet(() => (merger ? this._merger.connect(d) : this._merger.disconnect()));
      this._mergerOn = !!merger;
    }
    this._connectTap(t.mEl, viaEl ? this._els.master.dest : null);
    this._connectTap(t.cEl, m === 'dual' && this._els.cue ? this._els.cue.dest : null);
    const rd = m === 'remote' ? this._ensureRemote() : null;
    this._connectTap(t.mRemote, rd ? rd.dest : null);
    this._connectTap(t.cRemote, rd ? rd.dest : null);
    this._applyBusGains(true);
  }

  /** Set an AudioParam now (immediate) or glide to it (15 ms time constant). */
  _setParam(param, v, immediate) {
    try {
      const now = this.ctx.currentTime;
      param.cancelScheduledValues(now);
      if (immediate) param.setValueAtTime(v, now);
      else param.setTargetAtTime(v, now, 0.015);
    } catch {
      param.value = v;
    }
  }

  _applyBusGains(immediate) {
    const t = this._t;
    const remoteCue = this.remoteBus === 'cue';
    const remote = this._mode === 'remote';
    this._setParam(t.mDest.gain, remote && !remoteCue ? 0 : 1, immediate);
    this._setParam(t.cDest.gain, remote && !remoteCue ? 1 : 0, immediate);
    this._setParam(t.mRemote.gain, remoteCue ? 0 : 1, immediate);
    this._setParam(t.cRemote.gain, remoteCue ? 1 : 0, immediate);
  }

  _ramp(param, v, dur) {
    try {
      const now = this.ctx.currentTime;
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(v, now + dur);
    } catch {
      param.value = v;
    }
  }

  _fadeOut() {
    this._ramp(this._masterIn.gain, 0, FADE_S);
    this._ramp(this._cueIn.gain, 0, FADE_S);
    if (this.ctx.state !== 'running') return Promise.resolve();
    return new Promise((r) => setTimeout(r, FADE_WAIT_MS));
  }

  _fadeIn() {
    this._ramp(this._masterIn.gain, 1, 0.02);
    this._ramp(this._cueIn.gain, 1, 0.02);
  }

  _applyAlignment() {
    const a = this._mode === 'dual' ? alignmentDelays(this.settings.get('alignmentMs')) : { master: 0, cue: 0 };
    // a short glide (a tiny pitch bend) instead of a click
    for (const [node, v] of [[this._masterDelay, a.master], [this._cueDelay, a.cue]]) {
      try {
        const now = this.ctx.currentTime;
        node.delayTime.cancelScheduledValues(now);
        node.delayTime.setTargetAtTime(v, now, 0.03);
      } catch {
        node.delayTime.value = v;
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ dual mode

  _dualProblem() {
    const cue = this.cueDeviceId;
    if (!cue) return MSG.chooseCue;
    if (sameOutput(this.masterDeviceId, cue, this._devices)) return MSG.same;
    return null;
  }

  _ensureEl(role) {
    if (this._els[role]) return this._els[role];
    const doc = this._doc;
    if (!doc || typeof doc.createElement !== 'function' || typeof this.ctx.createMediaStreamDestination !== 'function') {
      return null;
    }
    const dest = this.ctx.createMediaStreamDestination();
    quiet(() => {
      dest.channelCount = 2;
      dest.channelCountMode = 'explicit';
    });
    const el = doc.createElement('audio');
    try {
      el.setAttribute('playsinline', '');
      el.setAttribute('aria-hidden', 'true');
      el.setAttribute('data-twinspin-output', role);
      el.autoplay = false;
      el.muted = false;
      if (el.style) el.style.display = 'none';
      el.srcObject = dest.stream;
    } catch {
      return null;
    }
    quiet(() => (doc.body || doc.documentElement).appendChild(el)); // plays detached too
    return (this._els[role] = { el, dest });
  }

  /** Start one hidden <audio> on `sink` ('' = system default). The play() call happens synchronously. */
  _routeEl(role, sink) {
    const rec = this._ensureEl(role);
    if (!rec) return Promise.reject(tagRole(makeErr('NotSupportedError'), role));
    const el = rec.el;
    const playP = safePlay(el);
    let sinkP;
    if (typeof el.setSinkId !== 'function') {
      sinkP = Promise.reject(makeErr('NotSupportedError'));
    } else if ((el.sinkId || '') === sink) {
      sinkP = Promise.resolve();
    } else if (this._env.safari && this._md && typeof this._md.enumerateDevices === 'function') {
      // Safari: the id must have been exposed by enumerateDevices in this document; the click's gesture token
      // carries through enumerateDevices' resolution (verify-routing.md)
      sinkP = promised(() => this._md.enumerateDevices()).then(() => el.setSinkId(sink));
    } else {
      sinkP = promised(() => el.setSinkId(sink));
    }
    return withTimeout(Promise.all([sinkP, playP]), SINK_TIMEOUT_MS).catch((e) => {
      throw tagRole(e, role);
    });
  }

  _setCtxSink(sink) {
    const cur = typeof this.ctx.sinkId === 'string' ? this.ctx.sinkId : '';
    if (cur === sink) return Promise.resolve();
    return withTimeout(promised(() => this.ctx.setSinkId(sink)), SINK_TIMEOUT_MS).catch((e) => {
      throw tagRole(e, 'master');
    });
  }

  _useCtxSink() {
    return !!this._env.ctxSetSinkId && typeof this.ctx.setSinkId === 'function';
  }

  _startDualSinks() {
    const masterSink = sinkIdOf(this.masterDeviceId);
    const cueSink = sinkIdOf(this.cueDeviceId);
    const jobs = [this._routeEl('cue', cueSink)];
    if (this._useCtxSink()) {
      this._masterVia = 'ctx';
      jobs.push(this._setCtxSink(masterSink));
    } else if (masterSink) {
      this._masterVia = 'el';
      jobs.push(this._routeEl('master', masterSink));
    } else {
      this._masterVia = 'dest';
    }
    return Promise.all(jobs);
  }

  _routeMaster(sink) {
    if (this._useCtxSink()) {
      return this._setCtxSink(sink).then(() => {
        this._masterVia = 'ctx';
      });
    }
    if (sink) {
      return this._routeEl('master', sink).then(() => {
        this._masterVia = 'el';
      });
    }
    this._masterVia = 'dest';
    return Promise.resolve();
  }

  _pauseUnused() {
    const m = this._els.master;
    const c = this._els.cue;
    if (m && !(this._mode === 'dual' && this._masterVia === 'el')) quiet(() => m.el.pause());
    if (c && this._mode !== 'dual') quiet(() => c.el.pause());
  }

  /** Outside dual mode: pause the hidden outputs and put the context back on the system default output. */
  _releaseDual() {
    this._pauseUnused();
    if (this._mode !== 'dual') {
      const cur = typeof this.ctx.sinkId === 'string' ? this.ctx.sinkId : '';
      if (cur && typeof this.ctx.setSinkId === 'function') promised(() => this.ctx.setSinkId('')).catch(() => {});
      this._masterVia = 'dest';
    }
  }

  // ------------------------------------------------------------------------------------------------ devices

  /** True once the browser shows real output names (permission granted or Firefox picks). */
  hasDeviceAccess() {
    return this._access;
  }

  /**
   * What the speaker-list unlock does on this browser, for the Outputs sheet to explain BEFORE the user taps.
   * @returns {{ needed: boolean, method: 'pick'|'mic'|'none', label: string, text: string }}
   */
  accessInfo() {
    if (!this._modes.dual.ok) return { needed: false, method: 'none', label: UNLOCK_LABEL, text: this._modes.dual.reason };
    if (this._env.selectAudioOutput) {
      return {
        needed: !this._access, method: 'pick', label: UNLOCK_LABEL,
        text: 'Firefox asks you to pick each output in its own window: one for the speaker, one for the headphones.',
      };
    }
    const again = this._env.safari ? ' Safari asks again each time you open TwinSpin.' : '';
    return {
      needed: !this._access, method: 'mic', label: UNLOCK_LABEL,
      text: 'Your browser only shows speaker names after you allow the microphone. TwinSpin never records: it asks '
        + 'once and turns the microphone off right away. A Bluetooth headset may blip for a second.' + again,
    };
  }

  /**
   * Unlock the output list (desktop only; call from a click). Firefox: opens its output picker and assigns the pick
   * to `role`. Others: getUserMedia({audio}) and stop the tracks immediately, then re-list.
   * @param {'master'|'cue'} role
   * @returns {Promise<boolean>} true when outputs are now visible (or the Firefox pick worked)
   */
  requestDeviceAccess(role = 'cue') {
    const r = role === 'master' ? 'master' : 'cue';
    const dual = this._modes.dual;
    if (!dual.ok) {
      this.emit('error', dual.reason);
      return Promise.resolve(false);
    }
    const md = this._md;
    if (md && this._env.selectAudioOutput && typeof md.selectAudioOutput === 'function') {
      return promised(() => md.selectAudioOutput()).then(async (info) => {
        if (!info || !info.deviceId) return false;
        this._granted.set(info.deviceId, {
          kind: 'audiooutput', deviceId: info.deviceId, label: info.label || '', groupId: info.groupId || '',
        });
        this._access = true;
        await this.listOutputs();
        await this._setDevice(r, info.deviceId);
        this.emit('change', 'access');
        return true;
      }, (err) => {
        const name = (err && err.name) || '';
        if (name === 'NotAllowedError' || name === 'AbortError') return false; // the user closed the picker
        this.emit('error', name === 'InvalidStateError' ? MSG.pickAgain : friendlySinkError(err, r));
        return false;
      });
    }
    if (!md || !this._env.getUserMedia || typeof md.getUserMedia !== 'function') {
      this.emit('error', MSG.noAccessApi);
      return Promise.resolve(false);
    }
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    return promised(() => md.getUserMedia({ audio })).then((stream) => {
      stopStream(stream); // release the mic at once (Bluetooth headsets drop to call quality while it is open)
      return this.listOutputs();
    }).then(() => {
      if (!this._access) {
        this.emit('error', MSG.noLabels);
        return false;
      }
      this.emit('change', 'access');
      return true;
    }, (err) => {
      this.emit('error', friendlyAccessError(err));
      return false;
    });
  }

  /**
   * The outputs worth showing: deduped, 'System default' first, each with a warning hint or null.
   * @returns {Promise<Array<{ deviceId: string, label: string, hint: string|null }>>}
   */
  async listOutputs() {
    const md = this._md;
    let raw = null;
    if (md && typeof md.enumerateDevices === 'function') {
      // Firefox resolves only while the page has focus: time out instead of hanging
      raw = await withTimeout(promised(() => md.enumerateDevices()), ENUM_TIMEOUT_MS).catch(() => null);
    }
    if (!Array.isArray(raw)) {
      return this._outputs ? this._outputs.slice() : [{ deviceId: 'default', label: 'System default', hint: null }];
    }
    const outs = raw.filter((d) => d && d.kind === 'audiooutput');
    for (const g of this._granted.values()) {
      if (!outs.some((o) => o.deviceId === g.deviceId)) outs.push(g);
    }
    const had = this._access;
    this._access = outs.some((d) => d.deviceId && d.label);
    const list = dedupeOutputs(outs);
    if (!list.some((d) => d.deviceId === 'default')) list.unshift({ deviceId: 'default', label: 'System default', groupId: '' });
    this._devices = list;
    this._outputs = list.map((d) => ({ deviceId: d.deviceId, label: d.label, hint: deviceLabelHint(d.label) }));
    if (had !== this._access) this.emit('change', 'access');
    return this._outputs.slice();
  }

  /** Choose the speaker output (call from a click in Safari). 'default' = system default. */
  setMasterDevice(id) {
    return this._setDevice('master', id);
  }

  /** Choose the headphones output (call from a click in Safari). */
  setCueDevice(id) {
    return this._setDevice('cue', id);
  }

  _setDevice(role, id) {
    const key = role === 'master' ? 'masterDeviceId' : 'cueDeviceId';
    const value = id ? String(id) : role === 'master' ? 'default' : '';
    if (this._mode !== 'dual') {
      this.settings.set(key, value);
      this.emit('change', 'devices');
      return Promise.resolve();
    }
    const other = role === 'master' ? this.cueDeviceId : this.masterDeviceId;
    if (!value) {
      this.emit('error', MSG.chooseCue);
      return Promise.resolve();
    }
    if (other && sameOutput(value, other, this._devices)) {
      this.emit('error', MSG.same);
      return Promise.resolve();
    }
    const gen = this._gen;
    const job = role === 'cue' ? this._routeEl('cue', sinkIdOf(value)) : this._routeMaster(sinkIdOf(value));
    return job.then(() => {
      this.settings.set(key, value);
      if (this._mode === 'dual' && gen === this._gen) {
        this._wire();
        this._pauseUnused();
      }
      this.emit('change', 'devices');
    }, (err) => {
      this.emit('error', friendlySinkError(err, role));
    });
  }

  async _deviceChanged() {
    this._outputs = null;
    if (this._mode !== 'dual' || !this._md) {
      this.emit('change', 'outputs');
      return;
    }
    const raw = await withTimeout(promised(() => this._md.enumerateDevices()), ENUM_TIMEOUT_MS).catch(() => null);
    if (this._disposed || this._mode !== 'dual' || !Array.isArray(raw)) return;
    const outs = raw.filter((d) => d && d.kind === 'audiooutput');
    if (!outs.some((d) => d.deviceId && d.label)) {
      this.emit('change', 'outputs'); // names hidden: can't tell what vanished
      return;
    }
    const ids = new Set(outs.map((d) => d.deviceId));
    const cue = this.cueDeviceId;
    const master = this.masterDeviceId;
    const lostCue = !!cue && cue !== 'default' && !ids.has(cue);
    const lostMaster = master !== 'default' && !ids.has(master);
    if (lostCue || lostMaster) {
      this._gen++;
      this._fallback(lostCue ? MSG.lostCue : MSG.lostMaster);
    } else {
      this.emit('change', 'outputs');
    }
  }

  // ------------------------------------------------------------------------------------------------ settings

  /** Signed output alignment for two outputs: +ms delays the speaker, -ms the headphones (-300..300). */
  setAlignmentMs(ms) {
    const a = alignmentDelays(ms);
    this.settings.set('alignmentMs', a.ms);
    this._applyAlignment();
    this.emit('change', 'alignment');
  }

  /** Split cable: false = speaker LEFT / headphones RIGHT, true = swapped. */
  setSplitSwap(on) {
    this.settings.set('splitSwap', !!on);
    this.emit('change', 'splitSwap');
    if (this._mode !== 'split') return Promise.resolve();
    const gen = this._gen;
    return this._fadeOut().then(() => {
      if (gen !== this._gen || this._mode !== 'split') return;
      this._wire();
      this._fadeIn();
    });
  }

  /**
   * Which bus the second device plays ('cue' = headphones, the default; 'master' = speaker); this device plays the
   * other one. A gain switch, no renegotiation.
   */
  setRemoteBus(which) {
    this.settings.set('remoteBus', which === 'master' ? 'master' : 'cue');
    this._applyBusGains(false);
    this.emit('change', 'remoteBus');
  }

  _ensureRemote() {
    if (this._remote) return this._remote;
    if (typeof this.ctx.createMediaStreamDestination !== 'function') return null;
    const dest = this.ctx.createMediaStreamDestination();
    quiet(() => {
      dest.channelCount = 2;
      dest.channelCountMode = 'explicit';
      dest.channelInterpretation = 'speakers';
    });
    quiet(() => dest.stream.getAudioTracks().forEach((tr) => {
      if ('contentHint' in tr) tr.contentHint = 'music';
    }));
    return (this._remote = { dest });
  }

  /** Stereo MediaStream for the second device, fed by both buses through gains (see setRemoteBus). */
  getRemoteStream() {
    const r = this._ensureRemote();
    return r ? r.dest.stream : null;
  }

  // ------------------------------------------------------------------------------------------------ test tones

  /**
   * Play an identifying beep on one output: speaker = two short high beeps, headphones = one low long beep.
   * Resolves when it has finished.
   * @param {'master'|'cue'} which
   */
  test(which = 'master') {
    const role = which === 'cue' ? 'cue' : 'master';
    if (role === 'cue' && this._mode === 'single') {
      this.emit('error', MSG.noCueOutput);
      return Promise.resolve();
    }
    const ctx = this.ctx;
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') promised(() => ctx.resume()).catch(() => {});
    const target = role === 'cue' ? this._cueIn : this._masterIn;
    const pattern = role === 'cue' ? [[0, 0.55, 392]] : [[0, 0.09, 1320], [0.17, 0.09, 1320]];
    const t0 = ctx.currentTime + 0.05;
    let end = 0;
    for (const [at, dur, freq] of pattern) {
      try {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const s = t0 + at;
        const e = s + dur;
        g.gain.value = 0;
        g.gain.setValueAtTime(0, s);
        g.gain.linearRampToValueAtTime(BEEP_LEVEL, s + 0.006);
        g.gain.setValueAtTime(BEEP_LEVEL, e - 0.012);
        g.gain.linearRampToValueAtTime(0, e);
        osc.connect(g);
        g.connect(target);
        osc.onended = () => quiet(() => {
          osc.disconnect();
          g.disconnect();
        });
        osc.start(s);
        osc.stop(e + 0.02);
      } catch (err) {
        console.warn('[TwinSpin] test tone failed', err);
      }
      end = Math.max(end, at + dur);
    }
    return new Promise((r) => setTimeout(r, Math.round((end + 0.15) * 1000)));
  }

  // ------------------------------------------------------------------------------------------------ teardown

  /** Disconnect everything this router made (the engine calls it before closing the context). */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._gen++;
    clearTimeout(this._restoreTimer);
    if (this._md && typeof this._md.removeEventListener === 'function') {
      this._md.removeEventListener('devicechange', this._onDeviceChange);
    }
    for (const r of [this._els.master, this._els.cue]) {
      if (!r) continue;
      quiet(() => {
        r.el.pause();
        r.el.srcObject = null;
        r.el.remove();
      });
    }
    const nodes = [this._masterIn, this._cueIn, this._masterDelay, this._cueDelay, this._merger, ...Object.values(this._t)];
    for (const n of nodes) if (n) quiet(() => n.disconnect());
    // the context is usually closing anyway; selective disconnect keeps the mixer's meters intact otherwise
    quiet(() => this.mixer.masterOut.disconnect(this._masterIn));
    quiet(() => this.mixer.cueOut.disconnect(this._cueIn));
  }
}
