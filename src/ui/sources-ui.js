// Song sources in the app UI (docs/SOURCES.md section 4): the Add music sheet, Google Drive picks and Drive links
// (a link that leads to songs is saved on this device, src/sources/drive-links.js, and can be imported again with
// importSavedLink), the music server browser, Save offline, and the import bar: one strip at the top of the
// screen (above the toasts) that shows an import or download while it runs ("Importing from Google Drive · 3 of
// 8 · 12 of 40 MB", a progress line) with Cancel. It also keeps the download progress of music-server songs that
// are loading on a deck, for the deck chips and the player page.
//   const src = new SourcesUI(app);  src.bind();  src.openAddMusic();  src.pickDrive();  // inside a tap
// The sources themselves (src/sources/gdrive.js, subsonic.js) are UI-agnostic; this only calls their documented
// methods and listens to their events. Without them (an older build) the Add music sheet explains instead.

import { h, icon, setText, setAttr } from './dom.js';
import { addMusicSheet } from './sheets/add-music-sheet.js';
import { ServerBrowser } from './server-browser.js';
import {
  progressOf, progressFraction, progressLine, errText, isAbort, countWord, serverLabel, needsDownload, savedLinkName,
  linkResultText,
} from './sources-text.js';
import { songTitle } from './format.js';
import { config } from '../core/env.js';
import { parseDriveUrl } from '../sources/drive-link.js';

const TITLES = {
  gdrive: 'Importing from Google Drive',
  link: 'Importing a Google Drive link',
  offline: 'Saving songs on this device',
};

export class SourcesUI {
  /** @param {object} app the AppUI (sources, library, toasts, sheets, addFiles(), toast()) */
  constructor(app) {
    this.app = app;
    this.job = null;            // the running import / save: { kind, ctrl, cancelled, shown, p, errorAt }
    this.decks = [null, null];  // music-server download on deck A / B: { entryId, title, p, ctrl }
    this.onDriveState = null;   // the open Add music sheet refreshes its Google Drive line
    this._offs = [];
    this._raf = 0;
    this._last = null;
    this.browser = new ServerBrowser(app);
    this._buildBar();
  }

  get gdrive() {
    return (this.app.sources && this.app.sources.gdrive) || null;
  }

  get server() {
    return (this.app.sources && this.app.sources.server) || null;
  }

  /** All three Google values are in config.js (the Drive button works). */
  get driveConfigured() {
    const g = this.gdrive;
    try {
      return !!(g && g.configured);
    } catch {
      return false;
    }
  }

  /** Drive links need only the API key. */
  get driveLinkReady() {
    const g = this.gdrive;
    if (!g || typeof g.importLink !== 'function') return false;
    try {
      if ('linkReady' in g) return !!g.linkReady;
    } catch {
      return false;
    }
    const key = config && config.google && typeof config.google.apiKey === 'string' ? config.google.apiKey.trim() : '';
    return !!key;
  }

  get serverConnected() {
    const s = this.server;
    try {
      return !!(s && s.connected);
    } catch {
      return false;
    }
  }

  /** The Google Drive row's second line in the Add music sheet. */
  driveDetail() {
    if (!this.gdrive) return 'Not available in this version';
    if (!this.driveConfigured) return 'Needs a one-time setup. Tap to see how.';
    const g = this.gdrive;
    let st = '';
    try {
      st = g.loadError ? 'failed' : g.ready ? 'ready' : g.loading ? 'loading' : '';
    } catch {
      st = '';
    }
    if (st === 'failed') return "Google Drive didn't load. Check your connection, then tap to try again.";
    if (st === 'loading') return 'Getting Google Drive ready…';
    return 'Pick songs from your Drive. TwinSpin only sees the songs you pick.';
  }

  /** The Music server row's second line. */
  serverDetail() {
    if (!this.server) return 'Not available in this version';
    if (this.serverConnected) return `Connected to ${serverLabel(this.server.server)}. Browse and play.`;
    return 'Navidrome or another Subsonic server, for example on a Synology NAS';
  }

  /** Subscribe to the sources (called once by AppUI). */
  bind() {
    const g = this.gdrive;
    if (g && typeof g.on === 'function') {
      this._offs.push(g.on('progress', (p) => this._progress('drive', p)));
      this._offs.push(g.on('error', (msg) => this._sourceError(msg)));
      this._offs.push(g.on('state', () => {
        if (this.onDriveState) this.onDriveState();
      }));
    }
    const s = this.server;
    if (s && typeof s.on === 'function') {
      let wasConnected = this.serverConnected;
      let wasId = this._serverId();
      this._offs.push(s.on('state', () => {
        const now = this.serverConnected;
        const id = this._serverId();
        if (now !== wasConnected || id !== wasId) this.browser.reset();
        wasConnected = now;
        wasId = id;
        this.app.songs.render(); // badges / Save offline of server songs
      }));
      this._offs.push(s.on('error', (msg) => {
        // the connect form shows its own failure, the open browser its status line; elsewhere a toast
        if (this.browser.connecting || this.browser.mounted) return;
        this._sourceError(msg);
      }));
    }
  }

