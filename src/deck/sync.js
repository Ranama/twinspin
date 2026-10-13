// SyncController: SYNC buttons. Matches a deck's tempo to the other deck (half/double time allowed) and keeps
// the beats in phase while both play.
//   const sync = new SyncController([deckA, deckB], settings);
//   sync.toggle(1);            // deck B follows deck A (the leader)
//   sync.resetTempo(1);        // SYNC long-press: sync off, tempo back to 0 %
//   sync.on('error', toast);   // "Deck A has no tempo yet. Wait for the BPM or tap it in."
// Rules (contract section 5, docs/AUTOMIX.md 4.2): SYNC on deck i makes the other deck the leader (a leader that
// is itself synced to deck i is switched off first). On enable the rate is matched (Deck.applySyncRate) and,
// when both decks play, the slave is aligned to the leader's beat phase EXACTLY: we compute where both decks will
// be 0.1 s from now on the audio clock and schedule the slave's jump for that moment (Deck.seekAt), so output
// latency and message timing cancel out (decks without seekAt jump at once). A paused slave is aligned the
// moment it starts. Every 30 ms (skipped while the page is hidden) the slave follows the leader's effective BPM
// and, when both play, nobody scratches, no scheduled start/jump is pending and nothing jumped in the last
// 150 ms, a small bend pulls the phase in; more than 0.2 beat off for 0.5 s means a hard re-align. Phase math
// follows the tracks' beat maps; a track flagged `variable` WITHOUT a beat map gets tempo sync only. A user tempo
// move on the slave ('tempoTouched') or a new song on either deck of the pair switches sync off. With
// settings.autoSync, a stopped deck whose BPM just arrived syncs to the other deck when that one is playing.

import { Emitter } from '../core/emitter.js';
import { matchTempo, phaseError, alignOffset, correctionBend } from './sync-math.js';

const TICK_MS = 30;
const SETTLE_MS = 150;        // no phase correction this long after a seek, loop wrap or scratch
const REALIGN_BEATS = 0.2;
const REALIGN_MS = 500;
const JUMP_SEC = 0.05;        // a position this far from where it should be counts as a jump
const ALIGN_LEAD = 0.1;       // s: an exact alignment jump is scheduled this far ahead on the audio clock
const START_ALIGN_LEAD = 0.05; // s: same when a paused slave just started (keeps the out-of-phase bit short)
const MIN_ALIGN_SEC = 0.0005; // smaller phase offsets are left to the bend controller

function isHidden() {
  try {
    return typeof document !== 'undefined' && !!document && document.visibilityState === 'hidden';
  } catch {
    return false;
  }
}

function perfNow() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

function grid(deck, pos) {
  const t = deck.track;
  return {
    pos, bpm: deck.bpm, firstBeat: t && Number.isFinite(t.firstBeat) ? t.firstBeat : 0, beats: (t && t.beats) || null,
  };
}

/** A scheduled start or jump (Auto Mix playAt / sync seekAt) has not happened yet. */
function pending(deck) {
  return deck.scheduledAt != null;
}

export class SyncController extends Emitter {
  /**
   * @param {import('./deck.js').Deck[]} decks [A, B]
   * @param {import('../core/settings.js').Settings} settings
   * @param {{ now?: () => number, setInterval?: Function, clearInterval?: Function, hidden?: () => boolean }} [deps]
   *   for tests (defaults: performance.now, the real timers, document.visibilityState)
   */
  constructor(decks, settings, deps = {}) {
    super();
    this.decks = decks || [];
    this.settings = settings || null;
    this._deps = {
      now: perfNow,
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (id) => clearInterval(id),
      hidden: isHidden,
      ...(deps || {}),
    };
    this._timer = null;
    this._mult = [1, 1];
    this._bpmKey = ['', ''];
    this._errSince = [null, null];
    this._settle = [-Infinity, -Infinity];
    this._last = [null, null];          // { pos, t } per deck, for jump detection
    this._wasPlaying = this.decks.map((d) => !!(d && d.playing));
    this.decks.forEach((d, i) => {
      if (!d || typeof d.on !== 'function') return;
      d.on('change', (what) => this._onDeckChange(i, what));
      d.on('tempoTouched', () => {
        if (this.isSynced(i)) this.setSync(i, false);
      });
      d.on('analyzed', () => this._autoSync(i));
    });
  }

  /** SYNC button. Returns the new state. */
  toggle(index) {
    this.setSync(index, !this.isSynced(index));
    return this.isSynced(index);
  }

  isSynced(index) {
    const d = this.decks[index];
    return !!(d && d.synced);
  }

