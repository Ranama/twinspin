// PeerJS plumbing for the second-device feature: lazy loader, pairing codes, peer ids, ICE config, friendly
// errors. Nothing here runs at import time; PeerJS is fetched only when the user starts sharing or listening.
//
//   const Peer = await loadPeerJs();                         // PeerJS 1.5.5 UMD, SRI-pinned, 3 CDNs, 12 s each
//   const peer = await openPeer(Peer, hostIdFor('K7QF'), peerOptions());
//   const early = takeEarly(peer);                           // connections that arrived with 'open'
//   joinLink('K7QF')  -> 'https://example.org/twinspin/?listen=K7QF'
//
// Ids: 'twinspin-v1-' + CODE for the DJ (host), 'twinspin-v1-l-' + random for listeners. Codes are 4 characters
// from ABCDEFGHJKMNPQRSTUVWXYZ23456789 (no 0/O, 1/I/L). ICE: Google STUN only by default (PeerJS's own TURN
// servers and the old Open Relay login are dead, docs/research/verify-webrtc.md); window.TWINSPIN_CONFIG.iceServers
// replaces the list (add your own TURN there), TWINSPIN_CONFIG.peerOptions points at your own PeerJS server.

import { config } from '../core/env.js';

export const PEERJS_VERSION = '1.5.5';
export const PEERJS_SRI = 'sha384-x0YgkOr/3UOZP2CRDxGW9e0Q+2Qjyr3uJrm4xU32Y7ZCNAo7Cc7bjhrZMi/dwczu';
export const PEERJS_URLS = Object.freeze([
  `https://cdn.jsdelivr.net/npm/peerjs@${PEERJS_VERSION}/dist/peerjs.min.js`,
  `https://cdnjs.cloudflare.com/ajax/libs/peerjs/${PEERJS_VERSION}/peerjs.min.js`,
  `https://unpkg.com/peerjs@${PEERJS_VERSION}/dist/peerjs.min.js`,
]);
export const ID_PREFIX = 'twinspin-v1-';
export const LISTENER_PREFIX = ID_PREFIX + 'l-';
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;
export const DEFAULT_ICE_SERVERS = Object.freeze([
  Object.freeze({ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }),
]);
export const TIMING = Object.freeze({
  loadMs: 12000,      // one CDN attempt
  openMs: 15000,      // registering with the signalling server
});

/** User-facing messages (shared by the host panel and the receiver page). */
export const MESSAGES = Object.freeze({
  offline: 'This device is offline. Connect to Wi-Fi and try again.',
  blocked: 'Couldn\'t load the connection helper. Check the internet connection (a content blocker may stop '
    + 'cdn.jsdelivr.net) and try again.',
  network: 'Can\'t reach the pairing server. Check the internet connection and try again.',
  unsupported: 'This browser can\'t stream sound between devices. Use a current Chrome, Safari or Firefox.',
  config: 'The pairing server settings in config.js are wrong. Remove peerOptions to use the free server.',
  codeTaken: 'Couldn\'t get a free code. Try again in a minute.',
  unreachableHost: 'Can\'t reach the second device. Both must be on the same Wi-Fi or hotspot.',
  unreachable: 'Can\'t reach the DJ device. Both must be on the same Wi-Fi or hotspot.',
  error: 'The connection failed. Try again.',
});

/** An Error with a stable `code` ('offline' | 'blocked' | 'network' | 'unsupported' | 'unavailable-id' | ...). */
export class RemoteError extends Error {
  constructor(code, message, detail = '') {
    super(message || MESSAGES[code] || MESSAGES.error);
    this.name = 'RemoteError';
    this.code = code;
    this.detail = detail;
  }
}

