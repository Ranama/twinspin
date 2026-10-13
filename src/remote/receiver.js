// The second-device page: plays the DJ's headphone (or speaker) mix sent over WebRTC by RemoteHost.
// src/main.js calls bootReceiver() instead of booting the DJ app when the URL has ?listen=CODE or #listen=CODE.
//
//   bootReceiver(document.getElementById('app'), { code: 'K7QF' });   // returns { stop() }
//
// One giant "Tap to listen" button. Its click handler, synchronously and before any await: sets
// navigator.audioSession.type = 'playback', unlocks the <audio playsinline> element by playing a silent clip (iOS
// lifts the media gesture rule for that element), and asks for a screen wake lock. Then it loads PeerJS, opens a
// DataConnection to 'twinspin-v1-' + CODE and answers the DJ's call receive-only, with stereo=1 added to the local
// answer (sdp.js); if the browser refuses the munged answer it asks for a new call and answers plainly (mono).
// No Web Audio here: the stream plays through the <audio> element (volume = the device's buttons).
// A watchdog (every 2 s) re-opens the link, asks for new calls and re-plays after interruptions. Delay and level
// come from getStats / getSynchronizationSources. Styles: css/remote.css (.rx-*).

import { env } from '../core/env.js';
import {
  loadPeerJs, openPeer, normalizeCode, hostIdFor, makeListenerId, isListenerId, peerOptions, toRemoteError,
  destroyPeer, closeQuietly, MESSAGES, CODE_LENGTH,
} from './peer.js';
import { addOpusStereo, hasOpusStereo } from './sdp.js';

const ID_KEY = 'twinspin.listener.id';
const HELP_TEXT = 'The 4 characters shown on the DJ\'s screen under Second device.';
const T = Object.freeze({
  watchMs: 2000,
  statsMs: 1000,
  levelMs: 100,
  sendMs: 2000,
  dcRetryMs: 9000,        // re-open the control link when it did not open (ICE can take a while)
  waitRetryMs: 5000,      // ...while the DJ is not sharing (peer-unavailable)
  recallMs: 4000,         // ask for a new call when none is playing
  streamWaitMs: 8000,     // call answered but no stream yet -> ask again
  silentMs: 7000,         // no bytes for this long while live -> reconnect
  hostSilentMs: 16000,    // no heartbeat from the DJ -> re-open the link
  signalRetryMs: 4000,    // re-register with the signalling server
});

const STATES = {
  idle: { title: 'Listen to the DJ', go: 'Tap to listen' },
  loading: { title: 'Getting ready…', detail: 'Loading the connection helper.', stop: 'Cancel' },
  connecting: { title: 'Connecting…', detail: 'Finding the DJ\'s device.', stop: 'Cancel' },
  waiting: { title: 'Waiting for the DJ', stop: 'Stop' },
  linking: { title: 'Linking up…', detail: 'Setting up the sound link.', stop: 'Stop' },
  live: { title: 'Listening', stop: 'Stop listening' },
  'needs-tap': { title: 'Tap to start the sound', detail: 'The browser needs one more tap before it plays sound.', go: 'Start sound', stop: 'Stop' },
  reconnecting: { title: 'Reconnecting…', detail: 'The link dropped. Trying again by itself.', stop: 'Stop' },
  unreachable: { title: 'Can\'t reach the DJ device', detail: MESSAGES.unreachable + ' Guest Wi-Fi often blocks this. Still trying…', stop: 'Stop' },
  ended: { title: 'The DJ stopped sharing', detail: 'This page reconnects by itself when the DJ shares again.', stop: 'Stop' },
  busy: { title: 'Someone else is listening', detail: 'Only one device can listen. Ask the DJ to disconnect the other one or make a new code.', go: 'Try again' },
  kicked: { title: 'Disconnected by the DJ', detail: 'The DJ disconnected this device. Ask for the new code to listen again.', go: 'Try again' },
  newcode: { title: 'The DJ made a new code', detail: 'Type the new code from the DJ\'s screen, or scan its QR code.', go: 'Tap to listen' },
  error: { title: 'Couldn\'t connect', go: 'Try again' },
};
const ACTIVE = new Set(['loading', 'connecting', 'waiting', 'linking', 'live', 'needs-tap', 'reconnecting', 'unreachable', 'ended']);