  /** Index of the deck that `index` follows, or null when it is not synced. */
  leaderOf(index) {
    return this.isSynced(index) ? 1 - index : null;
  }

  /**
   * Switch sync on or off for deck `index`. Returns true when the deck ends up in the requested state; on
   * failure it emits 'error' with a sentence for the user. opts.align false skips the alignment jump on enable
   * (Auto Mix starts the slave on the beat itself; the bend controller keeps it there).
   * @param {number} index
   * @param {boolean} on
   * @param {{ align?: boolean }} [opts]
   */
  setSync(index, on, opts) {
    const slave = this.decks[index];
    const leader = this.decks[1 - index];
    if (!slave) return false;
    if (!on) {
      if (!slave.synced) return true;
      slave.setSynced(false);
      slave.setBend(0, 'sync');
      this._errSince[index] = null;
      this._changed();
      return true;
    }
    const why = this._cannotSync(slave, leader);
    if (why) {
      this.emit('error', why);
      return false;
    }
    if (leader.synced) {
      leader.setSynced(false);
      leader.setBend(0, 'sync');
    }
    const m = matchTempo(slave.bpm, leader.effectiveBpm);
    this._mult[index] = m.multiplier;
    this._bpmKey[index] = `${slave.bpm}|${leader.bpm}`;
    this._errSince[index] = null;
    slave.applySyncRate(m.rate);
    slave.setSynced(true);
    const align = !(opts && opts.align === false);
    if (align && slave.playing && leader.playing && !this._noPhase(slave, leader) && !pending(slave) && !pending(leader)) {
      this._align(index, ALIGN_LEAD);
    }
    this._changed();
    return true;
  }

  /** SYNC long-press: sync off and tempo back to 0 %. */
  resetTempo(index) {
    const d = this.decks[index];
    if (!d) return;
    this.setSync(index, false);
    d.resetTempo();
  }

  /** Stop the timer and listeners' effects (tests / hot reload). */
  dispose() {
    if (this._timer !== null) this._deps.clearInterval(this._timer);
    this._timer = null;
  }

  // ---------------------------------------------------------------------------------------------------

  _cannotSync(slave, leader) {
    if (!slave.track) return `Load a song on deck ${slave.id} first.`;
    if (!(slave.bpm > 0)) return `Deck ${slave.id} has no tempo yet. Wait for the BPM or tap it in.`;
    if (!leader || !leader.track) return `Load a song on deck ${leader ? leader.id : 'B'} to sync to it.`;
    if (!(leader.bpm > 0)) return `Deck ${leader.id} has no tempo yet. Wait for the BPM or tap it in.`;
    return '';
  }

  /** No phase lock: a variable-tempo track without a beat map (its constant grid drifts away from the music). */
  _noPhase(a, b) {
    const off = (d) => !!(d.track && d.track.variable && !(d.track.beats && d.track.beats.length >= 2));
    return off(a) || off(b);
  }

  _changed() {
    this._updateTimer();
    this.emit('change');
  }

