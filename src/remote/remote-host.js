// RemoteHost: the DJ side of "Second device". Registers 'twinspin-v1-' + CODE on the PeerJS server, waits for ONE
// listener (receiver.js) to open a JSON DataConnection, then CALLS it with the remote MediaStream (PeerJS needs the
// side that owns the stream to be the caller). Other listeners get a polite {t:'busy'}.
//
//   const host = sharedHost();                        // one per page; survives the Outputs sheet closing
//   host.on('change', render); host.on('error', toast);
//   await host.start(router.getRemoteStream());       // after router.setMode('remote'); from a click
//   host.code -> 'K7QF', host.state -> 'waiting' | 'connecting' | 'live', host.listener -> { state, delayMs, ... }
//   host.kick(); host.newCode(); host.stop();
//
// Protocol on the DataConnection (JSON objects with a `t` field):
//   host -> listener: {t:'hello', v:1} | {t:'hb'} every 4 s | {t:'busy'} | {t:'kicked'} | {t:'bye'} | {t:'pong', c}
//   listener -> host: {t:'stats', delayMs, level, relay, live} every 2 s | {t:'recall'} (re-call me, e.g. after a
//     failed ICE or without the stereo munge) | {t:'ping', c} | {t:'bye'}
// Robustness: signalling loss ('disconnected') -> peer.reconnect() after 2 s, live calls keep playing; a listener
// silent for 15 s is dropped; its control link may come back within 12 s without a new call; ICE 'failed' ->
// 'Can't reach the second device...' and the listener asks for a new call. Send bitrate: encodings[0].maxBitrate =
// 192 kbps (128 over a TURN relay), modified in place; encodings are never added.

import { Emitter } from '../core/emitter.js';
import { storageGet, storageSet } from '../core/util.js';
import {
  loadPeerJs, openPeer, takeEarly, makeCode, normalizeCode, hostIdFor, joinLink, peerOptions, toRemoteError,
  destroyPeer, closeQuietly, offEvent, MESSAGES,
} from './peer.js';

const CODE_KEY = 'twinspin.remote.code';
const CODE_MAX_AGE_MS = 12 * 3600 * 1000;

export const HOST_TIMING = Object.freeze({
  heartbeatMs: 4000,
  deadMs: 15000,         // no message from the listener for this long -> dropped
  graceMs: 12000,        // control link closed: wait this long for it to come back before dropping the listener
  reconnectMs: 2000,     // signalling lost -> reconnect after this
  reconnectGiveUpMs: 120000,
  busyCloseMs: 400,
  recallMinMs: 250,      // flood guard for {t:'recall'}
  idTries: 5,
});

export const SEND_BITRATE = 192000;
export const RELAY_BITRATE = 128000;

let shared = null;

/** The page-wide RemoteHost (created on first use). */
export function sharedHost() {
  if (!shared) shared = new RemoteHost();
  return shared;
}

/** The page-wide RemoteHost if one was created, else null (never creates one). */
export function peekSharedHost() {
  return shared;
}

function now() {
  return Date.now();
}

function safeSend(dc, msg) {
  try {
    if (dc && dc.open) {
      dc.send(msg);
      return true;
    }
  } catch {
    /* closed meanwhile */
  }
  return false;
}

/**
 * Raise the Opus send bitrate on a connected RTCPeerConnection: encodings[0].maxBitrate modified in place (the
 * WebRTC spec forbids changing the number of encodings; libwebrtc uses maxBitrate as the Opus target).
 * @returns {Promise<boolean>} true when applied
 */
export async function setSendBitrate(pc, bps) {
  try {
    const senders = pc && typeof pc.getSenders === 'function' ? pc.getSenders() : [];
    const s = senders.find((x) => x && x.track && x.track.kind === 'audio');
    if (!s || typeof s.getParameters !== 'function') return false;
    const p = s.getParameters();
    if (!p || !Array.isArray(p.encodings) || p.encodings.length === 0) return false;
    if (p.encodings[0].maxBitrate === bps) return true;
    p.encodings[0].maxBitrate = bps;
    await s.setParameters(p);
    return true;
  } catch {
    return false;
  }
}

/** Whether the selected ICE pair of a connection runs through a TURN relay. */
export async function usesRelay(pc) {
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId) || pair;
    });
    if (!pair) {
      stats.forEach((s) => {
        if (!pair && s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) pair = s;
      });
    }
    if (!pair) return false;
    const l = stats.get(pair.localCandidateId);
    const r = stats.get(pair.remoteCandidateId);
    return (l && l.candidateType === 'relay') || (r && r.candidateType === 'relay') || false;
  } catch {
    return false;
  }
}

