// Google Drive as a song source (docs/SOURCES.md section 3.1), with no backend: Google Identity Services (token
// model, scope drive.file) + the Google Picker + GET https://www.googleapis.com/drive/v3/files/{id}?alt=media.
// The picked songs are downloaded at once and handed back as File objects for library.add() (each File carries
// `remote` { kind: 'gdrive', fileId } and `driveFileId`, so the library keeps the Drive file id).
//   const drive = new GoogleDriveSource({ config, library });   // config.google = { clientId, apiKey, appId }
//   drive.preload().catch(() => {});                            // when the Add music sheet opens
//   button.onclick = () => drive.pick().then((files) => library.add(files, { source: 'gdrive' }));  // IN the tap
//   await drive.importLink('https://drive.google.com/drive/folders/…');   // public link: API key only, no sign-in
//   drive.on('progress', ({ done, total, bytes, totalBytes, name }) => ...);  drive.cancel();  drive.signOut();
// pick() / importLink() reject with an Error whose message is plain words for the user (and a `code`); a cancel
// (popup closed, Picker cancelled, cancel(), the signal) resolves with the files finished so far ([] usually).
// When some songs of a batch fail, the others come back and one 'error' event says what went wrong.
// The access token (1 hour, no refresh token) lives in memory only. Never uses the redirect flow: it would
// unload the page and the audio engine.

import { Emitter } from '../core/emitter.js';
import { config as appConfig } from '../core/env.js';
import { looksLikeAudio } from '../audio/decode.js';
import { LIBRARY_CAP } from '../library/library.js';
import {
  abortError, contentType, isAbort, loadScript, makeAbort, makeFile, mimeForName, onAbort, readParts, runPool,
  safeFileName, sourceError,
} from './net.js';
import { parseDriveUrl } from './drive-link.js';

export { parseDriveUrl };

export const GAPI_URL = 'https://apis.google.com/js/api.js';
export const GSI_URL = 'https://accounts.google.com/gsi/client';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
/** Audio MIME types the Picker shows (Drive stores audio under many names; wildcards are undocumented). */
export const AUDIO_MIME_TYPES = Object.freeze([
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/x-aac', 'audio/wav',
  'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/flac', 'audio/x-flac', 'audio/ogg', 'audio/opus',
  'audio/webm', 'audio/aiff', 'audio/x-aiff',
]);
/**
 * At most this many songs per pick: the library keeps LIBRARY_CAP stored songs, so more would only be downloaded
 * to be removed again (and push out every older song).
 */
export const PICKER_MAX_ITEMS = LIBRARY_CAP;
/** Downloads running at the same time. */
export const PARALLEL_DOWNLOADS = 2;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const GRANT_KEY = 'twinspin.gdrive.v1';
const SCRIPT_TIMEOUT_MS = 20000;
const TOKEN_WAIT_MS = 5 * 60 * 1000;
const META_TIMEOUT_MS = 20000;
const MAX_LIST_PAGES = 10;

/** Mobile override for the Picker dialog (its own sizing is desktop-only): full screen under 600 px. */
export const PICKER_CSS = [
  '.picker-dialog-bg{z-index:2147483000!important}',
  '.picker-dialog{z-index:2147483001!important}',
  '@media (max-width:600px){',
  '.picker-dialog{left:0!important;top:0!important;width:100vw!important;max-width:100vw!important;' +
    'height:100vh!important;height:100dvh!important;border:0!important;border-radius:0!important;' +
    'box-sizing:border-box!important;padding-top:env(safe-area-inset-top,0px)!important}',
  '.picker-dialog-content,.picker-dialog-content iframe,.picker-dialog iframe{width:100%!important;' +
    'height:100%!important;max-width:100vw!important}',
  '}',
].join('\n');

