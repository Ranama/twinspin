// The SET LIST: an ordered queue of songs (the user's library songs and the demo tracks) that Auto Mix plays from
// top to bottom, and that the user can also load from by hand. A pure model (no DOM, no audio) that persists
// itself as [{ kind, id }] in settings.setList and keeps titles / BPM / duration up to date from the library.
//   const playlist = new Playlist({ settings, library });
//   playlist.add(library.list().slice(0, 3));            // library entries (demo entries work too)
//   playlist.add({ kind: 'demo', id: 1 }, { at: 0 });    // insert at the top
//   playlist.move(item.uid, 2);  playlist.remove(item.uid);  playlist.clear();
//   playlist.setCurrent(item.uid);  playlist.peekNext();  playlist.advance();  playlist.isPlayed(uid);
//   playlist.on('change', render);                       // any change of items, order or the current song
// Items are frozen objects { uid, kind: 'library'|'demo', id, title, artist, bpm?, duration? } (a new object when
// their details change). The same song may be in the list more than once (each copy has its own uid).
// `currentIndex` is the song Auto Mix is playing (-1 = none yet); songs above it count as played. The current
// song is remembered by uid, so moving songs around keeps it; removing it makes the song before it current, so
// the song that followed it is still next. The current position is not saved (a reload starts at the top).
// Saved library songs are dropped from the list when the library no longer has them, but only after the
// library has read its stored list (library.loaded), so a slow IndexedDB never empties the set list.
// Contract: docs/AUTOMIX.md section 4.3.

import { Emitter } from '../core/emitter.js';
import { DEMO_TRACKS } from '../audio/demo-synth.js';

/** Length of the synthesised demo tracks (demo-synth.js default). */
const DEMO_SECONDS = 96;
/** Most songs the set list holds. */
export const MAX_SET_LIST = 200;

let uidSeq = 0;
function newUid() {
  uidSeq = (uidSeq + 1) % 1679616;
  return `sl${uidSeq.toString(36)}${Math.floor(Math.random() * 1679616).toString(36)}`;
}

/** "Artist - Title.mp3" -> "Artist - Title" (underscores to spaces), '' for nothing. */
export function titleFromFileName(name) {
  return String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' ').trim();
}

function demoById(id) {
  return DEMO_TRACKS.find((d) => d.id === id) || null;
}

/**
 * A reference { kind, id } from anything the UI may hand over: a library entry ({ id, title, ... }), a library
 * demo entry ({ demo: true, demoId } or id 'demo-<n>'), { kind: 'demo', id } or { kind: 'library', id }.
 * Returns null for something unusable.
 */
export function itemRef(entry) {
  if (!entry || typeof entry !== 'object') return null;
  let kind = entry.kind;
  let id = entry.id;
  if (kind !== 'demo' && kind !== 'library') {
    if (entry.demo || entry.source === 'demo' || Number.isFinite(entry.demoId)) {
      kind = 'demo';
      id = Number.isFinite(entry.demoId) ? entry.demoId : id;
    } else {
      kind = 'library';
    }
  }
  if (kind === 'demo') {
    if (typeof id === 'string') id = Number(id.replace(/^demo-/, ''));
    return Number.isInteger(id) && demoById(id) ? { kind: 'demo', id } : null;
  }
  if (typeof id === 'string' && /^demo-\d+$/.test(id)) return itemRef({ kind: 'demo', id });
  return typeof id === 'string' && id ? { kind: 'library', id } : null;
}