  _serverId() {
    const s = this.server;
    try {
      return s && s.server && s.server.id ? String(s.server.id) : '';
    } catch {
      return '';
    }
  }

  _sourceError(msg) {
    const text = typeof msg === 'string' ? msg : errText(msg, '');
    if (!text) return;
    if (this.job) this.job.errorAt = Date.now();
    this.app.toast(text, { kind: 'error' });
  }

  // ---- sheets -------------------------------------------------------------------------------------------------

  openAddMusic() {
    this.app.sheets.open(addMusicSheet(this.app));
  }

  /** The music server browser (the connect form when not connected). */
  openServer() {
    this.app.sheets.open(this.browser.sheet());
  }

  /** Google's scripts are loaded, so a tap can open the sign-in popup at once (true when the source cannot tell). */
  get driveReady() {
    const g = this.gdrive;
    try {
      return !!g && g.ready !== false;
    } catch {
      return true;
    }
  }

  /**
   * Load Google's scripts when the Add music sheet opens (only when Drive is set up: nothing loads otherwise).
   * Safe to call again: a load that failed is tried again.
   */
  preloadDrive() {
    const g = this.gdrive;
    if (!g || !this.driveConfigured || typeof g.preload !== 'function') return;
    try {
      if (g.ready || g.loading) return;
    } catch {
      /* ask the source anyway */
    }
    let p;
    try {
      p = g.preload();
    } catch (err) {
      p = Promise.reject(err);
    }
    Promise.resolve(p)
      .catch((err) => console.warn('[TwinSpin] Google Drive scripts did not load', err))
      .then(() => {
        if (this.onDriveState) this.onDriveState();
      });
  }

  // ---- imports --------------------------------------------------------------------------------------------------

  /**
   * Google Drive: sign in (Google's popup) and pick songs. MUST run synchronously inside the tap (iPhone blocks a
   * popup that starts after an await). Returns false when nothing started.
   */
  pickDrive() {
    const g = this.gdrive;
    if (!g || typeof g.pick !== 'function') return false;
    const old = this.job;
    if (old) {
      if (old.kind !== 'gdrive' || old.shown) {
        this._busyToast();
        return false;
      }
      // still waiting for Google's sign-in window (it may never answer in an iPhone Home Screen app): ask again;
      // the source drops that earlier pick, which then ends quietly
      old.cancelled = true;
      old.ended = true;
      this.job = null;
    }
    const ctrl = makeCtrl();
    let p;
    try {
      p = g.pick({ signal: ctrl.signal });
    } catch (err) {
      p = Promise.reject(err);
    }
    // the bar shows with the first download progress (the user is still picking until then)
    this._run('gdrive', ctrl, p, { showNow: false, fallback: "Google Drive didn't answer. Check your connection and try again." });
    return true;
  }

  /**
   * Import a public Google Drive song / folder link. Returns { error } for a link that is not a Drive link (the
   * sheet shows it), else { ok: true } and the import runs with the bar. As soon as Google Drive says the link
   * leads to songs (importLink's onInfo), the link is saved on this device (Saved links), also when every song
   * is already in the library; a link that fails before that (not found, not shared) is not saved.
   * @param {string} url
   * @param {{ saved?: object }} [opts] `saved`: the saved link being imported again (its name goes on the bar)
   */
  importDriveLink(url, { saved = null } = {}) {
    const text = String(url || '').trim();
    const g = this.gdrive;
    if (!text) return { error: 'Paste the link first.' };
    let parsed = null;
    try {
      parsed = parseDriveUrl(text);
    } catch {
      parsed = null;
    }
    if (!parsed) return { error: 'That is not a Google Drive link. In Drive use Share > Copy link, then paste it here.' };
    if (!g || typeof g.importLink !== 'function' || !this.driveLinkReady) {
      return { error: 'Google Drive links need the one-time Google setup first.' };
    }
    if (this.job) return { error: 'Another import is still running. Wait for it, or cancel it.' };
    const ctrl = makeCtrl();
    let info = null;
    const onInfo = (i) => {
      if (!i || ctrl.signal.aborted) return;
      info = i;
      this._rememberLink(i);
    };
    let p;
    try {
      p = g.importLink(text, { signal: ctrl.signal, onInfo });
    } catch (err) {
      p = Promise.reject(err);
    }
    const name = saved ? savedLinkName(saved) : '';
    const folder = parsed.kind === 'folder';
    this._run('link', ctrl, p, {
      showNow: true,
      detail: name ? (folder ? `Looking in “${name}”…` : `Getting “${name}”…`) : folder ? 'Looking in the folder…' : 'Getting the song…',
      fallback: "That link couldn't be opened. Check that it is shared with “Anyone with the link”.",
      onFiles: (list) => this._addLinkFiles(list, info || { kind: parsed.kind, name: saved ? saved.name : '' }),
    });
    return { ok: true };
  }

