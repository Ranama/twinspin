// Auto Mix: plays the set list by itself like a DJ. It keeps the playing ("current") deck going, preloads the next
// set-list song on the other deck, and mixes into it: beat-matched, bar-aligned, crossfaded with a bass swap, the
// tempos met half way when the songs differ, then the new song eases back to its own tempo. When that song plays
// alone, the following one is preloaded on the free deck, and so on until the list ends.
//   const automix = new AutoMix({ engine, decks: [deckA, deckB], sync, settings, playlist });
//   automix.toggle();  automix.mixNow();  automix.noteUserCrossfader();     // UI
//   automix.on('change', (what) => ...);   // 'enabled' | 'state' | 'plan' | 'next' | 'mix'
//   automix.on('error' | 'takeover' | 'finished', toast);
//   // read every frame: enabled, state, currentDeck, nextItem, nextReady, secondsToMix, progress, plan
//
// How one transition works (all times on the AudioContext clock, "render time"):
//   1. PLAN (main thread, whenever a song, its analysis, the tempo or a setting changes): automix-plan.js picks
//      the out-point on the current song (a bar / phrase, `beats` before its musical end), the in-point on the
//      next song (its first bar of music) and the tempo mode: 'match' (next starts at the current tempo),
//      'meet' (the current song first ramps half way toward the next song's tempo) or 'cut' (no beat grid or
//      tempos too far apart: an 8-beat / 6 s blend, next at its own tempo). The next deck is parked at its
//      in-point with its tempo set and its bass cut, so it is ready to go.
//   2. PRE-RAMP ('meet' only): 16 beats before the mix (ending one bar and >= 2.6 s early) the current deck
//      glides to the meet tempo (Deck.rampTempo). From here on the mix is a "session" (state 'preparing').
//   3. SCHEDULE (2 s ahead; 20 s while the page is hidden, because browsers throttle timers there): t0 = the
//      context time at which the current deck plays the out-point (Deck.timeAtPosition, ramp aware). The next
//      deck starts exactly then at its in-point (seek + playAt), so its bar lands on the current deck's bar;
//      Mixer.scheduleCrossfade runs the crossfader over `beats` beats; the bass swap is two timed EQ glides
//      (current low -> kill, next low -> 0) over one beat at the half-way beat.
//   4. MIX (t0 .. t0 + length, state 'mixing'): 0.25 s after t0 the SyncController takes over phase keeping
//      (next follows current) except in 'cut' mode; 'cut' from a song with a grid also echoes the old song out.
//   5. AFTER: the old deck is paused, its bass and tempo reset, sync off; the new deck becomes current and (when
//      settings.automixReturn) ramps back to rate 1; the set list advances; the next song is preloaded.
// Takeover: during the mix (from t0 on the audio clock, even before the next tick notices) any user action on a
// deck or the crossfader ('userAction' events, mixer 'crossfader' events with source 'user', or
// noteUserCrossfader()) freezes the automation where it is, switches Auto Mix off and emits 'takeover'; so does
// a crossfader move once the crossfade is scheduled. Before t0 a user action that changes timing (play/pause/
// seek/tempo/loop/load...) just cancels the prepared mix (undoing the scheduled start, EQ and pre-ramp) and
// re-plans, except that previewing the next deck during the pre-ramp leaves the ramp alone; outside a session
// user actions simply re-plan. While the first song is starting, a load on the other deck does not stop the
// start. Robustness: songs that fail to load are skipped; a next song without a BPM gets a 'cut' (re-planned
// and re-parked when its BPM arrives late); a mix point that was missed (seek, late analysis, MIX NOW) mixes at
// the next bar; a song that ends before its mix starts the next one at once; an audio restart cancels the mix
// and re-plans; a parked next deck gets its bass back when Auto Mix lets go of it. Nothing allocates per frame;
// the 100 ms timer only runs while Auto Mix is on, and a failing tick is logged once instead of every 100 ms.
// This file decides WHEN; automix-plan.js computes the plan (pure) and automix-deck.js does the deck / mixer work.
// Contract: docs/AUTOMIX.md section 4.5.

import { Emitter } from '../core/emitter.js';
import { clamp } from '../core/util.js';
import { planTransition, crossfadeAt, returnSeconds } from './automix-plan.js';
import {
  AUTO, side, targetRate, trackIs, sameSong, loadItem, waitAnalysis, parkNextDeck, glideCrossfader, preRampWindow,
  scheduleTransition, settleSwap, freezeTransition, undoTransition, playingDeck, upcomingItem, findTrackInList, trackInfo,
  inPointOf, releaseNextDeck,
} from './automix-deck.js';

const TICK_MS = 100;
const SCHEDULE_LEAD = 2;        // s: the mix goes onto the audio clock this long before it starts
const HIDDEN_LEAD = 20;         // s: same while the page is hidden (timers may be throttled or frozen there)
const MIN_LEAD = 0.25;          // s: a mix start closer than this cannot be scheduled reliably -> next bar
const LATE_LEAD = 1;            // s: MIX NOW / a missed mix starts at the first bar at least this far ahead
const FREEZE_SEC = 30;          // s: this close to the mix the out/in points stop moving (unless the user acts)
const GAP_MIN_SEC = 2.6;        // s: the meet pre-ramp ends at least this long (and 4 beats) before the mix
const GAP_MIN_BEATS = 4;
const MIN_RAMP_BEATS = 4;       // a pre-ramp shorter than this is skipped (next song matches the current tempo)
const SYNC_DELAY = 0.25;        // s after t0: hand phase keeping to the SyncController
const CLEANUP_DELAY = 0.3;      // s after the crossfade: stop the old deck
const UNDO_RAMP_SEC = 3;        // s: a cancelled pre-ramp glides back to the old tempo
const RELEASE_SEC = 2;          // s: enabling while both decks play fades the other one out first
const START_WAIT_MS = 8000;     // the first song waits this long for its analysis (to start at its in-point)
const NEXT_WAIT_MS = 30000;     // the next song waits this long for its analysis (then it mixes without a grid)
const DEFAULT_VOLUME = 0.8;