function now() {
  return Date.now();
}

/** A short silent WAV as a data: URI (8 kHz, 8-bit mono): played inside the tap to unlock the element on iOS. */
export function silentWavUri(seconds = 0.25, rate = 8000) {
  const n = Math.max(1, Math.round(seconds * rate));
  const bytes = new Uint8Array(44 + n);
  const dv = new DataView(bytes.buffer);
  const str = (o, s) => {
    for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i);
  };
  str(0, 'RIFF');
  dv.setUint32(4, 36 + n, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate, true);
  dv.setUint16(32, 1, true);
  dv.setUint16(34, 8, true);
  str(36, 'data');
  dv.setUint32(40, n, true);
  bytes.fill(128, 44);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return 'data:audio/wav;base64,' + btoa(bin);
}

/** Human delay text: 'About 0.4 s behind the DJ'. */
export function delayText(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 150) return 'Less than 0.2 s behind the DJ';
  return `About ${(Math.round(ms / 100) / 10).toFixed(1)} s behind the DJ`;
}

/**
 * Check (two local RTCPeerConnections) whether this browser accepts stereo=1 in a local answer. Resolves true when
 * it works or can't be told within the timeout (the 'webrtc' error fallback still covers a refusal).
 */
function stereoMungeWorks(timeoutMs = 3000) {
  const PC = globalThis.RTCPeerConnection;
  if (typeof PC !== 'function') return Promise.resolve(false);
  let a = null;
  let b = null;
  const run = (async () => {
    a = new PC();
    b = new PC();
    a.addTransceiver('audio', { direction: 'sendonly' });
    const offer = await a.createOffer();
    await a.setLocalDescription(offer);
    await b.setRemoteDescription(offer);
    const answer = await b.createAnswer();
    const sdp = addOpusStereo(answer.sdp);
    if (!hasOpusStereo(sdp)) return true;
    await b.setLocalDescription({ type: 'answer', sdp });
    return true;
  })();
  const timeout = new Promise((r) => setTimeout(() => r(true), timeoutMs));
  return Promise.race([run.catch(() => false), timeout]).finally(() => {
    for (const pc of [a, b]) if (pc) quiet(() => pc.close());
  });
}