export const MSG = Object.freeze({
  notConfigured: "Google Drive isn't set up in this copy of TwinSpin yet. The setup guide shows how (about 15 " +
    'minutes, once).',
  linkNotConfigured: 'Google Drive links need the Google API key in config.js. The setup guide shows how.',
  loading: 'Google Drive is getting ready. Tap Google Drive again in a moment.',
  loadFailed: "Couldn't load Google Drive. Check your internet connection, or turn off a content blocker for this " +
    'site, then try again.',
  popupBlocked: "Allow pop-ups for TwinSpin, or use Add music > Google Drive in your phone's file picker.",
  denied: 'TwinSpin needs your OK to open the songs you pick. Tap Google Drive again and allow it.',
  signInFailed: "Google sign-in didn't work. Try again.",
  auth: 'Your Google Drive sign-in has expired. Tap Google Drive again to reconnect.',
  notShared: "That file or folder isn't shared. In Google Drive choose Share > General access > “Anyone with the " +
    'link”, then paste the link again.',
  quota: 'Google Drive is limiting downloads right now. Try again later.',
  keyProblem: "Google Drive isn't set up correctly for this site (the API key). Check the setup guide.",
  notFoundLink: "That file or folder wasn't found. Check the link, and that it is shared with “Anyone with the link”.",
  network: "Can't reach Google Drive. Check your internet connection.",
  server: 'Google Drive had a problem. Try again in a moment.',
  badLink: 'That is not a Google Drive link. In Drive use Share > Copy link, then paste it here.',
  notAudio: 'That link is not a song. Share a song file (MP3, M4A, WAV, FLAC ...) or a folder of songs.',
  emptyFolder: 'No songs found in that folder. TwinSpin imports the songs directly inside it (not sub-folders).',
  busy: 'Google Drive is still importing songs. Wait for it, or cancel it.',
});

const named = (name) => (name ? `“${name}”` : 'this file');

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function call(obj, name, ...args) {
  if (obj && typeof obj[name] === 'function') return obj[name](...args);
  return undefined;
}

function safeLocal() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/** A Picker DocumentObject or a files.get result as { id, name, mimeType, sizeBytes, lastEditedUtc, resourceKey }. */
function docOf(d) {
  if (!d || typeof d !== 'object' || !d.id) return null;
  const lastEdited = Number(d.lastEditedUtc) || (typeof d.modifiedTime === 'string' ? Date.parse(d.modifiedTime) : 0);
  return {
    id: String(d.id),
    name: String(d.name || d.title || ''),
    mimeType: String(d.mimeType || ''),
    sizeBytes: Number(d.sizeBytes || d.size) > 0 ? Number(d.sizeBytes || d.size) : 0,
    lastEditedUtc: Number.isFinite(lastEdited) && lastEdited > 0 ? lastEdited : 0,
    resourceKey: typeof d.resourceKey === 'string' ? d.resourceKey : '',
  };
}

function attachRemote(file, doc) {
  const remote = Object.freeze({ kind: 'gdrive', fileId: doc.id, ...(doc.resourceKey ? { resourceKey: doc.resourceKey } : {}) });
  try {
    Object.defineProperty(file, 'remote', { value: remote, enumerable: true, configurable: true });
    Object.defineProperty(file, 'driveFileId', { value: doc.id, enumerable: true, configurable: true });
  } catch {
    /* a frozen stand-in: library.add(files, { remote }) still works */
  }
  return file;
}

export class GoogleDriveSource extends Emitter {
  /**
   * @param {{ config?: object, library?: object, deps?: object }} [opts] `config`: the app config (with
   *   `google`) or the google part itself; default the one from config.js. `deps` for tests: { global (where
   *   `google` / `gapi` live), document, fetch, loadScript(src, { timeoutMs }), location, storage, now, language }
   */
  constructor({ config, library = null, deps = {} } = {}) {
    super();
    const cfg = config === undefined ? appConfig : config;
    const g = cfg && typeof cfg === 'object' && cfg.google && typeof cfg.google === 'object' ? cfg.google : cfg || {};
    this._cfg = Object.freeze({ clientId: str(g.clientId), apiKey: str(g.apiKey), appId: str(g.appId) });
    this.library = library;
    this._g = deps.global || globalThis;
    this._doc = 'document' in deps ? deps.document : globalThis.document || null;
    this._fetch = typeof deps.fetch === 'function' ? deps.fetch : (...a) => globalThis.fetch(...a);
    this._loadScript = typeof deps.loadScript === 'function' ? deps.loadScript
      : (src, opts) => loadScript(src, { document: this._doc, ...opts });
    this._location = deps.location || globalThis.location || null;
    this._store = 'storage' in deps ? deps.storage : safeLocal();
    this._now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    this._language = 'language' in deps ? deps.language : (globalThis.navigator && globalThis.navigator.language) || '';
    this._token = '';
    this._tokenExp = 0;
    this._tokenClient = null;
    this._pickerReady = false;
    this._preloadP = null;
    this._loadError = '';
    this._pending = null;   // token request waiting for Google's popup
    this._op = null;        // the pick / import under way
    this._progress = null;
    this._cssDone = false;
  }

  /** All three config values are present (clientId, apiKey, appId = the project number). */
  get configured() {
    const c = this._cfg;
    return !!(c.clientId && c.apiKey && c.appId);
  }