const MSG_EMPTY = 'Add songs to the set list first.';
const MSG_NOT_STARTED = 'Tap Start first so TwinSpin can play sound.';
const MSG_TAKEOVER = 'Auto Mix off. You took over the mix.';
const MSG_NONE_LOADED = "None of the songs in the set list could be loaded.";
const MSG_LAST = 'This is the last song in the set list.';

/** User actions that change timing: a prepared (not yet started) mix can no longer be trusted. */
const TIMING = new Set(['play', 'pause', 'cue', 'seek', 'scratch', 'tempo', 'loop', 'bpm', 'load', 'eject', 'brake', 'echo']);

function isHidden() {
  try {
    return typeof document !== 'undefined' && !!document && document.visibilityState === 'hidden';
  } catch {
    return false;
  }
}

export class AutoMix extends Emitter {
  /**
   * @param {object} opts
   * @param {import('../audio/engine.js').AudioEngine} opts.engine
   * @param {import('./deck.js').Deck[]} opts.decks [A, B]
   * @param {import('./sync.js').SyncController} opts.sync
   * @param {import('../core/settings.js').Settings} opts.settings mixBeats, automixReturn, automixBassSwap
   * @param {import('./playlist.js').Playlist} opts.playlist
   * @param {object} [opts.library] for song files (default: playlist.library)
   * @param {object} [opts.deps] for tests: { setInterval, clearInterval, setTimeout, clearTimeout, hidden }
   */
  constructor({ engine = null, decks = [], sync = null, settings = null, playlist = null, library = null, deps = {} } = {}) {
    super();
    this.engine = engine;
    this.decks = decks;
    this.sync = sync;
    this.settings = settings;
    this.playlist = playlist;
    this._library = library;
    this._deps = {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (id) => clearInterval(id),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
      hidden: isHidden,
      ...(deps || {}),
    };

    this._enabled = false;
    this._state = 'off';
    this._cur = null;           // index of the deck playing the current song
    this._next = null;          // { item, deck, source: 'auto'|'user', loading, ready, touched, label }
    this._plan = null;          // Transition (automix-plan.js) for current -> next
    this._planFor = null;       // { cur, next } track objects the plan was made for
    this._mix = null;           // the running transition session (see _beginSession)
    this._t0Est = null;         // estimated context time of the next mix start (secondsToMix)
    this._skipped = new Set();  // set-list uids that failed to load in this run
    this._lateFrom = null;      // track time: mix as soon as possible from here (MIX NOW / missed)
    this._noPreRamp = false;    // too late for a meet pre-ramp this time
    this._mixAsap = false;      // MIX NOW pressed before the next song was ready
    this._holdUntil = null;     // context time: the other deck is fading out (enable while both play)
    this._wasHidden = false;
    this._timer = null;
    this._startToken = 0;
    this._startItem = null;     // the set-list song _startFromIdle is putting on deck A
    this._tickErr = false;      // a tick threw (logged once)
    this._loadTokens = [0, 0];
    this._prw = null;           // cached pre-ramp window { plan, startPos, endPos, minLeft }
    this._bounds = new WeakMap();
    this._mixer = null;
    this._mixerOff = null;
    this._offs = [];

    this.decks.forEach((d, i) => {
      if (!d || typeof d.on !== 'function') return;
      this._offs.push(d.on('change', (what) => this._onDeckChange(i, what)));
      this._offs.push(d.on('userAction', (name) => this._onUserAction(i, name)));
      this._offs.push(d.on('ended', () => this._onEnded(i)));
    });
    if (engine && typeof engine.on === 'function') {
      this._offs.push(engine.on('ready', () => this._watchMixer()));
      this._offs.push(engine.on('restarted', () => this._onRestart()));
    }
    if (settings && typeof settings.on === 'function') {
      this._offs.push(settings.on('change', (key) => {
        if (key === 'mixBeats' || key === 'automixReturn' || key === 'automixBassSwap') this._onSettings();
      }));
    }
    if (playlist && typeof playlist.on === 'function') this._offs.push(playlist.on('change', () => this._onPlaylist()));
    this._watchMixer();
  }

  // ---------------------------------------------------------------------------------------------------------
  // State for the UI (cheap getters, read every frame)

  get enabled() {
    return this._enabled;
  }

  /** 'off' | 'starting' | 'playing' | 'preparing' | 'mixing' | 'finished' */
  get state() {
    return this._state;
  }

  /** Deck index of the current song (0 = A, 1 = B), null while off. */
  get currentDeck() {
    return this._enabled ? this._cur : null;
  }

  /**
   * What will be mixed in next: a set-list item, or { uid: null, kind: 'deck', title, artist } for a song the
   * user loaded on the prepared deck. null at the end of the list or while off.
   */
  get nextItem() {
    if (!this._enabled) return null;
    const n = this._next;
    if (n) return n.source === 'user' ? n.label : n.item;
    return this._state === 'starting' ? null : this._upcoming();
  }

