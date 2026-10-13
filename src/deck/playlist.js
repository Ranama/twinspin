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
// The set list is also the music player's queue (docs/PLAYER.md section 2):
//   playlist.addNext(entry);          // "Play next": right after the current song (add() = "Add to queue")
//   playlist.setShuffle(true);        // the UPCOMING songs in random order (settings.playerShuffle)
//   playlist.setShuffle(false);       // back to the order they had before (songs added meanwhile at the end)
//   playlist.previous();  playlist.rewind();  playlist.peekNext({ repeat: 'all' | 'one' });
//   playlist.reshuffle();             // shuffle on: the upcoming songs in a new random order (repeat all, a new round)
// While shuffle is on, add() puts each new song at a random upcoming position and addNext() right next. The
// order from before shuffling is remembered in memory only: after a reload, shuffle off keeps the order.
// Shuffling uses a seedable PRNG (`random` option, default mulberry32 with a random seed), so tests are exact.
// Contract: docs/AUTOMIX.md section 4.3, docs/PLAYER.md section 2.

import { Emitter } from '../core/emitter.js';
import { mulberry32 } from '../core/util.js';
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

/** A seed for the default shuffle PRNG (any 32-bit value; tests pass their own `random`). */
function randomSeed() {
  return (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
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
   * @param {{ settings?: import('../core/settings.js').Settings, library?: import('../library/library.js').Library,
   *   random?: () => number }} deps settings for persistence (settings.setList, settings.playerShuffle), library
   *   for titles / BPM / duration and blobs, random: a PRNG returning [0, 1) for shuffling (tests: mulberry32(seed))
   */
  constructor({ settings = null, library = null, random = null } = {}) {
    super();
    this.settings = settings;
    this.library = library;
    /** @type {object[]} */
    this._items = [];
    this._view = Object.freeze([]);
    this._cur = null;            // uid of the current song
    this._saving = false;
    this._sawLibraryChange = false;
    this._rand = typeof random === 'function' ? random : mulberry32(randomSeed());
    this._shuffle = this._setting('playerShuffle') === true;
    this._order = null;          // uids in the order before shuffling (null: nothing remembered)
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
        } else if (key === 'playerShuffle' && !this._saving) {
          this.setShuffle(value === true); // changed elsewhere (Settings sheet, Reset all settings)
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

  /**
   * The song after the current one (the first song when none is current), or null at the end.
   * opts.repeat 'all': the first song after the last one; 'one': the current song itself.
   * @param {{ repeat?: 'off'|'all'|'one' }} [opts]
   */
  peekNext(opts) {
    const repeat = opts && opts.repeat;
    const i = this.currentIndex;
    if (repeat === 'one' && i >= 0) return this._items[i];
    const next = this._items[i + 1] || null;
    if (next || repeat !== 'all') return next;
    return this._items[0] || null;
  }

  /** Upcoming songs are in random order (settings.playerShuffle). */
  get shuffle() {
    return this._shuffle;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Changes

  /**
   * Add songs (one entry or an array): library entries, library demo entries, { kind: 'demo', id } or
   * { kind: 'library', id }. Duplicates are allowed on purpose. opts.at inserts at that index (default: the end;
   * while shuffle is on, each song goes to a random upcoming position instead).
   * @returns {object[]} the new items
   */
  add(entries, { at } = {}) {
    const added = this._newItems(entries);
    if (!added.length) return [];
    const n = this._items.length;
    if (Number.isFinite(at)) {
      this._items.splice(Math.max(0, Math.min(n, Math.floor(at))), 0, ...added);
    } else if (this._shuffle) {
      for (const it of added) {
        const lo = this.currentIndex + 1;
        const span = this._items.length - lo + 1;
        this._items.splice(lo + Math.min(span - 1, Math.floor(this._rand() * span)), 0, it);
      }
    } else {
      this._items.push(...added);
    }
    this._changed(true);
    return added;
  }

  /**
   * "Play next": add songs right after the current one (at the top when none is current), in the given order,
   * shuffle or not. @returns {object[]} the new items
   */
  addNext(entries) {
    return this.add(entries, { at: this.currentIndex + 1 });
  }

  /**
   * Shuffle on: the songs after the current one go into random order (the order before is remembered).
   * Shuffle off: the songs still upcoming go back into that order; songs added meanwhile follow them at the end.
   * Saved in settings.playerShuffle. Returns true when something changed.
   */
  setShuffle(on) {
    const want = !!on;
    if (want === this._shuffle) return false;
    this._shuffle = want;
    if (want) {
      this._order = this._items.map((it) => it.uid);
      this._shuffleUpcoming();
    } else {
      this._unshuffle();
      this._order = null;
    }
    this._save('playerShuffle', want);
    this._changed(true);
    return true;
  }

  /**
   * While shuffle is on: the songs after the current one in a new random order (Auto Mix calls it when repeat all
   * starts the list over, so every round sounds different). The order from before shuffling is still the one
   * shuffle off goes back to. Returns true when it shuffled.
   */
  reshuffle() {
    if (!this._shuffle || this._items.length - (this.currentIndex + 1) < 2) return false;
    this._shuffleUpcoming();
    this._changed(true);
    return true;
  }

  /** Fisher-Yates over the songs after the current one. */
  _shuffleUpcoming() {
    const lo = this.currentIndex + 1;
    for (let i = this._items.length - 1; i > lo; i--) {
      const j = lo + Math.floor(this._rand() * (i - lo + 1));
      const t = this._items[i];
      this._items[i] = this._items[j];
      this._items[j] = t;
    }
  }

  /** The upcoming songs back in the remembered order; songs it does not know keep their order at the end. */
  _unshuffle() {
    const order = this._order;
    if (!order) return;
    const rank = new Map();
    order.forEach((uid, i) => rank.set(uid, i));
    const lo = this.currentIndex + 1;
    const up = this._items.slice(lo);
    const known = up.filter((it) => rank.has(it.uid)).sort((a, b) => rank.get(a.uid) - rank.get(b.uid));
    const added = up.filter((it) => !rank.has(it.uid));
    this._items = this._items.slice(0, lo).concat(known, added);
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

  /**
   * Remove several songs at once (one save, one 'change'); the current song is handled like remove().
   * @param {string[]} uids
   * @returns {number} how many were removed
   */
  removeMany(uids) {
    const gone = new Set(Array.isArray(uids) ? uids : []);
    if (!gone.size) return 0;
    let cur = this._cur;
    if (cur !== null && gone.has(cur)) {
      // like remove(): the nearest song before it that stays becomes current
      let i = this.indexOf(cur) - 1;
      while (i >= 0 && gone.has(this._items[i].uid)) i--;
      cur = i >= 0 ? this._items[i].uid : null;
    }
    const kept = this._items.filter((it) => !gone.has(it.uid));
    const n = this._items.length - kept.length;
    if (!n) return 0;
    this._items = kept;
    this._cur = cur;
    this._changed(true);
    return n;
  }

  /** "Clear queue": remove every song after the current one (all of them when none is current). */
  clearUpcoming() {
    return this.removeMany(this._items.slice(this.currentIndex + 1).map((it) => it.uid));
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

  /** Step back: the song before the current one becomes current and is returned; null at the top (no change). */
  previous() {
    const i = this.currentIndex;
    if (i <= 0) return null;
    const it = this._items[i - 1];
    this._cur = it.uid;
    this._changed(false);
    return it;
  }

  /** Repeat all: every song counts as unplayed again and the first one is current (returned; null when empty). */
  rewind() {
    const first = this._items[0] || null;
    const uid = first ? first.uid : null;
    if (uid !== this._cur) {
      this._cur = uid;
      this._changed(false);
    }
    return first;
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
    if (save) this._save('setList', this._items.map((it) => ({ kind: it.kind, id: it.id })));
    this.emit('change');
  }

  /** settings.set without hearing our own change back; a missing or broken store just means no saving. */
  _save(key, value) {
    if (!this.settings || typeof this.settings.set !== 'function') return;
    this._saving = true;
    try {
      this.settings.set(key, value);
    } catch (err) {
      console.warn(`[TwinSpin] ${key} could not be saved`, err);
    } finally {
      this._saving = false;
    }
  }

  /** Items for add() / addNext(): valid entries only, up to the cap. */
  _newItems(entries) {
    const list = Array.isArray(entries) ? entries : [entries];
    const room = MAX_SET_LIST - this._items.length;
    const added = [];
    for (const e of list) {
      if (added.length >= room) break;
      const ref = itemRef(e);
      if (!ref) continue;
      added.push(this._makeItem(newUid(), ref, e));
    }
    return added;
  }
}
