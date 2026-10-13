// The music player: a thin, UI-agnostic facade over the set list (the queue) and Auto Mix (all audio work stays in
// AutoMix), plus the Media Session API (lock screen / headset / OS media controls) where the browser has it.
//   const player = new Player({ automix, playlist, decks, engine, settings, library });
//   player.toggle();  player.next();  player.previous();  player.seek(42);  player.jumpTo(item.uid);
//   player.setShuffle(true);  player.cycleRepeat();  player.setTransition('crossfade');  player.setCrossfadeSec(8);
//   player.playNow(entry);  player.playNext(entry);  player.addToQueue(entry);  player.clearQueue();
//   player.on('change', (what) => ...);  // 'state' | 'track' | 'queue' | 'mode' | 'transport' | 'next' | 'plan'
//                                        // | 'mix' | 'progress'
//   // read every frame: state, nowPlaying, position, duration (cheap getters, cached objects)
// state: 'stopped' (Auto Mix off) | 'loading' (the first song or a song skipped to is loading) | 'playing' |
// 'mixing' (a transition runs; nowPlaying is still the song being mixed out) | 'paused'.
// nowPlaying: the song playing now; while stopped the song play() would start (the set list's current song, or
// the first unplayed one), or the song a deck plays by hand. upNext / history: the set list after / before it
// (history most recent first). shuffle / repeat / transition live in settings (playerShuffle, playerRepeat,
// transitionStyle, crossfadeSec), so the Settings sheet and the player always agree.
// Media Session: metadata (title, artist, album 'TwinSpin', the app icon as artwork), playbackState,
// setPositionState and the play / pause / previoustrack / nexttrack / seekto handlers. Every call is guarded (the
// API is missing in JsCheck, older browsers and some WebViews; an unsupported action just is not offered).
// Contract: docs/PLAYER.md section 4.

import { Emitter } from '../core/emitter.js';
import { clamp, hashHue } from '../core/util.js';
import {
  TRANSITION_STYLES, CROSSFADE_MIN, CROSSFADE_MAX, transitionStyleOf, crossfadeSecondsOf,
} from './automix-plan.js';
import { trackIs, deckHolding, playingDeck } from './automix-deck.js';

const REPEATS = Object.freeze(['off', 'all', 'one']);
const EMPTY = Object.freeze([]);
const ALBUM = 'TwinSpin';
/** Media Session artwork: the app icon (relative to the page, so it works under any GitHub Pages path). */
export const PLAYER_ARTWORK = Object.freeze([
  Object.freeze({ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }),
  Object.freeze({ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }),
]);
const SETTING_KEYS = new Set(['playerShuffle', 'playerRepeat', 'transitionStyle', 'crossfadeSec']);
const POSITION_EVERY_MS = 1000; // tempo changes refresh the Media Session position at most this often

function defaultMediaSession() {
  try {
    return typeof navigator !== 'undefined' && navigator && navigator.mediaSession ? navigator.mediaSession : null;
  } catch {
    return null;
  }
}

function defaultMetadata() {
  try {
    return typeof globalThis.MediaMetadata === 'function' ? globalThis.MediaMetadata : null;
  } catch {
    return null;
  }
}

function msNow() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