  /** The next song is loaded and analysed on the other deck and a plan exists. */
  get nextReady() {
    return !!(this._enabled && this._next && this._next.ready && this._plan);
  }

  /** Seconds until the planned mix starts (countdown), null when unknown or mixing. */
  get secondsToMix() {
    if (!this._enabled || this._state === 'mixing') return null;
    const t0 = this._mix && this._mix.t0 !== null ? this._mix.t0 : this._t0Est;
    const now = this._now();
    return t0 === null || now === null ? null : Math.max(0, t0 - now);
  }

  /** 0..1 through the running mix, else null. */
  get progress() {
    const m = this._mix;
    if (!this._enabled || !m || m.phase !== 'mixing') return null;
    const now = this._now();
    return now === null ? null : clamp((now - m.t0) / m.dur, 0, 1);
  }

  /** The current Transition (automix-plan.js), or null. */
  get plan() {
    return this._enabled ? (this._mix ? this._mix.plan : this._plan) : null;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Controls

  /** Switch Auto Mix on or off. Returns the new state (false when it could not start, with an 'error'). */
  setEnabled(on) {
    const want = !!on;
    if (want === this._enabled) return this._enabled;
    if (!want) {
      this._shutdown('off');
      return false;
    }
    if (!this.playlist || !this.playlist.length) {
      this.emit('error', MSG_EMPTY);
      return false;
    }
    if (!this._audioReady()) {
      this.emit('error', MSG_NOT_STARTED);
      return false;
    }
    this._enabled = true;
    this._resetRun();
    this._watchMixer();
    this._timer = this._deps.setInterval(() => this._safeTick(), TICK_MS);
    const playing = playingDeck(this.decks, this._mixerNow());
    if (playing === null) {
      this._startFromIdle();
    } else {
      this._cur = playing;
      this._adoptCurrentSong();
      this._setState('playing');
      this._releaseOtherDeck();
      this._prepareNext();
    }
    this._changed('enabled');
    return this._enabled;
  }

  toggle() {
    return this.setEnabled(!this._enabled);
  }

  /** Start the transition now: at the next bar of the current song (as soon as the next song is ready). */
  mixNow() {
    if (!this._enabled || this._state === 'starting') return false;
    const m = this._mix;
    if (m && m.phase !== 'ramp') return true; // already on its way
    if (!this._next) {
      this.emit('error', MSG_LAST);
      return false;
    }
    if (!this._next.ready || !this._plan) {
      this._mixAsap = true;
      return true;
    }
    const cur = this.decks[this._cur];
    if (m) {
      // skip the rest of the pre-ramp: mix at the tempo reached so far (a ramp left running would still be
      // moving the current song's tempo during the mix, away from the tempo the next song starts at)
      if (Math.abs(cur.rate - targetRate(cur)) > 1e-9) cur.rampTempo(cur.rate, 0);
      this._cancelSession(false);
    }
    if (!cur.playing) {
      this._startNextNow();
      return true;
    }
    this._goLate();
    this._tick();
    return true;
  }

  /** The UI moved the crossfader (also detected from the mixer's 'crossfader' events with source 'user'). */
  noteUserCrossfader() {
    const m = this._mix;
    if (!this._enabled || !m || m.phase === 'ramp') return; // nothing scheduled on the crossfader yet
    this._takeover();
  }

  /**
   * Has session `m` started mixing? Its phase flips on the next 100 ms tick after t0, but on the audio clock
   * the next song already plays from t0: an action in between must be treated as one during the mix.
   */
  _mixing(m) {
    if (!m) return false;
    if (m.phase === 'mixing') return true;
    if (m.phase !== 'scheduled' || m.t0 === null) return false;
    const now = this._now();
    return now !== null && now >= m.t0;
  }

  /** Stop and detach (tests, hot reload). */
  dispose() {
    this._shutdown('off');
    for (const off of this._offs) off();
    this._offs = [];
    if (this._mixerOff) this._mixerOff();
    this._mixerOff = null;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Starting and stopping

  _resetRun() {
    this._skipped.clear();
    this._next = null;
    this._plan = null;
    this._planFor = null;
    this._mix = null;
    this._t0Est = null;
    this._lateFrom = null;
    this._noPreRamp = false;
    this._mixAsap = false;
    this._holdUntil = null;
    this._prw = null;
    this._wasHidden = this._hidden();
    this._startToken++;
    this._startItem = null;
  }

  /**
   * Switch off: freeze a running mix (both songs keep playing) or undo one that has not started, give a parked
   * next deck its bass back, stop the timer. state 'off' or 'finished'.
   */
  _shutdown(state) {
    if (this._mix) {
      if (this._mixing(this._mix)) this._freezeMix();
      else this._cancelSession(false, true);
    }
    if (this._timer !== null) this._deps.clearInterval(this._timer);
    this._timer = null;
    const n = this._next;
    if (n) releaseNextDeck(this.decks[n.deck], n.touched);
    const was = this._enabled;
    this._enabled = false;
    this._startToken++;
    this._startItem = null;
    this._mix = null;
    this._next = null;
    this._plan = null;
    this._planFor = null;
    this._t0Est = null;
    this._holdUntil = null;
    this._cur = null;
    this._setState(state);
    if (was) this._changed('enabled');
  }

  /** Nothing plays: load the first unplayed song into deck A, cue it at its in-point and play it. */
  _startFromIdle() {
    const item = this._firstPlayable();
    if (!item) {
      this.emit('error', MSG_NONE_LOADED);
      this._shutdown('off');
      return;
    }
    const token = ++this._startToken;
    const deck = this.decks[0];
    this._cur = 0;
    this._startItem = item;
    this._setState('starting');
    this._loadItem(0, item).then((ok) => {
      if (token !== this._startToken || !this._enabled) return undefined;
      if (!ok) {
        this._skipped.add(item.uid);
        this._startFromIdle();
        return undefined;
      }
      this.playlist.setCurrent(item.uid);
      return waitAnalysis(deck, START_WAIT_MS, this._deps).then(() => {
        if (token !== this._startToken || !this._enabled || this._state !== 'starting') return;
        if (!deck.track) {
          this._startFromIdle();
          return;
        }
        this._startItem = null;
        this._syncOff(0);
        const inAt = this._inPointOf(deck);
        if (Math.abs(deck.position - inAt) > 0.001) deck.seek(inAt, AUTO);
        this._setXfade(side(0));
        if (!(deck.mix.volume > 0.01)) deck.setVolume(DEFAULT_VOLUME, AUTO);
        if (deck.mix.eq.low <= -0.98) deck.setEq('low', 0, AUTO); // a bass left killed by an earlier run
        deck.play(AUTO);
        this._setState('playing');
        this._prepareNext();
      });
    }).catch((err) => this._oops('start', err));
  }

  /** Auto Mix was switched on while a song plays: find it in the set list (else the list goes on as it is). */
  _adoptCurrentSong() {
    const idx = findTrackInList(this.playlist, this.decks[this._cur].track);
    if (idx >= 0) this.playlist.setCurrent(idx);
    else if (!this._upcoming()) this.playlist.setCurrent(-1); // everything was played: start the list over
  }

  /** Both decks play: fade the other one out over RELEASE_SEC, then stop it and preload the next song there. */
  _releaseOtherDeck() {
    const oi = 1 - this._cur;
    const o = this.decks[oi];
    if (!o || !o.playing) return;
    const mx = this._mixerNow();
    const s = side(this._cur);
    const x = mx ? mx.crossfader : s;
    const now = this._now();
    if (!mx || Math.abs(x - s) < 0.01 || now === null) {
      o.pause(AUTO);
      return;
    }
    if (typeof mx.scheduleCrossfade === 'function') mx.scheduleCrossfade(x, s, now + 0.05, RELEASE_SEC);
    else this._setXfade(s);
    this._holdUntil = now + RELEASE_SEC + 0.1;
  }

  // ---------------------------------------------------------------------------------------------------------
  // The next song

  /** The first set-list song after the current one that has not failed in this run. */
  _upcoming() {
    return upcomingItem(this.playlist, this._skipped);
  }

  /** _upcoming(), starting the list over when everything was played. */
  _firstPlayable() {
    let item = this._upcoming();
    if (!item && this.playlist.currentIndex >= 0) {
      this.playlist.setCurrent(-1);
      item = this._upcoming();
    }
    return item;
  }

  /** Make sure the upcoming set-list song is (being) loaded on the other deck. */
  _prepareNext() {
    if (!this._enabled || this._cur === null || this._mix || this._state === 'starting' || this._holdUntil !== null) return;
    const ni = 1 - this._cur;
    const deck = this.decks[ni];
    const n = this._next;
    if (n && n.source === 'user') {
      if (this._replan(false)) this._park();
      return;
    }
    const item = this._upcoming();
    if (!item) {
      if (n) {
        // nothing left to mix into (the rest of the list was removed): let go of the prepared deck
        releaseNextDeck(deck, n.touched);
        this._next = null;
        this._changed('next');
      }
      this._replan(false);
      return;
    }
    if (n && n.deck === ni && (n.item === item || sameSong(n.item, item))) {
      if (n.item !== item) {
        n.item = item;
        this._changed('next');
      }
      return;
    }
    const rec = { item, deck: ni, source: 'auto', loading: true, ready: false, touched: false, label: null };
    this._next = rec;
    this._plan = null;
    this._planFor = null;
    this._t0Est = null;
    this._changed('next');
    if (deck.track && !deck.loading && trackIs(deck.track, item) && !deck.playing) {
      rec.loading = false; // already there (e.g. loaded by hand from the set list)
      this._afterNextLoaded(rec);
      return;
    }
    if (deck.playing) deck.pause(AUTO);
    this._loadItem(ni, item).then((ok) => {
      if (this._next !== rec || !this._enabled) return;
      rec.loading = false;
      if (!ok) {
        this._skipped.add(item.uid);
        this._next = null;
        this._changed('next');
        this._prepareNext();
        return;
      }
      this._afterNextLoaded(rec);
    }).catch((err) => this._oops('preload', err));
  }

  /** A song the user is loading on the prepared deck becomes the next song (Auto Mix mixes into it). */
  _userNext(i) {
    const d = this.decks[i];
    const label = Object.freeze({ uid: null, kind: 'deck', id: null, title: `your song on deck ${(d && d.id) || (i ? 'B' : 'A')}`, artist: '' });
    const rec = { item: null, deck: i, source: 'user', loading: true, ready: false, touched: true, label };
    this._next = rec;
    this._plan = null;
    this._planFor = null;
    this._t0Est = null;
    this._changed('next');
    this._afterNextLoaded(rec);
  }

  /** The next song is on its deck: wait for its analysis, then plan and cue it. */
  _afterNextLoaded(rec) {
    const deck = this.decks[rec.deck];
    waitAnalysis(deck, NEXT_WAIT_MS, this._deps).then(() => {
      if (this._next !== rec || !this._enabled) return;
      if (deck.loading) {
        // still decoding (a long song the user is loading on a slow phone): keep waiting, never load over it
        this._afterNextLoaded(rec);
        return;
      }
      if (!deck.track) {
        // the song is gone (a failed load, an eject): back to the set list
        this._next = null;
        this._changed('next');
        this._prepareNext();
        return;
      }
      rec.ready = true;
      if (rec.source === 'user') rec.label = Object.freeze({ uid: null, kind: 'deck', id: null, title: deck.track.title || 'Untitled', artist: deck.track.artist || '' });
      this._syncOff(rec.deck);
      if (this._leaderOf(this._cur) === rec.deck) this._syncOff(this._cur);
      this._replan(true);
      this._cueNext();
      this._changed('next');
      if (this._mixAsap) {
        this._mixAsap = false;
        this.mixNow();
      }
    }).catch((err) => this._oops('next song', err));
  }

  /** Park the (paused) next deck ready to go and the crossfader on the current deck's side. */
  _cueNext() {
    if (!this._park()) return;
    glideCrossfader(this._mixerNow(), side(this._cur), this._now());
  }

  /**
   * Park the next deck for the current plan (in-point, start tempo, bass cut) without touching the crossfader
   * (a re-plan while the user handles it must not pull it around). Returns false when there is nothing to park.
   */
  _park() {
    const n = this._next;
    if (!n || !n.ready || this._mix || this._cur === null || n.deck === this._cur) return false;
    const bassSwap = this._setting('automixBassSwap', true) !== false;
    parkNextDeck(this.decks[n.deck], this.decks[this._cur], this._plan, { touched: n.touched, bassSwap });
    return true;
  }

  /** Load a set-list item on deck i (quietly: no 'userAction'). Resolves true when it is on the deck. */
  async _loadItem(i, item) {
    const token = ++this._loadTokens[i];
    const wanted = () => token === this._loadTokens[i] && this._enabled;
    try {
      return await loadItem(this.decks[i], item, this._lib(), wanted);
    } catch (err) {
      if (!wanted()) return false;
      console.warn('[TwinSpin] Auto Mix: load failed', err);
      this.emit('error', `Skipped “${item.title || 'a song'}”: it couldn't be loaded.`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Planning

  /**
   * Re-plan current -> next. Within FREEZE_SEC of the mix the plan for the same two songs (same BPMs) is kept
   * unless `force` (a user action): the countdown should not jump around at the last moment. A BPM that arrives
   * or changes always re-plans. Returns true when a new plan was made.
   */
  _replan(force) {
    if (!this._enabled || this._mix || this._cur === null) return false;
    const cur = this.decks[this._cur];
    const n = this._next;
    const next = n && n.deck !== this._cur ? this.decks[n.deck] : null;
    if (!cur || !cur.track || !n || !n.ready || !next || !next.track || next.loading) {
      if (this._plan) {
        this._plan = null;
        this._planFor = null;
        this._t0Est = null;
        this._changed('plan');
      }
      return false;
    }
    const pf = this._planFor;
    const same = !!pf && pf.cur === cur.track && pf.next === next.track && pf.curBpm === cur.bpm && pf.nextBpm === next.bpm;
    const left = this.secondsToMix;
    if (same && !force && left !== null && left < FREEZE_SEC) return false;
    let earliest;
    if (this._lateFrom !== null) {
      const now = this._now();
      const ahead = now !== null && cur.playing ? cur.positionAt(now + LATE_LEAD) : null;
      earliest = Math.max(this._lateFrom, Number.isFinite(ahead) ? ahead : cur.position);
    }
    const plan = planTransition(this._info(cur, true), this._info(next, false), this.settings, {
      earliest, noPreRamp: this._noPreRamp || this._hidden(),
    });
    this._plan = plan;
    this._planFor = { cur: cur.track, next: next.track, curBpm: cur.bpm, nextBpm: next.bpm };
    this._prw = null;
    const t0 = cur.playing ? cur.timeAtPosition(plan.out.at) : null;
    this._t0Est = Number.isFinite(t0) ? t0 : null; // the tick keeps it fresh
    this._changed('plan');
    return true;
  }

  _info(deck, isCur) {
    return trackInfo(deck, isCur, this._bounds);
  }

  _inPointOf(deck) {
    return inPointOf(deck, this._bounds);
  }

  /** Mix as soon as possible: plan from the first bar about a second from now, no pre-ramp. */
  _goLate() {
    const cur = this.decks[this._cur];
    const now = this._now();
    const ahead = now !== null && cur.playing ? cur.positionAt(now + LATE_LEAD) : null;
    this._lateFrom = Number.isFinite(ahead) ? ahead : cur.position;
    this._noPreRamp = true;
    if (this._replan(true)) this._park();
  }

  /**
   * Where the meet pre-ramp runs (track positions of the current song): it ends GAP before the out-point (at
   * least 4 beats and GAP_MIN_SEC) and lasts plan.tempo.preRampBeats beats.
   */
  _preRampWindow(cur, plan) {
    const w = this._prw;
    if (w && w.plan === plan) return w;
    this._prw = preRampWindow(cur, plan, { gapBeats: GAP_MIN_BEATS, gapSec: GAP_MIN_SEC, minRampBeats: MIN_RAMP_BEATS });
    return this._prw;
  }

  // ---------------------------------------------------------------------------------------------------------
  // The clock: one 100 ms tick while Auto Mix is on

  /** The timer's entry point: a bug in one tick is logged (once) instead of throwing every 100 ms. */
  _safeTick() {
    try {
      this._tick();
      this._tickErr = false;
    } catch (err) {
      if (!this._tickErr) console.error('[TwinSpin] Auto Mix tick failed', err);
      this._tickErr = true;
    }
  }

  _tick() {
    if (!this._enabled) return;
    const now = this._now();
    if (now === null) return;
    this._watchMixer();
    const hidden = this._hidden();
    if (hidden !== this._wasHidden) {
      this._wasHidden = hidden;
      if (!this._mix && this._replan(true)) this._park(); // hidden: no pre-ramp (timers are unreliable there)
    }
    if (this._holdUntil !== null && now >= this._holdUntil) {
      this._holdUntil = null;
      const o = this.decks[1 - this._cur];
      if (o && o.playing) o.pause(AUTO);
      this._prepareNext();
    }
    if (this._state === 'starting') return;
    if (this._mix) this._tickSession(now);
    else this._tickPlaying(now);
  }

  /** No session yet: watch the current song, start the pre-ramp or schedule the mix when it is time. */
  _tickPlaying(now) {
    const cur = this.decks[this._cur];
    const plan = this._plan;
    this._t0Est = null;
    if (cur && cur.track && !cur.playing && !cur.loading && !this._mixAsap && cur.duration > 0 &&
      cur.position >= cur.duration - 0.05) {
      this._onEnded(this._cur); // it ran out without an 'ended' we saw (e.g. a song shorter than the mix into it)
      return;
    }
    if (!cur || !plan || !this._next || !this._next.ready) return;
    if (!cur.playing || cur.scratching || (cur.loop && cur.loop.active)) return; // nothing to predict
    if (cur.scheduledAt != null) return;
    const t0 = cur.timeAtPosition(plan.out.at);
    if (t0 === null) {
      this._goLate(); // already past the out-point (the user jumped ahead, or the song was late)
      return;
    }
    this._t0Est = t0;
    if (plan.tempo.preRampBeats > 0) {
      const w = this._preRampWindow(cur, plan);
      const p = cur.positionAt(now);
      const lookahead = (1.5 * TICK_MS) / 1000 * (cur.rate || 1);
      if (Number.isFinite(p) && p >= w.startPos - lookahead) {
        const left = w.endPos - p;
        if (left < w.minLeft) {
          this._noPreRamp = true; // too late to meet half way: the next song matches the current tempo
          if (this._replan(true)) this._park();
          return;
        }
        this._beginSession('ramp');
        const target = plan.tempo.curTargetRate;
        cur.rampTempo(target, left / ((targetRate(cur) + target) / 2));
        return;
      }
    }
    const lead = this._hidden() ? HIDDEN_LEAD : SCHEDULE_LEAD;
    if (t0 - now <= lead) {
      if (t0 - now < MIN_LEAD) {
        this._goLate();
        return;
      }
      this._beginSession('scheduled');
      this._schedule(t0, now);
    }
  }

  /** A session runs: pre-ramp -> scheduled -> mixing -> handover. */
  _tickSession(now) {
    const m = this._mix;
    const cur = this.decks[m.cur];
    const next = this.decks[m.next];
    if (m.phase === 'ramp') {
      if (!cur.playing) {
        this._cancelSession(true);
        return;
      }
      const t0 = cur.timeAtPosition(m.plan.out.at);
      if (t0 === null) {
        this._cancelSession(false);
        this._goLate();
        return;
      }
      this._t0Est = t0;
      const lead = this._hidden() ? HIDDEN_LEAD : SCHEDULE_LEAD;
      if (t0 - now <= lead) {
        if (t0 - now < MIN_LEAD) {
          this._cancelSession(false);
          this._goLate();
          return;
        }
        this._schedule(t0, now);
      }
      return;
    }
    if (m.phase === 'scheduled') {
      if (now < m.t0) return;
      m.phase = 'mixing';
      this._setState('mixing');
    }
    // mixing
    if (!m.syncOn && now >= m.t0 + SYNC_DELAY) {
      m.syncOn = true;
      if (m.plan.mode !== 'cut' && this.sync && cur.bpm && next.bpm && cur.playing && next.playing) {
        this.sync.setSync(m.next, true, { align: false });
      }
    }
    if (m.plan.echoOut && !m.echoDone) {
      m.echoDone = true;
      if (cur.playing && typeof cur.echoOut === 'function') cur.echoOut(AUTO);
    }
    if (m.manualXfade) this._setXfade(crossfadeAt((now - m.t0) / m.dur, m.from, m.to));
    if (now >= m.t0 + m.dur + CLEANUP_DELAY) this._finishMix();
  }

  // ---------------------------------------------------------------------------------------------------------
  // The transition

  /** Start a session for the planned transition (phase 'ramp' or 'scheduled'). */
  _beginSession(phase) {
    const cur = this.decks[this._cur];
    this._mix = {
      phase,
      plan: this._plan,
      cur: this._cur,
      next: this._next.deck,
      item: this._next.item,
      source: this._next.source,
      baseRate: targetRate(cur),
      ramped: phase === 'ramp',
      t0: null,
      dur: 0,
      tSwap: null,
      swapSec: 0,
      low0: [0, 0],
      from: side(this._cur),
      to: side(this._next.deck),
      startedNext: false,
      nextWasRunning: false,
      syncOn: false,
      echoDone: false,
      manualXfade: false,
    };
    this._setState('preparing');
  }

  /**
   * Put the transition on the audio clock: the next deck starts at its in-point exactly at t0 (its bar on the
   * current deck's bar), the crossfade runs from t0 for `beats` beats, the bass swaps half way.
   */
  _schedule(t0, now) {
    const m = this._mix;
    m.phase = 'scheduled';
    this._syncOff(m.next);
    if (this._leaderOf(m.cur) === m.next) this._syncOff(m.cur);
    scheduleTransition(m, this.decks[m.cur], this.decks[m.next], this._mixerNow(), t0);
    this._t0Est = t0;
    this._setState(now >= t0 ? 'mixing' : 'preparing');
    if (now >= t0) m.phase = 'mixing';
    this._changed('plan');
  }

  /** The crossfade is done: hand over to the new deck and line up the following song. */
  _finishMix() {
    const m = this._mix;
    this._mix = null;
    this._handover(m.cur, m.next, m.item, m.source);
  }

  /** The current song ended before a mix: start the next one at once (at its own tempo). */
  _startNextNow() {
    const n = this._next;
    if (!n || !n.ready) {
      this._mixAsap = true;
      return;
    }
    const next = this.decks[n.deck];
    this._syncOff(n.deck);
    if (!next.playing) {
      next.rampTempo(1, 0);
      const inAt = this._plan ? this._plan.in.at : this._inPointOf(next);
      if (Math.abs(next.position - inAt) > 0.001) next.seek(inAt, AUTO);
      if (next.mix.eq.low !== 0) next.setEq('low', 0, AUTO);
      next.play(AUTO);
    }
    this._handover(this._cur, n.deck, n.item, n.source);
  }

  /**
   * The new deck is now the current one: stop the old deck (bass and tempo back to normal, sync off), ease the
   * new song back to its own tempo, advance the set list and preload the following song.
   */
  _handover(oldIdx, newIdx, item, source) {
    const old = this.decks[oldIdx];
    const neu = this.decks[newIdx];
    // the new roles first: the deck events below (tempo, transport, EQ) must never be taken for the old
    // current -> next pair (a re-plan would park the deck that is now playing, bass cut and all)
    this._cur = newIdx;
    this._next = null;
    this._plan = null;
    this._planFor = null;
    this._t0Est = null;
    this._lateFrom = null;
    this._noPreRamp = false;
    this._mixAsap = false;
    this._syncOff(newIdx);
    this._syncOff(oldIdx);
    if (old.playing) old.pause(AUTO);
    if (old.mix.eq.low !== 0) old.setEq('low', 0, AUTO);
    old.rampTempo(1, 0);
    this._setXfade(side(newIdx));
    if (this._setting('automixReturn', true) !== false && neu.bpm) {
      const r = targetRate(neu);
      if (Math.abs(r - 1) > 1e-4) neu.rampTempo(1, returnSeconds(neu.bpm, r));
    }
    this._setState('playing');
    // (the set list's 'change' may already start the preload; _prepareNext() below is then a no-op)
    if (source === 'auto' && item && this.playlist.get(item.uid)) this.playlist.setCurrent(item.uid);
    this._changed('mix');
    this._prepareNext();
  }

  /** Takeover during the mix: stop the automation where it is (both decks keep playing). */
  _freezeMix() {
    const m = this._mix;
    if (!m) return;
    this._mix = null;
    freezeTransition(m, this.decks[m.cur], this.decks[m.next], this._mixerNow(), this._now());
  }

  /**
   * Cancel a session that has not started mixing: undo the scheduled start, crossfade and EQ, and (when
   * `restoreTempo`) glide the current deck back from a pre-ramp the user did not override. Re-plans unless
   * `quiet` (switching off).
   */
  _cancelSession(restoreTempo, quiet = false) {
    const m = this._mix;
    if (!m) return;
    this._mix = null;
    const cur = this.decks[m.cur];
    if (m.phase !== 'ramp') undoTransition(m, cur, this.decks[m.next], this._mixerNow(), this._now());
    if (restoreTempo && m.ramped && cur.tempoSource === 'auto' && Math.abs(targetRate(cur) - m.baseRate) > 1e-6) {
      cur.rampTempo(m.baseRate, UNDO_RAMP_SEC);
    }
    this._t0Est = null;
    if (quiet) return;
    this._setState('playing');
    this._replan(true);
    this._cueNext();
  }

  _takeover() {
    this._shutdown('off');
    this.emit('takeover', MSG_TAKEOVER);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Events

  _onUserAction(i, name) {
    if (!this._enabled) return;
    if (name === 'load' || name === 'eject') this._loadTokens[i]++; // an Auto Mix load in flight there is void
    const m = this._mix;
    if (this._mixing(m)) {
      this._takeover();
      return;
    }
    if (!TIMING.has(name)) return; // EQ / volume / filter outside the mix are fine (the bass swap overrides)
    if (m && m.phase === 'ramp' && i === m.next && name !== 'load' && name !== 'eject') {
      // the user previews the next song during the pre-ramp: nothing is scheduled on that deck yet, so the
      // current song keeps gliding to the meet tempo (the mix puts the next deck on its in-point when scheduled)
      if (this._next) this._next.touched = true;
      return;
    }
    if (m) this._cancelSession(name !== 'tempo');
    if (this._state === 'starting') this._userWhileStarting(i, name);
    if (i !== this._cur) {
      if (name === 'load') {
        // the user put their own song on the deck Auto Mix prepared: mix into that one instead
        this._userNext(i);
        return;
      }
      if (name === 'eject') {
        this._next = null;
        this._plan = null;
        this._planFor = null;
        this._changed('next');
        this._prepareNext();
        return;
      }
      if (this._next) this._next.touched = true; // the user handles that deck now: no more re-cueing
    } else if (name === 'tempo' || name === 'bpm' || name === 'seek' || name === 'load') {
      this._lateFrom = null;
      this._noPreRamp = false;
    }
    this._replan(true);
    this._cueNext();
  }

  /**
   * A user action while the first song is still being started on deck A. On deck A itself (or PLAY on the other
   * deck) the user is driving: stop the automatic start and carry on from what they do. Loading / ejecting a
   * song on the other deck only changes what comes next: the start goes on.
   */
  _userWhileStarting(i, name) {
    if (i !== this._cur && (name === 'load' || name === 'eject')) return;
    this._startToken++;
    const first = this._startItem;
    this._startItem = null;
    // the user handles the first song on deck A: it counts as the current song of the list (when they started
    // the other deck instead, that song stays next and is mixed into from there)
    const a = this.decks[this._cur];
    if (i === this._cur && first && a && trackIs(a.track, first) && this.playlist.get(first.uid)) {
      this.playlist.setCurrent(first.uid);
    }
    if (name === 'play' && i !== this._cur && this.decks[i].playing) {
      // the user started the other deck: its song is the current one now, and the first song (loaded on deck A
      // but never started) is still to come
      const k = first ? this.playlist.indexOf(first.uid) : -1;
      if (k >= 0 && this.playlist.currentIndex === k) this.playlist.setCurrent(k - 1);
      this._cur = i;
      if (this._next && this._next.deck === i) this._next = null; // (their own song there is now the current one)
      this._adoptCurrentSong();
    }
    this._setState('playing');
    this._prepareNext();
  }

  _onDeckChange(i, what) {
    // ('mixing' without a session: a handover is under way, the roles are changing)
    if (!this._enabled || this._mix || this._state === 'starting' || this._state === 'mixing') return;
    let replanned = false;
    if (what === 'track' || what === 'analysis' || what === 'bpm' || what === 'loading') replanned = this._replan(false);
    else if (what === 'tempo' && i === this._cur) replanned = this._replan(false);
    // a late analysis (or a new tempo) changes the in-point, start tempo and bass swap: park the next deck again
    if (replanned) this._park();
  }

  _onEnded(i) {
    if (!this._enabled || i !== this._cur || this._state === 'starting') return;
    const m = this._mix;
    if (this._mixing(m)) return; // the old song ran out during the crossfade: fine
    if (m) this._cancelSession(false, true);
    if (!this._next) {
      this._finish();
      return;
    }
    this._startNextNow();
  }

  _onSettings() {
    if (!this._enabled || this._mix) return;
    this._replan(false);
    this._cueNext();
  }

  _onPlaylist() {
    if (!this._enabled || this._mix || this._state !== 'playing') return;
    this._prepareNext();
  }

  _onRestart() {
    this._watchMixer();
    if (!this._enabled) return;
    const m = this._mix;
    if (m) {
      // the old audio graph is gone and the decks come back paused: drop the mix, put the EQ back
      this._mix = null;
      if (m.phase !== 'ramp') settleSwap(m, this.decks[m.cur], this.decks[m.next], null);
    }
    this._t0Est = null;
    this._lateFrom = null;
    if (this._state !== 'starting') this._setState('playing');
    this._replan(true);
  }

  /** The set list is done: the last song played out. */
  _finish() {
    this._shutdown('finished');
    this.emit('finished');
  }

  // ---------------------------------------------------------------------------------------------------------
  // Helpers

  _setState(s) {
    if (s === this._state) return;
    this._state = s;
    this._changed('state');
  }

  /** An unexpected error inside an async step: log it (never an unhandled rejection). */
  _oops(where, err) {
    console.error(`[TwinSpin] Auto Mix (${where}) failed`, err);
  }

  _changed(what) {
    this.emit('change', what);
  }

  _now() {
    const ctx = this.engine && this.engine.ctx;
    const t = ctx ? ctx.currentTime : NaN;
    return Number.isFinite(t) ? t : null;
  }

  _hidden() {
    try {
      return !!this._deps.hidden();
    } catch {
      return false;
    }
  }

  _audioReady() {
    return !!(this.engine && this.engine.ready && this._now() !== null);
  }

  _lib() {
    return this._library || (this.playlist && this.playlist.library) || null;
  }

  _setting(key, fallback) {
    try {
      const v = this.settings && typeof this.settings.get === 'function' ? this.settings.get(key) : undefined;
      return v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  }

  _mixerNow() {
    return (this.engine && this.engine.mixer) || null;
  }

  /** Follow the engine's mixer (a new one after an audio restart) for user crossfader moves. */
  _watchMixer() {
    const mx = this._mixerNow();
    if (mx === this._mixer) return;
    if (this._mixerOff) this._mixerOff();
    this._mixerOff = null;
    this._mixer = mx;
    if (mx && typeof mx.on === 'function') {
      this._mixerOff = mx.on('crossfader', (e) => {
        if (e && e.source === 'user') this.noteUserCrossfader();
      });
    }
  }

  _setXfade(x) {
    const mx = this._mixerNow();
    if (mx && typeof mx.setCrossfader === 'function') mx.setCrossfader(x, AUTO);
  }

  _syncOff(i) {
    const s = this.sync;
    if (s && typeof s.isSynced === 'function' && s.isSynced(i)) s.setSync(i, false);
  }

  _leaderOf(i) {
    const s = this.sync;
    return s && typeof s.leaderOf === 'function' ? s.leaderOf(i) : null;
  }
}