  /** The saved Google Drive links (SavedDriveLinks), or null when this build has none. */
  get driveLinks() {
    const s = (this.app.sources && this.app.sources.driveLinks) || null;
    return s && typeof s.list === 'function' ? s : null;
  }

  /** The saved links, newest used first ([] without the store). */
  savedLinks() {
    const store = this.driveLinks;
    try {
      return store ? store.list() : [];
    } catch {
      return [];
    }
  }

  /**
   * Import a saved link again (Saved links > Import again, the quick rows in Add music): the same import as
   * pasting it, with the bar and Cancel. Returns { ok: true } or { error } like importDriveLink().
   */
  importSavedLink(id) {
    const store = this.driveLinks;
    let link = null;
    try {
      link = store ? store.get(id) : null;
    } catch {
      link = null;
    }
    if (!link || !link.url) return { error: 'That saved link is gone. Paste the link again.' };
    return this.importDriveLink(link.url, { saved: link });
  }

  /** Save a link that leads to songs ({ id, kind, name, songCount, resourceKey } from importLink's onInfo). */
  _rememberLink(info) {
    const store = this.driveLinks;
    if (!store) return null;
    try {
      return store.save({ id: info.id, kind: info.kind, name: info.name, songCount: info.songCount, resourceKey: info.resourceKey });
    } catch (err) {
      console.warn('[TwinSpin] the Drive link could not be saved', err);
      return null;
    }
  }

  /**
   * A link import is done: its songs go in like any import (library, set list, an empty deck), and the toast
   * says what was new: '“Road Trip” · 3 new songs added' or '“Road Trip” · no new songs, all 9 are already in
   * your library'. A saved link the user renamed is named their way.
   */
  _addLinkFiles(list, info) {
    const lib = this.app.library;
    const kind = info && info.kind === 'file' ? 'file' : 'folder';
    let name = info && info.name ? String(info.name) : '';
    try {
      const saved = info && info.id && this.driveLinks ? this.driveLinks.get(info.id) : null;
      if (saved && saved.name) name = saved.name;
    } catch {
      /* the name from Google Drive */
    }
    // which songs the library had before: it must be open first (init() is shared and never rejects)
    return Promise.resolve()
      .then(() => (lib && typeof lib.init === 'function' ? lib.init() : null))
      .catch(() => {})
      .then(() => {
        const before = new Set();
        try {
          for (const e of (lib && lib.list()) || []) if (e && e.id) before.add(e.id);
        } catch {
          /* every song counts as new */
        }
        return this.app.addFiles(list, {
          describe: ({ entries, queued, waiting, deck }) => {
            const ids = new Set((entries || []).map((e) => e && e.id).filter(Boolean));
            if (!ids.size) return ''; // the library failed: the usual words
            let fresh = 0;
            for (const id of ids) if (!before.has(id)) fresh++;
            return linkResultText({ name, kind, total: ids.size, fresh, queued, waiting, deck });
          },
        });
      })
      .catch((err) => console.warn('[TwinSpin] adding the link songs failed', err));
  }

  /** Track an import: progress in the bar, the files into the library (+ set list, + an empty deck) when done. */
  _run(kind, ctrl, promise, { showNow, detail = '', fallback, onFiles = null }) {
    const job = { kind, ctrl, cancelled: false, shown: false, errorAt: 0, p: null };
    this.job = job;
    if (showNow) this._showBar(TITLES[kind] || TITLES.gdrive, detail, null);
    job.p = Promise.resolve(promise).then((files) => {
      this._endJob(job);
      const list = (Array.isArray(files) ? files : []).filter(Boolean);
      // after Cancel the source hands back the songs that had finished: those are kept
      if (!list.length) {
        if (!job.cancelled && kind === 'link' && Date.now() - job.errorAt > 2000) {
          this.app.toast('No songs found behind that link.', { kind: 'error' });
        }
        return undefined;
      }
      if (onFiles) return onFiles(list);
      this.app.addFiles(list);
      return undefined;
    }, (err) => {
      this._endJob(job);
      if (job.cancelled || isAbort(err)) return;
      if (Date.now() - job.errorAt < 2000) return; // the source said why already
      this.app.toast(errText(err, fallback), { kind: 'error' });
    });
    return job.p;
  }

