// Auto Mix mechanics: what Auto Mix does to the decks and the mixer, as plain functions. The AutoMix controller
// (src/deck/automix.js) decides WHEN; these do the work: load a set-list song, wait for its analysis, park the
// next deck ready to go, put one transition on the audio clock (scheduled start, crossfade, bass swap) and undo
// or freeze it. All deck calls pass { source: 'auto' } so they never look like user actions.
//   await loadItem(deck, item, library, () => stillWanted);   await waitAnalysis(deck, 30000, timers);
//   parkNextDeck(deck, curDeck, plan, { touched, bassSwap });
//   scheduleTransition(m, cur, next, mixer, t0);   undoTransition(m, cur, next, mixer, now);
// `m` is the AutoMix session record ({ plan, cur, next, t0, dur, tSwap, swapSec, low0, from, to, ... }).
// Contract: docs/AUTOMIX.md section 4.5.

import { CUT_SECONDS, musicalBounds, chooseInPoint } from './automix-plan.js';

/** Options for every deck call Auto Mix makes. */
export const AUTO = Object.freeze({ source: 'auto' });
const DEFAULT_VOLUME = 0.8;

/** Crossfader end for deck index i: A = -1, B = +1. */
export const side = (i) => (i === 0 ? -1 : 1);

/** The rate a deck is heading for (its target during a tempo ramp). */
export function targetRate(deck) {
  const r = deck.targetRate;
  return Number.isFinite(r) && r > 0 ? r : deck.rate > 0 ? deck.rate : 1;
}

/** Is this deck track that set-list item's song? */
export function trackIs(track, item) {
  if (!track || !item) return false;
  if (item.kind === 'demo') return track.source === 'demo' && track.demoId === item.id;
  if (track.libraryId != null) return track.libraryId === item.id;
  return !!item.title && track.title === item.title && (!(item.duration > 0) || Math.abs(item.duration - track.duration) < 0.5);
}

/** The same song (two set-list items may be copies of one song). */
export function sameSong(a, b) {
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}

/**
 * Load a set-list item on a deck, quietly. Resolves true when it is on the deck, false when `stillWanted()`
 * turned false meanwhile; rejects when the song cannot be loaded (a missing file, a decode error).
 * @param {import('./deck.js').Deck} deck
 * @param {{ kind: 'library'|'demo', id: string|number, title: string, artist: string }} item
 * @param {object|null} library getBlob(id), get(id)
 * @param {() => boolean} stillWanted
 */
export async function loadItem(deck, item, library, stillWanted) {
  if (item.kind === 'demo') {
    await deck.loadDemo(item.id, AUTO);
  } else {
    const blob = library && typeof library.getBlob === 'function' ? await library.getBlob(item.id) : null;
    if (!stillWanted()) return false;
    if (!blob) throw new Error('This song is no longer stored on this device.');
    const entry = typeof library.get === 'function' ? library.get(item.id) : null;
    const meta = { title: item.title, artist: item.artist, fileName: (entry && entry.fileName) || '', libraryId: item.id };
    await deck.loadFile(blob, meta, AUTO);
  }
  return stillWanted() && !!deck.track;
}

/**
 * Resolves when the deck's song is loaded and analysed (or its analysis failed, or the song went away), or after
 * `ms` at the latest. Safe to call while the deck is still loading: a Deck emits its 'loading' change (track set,
 * loading over) a moment BEFORE it starts the analysis, so every check waits for the end of that emit run
 * (a microtask) instead of trusting the state inside the event.
 * @param {object} timers { setTimeout, clearTimeout }
 */
export function waitAnalysis(deck, ms, timers) {
  return new Promise((resolve) => {
    const done = () => !!deck.track && !deck.loading && !deck.analyzing;
    if (done()) {
      resolve();
      return;
    }
    let timer = null;
    let off = null;
    let queued = false;
    const finish = () => {
      if (off) off();
      off = null;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      resolve();
    };
    const check = () => {
      queued = false;
      if (off && (done() || (!deck.track && !deck.loading))) finish();
    };
    off = deck.on('change', () => {
      if (queued) return;
      queued = true;
      Promise.resolve().then(check);
    });
    timer = timers.setTimeout(finish, ms);
  });
}

/**
 * Get the (paused) next deck ready: parked at the plan's in-point with its start tempo, the bass cut for the
 * bass swap, mid / high / filter flat (unless the user has been handling that deck: `touched`), volume up.
 * @param {object} deck the next deck
 * @param {object} cur the current deck (its volume is copied when the next one is at 0)
 * @param {object|null} plan Transition
 * @param {{ touched: boolean, bassSwap: boolean }} opts
 */
