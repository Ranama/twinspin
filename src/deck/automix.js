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
//
// Music player (docs/PLAYER.md section 3; the Player facade in player.js drives these):
//   Styles (settings.transitionStyle, re-planned on change): 'dj' (the mix above), 'crossfade' (both songs at
//   their own tempo, an equal-power crossfade of settings.crossfadeSec that ends at the current song's musical
//   end), 'gapless' (the next song starts exactly at the musical end, 15 ms fades).
//   Repeat (settings.playerRepeat): 'all' starts the set list over after its last song, 'one' loads the current
//   song again on the other deck and mixes it into itself; 'off' finishes as before.
//   Transport, safe in any state (no-ops when they make no sense; never a takeover: every deck call is 'auto'):
//     play()    off: switch on and start at `startItem` (the set list's current song, resumed where its deck
//               stopped, or the first unplayed one; setEnabled(true) starts there too); paused: resume().
//     pause()   pause the current deck (during a mix both, the crossfade and bass swap frozen); stays on.
//     resume()  go on: a paused mix continues on its curve, both decks restarted together on the audio clock.
//     skip()    the next song now with a 1.5 s equal-power fade (no beat matching; quickTransition); during a
//               mix: the mix completes at once. back(): restart the song from its in-point when it is past 5 s,
//               else the previous set-list song with the same fade. jumpTo(uid): that song now, the list goes
//               on after it. A song that still has to load is loaded first (state stays, `pendingItem`).
//               While paused, skip / back change the song quietly (it stays paused); jumpTo plays it.
//     seek(sec) the current song (not during a mix); re-plans.
//   While Auto Mix is off, skip() / back() / cue(uid) only move the set list's current song (what play() starts).
// This file decides WHEN; automix-plan.js computes the plan (pure) and automix-deck.js does the deck / mixer work.
// Contract: docs/AUTOMIX.md section 4.5, docs/PLAYER.md section 3.

