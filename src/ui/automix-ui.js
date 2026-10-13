// Auto Mix controls outside the Songs page: the AUTO switch in the tab bar (phone / tablet portrait), the status
// strip ("Next: Spore Garden · mix in 0:42" with MIX NOW; "Mixing into Spore Garden 45%" with a progress bar),
// and the planned mix markers on the overview strips. AppUI places the strip for the layout (automixPlacement in
// layout-math.js): a row above the crossfader (pp / tp), pills over the waveforms (pl) or a row inside the
// crossfader panel (console). It also routes the AutoMix / Playlist events to toasts and redraws.
//   const amui = new AutomixUI(app);  tabs.append(amui.tabBtn);  amui.bind();
//   amui.place('row', { shell, waves, xf });  amui.setShown(true);  amui.render();   // render() every frame
// Works without an AutoMix (older builds, tests): then every Auto Mix control stays hidden.

import { h, icon, setText, setClass, setAttr, guard } from './dom.js';
import { automixSnapshot, automixStatus, planOutAt, planInAt, addedText, itemTitle } from './automix-text.js';

const STATUS_EVERY = 4; // frames between status line refreshes (~15 per second)

export class AutomixUI {
  /** @param {object} app the AppUI (automix, playlist, decks, toggleAutomix(), mixNow(), overviews) */
  constructor(app) {
    this.app = app;
    this.am = app.automix || null;
    this.available = !!this.am;
    this._snap = {};
    this._status = null;
    this._frame = 0;
    this._dirty = true;
    this._where = '';
    this._shown = null;
    this._targets = []; // extra status targets: objects with update(status, on) (the Songs page card)
    this._markKey = '';
    this._offs = [];
    this._build();
  }

  _build() {
    const app = this.app;
    // Tab-bar switch (pp / tp): one tap from every page.
    this.tabBtn = h('button.tab.tab-auto', { type: 'button', role: 'switch', 'aria-checked': 'false',
      'aria-label': 'Auto Mix: plays the set list by itself and mixes each song into the next' },
    h('span.am-mini', { 'aria-hidden': 'true' }, h('span.am-mini-dot')), h('span.tab-text', { text: 'AUTO MIX' }));
    this.tabBtn.addEventListener('click', () => app.toggleAutomix());
    this.tabBtn.hidden = !this.available;

    // Status strip
    this.toggleText = h('span.am-toggle-text', { text: 'AUTO' });
    this.toggleBtn = h('button.am-toggle', { type: 'button', role: 'switch', 'aria-checked': 'false',
      'aria-label': 'Auto Mix on or off' }, h('span.am-mini', { 'aria-hidden': 'true' }, h('span.am-mini-dot')), this.toggleText);
    this.toggleBtn.addEventListener('click', () => app.toggleAutomix());
    this.titleEl = h('span.am-title', { text: 'Auto Mix off' });
    this.detailEl = h('span.am-detail', { text: '' });
    this.barFill = h('span.am-bar-fill');
    this.bar = h('span.am-bar', { 'aria-hidden': 'true' }, this.barFill);
    this.info = h('div.am-info', {}, h('span.am-line', {}, icon('auto', 'am-ico'), this.titleEl, this.detailEl), this.bar);
    this.mixNowBtn = h('button.am-mixnow', { type: 'button', 'aria-label': 'Mix into the next song now' }, h('span', { text: 'MIX NOW' }));
    this.mixNowBtn.addEventListener('click', () => app.mixNow());
    this.el = h('section.am-strip', { 'aria-label': 'Auto Mix', hidden: true }, this.toggleBtn, this.info, this.mixNowBtn);
  }

  /** Subscribe to the AutoMix / Playlist events (called once by AppUI). */
  bind() {
    const app = this.app;
    const am = this.am;
    const mark = () => {
      this._dirty = true;
    };
    if (am && typeof am.on === 'function') {
      this._offs.push(am.on('change', () => {
        mark();
        app.onAutomixChange();
      }));
      this._offs.push(am.on('error', (msg) => {
        const empty = /set list/i.test(String(msg || ''));
        app.toast(msg, { kind: 'error', action: empty ? { label: 'Songs', onClick: () => app.showSongs() } : undefined });
        mark();
      }));
      this._offs.push(am.on('takeover', (msg) => {
        app.toast(msg || 'Auto Mix off. You took over the mix.', { action: { label: 'Turn on', onClick: () => app.setAutomix(true) } });
        mark();
        app.onAutomixChange();
      }));
      this._offs.push(am.on('finished', () => {
        app.toast('Set list finished. Auto Mix is off.', { kind: 'ok' });
        mark();
        app.onAutomixChange();
      }));
    }
    const pl = app.playlist;
    if (pl && typeof pl.on === 'function') {
      this._offs.push(pl.on('change', () => {
        mark();
        app.songs.renderSetList();
      }));
    }
  }

  /** Is Auto Mix switched on right now? */
  get enabled() {
    return !!(this.am && this.am.enabled);
  }