function loadSavedCode() {
  const v = storageGet(CODE_KEY, null);
  if (!v || typeof v !== 'object') return null;
  const code = normalizeCode(v.code);
  if (!code || !(now() - Number(v.at) < CODE_MAX_AGE_MS)) return null;
  return code;
}

function saveCode(code) {
  storageSet(CODE_KEY, { code, at: now() });
}

export class RemoteHost extends Emitter {
  /**
   * @param {{ Peer?: Function, timing?: object, location?: object }} [opts]  Peer: PeerJS constructor (tests;
   *   default loads PeerJS lazily), timing: overrides for HOST_TIMING, location: for link()
   */
  constructor({ Peer = null, timing = {}, location = null } = {}) {
    super();
    this._Peer = Peer;
    this._t = { ...HOST_TIMING, ...timing };
    this._loc = location;
    this._peer = null;
    this._stream = null;
    this._code = null;
    this._state = 'idle';
    this._error = null;
    this._notice = null;
    this._signal = 'ok';          // 'ok' | 'reconnecting' | 'lost': link to the pairing server
    this._listener = null;        // internal record
    this._banned = new Set();
    this._gen = 0;
    this._starting = null;
    this._hbTimer = null;
    this._reconnectTimer = null;
    this._lostSince = 0;
    this._lastRecall = 0;
    this._bus = 'cue';           // which mix the listener plays (shown on its screen)
  }

  /** 'idle' | 'starting' | 'waiting' | 'connecting' | 'live' | 'error' */
  get state() {
    return this._state;
  }

  /** True while sharing (starting, waiting or connected). */
  get active() {
    return this._state !== 'idle' && this._state !== 'error';
  }

  /** The pairing code while sharing, else null. */
  get code() {
    return this._code;
  }

  /** The join link for the current code, or ''. */
  get link() {
    return this._code ? joinLink(this._code, this._loc || globalThis.location) : '';
  }

  /** Last start failure message (state 'error'), else null. */
  get error() {
    return this._error;
  }

  /** One-off information for the panel (e.g. the old code was taken), else null. */
  get notice() {
    return this._notice;
  }

  /** Pairing-server link: 'ok' | 'reconnecting' | 'lost' (a live listener keeps playing in every case). */
  get signal() {
    return this._signal;
  }

  /**
   * The connected listener or null: { id, state: 'connecting'|'live'|'reconnecting'|'unreachable', since,
   * delayMs: number|null, relay: boolean, level: number }.
   */
  get listener() {
    const L = this._listener;
    if (!L) return null;
    return Object.freeze({ id: L.id, state: L.state, since: L.since, delayMs: L.delayMs, relay: L.relay, level: L.level });
  }

  /**
   * Start sharing `stream` (call from a click; loads PeerJS and registers a code). When already sharing, swaps the
   * stream and calls the listener again (used after an audio engine restart).
   * @param {MediaStream} stream
   * @returns {Promise<void>} resolves when a code is ready (or the start failed: see state/error and 'error')
   */
  start(stream) {
    if (!stream) {
      this._emitError('Nothing to share yet. Start the audio first.');
      return Promise.resolve();
    }
    const swapped = this._stream && this._stream !== stream;
    this._stream = stream;
    if (this._peer && this.active) {
      if (swapped && this._listener && this._listener.dc && this._listener.dc.open) this._call();
      return this._starting || Promise.resolve();
    }
    if (this._starting) return this._starting;
    return this._run(false);
  }

  _run(fresh) {
    const p = this._open(fresh).finally(() => {
      if (this._starting === p) this._starting = null;
    });
    this._starting = p;
    return p;
  }

  /** Stop sharing: tells the listener, closes everything, frees the code. */
  stop() {
    this._gen++;
    this._starting = null;
    this._teardown({ t: 'bye' });
    this._code = null;
    this._error = null;
    this._notice = null;
    this._signal = 'ok';
    this._setState('idle');
  }

  /** Drop the current listener and register a fresh code (the old link stops working). */
  newCode() {
    if (!this._stream) return Promise.resolve();
    this._gen++;
    this._teardown({ t: 'bye', reason: 'newcode' });
    this._banned.clear();
    this._code = null;
    return this._run(true);
  }

