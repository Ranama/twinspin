// Track loading for the app UI: files picked or dropped for a deck, "Add music" (library + end of the set list +
// first empty deck), library rows, set list rows, demo tracks, the load lock ("Deck A is playing. Replace the
// song?"), and writing analysis results (BPM, duration, first beat) back to the library entry.
//   const loader = new TrackLoader(app);  loader.loadFiles(0, files);  loader.loadFromLibrary(1, entry);
// The Deck reports its own load errors ('error' events -> toasts) and the Library explains skipped non-audio
// files; this only adds a fallback toast when a load fails without one.

import { songTitle } from './format.js';
import { looksLikeAudio } from '../audio/decode.js';

export class TrackLoader {
  /** @param {object} app the AppUI (engine, decks, library, dialog, toast(), lastDeckError) */
  constructor(app) {
    this.app = app;
    this.libIds = [null, null]; // library id of the song each deck is loading/playing (files from this device)
    this.loadToken = [0, 0]; // bumps on every load so late library results never tag a newer song
    this.libMetaKey = {};
  }

  _audioReady() {
    const eng = this.app.engine;
    if (eng && eng.ready) return true;
    this.app.toast('Tap Start first so TwinSpin can play sound.', { kind: 'error' });
    return false;
  }

  /** Load lock: ask before replacing a song that is playing and audible. */
  async confirmReplace(deck) {
    if (!(deck && deck.track && deck.playing && deck.audible)) return true;
    return this.app.dialog.confirm({
      title: 'Replace the song?',
      message: `Deck ${deck.id} is playing. Replace the song?`,
      ok: 'Replace', cancel: 'Keep playing', danger: true,
    });
  }