  /** Public Drive links can be imported (only the API key is needed). */
  get linkReady() {
    return !!this._cfg.apiKey;
  }

  /** Google's scripts are loaded (api.js with the Picker, and gsi/client): pick() can open the popup at once. */
  get ready() {
    return this._pickerReady && !!this._tokenClient;
  }

  /** The scripts are loading. */
  get loading() {
    return !!this._preloadP && !this.ready;
  }

  /** Why the scripts did not load ('' when fine). */
  get loadError() {
    return this._loadError;
  }

  /** A Drive sign-in from this session is still valid (no popup needed). */
  get signedIn() {
    return !!this._token && this._now() < this._tokenExp;
  }

  /** A pick or link import is running. */
  get busy() {
    return !!this._op;
  }

  /** The last 'progress' of the running import ({ done, total, bytes, totalBytes, name }) or null. */
  get progress() {
    return this._progress ? { ...this._progress } : null;
  }

  // ---- scripts ------------------------------------------------------------------------------------------------

  /**
   * Load https://apis.google.com/js/api.js (+ gapi.load('picker')) and https://accounts.google.com/gsi/client and
   * set up the token client, so a later tap can open Google's popup at once. Does nothing until Drive is
   * configured. Rejects with a readable Error (code 'load-failed') when the scripts cannot load (offline, a
   * content blocker); `loadError` keeps the message and the next call tries again.
   * @returns {Promise<void>}
   */
  preload() {
    if (!this.configured || this.ready) return Promise.resolve();
    if (this._preloadP) return this._preloadP;
    this._loadError = '';
    const p = Promise.all([this._loadPicker(), this._loadGis()]).then(
      () => {
        this._injectCss();
        this.emit('state');
      },
      (err) => {
        console.warn('[TwinSpin] Google Drive scripts did not load', err);
        this._loadError = MSG.loadFailed;
        if (this._preloadP === p) this._preloadP = null;
        this.emit('state');
        throw sourceError('load-failed', MSG.loadFailed, err);
      },
    );
    this._preloadP = p;
    p.catch(() => {}); // callers that do not wait for it must not see an unhandled rejection
    this.emit('state');
    return p;
  }

