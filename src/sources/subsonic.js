// Music servers that speak the Subsonic / OpenSubsonic API (Navidrome on a Synology NAS, Gonic, Airsonic-Advanced,
// Ampache ...): docs/SOURCES.md section 3.2. Navidrome sends Access-Control-Allow-Origin: *, so the app talks to it
// straight from the browser with plain GET requests (auth in the query string, no custom headers: no preflight).
//   const client = new SubsonicClient({ url, username, password });     // t = md5(password + salt); never p=
//   const body = await client.getAlbumList2('newest', 50, 0);           // the 'subsonic-response' body
//   const blob = await client.download(songId, { signal, onProgress }); // download.view, else stream.view?format=raw
//   const server = new MusicServerSource({ library });
//   await server.connect({ url, username, password, remember });       // stores { url, username, token, salt }
//   await library.addRemote(server.toEntries(body.album.song));          // songs play through the 'subsonic' resolver
// Methods resolve with the inner 'subsonic-response' object (status 'ok'); its list fields are always arrays
// (old servers send a lone object for a one-item list). Failures reject with an Error whose message is plain words
// for the user and whose `code` says what went wrong ('auth', 'not-found', 'forbidden', 'network', 'timeout',
// 'not-subsonic', 'server-down', 'unreachable', 'cors', 'mixed-content', 'bad-url', ...; `subsonicCode` holds the
// server's number).

import { Emitter } from '../core/emitter.js';
import { md5 } from './md5.js';
import {
  abortError, contentType, isAbort, makeAbort, makeBlob, makeFile, mimeForName, onAbort, readParts, safeFileName,
  sourceError,
} from './net.js';
import { songName } from './remote-ref.js';

/** Subsonic REST API version TwinSpin speaks. */
export const API_VERSION = '1.16.1';
export const CLIENT_NAME = 'TwinSpin';
/** localStorage / sessionStorage key of the saved connection ({ url, username, token, salt } - never a password). */
export const SERVER_STORE_KEY = 'twinspin.musicserver.v1';
const CALL_TIMEOUT_MS = 20000;
const HEADERS_TIMEOUT_MS = 30000;
const PROBE_TIMEOUT_MS = 8000;

export const MSG = Object.freeze({
  network: "Can't reach your music server. Check your connection and that the server is on.",
  unreachable: "Can't reach your music server. Check the address. From outside your home use the " +
    'https://….synology.me address. If the address shows a certificate warning in the browser, the server needs ' +
    "a valid certificate (for example Let's Encrypt on the NAS).",
  cors: "Your music server answered, but it doesn't let TwinSpin in. Check that the address points at Navidrome " +
    "(or another Subsonic server) and that the NAS reverse proxy doesn't remove its headers.",
  mixedContent: 'TwinSpin runs on https://, so browsers block http:// addresses. Use the https:// address of your ' +
    'music server (see the NAS guide).',
  mixedLocal: 'Your browser blocked this http:// address. Only Chrome (on a computer or Android) can use a home ' +
    'network http:// address, after you allow access to devices on your local network. Use the https:// address ' +
    'of your music server instead.',
  localWarning: 'This http:// address only works in Chrome (on a computer or Android) at home, after you allow ' +
    'access to devices on your local network. iPhone and other browsers need the https:// address of your server.',
  timeout: 'Your music server took too long to answer. Check the address and that the server is on.',
  notSubsonic: "That address answers, but it isn't a music server TwinSpin can use. Check the address: it should " +
    'open Navidrome (or another Subsonic server) in the browser.',
  serverDown: "Your NAS answered, but the music server behind it isn't running. Start Navidrome (Container " +
    'Manager), then try again.',
});

const SUBSONIC_ERRORS = Object.freeze({
  0: ['server', ''],
  10: ['bad-request', "Your music server says TwinSpin's request is missing a detail. Update the server, then try again."],
  20: ['version', 'Your music server needs a newer Subsonic version than TwinSpin speaks. Update TwinSpin (reload ' +
    'the page) or use another server.'],
  30: ['version', 'Your music server is too old for TwinSpin. Update it (Navidrome works best).'],
  40: ['auth', 'Wrong user name or password.'],
  41: ['auth', "This server can't check passwords the way TwinSpin sends them (it does not allow token sign-in " +
    'for LDAP accounts). Use a local account on the music server.'],
  42: ['auth', "Your music server doesn't support this way of signing in."],
  43: ['auth', 'Your music server got two kinds of sign-in at once. Disconnect and connect again.'],
  44: ['auth', "The API key isn't valid. Make a new one on your music server."],
  50: ['forbidden', "Your account on the music server isn't allowed to do that. Ask the server's admin to allow " +
    'it (for example downloads or streaming).'],
  60: ['forbidden', 'The trial period of your music server is over.'],
  70: ['not-found', "That isn't on your music server any more. It may have been moved or removed."],
});