export function parkNextDeck(deck, cur, plan, { touched, bassSwap }) {
  if (!deck.track) return;
  if (!deck.playing && plan) {
    if (!touched && Math.abs(deck.position - plan.in.at) > 0.002) deck.seek(plan.in.at, AUTO);
    const rate = plan.tempo.nextStartRate;
    if (Math.abs(targetRate(deck) - rate) > 1e-6) deck.rampTempo(rate, 0);
  }
  const low = bassSwap && (!plan || plan.bassSwap) ? -1 : 0;
  if (deck.mix.eq.low !== low) deck.setEq('low', low, AUTO);
  if (!touched) {
    if (deck.mix.eq.mid !== 0) deck.setEq('mid', 0, AUTO);
    if (deck.mix.eq.high !== 0) deck.setEq('high', 0, AUTO);
    if (deck.mix.filter && typeof deck.setFilter === 'function') deck.setFilter(0, AUTO);
  }
  if (!(deck.mix.volume > 0.01)) {
    const v = cur && cur.mix ? cur.mix.volume : 0;
    deck.setVolume(v > 0.01 ? v : DEFAULT_VOLUME, AUTO);
  }
}

/**
 * Auto Mix is letting go of a prepared (paused, untouched) next deck: give it its bass back, so a user who plays
 * it by hand later does not wonder where the low end went.
 */
export function releaseNextDeck(deck, touched) {
  if (!deck || deck.playing || touched) return;
  if (deck.mix && deck.mix.eq.low !== 0) deck.setEq('low', 0, AUTO);
}

/** Move the crossfader to `x` (a short glide when the mixer can schedule one), unless it is there already. */
export function glideCrossfader(mixer, x, now, seconds = 1.5) {
  if (!mixer || now === null || Math.abs(mixer.crossfader - x) <= 0.01 || mixer.crossfadeScheduled) return;
  if (typeof mixer.scheduleCrossfade === 'function') mixer.scheduleCrossfade(mixer.crossfader, x, now + 0.05, seconds);
  else if (typeof mixer.setCrossfader === 'function') mixer.setCrossfader(x, AUTO);
}

/**
 * Where the 'meet' pre-ramp runs on the current song (track positions): it ends `gapBeats` before the
 * out-point (at least `gapSec` at the meet tempo) and lasts plan.tempo.preRampBeats beats. `minLeft` is the
 * track distance of `minRampBeats`: a ramp shorter than that is not worth starting.
 */
export function preRampWindow(cur, plan, { gapBeats, gapSec, minRampBeats }) {
  const target = plan.tempo.curTargetRate;
  const beatSec = cur.beatLengthAt(plan.out.at) / target;
  const gap = Math.max(gapBeats, Math.ceil(gapSec / beatSec));
  const k = plan.out.beat - gap;
  const endPos = cur.timeOfBeat(k);
  const startPos = cur.timeOfBeat(k - plan.tempo.preRampBeats);
  const minLeft = endPos - cur.timeOfBeat(k - minRampBeats);
  return { plan, startPos, endPos, minLeft };
}

/**
 * Put session `m` on the audio clock with its mix start at context time t0: the next deck gets the current
 * deck's live tempo (matched per plan; 'cut': its own tempo) and starts exactly at t0 on its in-point (so its
 * bar lands on the current deck's bar); the crossfade runs from t0 over the mix's beats (beat-map aware); the
 * bass swaps half way over one beat. Fills m.t0, m.dur, m.from, m.to, m.tSwap, m.swapSec, m.low0,
 * m.nextWasRunning, m.startedNext, m.manualXfade.
 */
export function scheduleTransition(m, cur, next, mixer, t0) {
  const plan = m.plan;
  m.t0 = t0;
  // tempo at t0 (a pre-ramp has finished by then): the next deck follows the LIVE tempo of the current one
  const curRate = targetRate(cur);
  const nextRate = plan.mode === 'cut' || !cur.bpm || !next.bpm ? 1 : (cur.bpm * curRate * plan.multiplier) / next.bpm;
  next.rampTempo(nextRate, 0);
  const running = next.playing && next.scheduledAt == null;
  if (running) {
    next.seekAt(plan.in.at, t0, AUTO); // the user was previewing it: it jumps onto the beat at t0
  } else {
    if (next.playing) next.pause(AUTO);
    next.seek(plan.in.at, AUTO); // parks exactly there
    next.playAt(t0, AUTO);
  }
  m.startedNext = true;
  m.nextWasRunning = running;
  // the crossfade
  let dur = plan.fadeSec > 0 ? plan.fadeSec : CUT_SECONDS;
  if (plan.beats > 0 && cur.bpm && plan.out.beat !== null) {
    const end = cur.timeOfBeat(plan.out.beat + plan.beats);
    if (Number.isFinite(end) && end > plan.out.at) dur = (end - plan.out.at) / curRate;
  }
  m.dur = dur;
  m.from = side(m.cur);
  m.to = side(m.next);
  if (mixer && typeof mixer.scheduleCrossfade === 'function') {
    mixer.scheduleCrossfade(m.from, m.to, t0, dur);
  } else {
    m.manualXfade = true; // older mixers: the AutoMix tick moves the crossfader
    if (mixer && typeof mixer.setCrossfader === 'function') mixer.setCrossfader(m.from, AUTO);
  }
  // the bass swap: half way, over one beat
  m.low0 = [cur.mix.eq.low, next.mix.eq.low];
  if (plan.bassSwap && cur.bpm && plan.out.beat !== null) {
    const half = cur.timeOfBeat(plan.out.beat + plan.bassSwapBeat);
    m.tSwap = t0 + (half - plan.out.at) / curRate;
    m.swapSec = cur.beatLengthAt(half) / curRate;
    cur.setEq('low', -1, { at: m.tSwap, ramp: m.swapSec, source: 'auto' });
    next.setEq('low', 0, { at: m.tSwap, ramp: m.swapSec, source: 'auto' });
  } else if (next.mix.eq.low !== 0) {
    next.setEq('low', 0, AUTO);
  }
}