export class Player extends Emitter {
  /**
   * @param {object} opts
   * @param {import('./automix.js').AutoMix} opts.automix
   * @param {import('./playlist.js').Playlist} opts.playlist the set list = the queue
   * @param {import('./deck.js').Deck[]} opts.decks [A, B]
   * @param {object} [opts.engine] for the mixer (which deck plays by hand while stopped)
   * @param {object} opts.settings playerShuffle, playerRepeat, transitionStyle, crossfadeSec
   * @param {object} [opts.library]
   * @param {object} [opts.deps] for tests: { mediaSession, MediaMetadata, artwork } (null = none)
   */
  constructor({ automix = null, playlist = null, decks = null, engine = null, settings = null, library = null, deps = {} } = {}) {
    super();
    this.automix = automix;
    this.playlist = playlist || (automix && automix.playlist) || null;
    this.decks = Array.isArray(decks) && decks.length ? decks : (automix && automix.decks) || [];
    this.engine = engine || (automix && automix.engine) || null;
    this.settings = settings || (automix && automix.settings) || null;
    this.library = library || (this.playlist && this.playlist.library) || null;
    const d = deps || {};
    this._ms = d.mediaSession !== undefined ? d.mediaSession : defaultMediaSession();
    this._Meta = d.MediaMetadata !== undefined ? d.MediaMetadata : defaultMetadata();
    this._artwork = d.artwork || PLAYER_ARTWORK;
    this._offs = [];
    this._actions = [];
    // caches (the getters are read every frame)
    this._np = null;            // nowPlaying object
    this._npDeckIdx = null;
    this._scratch = { item: null, deckIndex: null };
    this._upKey = { items: null, idx: -2 };
    this._up = EMPTY;
    this._hist = EMPTY;
    // what was last reported
    this._lastState = null;
    this._lastNp = null;
    this._metaKey = null;
    this._lastPs = null;
    this._posSet = false;
    this._posAt = -Infinity;

    const am = automix;
    if (am && typeof am.on === 'function') {
      this._offs.push(am.on('change', (what) => this._refresh(what === 'enabled' ? 'state' : what)));
    }
    const pl = this.playlist;
    if (pl && typeof pl.on === 'function') this._offs.push(pl.on('change', () => this._refresh('queue')));
    const st = this.settings;
    if (st && typeof st.on === 'function') {
      this._offs.push(st.on('change', (key) => {
        if (SETTING_KEYS.has(key)) this._refresh('mode');
      }));
    }
    this.decks.forEach((deck, i) => {
      if (!deck || typeof deck.on !== 'function') return;
      this._offs.push(deck.on('change', (what) => this._onDeck(i, what)));
    });
    this._bindMediaSession();
    this._refresh(null);
  }

  // ---------------------------------------------------------------------------------------------------------
  // State (cheap getters)

  /** 'stopped' | 'loading' | 'playing' | 'mixing' | 'paused' */
  get state() {
    const am = this.automix;
    if (!am || !am.enabled) return 'stopped';
    if (am.paused) return 'paused';
    if (am.state === 'starting' || am.pendingItem) return 'loading';
    if (am.state === 'mixing') return 'mixing';
    return 'playing';
  }

  /**
   * { item, deckIndex, title, artist, bpm, hue } of the song playing now (see the header), or null. item is the
   * set-list item (null for a song that is not in the list), deckIndex the deck holding it (null while it is not
   * loaded yet), bpm the song's own tempo (null until known), hue its colour (0..360, as the deck uses it).
   * The same object until something in it changes.
   */
  get nowPlaying() {
    const info = this._nowInfo();
    if (!info) {
      this._np = null;
      return null;
    }
    const deck = info.deckIndex !== null ? this.decks[info.deckIndex] : null;
    const track = deck && deck.track ? deck.track : null;
    const item = info.item;
    const bpm = track && deck.bpm > 0 ? deck.bpm : item && item.bpm > 0 ? item.bpm : null;
    const np = this._np;
    if (np && np.item === item && np.deckIndex === info.deckIndex && np._track === track && np.bpm === bpm) return np;
    const title = (item && item.title) || (track && track.title) || 'Untitled';
    const artist = (item && item.artist) || (track && track.artist) || '';
    const hue = track && Number.isFinite(track.hue) ? track.hue : hashHue(`${title}|${artist}`);
    const fresh = { item, deckIndex: info.deckIndex, title, artist, bpm, hue };
    Object.defineProperty(fresh, '_track', { value: track, enumerable: false });
    this._np = Object.freeze(fresh);
    return this._np;
  }

  /** Seconds into the current song (live). */
  get position() {
    const d = this._nowDeck();
    if (!d || !d.track) return 0;
    const p = d.position;
    return Number.isFinite(p) ? p : 0;
  }

  /** Length of the current song in seconds (the set list's value while it is still loading; 0 unknown). */
  get duration() {
    const d = this._nowDeck();
    if (d && d.track && d.duration > 0) return d.duration;
    const info = this._nowInfo();
    return info && info.item && info.item.duration > 0 ? info.item.duration : 0;
  }