  /** Files picked or dropped for a deck: the first song loads there, all songs go into the library. */
  async loadFiles(index, files) {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) return;
    const songs = list.filter(looksLikeAudio);
    if (!songs.length) {
      this._addToLibrary(list); // the library says what was skipped ('error' -> toast)
      return;
    }
    if (!this._audioReady()) {
      this._addToLibrary(list).then((entries) => this._savedToast(entries, songs));
      return;
    }
    const deck = this.app.decks[index];
    const ok = await this.confirmReplace(deck);
    const addP = this._addToLibrary(list);
    if (!ok) {
      addP.then((entries) => this._savedToast(entries, songs));
      return;
    }
    const first = songs[0];
    const token = ++this.loadToken[index];
    this.libIds[index] = null;
    this._loadDeck(index, () => deck.loadFile(first));
    addP.then((entries) => {
      if (this.loadToken[index] !== token) return;
      const e = this._findEntry(entries, first);
      if (e) {
        this.libIds[index] = e.id;
        this.syncLibraryMeta(index);
      }
      if (songs.length > 1) this.app.toast(`Added ${songs.length} songs to your library`, { kind: 'ok' });
    });
  }

  /**
   * "Add music" / a drop outside the decks: save to the library, append the songs to the end of the set list,
   * and load the first song into an empty deck (not while Auto Mix is on: it loads the decks itself).
   */
  addFiles(files) {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) return;
    const app = this.app;
    const songs = list.filter(looksLikeAudio);
    const addP = this._addToLibrary(list);
    if (!songs.length) return; // the library says what was skipped
    const toSetList = !!app.playlist;
    let loadedOn = -1;
    if (app.engine && app.engine.ready && !(app.automix && app.automix.enabled)) {
      loadedOn = app.decks.findIndex((d) => d && !d.track && !d.loading);
      if (loadedOn >= 0) {
        const i = loadedOn;
        const token = ++this.loadToken[i];
        const deck = app.decks[i];
        this.libIds[i] = null;
        this._loadDeck(i, () => deck.loadFile(songs[0]));
        addP.then((entries) => {
          if (this.loadToken[i] !== token) return;
          const e = this._findEntry(entries, songs[0]);
          if (e) {
            this.libIds[i] = e.id;
            this.syncLibraryMeta(i);
          }
        });
      }
    }
    addP.then((entries) => {
      const n = entries.length || songs.length;
      const what = n === 1 ? `“${songTitle(entries[0] || { fileName: songs[0].name })}”` : `${n} songs`;
      let added = 0;
      if (toSetList && entries.length) added = app.addToSetList(entries, { quiet: true });
      const where = loadedOn >= 0 ? `, loading on deck ${loadedOn ? 'B' : 'A'}` : '';
      const sl = added ? ' to your songs and the set list' : '';
      app.toast(`Added ${what}${sl}${where}`, { kind: 'ok' });
    });
  }

  /** A set list row's A / B button (Auto Mix off: the set list is a queue to load from by hand). */
  async loadSetListItem(index, item) {
    if (!item) return;
    if (item.kind === 'demo') {
      await this.loadDemo(index, item.id);
      return;
    }
    let entry = null;
    try {
      entry = (this.app.library.list() || []).find((e) => e && e.id === item.id) || null;
    } catch {
      entry = null;
    }
    if (!entry) {
      this.app.toast(`“${songTitle(item)}” is no longer stored on this device. Add it again.`, { kind: 'error' });
      return;
    }
    await this.loadFromLibrary(index, entry);
  }

  /** A library row's A / B button. */
  async loadFromLibrary(index, entry) {
    if (!entry || !this._audioReady()) return;
    const app = this.app;
    const deck = app.decks[index];
    if (!(await this.confirmReplace(deck))) return;
    let blob = null;
    try {
      blob = await app.library.getBlob(entry.id);
    } catch {
      blob = null;
    }
    if (!blob) {
      app.toast(`“${songTitle(entry)}” is no longer stored on this device. Add it again.`, { kind: 'error' });
      return;
    }
    ++this.loadToken[index];
    this.libIds[index] = entry.id;
    // the 60-song cap removes the least recently used songs first
    Promise.resolve()
      .then(() => app.library.update(entry.id, { lastUsedAt: Date.now() }))
      .catch(() => {});
    const meta = {
      title: entry.title || songTitle(entry), artist: entry.artist || '', fileName: entry.fileName || '', libraryId: entry.id,
    };
    this._loadDeck(index, () => deck.loadFile(blob, meta));
  }

  /** A demo row's A / B button. */
  async loadDemo(index, id) {
    if (!this._audioReady()) return;
    const deck = this.app.decks[index];
    if (!(await this.confirmReplace(deck))) return;
    ++this.loadToken[index];
    this.libIds[index] = null;
    this._loadDeck(index, () => deck.loadDemo(id));
  }

  /** "Try the demo tracks": demo 0 on deck A, demo 1 on deck B (waits for the decks to attach). */
  loadDemos() {
    this.app.decks.forEach((deck, i) => {
      waitFor(() => !!deck && deck.ready !== false, 5000).then(() => {
        ++this.loadToken[i];
        this.libIds[i] = null;
        this._loadDeck(i, () => deck.loadDemo(i));
      });
    });
  }

  /** Store the analysed BPM / duration / first beat on the deck's library entry (once per change). */
  syncLibraryMeta(i) {
    const app = this.app;
    const d = app.decks[i];
    const t = d && d.track;
    const lib = app.library;
    if (!t || !lib || typeof lib.update !== 'function') return;
    const id = t.libraryId || (t.source !== 'demo' ? this.libIds[i] : null);
    if (!id) return;
    const patch = {};
    if (d.bpm > 0) patch.bpm = d.bpm;
    if (t.duration > 0) patch.duration = t.duration;
    if (Number.isFinite(t.firstBeat)) patch.firstBeat = t.firstBeat;
    if (!Object.keys(patch).length) return;
    const key = JSON.stringify(patch);
    if (this.libMetaKey[id] === key) return;
    this.libMetaKey[id] = key;
    Promise.resolve()
      .then(() => lib.update(id, patch))
      .catch(() => {});
  }

  _savedToast(entries, files) {
    if (!entries || !entries.length) return;
    const first = entries[0] || { fileName: files && files[0] ? files[0].name : '' };
    const what = entries.length === 1 ? `“${songTitle(first)}”` : `${entries.length} songs`;
    this.app.toast(`Saved ${what} to your songs`, { kind: 'ok' });
  }

  _addToLibrary(list) {
    const lib = this.app.library;
    if (!lib || typeof lib.add !== 'function') return Promise.resolve([]);
    return Promise.resolve()
      .then(() => lib.add(list))
      .then((r) => (Array.isArray(r) ? r.filter(Boolean) : r ? [r] : []))
      .catch((err) => {
        console.warn('[TwinSpin] library add failed', err);
        return [];
      });
  }

  _findEntry(entries, file) {
    const match = (e) => e && (e.fileName === file.name || e.name === file.name) && (!Number.isFinite(e.size) || e.size === file.size);
    let e = (entries || []).find(match);
    if (!e) {
      try {
        e = (this.app.library.list() || []).find(match);
      } catch {
        e = null;
      }
    }
    return e || null;
  }

  _loadDeck(index, run) {
    const app = this.app;
    let p;
    try {
      p = run();
    } catch (err) {
      p = Promise.reject(err);
    }
    Promise.resolve(p).catch((err) => {
      console.warn('[TwinSpin] load failed', err);
      if (Date.now() - (app.lastDeckError[index] || 0) > 1500) {
        app.toast("That song couldn't be loaded. Try an MP3 or WAV file.", { kind: 'error', deck: index ? 'B' : 'A' });
      }
    });
  }
}

/** Resolve once cond() is true (polling every 50 ms) or after timeoutMs. */
export function waitFor(cond, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      let ok = false;
      try {
        ok = !!cond();
      } catch {
        ok = false;
      }
      if (ok || Date.now() - t0 > timeoutMs) resolve(ok);
      else setTimeout(tick, 50);
    };
    tick();
  });
}