  /** Tell the listener which mix it plays ('cue' = headphones, 'master' = speaker); shown on its screen. */
  setBus(bus) {
    this._bus = bus === 'master' ? 'master' : 'cue';
    const L = this._listener;
    if (L) safeSend(L.dc, { t: 'info', bus: this._bus });
  }

  /** Which mix the listener plays: 'cue' | 'master'. */
  get bus() {
    return this._bus;
  }

  /** Disconnect the current listener; that device can't reconnect with this code until a new code is made. */
  kick() {
    const L = this._listener;
    if (!L) return;
    this._banned.add(L.id);
    safeSend(L.dc, { t: 'kicked' });
    const dc = L.dc;
    this._dropListener();
    if (dc) setTimeout(() => closeQuietly(dc), this._t.busyCloseMs);
  }

  // ------------------------------------------------------------------------------------------------ internals

  _setState(s) {
    if (this._state !== s) this._state = s;
    this.emit('change');
  }

  _emitError(message) {
    this.emit('error', message);
  }

  _updateState() {
    if (!this._peer) return;
    const L = this._listener;
    this._setState(!L ? 'waiting' : L.state === 'live' ? 'live' : 'connecting');
  }

  async _open(fresh) {
    const gen = ++this._gen;
    this._error = null;
    this._notice = null;
    this._setState('starting');
    let Peer = this._Peer;
    try {
      if (!Peer) Peer = await loadPeerJs();
    } catch (e) {
      if (gen === this._gen) this._fail(toRemoteError(e));
      return;
    }
    if (gen !== this._gen) return;
    const saved = fresh ? null : loadSavedCode();
    let code = saved || makeCode();
    for (let attempt = 0; ; attempt++) {
      let peer;
      try {
        peer = await openPeer(Peer, hostIdFor(code), peerOptions());
      } catch (e) {
        if (gen !== this._gen) return;
        const err = toRemoteError(e);
        if (err.code === 'unavailable-id' && attempt < this._t.idTries) {
          if (code === saved) {
            this._notice = 'Your last code is still in use, so here is a new one. Scan it again on the second device.';
          }
          code = makeCode();
          continue;
        }
        this._fail(err);
        return;
      }
      if (gen !== this._gen) {
        destroyPeer(peer);
        return;
      }
      this._attach(peer, code);
      return;
    }
  }

  _fail(err) {
    this._teardown(null);
    this._code = null;
    this._error = err.message;
    this._setState('error');
    this._emitError(err.message);
  }

  _attach(peer, code) {
    this._peer = peer;
    this._code = code;
    this._signal = 'ok';
    saveCode(code);
    const h = {
      connection: (dc) => this._onConnection(peer, dc),
      disconnected: () => this._onSignalLost(peer),
      error: (e) => this._onPeerError(peer, e),
      call: (c) => closeQuietly(c), // the host never takes calls
      open: () => {
        if (this._peer !== peer) return;
        this._signal = 'ok';
        this._lostSince = 0;
        this.emit('change');
      },
      close: () => {
        if (this._peer !== peer || this._state === 'idle') return;
        // destroyed under us (should not happen): report and reset
        this._fail(new Error(MESSAGES.network));
      },
    };
    peer.__twinspinHandlers = h;
    for (const k of Object.keys(h)) peer.on(k, h[k]);
    for (const dc of takeEarly(peer)) this._onConnection(peer, dc);
    clearInterval(this._hbTimer);
    this._hbTimer = setInterval(() => this._heartbeat(), this._t.heartbeatMs);
    this._updateState();
  }

  _teardown(farewell) {
    clearInterval(this._hbTimer);
    clearTimeout(this._reconnectTimer);
    this._hbTimer = null;
    this._reconnectTimer = null;
    const L = this._listener;
    if (L) {
      if (farewell) safeSend(L.dc, farewell);
      const dc = L.dc;
      this._dropListener(true);
      if (dc) setTimeout(() => closeQuietly(dc), farewell ? this._t.busyCloseMs : 0);
    }
    const peer = this._peer;
    this._peer = null;
    if (peer) {
      const h = peer.__twinspinHandlers;
      if (h) for (const k of Object.keys(h)) offEvent(peer, k, h[k]);
      // let a farewell message leave before the peer goes
      if (farewell) setTimeout(() => destroyPeer(peer), this._t.busyCloseMs + 50);
      else destroyPeer(peer);
    }
  }

