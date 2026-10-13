// Auto Mix wording and small pure helpers for the UI (no DOM, tested in tests/ui-automix.test.js): the status
// line shown on the DECKS page / crossfader panel / Songs card, the set list row badges, the countdown text and
// the drag-to-reorder index math of the set list.
//   const st = automixStatus(automixSnapshot(automix, decks));   // { show, title, detail, short, pct, mixNow }
//   setListBadge(2, { currentIndex: 1, nextIndex: 2, enabled: true }) === 'next'
//   dragTargetIndex(0, 130, 64, 5) === 2

import { fmtTime } from '../core/util.js';

/** Countdown text: 42 -> '0:42', 65.2 -> '1:06' (rounded up so it never shows 0:00 early), null -> ''. */
export function fmtCountdown(sec) {
  if (!Number.isFinite(sec)) return '';
  return fmtTime(Math.max(0, Math.ceil(sec - 1e-6)));
}

/** Plain words for a transition mode ('match' | 'meet' | 'cut'). */
export function mixModeText(mode) {
  if (mode === 'match') return 'beat-matched';
  if (mode === 'meet') return 'tempos meet half way';
  if (mode === 'cut') return 'quick blend';
  return '';
}

/**
 * Read what the status line needs from an AutoMix-like object and the decks, defensively (any field may be
 * missing while the controller is starting). Allocates one small object: call it a few times per second at
 * most, or reuse `out`.
 * @param {object|null} am  AutoMix (enabled, state, currentDeck, nextItem, nextReady, secondsToMix, progress, plan)
 * @param {object[]} [decks]
 * @param {object} [out]  object to fill (avoids allocation in the frame loop)
 */
export function automixSnapshot(am, decks, out = {}) {
  const ok = !!am;
  out.available = ok;
  out.enabled = ok && !!am.enabled;
  out.state = ok && typeof am.state === 'string' ? am.state : 'off';
  const next = ok ? am.nextItem : null;
  out.nextTitle = next ? itemTitle(next) : '';
  out.nextReady = ok && !!am.nextReady;
  out.secondsToMix = ok && Number.isFinite(am.secondsToMix) ? am.secondsToMix : null;
  out.progress = ok && Number.isFinite(am.progress) ? am.progress : null;
  const plan = ok ? am.plan : null;
  out.mode = plan ? planMode(plan) : '';
  const cur = ok && (am.currentDeck === 0 || am.currentDeck === 1) ? am.currentDeck : null;
  out.currentDeck = cur;
  out.remaining = null;
  out.incomingTitle = '';
  if (cur !== null && decks && decks[cur]) {
    const d = decks[cur];
    const dur = Number.isFinite(d.duration) && d.duration > 0 ? d.duration : 0;
    const rate = Number.isFinite(d.rate) && d.rate > 0 ? d.rate : 1;
    if (dur > 0 && Number.isFinite(d.position)) out.remaining = Math.max(0, (dur - d.position) / rate);
    const other = decks[1 - cur];
    if (other && other.track) out.incomingTitle = trackTitle(other.track);
  }
  return out;
}

/**
 * The Auto Mix status line.
 * @param {object} s  automixSnapshot()
 * @returns {{show:boolean, on:boolean, title:string, detail:string, short:string, pct:number|null, mixNow:boolean,
 *            mixing:boolean}}
 *   title: bold first part ('Next: Spore Garden'), detail: the rest ('mix in 0:42'), short: a few characters for
 *   tiny pills ('0:42', '45%', 'AUTO'), pct: 0..100 while mixing, mixNow: whether MIX NOW can be pressed.
 */
export function automixStatus(s) {
  const r = { show: false, on: false, title: 'Auto Mix off', detail: 'Plays your set list by itself', short: 'AUTO', pct: null,
    mixNow: false, mixing: false };
  if (!s || !s.available) {
    r.detail = '';
    return r;
  }
  const state = s.state || 'off';
  if (!s.enabled && state !== 'finished') return r;
  r.show = true;
  r.on = true;
  if (state === 'finished') {
    r.on = false;
    r.title = 'Set list finished';
    r.detail = 'Auto Mix is off';
    return r;
  }
  if (state === 'starting' || state === 'off') {
    r.title = 'Auto Mix';
    r.detail = 'Starting…';
    r.short = 'AUTO';
    return r;
  }
  if (state === 'mixing') {
    const pct = s.progress === null ? 0 : Math.round(Math.max(0, Math.min(1, s.progress)) * 100);
    const into = s.nextTitle || s.incomingTitle;
    r.mixing = true;
    r.pct = pct;
    r.title = into ? `Mixing into ${into}` : 'Mixing';
    r.detail = `${pct}%`;
    r.short = `${pct}%`;
    return r;
  }
  // 'playing' | 'preparing'
  if (s.nextTitle) {
    r.title = `Next: ${s.nextTitle}`;
    if (!s.nextReady) r.detail = 'getting it ready…';
    else if (s.secondsToMix !== null) r.detail = `mix in ${fmtCountdown(s.secondsToMix)}`;
    else r.detail = 'ready';
    r.short = s.nextReady && s.secondsToMix !== null ? fmtCountdown(s.secondsToMix) : 'AUTO';
    // MIX NOW also works before the next song is ready: Auto Mix then mixes as soon as it is
    r.mixNow = true;
    return r;
  }
  r.title = 'Last song';
  r.detail = s.remaining !== null ? `ends in ${fmtCountdown(s.remaining)}` : 'then the set ends';
  r.short = 'LAST';
  return r;
}

