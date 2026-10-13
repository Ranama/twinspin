// Overlay layers of the app UI: toasts, the in-page confirm dialog, the start overlay ("Tap to start"), the
// "Tap to resume audio" banner and first-run coach marks. All are plain DOM, hidden with display:none (never
// opacity:0, Safari 26 samples fixed elements for its toolbar tint). No alert()/confirm() anywhere.
//   const toasts = new Toasts(layerEl);  toasts.show('Saved', { kind: 'ok' });
//   const ok = await dialog.confirm({ title: 'Replace the song?', message: 'Deck A is playing.', ok: 'Replace' });

import { h, icon, setKids } from './dom.js';
import { env } from '../core/env.js';

// ---- Toasts ------------------------------------------------------------------------------------------------

export class Toasts {
  /** @param {HTMLElement} parent element the toast stack is appended to */
  constructor(parent) {
    this.el = h('div.toasts', { role: 'region', 'aria-label': 'Messages' });
    this.live = h('div.sr-only', { 'aria-live': 'polite', role: 'status' });
    this.alert = h('div.sr-only', { 'aria-live': 'assertive', role: 'alert' });
    parent.append(this.el, this.live, this.alert);
    this.recent = new Map(); // text -> time shown (dedupe bursts)
  }

  /**
   * Show a toast.
   * @param {string} text plain message
   * @param {{kind?:'info'|'error'|'ok', deck?:string, action?:{label:string,onClick:Function}, timeout?:number,
   *          sticky?:boolean}} opts
   * @returns {{close:Function}}
   */
  show(text, opts = {}) {
    const msg = String(text || '').trim();
    if (!msg) return { close() {} };
    const now = Date.now();
    const last = this.recent.get(msg);
    if (last && now - last < 2500) return { close() {} };
    this.recent.set(msg, now);
    if (this.recent.size > 30) this.recent.clear();

    const kind = opts.kind || 'info';
    const badge = opts.deck
      ? h('span.toast-badge.deck-' + String(opts.deck).toLowerCase(), { text: opts.deck })
      : icon(kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'info', 'toast-ico');
    const body = h('div.toast-text', { text: msg });
    const el = h('div.toast.toast-' + kind, {}, badge, body);
    let closed = false;
    let timer = 0;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      el.classList.add('out');
      setTimeout(() => el.remove(), 180);
    };
    if (opts.action) {
      const b = h('button.toast-action', { type: 'button', text: opts.action.label });
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        try {
          opts.action.onClick();
        } finally {
          close();
        }
      });
      el.append(b);
    }
    el.addEventListener('click', close);
    this.el.append(el);
    while (this.el.children.length > 3) this.el.firstChild.remove();
    (kind === 'error' ? this.alert : this.live).textContent = msg;
    if (!opts.sticky) {
      const ms = opts.timeout || (opts.action ? 8000 : kind === 'error' ? 5500 : 2800);
      timer = setTimeout(close, ms);
    }
    return { close };
  }
}

// ---- Confirm dialog ----------------------------------------------------------------------------------------