export class Playlist extends Emitter {
  /**
   * @param {{ settings?: import('../core/settings.js').Settings, library?: import('../library/library.js').Library }}
   *   deps settings for persistence (settings.setList), library for titles / BPM / duration and blobs
   */
  constructor({ settings = null, library = null } = {}) {
    super();
    this.settings = settings;
    this.library = library;
    /** @type {object[]} */
    this._items = [];
    this._view = Object.freeze([]);
    this._cur = null;            // uid of the current song
    this._saving = false;
    this._sawLibraryChange = false;
    this._restore(this._setting('setList'));
    if (library && typeof library.on === 'function') {
      library.on('change', () => {
        this._sawLibraryChange = true;
        this._onLibrary();
      });
    }
    if (settings && typeof settings.on === 'function') {
      settings.on('change', (key, value) => {
        if (key === 'setList' && !this._saving) {
          this._restore(value);
          this._changed(false);
        }
      });
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // State

  /** The songs in play order (a frozen array, replaced on every change). */
  get items() {
    return this._view;
  }

  get length() {
    return this._items.length;
  }

  /** Index of the song Auto Mix is playing, -1 when none. */
  get currentIndex() {
    return this._cur === null ? -1 : this._items.findIndex((it) => it.uid === this._cur);
  }

  /** The current item or null. */
  get current() {
    const i = this.currentIndex;
    return i >= 0 ? this._items[i] : null;
  }

  /** The item with this uid, or null. */
  get(uid) {
    return this._items.find((it) => it.uid === uid) || null;
  }

  indexOf(uid) {
    return this._items.findIndex((it) => it.uid === uid);
  }

  /** True for songs above the current one (already played in this set). */
  isPlayed(uid) {
    const i = this.indexOf(uid);
    return i >= 0 && i < this.currentIndex;
  }

  /** The song after the current one (the first song when none is current), or null at the end. */
  peekNext() {
    return this._items[this.currentIndex + 1] || null;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Changes

  /**
   * Add songs (one entry or an array): library entries, library demo entries, { kind: 'demo', id } or
   * { kind: 'library', id }. Duplicates are allowed on purpose. opts.at inserts at that index (default: the end).
   * @returns {object[]} the new items
   */
  add(entries, { at } = {}) {
    const list = Array.isArray(entries) ? entries : [entries];
    const room = MAX_SET_LIST - this._items.length;
    const added = [];
    for (const e of list) {
      if (added.length >= room) break;
      const ref = itemRef(e);
      if (!ref) continue;
      added.push(this._makeItem(newUid(), ref, e));
    }
    if (!added.length) return [];
    const n = this._items.length;
    const i = Number.isFinite(at) ? Math.max(0, Math.min(n, Math.floor(at))) : n;
    this._items.splice(i, 0, ...added);
    this._changed(true);
    return added;
  }

  /** Remove one song. Removing the current song makes the one before it current (the next stays next). */
  remove(uid) {
    const i = this.indexOf(uid);
    if (i < 0) return false;
    if (this._cur === uid) this._cur = i > 0 ? this._items[i - 1].uid : null;
    this._items.splice(i, 1);
    this._changed(true);
    return true;
  }

  /** Move a song to position `toIndex` (clamped). The current song stays current wherever it ends up. */
  move(uid, toIndex) {
    const i = this.indexOf(uid);
    if (i < 0 || !Number.isFinite(toIndex)) return false;
    const j = Math.max(0, Math.min(this._items.length - 1, Math.floor(toIndex)));
    if (i === j) return false;
    const [it] = this._items.splice(i, 1);
    this._items.splice(j, 0, it);
    this._changed(true);
    return true;
  }

  /** Empty the set list. */
  clear() {
    if (!this._items.length && this._cur === null) return;
    this._items = [];
    this._cur = null;
    this._changed(true);
  }

  /**
   * Mark the song Auto Mix is playing: a uid, an index, or -1 / null for none (the next song is then the
   * first one).
   */
  setCurrent(uidOrIndex) {
    let uid = null;
    if (typeof uidOrIndex === 'string') uid = this.get(uidOrIndex) ? uidOrIndex : null;
    else if (Number.isInteger(uidOrIndex) && uidOrIndex >= 0 && uidOrIndex < this._items.length) uid = this._items[uidOrIndex].uid;
    if (uid === this._cur) return;
    this._cur = uid;
    this._changed(false);
  }

  /** Step to the next song: it becomes current and is returned; null at the end (nothing changes then). */
  advance() {
    const next = this.peekNext();
    if (!next) return null;
    this._cur = next.uid;
    this._changed(false);
    return next;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Internals

  _setting(key) {
    try {
      return this.settings && typeof this.settings.get === 'function' ? this.settings.get(key) : undefined;
    } catch {
      return undefined;
    }
  }

  _libraryLoaded() {
    const lib = this.library;
    if (!lib) return false;
    return typeof lib.loaded === 'boolean' ? lib.loaded : this._sawLibraryChange;
  }

  /** The library entry for an id (a copy), or null. */
  _libEntry(id) {
    const lib = this.library;
    if (!lib) return null;
    try {
      if (typeof lib.get === 'function') {
        const e = lib.get(id);
        if (e) return e;
      }
      if (typeof lib.list === 'function') return (lib.list() || []).find((x) => x && x.id === id) || null;
    } catch {
      /* a broken library just means no details */
    }
    return null;
  }

  /** A frozen item with the best details we have (the library entry, the demo list, else `hint`). */
  _makeItem(uid, ref, hint) {
    const it = { uid, kind: ref.kind, id: ref.id, title: '', artist: '' };
    if (ref.kind === 'demo') {
      const d = demoById(ref.id);
      it.title = d.title;
      it.artist = d.artist;
      it.bpm = d.bpm;
      it.duration = DEMO_SECONDS;
      return Object.freeze(it);
    }
    const e = this._libEntry(ref.id) || hint || {};
    it.title = (typeof e.title === 'string' && e.title) || titleFromFileName(e.fileName) || 'Untitled';
    it.artist = typeof e.artist === 'string' ? e.artist : '';
    if (Number.isFinite(e.bpm) && e.bpm > 0) it.bpm = e.bpm;
    if (Number.isFinite(e.duration) && e.duration > 0) it.duration = e.duration;
    return Object.freeze(it);
  }

  /** Rebuild the list from saved [{ kind, id }] (constructor, or settings changed from outside, e.g. reset). */
  _restore(saved) {
    const list = Array.isArray(saved) ? saved.slice(0, MAX_SET_LIST) : [];
    const items = [];
    for (const s of list) {
      const ref = itemRef(s && typeof s === 'object' ? { kind: s.kind, id: s.id } : null);
      if (ref) items.push(this._makeItem(newUid(), ref, null));
    }
    this._items = items;
    if (this._cur !== null && !this.get(this._cur)) this._cur = null;
    if (this._libraryLoaded()) this._dropMissing();
    this._view = Object.freeze(this._items.slice());
  }

  /** Library songs that are gone (removed, or pushed out by the 60-song cap) leave the set list. */
  _dropMissing() {
    let changed = false;
    for (let i = this._items.length - 1; i >= 0; i--) {
      const it = this._items[i];
      if (it.kind !== 'library' || this._libEntry(it.id)) continue;
      if (this._cur === it.uid) this._cur = i > 0 ? this._items[i - 1].uid : null;
      this._items.splice(i, 1);
      changed = true;
    }
    return changed;
  }

  _onLibrary() {
    let changed = this._libraryLoaded() ? this._dropMissing() : false;
    let details = false;
    for (let i = 0; i < this._items.length; i++) {
      const it = this._items[i];
      if (it.kind !== 'library') continue;
      const e = this._libEntry(it.id);
      if (!e) continue;
      const fresh = this._makeItem(it.uid, it, e);
      if (fresh.title !== it.title || fresh.artist !== it.artist || fresh.bpm !== it.bpm || fresh.duration !== it.duration) {
        this._items[i] = fresh;
        details = true;
      }
    }
    if (changed) this._changed(true);
    else if (details) this._changed(false);
  }

  /** Publish a new items view, save when the order or contents changed, emit 'change'. */
  _changed(save) {
    this._view = Object.freeze(this._items.slice());
    if (save && this.settings && typeof this.settings.set === 'function') {
      this._saving = true;
      try {
        this.settings.set('setList', this._items.map((it) => ({ kind: it.kind, id: it.id })));
      } catch (err) {
        console.warn('[TwinSpin] set list could not be saved', err);
      } finally {
        this._saving = false;
      }
    }
    this.emit('change');
  }
}