  _busyToast() {
    this.app.toast('An import is still running. Wait for it, or tap Cancel.', { kind: 'error' });
  }

  /** Cancel button of the bar. */
  cancel() {
    const job = this.job;
    if (!job) return;
    job.cancelled = true;
    try {
      job.ctrl.abort();
    } catch {
      /* ignore */
    }
    const g = this.gdrive;
    if ((job.kind === 'gdrive' || job.kind === 'link') && g && typeof g.cancel === 'function') {
      try {
        g.cancel();
      } catch {
        /* ignore */
      }
    }
    this._endJob(job);
    this.app.toast(job.kind === 'offline' ? 'Stopped saving songs' : 'Import cancelled');
  }

  /** The job is over (or cancelled): its bar goes, unless a newer job owns the bar now. */
  _endJob(job) {
    if (job.ended) return;
    job.ended = true;
    if (this.job !== job) return;
    this.job = null;
    this._hideBar();
  }

  /** Source 'progress' events: { done, total, bytes, totalBytes, name }. */
  _progress(from, p) {
    const job = this.job;
    if (!job || job.cancelled) return;
    if (from === 'drive' && job.kind !== 'gdrive' && job.kind !== 'link') return;
    const pr = progressOf(p);
    const detail = progressLine(pr) || (pr.name ? pr.name : '');
    this._showBar(TITLES[job.kind] || TITLES.gdrive, detail, progressFraction(pr), pr.name);
  }

  /**
   * Save music-server songs on this device (library.saveOffline), one after another, with the bar and Cancel.
   * @param {object[]} entries library entries
   */
  async saveOffline(entries) {
    const lib = this.app.library;
    const list = (entries || []).filter((e) => e && needsDownload(e));
    if (!lib || typeof lib.saveOffline !== 'function') {
      this.app.toast('Saving songs needs a newer TwinSpin. Reload the page.', { kind: 'error' });
      return 0;
    }
    if (!list.length) {
      if ((entries || []).length) this.app.toast(entries.length === 1 ? 'That song is already saved on this device.' : 'These songs are already saved on this device.', { kind: 'ok' });
      return 0;
    }
    if (this.job) {
      this._busyToast();
      return 0;
    }
    const ctrl = makeCtrl();
    const job = { kind: 'offline', ctrl, cancelled: false, shown: true, errorAt: 0, p: null };
    this.job = job;
    const totalBytes = list.reduce((s, e) => s + (Number.isFinite(e.size) && e.size > 0 ? e.size : 0), 0);
    let doneBytes = 0;
    let saved = 0;
    let failed = '';
    const show = (cur) => {
      if (this.job !== job) return; // cancelled: the bar stays down
      const pr = { done: saved, total: list.length, bytes: doneBytes + cur, totalBytes, name: '' };
      this._showBar(TITLES.offline, progressLine(pr), progressFraction(pr));
    };
    show(0);
    for (const e of list) {
      if (job.cancelled) break;
      try {
        await lib.saveOffline(e.id, {
          signal: ctrl.signal,
          onProgress: (a, b) => {
            if (!job.cancelled) show(progressOf(a, b).bytes);
          },
        });
        saved++;
      } catch (err) {
        if (job.cancelled || isAbort(err)) break;
        failed = errText(err, "A song couldn't be saved. Check the connection to your music server.");
        break;
      }
      doneBytes += Number.isFinite(e.size) && e.size > 0 ? e.size : 0;
      show(0);
    }
    if (this.job === job) this._endJob(job);
    if (failed) this.app.toast(failed, { kind: 'error' });
    else if (!job.cancelled) {
      this.app.toast(saved === 1 ? `Saved “${songTitle(list[0])}” on this device` : `Saved ${countWord(saved, 'song')} on this device`, { kind: 'ok' });
    }
    return saved;
  }

  // ---- music-server songs loading on a deck ----------------------------------------------------------------------

