// Music player wording and small pure helpers for the UI (no DOM, tested in tests/ui-player.test.js): reading the
// Player defensively (playerSnapshot), the text and states the PLAYER page shows (playerView), the transition
// styles, the repeat cycle, the queue signature that decides when the Up next list is rebuilt, and toast texts.
//   const v = playerView(playerSnapshot(player, automix, settings));   // { stateText, title, elapsed, ... }
//   nextRepeat('off') === 'all'   transitionText('crossfade', 8) === 'Fades one song into the next over 8 seconds.'
// The Player itself is src/deck/player.js (docs/PLAYER.md section 4); every field may be missing while it starts.

import { fmtTime, hashHue, clamp } from '../core/util.js';
import { itemTitle } from './automix-text.js';

/** The player's states (docs/PLAYER.md section 4). */
export const PLAYER_STATES = Object.freeze(['stopped', 'playing', 'paused', 'loading', 'mixing']);

/** Transition styles, in the order the chooser shows them, with one line of explanation each. */
export const TRANSITIONS = Object.freeze([
  Object.freeze({ value: 'dj', label: 'DJ mix', text: 'Beat-matched like a DJ: the tempos meet and the bass swaps half way.' }),
  Object.freeze({ value: 'crossfade', label: 'Crossfade', text: 'Fades one song into the next.' }),
  Object.freeze({ value: 'gapless', label: 'Gapless', text: 'The next song starts the moment this one ends.' }),
]);

/** Crossfade length range (s), settings.crossfadeSec. */
export const CROSSFADE_MIN = 2;
export const CROSSFADE_MAX = 12;
export const CROSSFADE_DEFAULT = 6;

/** The repeat modes in the order the repeat button cycles through them. */
export const REPEAT_MODES = Object.freeze(['off', 'all', 'one']);

/** A transition style from anything ('dj' for unknown values). */
export function cleanTransition(style) {
  return TRANSITIONS.some((t) => t.value === style) ? style : 'dj';
}

/** A crossfade length, 2..12 s in half seconds like the Player keeps it (6 for nonsense). */
export function cleanCrossfade(sec) {
  return Number.isFinite(sec) ? clamp(Math.round(sec * 2) / 2, CROSSFADE_MIN, CROSSFADE_MAX) : CROSSFADE_DEFAULT;
}

/** '6 s', '6.5 s'. */
export function fmtSeconds(sec) {
  const n = cleanCrossfade(sec);
  return `${Number.isInteger(n) ? n : n.toFixed(1)} s`;
}

/** The chooser entry for a style. */
export function transitionInfo(style) {
  const v = cleanTransition(style);
  return TRANSITIONS.find((t) => t.value === v);
}

/** The one-line explanation of a style (crossfade names its length). */
export function transitionText(style, sec) {
  const t = transitionInfo(style);
  if (t.value === 'crossfade') return `Fades one song into the next over ${fmtSeconds(sec).replace(' s', ' seconds')}.`;
  return t.text;
}

/** Short label for the compact transition button: 'DJ mix', 'Crossfade 6 s', 'Gapless'. */
export function transitionShort(style, sec) {
  const t = transitionInfo(style);
  return t.value === 'crossfade' ? `Crossfade ${fmtSeconds(sec)}` : t.label;
}

/** A repeat mode from anything ('off' for unknown values). */
export function cleanRepeat(mode) {
  return REPEAT_MODES.includes(mode) ? mode : 'off';
}

/** off -> all -> one -> off. */
export function nextRepeat(mode) {
  const i = REPEAT_MODES.indexOf(cleanRepeat(mode));
  return REPEAT_MODES[(i + 1) % REPEAT_MODES.length];
}

/**
 * The repeat button's look: icon ('repeat' | 'repeatOne'), on (lit), label (what it does now, for screen readers
 * and the title) and the toast text after a tap.
 */
export function repeatInfo(mode) {
  const m = cleanRepeat(mode);
  if (m === 'all') {
    return { mode: m, icon: 'repeat', on: true, label: 'Repeat all: the queue starts again at the end', toast: 'Repeat all' };
  }
  if (m === 'one') {
    return { mode: m, icon: 'repeatOne', on: true, label: 'Repeat one: this song plays again', toast: 'Repeat this song' };
  }
  return { mode: m, icon: 'repeat', on: false, label: 'Repeat off', toast: 'Repeat off' };
}