function randomBytes(n) {
  const out = new Uint8Array(n);
  try {
    const c = globalThis.crypto;
    if (c && typeof c.getRandomValues === 'function') return c.getRandomValues(out);
  } catch {
    /* fall through */
  }
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** A random pairing code, e.g. 'K7QF'. */
export function makeCode(n = CODE_LENGTH) {
  const bytes = randomBytes(n * 2);
  let s = '';
  // rejection sampling keeps the 31-letter alphabet uniform
  for (let i = 0; i < bytes.length && s.length < n; i++) {
    if (bytes[i] < 248) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  while (s.length < n) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

/**
 * Clean up a typed or URL code: trims, upper-cases, drops spaces and dashes. Returns null unless it is exactly
 * CODE_LENGTH characters of the alphabet.
 */
export function normalizeCode(input) {
  const s = String(input == null ? '' : input).toUpperCase().replace(/[\s_-]+/g, '');
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) if (CODE_ALPHABET.indexOf(ch) < 0) return null;
  return s;
}

/** The DJ's PeerJS id for a code. */
export function hostIdFor(code) {
  return ID_PREFIX + code;
}

/** A fresh random listener id (PeerJS id rules: letters/digits separated by single dashes). */
export function makeListenerId() {
  const bytes = randomBytes(10);
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (const b of bytes) s += abc[b % abc.length];
  return LISTENER_PREFIX + s;
}

/** True for ids this app hands out to listeners. */
export function isListenerId(id) {
  return /^twinspin-v1-l-[a-z0-9]{6,16}$/.test(String(id || ''));
}

/**
 * The link a second device opens: origin + pathname + '?listen=CODE'.
 * @param {string} code
 * @param {{origin: string, pathname: string}} [loc]  defaults to window.location
 */
export function joinLink(code, loc = globalThis.location) {
  const origin = (loc && loc.origin && loc.origin !== 'null') ? loc.origin : '';
  const path = (loc && loc.pathname) || '/';
  return `${origin}${path}?listen=${encodeURIComponent(code)}`;
}

/** ICE servers: config.iceServers when set, else Google STUN. Returns a fresh copy. */
export function iceServers(cfg = config) {
  const list = cfg && Array.isArray(cfg.iceServers) && cfg.iceServers.length ? cfg.iceServers : DEFAULT_ICE_SERVERS;
  return list.map((s) => ({ ...s, urls: Array.isArray(s.urls) ? s.urls.slice() : s.urls }));
}

/** PeerJS constructor options (ICE + optional self-hosted signalling server from config.peerOptions). */
export function peerOptions(cfg = config) {
  const o = { config: { iceServers: iceServers(cfg) }, debug: 1 };
  const p = cfg && cfg.peerOptions;
  if (p && typeof p === 'object') {
    for (const k of ['host', 'port', 'path', 'key', 'secure', 'pingInterval', 'debug', 'token']) {
      if (p[k] != null && p[k] !== '') o[k] = p[k];
    }
  }
  return o;
}

function findPeer(w) {
  try {
    if (w && w.peerjs && typeof w.peerjs.Peer === 'function') return w.peerjs.Peer;
    if (w && typeof w.Peer === 'function') return w.Peer;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Add a <script> once and resolve when `check()` returns something truthy after it loaded.
 * @param {string} url
 * @param {{ integrity?: string|null, timeoutMs?: number, check: () => any, doc?: Document }} opts
 */
export function loadScript(url, { integrity = null, timeoutMs = TIMING.loadMs, check, doc } = {}) {
  const d = doc || globalThis.document;
  return new Promise((resolve, reject) => {
    if (!d || typeof d.createElement !== 'function') {
      reject(new RemoteError('unsupported', MESSAGES.unsupported, 'no document'));
      return;
    }
    let done = false;
    let s = null;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (s) {
        s.onload = null;
        s.onerror = null;
        if (err) {
          try { s.remove(); } catch { /* ignore */ }
        }
      }
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new RemoteError('blocked', MESSAGES.blocked, `timeout ${url}`)), timeoutMs);
    try {
      s = d.createElement('script');
      s.async = true;
      s.crossOrigin = 'anonymous';
      if (integrity) s.integrity = integrity;
      s.onload = () => {
        let v = null;
        try { v = check ? check() : true; } catch { v = null; }
        if (v) finish(null, v);
        else finish(new RemoteError('blocked', MESSAGES.blocked, `loaded but missing: ${url}`));
      };
      s.onerror = () => finish(new RemoteError('blocked', MESSAGES.blocked, `script error ${url}`));
      s.src = url;
      (d.head || d.documentElement || d.body).appendChild(s);
    } catch (e) {
      finish(new RemoteError('blocked', MESSAGES.blocked, String((e && e.message) || e)));
    }
  });
}

let peerLoad = null;

/**
 * Load PeerJS 1.5.5 once and resolve with its Peer constructor. Tries config.peerJsUrl (if set), then jsDelivr,
 * cdnjs and unpkg (same bytes, same SRI), 12 s each. Rejects with a RemoteError ('offline' | 'blocked').
 */
export function loadPeerJs({ win = globalThis, doc = null, timeoutMs = TIMING.loadMs } = {}) {
  const ready = findPeer(win);
  if (ready) return Promise.resolve(ready);
  if (peerLoad) return peerLoad;
  try {
    const nav = globalThis.navigator;
    if (nav && nav.onLine === false) return Promise.reject(new RemoteError('offline'));
  } catch {
    /* ignore */
  }
  const sources = PEERJS_URLS.map((url) => ({ url, integrity: PEERJS_SRI }));
  if (config.peerJsUrl) sources.unshift({ url: String(config.peerJsUrl), integrity: null });
  peerLoad = (async () => {
    let last = null;
    for (const src of sources) {
      try {
        return await loadScript(src.url, { integrity: src.integrity, timeoutMs, check: () => findPeer(win), doc });
      } catch (e) {
        last = e;
        const again = findPeer(win); // a slow earlier attempt may have finished meanwhile
        if (again) return again;
      }
    }
    throw last || new RemoteError('blocked');
  })();
  peerLoad.catch(() => {
    peerLoad = null; // allow a retry
  });
  return peerLoad;
}

/** A PeerJS error (err.type) or anything thrown -> RemoteError with a friendly message. */
export function toRemoteError(e) {
  if (e instanceof RemoteError) return e;
  const type = (e && e.type) || '';
  const detail = `${type}: ${(e && e.message) || e}`;
  switch (type) {
    case 'unavailable-id': return new RemoteError('unavailable-id', MESSAGES.codeTaken, detail);
    case 'peer-unavailable': return new RemoteError('peer-unavailable', MESSAGES.network, detail);
    case 'browser-incompatible': return new RemoteError('unsupported', MESSAGES.unsupported, detail);
    case 'invalid-id':
    case 'invalid-key': return new RemoteError('config', MESSAGES.config, detail);
    case 'webrtc': return new RemoteError('webrtc', MESSAGES.error, detail);
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
    case 'ssl-unavailable':
    case 'disconnected':
      return new RemoteError('network', MESSAGES.network, detail);
    default:
      return new RemoteError('error', MESSAGES.error, detail);
  }
}

function off(emitter, type, fn) {
  try {
    if (typeof emitter.off === 'function') emitter.off(type, fn);
    else if (typeof emitter.removeListener === 'function') emitter.removeListener(type, fn);
  } catch {
    /* ignore */
  }
}

/** Remove an event listener from a PeerJS object (eventemitter3: off/removeListener). */
export const offEvent = off;

/** Destroy a Peer quietly. */
export function destroyPeer(peer) {
  if (!peer) return;
  try {
    if (!peer.destroyed) peer.destroy();
  } catch {
    /* already gone */
  }
}

/** Close a DataConnection/MediaConnection quietly. */
export function closeQuietly(conn) {
  if (!conn) return;
  try {
    conn.close();
  } catch {
    /* already closed */
  }
}

/**
 * new Peer(id, options) and wait for 'open'. Connections the server delivers right with 'open' are buffered until
 * takeEarly(peer) hands them over. Rejects with a RemoteError (code 'unavailable-id' when the id is taken,
 * 'network' on timeout or server trouble, 'unsupported' when the browser lacks WebRTC).
 * @param {Function} Peer  PeerJS constructor
 * @param {string|null} id
 * @param {object} options  peerOptions()
 * @param {{ timeoutMs?: number }} [opts]
 */
export function openPeer(Peer, id, options, { timeoutMs = TIMING.openMs } = {}) {
  return new Promise((resolve, reject) => {
    let peer = null;
    let done = false;
    let timer = null;
    const early = [];
    const onConn = (c) => early.push(c);
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (peer) {
        off(peer, 'open', onOpen);
        off(peer, 'error', onErr);
      }
      if (err) {
        if (peer) off(peer, 'connection', onConn);
        destroyPeer(peer);
        reject(err);
      } else {
        peer.__twinspinEarly = { list: early, fn: onConn };
        resolve(peer);
      }
    };
    const onOpen = () => finish(null);
    const onErr = (e) => finish(toRemoteError(e));
    try {
      peer = id ? new Peer(id, options) : new Peer(options);
    } catch (e) {
      reject(new RemoteError('unsupported', MESSAGES.unsupported, String((e && e.message) || e)));
      return;
    }
    timer = setTimeout(() => finish(new RemoteError('network', MESSAGES.network, 'signalling timeout')), timeoutMs);
    peer.on('connection', onConn);
    peer.on('open', onOpen);
    peer.on('error', onErr);
  });
}

/** Stop buffering early connections of a peer from openPeer() and return them. */
export function takeEarly(peer) {
  const e = peer && peer.__twinspinEarly;
  if (!e) return [];
  peer.__twinspinEarly = null;
  off(peer, 'connection', e.fn);
  return e.list.splice(0);
}
