// Sheet host: one modal panel (bottom sheet on phones, side panel on tablets/desktop) that shows one sheet at a
// time, with a back stack (menu -> outputs -> back). A sheet definition is
//   { id, title, mount(body, host) -> optional cleanup function }
// and is mounted fresh on every open, so it always reflects current state.
//   host.open(outputsSheet(app));  host.push(settingsSheet(app));  host.back();  host.close();

import { h, icon, setKids, trackHold } from '../dom.js';

export class SheetHost {
  /**
   * @param {HTMLElement} parent overlay parent (outside the app shell)
   * @param {{onToggle?:(open:boolean)=>void}} opts
   */
  constructor(parent, opts = {}) {
    this.onToggle = opts.onToggle || (() => {});
    this.titleEl = h('h2.sheet-title', { id: 'sheet-title' });
    this.backBtn = h('button.icon-btn.sheet-back', { type: 'button', 'aria-label': 'Back' }, icon('back'));
    this.closeBtn = h('button.icon-btn.sheet-close', { type: 'button', 'aria-label': 'Close' }, icon('close'));
    this.body = h('div.sheet-body');
    this.panel = h('section.sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheet-title', tabindex: '-1' },
      h('header.sheet-head', {}, this.backBtn, this.titleEl, this.closeBtn), this.body);
    this.scrim = h('div.sheet-scrim');
    this.layer = h('div.sheet-layer', { hidden: true }, this.scrim, this.panel);
    parent.append(this.layer);
    this.stack = [];
    this.cleanup = null;
    this.backBtn.addEventListener('click', () => this.back());
    this.closeBtn.addEventListener('click', () => this.close());
    this.scrim.addEventListener('click', () => this.close());
    this.layer.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (this.stack.length > 1) this.back();
        else this.close();
      }
    });
  }

  get isOpen() {
    return !this.layer.hidden;
  }

  /** Id of the sheet on top, or null. */
  get current() {
    return this.stack.length ? this.stack[this.stack.length - 1].id : null;
  }

  /** Open a sheet as the only entry (replaces whatever is open). */
  open(def) {
    this.stack = [def];
    this._show();
  }

  /** Open a sheet on top of the current one (Back returns). */
  push(def) {
    if (!this.isOpen) return this.open(def);
    this.stack.push(def);
    this._show();
    return undefined;
  }

  back() {
    if (this.stack.length <= 1) return this.close();
    this.stack.pop();
    this._show();
    return undefined;
  }

  /** Re-mount the current sheet (after a state change that alters its structure). */
  refresh() {
    if (this.isOpen && this.stack.length) this._show(true);
  }

  close() {
    if (!this.isOpen) return;
    this._unmount();
    this.stack = [];
    this.layer.hidden = true;
    this.onToggle(false);
    try {
      if (this._prevFocus && this._prevFocus.focus) this._prevFocus.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
  }

  _unmount() {
    const c = this.cleanup;
    this.cleanup = null;
    if (typeof c === 'function') {
      try {
        c();
      } catch (err) {
        console.error('[TwinSpin] sheet cleanup failed', err);
      }
    }
  }

  _show(keepScroll) {
    const def = this.stack[this.stack.length - 1];
    const wasOpen = this.isOpen;
    const scroll = keepScroll ? this.body.scrollTop : 0;
    this._unmount();
    if (!wasOpen) this._prevFocus = document.activeElement;
    this.titleEl.textContent = def.title || '';
    this.backBtn.hidden = this.stack.length <= 1;
    this.panel.dataset.sheet = def.id || '';
    setKids(this.body);
    this.layer.hidden = false;
    try {
      const c = def.mount(this.body, this);
      this.cleanup = typeof c === 'function' ? c : null;
    } catch (err) {
      console.error('[TwinSpin] sheet failed to open', err);
      setKids(this.body, h('p.sheet-note', { text: 'This panel could not be shown. Try again, or reload the page.' }));
    }
    this.body.scrollTop = scroll;
    if (!wasOpen) {
      this.onToggle(true);
      try {
        this.closeBtn.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }
  }
}

// ---- Building blocks shared by the sheets --------------------------------------------------------------------

/** A titled section of a sheet. */
export function section(title, ...kids) {
  return h('section.sheet-sec', {}, title ? h('h3.sheet-h', { text: title }) : null, ...kids);
}

/** A paragraph of plain explanatory text. */
export function note(text, className = '') {
  return h('p.sheet-note' + (className ? '.' + className : ''), { text });
}

/**
 * A big on/off row (role=switch). onChange(newValue) is called from the click (user activation).
 * @returns {{el:HTMLElement, set:(on:boolean)=>void}}
 */
export function switchRow(label, detail, value, onChange) {
  const knob = h('span.switch', { 'aria-hidden': 'true' }, h('span.switch-dot'));
  const el = h('button.row.row-switch', { type: 'button', role: 'switch', 'aria-checked': value ? 'true' : 'false' },
    h('span.row-main', {}, h('span.row-label', { text: label }), detail ? h('span.row-detail', { text: detail }) : null), knob);
  let on = !!value;
  const set = (v) => {
    on = !!v;
    el.setAttribute('aria-checked', on ? 'true' : 'false');
  };
  el.addEventListener('click', () => {
    set(!on);
    onChange(on);
  });
  return { el, set };
}

/**
 * A segmented control: options [{value, label}], onChange(value) from a click.
 * @returns {{el:HTMLElement, set:(value:any)=>void}}
 */
export function segmented(label, options, value, onChange, opts = {}) {
  const btns = options.map((o) => {
    const b = h('button.seg-btn', { type: 'button', role: 'radio', 'aria-checked': 'false', text: o.label });
    b.addEventListener('click', () => {
      set(o.value);
      onChange(o.value);
    });
    return { b, v: o.value };
  });
  const group = h('div.seg', { role: 'radiogroup', 'aria-label': label }, btns.map((x) => x.b));
  const set = (v) => {
    for (const x of btns) x.b.setAttribute('aria-checked', x.v === v ? 'true' : 'false');
  };
  set(value);
  const el = opts.bare ? group : h('div.row.row-seg', {}, h('span.row-main', {}, h('span.row-label', { text: label }),
    opts.detail ? h('span.row-detail', { text: opts.detail }) : null, opts.extra || null), group);
  return { el, set };
}

/** A tappable navigation row with icon, label, detail and a chevron. */
export function navRow(iconName, label, detail, onClick, opts = {}) {
  const det = h('span.row-detail', { text: detail || '' });
  const el = h('button.row.row-nav' + (opts.className ? '.' + opts.className : ''), { type: 'button' },
    icon(iconName, 'row-ico'), h('span.row-main', {}, h('span.row-label', { text: label }), det),
    opts.noChevron ? null : icon('chevron', 'row-chev'));
  el.addEventListener('click', onClick);
  return { el, setDetail: (t) => { det.textContent = t || ''; } };
}

/** A labelled slot for a Fader widget inside a sheet. */
export function sliderRow(label, detail) {
  const slot = trackHold(h('div.sheet-slider'));
  const valueEl = h('span.row-value');
  const el = h('div.row.row-slider', {}, h('span.row-main', {}, h('span.row-label', { text: label }),
    detail ? h('span.row-detail', { text: detail }) : null), valueEl, slot);
  return { el, slot, valueEl };
}
