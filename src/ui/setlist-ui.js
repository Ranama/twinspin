// SET LIST section at the top of the Songs page / sheet / drawer: the big AUTO MIX switch with a one-line
// explanation and live status, the mix length (16 / 32 / 64 beats), MIX NOW, and the ordered set list (NOW /
// NEXT badges, BPM and duration, drag the handle to reorder, A / B to load by hand while Auto Mix is off,
// remove, Clear) with an empty state. Library and demo rows below add to it with their + buttons.
//   const sl = new SetListUI(app);  scrollBox.prepend(sl.el);  sl.setScroller(scrollBox);  sl.render();
// The list itself scrolls (touch-action: pan-y); only the grip handle starts a drag (pointer events, captured),
// so a finger on a row still scrolls the list. Arrow up / down on a focused handle moves the song by one.

import { h, icon, setKids, setText, setClass, setAttr } from './dom.js';
import { songMeta } from './format.js';
import { setListBadge, itemTitle } from './automix-text.js';
import { DragReorder } from './drag-reorder.js';

const MIX_LENGTHS = [16, 32, 64];

export class SetListUI {
  /** @param {object} app the AppUI (playlist, automix, settings, library, decks, dialog, toast(), loaders) */
  constructor(app) {
    this.app = app;
    this.scroller = null;
    this._pending = false;
    this._focusUid = null;
    this._rows = [];
    this._build();
    this.dragger = new DragReorder({
      list: this.list,
      rows: () => this._rows,
      scroller: () => this.scroller,
      onDrop: (uid, to) => this._move(uid, to),
      onEnd: () => {
        if (this._pending) this.render();
      },
    });
  }

  get playlist() {
    return this.app.playlist || null;
  }

  get automix() {
    return this.app.automix || null;
  }

  _build() {
    const app = this.app;
    // AUTO MIX card
    this.swSub = h('span.am-switch-sub', { text: 'Off' });
    this.sw = h('button.am-switch', { type: 'button', role: 'switch', 'aria-checked': 'false' },
      icon('auto', 'am-switch-ico'),
      h('span.am-switch-main', {}, h('span.am-switch-title', { text: 'AUTO MIX' }), this.swSub),
      h('span.switch', { 'aria-hidden': 'true' }, h('span.switch-dot')));
    this.sw.addEventListener('click', () => app.toggleAutomix());
    this.lenBtns = MIX_LENGTHS.map((n) => {
      const b = h('button.seg-btn', { type: 'button', role: 'radio', 'aria-checked': 'false', 'aria-label': `${n} beat mixes`, text: String(n) });
      b.addEventListener('click', () => {
        try {
          app.settings.set('mixBeats', n);
        } catch {
          /* ignore */
        }
        this.renderOptions();
      });
      return { n, b };
    });
    this.mixNowBtn = h('button.btn.btn-sm.am-card-mixnow', { type: 'button', hidden: true }, icon('auto'), h('span', { text: 'MIX NOW' }));
    this.mixNowBtn.addEventListener('click', () => app.mixNow());
    this.card = h('div.am-card', {},
      this.sw,
      h('p.am-explain', { text: 'Plays your set list from top to bottom and mixes each song into the next, like a DJ.' }),
      h('div.am-opts', {},
        h('span.am-opt-label', { text: 'Mix length' }),
        h('div.seg.am-len', { role: 'radiogroup', 'aria-label': 'Mix length in beats' }, this.lenBtns.map((x) => x.b)),
        h('span.am-opt-unit', { text: 'beats' }),
        this.mixNowBtn));

    // list
    this.countEl = h('span.songs-count');
    this.clearBtn = h('button.btn.btn-ghost.btn-sm.sl-clear', { type: 'button' }, h('span', { text: 'Clear' }));
    this.clearBtn.addEventListener('click', () => this._clear());
    this.list = h('div.sl-list', { role: 'list', 'aria-label': 'Set list, in play order' });
    this.empty = h('p.sl-empty', { text: 'Add songs with + on any song below, or tap Add music.' });
    this.el = h('div.songs-sec.sl', { 'aria-label': 'Auto Mix and set list' },
      this.card,
      h('h3.songs-h.sl-h', {}, h('span', { text: 'Set list' }), this.countEl, h('span.sl-h-gap'), this.clearBtn),
      this.list, this.empty);
    this.renderOptions();
  }

  /** The scroll box that holds the list (for auto-scroll while dragging). */
  setScroller(el) {
    this.scroller = el || null;
  }

  /** Status line + switch state (AutomixUI calls this a few times per second through addTarget). */
  update(st, on) {
    setAttr(this.sw, 'aria-checked', on ? 'true' : 'false');
    setClass(this.sw, 'on', on);
    setClass(this.card, 'on', on);
    setText(this.swSub, on ? `${st.title}${st.detail ? ` · ${st.detail}` : ''}` : 'Off');
    this.mixNowBtn.hidden = !on || st.mixing;
    this.mixNowBtn.disabled = !st.mixNow;
    if (on !== this._lastOn) {
      this._lastOn = on;
      setClass(this.list, 'auto-on', on);
      this.updateBadges();
    }
  }

  /** Mix length buttons from settings.mixBeats. */
  renderOptions() {
    let beats = 32;
    try {
      beats = Number(this.app.settings.get('mixBeats')) || 32;
    } catch {
      beats = 32;
    }
    for (const x of this.lenBtns) x.b.setAttribute('aria-checked', x.n === beats ? 'true' : 'false');
  }