export class Dialog {
  constructor(parent) {
    this.layer = h('div.dialog-layer', { hidden: true });
    this.card = h('div.dialog', { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-title', 'aria-describedby': 'dlg-msg' });
    this.scrim = h('div.dialog-scrim');
    this.scrim.addEventListener('click', () => this._finish(false));
    this.layer.append(this.scrim, this.card);
    parent.append(this.layer);
    this._resolve = null;
    this.layer.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this._finish(false);
      }
    });
  }

  get open() {
    return !this.layer.hidden;
  }

  /**
   * In-page confirm. Resolves true for OK, false for cancel / Escape / scrim.
   * @param {{title:string, message?:string, ok?:string, cancel?:string, danger?:boolean}} o
   */
  confirm(o) {
    if (this._resolve) this._finish(false);
    const okBtn = h('button.btn.btn-primary' + (o.danger ? '.btn-danger' : ''), { type: 'button', text: o.ok || 'OK' });
    const cancelBtn = h('button.btn', { type: 'button', text: o.cancel || 'Cancel' });
    okBtn.addEventListener('click', () => this._finish(true));
    cancelBtn.addEventListener('click', () => this._finish(false));
    setKids(this.card,
      h('h2.dialog-title', { id: 'dlg-title', text: o.title || '' }),
      o.message ? h('p.dialog-msg', { id: 'dlg-msg', text: o.message }) : null,
      h('div.dialog-actions', {}, cancelBtn, okBtn));
    this._prevFocus = document.activeElement;
    this.layer.hidden = false;
    try {
      okBtn.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
    return new Promise((resolve) => {
      this._resolve = resolve;
    });
  }

  _finish(value) {
    const r = this._resolve;
    this._resolve = null;
    this.layer.hidden = true;
    try {
      if (this._prevFocus && this._prevFocus.focus) this._prevFocus.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
    if (r) r(value);
  }
}

// ---- Start overlay -----------------------------------------------------------------------------------------

export class StartOverlay {
  /**
   * @param {HTMLElement} parent
   * @param {{onStart:Function, onDemo:Function}} handlers called synchronously from the click (user activation)
   */
  constructor(parent, { onStart, onDemo }) {
    this.status = h('p.start-status', { role: 'status', 'aria-live': 'polite' });
    this.startBtn = h('button.btn.btn-start', { type: 'button' }, icon('play'), h('span', { text: 'Tap to start' }));
    this.demoBtn = h('button.btn.btn-ghost.btn-demo', { type: 'button' }, icon('songs'), h('span', { text: 'Try the demo tracks' }));
    this.startBtn.addEventListener('click', () => onStart());
    this.demoBtn.addEventListener('click', () => onDemo());
    const notes = [];
    if (!env.secure) {
      notes.push(h('p.start-note', { text: 'This page is not on https://, so TwinSpin uses its fallback sound engine. Open the https link for the best sound.' }));
    }
    this.el = h('div.start-layer', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'start-title' },
      h('div.start-card', {},
        h('div.start-discs', { 'aria-hidden': 'true' }, h('span.cd.cd-a'), h('span.cd.cd-b')),
        h('h1.start-title', { id: 'start-title' }, h('span.logo-twin', { text: 'Twin' }), h('span.logo-spin', { text: 'Spin' })),
        h('p.start-tag', { text: 'Two decks in your pocket. Load songs, sync, mix.' }),
        h('div.start-actions', {}, this.startBtn, this.demoBtn),
        this.status,
        ...notes));
    parent.append(this.el);
  }

  /** Busy state while audio starts. `text` replaces the status line (omit it to keep the current one). */
  setBusy(busy, text) {
    this.startBtn.disabled = !!busy;
    this.demoBtn.disabled = !!busy;
    this.el.classList.toggle('busy', !!busy);
    this.el.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (text !== undefined) {
      this.status.textContent = text || '';
      this.status.classList.remove('error');
    }
  }

  showError(text) {
    this.setBusy(false, text);
    this.status.classList.add('error');
    try {
      this.startBtn.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
  }

  hide() {
    this.el.hidden = true;
  }

  get visible() {
    return !this.el.hidden;
  }
}

// ---- Resume banner -----------------------------------------------------------------------------------------

export class ResumeBanner {
  constructor(parent, { onResume, onRestart }) {
    this.text = h('span.resume-text', { text: 'Sound is paused by the system.' });
    const resume = h('button.btn.btn-primary', { type: 'button', text: 'Tap to resume audio' });
    const restart = h('button.btn', { type: 'button', text: 'Restart audio' });
    resume.addEventListener('click', () => onResume());
    restart.addEventListener('click', () => onRestart());
    this.resumeBtn = resume;
    this.el = h('div.resume-banner', { role: 'alert', hidden: true }, icon('speaker', 'resume-ico'), this.text,
      h('div.resume-actions', {}, resume, restart));
    parent.append(this.el);
  }

  show(state) {
    this.text.textContent = state === 'closed'
      ? 'Audio stopped. Restart it to keep playing.'
      : 'Sound is paused by the system (a call, another app, or the screen lock).';
    this.resumeBtn.hidden = state === 'closed';
    this.el.hidden = false;
  }

  hide() {
    this.el.hidden = true;
  }
}

// ---- Coach marks -------------------------------------------------------------------------------------------

/**
 * A single floating hint bubble pointing at a target element.
 * coach.show({ target, text, step, steps, onNext, onSkip }); coach.place(); coach.hide();
 */
export class Coach {
  constructor(parent) {
    this.text = h('p.coach-text');
    this.count = h('span.coach-count');
    this.next = h('button.btn.btn-primary.btn-sm', { type: 'button', text: 'Got it' });
    this.skip = h('button.btn.btn-ghost.btn-sm', { type: 'button', text: 'Skip tips' });
    this.arrow = h('span.coach-arrow', { 'aria-hidden': 'true' });
    this.el = h('div.coach', { role: 'note', hidden: true }, this.arrow, h('div.coach-head', {}, icon('bulb', 'coach-ico'), this.count),
      this.text, h('div.coach-actions', {}, this.skip, this.next));
    parent.append(this.el);
    this.target = null;
    this.next.addEventListener('click', () => this.onNext && this.onNext());
    this.skip.addEventListener('click', () => this.onSkip && this.onSkip());
  }

  show({ target, text, step, steps, onNext, onSkip, nextLabel }) {
    this.target = target;
    this.text.textContent = text;
    this.count.textContent = `Tip ${step} of ${steps}`;
    this.next.textContent = nextLabel || 'Got it';
    this.onNext = onNext;
    this.onSkip = onSkip;
    this.el.hidden = false;
    this.place();
  }

  hide() {
    this.el.hidden = true;
    this.target = null;
  }

  get visible() {
    return !this.el.hidden;
  }

  /** Position the bubble next to its target (call after layout changes; cheap). */
  place() {
    if (this.el.hidden) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const t = this.target;
    const r = t && t.getBoundingClientRect ? t.getBoundingClientRect() : null;
    const visible = r && r.width > 0 && r.height > 0;
    const bw = Math.min(300, vw - 32);
    this.el.style.width = `${bw}px`;
    const bh = this.el.offsetHeight || 140;
    let left;
    let top;
    let below = true;
    if (visible) {
      const cx = r.left + r.width / 2;
      left = Math.max(16, Math.min(vw - bw - 16, cx - bw / 2));
      if (r.bottom + bh + 14 < vh - 8) top = r.bottom + 12;
      else if (r.top - bh - 14 > 8) {
        top = r.top - bh - 12;
        below = false;
      } else top = Math.max(8, Math.min(vh - bh - 8, r.top + r.height / 2 - bh / 2));
      const ax = Math.max(16, Math.min(bw - 16, cx - left));
      this.arrow.style.left = `${ax}px`;
      this.arrow.hidden = false;
    } else {
      left = (vw - bw) / 2;
      top = (vh - bh) / 2;
      this.arrow.hidden = true;
    }
    this.el.classList.toggle('above', !below);
    this.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }
}