  /** The songs after the current one, in play order (after shuffle). Frozen; the same array until it changes. */
  get upNext() {
    this._lists();
    return this._up;
  }

  /** The songs before the current one, most recent first. Frozen; the same array until it changes. */
  get history() {
    this._lists();
    return this._hist;
  }

  get shuffle() {
    return !!(this.playlist && this.playlist.shuffle);
  }

  /** 'off' | 'all' | 'one' */
  get repeat() {
    const r = this._setting('playerRepeat', 'off');
    return REPEATS.includes(r) ? r : 'off';
  }

  /** 'dj' | 'crossfade' | 'gapless' */
  get transition() {
    return transitionStyleOf(this.settings);
  }

  /** The 'crossfade' style's length in seconds (2..12). */
  get crossfadeSec() {
    return crossfadeSecondsOf(this.settings);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Controls

  /** Play: start the queue (Auto Mix on) or resume. */
  play() {
    return this.automix ? !!this.automix.play() : false;
  }

  pause() {
    return this.automix ? !!this.automix.pause() : false;
  }

  /** Play when stopped or paused, else pause. */
  toggle() {
    const s = this.state;
    return s === 'stopped' || s === 'paused' ? this.play() : this.pause();
  }

  /** The next song (quick fade; during a mix: the mix completes at once). */
  next() {
    return this.automix ? !!this.automix.skip() : false;
  }

  /** Restart the song (past 5 s) or the previous one. */
  previous() {
    return this.automix ? !!this.automix.back() : false;
  }

  /** Seek the current song (not while mixing). */
  seek(sec) {
    return this.automix ? !!this.automix.seek(sec) : false;
  }

  /** Play this queue item now; the queue goes on after it. */
  jumpTo(uid) {
    return this.automix ? !!this.automix.jumpTo(uid) : false;
  }

  setShuffle(on) {
    return this.playlist && typeof this.playlist.setShuffle === 'function' ? this.playlist.setShuffle(!!on) : false;
  }

  /** off -> all -> one -> off. Returns the new mode. */
  cycleRepeat() {
    const next = REPEATS[(REPEATS.indexOf(this.repeat) + 1) % REPEATS.length];
    this.setRepeat(next);
    return this.repeat;
  }

  setRepeat(mode) {
    if (!REPEATS.includes(mode)) return false;
    return this._set('playerRepeat', mode);
  }

  /** 'dj' | 'crossfade' | 'gapless' (Auto Mix re-plans the coming transition). */
  setTransition(style) {
    if (!TRANSITION_STYLES.includes(style)) return false;
    return this._set('transitionStyle', style);
  }

  /** The 'crossfade' style's length, 2..12 s (rounded to 0.5 s). */
  setCrossfadeSec(s) {
    const v = Number(s);
    if (!Number.isFinite(v)) return false;
    return this._set('crossfadeSec', clamp(Math.round(v * 2) / 2, CROSSFADE_MIN, CROSSFADE_MAX));
  }

  /**
   * Insert the song(s) right after the current one and play it now; the queue goes on after it. While stopped
   * (nothing playing) the song goes in front of the one shown as ready, which then follows it. Returns the new
   * queue items.
   */
  playNow(entry) {
    const added = this._insert(entry, this._idle());
    if (added.length) this.jumpTo(added[0].uid);
    return added;
  }

  /**
   * "Play next": right after the song now playing (while stopped: after the one shown as ready, which still plays
   * first). Returns the new queue items.
   */
  playNext(entry) {
    const am = this.automix;
    if (am && !am.enabled && typeof am.cue === 'function' && this._idle()) {
      // stopped: the song shown as ready becomes the set list's current song, the new one goes right after it
      const ready = am.startItem;
      if (ready && this.playlist && this.playlist.current !== ready) am.cue(ready.uid);
    }
    return this._insert(entry, false);
  }

  /** "Add to queue": at the end (a random upcoming position while shuffle is on). Returns the new items. */
  addToQueue(entry) {
    return this.playlist ? this.playlist.add(entry) : [];
  }

  /** "Clear queue": remove every song in upNext (one change). Returns how many were removed. */
  clearQueue() {
    const pl = this.playlist;
    const up = this.upNext;
    if (!pl || !up.length) return 0;
    if (typeof pl.removeMany === 'function') return pl.removeMany(up.map((it) => it.uid));
    let n = 0;
    for (let i = up.length - 1; i >= 0; i--) if (pl.remove(up[i].uid)) n++;
    return n;
  }

  /** Detach from everything and hand the Media Session back. */
  dispose() {
    for (const off of this._offs) off();
    this._offs = [];
    const ms = this._ms;
    if (ms) {
      for (const a of this._actions) {
        try {
          ms.setActionHandler(a, null);
        } catch {
          /* ignore */
        }
      }
      try {
        ms.metadata = null;
      } catch {
        /* ignore */
      }
      try {
        ms.playbackState = 'none';
      } catch {
        /* ignore */
      }
    }
    this._actions = [];
  }

  // ---------------------------------------------------------------------------------------------------------
  // Internals

  /** Which song is "now playing" (a reused scratch object { item, deckIndex }), or null. */
  _nowInfo() {
    const s = this._scratch;
    const am = this.automix;
    if (am && am.enabled) {
      const di = am.currentDeck;
      s.item = am.currentItem || null;
      s.deckIndex = di === 0 || di === 1 ? di : null;
      if (am.state === 'starting' && s.deckIndex !== null && !this._holds(s.deckIndex, s.item)) s.deckIndex = null;
      return s.item || s.deckIndex !== null ? s : null;
    }
    // stopped: a deck played by hand, else what play() starts
    const mixer = this.engine && this.engine.mixer;
    const pi = playingDeck(this.decks, mixer || null);
    if (pi !== null) {
      s.deckIndex = pi;
      s.item = this._itemOfTrack(this.decks[pi].track);
      return s;
    }
    const pl = this.playlist;
    const item = am ? am.startItem : pl ? pl.current || pl.items[0] || null : null;
    if (!item) return null;
    s.item = item;
    s.deckIndex = deckHolding(this.decks, item, 0);
    return s;
  }

  _nowDeck() {
    const info = this._nowInfo();
    return info && info.deckIndex !== null ? this.decks[info.deckIndex] || null : null;
  }

  /** Add to the queue next to the now-playing song: after it, or in front of it (`before`). */
  _insert(entry, before) {
    const pl = this.playlist;
    if (!pl) return [];
    const info = this._nowInfo();
    const i = info && info.item ? pl.indexOf(info.item.uid) : -1;
    if (i >= 0) return pl.add(entry, { at: before ? i : i + 1 });
    // a song that is not in the list (or nothing at all): right after the list's current song
    return typeof pl.addNext === 'function' ? pl.addNext(entry) : pl.add(entry, { at: pl.currentIndex + 1 });
  }

  /** Stopped, and no deck is playing by hand. */
  _idle() {
    const am = this.automix;
    if (am && am.enabled) return false;
    const d = this._nowDeck();
    return !(d && d.playing);
  }

  _holds(i, item) {
    const d = this.decks[i];
    return !!(d && d.track && !d.loading && item && trackIs(d.track, item));
  }

  /** The set-list item a deck's track is (the current one preferred), or null. */
  _itemOfTrack(track) {
    const pl = this.playlist;
    if (!pl || !track) return null;
    const c = pl.current;
    if (c && trackIs(track, c)) return c;
    return pl.items.find((it) => trackIs(track, it)) || null;
  }

  /** Recompute upNext / history when the set list or the current song moved. */
  _lists() {
    const pl = this.playlist;
    if (!pl) {
      this._up = EMPTY;
      this._hist = EMPTY;
      return;
    }
    const items = pl.items;
    const info = this._nowInfo();
    let idx = info && info.item ? pl.indexOf(info.item.uid) : -1;
    if (idx < 0) idx = pl.currentIndex; // (a song that is not in the list: the list goes on after its current song)
    const k = this._upKey;
    if (k.items === items && k.idx === idx) return;
    k.items = items;
    k.idx = idx;
    this._up = Object.freeze(items.slice(idx + 1));
    this._hist = idx > 0 ? Object.freeze(items.slice(0, idx).reverse()) : EMPTY;
  }

  _onDeck(i, what) {
    if (what === 'transport' || what === 'track' || what === 'loading' || what === 'analysis' || what === 'bpm') {
      this._refresh(what === 'transport' ? 'transport' : null);
    } else if (what === 'tempo' && i === this._npDeckIdx) {
      const t = msNow();
      if (t - this._posAt >= POSITION_EVERY_MS) this._updatePosition();
    }
  }

  /** Something changed: report state / track changes, pass `what` on, keep the Media Session up to date. */
  _refresh(what) {
    const st = this.state;
    const np = this.nowPlaying;
    this._npDeckIdx = np ? np.deckIndex : null;
    const stateChanged = st !== this._lastState;
    const trackChanged = np !== this._lastNp;
    this._lastState = st;
    this._lastNp = np;
    this._updateMetadata(st, np);
    this._updatePlayback(st);
    if (stateChanged) this.emit('change', 'state');
    if (trackChanged) this.emit('change', 'track');
    if (what && what !== 'state' && what !== 'track') this.emit('change', what);
  }

  // ---- Media Session

  _bindMediaSession() {
    const ms = this._ms;
    if (!ms || typeof ms.setActionHandler !== 'function') return;
    const handlers = [
      ['play', () => this.play()],
      ['pause', () => this.pause()],
      ['previoustrack', () => this.previous()],
      ['nexttrack', () => this.next()],
      ['seekto', (details) => {
        if (details && Number.isFinite(details.seekTime)) this.seek(details.seekTime);
      }],
    ];
    for (const [action, fn] of handlers) {
      try {
        ms.setActionHandler(action, fn);
        this._actions.push(action);
      } catch {
        /* this browser does not offer that action */
      }
    }
  }

  _updateMetadata(st, np) {
    const ms = this._ms;
    if (!ms) return;
    const show = st !== 'stopped' && !!np;
    const key = show ? `${np.title}\n${np.artist}` : null;
    if (key === this._metaKey) return;
    this._metaKey = key;
    try {
      if (!show) {
        ms.metadata = null;
        return;
      }
      const init = { title: np.title, artist: np.artist, album: ALBUM, artwork: this._artwork.map((a) => ({ ...a })) };
      const M = this._Meta;
      ms.metadata = typeof M === 'function' ? new M(init) : init;
    } catch {
      /* metadata is optional */
    }
  }

  _updatePlayback(st) {
    const ms = this._ms;
    if (!ms) return;
    const ps = st === 'stopped' ? 'none' : st === 'paused' ? 'paused' : 'playing';
    if (ps !== this._lastPs) {
      this._lastPs = ps;
      try {
        ms.playbackState = ps;
      } catch {
        /* ignore */
      }
    }
    this._updatePosition(st);
  }

  /** setPositionState from the current song (cleared while stopped or while its length is unknown). */
  _updatePosition(st = this.state) {
    const ms = this._ms;
    if (!ms || typeof ms.setPositionState !== 'function') return;
    this._posAt = msNow();
    const duration = st === 'stopped' ? 0 : this.duration;
    try {
      if (!(duration > 0)) {
        if (this._posSet) ms.setPositionState();
        this._posSet = false;
        return;
      }
      const d = this._nowDeck();
      const rate = d && d.rate > 0 && Number.isFinite(d.rate) ? d.rate : 1;
      ms.setPositionState({ duration, playbackRate: rate, position: clamp(this.position, 0, duration) });
      this._posSet = true;
    } catch {
      /* an older implementation: no position */
    }
  }

  _setting(key, fallback) {
    try {
      const v = this.settings && typeof this.settings.get === 'function' ? this.settings.get(key) : undefined;
      return v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  }

  _set(key, value) {
    const st = this.settings;
    if (!st || typeof st.set !== 'function') return false;
    try {
      st.set(key, value);
      return true;
    } catch (err) {
      console.warn(`[TwinSpin] player: ${key} could not be saved`, err);
      return false;
    }
  }
}
