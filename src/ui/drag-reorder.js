// Drag-to-reorder for a scrolling list (the SET LIST on the Songs page, Up next on the PLAYER page). Only the
// grip handle starts a drag (pointer events, captured), so a finger on a row still scrolls the list; the dragged
// row follows the finger, the rows in between make room, the list auto-scrolls near its edges, and the drop calls
// onDrop(uid, toRow). Rows are { uid, el, handle } in the order they are shown.
//   const drag = new DragReorder({ list, rows: () => this._rows, scroller: () => this.scroll,
//     onDrop: (uid, to) => playlist.move(uid, ...), onEnd: () => this.renderIfPending() });
//   handle.addEventListener('pointerdown', (e) => drag.start(e, uid));
// The index math lives in automix-text.js (dragTargetIndex, dragShift, autoScrollStep; tested there).

import { setClass } from './dom.js';
import { dragTargetIndex, dragShift, autoScrollStep } from './automix-text.js';

export class DragReorder {
  /**
   * @param {object} o
   * @param {HTMLElement} o.list  the list element (gets .is-dragging while a row moves)
   * @param {() => Array<{uid:any, el:HTMLElement, handle:HTMLElement}>} o.rows  the rows as shown
   * @param {() => HTMLElement|null} [o.scroller]  the scroll box (auto-scroll near its edges)
   * @param {(uid:any, toRow:number) => void} o.onDrop  a row was dropped at a new place
   * @param {() => void} [o.onEnd]  after every drag (dropped or not), e.g. to apply a deferred re-render
   */
  constructor({ list, rows, scroller = () => null, onDrop, onEnd = () => {} }) {
    this.list = list;
    this.rows = rows;
    this.scroller = scroller;
    this.onDrop = onDrop;
    this.onEnd = onEnd;
    this.drag = null;
  }

  /** A row is being dragged right now. */
  get active() {
    return !!this.drag;
  }

  /** pointerdown on a row's handle. */
  start(e, uid) {
    if (this.drag) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const rows = this.rows() || [];
    const from = rows.findIndex((r) => r.uid === uid);
    if (from < 0) return;
    e.preventDefault();
    const r = rows[from];
    let rowH = 0;
    try {
      const rect = r.el.getBoundingClientRect();
      rowH = rect && rect.height > 0 ? rect.height : 0;
    } catch {
      rowH = 0;
    }
    const sc = this.scroller();
    const d = {
      pid: e.pointerId, uid, from, to: from, y0: e.clientY, y: e.clientY, rowH: rowH || 60,
      scroll0: sc ? sc.scrollTop : 0, raf: 0, handle: r.handle, rows,
    };
    this.drag = d;
    try {
      r.handle.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    setClass(r.el, 'dragging', true);
    setClass(this.list, 'is-dragging', true);
    d.onMove = (ev) => {
      if (ev.pointerId !== d.pid) return;
      d.y = ev.clientY;
      this._layout();
    };
    d.onUp = (ev) => {
      if (ev.pointerId !== d.pid) return;
      this._end(ev.type === 'pointerup');
    };
    r.handle.addEventListener('pointermove', d.onMove);
    r.handle.addEventListener('pointerup', d.onUp);
    r.handle.addEventListener('pointercancel', d.onUp);
    r.handle.addEventListener('lostpointercapture', d.onUp);
    this._tick();
  }

  /** Stop a drag without moving anything (the list is being destroyed). */
  cancel() {
    if (this.drag) this._end(false);
  }

  _layout() {
    const d = this.drag;
    if (!d) return;
    const sc = this.scroller();
    const dy = d.y - d.y0 + (sc ? sc.scrollTop - d.scroll0 : 0);
    d.to = dragTargetIndex(d.from, dy, d.rowH, d.rows.length);
    d.rows.forEach((r, i) => {
      const y = i === d.from ? dy : dragShift(i, d.from, d.to, d.rowH);
      r.el.style.transform = y ? `translateY(${Math.round(y)}px)` : '';
    });
  }

  _tick() {
    const d = this.drag;
    if (!d || typeof requestAnimationFrame !== 'function') return;
    d.raf = requestAnimationFrame(() => {
      const dd = this.drag;
      if (!dd) return;
      const sc = this.scroller();
      if (sc && typeof sc.getBoundingClientRect === 'function') {
        let rect = null;
        try {
          rect = sc.getBoundingClientRect();
        } catch {
          rect = null;
        }
        const step = rect ? autoScrollStep(dd.y, rect.top, rect.bottom) : 0;
        if (step) {
          const before = sc.scrollTop;
          sc.scrollTop = before + step;
          if (sc.scrollTop !== before) this._layout();
        }
      }
      this._tick();
    });
  }

  _end(commit) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(d.raf);
    const hd = d.handle;
    hd.removeEventListener('pointermove', d.onMove);
    hd.removeEventListener('pointerup', d.onUp);
    hd.removeEventListener('pointercancel', d.onUp);
    hd.removeEventListener('lostpointercapture', d.onUp);
    try {
      if (hd.hasPointerCapture && hd.hasPointerCapture(d.pid)) hd.releasePointerCapture(d.pid);
    } catch {
      /* ignore */
    }
    for (const r of d.rows) {
      r.el.style.transform = '';
      setClass(r.el, 'dragging', false);
    }
    setClass(this.list, 'is-dragging', false);
    if (commit && d.to !== d.from) {
      try {
        this.onDrop(d.uid, d.to);
      } catch (err) {
        console.warn('[TwinSpin] reorder failed', err);
      }
    }
    this.onEnd();
  }
}