  _items() {
    const pl = this.playlist;
    if (!pl) return [];
    try {
      const items = pl.items;
      return Array.isArray(items) ? items : [];
    } catch {
      return [];
    }
  }

  /** Rebuild the rows (playlist 'change'). Deferred while a row is being dragged. */
  render() {
    if (this.dragger.active) {
      this._pending = true;
      return;
    }
    this._pending = false;
    const items = this._items();
    const available = !!this.playlist;
    this.el.hidden = !available;
    if (!available) return;
    this.card.hidden = !this.automix; // a set list without Auto Mix is still a queue to load from by hand
    this.countEl.textContent = items.length ? String(items.length) : '';
    this.clearBtn.hidden = !items.length;
    this.empty.hidden = items.length > 0;
    this._rows = items.map((it, i) => this._row(it, i));
    setKids(this.list, this._rows.map((r) => r.el));
    this.updateBadges();
    if (this._focusUid != null) {
      const r = this._rows.find((x) => x.uid === this._focusUid);
      this._focusUid = null;
      if (r) {
        try {
          r.handle.focus({ preventScroll: false });
        } catch {
          /* ignore */
        }
      }
    }
  }

  _row(item, index) {
    const title = itemTitle(item);
    const uid = item.uid;
    const badge = h('span.sl-badge');
    const handle = h('button.sl-handle', { type: 'button', 'aria-label': `Move ${title}. Drag, or use the arrow keys.` }, icon('grip'));
    const meta = songMeta({ artist: item.artist, bpm: item.bpm, duration: item.duration });
    const load = (i) => {
      const id = i ? 'B' : 'A';
      const b = h(`button.load-btn.sl-load.deck-${id.toLowerCase()}`, { type: 'button', 'aria-label': `Load ${title} on deck ${id}`, text: id });
      b.addEventListener('click', () => this.app.loadSetListItem(i, item));
      return b;
    };
    const rm = h('button.icon-btn.sl-rm', { type: 'button', 'aria-label': `Remove ${title} from the set list` }, icon('close'));
    rm.addEventListener('click', () => this._remove(uid));
    const el = h('div.sl-row', { role: 'listitem', dataset: { uid: String(uid) } },
      handle,
      h('div.song-info', {}, h('span.sl-title-row', {}, badge, h('span.song-title', { text: title })),
        meta ? h('span.song-meta', { text: meta }) : null),
      load(0), load(1), rm);
    handle.addEventListener('pointerdown', (e) => this._dragStart(e, uid));
    handle.addEventListener('keydown', (e) => this._key(e, uid));
    return { uid, el, handle, badge, index };
  }

  /** NOW / NEXT / played markers (automix 'change', playlist 'change'). */
  updateBadges() {
    const pl = this.playlist;
    if (!pl || !this._rows.length) return;
    const am = this.automix;
    const enabled = !!(am && am.enabled);
    let currentIndex = -1;
    let nextIndex = -1;
    try {
      currentIndex = Number.isInteger(pl.currentIndex) ? pl.currentIndex : -1;
      const next = am && am.nextItem ? am.nextItem : typeof pl.peekNext === 'function' ? pl.peekNext() : null;
      if (next && next.uid != null) nextIndex = this._rows.findIndex((r) => r.uid === next.uid);
    } catch {
      /* ignore */
    }
    this._rows.forEach((r, i) => {
      const b = setListBadge(i, { currentIndex, nextIndex, enabled });
      setText(r.badge, b === 'now' ? 'NOW' : b === 'next' ? 'NEXT' : '');
      setClass(r.el, 'is-now', b === 'now');
      setClass(r.el, 'is-next', b === 'next');
      setClass(r.el, 'is-played', b === 'played');
    });
  }

  _remove(uid) {
    const pl = this.playlist;
    if (!pl) return;
    try {
      pl.remove(uid);
    } catch (err) {
      console.warn('[TwinSpin] set list remove failed', err);
    }
  }

  async _clear() {
    const pl = this.playlist;
    if (!pl || !this._items().length) return;
    const ok = await this.app.dialog.confirm({
      title: 'Clear the set list?',
      message: 'Your songs stay in the library. The song playing now keeps playing.',
      ok: 'Clear set list', cancel: 'Keep it',
    });
    if (!ok) return;
    try {
      pl.clear();
    } catch (err) {
      console.warn('[TwinSpin] set list clear failed', err);
    }
  }

  _move(uid, to) {
    const pl = this.playlist;
    if (!pl) return;
    try {
      pl.move(uid, to);
    } catch (err) {
      console.warn('[TwinSpin] set list move failed', err);
    }
  }

  _key(e, uid) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    e.stopPropagation();
    const i = this._rows.findIndex((r) => r.uid === uid);
    if (i < 0) return;
    const to = e.key === 'ArrowUp' ? i - 1 : i + 1;
    if (to < 0 || to >= this._rows.length) return;
    this._focusUid = uid;
    this._move(uid, to);
  }

  // ---- drag to reorder (pointer events on the handle only; drag-reorder.js) -------------------------------------

  _dragStart(e, uid) {
    this.dragger.start(e, uid);
  }

  destroy() {
    this.dragger.cancel();
  }
}