/** A cancelled bass swap: before its time the old EQ comes back, during its glide it finishes at once. */
export function settleSwap(m, cur, next, now) {
  if (m.tSwap === null) return;
  if (now === null || now < m.tSwap) {
    cur.setEq('low', m.low0[0], AUTO);
    next.setEq('low', m.low0[1], AUTO);
  } else if (now < m.tSwap + m.swapSec) {
    cur.setEq('low', -1, AUTO);
    next.setEq('low', 0, AUTO);
  }
}

/** Takeover during the mix: the crossfade and EQ stop where they are; both decks keep playing. */
export function freezeTransition(m, cur, next, mixer, now) {
  if (mixer && typeof mixer.cancelCrossfade === 'function') mixer.cancelCrossfade(AUTO);
  settleSwap(m, cur, next, now);
}

/** A scheduled transition that has not started: undo the next deck's start (or jump), crossfade and EQ. */
export function undoTransition(m, cur, next, mixer, now) {
  if (mixer && typeof mixer.cancelCrossfade === 'function') mixer.cancelCrossfade(AUTO);
  if (m.startedNext && next.scheduledAt != null) {
    if (m.nextWasRunning) next.seek(next.position, AUTO); // drops the pending jump
    else next.pause(AUTO); // drops the pending start
  }
  settleSwap(m, cur, next, now);
}

/** The deck Auto Mix should treat as current when switched on: the playing one (the louder if both). */
export function playingDeck(decks, mixer) {
  const a = decks[0];
  const b = decks[1];
  const pa = !!(a && a.playing && a.track);
  const pb = !!(b && b.playing && b.track);
  if (pa && pb) return mixer && mixer.crossfader > 0.001 ? 1 : 0;
  return pa ? 0 : pb ? 1 : null;
}

/** The first set-list song after the current one that is not in `skipped` (uids that failed in this run). */
export function upcomingItem(playlist, skipped) {
  if (!playlist) return null;
  const items = playlist.items;
  for (let i = playlist.currentIndex + 1; i < items.length; i++) if (!skipped.has(items[i].uid)) return items[i];
  return null;
}

/** Index of the set-list item a playing track is (preferring one after the current song), or -1. */
export function findTrackInList(playlist, track) {
  const items = playlist.items;
  const ci = playlist.currentIndex;
  const idx = items.findIndex((it, i) => i > ci && trackIs(track, it));
  return idx >= 0 ? idx : items.findIndex((it) => trackIs(track, it));
}

/** musicalBounds() per track, cached (WeakMap) until its waveform or duration changes. */
export function boundsOf(cache, track, duration) {
  const c = cache.get(track);
  if (c && c.waveform === track.waveform && c.duration === duration) return c.bounds;
  const bounds = musicalBounds(track.waveform, duration);
  cache.set(track, { waveform: track.waveform, duration, bounds });
  return bounds;
}

/** Track data for the planner (automix-plan.js). The current deck plans with the tempo it is heading for. */
export function trackInfo(deck, isCur, cache) {
  const t = deck.track;
  return {
    bpm: deck.bpm,
    firstBeat: Number.isFinite(t.firstBeat) ? t.firstBeat : 0,
    beats: t.beats || null,
    duration: deck.duration,
    waveform: t.waveform || null,
    rate: isCur ? targetRate(deck) : 1,
    bounds: boundsOf(cache, t, deck.duration),
  };
}

/** Where a deck's song starts its music (chooseInPoint), 0 without a song. */
export function inPointOf(deck, cache) {
  return deck.track ? chooseInPoint(trackInfo(deck, false, cache), boundsOf(cache, deck.track, deck.duration)) : 0;
}