/** Title of a set list item ({ title } or { kind:'demo', id }). */
export function itemTitle(item) {
  if (!item) return '';
  if (item.title) return String(item.title);
  if (item.fileName) return String(item.fileName).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' ');
  return item.kind === 'demo' ? 'Demo track' : 'Untitled';
}

function trackTitle(t) {
  return itemTitle(t);
}

/** Mode of a planned transition, wherever the planner put it (plan.mode or plan.tempo.mode). */
export function planMode(plan) {
  if (!plan) return '';
  if (typeof plan.mode === 'string') return plan.mode;
  if (plan.tempo && typeof plan.tempo.mode === 'string') return plan.tempo.mode;
  return '';
}

/** Track time (s) where the current song starts mixing out, or null (plan.out.at, plan.outAt). */
export function planOutAt(plan) {
  if (!plan) return null;
  const o = plan.out;
  if (o && Number.isFinite(o.at)) return o.at;
  if (Number.isFinite(o)) return o;
  if (Number.isFinite(plan.outAt)) return plan.outAt;
  return null;
}

/** Track time (s) of the next song's mix-in point, or null (plan.in / plan.in.at / plan.inAt / plan.inPoint). */
export function planInAt(plan) {
  if (!plan) return null;
  const i = plan.in;
  if (Number.isFinite(i)) return i;
  if (i && Number.isFinite(i.at)) return i.at;
  if (Number.isFinite(plan.inAt)) return plan.inAt;
  if (Number.isFinite(plan.inPoint)) return plan.inPoint;
  return null;
}

/**
 * Badge for a set list row: 'now' (Auto Mix is playing it), 'next' (mixed in next), 'played' (already played in
 * this run) or ''. NOW / NEXT only while Auto Mix is on; played songs stay dimmed after it stops.
 * @param {number} index row index
 * @param {{currentIndex:number, nextIndex:number, enabled:boolean}} o
 */
export function setListBadge(index, { currentIndex = -1, nextIndex = -1, enabled = false } = {}) {
  if (enabled && index === currentIndex && currentIndex >= 0) return 'now';
  if (enabled && index === nextIndex && nextIndex >= 0) return 'next';
  if (currentIndex >= 0 && index < currentIndex) return 'played';
  return '';
}

/**
 * Where a dragged row lands: rows are `rowH` px tall, the finger moved `dy` px from where the row started.
 * The row moves once the finger passes half of the neighbour. Result clamped to 0..count-1.
 */
export function dragTargetIndex(from, dy, rowH, count) {
  if (!(count > 0)) return 0;
  const h = rowH > 0 ? rowH : 1;
  const steps = dy >= 0 ? Math.floor(dy / h + 0.5) : -Math.floor(-dy / h + 0.5);
  return Math.max(0, Math.min(count - 1, from + steps));
}

/**
 * Offset (px) for the row at `index` while row `from` is dragged to `to`: rows between shift by one row height
 * to make room. The dragged row itself follows the finger (not handled here).
 */
export function dragShift(index, from, to, rowH) {
  if (index === from) return 0;
  if (from < to && index > from && index <= to) return -rowH;
  if (from > to && index < from && index >= to) return rowH;
  return 0;
}

/**
 * Auto-scroll speed while dragging near the edges of a scroll box: px per frame, negative = up.
 * @param {number} y pointer clientY
 * @param {number} top box top (clientY)
 * @param {number} bottom box bottom (clientY)
 */
export function autoScrollStep(y, top, bottom, edge = 44, max = 14) {
  if (!(bottom > top)) return 0;
  if (y < top + edge) return -Math.round(max * Math.min(1, (top + edge - y) / edge));
  if (y > bottom - edge) return Math.round(max * Math.min(1, (y - (bottom - edge)) / edge));
  return 0;
}

/** Short text for "added to the set list" toasts. */
export function addedText(count, firstTitle) {
  if (count === 1 && firstTitle) return `Added “${firstTitle}” to the set list`;
  return `Added ${count} song${count === 1 ? '' : 's'} to the set list`;
}