/** Run fn and swallow errors (storage, media and cleanup calls that may throw in odd contexts). */
function quiet(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function safePlay(audio) {
  try {
    const p = audio.play();
    return p && typeof p.then === 'function' ? p : Promise.resolve();
  } catch (e) {
    return Promise.reject(e);
  }
}

/** The listener id for this tab (sessionStorage: a reload keeps it, so the DJ sees the same device). */
function savedListenerId() {
  const v = quiet(() => globalThis.sessionStorage.getItem(ID_KEY));
  return isListenerId(v) ? v : rememberListenerId(makeListenerId());
}

function rememberListenerId(id) {
  quiet(() => globalThis.sessionStorage.setItem(ID_KEY, id));
  return id;
}

class Receiver {
  constructor(root, code) {
    this.root = root;
    this._code = normalizeCode(code);
    this._state = 'idle';
    this._detail = '';
    this._gen = 0;
    this._peer = null;
    this._dc = null;
    this._call = null;
    this._stream = null;
    this._stereo = true;
    this._mungeCheck = null;
    this._bus = 'cue';
    this._timers = [];
    this._wake = null;
    this._silent = null;
    this._delayMs = null;
    this._relay = false;
    this._level = 0;
    this._prevRx = null;
    this._lastBytesAt = 0;
    this._reset();
    this._build();
    this._render();
  }

  _reset() {
    this._dcAt = 0;
    this._dcOpenAt = 0;
    this._hostSeen = 0;
    this._callAt = 0;
    this._streamAt = 0;
    this._lastRecall = 0;
    this._recallBackoff = T.recallMs;
    this._signalAt = 0;
    this._lostSignalSince = 0;
    this._waiting = false;
    this._dcFails = 0;
  }

  // ------------------------------------------------------------------------------------------------ DOM

  _build() {
    const r = this.root;
    r.textContent = '';
    const page = el('div', 'rx');
    page.dataset.state = 'idle';
    const top = el('header', 'rx-top');
    const brand = el('div', 'rx-brand');
    brand.append(el('span', 'rx-logo'), el('span', 'rx-name', 'TwinSpin'));
    brand.firstChild.setAttribute('aria-hidden', 'true');
    top.append(brand, el('span', 'rx-tag', 'Second device'));

    const main = el('main', 'rx-main');
    const disc = el('div', 'rx-disc');
    disc.setAttribute('aria-hidden', 'true');
    disc.append(el('div', 'rx-disc-face'), el('div', 'rx-disc-label'));
    this.$title = el('h1', 'rx-title');
    this.$title.setAttribute('aria-live', 'polite');
    this.$detail = el('p', 'rx-detail');
    this.$meter = el('div', 'rx-meter');
    this.$meter.setAttribute('aria-hidden', 'true');
    this.$fill = el('div', 'rx-meter-fill');
    this.$meter.append(this.$fill);
    this.$delay = el('p', 'rx-delay');

    this.$form = el('form', 'rx-codeform');
    this.$form.setAttribute('novalidate', '');
    const label = el('label', 'rx-codelabel', 'Code from the DJ');
    label.htmlFor = 'rx-code';
    this.$code = el('input', 'rx-code');
    Object.assign(this.$code, { id: 'rx-code', type: 'text', maxLength: CODE_LENGTH + 2, autocomplete: 'off', spellcheck: false });
    this.$code.setAttribute('autocapitalize', 'characters');
    this.$code.setAttribute('autocorrect', 'off');
    this.$code.setAttribute('inputmode', 'text');
    this.$code.setAttribute('placeholder', 'K7QF');
    this.$code.setAttribute('aria-describedby', 'rx-code-help');
    this.$code.value = this._code || '';
    this.$codeHelp = el('p', 'rx-codehelp', HELP_TEXT);
    this.$codeHelp.id = 'rx-code-help';
    this.$form.append(label, this.$code, this.$codeHelp);

    this.$go = el('button', 'rx-go');
    this.$go.type = 'button';
    this.$stop = el('button', 'rx-stop');
    this.$stop.type = 'button';
    main.append(disc, this.$title, this.$detail, this.$meter, this.$delay, this.$form, this.$go, this.$stop);

    const notes = el('ul', 'rx-notes');
    this.$wakeNote = el('li', 'rx-note-wake', 'Keep this screen on: locking it stops the sound.');
    notes.append(this.$wakeNote, el('li', '', 'Use this device\'s volume buttons.'),
      el('li', '', 'Both devices on the same Wi-Fi or a phone hotspot. Guest Wi-Fi may block it.'));

    this.$audio = el('audio', 'rx-audio');
    this.$audio.setAttribute('playsinline', '');
    this.$audio.setAttribute('aria-hidden', 'true');
    page.append(top, main, notes, this.$audio);
    r.append(page);
    this.$page = page;

    this.$code.addEventListener('input', () => {
      const v = this.$code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
      if (v !== this.$code.value) this.$code.value = v;
      this.$code.classList.remove('rx-bad');
      this.$codeHelp.textContent = HELP_TEXT;
      this._render();
    });
    this.$form.addEventListener('submit', (e) => {
      e.preventDefault();
      this._onGo();
    });
    this.$go.addEventListener('click', () => this._onGo());
    this.$stop.addEventListener('click', () => this.stop());
    this._onVisibility = () => this._visibility();
    this._onPageHide = () => this._goodbye();
    document.addEventListener('visibilitychange', this._onVisibility);
    globalThis.addEventListener('pagehide', this._onPageHide);
    globalThis.addEventListener('pageshow', (e) => {
      // back from the back/forward cache: the link was closed on pagehide, start over with one tap
      if (e && e.persisted && ACTIVE.has(this._state)) this._setState('idle');
    });
    this.$audio.addEventListener('pause', () => {
      if (this._state === 'live' && !document.hidden) this._setState('needs-tap');
    });
  }

  _render() {
    const s = STATES[this._state] || STATES.idle;
    const p = this.$page;
    p.dataset.state = this._state;
    p.classList.toggle('rx-active', ACTIVE.has(this._state));
    this.$title.textContent = s.title;
    this.$detail.textContent = this._detailText(s);
    const typing = !ACTIVE.has(this._state);
    this.$form.hidden = !typing;
    const goLabel = s.go || '';
    this.$go.hidden = !goLabel;
    this.$go.textContent = goLabel;
    this.$go.disabled = typing && !normalizeCode(this.$code.value);
    this.$stop.hidden = !s.stop;
    this.$stop.textContent = s.stop || '';
    const live = this._state === 'live';
    this.$meter.hidden = !live;
    this.$delay.hidden = !(live && this._delayMs);
    this.$delay.textContent = live ? delayText(this._delayMs) + (this._relay ? ' (through a relay)' : '') : '';
  }

  _detailText(s) {
    if (this._state === 'idle') {
      return this._code
        ? 'Plays the DJ\'s sound on this device. Check the code, then tap the button.'
        : 'Plays the DJ\'s sound on this device. Type the code from the DJ\'s screen, then tap the button.';
    }
    if (this._state === 'waiting') {
      return `Code ${this._code}. Ask the DJ to open Outputs, choose Second device and tap Start sharing.`;
    }
    if (this._state === 'live') {
      return this._bus === 'master' ? 'Playing the DJ\'s speaker mix.' : 'Playing the DJ\'s headphone mix.';
    }
    if (this._state === 'error') return this._detail || MESSAGES.error;
    return s.detail || '';
  }

  _setState(state, detail = '') {
    this._state = state;
    this._detail = detail;
    this._render();
  }

  // ------------------------------------------------------------------------------------------------ actions

  _onGo() {
    if (this._state === 'needs-tap') {
      this._playNow(true);
      return;
    }
    if (ACTIVE.has(this._state)) return;
    const code = normalizeCode(this.$code.value);
    if (!code) {
      this.$code.classList.add('rx-bad');
      this.$codeHelp.textContent = 'Codes are 4 letters and digits, like K7QF (no 0, 1, I, L or O).';
      try { this.$code.focus(); } catch { /* ignore */ }
      return;
    }
    // --- inside the tap, before any await (iOS) ---
    quiet(() => {
      if (env.audioSession && navigator.audioSession) navigator.audioSession.type = 'playback';
    });
    this._unlockAudio();
    this._requestWake();
    // --- then the slow part ---
    this._start(code);
  }

  _unlockAudio() {
    const a = this.$audio;
    try {
      if (!this._silent) this._silent = silentWavUri();
      a.srcObject = null;
      a.loop = true;
      a.src = this._silent;
      safePlay(a).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  _requestWake() {
    const nav = globalThis.navigator;
    if (!nav || !nav.wakeLock || typeof nav.wakeLock.request !== 'function') {
      this.$wakeNote.classList.add('rx-warn');
      this.$wakeNote.textContent = 'Keep this screen on (turn off auto-lock while listening): locking it stops the sound.';
      return;
    }
    if (this._wake && !this._wake.released) return;
    try {
      nav.wakeLock.request('screen').then((s) => {
        this._wake = s;
        this.$wakeNote.classList.remove('rx-warn');
      }, () => {
        this.$wakeNote.classList.add('rx-warn');
      });
    } catch {
      /* ignore */
    }
  }

  _updateUrl(code) {
    try {
      const loc = globalThis.location;
      const url = `${loc.pathname}?listen=${encodeURIComponent(code)}`;
      if (loc.search !== `?listen=${code}` || loc.hash) globalThis.history.replaceState(null, '', url);
    } catch {
      /* sandboxed */
    }
  }

  async _start(code) {
    const gen = ++this._gen;
    this._code = code;
    this._updateUrl(code);
    this._reset();
    this._stereo = true;
    this._setState('loading');
    if (!env.webrtc || typeof globalThis.RTCPeerConnection !== 'function') {
      this._fail(MESSAGES.unsupported);
      return;
    }
    this._mungeCheck = this._mungeCheck || stereoMungeWorks();
    let Peer;
    try {
      Peer = await loadPeerJs();
    } catch (e) {
      if (gen === this._gen) this._fail(toRemoteError(e).message);
      return;
    }
    if (gen !== this._gen) return;
    this._stereo = await this._mungeCheck;
    if (gen !== this._gen) return;
    this._setState('connecting');
    this._Peer = Peer;
    const ok = await this._openPeer(gen);
    if (!ok || gen !== this._gen) return;
    this._connect();
    this._startTimers();
  }

  async _openPeer(gen) {
    let id = savedListenerId();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const peer = await openPeer(this._Peer, id, peerOptions());
        if (gen !== this._gen) {
          destroyPeer(peer);
          return false;
        }
        this._attachPeer(peer);
        return true;
      } catch (e) {
        if (gen !== this._gen) return false;
        const err = toRemoteError(e);
        if (err.code === 'unavailable-id') {
          id = rememberListenerId(makeListenerId());
          continue;
        }
        this._fail(err.message);
        return false;
      }
    }
    this._fail(MESSAGES.network);
    return false;
  }

  _attachPeer(peer) {
    this._peer = peer;
    peer.on('call', (call) => this._onCall(peer, call));
    peer.on('error', (e) => this._onPeerError(peer, e));
    peer.on('disconnected', () => {
      if (this._peer === peer && !this._lostSignalSince) this._lostSignalSince = now();
    });
    peer.on('open', () => {
      if (this._peer === peer) this._lostSignalSince = 0;
    });
  }

  _connect() {
    const peer = this._peer;
    if (!peer || peer.destroyed || peer.disconnected || !this._code) return;
    if (this._dc) {
      const old = this._dc;
      this._dc = null;
      if (!old.open && !this._waiting) {
        // the last attempt never opened (ICE stuck): after two of those, say why
        this._dcFails++;
        if (this._dcFails >= 2) this._linkFailed();
      }
      closeQuietly(old);
    }
    this._dcAt = now();
    let dc = null;
    try {
      dc = peer.connect(hostIdFor(this._code), {
        reliable: true, serialization: 'json', metadata: { app: 'twinspin', v: 1, role: 'listener' },
      });
    } catch {
      dc = null;
    }
    if (!dc) return;
    this._dc = dc;
    dc.on('open', () => {
      if (this._dc !== dc) return;
      this._dcOpenAt = now();
      this._hostSeen = now();
      this._waiting = false;
      this._dcFails = 0;
      if (['connecting', 'waiting', 'ended', 'reconnecting', 'unreachable'].includes(this._state) && !this._playing()) {
        this._setState('linking');
      }
      this._sendStats();
    });
    dc.on('data', (m) => this._onData(dc, m));
    const lost = () => {
      if (this._dc !== dc) return;
      this._dc = null;
      if (this._state === 'linking' || (this._state === 'live' && !this._playing())) this._setState('reconnecting');
    };
    dc.on('close', lost);
    dc.on('error', (e) => {
      // PeerJS reports a failed ICE check on the link itself as 'negotiation-failed' (then closes it)
      if (this._dc === dc && e && e.type === 'negotiation-failed') {
        this._dcFails++;
        this._linkFailed();
      }
      lost();
    });
  }

  /** The devices can't reach each other (ICE failed): say so, and retry more slowly. */
  _linkFailed() {
    this._recallBackoff = Math.min(20000, this._recallBackoff * 2);
    if (!this._playing()) this._setState('unreachable');
  }

  _onData(dc, m) {
    if (this._dc !== dc || !m || typeof m !== 'object') return;
    this._hostSeen = now();
    switch (m.t) {
      case 'hello':
      case 'info':
        if (m.bus === 'master' || m.bus === 'cue') this._bus = m.bus;
        this._render();
        break;
      case 'busy':
        this._halt('busy');
        break;
      case 'kicked':
        this._halt('kicked');
        break;
      case 'bye':
        if (m.reason === 'newcode') this._halt('newcode');
        else this._toEnded();
        break;
      default:
        break;
    }
  }

  _toEnded() {
    this._closeCall();
    const dc = this._dc;
    this._dc = null;
    closeQuietly(dc);
    this._waiting = true;
    this._dcAt = now();
    this._setState('ended');
  }

  _send(msg) {
    const dc = this._dc;
    if (dc && dc.open) quiet(() => dc.send(msg));
  }

  _askRecall() {
    this._lastRecall = now();
    this._send({ t: 'recall' });
  }

  _onCall(peer, call) {
    if (peer !== this._peer || !this._code || call.peer !== hostIdFor(this._code)) {
      closeQuietly(call);
      return;
    }
    if (this._call && this._call !== call) closeQuietly(this._call);
    this._call = call;
    this._callAt = now();
    this._streamAt = 0;
    this._prevRx = null;
    const stereo = this._stereo;
    try {
      call.answer(undefined, stereo ? { sdpTransform: (sdp) => addOpusStereo(sdp) } : {});
    } catch {
      this._stereo = false;
      this._askRecall();
      return;
    }
    call.on('stream', (stream) => this._onStream(call, stream));
    call.on('iceStateChanged', (s) => this._onIce(call, s));
    call.on('close', () => {
      if (this._call !== call) return;
      this._call = null;
      if (ACTIVE.has(this._state) && this._state !== 'ended' && this._state !== 'waiting') this._setState('reconnecting');
    });
    call.on('error', (e) => {
      if (this._call !== call) return;
      const type = (e && e.type) || '';
      if (type === 'negotiation-failed') this._unreachable();
    });
  }

  _onStream(call, stream) {
    if (this._call !== call) return;
    this._stream = stream;
    this._streamCall = call;
    this._streamAt = now();
    this._lastBytesAt = now();
    this._recallBackoff = T.recallMs;
    const a = this.$audio;
    quiet(() => {
      a.loop = false;
      a.srcObject = stream; // srcObject wins over the silent clip's src
      a.removeAttribute('src');
    });
    this._playNow(false);
  }

  _playNow(fromTap) {
    const a = this.$audio;
    if (fromTap) this._requestWake();
    safePlay(a).then(() => {
      if (this._current() && ACTIVE.has(this._state)) this._setState('live');
    }, (err) => {
      const name = (err && err.name) || '';
      if (name === 'NotAllowedError' && ACTIVE.has(this._state)) this._setState('needs-tap');
    });
  }

  _playing() {
    const a = this.$audio;
    return this._current() && !a.paused;
  }

  /** The attached stream belongs to the current call (an old call's stream is frozen, not live). */
  _current() {
    return !!(this._stream && this._call && this._streamCall === this._call && this.$audio.srcObject === this._stream);
  }

  _onIce(call, s) {
    if (this._call !== call) return;
    if (s === 'connected' || s === 'completed') {
      this._recallBackoff = T.recallMs;
      if (this._playing() && this._state !== 'live') this._setState('live');
    } else if (s === 'disconnected') {
      if (this._state === 'live') this._setState('reconnecting');
    } else if (s === 'failed') {
      this._unreachable();
    }
  }

  _unreachable() {
    this._closeCall();
    this._linkFailed();
  }

  _closeCall() {
    const c = this._call;
    this._call = null;
    closeQuietly(c);
  }

  _onPeerError(peer, e) {
    if (peer !== this._peer) return;
    const type = (e && e.type) || '';
    if (type === 'peer-unavailable') {
      // the DJ's code isn't registered (not sharing yet, stopped, or a typo)
      this._waiting = true;
      const dc = this._dc;
      this._dc = null;
      closeQuietly(dc);
      if (this._state !== 'ended' && !this._playing()) this._setState('waiting');
      return;
    }
    if (type === 'webrtc' && this._stereo) {
      // the browser refused the stereo answer: answer plainly from now on
      this._stereo = false;
      this._closeCall();
      this._askRecall();
      return;
    }
    if (type === 'browser-incompatible') this._fail(MESSAGES.unsupported);
    // network/server errors: the watchdog re-registers
  }

  _halt(state) {
    this._gen++;
    this._teardown(true);
    this._setState(state);
    if (state === 'newcode' || state === 'kicked') {
      this.$code.value = '';
      this._code = null;
    }
    this._render();
  }

  _fail(message) {
    this._gen++;
    this._teardown(true);
    this._setState('error', message);
  }

  // ------------------------------------------------------------------------------------------------ timers

  _startTimers() {
    this._clearTimers();
    this._timers.push(setInterval(() => this._watch(), T.watchMs));
    this._timers.push(setInterval(() => this._stats(), T.statsMs));
    this._timers.push(setInterval(() => this._levelTick(), T.levelMs));
    this._timers.push(setInterval(() => this._sendStats(), T.sendMs));
  }

  _clearTimers() {
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
  }

  _watch() {
    const peer = this._peer;
    if (!peer || !ACTIVE.has(this._state)) return;
    const t = now();
    if (peer.destroyed) {
      this._restartPeer();
      return;
    }
    if (peer.disconnected) {
      if (t - this._signalAt > T.signalRetryMs) {
        this._signalAt = t;
        try { peer.reconnect(); } catch { /* destroyed */ }
      }
      if (this._lostSignalSince && t - this._lostSignalSince > 45000 && !this._playing()) this._restartPeer();
      return;
    }
    const dcOpen = !!(this._dc && this._dc.open);
    if (!dcOpen) {
      const wait = this._waiting ? T.waitRetryMs : this._state === 'unreachable' ? this._recallBackoff : T.dcRetryMs;
      if (t - this._dcAt > wait) this._connect();
      return;
    }
    if (t - this._hostSeen > T.hostSilentMs) {
      this._connect(); // the DJ went quiet: open a fresh link
      return;
    }
    const callOk = this._call && this._call.open !== false;
    if (!callOk) {
      if (t - this._lastRecall > this._recallBackoff && t - this._dcOpenAt > 2500) this._askRecall();
    } else if (!this._streamAt && t - this._callAt > T.streamWaitMs && t - this._lastRecall > T.streamWaitMs) {
      this._askRecall();
    } else if (this._streamAt && t - this._lastBytesAt > T.silentMs && t - this._lastRecall > T.silentMs) {
      if (this._state === 'live') this._setState('reconnecting');
      this._askRecall();
    }
    const a = this.$audio;
    if (this._current() && a.paused && !document.hidden && this._state !== 'needs-tap') this._playNow(false);
  }

  async _restartPeer() {
    const gen = this._gen;
    const old = this._peer;
    this._peer = null;
    this._dc = null;
    this._closeCall();
    destroyPeer(old);
    this._lostSignalSince = 0;
    if (!this._Peer) return;
    const ok = await this._openPeer(gen);
    if (ok && gen === this._gen) this._connect();
  }

  async _stats() {
    const call = this._call;
    const pc = call && call.peerConnection;
    if (!pc || typeof pc.getStats !== 'function' || document.hidden) return;
    let report;
    try {
      report = await pc.getStats();
    } catch {
      return;
    }
    let rx = null;
    let pair = null;
    report.forEach((s) => {
      if (s.type === 'inbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio')) rx = s;
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId) || pair;
    });
    if (!pair) {
      report.forEach((s) => {
        if (!pair && s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) pair = s;
      });
    }
    if (!rx) return;
    const prev = this._prevRx;
    if (!prev || rx.bytesReceived > prev.bytesReceived) this._lastBytesAt = now();
    let jbMs = null;
    if (prev && rx.jitterBufferEmittedCount > prev.jitterBufferEmittedCount) {
      jbMs = (1000 * (rx.jitterBufferDelay - prev.jitterBufferDelay)) / (rx.jitterBufferEmittedCount - prev.jitterBufferEmittedCount);
    }
    this._prevRx = {
      bytesReceived: rx.bytesReceived || 0,
      jitterBufferDelay: rx.jitterBufferDelay || 0,
      jitterBufferEmittedCount: rx.jitterBufferEmittedCount || 0,
    };
    const rttMs = pair && pair.currentRoundTripTime ? pair.currentRoundTripTime * 1000 : null;
    if (pair) {
      const l = report.get(pair.localCandidateId);
      const r = report.get(pair.remoteCandidateId);
      this._relay = !!((l && l.candidateType === 'relay') || (r && r.candidateType === 'relay'));
    }
    if (jbMs != null && Number.isFinite(jbMs)) {
      const est = jbMs + (rttMs != null ? rttMs / 2 : 15) + 30 + 20; // + Opus/packet + output buffer
      this._delayMs = this._delayMs == null ? est : this._delayMs + 0.3 * (est - this._delayMs);
    }
    if (typeof rx.audioLevel === 'number' && !this._ssrcLevels) this._level = rx.audioLevel;
    if (this._state === 'live') this._render();
  }

  _levelTick() {
    if (document.hidden || this._state !== 'live') return;
    const pc = this._call && this._call.peerConnection;
    let level = null;
    try {
      const rcv = pc && pc.getReceivers ? pc.getReceivers().find((x) => x.track && x.track.kind === 'audio') : null;
      const src = rcv && typeof rcv.getSynchronizationSources === 'function' ? rcv.getSynchronizationSources() : [];
      if (src.length && typeof src[0].audioLevel === 'number') {
        level = src[0].audioLevel;
        this._ssrcLevels = true;
      }
    } catch {
      /* ignore */
    }
    if (level == null) level = this._level;
    // fast attack, slow release; shown on a -48..0 dB scale
    const db = level > 0 ? 20 * Math.log10(level) : -100;
    const target = Math.max(0, Math.min(1, (db + 48) / 48));
    const cur = this._shown || 0;
    this._shown = target > cur ? target : cur + (target - cur) * 0.15;
    this._level = level;
    this.$fill.style.transform = `scaleX(${this._shown.toFixed(3)})`;
    this.$page.style.setProperty('--rx-level', this._shown.toFixed(3));
  }

  _sendStats() {
    this._send({
      t: 'stats', delayMs: this._delayMs == null ? null : Math.round(this._delayMs), level: this._level || 0,
      relay: this._relay, live: this._state === 'live',
    });
  }

  _visibility() {
    if (document.hidden) return;
    if (ACTIVE.has(this._state)) {
      this._requestWake();
      if (this._current() && this.$audio.paused) this._playNow(false);
      this._watch();
    }
  }

  // ------------------------------------------------------------------------------------------------ teardown

  _goodbye() {
    this._send({ t: 'bye' });
    this._teardown(true);
  }

  _teardown(releaseWake) {
    this._clearTimers();
    const dc = this._dc;
    this._dc = null;
    this._closeCall();
    if (dc) setTimeout(() => closeQuietly(dc), 0);
    const peer = this._peer;
    this._peer = null;
    if (peer) setTimeout(() => destroyPeer(peer), 150);
    this._stream = null;
    this._delayMs = null;
    this._shown = 0;
    const a = this.$audio;
    quiet(() => {
      a.pause();
      a.srcObject = null;
      a.removeAttribute('src');
    });
    if (releaseWake && this._wake) {
      const wake = this._wake;
      this._wake = null;
      quiet(() => Promise.resolve(wake.release()).catch(() => {}));
    }
  }

  /** Stop listening and go back to the start screen. */
  stop() {
    this._gen++;
    this._send({ t: 'bye' });
    this._teardown(true);
    this._setState('idle');
  }
}

/**
 * Boot the second-device page into `root` (replaces its content).
 * @param {HTMLElement} root
 * @param {{ code?: string|null }} [opts]  code from ?listen=CODE / #listen=CODE (may be empty or invalid)
 * @returns {{ stop(): void }}
 */
export function bootReceiver(root, { code = null } = {}) {
  const host = root || document.body;
  quiet(() => {
    document.documentElement.classList.add('ts-rx');
    document.title = 'TwinSpin - Second device';
  });
  const rx = new Receiver(host, code);
  return { stop: () => rx.stop() };
}