/**
 * A readable Error for a Subsonic error { code, message }.
 * @returns {Error & { code: string, subsonicCode: number }}
 */
export function subsonicError(error) {
  const n = error && Number.isFinite(Number(error.code)) ? Number(error.code) : 0;
  const serverMsg = error && typeof error.message === 'string' ? error.message.trim() : '';
  const known = SUBSONIC_ERRORS[n];
  const [code, text] = known || ['server', ''];
  const message = text || (serverMsg
    ? `Your music server reported a problem: ${serverMsg.slice(0, 200)}`
    : 'Your music server reported a problem. Try again.');
  const err = sourceError(code, message);
  err.subsonicCode = n;
  if (serverMsg) err.serverMessage = serverMsg;
  return err;
}

function httpError(status) {
  if (status === 401 || status === 403) {
    return sourceError('auth', `Your music server refused TwinSpin (error ${status}). Check the user name and password.`);
  }
  if (status === 404) return sourceError('not-subsonic', MSG.notSubsonic);
  if (status === 502 || status === 503 || status === 504) return sourceError('server-down', MSG.serverDown);
  return sourceError(status >= 500 ? 'server' : 'http', `Your music server answered with error ${status}. Try again.`);
}

/** A random hex salt (crypto.getRandomValues when there is one). */
export function randomSalt(length = 12) {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  try {
    globalThis.crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let s = '';
  for (const b of bytes) s += (b < 16 ? '0' : '') + b.toString(16);
  return s.slice(0, length);
}

/**
 * The auth query parameters: u + t = md5(password + salt) + s (a password is never sent), or the OpenSubsonic
 * apiKey alone (never together with u/t/s: servers reject the mix), plus v, c and f=json.
 * @param {{ username?: string, password?: string, token?: string, salt?: string, apiKey?: string,
 *   clientName?: string }} creds
 * @returns {Record<string, string>}
 */
export function authParams({ username = '', password, token, salt, apiKey, clientName = CLIENT_NAME } = {}) {
  const common = { v: API_VERSION, c: clientName || CLIENT_NAME, f: 'json' };
  if (apiKey) return { apiKey: String(apiKey), ...common };
  let t = token;
  let s = salt;
  if (!t && typeof password === 'string') {
    s = s || randomSalt();
    t = md5(password + s);
  }
  return { u: String(username || ''), t: String(t || ''), s: String(s || ''), ...common };
}

function query(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
    .join('&');
}

// ---------------------------------------------------------------------------------------------------------
// Addresses

const PRIVATE_V4 = [
  [10, 0, 0, 0, 8], [172, 16, 0, 0, 12], [192, 168, 0, 0, 16], [127, 0, 0, 0, 8], [169, 254, 0, 0, 16],
  [100, 64, 0, 0, 10],
];

function v4Private(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const ip = m.slice(1).map(Number);
  if (ip.some((x) => x > 255)) return false;
  const n = ((ip[0] << 24) >>> 0) + (ip[1] << 16) + (ip[2] << 8) + ip[3];
  return PRIVATE_V4.some(([a, b, c, d, bits]) => {
    const base = ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

/** True for localhost, private / link-local / CGNAT IPv4, ::1, fc00::/7, fe80::/10 and *.local names. */
export function isLocalHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (v4Private(h)) return true;
  if (h.includes(':')) return h === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h);
  return false;
}

/**
 * Clean up a music server address the way people type or paste it: adds https:// (http:// for a home network
 * address), drops a trailing slash, '/rest/...', Navidrome's '/app/...' web pages, query and fragment. http:// is
 * allowed only for localhost and home-network addresses (with a warning: only Chrome can use those from the
 * https app) or when TwinSpin itself runs on http://.
 * @param {string} input
 * @param {{ pageProtocol?: string }} [opts] the app's own location.protocol
 * @returns {{ url: string, host: string, secure: boolean, local: boolean, warning: string }}
 * @throws an Error (code 'bad-url' | 'mixed-content') with a readable message
 */
export function normalizeServerUrl(input, { pageProtocol = 'https:' } = {}) {
  let text = String(input == null ? '' : input).trim();
  if (!text) throw sourceError('bad-url', 'Type the address of your music server.');
  if (/\s/.test(text)) throw sourceError('bad-url', 'The address has a space in it. Check it and try again.');
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      throw sourceError('bad-url', 'Use an address that starts with https:// (for example https://music.yourname.synology.me).');
    }
  } else {
    const hostGuess = text.split(/[/?#]/)[0].replace(/:\d+$/, '');
    text = `${isLocalHost(hostGuess) ? 'http' : 'https'}://${text}`;
  }
  const m = /^(https?):\/\/([^/?#]*)([^?#]*)/i.exec(text);
  if (!m || !m[2]) throw sourceError('bad-url', "That doesn't look like a web address. Check it and try again.");
  const scheme = m[1].toLowerCase();
  let authority = m[2];
  if (authority.includes('@')) {
    throw sourceError('bad-url', "Leave the user name out of the address; type it in the User field instead.");
  }
  authority = authority.toLowerCase();
  const hm = /^(\[[0-9a-f:.]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(authority);
  if (!hm) throw sourceError('bad-url', "That doesn't look like a web address. Check it and try again.");
  const host = hm[1];
  const port = hm[2] ? Number(hm[2]) : 0;
  if (port > 65535 || (hm[2] && port === 0)) throw sourceError('bad-url', 'The port number in the address is not valid.');
  if (!/^\[[0-9a-f:.]+\]$/.test(host) && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.?$/.test(host)) {
    throw sourceError('bad-url', "That doesn't look like a web address. Check it and try again.");
  }
  const defaultPort = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80);
  let path = m[3] || '';
  path = path.replace(/\/+/g, '/');
  path = path.replace(/\/(rest|app)(\/.*)?$/i, '');
  path = path.replace(/\/(index\.html?)?$/i, '');
  const local = isLocalHost(host);
  const secure = scheme === 'https';
  let warning = '';
  if (!secure) {
    const pageHttps = String(pageProtocol || '').toLowerCase() === 'https:';
    if (pageHttps && !local) throw sourceError('mixed-content', MSG.mixedContent);
    if (pageHttps) warning = MSG.localWarning;
  }
  const url = `${scheme}://${host}${port && !defaultPort ? `:${port}` : ''}${path}`;
  return { url, host, secure, local, warning };
}

/** A stable id for a server address ('srv-' + 12 hex digits). */
export function serverIdFor(url) {
  return `srv-${md5(String(url || '').toLowerCase()).slice(0, 12)}`;
}

// ---------------------------------------------------------------------------------------------------------
// The client

const arr = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []);

/** Make the list fields of a response body arrays (in place) and return it. */
function fixLists(b) {
  const fix = (o, k) => {
    if (o && typeof o === 'object' && k in o) o[k] = arr(o[k]);
  };
  if (b.artists) {
    fix(b.artists, 'index');
    for (const i of b.artists.index || []) fix(i, 'artist');
  }
  if (b.indexes) {
    fix(b.indexes, 'index');
    for (const i of b.indexes.index || []) fix(i, 'artist');
  }
  if (b.artist && !Array.isArray(b.artist)) fix(b.artist, 'album');
  if (b.albumList2) fix(b.albumList2, 'album');
  if (b.albumList) fix(b.albumList, 'album');
  if (b.album && !Array.isArray(b.album)) fix(b.album, 'song');
  if (b.searchResult3) ['artist', 'album', 'song'].forEach((k) => fix(b.searchResult3, k));
  if (b.playlists) fix(b.playlists, 'playlist');
  if (b.playlist && !Array.isArray(b.playlist)) fix(b.playlist, 'entry');
  if (b.randomSongs) fix(b.randomSongs, 'song');
  if (b.musicFolders) fix(b.musicFolders, 'musicFolder');
  if ('openSubsonicExtensions' in b) b.openSubsonicExtensions = arr(b.openSubsonicExtensions);
  return b;
}

/**
 * fetch with a deadline and the caller's signal; rejects with code 'timeout', an AbortError or code 'network'.
 * Settles even when the fetch implementation ignores the abort.
 */
function fetchWithin(fetchFn, url, init, signal, ms) {
  return new Promise((resolve, reject) => {
    const ctl = makeAbort();
    let done = false;
    let timer = null;
    let unlink = () => {};
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      unlink();
      fn(v);
    };
    unlink = onAbort(signal, () => {
      ctl.abort();
      finish(reject, abortError());
    });
    if (done) {
      unlink();
      return;
    }
    if (ms > 0) {
      timer = setTimeout(() => {
        ctl.abort();
        finish(reject, sourceError('timeout', MSG.timeout));
      }, ms);
    }
    let p;
    try {
      p = fetchFn(url, { ...init, signal: ctl.signal });
    } catch (err) {
      p = Promise.reject(err);
    }
    Promise.resolve(p).then(
      (res) => finish(resolve, res),
      (err) => finish(reject, isAbort(err) ? abortError() : sourceError('network', MSG.network, err)),
    );
  });
}

export class SubsonicClient {
  /**
   * @param {{ url: string, username?: string, password?: string, token?: string, salt?: string, apiKey?: string,
   *   fetch?: typeof fetch, clientName?: string, timeoutMs?: number }} opts `url` is the server's base address
   *   (normalizeServerUrl); a password is turned into token + salt at once and not kept
   */
  constructor({ url, username = '', password, token, salt, apiKey, fetch: fetchFn, clientName = CLIENT_NAME,
    timeoutMs = CALL_TIMEOUT_MS } = {}) {
    this._base = String(url || '').replace(/\/+$/, '');
    this._fetch = typeof fetchFn === 'function' ? fetchFn : (...a) => globalThis.fetch(...a);
    this._auth = Object.freeze(authParams({ username, password, token, salt, apiKey, clientName }));
    this._timeout = timeoutMs;
  }

  /** The server's base address. */
  get url() {
    return this._base;
  }

  /** The auth parameters this client sends ({ u, t, s, v, c, f } or { apiKey, v, c, f }). */
  get auth() {
    return this._auth;
  }

  /** The full URL of a REST method with auth and parameters. */
  methodUrl(method, params = {}) {
    return `${this._base}/rest/${method}.view?${query({ ...this._auth, ...params })}`;
  }

  /**
   * Call a JSON method. Resolves with the 'subsonic-response' body (status 'ok').
   * @param {string} method e.g. 'ping'
   * @param {object} [params]
   * @param {{ signal?: AbortSignal }} [opts]
   */
  async call(method, params = {}, { signal } = {}) {
    const url = this.methodUrl(method, params);
    const res = await fetchWithin(this._fetch, url, { method: 'GET', credentials: 'omit', cache: 'no-store' }, signal,
      this._timeout);
    let body = null;
    let parsed = false;
    try {
      body = await res.json();
      parsed = true;
    } catch {
      body = null;
    }
    const inner = body && typeof body === 'object' ? body['subsonic-response'] : null;
    if (inner && typeof inner === 'object' && inner.status === 'failed') throw subsonicError(inner.error);
    if (!res.ok) throw httpError(res.status);
    if (!parsed || !inner || typeof inner !== 'object' || inner.status !== 'ok') {
      throw sourceError('not-subsonic', MSG.notSubsonic);
    }
    return fixLists(inner);
  }

  /** ping: { status, version, type?, serverVersion?, openSubsonic? }. */
  ping(opts) {
    return this.call('ping', {}, opts);
  }

  /** OpenSubsonic extensions (empty on plain Subsonic servers, which answer with an error). */
  async getOpenSubsonicExtensions(opts) {
    try {
      const b = await this.call('getOpenSubsonicExtensions', {}, opts);
      return arr(b.openSubsonicExtensions);
    } catch (err) {
      if (isAbort(err) || err.code === 'network' || err.code === 'timeout') throw err;
      return [];
    }
  }

  /** getArtists: body.artists.index[].artist[]. */
  getArtists(opts) {
    return this.call('getArtists', {}, opts);
  }

  /** getArtist: body.artist with album[]. */
  getArtist(id, opts) {
    return this.call('getArtist', { id }, opts);
  }

  /**
   * getAlbumList2: body.albumList2.album[] (a page: `size` albums from `offset`; a shorter page is the last).
   * @param {string} [type] 'alphabeticalByName' | 'alphabeticalByArtist' | 'newest' | 'recent' | 'frequent' |
   *   'random' | 'starred' | 'byYear' | 'byGenre'
   * @param {number} [size] 1..500
   * @param {number} [offset]
   * @param {object} [extra] e.g. { fromYear, toYear } or { genre }
   */
  getAlbumList2(type = 'alphabeticalByName', size = 50, offset = 0, extra = {}, opts) {
    const n = Math.max(1, Math.min(500, Math.round(Number(size) || 50)));
    const o = Math.max(0, Math.round(Number(offset) || 0));
    return this.call('getAlbumList2', { type: type || 'alphabeticalByName', size: n, offset: o, ...extra }, opts);
  }

  /** getAlbum: body.album with song[]. */
  getAlbum(id, opts) {
    return this.call('getAlbum', { id }, opts);
  }

  /**
   * search3: body.searchResult3 { artist[], album[], song[] }.
   * @param {string} queryText
   * @param {{ artistCount?: number, artistOffset?: number, albumCount?: number, albumOffset?: number,
   *   songCount?: number, songOffset?: number }} [page]
   */
  search3(queryText, page = {}, opts) {
    const p = {
      query: String(queryText == null ? '' : queryText),
      artistCount: 20, artistOffset: 0, albumCount: 20, albumOffset: 0, songCount: 50, songOffset: 0,
    };
    for (const k of Object.keys(p)) {
      if (k !== 'query' && Number.isFinite(page[k])) p[k] = Math.max(0, Math.round(page[k]));
    }
    return this.call('search3', p, opts);
  }

  /** getPlaylists: body.playlists.playlist[]. */
  getPlaylists(opts) {
    return this.call('getPlaylists', {}, opts);
  }

  /** getPlaylist: body.playlist with entry[]. */
  getPlaylist(id, opts) {
    return this.call('getPlaylist', { id }, opts);
  }

  /** getRandomSongs: body.randomSongs.song[]. */
  getRandomSongs(size = 50, opts) {
    return this.call('getRandomSongs', { size: Math.max(1, Math.min(500, Math.round(Number(size) || 50))) }, opts);
  }

  /** URL of a cover image (for an <img>); '' without an id. */
  coverArtUrl(id, size = 300) {
    if (id == null || id === '') return '';
    const s = Number.isFinite(size) && size > 0 ? Math.round(size) : undefined;
    return this.methodUrl('getCoverArt', { id, size: s });
  }

  /** URL of the original file. */
  downloadUrl(songId) {
    return this.methodUrl('download', { id: songId });
  }

  /** URL of a stream: format 'raw' = the original file; 'mp3' + maxBitRate transcodes on the server. */
  streamUrl(songId, { format, maxBitRate } = {}) {
    return this.methodUrl('stream', { id: songId, format, maxBitRate });
  }

  /**
   * Download a song: download.view (the original file), falling back to stream.view?format=raw when the server
   * does not allow downloads. With `format` (e.g. 'mp3') the server transcodes (stream.view only).
   * @param {string} songId
   * @param {{ signal?: AbortSignal, onProgress?: (bytes: number, totalBytes: number) => void, totalHint?: number,
   *   format?: string, maxBitRate?: number }} [opts]
   * @returns {Promise<Blob>}
   */
  async download(songId, { signal, onProgress, totalHint = 0, format, maxBitRate } = {}) {
    const urls = format && format !== 'raw'
      ? [this.streamUrl(songId, { format, maxBitRate })]
      : [this.downloadUrl(songId), this.streamUrl(songId, { format: 'raw' })];
    let last = null;
    for (const url of urls) {
      try {
        return await this._blob(url, { signal, onProgress, totalHint });
      } catch (err) {
        if (isAbort(err) || ['network', 'timeout', 'stalled', 'auth', 'not-found'].includes(err.code)) throw err;
        last = err;
      }
    }
    throw last || sourceError('download', "The song couldn't be downloaded from your music server.");
  }

  async _blob(url, { signal, onProgress, totalHint }) {
    const res = await fetchWithin(this._fetch, url, { method: 'GET', credentials: 'omit' }, signal, HEADERS_TIMEOUT_MS);
    const ct = contentType(res);
    const isText = ct.includes('json') || ct.includes('xml') || ct.startsWith('text/');
    if (!res.ok || isText) {
      let inner = null;
      try {
        const body = await res.json();
        inner = body && body['subsonic-response'];
      } catch {
        inner = null;
      }
      if (inner && inner.status === 'failed') throw subsonicError(inner.error);
      if (!res.ok) throw httpError(res.status);
      throw sourceError('not-audio', "Your music server didn't send a song file.");
    }
    let parts;
    try {
      ({ parts } = await readParts(res, { onProgress, totalHint, cancelled: () => !!(signal && signal.aborted) }));
    } catch (err) {
      if (isAbort(err) || (signal && signal.aborted)) throw abortError();
      if (err && err.code === 'stalled') throw err;
      throw sourceError('network', MSG.network, err);
    }
    return makeBlob(parts, ct && ct !== 'application/octet-stream' ? ct : '');
  }
}

// ---------------------------------------------------------------------------------------------------------
// Connection management for the UI

function safeStore(name) {
  try {
    return globalThis[name] || null;
  } catch {
    return null;
  }
}

function readRecord(store) {
  try {
    const raw = store && store.getItem(SERVER_STORE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function writeRecord(store, value) {
  try {
    if (!store) return false;
    if (value) store.setItem(SERVER_STORE_KEY, JSON.stringify(value));
    else store.removeItem(SERVER_STORE_KEY);
    return true;
  } catch {
    return false;
  }
}

const num = (v) => (Number.isFinite(Number(v)) && v !== '' && v !== null && v !== undefined ? Number(v) : 0);

function baseName(path) {
  const parts = String(path || '').split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

export class MusicServerSource extends Emitter {
  /**
   * @param {{ settings?: object, library?: object, fetch?: typeof fetch, local?: Storage|null,
   *   session?: Storage|null, location?: { protocol: string } }} [opts] fetch / local / session / location
   *   for tests (default: the browser's)
   */
  constructor({ settings = null, library = null, fetch: fetchFn, local, session, location } = {}) {
    super();
    this.settings = settings;
    this.library = library;
    this._fetch = typeof fetchFn === 'function' ? fetchFn : (...a) => globalThis.fetch(...a);
    this._local = local !== undefined ? local : safeStore('localStorage');
    this._session = session !== undefined ? session : safeStore('sessionStorage');
    this._location = location || safeStore('location') || { protocol: 'https:' };
    this._client = null;
    this._server = null;
    this._status = 'disconnected';
    this._remember = false;
    this._warning = '';
    this._seq = 0;
    this._resolver = (entry, opts) => this._resolve(entry, opts);
    this._restore();
  }

  /** True while a server is set up (signed in now or restored from this device; it may still be unreachable). */
  get connected() {
    return !!this._client;
  }

  /** 'disconnected' | 'connecting' | 'connected' | 'unreachable' | 'auth-failed'. */
  get status() {
    return this._status;
  }

  /** { id, url, name, type, version, serverVersion, openSubsonic } of the server, or null. */
  get server() {
    return this._server;
  }

  /** The SubsonicClient of the connected server, or null. */
  get client() {
    return this._client;
  }

  /** True when the connection is kept on this device (else only until the tab closes). */
  get remembered() {
    return this._remember;
  }

  /** A note to show about the address (an http:// home network address), or ''. */
  get warning() {
    return this._warning;
  }

  _pageProtocol() {
    try {
      return String(this._location.protocol || 'https:');
    } catch {
      return 'https:';
    }
  }

  _setStatus(s) {
    if (this._status === s) return;
    this._status = s;
    this.emit('state');
  }

  /** A saved connection (localStorage when remembered, else sessionStorage) comes back without the network. */
  _restore() {
    let rec = readRecord(this._local);
    let remember = true;
    if (!rec) {
      rec = readRecord(this._session);
      remember = false;
    }
    if (!rec || typeof rec.url !== 'string') return;
    let norm;
    try {
      norm = normalizeServerUrl(rec.url, { pageProtocol: this._pageProtocol() });
    } catch {
      return;
    }
    const hasToken = typeof rec.token === 'string' && rec.token && typeof rec.salt === 'string' && rec.salt;
    const hasKey = typeof rec.apiKey === 'string' && rec.apiKey;
    if (!hasToken && !hasKey) return;
    const client = new SubsonicClient({
      url: norm.url, username: typeof rec.username === 'string' ? rec.username : '', fetch: this._fetch,
      ...(hasKey ? { apiKey: rec.apiKey } : { token: rec.token, salt: rec.salt }),
    });
    const info = rec.server && typeof rec.server === 'object' ? rec.server : {};
    this._install(client, norm, info, remember);
  }

  _install(client, norm, info, remember) {
    this._client = client;
    this._remember = remember;
    this._warning = norm.warning || '';
    this._server = Object.freeze({
      id: serverIdFor(norm.url),
      url: norm.url,
      name: typeof info.name === 'string' && info.name ? info.name : norm.host,
      type: typeof info.type === 'string' ? info.type : '',
      version: typeof info.version === 'string' ? info.version : '',
      serverVersion: typeof info.serverVersion === 'string' ? info.serverVersion : '',
      openSubsonic: info.openSubsonic === true,
    });
    this._status = 'connected';
    if (this.library && typeof this.library.setResolver === 'function') this.library.setResolver('subsonic', this._resolver);
  }

  /**
   * Sign in to a music server: checks the address, pings the server, then keeps { url, username, token, salt }
   * (never the password) in localStorage when `remember`, else in sessionStorage (until the tab closes), and
   * registers the library's 'subsonic' resolver. Rejects with a readable Error (code 'bad-url', 'mixed-content',
   * 'auth', 'unreachable', 'cors', 'not-subsonic', 'server-down', 'timeout', ...); the old connection stays.
   * @param {{ url: string, username?: string, password?: string, apiKey?: string, remember?: boolean }} opts
   */
  async connect({ url, username = '', password = '', apiKey = '', remember = false } = {}) {
    const norm = normalizeServerUrl(url, { pageProtocol: this._pageProtocol() });
    const user = String(username || '').trim();
    const key = String(apiKey || '').trim();
    if (!key && !user) throw sourceError('bad-input', 'Type your user name.');
    if (!key && !password) throw sourceError('bad-input', 'Type your password.');
    const seq = ++this._seq;
    const before = this._status;
    this._setStatus('connecting');
    const salt = randomSalt();
    const client = new SubsonicClient(key
      ? { url: norm.url, apiKey: key, fetch: this._fetch }
      : { url: norm.url, username: user, token: md5(String(password) + salt), salt, fetch: this._fetch });
    let info;
    try {
      info = await client.ping();
    } catch (err) {
      if (seq === this._seq) this._setStatus(this._client ? (before === 'connecting' ? 'connected' : before) : 'disconnected');
      throw await this._diagnose(err, norm);
    }
    if (seq !== this._seq) throw abortError(); // a newer connect() took over
    const server = {
      name: norm.host,
      type: typeof info.type === 'string' ? info.type : '',
      version: typeof info.version === 'string' ? info.version : '',
      serverVersion: typeof info.serverVersion === 'string' ? info.serverVersion : '',
      openSubsonic: info.openSubsonic === true,
    };
    const rec = key
      ? { url: norm.url, apiKey: key, server }
      : { url: norm.url, username: user, token: client.auth.t, salt: client.auth.s, server };
    if (remember) {
      writeRecord(this._local, rec);
      writeRecord(this._session, null);
    } else {
      writeRecord(this._session, rec);
      writeRecord(this._local, null);
    }
    this._install(client, norm, server, !!remember);
    this.emit('state');
  }

  /** Why a connection failed, in plain words (probes the address once when the browser only said "failed"). */
  async _diagnose(err, norm) {
    if (!err || err.code !== 'network') return err;
    const pageHttps = this._pageProtocol().toLowerCase() === 'https:';
    if (!norm.secure && pageHttps) return sourceError('mixed-content', MSG.mixedLocal, err);
    let reachable = false;
    try {
      const res = await fetchWithin(this._fetch, `${norm.url}/rest/ping.view`,
        { method: 'GET', mode: 'no-cors', credentials: 'omit', cache: 'no-store' }, null, PROBE_TIMEOUT_MS);
      reachable = !!res;
    } catch {
      reachable = false;
    }
    return reachable ? sourceError('cors', MSG.cors, err) : sourceError('unreachable', MSG.unreachable, err);
  }

  /**
   * Check the saved connection now (ping). Resolves true when the server answers; else false, with an 'error'
   * event and status 'unreachable' / 'auth-failed'. Never rejects.
   */
  async verify() {
    const client = this._client;
    if (!client) return false;
    const seq = this._seq;
    try {
      const info = await client.ping();
      if (client !== this._client || seq !== this._seq) return false;
      const s = this._server;
      const upd = {
        ...s,
        type: typeof info.type === 'string' ? info.type : s.type,
        version: typeof info.version === 'string' ? info.version : s.version,
        serverVersion: typeof info.serverVersion === 'string' ? info.serverVersion : s.serverVersion,
        openSubsonic: info.openSubsonic === true,
      };
      this._server = Object.freeze(upd);
      const store = this._remember ? this._local : this._session;
      const rec = readRecord(store);
      if (rec) {
        rec.server = { name: upd.name, type: upd.type, version: upd.version, serverVersion: upd.serverVersion,
          openSubsonic: upd.openSubsonic };
        writeRecord(store, rec);
      }
      this._status = 'connected';
      this.emit('state');
      return true;
    } catch (err) {
      if (client !== this._client) return false;
      this._setStatus(err && err.code === 'auth' ? 'auth-failed' : 'unreachable');
      this.emit('error', err && err.message ? err.message : MSG.network);
      return false;
    }
  }

  /** Forget the server on this device (both storages) and unregister the resolver. Listed songs stay. */
  disconnect() {
    this._seq++;
    writeRecord(this._local, null);
    writeRecord(this._session, null);
    const had = !!this._client;
    this._client = null;
    this._server = null;
    this._warning = '';
    this._remember = false;
    this._status = 'disconnected';
    if (this.library && typeof this.library.setResolver === 'function') this.library.setResolver('subsonic', null);
    if (had) this.emit('state');
  }

  /**
   * Library entries (for library.addRemote) for songs of the connected server: raw Subsonic song objects (or
   * objects with `raw`). Folders and videos are left out.
   * @param {object[]} songs
   * @returns {object[]} { title, artist, album, duration, bpm?, coverArt, fileName, size, type,
   *   remote: { kind: 'subsonic', serverId, songId } }
   */
  toEntries(songs) {
    const serverId = this._server ? this._server.id : '';
    if (!serverId) return [];
    const out = [];
    for (const x of arr(songs)) {
      const s = x && x.raw && typeof x.raw === 'object' ? x.raw : x;
      if (!s || s.id == null || s.id === '' || s.isDir === true || s.isVideo === true) continue;
      const suffix = typeof s.suffix === 'string' ? s.suffix.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) : '';
      const title = String(s.title || s.name || baseName(s.path).replace(/\.[^.]+$/, '') || 'Untitled');
      const artist = String(s.artist || s.displayArtist || '');
      let fileName = safeFileName(baseName(s.path), '');
      if (!fileName || !/\.[a-z0-9]{1,5}$/i.test(fileName)) {
        fileName = safeFileName(`${artist ? `${artist} - ` : ''}${title}${suffix ? `.${suffix}` : ''}`);
      }
      const ct = typeof s.contentType === 'string' && /^audio\//i.test(s.contentType) ? s.contentType : '';
      const e = {
        title,
        artist,
        album: String(s.album || ''),
        duration: num(s.duration),
        coverArt: s.coverArt != null ? String(s.coverArt) : '',
        fileName,
        size: num(s.size),
        type: ct || mimeForName(fileName),
        remote: { kind: 'subsonic', serverId, songId: String(s.id) },
      };
      if (num(s.bpm) > 0) e.bpm = num(s.bpm);
      out.push(e);
    }
    return out;
  }

  /**
   * Cover image URL for a library entry of this server (or a cover id), '' when there is none. The URL carries
   * the sign-in token, so it is made when needed and never stored.
   */
  coverArtUrl(entryOrId, size = 300) {
    const c = this._client;
    if (!c) return '';
    let id = entryOrId;
    if (entryOrId && typeof entryOrId === 'object') {
      const r = entryOrId.remote;
      if (!r || r.kind !== 'subsonic' || !this._server || r.serverId !== this._server.id) return '';
      id = entryOrId.coverArt || '';
    }
    return id ? c.coverArtUrl(id, size) : '';
  }

  /** The library resolver: download a song of this server as a File named like the entry. */
  async _resolve(entry, { signal, onProgress } = {}) {
    const c = this._client;
    const r = entry && entry.remote;
    if (!c) throw sourceError('unavailable', `Connect to your music server to play ${songName(entry)}.`);
    if (!r || r.kind !== 'subsonic' || !this._server || r.serverId !== this._server.id) {
      throw sourceError('other-server', `${songName(entry)} is on another music server. Connect to that server to play it.`);
    }
    let blob;
    try {
      blob = await c.download(r.songId, { signal, onProgress, totalHint: entry.size || 0 });
    } catch (err) {
      if (isAbort(err)) throw err;
      if (err && (err.code === 'network' || err.code === 'timeout' || err.code === 'stalled')) {
        throw sourceError('unreachable', `Can't reach your music server to get ${songName(entry)}. Check your ` +
          'connection, or save songs offline before you leave home.', err);
      }
      throw err;
    }
    const type = blob.type || entry.type || mimeForName(entry.fileName);
    return makeFile([blob], entry.fileName || 'song', { type, lastModified: 0 });
  }
}