  _onConnection(peer, dc) {
    if (peer !== this._peer || !dc) return;
    const meta = dc.metadata || {};
    if (meta.app !== 'twinspin') {
      closeQuietly(dc);
      return;
    }
    const onOpen = () => this._accept(dc);
    if (dc.open) onOpen();
    else dc.on('open', onOpen);
    dc.on('data', (m) => this._onData(dc, m));
    dc.on('close', () => this._onDcClose(dc));
    dc.on('error', () => this._onDcClose(dc));
  }

  _refuse(dc, msg) {
    safeSend(dc, msg);
    setTimeout(() => closeQuietly(dc), this._t.busyCloseMs);
  }

  _healthy(L) {
    return !!(L && L.dc && L.dc.open && now() - L.lastSeen < this._t.deadMs);
  }

  _accept(dc) {
    if (!this._peer) {
      closeQuietly(dc);
      return;
    }
    if (this._banned.has(dc.peer)) {
      this._refuse(dc, { t: 'kicked' });
      return;
    }
    let L = this._listener;
    if (L && L.id !== dc.peer) {
      if (this._healthy(L)) {
        this._refuse(dc, { t: 'busy' });
        return;
      }
      const stale = L.dc;
      this._dropListener(); // the old one is gone or silent: the newcomer takes the slot
      closeQuietly(stale);
      L = null;
    }
    if (L) {
      // the same device re-opened its control link
      const old = L.dc;
      L.dc = dc;
      L.lastSeen = now();
      clearTimeout(L.graceTimer);
      if (old && old !== dc) closeQuietly(old);
      safeSend(dc, { t: 'hello', v: 1, bus: this._bus });
      if (!this._callAlive(L.call)) this._call();
      else if (L.state === 'reconnecting') L.state = 'live';
    } else {
      L = {
        id: dc.peer, dc, call: null, state: 'connecting', since: now(), lastSeen: now(), delayMs: null,
        relay: false, level: 0, graceTimer: null, bitrateFor: null, iceFailedAt: 0,
      };
      this._listener = L;
      safeSend(dc, { t: 'hello', v: 1, bus: this._bus });
      this._call();
    }
    this._updateState();
  }

  _callAlive(call) {
    if (!call || call.open === false) return false;
    const pc = call.peerConnection;
    if (!pc) return !!call.open;
    const s = pc.iceConnectionState;
    return s === 'connected' || s === 'completed' || s === 'checking' || s === 'new';
  }

  _call() {
    const L = this._listener;
    const peer = this._peer;
    if (!L || !peer || !this._stream) return;
    this._lastRecall = now();
    if (L.call) {
      const old = L.call;
      L.call = null;
      closeQuietly(old);
    }
    let call = null;
    try {
      call = peer.call(L.id, this._stream, { metadata: { app: 'twinspin', v: 1 } });
    } catch {
      call = null;
    }
    if (!call) {
      // peer.call returns undefined (and emits nothing) without a stream or when the peer is closing
      L.state = 'reconnecting';
      this._updateState();
      return;
    }
    L.call = call;
    L.state = 'connecting';
    L.bitrateFor = null;
    const onIce = (s) => this._onIce(L, call, s);
    call.on('iceStateChanged', onIce);
    const pc = call.peerConnection;
    if (pc && typeof pc.addEventListener === 'function') {
      pc.addEventListener('iceconnectionstatechange', () => onIce(pc.iceConnectionState));
    }
    call.on('close', () => {
      if (L.call !== call) return;
      L.call = null;
      if (this._listener === L && L.state !== 'unreachable') L.state = 'reconnecting';
      this._updateState();
    });
    call.on('error', (e) => {
      if (L.call !== call) return;
      const type = (e && e.type) || '';
      if (type === 'negotiation-failed' || /ice|negotiat/i.test(String((e && e.message) || ''))) this._iceFailed(L);
    });
  }

  _onIce(L, call, s) {
    if (L.call !== call || this._listener !== L) return;
    if (s === 'connected' || s === 'completed') {
      if (L.state !== 'live') {
        L.state = 'live';
        L.iceFailedAt = 0;
        this._updateState();
      }
      const pc = call.peerConnection;
      if (pc && L.bitrateFor !== call) {
        L.bitrateFor = call;
        setSendBitrate(pc, SEND_BITRATE).then(() => usesRelay(pc)).then((relay) => {
          if (L.call !== call) return;
          L.relay = relay;
          if (relay) setSendBitrate(pc, RELAY_BITRATE);
          this.emit('change');
        });
      }
    } else if (s === 'disconnected') {
      if (L.state === 'live') {
        L.state = 'reconnecting';
        this._updateState();
      }
    } else if (s === 'failed') {
      this._iceFailed(L);
    }
  }