  /** The 30 ms follower runs only while some deck is synced. */
  _updateTimer() {
    const any = this.decks.some((d) => d && d.synced);
    if (any && this._timer === null) {
      this._last = [null, null];
      this._timer = this._deps.setInterval(() => this._tick(), TICK_MS);
    } else if (!any && this._timer !== null) {
      this._deps.clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Jump the slave (declicked) so its beat phase matches the leader. Exact version: both positions are
   * predicted for `lead` seconds from now on the audio clock and the jump is scheduled for that moment
   * (Deck.seekAt), so latency and message timing do not matter. Decks without the audio-clock API jump now.
   */
  _align(index, lead = ALIGN_LEAD) {
    const slave = this.decks[index];
    const leader = this.decks[1 - index];
    const m = this._mult[index];
    let settleMs = SETTLE_MS;
    const now = slave.audioTime;
    const exact = now != null && typeof slave.seekAt === 'function' && typeof slave.positionAt === 'function' &&
      typeof leader.positionAt === 'function';
    const at = exact ? now + lead : 0;
    const sp = exact ? slave.positionAt(at) : null;
    const lp = exact ? leader.positionAt(at) : null;
    if (Number.isFinite(sp) && Number.isFinite(lp)) {
      const off = alignOffset(grid(slave, sp), grid(leader, lp), m);
      if (Math.abs(off) > MIN_ALIGN_SEC) slave.seekAt(sp + off, at, { source: 'sync' });
      settleMs += lead * 1000;
    } else {
      const s = grid(slave, slave.position);
      const off = alignOffset(s, grid(leader, leader.position), m);
      if (Math.abs(off) > MIN_ALIGN_SEC) slave.seek(s.pos + off, { source: 'sync' });
    }
    slave.setBend(0, 'sync');
    this._errSince[index] = null;
    this._settle[index] = this._deps.now() + settleMs;
    this._last[index] = null;
  }

  _onDeckChange(i, what) {
    const d = this.decks[i];
    if (!d) return;
    if ((what === 'loading' && d.loading && !d.restoring) || (what === 'track' && !d.track)) {
      // a new song (or none) on this deck: its own sync and the other deck's sync to it are void
      if (this.isSynced(i)) this.setSync(i, false);
      if (this.isSynced(1 - i)) this.setSync(1 - i, false);
      return;
    }
    if (what === 'sync') {
      this._updateTimer(); // the deck may have changed its own flag (load / eject)
      return;
    }
    if (what === 'transport') {
      const playing = !!d.playing;
      const was = this._wasPlaying[i];
      this._wasPlaying[i] = playing;
      if (playing && !was && d.synced && !pending(d)) {
        const leader = this.decks[1 - i];
        if (leader && leader.playing && leader.bpm > 0 && d.bpm > 0 && !this._noPhase(d, leader) && !pending(leader)) {
          this._align(i, START_ALIGN_LEAD);
        }
      }
    }
  }

  _autoSync(i) {
    let auto = true;
    try {
      auto = !this.settings || typeof this.settings.get !== 'function' || this.settings.get('autoSync') !== false;
    } catch {
      auto = true;
    }
    if (!auto) return;
    const d = this.decks[i];
    const o = this.decks[1 - i];
    if (!d || !o || d.playing || d.synced || !(d.bpm > 0)) return;
    if (!o.track || !o.playing || !(o.bpm > 0)) return;
    this.setSync(i, true);
  }

  _tick() {
    if (this._deps.hidden()) {
      this._last = [null, null];
      return;
    }
    const now = this._deps.now();
    const pos = this.decks.map((d, i) => this._observe(i, now));
    for (let i = 0; i < this.decks.length && i < 2; i++) this._follow(i, now, pos);
  }

  /** Read a deck's position and note jumps (seek, loop wrap, scratch) for the settle time. */
  _observe(i, now) {
    const d = this.decks[i];
    if (!d || !d.track) {
      this._last[i] = null;
      return 0;
    }
    const pos = d.position;
    const last = this._last[i];
    if (d.scratching) {
      this._settle[i] = now + SETTLE_MS;
    } else if (Number.isFinite(d.lastJumpAt) && now - d.lastJumpAt < SETTLE_MS) {
      this._settle[i] = Math.max(this._settle[i], d.lastJumpAt + SETTLE_MS);
    } else if (last) {
      const dt = (now - last.t) / 1000;
      const speed = d.playing ? (d.rate || 1) + (Number.isFinite(d.bend) ? d.bend : 0) : 0;
      if (Math.abs(pos - (last.pos + speed * dt)) > JUMP_SEC + 0.02 * dt) this._settle[i] = now + SETTLE_MS;
    }
    this._last[i] = { pos, t: now };
    this._wasPlaying[i] = !!d.playing;
    return pos;
  }

  _follow(i, now, pos) {
    const slave = this.decks[i];
    const leader = this.decks[1 - i];
    if (!slave || !slave.synced) return;
    if (!leader || !leader.track || !(leader.bpm > 0) || !slave.track || !(slave.bpm > 0)) {
      slave.setBend(0, 'sync');
      this._errSince[i] = null;
      return;
    }
    const key = `${slave.bpm}|${leader.bpm}`;
    if (key !== this._bpmKey[i]) {
      this._bpmKey[i] = key;
      this._mult[i] = matchTempo(slave.bpm, leader.effectiveBpm).multiplier;
    }
    const rate = (leader.effectiveBpm * this._mult[i]) / slave.bpm;
    if (Math.abs(rate - slave.rate) > 1e-9) slave.applySyncRate(rate);

    const locked = slave.playing && leader.playing && !slave.scratching && !leader.scratching &&
      !this._noPhase(slave, leader) && !pending(slave) && !pending(leader) &&
      now >= this._settle[i] && now >= this._settle[1 - i];
    if (!locked) {
      slave.setBend(0, 'sync');
      this._errSince[i] = null;
      return;
    }
    const err = phaseError(grid(slave, pos[i]), grid(leader, pos[1 - i]), this._mult[i]);
    if (Math.abs(err) > REALIGN_BEATS) {
      if (this._errSince[i] === null) this._errSince[i] = now;
      else if (now - this._errSince[i] >= REALIGN_MS) {
        this._align(i);
        return;
      }
    } else {
      this._errSince[i] = null;
    }
    slave.setBend(correctionBend(err), 'sync');
  }
}