function read(obj, key, fallback) {
  if (!obj) return fallback;
  try {
    const v = obj[key];
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

function setting(settings, key, fallback) {
  if (!settings || typeof settings.get !== 'function') return fallback;
  try {
    const v = settings.get(key);
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

function list(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * Read what the player page needs from a Player-like object, the AutoMix and the settings, defensively (any
 * getter may be missing or throw while things start). Fills `out` (no allocation per frame apart from strings).
 * @param {object|null} player   Player (state, nowPlaying, position, duration, upNext, history, shuffle, repeat,
 *                               transition)
 * @param {object|null} automix  AutoMix (enabled, progress, nextItem) for the "mixing into" line
 * @param {object|null} settings Settings (fallbacks for shuffle / repeat / transition, and crossfadeSec)
 * @param {object} [out]
 */
export function playerSnapshot(player, automix, settings, out = {}) {
  out.available = !!player;
  const st = read(player, 'state', 'stopped');
  out.state = PLAYER_STATES.includes(st) ? st : 'stopped';
  const now = read(player, 'nowPlaying', null);
  const item = now && typeof now === 'object' ? now.item || null : null;
  out.hasNow = !!(now && typeof now === 'object');
  out.uid = item && item.uid != null ? item.uid : null;
  out.title = out.hasNow ? String(now.title || itemTitle(item) || 'Untitled') : '';
  out.artist = out.hasNow ? String(now.artist || (item && item.artist) || '') : '';
  out.bpm = out.hasNow && Number.isFinite(now.bpm) && now.bpm > 0 ? now.bpm : null;
  out.hue = out.hasNow && Number.isFinite(now.hue) ? now.hue : null;
  out.deckIndex = out.hasNow && (now.deckIndex === 0 || now.deckIndex === 1) ? now.deckIndex : null;
  // while stopped, nowPlaying is the song play() starts, or a song a deck plays by hand
  const decks = read(player, 'decks', null);
  const deck = out.deckIndex !== null && Array.isArray(decks) ? decks[out.deckIndex] : null;
  out.deckPlaying = !!(deck && read(deck, 'playing', false));
  const pos = read(player, 'position', 0);
  const dur = read(player, 'duration', 0);
  out.duration = Number.isFinite(dur) && dur > 0 ? dur : 0;
  out.position = Number.isFinite(pos) ? clamp(pos, 0, out.duration || Math.max(0, pos)) : 0;
  out.shuffle = !!read(player, 'shuffle', setting(settings, 'playerShuffle', false));
  out.repeat = cleanRepeat(read(player, 'repeat', setting(settings, 'playerRepeat', 'off')));
  out.transition = cleanTransition(read(player, 'transition', setting(settings, 'transitionStyle', 'dj')));
  out.crossfadeSec = cleanCrossfade(read(player, 'crossfadeSec', setting(settings, 'crossfadeSec', CROSSFADE_DEFAULT)));
  const up = list(read(player, 'upNext', null));
  const hist = list(read(player, 'history', null));
  out.upNextCount = up.length;
  out.historyCount = hist.length;
  out.firstUp = up.length ? itemTitle(up[0]) : '';
  out.autoOn = !!read(automix, 'enabled', false);
  const prog = read(automix, 'progress', null);
  out.mixProgress = Number.isFinite(prog) ? clamp(prog, 0, 1) : null;
  const next = read(automix, 'nextItem', null);
  out.mixInto = next ? itemTitle(next) : out.firstUp;
  return out;
}

/**
 * Everything the player page shows, as plain values. While stopped, the card shows the song play() starts with
 * ('READY'), or a song a deck plays by hand ('PLAYING BY HAND': Auto Mix is off, play takes it over).
 * @param {object} s playerSnapshot()
 * @returns {{stateText:string, title:string, artist:string, tags:string, deck:string, spinning:boolean,
 *   busy:boolean, playIcon:'play'|'pause', playLabel:string, active:boolean, elapsed:string, remaining:string,
 *   seek:number, seekEnabled:boolean, mixing:boolean, mixText:string, mixPct:number, sub:string, hue:number,
 *   empty:boolean}}
 *   sub: the quiet line between the times (mixing progress, or what play does while stopped)
 */
export function playerView(s) {
  const state = s && s.state ? s.state : 'stopped';
  const hasNow = !!(s && s.hasNow);
  const mixing = state === 'mixing';
  const active = state !== 'stopped';
  const v = {
    stateText: '', title: '', artist: '', tags: '', deck: '', spinning: false, busy: state === 'loading',
    playIcon: 'play', playLabel: 'Play', active, elapsed: '', remaining: '', seek: 0, seekEnabled: false, mixing,
    mixText: '', mixPct: 0, sub: '', hue: 0, empty: false,
  };
  if (!s || !s.available) {
    v.stateText = 'PLAYER';
    v.title = 'The player is not available';
    v.empty = true;
    return v;
  }
  const byHand = state === 'stopped' && hasNow && !!s.deckPlaying;
  v.stateText = {
    stopped: byHand ? 'PLAYING BY HAND' : 'READY', playing: 'NOW PLAYING', paused: 'PAUSED', loading: 'LOADING…', mixing: 'MIXING',
  }[state];
  if (state === 'stopped' && hasNow) v.sub = byHand ? 'Play hands it to the player' : 'Press play to start the queue';
  if (hasNow) {
    v.title = s.title;
    v.artist = s.artist;
    const tags = [];
    if (s.bpm) tags.push(`${Math.round(s.bpm)} BPM`);
    v.tags = tags.join(' · ');
    v.deck = s.deckIndex === 0 ? 'A' : s.deckIndex === 1 ? 'B' : '';
  } else if (s.upNextCount > 0) {
    v.title = 'Press play';
    v.artist = s.firstUp ? `Up first: ${s.firstUp}` : 'Starts the queue';
  } else {
    v.stateText = 'NOTHING PLAYING';
    v.title = 'Your queue is empty';
    v.artist = 'Add songs on the Songs page';
    v.empty = true;
  }
  v.spinning = state === 'playing' || mixing || byHand;
  const pausable = state === 'playing' || mixing || state === 'loading';
  v.playIcon = pausable ? 'pause' : 'play';
  v.playLabel = pausable ? 'Pause' : state === 'paused' ? 'Resume' : 'Play the queue';
  const dur = s.duration || 0;
  if (hasNow && dur > 0) {
    v.elapsed = fmtTime(s.position);
    v.remaining = fmtTime(Math.max(0, dur - s.position), true);
    v.seek = clamp(s.position / dur, 0, 1);
  } else if (hasNow) {
    v.elapsed = fmtTime(s.position || 0);
    v.remaining = '';
  }
  v.seekEnabled = hasNow && dur > 0 && (state === 'playing' || state === 'paused');
  if (mixing) {
    v.mixPct = s.mixProgress === null ? 0 : Math.round(s.mixProgress * 100);
    v.mixText = s.mixInto ? `Mixing into ${s.mixInto}` : 'Mixing into the next song';
    v.sub = `${v.mixText} · ${v.mixPct}%`;
  }
  v.hue = Number.isFinite(s.hue) ? ((Math.round(s.hue) % 360) + 360) % 360 : hasNow ? hashHue(s.title || 'TwinSpin') : 250;
  return v;
}

/** Seconds to seek to for a seek bar fraction (0..1) of a song `duration` s long (kept off the very end). */
export function seekTarget(fraction, duration) {
  if (!(duration > 0) || !Number.isFinite(fraction)) return 0;
  return clamp(fraction, 0, 1) * Math.max(0, duration - 0.25);
}

/** Signature of a list of queue items (uids in order): the Up next / History lists rebuild when it changes. */
export function queueKey(items, extra = '') {
  let k = String(extra);
  for (const it of list(items)) k += `|${it && it.uid != null ? it.uid : '?'}:${it && it.title ? it.title : ''}`;
  return k;
}

/**
 * Where to move a dragged Up next row so it lands on row `to` of the shown list: the playlist index of the item
 * shown there now (Playlist.move semantics: remove, then insert at that index). -1 when it cannot be found.
 * @param {object[]} shown   the Up next items as shown
 * @param {number} to        the target row
 * @param {(uid:string)=>number} indexOf  playlist.indexOf
 */
export function queueMoveIndex(shown, to, indexOf) {
  const rows = list(shown);
  if (!rows.length || !Number.isInteger(to) || to < 0 || to >= rows.length) return -1;
  const target = rows[to];
  if (!target || target.uid == null || typeof indexOf !== 'function') return -1;
  const i = indexOf(target.uid);
  return Number.isInteger(i) ? i : -1;
}

/** Toast text after a Songs page action: 'now' | 'next' | 'queue'. */
export function songActionText(kind, title) {
  const t = title ? `“${title}”` : 'The song';
  if (kind === 'now') return `Playing ${t}`;
  if (kind === 'next') return `${t} plays next`;
  return `Added ${t} to the queue`;
}

/** "History (12)" / "Up next" counts as shown in the section heads. */
export function countText(n) {
  return n > 0 ? String(n) : '';
}