import { Emitter } from '../core/emitter.js';
import { clamp } from '../core/util.js';
import {
  planTransition, crossfadeAt, returnSeconds, quickTransition, isBeatMatched, transitionStyleOf, QUICK_FADE,
} from './automix-plan.js';
import {
  AUTO, side, targetRate, trackIs, sameSong, loadItem, waitAnalysis, parkNextDeck, glideCrossfader, preRampWindow,
  scheduleTransition, settleSwap, freezeTransition, undoTransition, playingDeck, upcomingItem, findTrackInList, trackInfo,
  inPointOf, releaseNextDeck, itemAfter, itemBefore, pauseTransition, resumeTransition, completeTransition,
  abortTransition, startPointOf, deckHolding,
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
const QUICK_LEAD = 0.1;         // s: a player skip / back / jump fade starts this far ahead on the audio clock
const RESUME_LEAD = 0.05;       // s: a paused mix restarts both decks together this far ahead
const BACK_RESTART_SEC = 5;     // back(): past this far into the song it restarts, else the previous song
const RESUME_TAIL_SEC = 5;      // play(): a paused song this close to its end is started over, not resumed
const END_EPS = 0.05;           // s: a stopped deck this close to the end of its song has ended
const PROGRESS_TICKS = 5;       // 'change' 'progress' every 5 ticks (0.5 s) while a mix runs
const REPEAT_MODES = ['off', 'all', 'one'];
/** Jump target meaning "the user's own song on the prepared deck" (skip() into it). */
const JUMP_USER = Object.freeze({ uid: null, user: true });

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
    this._paused = false;       // the player paused Auto Mix (it stays on)
    this._jumpTarget = null;    // set-list item (or JUMP_USER) to fade into as soon as it is ready
    this._resumeOnJump = false; // that jump was a jumpTo() while paused: play once there
    this._quietList = false;    // updating the set list after a transition (its 'change' events are ours)
    this._noSkip = new Set();   // (an empty "skipped" set for the off-state helpers)

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
        else if (key === 'transitionStyle' || key === 'crossfadeSec') this._onStyle();
        else if (key === 'playerRepeat') this._onRepeat();
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

  /** 0..1 through the running mix (held while paused), else null. */
  get progress() {
    const m = this._mix;
    if (!this._enabled || !m || m.phase !== 'mixing') return null;
    const now = m.pausedAt != null ? m.pausedAt : this._now();
    return now === null ? null : clamp((now - m.t0) / m.dur, 0, 1);
  }

  /** The current Transition (automix-plan.js), or null. */
  get plan() {
    return this._enabled ? (this._mix ? this._mix.plan : this._plan) : null;
  }

  /**
   * On, and the music is paused: by pause(), or the current deck was stopped some other way (the DECKS page,
   * an audio restart) before its song ended. resume() / play() go on.
   */
  get paused() {
    if (!this._enabled) return false;
    if (this._paused) return true;
    if (this._mix || this._holdUntil !== null || (this._state !== 'playing' && this._state !== 'preparing')) return false;
    const cur = this._cur !== null ? this.decks[this._cur] : null;
    return !!(cur && cur.track && !cur.playing && !cur.loading && !(cur.duration > 0 && cur.position >= cur.duration - END_EPS));
  }

  /**
   * The set-list item of the song playing now (while starting: the song being started), null for a song that is
   * not in the set list (the user's own on the prepared deck) and while off.
   */
  get currentItem() {
    if (!this._enabled) return null;
    if (this._state === 'starting') return this._startItem;
    const c = this.playlist ? this.playlist.current : null;
    const d = this._cur !== null ? this.decks[this._cur] : null;
    return c && d && d.track && trackIs(d.track, c) ? c : null;
  }

  /**
   * While off: the set-list item play() starts (the current song, or the first unplayed one; after the end of
   * the list the first one). While on: currentItem.
   */
  get startItem() {
    if (this._enabled) return this.currentItem;
    const pl = this.playlist;
    if (!pl || !pl.length) return null;
    const c = pl.current;
    if (this._state !== 'finished' && c && !this._endedOnDeck(c)) return c;
    return upcomingItem(pl, this._noSkip, 'off') || pl.items[0] || null;
  }

  /** A stopped deck holds this song at its very end (it played out after Auto Mix was switched off). */
  _endedOnDeck(item) {
    for (const d of this.decks) {
      if (d && d.track && !d.playing && !d.loading && d.duration > 0 && d.position >= d.duration - 0.5 && trackIs(d.track, item)) {
        return true;
      }
    }
    return false;
  }

  /** A song the player is waiting for (loading) to jump to, or null. */
  get pendingItem() {
    const j = this._jumpTarget;
    if (!this._enabled || !j) return null;
    return j === JUMP_USER ? (this._next ? this._next.label : null) : j;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Controls

  /**
   * Switch Auto Mix on or off. Returns the new state (false when it could not start, with an 'error'). On: a
   * playing deck becomes current; else the queue starts at startItem, the same song play() starts (a paused deck
   * that holds it plays on from where it is).
   */
  setEnabled(on) {
    const want = !!on;
    if (want === this._enabled) return this._enabled;
    if (!want) {
      this._shutdown('off');
      return false;
    }
    return this._enable(this.startItem, true);
  }

  /** While off: make this set-list song the one play() (and switching on) starts. Returns true when it did. */
  cue(uid) {
    if (this._enabled || !this.playlist) return false;
    const item = this.playlist.get(uid);
    return item ? this._moveStart(item) : false;
  }

  toggle() {
    return this.setEnabled(!this._enabled);
  }

  /**
   * Switch on. A playing deck becomes current (its song found in the set list). Otherwise `item` (or the first
   * unplayed song) is loaded on deck A and started; with `resume`, a paused deck that already holds that song
   * simply plays on from where it is.
   */
  _enable(item, resume) {
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
    const held = playing === null && item && resume ? deckHolding(this.decks, item, RESUME_TAIL_SEC) : null;
    if (playing !== null) {
      this._cur = playing;
      this._adoptCurrentSong();
      this._setState('playing');
      this._releaseOtherDeck();
      this._prepareNext();
    } else if (held !== null) {
      // the song is still on a deck (paused, e.g. Auto Mix was switched off meanwhile): play on from there
      const deck = this.decks[held];
      this._cur = held;
      this.playlist.setCurrent(item.uid);
      this._readyToPlay(held);
      const start = this._startPoint(deck);
      if (deck.position < start - 0.001) deck.seek(start, AUTO);
      deck.play(AUTO);
      this._setState('playing');
      this._prepareNext();
    } else {
      this._startFromIdle(item);
    }
    this._changed('enabled');
    return this._enabled;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Player transport (docs/PLAYER.md section 3). Never a takeover: every deck call passes { source: 'auto' }.

  /** Off: switch on and play the set list from its current song (see startItem). Paused: resume. */
  play() {
    if (this._enabled) return this.paused ? this.resume() : true;
    const ok = this.setEnabled(true);
    if (ok) this._changed('transport');
    return ok;
  }

  /**
   * Pause the music without switching Auto Mix off: the current deck stops; during a mix both decks stop with
   * the crossfade and bass swap frozen (resume() continues them). A mix that is only prepared is undone (the
   * plan is made again on resume). Returns true when it paused.
   */
  pause() {
    if (!this._enabled || this.paused) return false;
    this._paused = true;
    if (this._state !== 'starting') {
      if (this._holdUntil !== null) this._endHold();
      const m = this._mix;
      const now = this._now();
      if (m && this._mixing(m)) {
        if (m.syncOn) this._syncOff(m.next);
        m.syncOn = false;
        pauseTransition(m, this.decks[m.cur], this.decks[m.next], this._mixerNow(), now);
      } else {
        const cur = this.decks[this._cur];
        if (m) {
          this._stopRamp(cur);
          this._cancelSession(false);
        }
        if (cur && cur.playing) cur.pause(AUTO);
        this._t0Est = null;
      }
    }
    this._changed('transport');
    return true;
  }

  /** Go on after pause() (or after the current deck was stopped elsewhere). Returns true when it resumed. */
  resume() {
    if (!this._enabled || !this.paused) return false;
    this._paused = false;
    const now = this._now();
    const m = this._mix;
    if (m && m.pausedAt != null) {
      if (now !== null) {
        const tr = resumeTransition(m, this.decks[m.cur], this.decks[m.next], this._mixerNow(), now, RESUME_LEAD);
        m.syncAt = tr + SYNC_DELAY;
      } else {
        m.pausedAt = null;
      }
    } else if (this._state !== 'starting' && this._cur !== null) {
      const cur = this.decks[this._cur];
      if (cur && cur.track && !cur.playing && !cur.loading) {
        if (cur.duration > 0 && cur.position >= cur.duration - END_EPS) this._onEnded(this._cur);
        else cur.play(AUTO);
      }
      if (this._replan(true)) this._park();
    }
    this._changed('transport');
    return true;
  }

  /**
   * The next song now: a quick equal-power fade (QUICK_FADE, no beat matching) into it, once it is loaded.
   * During a mix the mix completes at once. Off: the set list's current song moves on (what play() starts).
   */
  skip() {
    const pl = this.playlist;
    if (!pl) return false;
    const wrap = this._repeat() !== 'off';
    if (!this._enabled) {
      const s = this.startItem;
      const t = s ? itemAfter(pl, s.uid, this._noSkip, wrap) : null;
      return t ? this._moveStart(t) : false;
    }
    if (this._state === 'starting') {
      const t = this._startItem ? itemAfter(pl, this._startItem.uid, this._skipped, wrap) : null;
      if (!t) return false;
      this._startFromIdle(t);
      this._changed('transport');
      return true;
    }
    const m = this._mix;
    if (m && (this._mixing(m) || (m.plan.quick && m.phase === 'scheduled'))) {
      // during a mix (or a skip fade about to start): the incoming song takes over at once
      this._completeMix();
      this._changed('transport');
      return true;
    }
    const n = this._next;
    if (n && n.source === 'user' && !(this._jumpTarget && this._jumpTarget !== JUMP_USER)) {
      return this._jumpToItem(JUMP_USER);
    }
    // from a song we are already waiting for (skip pressed twice), else from the current one
    const j = this._jumpTarget && this._jumpTarget !== JUMP_USER ? this._jumpTarget : null;
    const base = j || this.currentItem;
    const t = base ? itemAfter(pl, base.uid, this._skipped, wrap) : upcomingItem(pl, this._skipped, wrap ? 'all' : 'off');
    if (!t) {
      this.emit('error', MSG_LAST);
      return false;
    }
    return this._jumpToItem(t);
  }

  /**
   * Past 5 s into the song: restart it from its in-point (during a mix: the song being mixed out, the mix is
   * called off). Otherwise the previous set-list song with the quick fade. Off: moves the set list's current
   * song back (or restarts a paused deck that holds it).
   */
  back() {
    const pl = this.playlist;
    if (!pl) return false;
    if (!this._enabled) return this._backWhileOff();
    if (this._state === 'starting') {
      const t = this._startItem ? itemBefore(pl, this._startItem.uid, this._skipped) : null;
      if (!t) return false;
      this._startFromIdle(t);
      this._changed('transport');
      return true;
    }
    if (this._jumpTarget) {
      // back while waiting for a song skip() asked for: stay on this one
      this._jumpTarget = null;
      this._resumeOnJump = false;
      if (!this._mix) this._prepareNext();
      this._changed('transport');
      return true;
    }
    const cur = this._cur !== null ? this.decks[this._cur] : null;
    if (!cur || !cur.track) return false;
    const item = this.currentItem;
    // a song that is not in the set list (the user's own): its "previous" is the set list's current song
    const prev = item ? itemBefore(pl, item.uid, this._skipped) : pl.current;
    if (cur.position - this._startPoint(cur) > BACK_RESTART_SEC || !prev) return this._restartCurrent();
    const m = this._mix;
    if (m && this._mixing(m)) this._completeMix(); // (then fade from the new song to the previous one)
    return this._jumpToItem(prev);
  }

  /**
   * Play this set-list item now with the quick fade; the list goes on after it. Off: switch on and start
   * there. The current song itself: restart it. Paused: it plays ("play it now"; skip / back keep the pause),
   * starting at once from its start once it is loaded.
   */
  jumpTo(uid) {
    const item = this.playlist ? this.playlist.get(uid) : null;
    if (!item) return false;
    if (!this._enabled) {
      if (playingDeck(this.decks, this._mixerNow()) === null) {
        const ok = this._enable(item, false);
        if (ok) this._changed('transport');
        return ok;
      }
      if (!this.setEnabled(true)) return false;
    }
    const play = this.paused;
    if (this._state === 'starting') {
      this._paused = false;
      this._startFromIdle(item);
      this._changed('transport');
      return true;
    }
    const m = this._mix;
    if (m && this._mixing(m)) {
      const into = m.item && m.source === 'auto' && m.item.uid === uid;
      this._completeMix();
      if (into) {
        if (play) this.resume();
        this._changed('transport');
        return true;
      }
    }
    const curItem = this.currentItem;
    if (curItem && curItem.uid === uid) {
      const ok = this._restartCurrent();
      if (play) this.resume();
      return ok;
    }
    return this._jumpToItem(item, play);
  }

  /** Seek the current song (not during a mix, nor while it starts); re-plans. Off: a paused deck holding it. */
  seek(sec) {
    if (!Number.isFinite(sec)) return false;
    if (!this._enabled) {
      const s = this.startItem;
      const i = s ? deckHolding(this.decks, s, 0) : null;
      if (i === null) return false;
      const d = this.decks[i];
      d.seek(clamp(sec, 0, Math.max(0, d.duration - END_EPS)), AUTO);
      this._changed('transport');
      return true;
    }
    if (this._state === 'starting' || this._cur === null) return false;
    const m = this._mix;
    if (m && this._mixing(m)) return false;
    const cur = this.decks[this._cur];
    if (!cur || !cur.track || cur.loading) return false;
    if (m) this._cancelSession(true, true);
    cur.seek(clamp(sec, 0, Math.max(0, cur.duration - END_EPS)), AUTO);
    this._lateFrom = null;
    this._noPreRamp = false;
    this._setState('playing');
    this._replan(true);
    this._cueNext();
    this._changed('transport');
    return true;
  }

  /** Off: make `item` the set list's current song (what play() starts). */
  _moveStart(item) {
    this.playlist.setCurrent(item.uid);
    if (this._state === 'finished') this._setState('off'); // (the list does not start over any more)
    this._changed('transport');
    return true;
  }

  /** back() while off: restart a paused song that is past 5 s, else move the set list's current song back. */
  _backWhileOff() {
    const s = this.startItem;
    if (!s) return false;
    const i = deckHolding(this.decks, s, 0);
    if (i !== null) {
      const d = this.decks[i];
      const start = this._startPoint(d);
      if (d.position - start > BACK_RESTART_SEC) {
        d.seek(start, AUTO);
        this._changed('transport');
        return true;
      }
    }
    const t = itemBefore(this.playlist, s.uid, this._noSkip);
    return t ? this._moveStart(t) : false;
  }

  /**
   * The current song from its start point again. During a mix it is the song being mixed out: the mix is called
   * off (the incoming deck stops and is parked again, the crossfader goes back). A pending jump is dropped.
   */
  _restartCurrent() {
    const wasPaused = this.paused;
    const m = this._mix;
    const cur = this.decks[this._cur];
    if (m && this._mixing(m)) {
      this._mix = null;
      if (m.syncOn) this._syncOff(m.next);
      abortTransition(m, this.decks[m.cur], this.decks[m.next], this._mixerNow());
      this._setXfade(side(m.cur));
      // an echo out already under way would stop the deck a moment later: a transport command cancels that
      if (m.plan.echoOut && m.echoDone && cur.playing) cur.pause(AUTO);
    } else if (m) {
      this._stopRamp(cur);
      this._cancelSession(false, true);
    }
    // the song starts over at the tempo it had before this transition (a meet pre-ramp / meet mix moved it)
    if (m && m.cur === this._cur && cur.tempoSource === 'auto' && Math.abs(targetRate(cur) - m.baseRate) > 1e-6) {
      cur.rampTempo(m.baseRate, 0);
    }
    this._jumpTarget = null;
    cur.seek(this._startPoint(cur), AUTO);
    if (!wasPaused && !cur.playing) cur.play(AUTO);
    this._lateFrom = null;
    this._noPreRamp = false;
    this._t0Est = null;
    this._setState('playing');
    this._prepareNext();
    this._replan(true);
    this._cueNext();
    this._changed('transport');
    return true;
  }

  /**
   * Go to `target` (a set-list item, or JUMP_USER: the user's song on the prepared deck) with the quick fade:
   * at once when it is ready on the other deck, else after it is loaded (state 'playing' meanwhile; the current
   * song goes on). A prepared (not yet started) mix is called off first.
   */
  _jumpToItem(target, play = false) {
    const m = this._mix;
    if (m && this._mixing(m)) return false;
    if (m) {
      this._stopRamp(this.decks[m.cur]);
      this._cancelSession(false, true);
      this._setState('playing');
    }
    // `play`: jumpTo while paused plays the song (kept when skip goes on from a song still loading for it)
    this._resumeOnJump = play || (!!this._jumpTarget && this._resumeOnJump);
    this._jumpTarget = target;
    if (target !== JUMP_USER) {
      this._skipped.delete(target.uid); // a song picked by hand gets another try
      if (this._next && this._next.source === 'user') this._next = null; // the pick replaces the user's song
    }
    this._prepareNext();
    const n = this._next;
    if (n && n.ready && this._jumpWanted(n)) this._quickFade();
    this._changed('transport');
    return true;
  }

  /** Is the prepared next song the one a pending jump waits for? */
  _jumpWanted(rec) {
    const j = this._jumpTarget;
    if (!j || !rec) return false;
    return j === JUMP_USER ? rec.source === 'user' : rec.source === 'auto' && rec.item === j;
  }

  /**
   * Fade into the prepared next song now (QUICK_FADE, both at their own tempo, from its start point). Paused:
   * switch to it without a fade (it stays paused). The current song already over: start it at once.
   */
  _quickFade() {
    const n = this._next;
    this._jumpTarget = null;
    if (!n || !n.ready || this._cur === null || n.deck === this._cur) return false;
    const cur = this.decks[this._cur];
    const next = this.decks[n.deck];
    const play = this._resumeOnJump;
    this._resumeOnJump = false;
    if (this.paused) {
      // (also a song stopped on the DECKS page: the player shows it as paused, so it stays quiet the same way)
      this._switchTo(n);
      if (play) this.resume(); // jumpTo while paused: the song starts at once from its start
      return true;
    }
    const now = this._now();
    if (!cur.playing || now === null) {
      n.jumped = true;
      this._startNextNow();
      return true;
    }
    if (this._mix) this._cancelSession(false, true);
    const t0 = now + QUICK_LEAD;
    this._plan = quickTransition({
      outAt: cur.positionAt(t0), inAt: this._startPoint(next), curRate: targetRate(cur), fadeSec: QUICK_FADE,
    });
    this._planFor = null;
    this._beginSession('scheduled');
    this._schedule(t0, now);
    return true;
  }

  /** Paused: the prepared next song becomes the current one, parked at its start point (no fade, no sound). */
  _switchTo(n) {
    const next = this.decks[n.deck];
    this._syncOff(n.deck);
    if (next.playing) next.pause(AUTO);
    if (Math.abs(targetRate(next) - 1) > 1e-9) next.rampTempo(1, 0);
    const start = this._startPoint(next);
    if (Math.abs(next.position - start) > 0.001) next.seek(start, AUTO);
    if (next.mix.eq.low !== 0) next.setEq('low', 0, AUTO);
    this._handover(this._cur, n.deck, n.item, n.source, true);
  }

  /** Skip during a mix: the incoming song takes over at once (crossfader over, old deck stopped). */
  _completeMix() {
    const m = this._mix;
    if (!m) return;
    this._mix = null;
    const next = this.decks[m.next];
    completeTransition(m, next, this._mixerNow());
    if (!this._paused && !next.playing && next.track) next.play(AUTO);
    this._handover(m.cur, m.next, m.item, m.source, !!m.plan.quick);
  }

  /** Enabling while both decks played: stop the fading one now (pause() came first). */
  _endHold() {
    this._holdUntil = null;
    const o = this.decks[1 - this._cur];
    const mx = this._mixerNow();
    if (mx && typeof mx.cancelCrossfade === 'function') mx.cancelCrossfade(AUTO);
    this._setXfade(side(this._cur));
    if (o && o.playing) o.pause(AUTO);
    this._prepareNext();
  }

  /** A running tempo ramp (meet pre-ramp) stops where it is. */
  _stopRamp(deck) {
    if (deck && Math.abs(deck.rate - targetRate(deck)) > 1e-9) deck.rampTempo(deck.rate, 0);
  }

  /** A deck Auto Mix is about to play alone: sync off, crossfader to it, volume up, bass and tempo back. */
  _readyToPlay(i) {
    const deck = this.decks[i];
    this._syncOff(i);
    this._setXfade(side(i));
    if (!(deck.mix.volume > 0.01)) deck.setVolume(DEFAULT_VOLUME, AUTO);
    if (deck.mix.eq.low <= -0.98) deck.setEq('low', 0, AUTO); // a bass left killed by an earlier run
    if (deck.tempoSource !== 'user' && Math.abs(targetRate(deck) - 1) > 1e-9) deck.rampTempo(1, 0);
  }

  /** Where a song starts (in-point; musical start for 'gapless'). */
  _startPoint(deck) {
    return startPointOf(deck, this._bounds, this._style());
  }

  /** settings.playerRepeat: 'off' | 'all' | 'one'. */
  _repeat() {
    const r = this._setting('playerRepeat', 'off');
    return REPEAT_MODES.includes(r) ? r : 'off';
  }

  _style() {
    return transitionStyleOf(this.settings);
  }

  /** Start the transition now: at the next bar of the current song (as soon as the next song is ready). */
  mixNow() {
    if (!this._enabled || this._state === 'starting') return false;
    if (this.paused) this.resume(); // (MIX NOW means music)
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
    this._paused = false;
    this._jumpTarget = null;
    this._resumeOnJump = false;
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
    this._paused = false;
    this._jumpTarget = null;
    this._resumeOnJump = false;
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

  /**
   * Nothing plays: load `want` (or the first unplayed song) into deck A, cue it at its in-point and play it
   * (paused: cue only). A song that fails is skipped (the one after it is tried).
   */
  _startFromIdle(want = null) {
    const item = want && this.playlist.get(want.uid) && !this._skipped.has(want.uid) ? want : this._firstPlayable();
    if (!item) {
      this.emit('error', MSG_NONE_LOADED);
      this._shutdown('off');
      return;
    }
    const token = ++this._startToken;
    const deck = this.decks[0];
    if (this._next && this._next.deck === 0) {
      this._next = null; // (a song prepared on deck A for an earlier start is loaded over)
      this._plan = null;
      this._planFor = null;
      this._changed('next');
    }
    this._jumpTarget = null;
    this._cur = 0;
    this._startItem = item;
    this._setState('starting');
    this._loadItem(0, item).then((ok) => {
      if (token !== this._startToken || !this._enabled) return undefined;
      if (!ok) {
        this._skipped.add(item.uid);
        this._startFromIdle(itemAfter(this.playlist, item.uid, this._skipped, false));
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
        this._readyToPlay(0);
        const inAt = this._startPoint(deck);
        if (Math.abs(deck.position - inAt) > 0.001) deck.seek(inAt, AUTO);
        if (!this._paused) deck.play(AUTO);
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

  /**
   * The song to mix into next: a song the player jumps to, else the first set-list song after the current one
   * that has not failed in this run (repeat 'all': from the top after the last one; 'one': the current song).
   */
  _upcoming() {
    const j = this._jumpTarget;
    if (j && j !== JUMP_USER) {
      if (this.playlist.get(j.uid)) return j;
      this._jumpTarget = null; // removed from the list meanwhile
    }
    let repeat = this._repeat();
    // repeat one while the user's own song (not in the set list) plays: the set list simply goes on
    if (repeat === 'one' && this._state !== 'starting' && !this.currentItem) repeat = 'off';
    return upcomingItem(this.playlist, this._skipped, repeat);
  }

  /** The first song to start (never the current one again for repeat 'one'); the list over when all played. */
  _firstPlayable() {
    const pl = this.playlist;
    let item = upcomingItem(pl, this._skipped, this._repeat() === 'off' ? 'off' : 'all');
    if (!item && pl.currentIndex >= 0) {
      pl.setCurrent(-1);
      item = upcomingItem(pl, this._skipped, 'off');
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
        if (this._jumpTarget === item) this._jumpTarget = null; // (the player stays on the current song)
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
    this._jumpTarget = null; // the user's own pick replaces a pending player jump
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
      if (this._jumpWanted(rec) && !this._mix && this._state !== 'starting') {
        this._mixAsap = false;
        this._quickFade(); // the song the player skipped / jumped to is ready
        return;
      }
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
      // a song source's own words (src/sources/*: an Error with a string `code`, e.g. "Can't reach your music
      // server ..." or "Connect to your music server to play ...") say why; anything else stays generic
      const why = err && typeof err.code === 'string' && err.code !== 'aborted' && typeof err.message === 'string' &&
        err.message ? ` ${err.message}` : '';
      this.emit('error', why ? `Skipped “${item.title || 'a song'}”.${why}`
        : `Skipped “${item.title || 'a song'}”: it couldn't be loaded.`);
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
    if (this._paused) return;
    if (cur && cur.track && !cur.playing && !cur.loading && !this._mixAsap && cur.duration > 0 &&
      cur.position >= cur.duration - END_EPS) {
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
    if (m.pausedAt != null) return; // the player paused the mix
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
    if (!m.syncOn && now >= (m.syncAt !== null ? m.syncAt : m.t0 + SYNC_DELAY)) {
      m.syncOn = true;
      if (isBeatMatched(m.plan) && this.sync && cur.bpm && next.bpm && cur.playing && next.playing) {
        this.sync.setSync(m.next, true, { align: false });
      }
    }
    if (m.plan.echoOut && !m.echoDone) {
      m.echoDone = true;
      if (cur.playing && typeof cur.echoOut === 'function') cur.echoOut(AUTO);
    }
    if (m.manualXfade) this._setXfade(crossfadeAt((now - m.t0) / m.dur, m.from, m.to));
    if (now >= m.t0 + m.dur + CLEANUP_DELAY) {
      this._finishMix();
      return;
    }
    if (++m.ticks % PROGRESS_TICKS === 0) this._changed('progress');
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
      syncAt: null,             // context time sync keeping starts (null: t0 + SYNC_DELAY)
      echoDone: false,
      manualXfade: false,
      ticks: 0,                 // mixing ticks ('progress' events)
      pausedAt: null,           // player pause: context time it was paused (pauseTransition)
      resumeCur: false,
      resumeNext: false,
      swapIn: null,             // paused before the bass swap: its offset from t0
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
    this._handover(m.cur, m.next, m.item, m.source, !!m.plan.quick);
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
    this._handover(this._cur, n.deck, n.item, n.source, !!n.jumped);
  }

  /**
   * The new deck is now the current one: stop the old deck (bass and tempo back to normal, sync off), ease the
   * new song back to its own tempo, advance the set list and preload the following song. `jumped`: the player
   * skipped / jumped there (see _makeCurrent).
   */
  _handover(oldIdx, newIdx, item, source, jumped = false) {
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
    if (source === 'auto' && item && this.playlist.get(item.uid)) this._makeCurrent(item, jumped);
    this._changed('mix');
    this._prepareNext();
  }

  /**
   * The set list's current song becomes `item` after a transition into it. A jump (player skip / back / jumpTo)
   * goes straight there: the songs in between count as played. A normal transition into a song that was moved
   * further down meanwhile (shuffle, a drag) moves it up next to the old current song first, so the songs in
   * between are still to come. Past the end with repeat all the list starts over (everything unplayed).
   * (One preload afterwards: the set list's 'change' events in between are not acted on.)
   */
  _makeCurrent(item, jumped) {
    const pl = this.playlist;
    this._quietList = true;
    try {
      const ci = pl.currentIndex;
      const ii = pl.indexOf(item.uid);
      let wrapped = false;
      if (!jumped && ii !== ci && ii >= 0) {
        const items = pl.items;
        const unplayed = (from, to) => items.slice(from, to).some((it) => !this._skipped.has(it.uid));
        // repeat all past the last song (nothing left after the old one): the list starts over. A song dragged to
        // the top while songs after the old one are still to come was just moved: it goes back next to it.
        if (ii < ci && this._repeat() === 'all' && !unplayed(0, ii) && !unplayed(ci + 1, items.length)) {
          if (typeof pl.rewind === 'function') pl.rewind();
          wrapped = true;
        } else if (ii < ci || unplayed(ci + 1, ii)) {
          // moved after the mix was scheduled: up next to the old song (songs that failed to load stay played)
          pl.move(item.uid, ii < ci ? ci : ci + 1);
        }
      }
      pl.setCurrent(item.uid);
      // shuffle + repeat all: every round in a new order (the songs after the first one)
      if (wrapped && pl.shuffle && typeof pl.reshuffle === 'function') pl.reshuffle();
    } finally {
      this._quietList = false;
    }
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
    // the user started the current song again by hand (DECKS page): the player is no longer paused
    if (this._paused && i === this._cur && this.decks[i] && this.decks[i].playing) this._paused = false;
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

  /** The transition style or crossfade length changed: re-plan now (a prepared mix that has not started too). */
  _onStyle() {
    if (!this._enabled || this._state === 'starting') return;
    const m = this._mix;
    if (m) {
      if (this._mixing(m) || m.plan.quick) return; // this transition goes on as it is
      this._cancelSession(true); // (re-plans in the new style)
      return;
    }
    this._replan(true);
    this._cueNext();
  }

  /** Repeat changed: the next song may be another one (a prepared mix that has not started is called off). */
  _onRepeat() {
    if (!this._enabled || this._state === 'starting') return;
    const m = this._mix;
    if (m) {
      if (this._mixing(m) || m.plan.quick) return;
      this._cancelSession(true);
    }
    this._prepareNext();
  }

  _onPlaylist() {
    if (!this._enabled || this._quietList) return;
    const m = this._mix;
    if (m && !this._mixing(m) && !m.plan.quick && m.source === 'auto' && m.item && !this.playlist.get(m.item.uid)) {
      // the song a prepared (not yet audible) mix goes into left the queue (removed, Clear queue): call the mix
      // off; the queue goes on without it (or the current song plays out)
      this._cancelSession(true);
      this._prepareNext();
      return;
    }
    if (this._mix || this._state !== 'playing') return;
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