  _withTimeout(fn) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (f, v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        f(v);
      };
      const timer = setTimeout(() => finish(reject, sourceError('load-timeout', MSG.loadFailed)), SCRIPT_TIMEOUT_MS);
      try {
        fn((v) => finish(resolve, v), (e) => finish(reject, e));
      } catch (err) {
        finish(reject, err);
      }
    });
  }

  _loadPicker() {
    const g = this._g;
    const has = () => !!(g.google && g.google.picker && typeof g.google.picker.PickerBuilder === 'function');
    if (has()) {
      this._pickerReady = true;
      return Promise.resolve();
    }
    const script = g.gapi && typeof g.gapi.load === 'function' ? Promise.resolve()
      : this._loadScript(GAPI_URL, { timeoutMs: SCRIPT_TIMEOUT_MS });
    return script
      .then(() => this._withTimeout((ok, fail) => {
        if (!g.gapi || typeof g.gapi.load !== 'function') {
          fail(sourceError('load-failed', MSG.loadFailed));
          return;
        }
        g.gapi.load('picker', {
          callback: () => ok(),
          onerror: () => fail(sourceError('load-failed', MSG.loadFailed)),
          timeout: SCRIPT_TIMEOUT_MS,
          ontimeout: () => fail(sourceError('load-timeout', MSG.loadFailed)),
        });
      }))
      .then(() => {
        if (!has()) throw sourceError('load-failed', MSG.loadFailed);
        this._pickerReady = true;
      });
  }

  _loadGis() {
    const g = this._g;
    const oauth2 = () => (g.google && g.google.accounts && g.google.accounts.oauth2) || null;
    const has = () => !!(oauth2() && typeof oauth2().initTokenClient === 'function');
    if (this._tokenClient) return Promise.resolve();
    const script = has() ? Promise.resolve() : this._loadScript(GSI_URL, { timeoutMs: SCRIPT_TIMEOUT_MS });
    return script.then(() => {
      if (!has()) throw sourceError('load-failed', MSG.loadFailed);
      this._tokenClient = oauth2().initTokenClient({
        client_id: this._cfg.clientId,
        scope: DRIVE_SCOPE,
        callback: (resp) => this._onToken(resp),
        error_callback: (err) => this._onTokenError(err),
      });
    });
  }

  /** The Picker's mobile CSS (once). */
  _injectCss() {
    if (this._cssDone) return;
    const doc = this._doc;
    try {
      if (!doc || typeof doc.createElement !== 'function') return;
      if (typeof doc.getElementById === 'function' && doc.getElementById('twinspin-picker-css')) {
        this._cssDone = true;
        return;
      }
      const el = doc.createElement('style');
      el.id = 'twinspin-picker-css';
      el.textContent = PICKER_CSS;
      (doc.head || doc.body || doc.documentElement).appendChild(el);
      this._cssDone = true;
    } catch {
      /* the Picker still works, only less nicely on phones */
    }
  }

  // ---- sign-in --------------------------------------------------------------------------------------------------

  _granted() {
    try {
      const raw = this._store && this._store.getItem(GRANT_KEY);
      const v = raw ? JSON.parse(raw) : null;
      return !!(v && v.granted === true);
    } catch {
      return false;
    }
  }

  _setGranted(on) {
    try {
      if (!this._store) return;
      if (on) this._store.setItem(GRANT_KEY, JSON.stringify({ granted: true }));
      else this._store.removeItem(GRANT_KEY);
    } catch {
      /* private mode: the consent screen shows again next time */
    }
  }

  /** Ask Google for a token. MUST run synchronously inside the tap; resolves with the token or null (cancelled). */
  _requestToken(op) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this._pending === pending) this._pending = null;
        op.onCancel = null;
        fn(v);
      };
      const pending = { resolve: (t) => finish(resolve, t), reject: (e) => finish(reject, e) };
      const timer = setTimeout(() => finish(resolve, null), TOKEN_WAIT_MS);
      this._pending = pending;
      op.onCancel = () => finish(resolve, null);
      try {
        this._tokenClient.requestAccessToken({ prompt: this._granted() ? '' : 'consent' });
      } catch (err) {
        finish(reject, sourceError('popup-blocked', MSG.popupBlocked, err));
      }
    });
  }

  _onToken(resp) {
    const pending = this._pending;
    this._pending = null;
    if (!resp || resp.error || !resp.access_token) {
      const code = resp && resp.error;
      if (!pending) return;
      if (code === 'access_denied') pending.resolve(null); // the user said no on Google's screen
      else pending.reject(sourceError('sign-in', MSG.signInFailed));
      return;
    }
    const oauth2 = this._g.google && this._g.google.accounts && this._g.google.accounts.oauth2;
    if (oauth2 && typeof oauth2.hasGrantedAllScopes === 'function') {
      let ok = true;
      try {
        ok = !!oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE);
      } catch {
        ok = true;
      }
      if (!ok) {
        if (pending) pending.reject(sourceError('denied', MSG.denied));
        return;
      }
    }
    const secs = Number(resp.expires_in);
    this._token = String(resp.access_token);
    this._tokenExp = this._now() + Math.max(0, (Number.isFinite(secs) && secs > 0 ? secs : 3599) - 60) * 1000;
    this._setGranted(true);
    this.emit('state');
    if (pending) pending.resolve(this._token);
  }

  _onTokenError(err) {
    const pending = this._pending;
    this._pending = null;
    if (!pending) return;
    const type = err && err.type;
    if (type === 'popup_closed') pending.resolve(null);
    else if (type === 'popup_failed_to_open') pending.reject(sourceError('popup-blocked', MSG.popupBlocked));
    else pending.reject(sourceError('sign-in', MSG.signInFailed));
  }

  _clearToken() {
    const had = !!this._token;
    this._token = '';
    this._tokenExp = 0;
    if (had) this.emit('state');
  }

  /** Forget the Drive sign-in on this device and revoke TwinSpin's access token at Google. */
  signOut() {
    const token = this._token;
    this._token = '';
    this._tokenExp = 0;
    this._setGranted(false);
    const oauth2 = this._g.google && this._g.google.accounts && this._g.google.accounts.oauth2;
    if (token && oauth2 && typeof oauth2.revoke === 'function') {
      try {
        oauth2.revoke(token, () => {});
      } catch {
        /* the token runs out within the hour anyway */
      }
    }
    this.emit('state');
  }

  // ---- operations -----------------------------------------------------------------------------------------------

  _begin(signal) {
    // stage: 'token' (Google's popup) | 'picker' | 'download' | 'link'
    const op = { ctl: makeAbort(), cancelled: false, onCancel: null, unlink: () => {}, stage: 'link' };
    this._op = op;
    this._progress = null;
    op.unlink = onAbort(signal, () => this._cancelOp(op));
    this.emit('state');
    return op;
  }

  _end(op) {
    op.unlink();
    if (this._op !== op) return;
    this._op = null;
    this._progress = null;
    this.emit('state');
  }

  _cancelOp(op) {
    if (op.cancelled) return;
    op.cancelled = true;
    op.ctl.abort();
    const fn = op.onCancel;
    op.onCancel = null;
    if (typeof fn === 'function') fn();
  }

  /** Stop the running pick / import: the files finished so far come back from pick() / importLink(). */
  cancel() {
    if (this._op) this._cancelOp(this._op);
  }

  /**
   * Sign in (Google's popup, only when needed), open the Google Picker and download the songs the user picks
   * (2 at a time, 'progress' events). MUST be called synchronously from a tap (iPhone blocks a popup that opens
   * after an await). Resolves with File objects (name, type, lastModified; `remote` / `driveFileId` attached);
   * [] when cancelled. Rejects with a readable Error (code 'not-configured', 'loading', 'popup-blocked', 'denied',
   * 'sign-in', 'auth', 'forbidden', 'not-found', 'quota', 'network', 'busy', ...).
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<File[]>}
   */
  pick({ signal } = {}) {
    if (!this.configured) return Promise.reject(sourceError('not-configured', MSG.notConfigured));
    if (this._op) {
      // Google's popup may never answer (seen in iPhone home-screen apps): a new tap asks again
      if (this._op.stage !== 'token') return Promise.reject(sourceError('busy', MSG.busy));
      this._cancelOp(this._op);
    }
    if (signal && signal.aborted) return Promise.resolve([]);
    let tokenP;
    let op;
    if (this.signedIn) {
      op = this._begin(signal);
      op.stage = 'picker';
      tokenP = Promise.resolve(this._token);
    } else if (this._tokenClient) {
      op = this._begin(signal);
      op.stage = 'token';
      tokenP = this._requestToken(op); // synchronous popup request, still inside the tap
    } else {
      const failed = this._loadError;
      this._startPreload();
      return Promise.reject(sourceError(failed ? 'load-failed' : 'loading', failed || MSG.loading));
    }
    return tokenP
      .then((token) => {
        if (!token || op.cancelled) return [];
        op.stage = 'picker';
        return this._whenReady().then(() => this._openPicker(token, op));
      })
      .then((docs) => {
        if (!docs.length || op.cancelled) return [];
        op.stage = 'download';
        return this._downloadAll(docs, { token: this._token, op, mode: 'pick' });
      })
      .then((files) => {
        this._end(op);
        return files;
      }, (err) => {
        this._end(op);
        if (isAbort(err) || op.cancelled) return [];
        throw err;
      });
  }

  _whenReady() {
    if (this._pickerReady) return Promise.resolve();
    return this.preload().then(() => {
      if (!this._pickerReady) throw sourceError('load-failed', this._loadError || MSG.loadFailed);
    });
  }

  /** preload() for callers that only start it (its failure shows in `loadError` and the 'state' event). */
  _startPreload() {
    this.preload().catch(() => {});
  }

  /** Open the Picker; resolves with the picked documents ([] when cancelled). */
  _openPicker(token, op) {
    const P = this._g.google && this._g.google.picker;
    if (!P || typeof P.PickerBuilder !== 'function') return Promise.reject(sourceError('load-failed', MSG.loadFailed));
    this._injectCss();
    return new Promise((resolve, reject) => {
      let picker = null;
      let settled = false;
      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        op.onCancel = null;
        try {
          call(picker, 'setVisible', false);
          call(picker, 'dispose');
        } catch {
          /* ignore */
        }
        fn(v);
      };
      try {
        const view = new P.DocsView(P.ViewId.DOCS);
        call(view, 'setMimeTypes', AUDIO_MIME_TYPES.join(','));
        call(view, 'setIncludeFolders', true);
        call(view, 'setSelectFolderEnabled', false);
        call(view, 'setParent', 'root');
        call(view, 'setMode', P.DocsViewMode.LIST);
        const b = new P.PickerBuilder();
        call(b, 'addView', view);
        call(b, 'enableFeature', P.Feature.MULTISELECT_ENABLED);
        call(b, 'setMaxItems', PICKER_MAX_ITEMS);
        call(b, 'setOAuthToken', token);
        call(b, 'setDeveloperKey', this._cfg.apiKey);
        call(b, 'setAppId', this._cfg.appId);
        const origin = this._location && this._location.origin;
        if (origin && origin !== 'null') call(b, 'setOrigin', origin);
        call(b, 'setTitle', 'Add songs from Google Drive');
        const lang = String(this._language || '').slice(0, 2).toLowerCase();
        if (/^[a-z]{2}$/.test(lang)) call(b, 'setLocale', lang);
        const R = P.Response || {};
        const A = P.Action || {};
        call(b, 'setCallback', (data) => {
          const action = data ? data[R.ACTION || 'action'] : null;
          if (action === (A.PICKED || 'picked')) {
            const list = (data[R.DOCUMENTS || 'docs'] || []).map(docOf).filter(Boolean);
            finish(resolve, list);
          } else if (action === (A.CANCEL || 'cancel')) {
            finish(resolve, []);
          } else if (action === (A.ERROR || 'error')) {
            finish(reject, sourceError('picker', MSG.keyProblem));
          }
        });
        picker = b.build();
        op.onCancel = () => finish(resolve, []);
        picker.setVisible(true);
      } catch (err) {
        finish(reject, sourceError('picker', MSG.loadFailed, err));
      }
    });
  }

  /**
   * Import a public "Anyone with the link" Drive file or folder (the songs directly inside a folder, at most
   * LIBRARY_CAP), with the API key only: no sign-in. Resolves with File objects ([] when cancelled); rejects
   * with a readable Error (code 'bad-link', 'not-configured', 'forbidden', 'not-found', 'not-audio',
   * 'empty-folder', 'quota', 'network', 'busy', ...).
   * @param {string} url
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<File[]>}
   */
  async importLink(url, { signal } = {}) {
    const ref = parseDriveUrl(url);
    if (!ref) throw sourceError('bad-link', MSG.badLink);
    if (!this._cfg.apiKey) throw sourceError('not-configured', MSG.linkNotConfigured);
    if (this._op) throw sourceError('busy', MSG.busy);
    if (signal && signal.aborted) return [];
    const op = this._begin(signal);
    try {
      let meta = docOrMeta(await this._getMeta(ref.id, ref.resourceKey, op), ref.id);
      if (meta.mimeType === SHORTCUT_MIME && meta.targetId) {
        meta = docOrMeta(await this._getMeta(meta.targetId, '', op), meta.targetId);
      }
      let docs;
      if (meta.mimeType === FOLDER_MIME) {
        const rk = meta.id === ref.id ? ref.resourceKey || meta.resourceKey : meta.resourceKey;
        docs = await this._listFolder(meta.id, rk, op);
        docs = docs.filter((d) => looksLikeAudio({ type: d.mimeType, name: d.name }));
        if (!docs.length) throw sourceError('empty-folder', MSG.emptyFolder);
      } else {
        const d = docOf(meta);
        if (d && !d.resourceKey && ref.resourceKey) d.resourceKey = ref.resourceKey;
        docs = d ? [d] : [];
      }
      const found = docs.length;
      if (found > LIBRARY_CAP) docs = docs.slice(0, LIBRARY_CAP);
      const files = await this._downloadAll(docs, { key: this._cfg.apiKey, op, mode: 'link' });
      if (found > LIBRARY_CAP && !op.cancelled) {
        this.emit('error', `That folder has ${found} songs. TwinSpin imported the first ${LIBRARY_CAP}, because your ` +
          `library keeps up to ${LIBRARY_CAP} songs.`);
      }
      return files;
    } catch (err) {
      if (isAbort(err) || op.cancelled) return [];
      throw err;
    } finally {
      this._end(op);
    }
  }

  async _getMeta(id, resourceKey, op) {
    const fields = 'id,name,mimeType,size,modifiedTime,resourceKey,shortcutDetails(targetId,targetMimeType)';
    const url = `${DRIVE_FILES_URL}/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}` +
      `&supportsAllDrives=true&key=${encodeURIComponent(this._cfg.apiKey)}`;
    return this._json(url, resourceKey ? { 'X-Goog-Drive-Resource-Keys': `${id}/${resourceKey}` } : {}, op);
  }

  async _listFolder(folderId, resourceKey, op) {
    const q = `'${folderId}' in parents and mimeType contains 'audio/' and trashed = false`;
    const fields = 'nextPageToken,files(id,name,mimeType,size,modifiedTime,resourceKey)';
    const headers = resourceKey ? { 'X-Goog-Drive-Resource-Keys': `${folderId}/${resourceKey}` } : {};
    const out = [];
    let pageToken = '';
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const url = `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}` +
        '&pageSize=1000&orderBy=name_natural&supportsAllDrives=true&includeItemsFromAllDrives=true' +
        `${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}&key=${encodeURIComponent(this._cfg.apiKey)}`;
      const body = await this._json(url, headers, op);
      for (const f of Array.isArray(body && body.files) ? body.files : []) {
        const d = docOf(f);
        if (d) out.push(d);
      }
      pageToken = body && typeof body.nextPageToken === 'string' ? body.nextPageToken : '';
      if (!pageToken) break;
    }
    return out;
  }

  /** GET JSON from the Drive API with the API key (a website-restricted key needs the origin as referrer). */
  async _json(url, headers, op) {
    let res;
    try {
      res = await this._send(url, { headers, referrerPolicy: 'strict-origin' }, op, META_TIMEOUT_MS);
    } catch (err) {
      if (isAbort(err) || op.cancelled) throw abortError();
      throw err;
    }
    if (!res.ok) throw await this._httpError(res, 'link', '');
    try {
      return await res.json();
    } catch (err) {
      throw sourceError('server', MSG.server, err);
    }
  }

  /** fetch with the operation's abort signal (and a deadline for the answer's headers). */
  _send(url, init, op, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      let done = false;
      let timer = null;
      const finish = (fn, v) => {
        if (done) return;
        done = true;
        if (timer !== null) clearTimeout(timer);
        fn(v);
      };
      if (op.cancelled) {
        finish(reject, abortError());
        return;
      }
      if (timeoutMs > 0) {
        timer = setTimeout(() => finish(reject, sourceError('timeout', MSG.network)), timeoutMs);
      }
      let p;
      try {
        p = this._fetch(url, { method: 'GET', credentials: 'omit', ...init, signal: op.ctl.signal });
      } catch (err) {
        p = Promise.reject(err);
      }
      Promise.resolve(p).then(
        (res) => finish(resolve, res),
        (err) => finish(reject, isAbort(err) || op.cancelled ? abortError() : sourceError('network', MSG.network, err)),
      );
    });
  }

  /** A readable Error for a failed Drive API answer. mode 'pick' (signed in) or 'link' (API key). */
  async _httpError(res, mode, name) {
    let reason = '';
    let message = '';
    try {
      const body = await res.json();
      const e = body && body.error;
      if (e && typeof e === 'object') {
        const first = Array.isArray(e.errors) && e.errors[0] ? e.errors[0] : null;
        const detail = Array.isArray(e.details) ? e.details.find((d) => d && d.reason) : null;
        reason = [first && first.reason, detail && detail.reason, e.status].filter(Boolean).join(' ');
        message = typeof e.message === 'string' ? e.message : '';
      }
    } catch {
      /* not JSON */
    }
    const s = res.status;
    const text = `${reason} ${message}`;
    const err = (code, msg) => {
      const x = sourceError(code, msg);
      x.status = s;
      if (reason) x.reason = reason;
      return x;
    };
    if (/keyInvalid|API_KEY|accessNotConfigured|SERVICE_DISABLED|ipRefererBlocked|referer|referrer|API key/i.test(text)) {
      return err('setup', MSG.keyProblem);
    }
    if (s === 401) {
      this._clearToken();
      return err('auth', mode === 'link' ? MSG.keyProblem : MSG.auth);
    }
    if (s === 429 || /rateLimit|quotaExceeded|downloadQuota/i.test(reason)) return err('quota', MSG.quota);
    if (s === 403) {
      if (/cannotDownloadAbusiveFile/i.test(reason)) {
        return err('forbidden', `Google flagged ${named(name)} as possibly harmful, so it can't be downloaded here.`);
      }
      if (/cannotDownloadFile/i.test(reason)) return err('forbidden', `The owner of ${named(name)} doesn't allow downloads.`);
      return err('forbidden', mode === 'link' ? MSG.notShared : `TwinSpin isn't allowed to open ${named(name)}. Pick it again in Google Drive.`);
    }
    if (s === 404) {
      return err('not-found', mode === 'link' ? MSG.notFoundLink : `Google Drive couldn't find ${named(name)}. Pick it again.`);
    }
    if (s >= 500) return err('server', MSG.server);
    return err('http', `Google Drive answered with error ${s}. Try again.`);
  }

  /** Download documents (PARALLEL_DOWNLOADS at a time) with 'progress' events; see pick() for the outcome. */
  async _downloadAll(rawDocs, { token = '', key = '', op, mode }) {
    const docs = [];
    let notSongs = 0;
    for (const d of rawDocs) {
      if (!d || !d.id || d.mimeType === FOLDER_MIME) continue;
      if (/^application\/vnd\.google-apps\./.test(d.mimeType) || !looksLikeAudio({ type: d.mimeType, name: d.name })) {
        notSongs++;
        continue;
      }
      docs.push(d);
    }
    const skippedText = notSongs === 1 ? 'One file is not a song, so it was skipped.'
      : `${notSongs} files are not songs, so they were skipped.`;
    if (!docs.length) {
      if (notSongs) throw sourceError('not-audio', mode === 'link' ? MSG.notAudio : skippedText);
      return [];
    }
    if (notSongs) this.emit('error', skippedText);
    const total = docs.length;
    const sizes = docs.map((d) => d.sizeBytes);
    const got = docs.map(() => 0);
    let done = 0;
    const report = (name) => {
      if (op.cancelled) return;
      const totalBytes = sizes.every((s) => s > 0) ? sizes.reduce((a, b) => a + b, 0) : 0;
      const bytes = got.reduce((a, b) => a + b, 0);
      this._progress = { done, total, bytes, totalBytes, name };
      this.emit('progress', { ...this._progress });
    };
    report(docs[0].name);
    const jobs = docs.map((d, i) => async () => {
      if (op.cancelled) throw abortError();
      const file = await this._fileFor(d, {
        token, key, op, mode,
        onProgress: (bytes, size) => {
          got[i] = bytes;
          if (size > 0) sizes[i] = size;
          report(d.name);
        },
      });
      got[i] = file.size || got[i];
      if (file.size > 0) sizes[i] = file.size;
      done++;
      report(d.name);
      return file;
    });
    const results = await runPool(jobs, PARALLEL_DOWNLOADS);
    const files = [];
    const failures = [];
    for (const r of results) {
      if (r.ok) files.push(r.value);
      else if (!isAbort(r.error)) failures.push(r.error);
    }
    if (op.cancelled) return files;
    if (!files.length && failures.length) throw failures[0];
    if (failures.length) {
      this.emit('error', failures.length === 1 ? failures[0].message
        : `${failures.length} of ${total} songs couldn't be downloaded. ${failures[0].message}`);
    }
    return files;
  }

  /** One song as a File: the copy already in the library when there is one, else a download. */
  async _fileFor(d, { token, key, op, mode, onProgress }) {
    const lib = this.library;
    if (lib && typeof lib.findRemote === 'function' && typeof lib.getBlob === 'function') {
      try {
        const known = lib.findRemote({ kind: 'gdrive', fileId: d.id });
        const blob = known && known.stored ? await lib.getBlob(known.id) : null;
        if (blob) {
          const file = makeFile([blob], known.fileName || safeFileName(d.name), {
            type: known.type || blob.type || d.mimeType, lastModified: known.lastModified,
          });
          return attachRemote(file, d);
        }
      } catch {
        /* download it again */
      }
    }
    const url = `${DRIVE_FILES_URL}/${encodeURIComponent(d.id)}?alt=media&supportsAllDrives=true` +
      `${key ? `&key=${encodeURIComponent(key)}` : ''}`;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (d.resourceKey) headers['X-Goog-Drive-Resource-Keys'] = `${d.id}/${d.resourceKey}`;
    const init = key ? { headers, referrerPolicy: 'strict-origin' } : { headers };
    const res = await this._send(url, init, op, META_TIMEOUT_MS);
    if (!res.ok) throw await this._httpError(res, mode, d.name);
    let parts;
    try {
      ({ parts } = await readParts(res, { onProgress, totalHint: d.sizeBytes, cancelled: () => op.cancelled }));
    } catch (err) {
      if (isAbort(err) || op.cancelled) throw abortError();
      if (err && err.code === 'stalled') throw err;
      throw sourceError('network', MSG.network, err);
    }
    const ct = contentType(res);
    const type = (d.mimeType && d.mimeType !== 'application/octet-stream' ? d.mimeType : '') ||
      (ct.startsWith('audio/') ? ct : '') || mimeForName(d.name);
    const file = makeFile(parts, safeFileName(d.name), { type, lastModified: d.lastEditedUtc });
    return attachRemote(file, d);
  }
}

/** A files.get answer with the shortcut target pulled up ({ ..., targetId }); `id` defaults to the asked one. */
function docOrMeta(meta, askedId) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const target = m.shortcutDetails && m.shortcutDetails.targetId ? String(m.shortcutDetails.targetId) : '';
  return { ...m, id: String(m.id || askedId || ''), mimeType: String(m.mimeType || ''), targetId: target };
}