  /** Switch Auto Mix on or off. Needs running audio; an empty set list is explained by AutoMix ('error'). */
  setEnabled(on) {
    const app = this.app;
    const am = this.am;
    if (!am) return;
    if (on && !(app.engine && app.engine.ready)) {
      app.toast('Tap Start first so TwinSpin can play sound.', { kind: 'error' });
      return;
    }
    const was = !!am.enabled;
    guard('automix toggle', () => (typeof am.setEnabled === 'function' ? am.setEnabled(!!on) : am.toggle()));
    const now = !!am.enabled;
    if (now && !was) app.toast('Auto Mix on. It plays the set list and mixes each song into the next.', { kind: 'ok' });
    else if (!now && was) app.toast('Auto Mix off. The music keeps playing.');
    app.onAutomixChange();
  }

  /** MIX NOW: start the transition at the next bar (or as soon as the next song is ready). */
  mixNow() {
    const am = this.am;
    if (!am || !am.enabled || typeof am.mixNow !== 'function') return;
    guard('automix mix now', () => am.mixNow());
    this._dirty = true;
  }

  /**
   * Add songs to the end of the set list: library entries ({ id, title, ... }) or demos ({ kind: 'demo', id }).
   * Toasts what happened unless `quiet`.
   * @returns {number} how many were added
   */
  addToSetList(entries, { quiet = false } = {}) {
    const app = this.app;
    const pl = app.playlist;
    const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
    if (!pl || !list.length) return 0;
    let n = 0;
    try {
      const added = pl.add(list);
      n = Array.isArray(added) ? added.length : list.length;
    } catch (err) {
      console.warn('[TwinSpin] set list add failed', err);
      app.toast("Those songs couldn't be added to the set list. Try again.", { kind: 'error' });
      return 0;
    }
    if (!n) {
      app.toast('The set list is full. Remove some songs first.', { kind: 'error' });
      return 0;
    }
    if (!quiet) app.toast(addedText(n, n === 1 ? itemTitle(list[0]) : ''), { kind: 'ok' });
    return n;
  }

  /** Register an extra place that shows the status (the Songs page card). */
  addTarget(t) {
    if (t) this._targets.push(t);
    this._dirty = true;
  }

  /**
   * Put the strip where the layout wants it: 'row' (shell grid row above the crossfader), 'waves' (pills over
   * the waveforms) or 'xf' (inside the crossfader panel).
   */
  place(where, { shell, waves, xf }) {
    if (where === this._where && this.el.parentNode) return;
    this._where = where;
    this.el.dataset.where = where;
    if (where === 'xf' && xf) xf.insertBefore(this.el, xf.firstChild);
    else if (where === 'waves' && waves) waves.appendChild(this.el);
    else if (shell) {
      if (xf && xf.parentNode === shell) shell.insertBefore(this.el, xf);
      else shell.appendChild(this.el);
    }
    this._dirty = true;
  }

  /** Show or hide the strip (AppUI decides per layout / page). */
  setShown(on) {
    const v = !!on && this.available;
    if (v === this._shown) return;
    this._shown = v;
    this.el.hidden = !v;
    this._dirty = true;
  }

  markDirty() {
    this._dirty = true;
  }

  /** Per animation frame: refresh the status (throttled) and the overview markers. */
  render() {
    if (!this.available) return;
    this._frame++;
    if (!this._dirty && this._frame % STATUS_EVERY !== 0) return;
    this._dirty = false;
    const app = this.app;
    automixSnapshot(this.am, app.decks, this._snap);
    const st = automixStatus(this._snap);
    this._status = st;
    const on = this._snap.enabled;
    // switches
    for (const b of [this.tabBtn, this.toggleBtn]) {
      setAttr(b, 'aria-checked', on ? 'true' : 'false');
      setClass(b, 'on', on);
    }
    setText(this.toggleText, this._where === 'waves' && on ? st.short : 'AUTO');
    // strip
    setClass(this.el, 'on', on);
    setClass(this.el, 'mixing', st.mixing);
    setText(this.titleEl, st.title);
    setText(this.detailEl, st.detail);
    this.bar.hidden = !st.mixing;
    if (st.mixing) this.barFill.style.setProperty('--p', String((st.pct || 0) / 100));
    this.mixNowBtn.hidden = !on || st.mixing;
    this.mixNowBtn.disabled = !st.mixNow;
    for (const t of this._targets) guard('automix status target', () => t.update(st, on));
    this._renderMarkers();
  }

  /** The planned mix-out point on the current deck's overview and the mix-in point on the next deck's. */
  _renderMarkers() {
    const app = this.app;
    const am = this.am;
    const ovs = app.overviews || [];
    let outAt = null;
    let inAt = null;
    let cur = null;
    if (am && am.enabled) {
      const plan = am.plan || null;
      cur = am.currentDeck === 0 || am.currentDeck === 1 ? am.currentDeck : null;
      outAt = planOutAt(plan);
      inAt = am.nextReady ? planInAt(plan) : null;
    }
    const key = `${cur}|${outAt}|${inAt}`;
    if (key === this._markKey) return;
    this._markKey = key;
    for (let i = 0; i < 2; i++) {
      const ov = ovs[i];
      if (!ov || typeof ov.setMixMarker !== 'function') continue;
      let at = null;
      let kind = 'out';
      if (cur !== null) {
        if (i === cur) at = outAt;
        else {
          at = inAt;
          kind = 'in';
        }
      }
      guard('mix marker', () => ov.setMixMarker(at, kind));
    }
  }

  /** The last computed status (tests, diagnostics). */
  get status() {
    return this._status;
  }

  destroy() {
    for (const off of this._offs) guard('automix off', off);
    this._offs = [];
  }
}