  _iceFailed(L) {
    if (this._listener !== L) return;
    const first = !L.iceFailedAt;
    L.iceFailedAt = now();
    L.state = 'unreachable';
    this._updateState();
    if (first) this._emitError(MESSAGES.unreachableHost);
  }

  _onData(dc, m) {
    const L = this._listener;
    if (!L || L.dc !== dc || !m || typeof m !== 'object') return;
    L.lastSeen = now();
    switch (m.t) {
      case 'recall':
        if (now() - this._lastRecall >= this._t.recallMinMs || L.state === 'unreachable' || !this._callAlive(L.call)) {
          this._call();
        }
        this._updateState();
        break;
      case 'stats': {
        const d = Number(m.delayMs);
        L.delayMs = Number.isFinite(d) && d >= 0 ? d : null;
        const lv = Number(m.level);
        L.level = Number.isFinite(lv) ? Math.max(0, Math.min(1, lv)) : 0;
        if (typeof m.relay === 'boolean') L.relay = m.relay;
        if (m.live && L.state !== 'live' && this._callAlive(L.call)) L.state = 'live';
        this._updateState();
        break;
      }
      case 'ping':
        safeSend(dc, { t: 'pong', c: m.c });
        break;
      case 'bye':
        this._dropListener();
        setTimeout(() => closeQuietly(dc), 0);
        break;
      default:
        break;
    }
  }

  _onDcClose(dc) {
    const L = this._listener;
    if (!L || L.dc !== dc) return;
    L.dc = null;
    if (L.state === 'live' || L.state === 'connecting') L.state = 'reconnecting';
    clearTimeout(L.graceTimer);
    L.graceTimer = setTimeout(() => {
      if (this._listener === L && !L.dc) this._dropListener();
    }, this._t.graceMs);
    this._updateState();
  }

  _dropListener(silent = false) {
    const L = this._listener;
    if (!L) return;
    this._listener = null;
    clearTimeout(L.graceTimer);
    const call = L.call;
    L.call = null;
    closeQuietly(call);
    if (!silent) this._updateState();
  }

  _heartbeat() {
    const L = this._listener;
    if (L) {
      if (L.dc && L.dc.open) safeSend(L.dc, { t: 'hb' });
      if (now() - L.lastSeen > this._t.deadMs && !(L.graceTimer && !L.dc)) {
        const dc = L.dc;
        this._dropListener();
        closeQuietly(dc);
      }
    }
    const peer = this._peer;
    if (!peer || peer.destroyed) return;
    if (peer.disconnected) {
      if (!this._reconnectTimer) this._onSignalLost(peer);
    } else if (this._signal !== 'ok') {
      // reconnected (PeerJS may not repeat 'open' when the server kept our old entry)
      this._signal = 'ok';
      this._lostSince = 0;
      this.emit('change');
    }
  }

  _onSignalLost(peer) {
    if (peer !== this._peer || peer.destroyed) return;
    if (!this._lostSince) this._lostSince = now();
    this._signal = now() - this._lostSince > this._t.reconnectGiveUpMs ? 'lost' : 'reconnecting';
    this.emit('change');
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (peer !== this._peer || peer.destroyed || !peer.disconnected) return;
      try {
        peer.reconnect();
      } catch {
        /* destroyed meanwhile */
      }
    }, this._t.reconnectMs);
  }

  _onPeerError(peer, e) {
    if (peer !== this._peer) return;
    const type = (e && e.type) || '';
    if (type === 'peer-unavailable') {
      // our call target is gone (the listener closed its page)
      const L = this._listener;
      if (L && String((e && e.message) || '').indexOf(L.id) >= 0) this._dropListener();
      return;
    }
    if (type === 'unavailable-id') {
      // reconnecting while the server still holds our old socket: keep trying a while (alive_timeout ~90 s)
      this._onSignalLost(peer);
      return;
    }
    if (type === 'browser-incompatible') {
      this._fail(toRemoteError(e));
      return;
    }
    if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed'
      || type === 'disconnected') {
      this._onSignalLost(peer);
    }
    // 'webrtc' and others: per-connection trouble, handled by the call/link handlers
  }
}