  /**
   * TrackLoader: a music-server song starts downloading for deck `i`. Returns { signal, onProgress } for
   * library.getBlob; a newer load on the same deck cancels the older download.
   */
  startDeckDownload(i, entry) {
    this.endDeckDownload(i, true);
    const ctrl = makeCtrl();
    const d = { entryId: entry.id, title: songTitle(entry), p: { done: 0, total: 0, bytes: 0, totalBytes: entry.size || 0 }, ctrl };
    this.decks[i] = d;
    this._markDeck(i);
    return {
      signal: ctrl.signal,
      onProgress: (a, b) => {
        if (this.decks[i] !== d) return;
        const pr = progressOf(a, b);
        d.p = { ...pr, totalBytes: pr.totalBytes || d.p.totalBytes };
        this._markDeck(i);
      },
      done: () => {
        if (this.decks[i] === d) this.endDeckDownload(i, false);
      },
    };
  }

  /** The download for deck `i` is over (or replaced: abort it). */
  endDeckDownload(i, abort) {
    const d = this.decks[i];
    if (!d) return;
    this.decks[i] = null;
    if (abort) {
      try {
        d.ctrl.abort();
      } catch {
        /* ignore */
      }
    }
    this._markDeck(i);
  }

  /** { title, p } of a running deck download, or null. */
  deckDownload(i) {
    return this.decks[i] || null;
  }

  _markDeck(i) {
    const u = this.app.deckUIs && this.app.deckUIs[i];
    if (u && typeof u.markDirty === 'function') u.markDirty();
    if (this.app.playerUI) this.app.playerUI.markDirty();
  }

  // ---- the import bar -------------------------------------------------------------------------------------------

  _buildBar() {
    this.barIco = icon('cloud', 'ib-ico');
    this.barTitle = h('span.ib-title', { text: '' });
    this.barDetail = h('span.ib-detail', { text: '' });
    this.barFill = h('span.ib-fill');
    this.barTrack = h('span.ib-track', { role: 'progressbar', 'aria-label': 'Progress', 'aria-valuemin': '0', 'aria-valuemax': '100' },
      this.barFill);
    this.barCancel = h('button.ib-cancel', { type: 'button' }, h('span', { text: 'Cancel' }));
    this.barCancel.addEventListener('click', () => this.cancel());
    this.bar = h('div.import-bar', { hidden: true, role: 'group', 'aria-label': 'Import' }, this.barIco,
      h('div.ib-main', {}, this.barTitle, this.barDetail, this.barTrack), this.barCancel);
    const host = this.app.toasts && this.app.toasts.el;
    if (host) host.prepend(this.bar);
    else if (this.app.overlay) this.app.overlay.append(this.bar);
  }

  _showBar(title, detail, fraction, name) {
    this._last = { title, detail, fraction, name };
    if (this.job) this.job.shown = true;
    if (this.bar.hidden) {
      this.bar.hidden = false;
      const kind = this.job ? this.job.kind : '';
      this.bar.dataset.kind = kind;
      setAttr(this.barCancel, 'aria-label', kind === 'offline' ? 'Stop saving songs' : 'Cancel the import');
      // tell screen readers once, not on every progress step
      try {
        this.app.toasts.live.textContent = title;
      } catch {
        /* ignore */
      }
    }
    if (this._raf) return;
    const paint = () => {
      this._raf = 0;
      const l = this._last;
      if (!l || this.bar.hidden) return;
      setText(this.barTitle, l.title);
      setText(this.barDetail, l.detail || l.name || '');
      const f = l.fraction;
      this.barTrack.classList.toggle('indeterminate', f == null);
      this.barFill.style.setProperty('--p', f == null ? '0.3' : String(f));
      setAttr(this.barTrack, 'aria-valuenow', f == null ? null : String(Math.round(f * 100)));
    };
    if (typeof requestAnimationFrame === 'function') this._raf = requestAnimationFrame(paint);
    else paint();
  }

  _hideBar() {
    this.bar.hidden = true;
    this._last = null;
  }

  destroy() {
    for (const off of this._offs) {
      if (typeof off === 'function') off();
    }
    this._offs = [];
    if (this._raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._raf);
    this._raf = 0;
    for (let i = 0; i < this.decks.length; i++) this.endDeckDownload(i, true);
  }
}

/** An AbortController, or a stand-in where there is none (very old browsers, tests). */
function makeCtrl() {
  if (typeof AbortController === 'function') return new AbortController();
  const fns = new Set();
  const signal = {
    aborted: false,
    onabort: null,
    addEventListener(type, fn) {
      if (type === 'abort' && typeof fn === 'function') fns.add(fn);
    },
    removeEventListener(type, fn) {
      fns.delete(fn);
    },
  };
  return {
    signal,
    abort() {
      if (signal.aborted) return;
      signal.aborted = true;
      const ev = { type: 'abort', target: signal };
      if (typeof signal.onabort === 'function') signal.onabort(ev);
      for (const fn of [...fns]) fn(ev);
    },
  };
}
