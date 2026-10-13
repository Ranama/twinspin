// The mixer: two channel strips (headphone PFL, FILTER, HI, MID, LOW, volume fader, meter), the centre section
// (master volume + meter, headphone mix and volume on tablets/desktop, Outputs button) and the crossfader row.
// Phones draw EQ/filter as bar sliders, tablets and desktop as rotary knobs: AppUI calls setKnobStyle() when the
// layout changes and the knobs are rebuilt. render() runs every animation frame (meters, the crossfader thumb
// following mixer.crossfader while Auto Mix moves it) and re-syncs widgets from the Deck state when a deck
// changed. EQ / filter / volume moves go through the Deck setters, so Auto Mix sees them as 'userAction'.
//   const mixer = new MixerUI(app);  shell.append(mixer.el, mixer.xfEl);  mixer.setKnobStyle('bar', 40);

import { h, icon, setClass, setAttr, trackHold, isHeld, touchedRecently, stampInput, guard } from './dom.js';
import { fmtEq, fmtFilter, fmtPct, fmtXfade, fmtCueMix } from './format.js';
import { Fader, Knob, MeterView, bindPress } from './widgets/controls.js';
import { num, syncWidget } from './deck-ui.js';

const BANDS = [
  { key: 'filter', label: 'FILTER' },
  { key: 'high', label: 'HI' },
  { key: 'mid', label: 'MID' },
  { key: 'low', label: 'LOW' },
];

export class MixerUI {
  /** @param {object} app the AppUI */
  constructor(app) {
    this.app = app;
    this.dirty = true;
    this.unbind = [];
    this.style = null;
    this.size = 0;
    this.strips = [this._strip(0), this._strip(1)];
    this._buildCentre();
    this.el = h('section.mixer', { 'aria-label': 'Mixer' }, this.strips[0].el, this.centre, this.strips[1].el);
    this._buildXfade();
  }

  _strip(i) {
    const app = this.app;
    const deck = app.decks[i];
    const id = (deck && deck.id) || (i ? 'B' : 'A');
    const lc = id.toLowerCase();
    const s = { i, deck, id, knobs: {}, slots: {} };
    s.pfl = h('button.pfl.strip-pfl', { type: 'button', 'aria-pressed': 'false', 'aria-label': `Headphones pre-listen, deck ${id}` },
      icon('headphones'), h('span.pfl-text', { text: id }));
    this.unbind.push(bindPress(s.pfl, { keys: true, onPress: () => app.togglePfl(i) }));
    for (const b of BANDS) s.slots[b.key] = trackHold(h(`div.kslot.k-${b.key}`));
    s.eq = h('div.eq', {}, BANDS.map((b) => s.slots[b.key]));
    s.volSlot = trackHold(h('div.vslot'));
    s.meterSlot = h('div.mslot');
    s.el = h(`div.strip.strip-${lc}`, { 'aria-label': `Channel ${id}` },
      h(`span.strip-badge.deck-${lc}`, { text: id }), s.pfl, s.eq, h('div.vol', {}, s.volSlot, s.meterSlot));
    const mix = (deck && deck.mix) || {};
    s.fader = guard('volume Fader', () => new Fader(s.volSlot, {
      orientation: 'vertical', min: 0, max: 1, value: num(mix.volume, 0.8), defaultValue: 0.8, label: 'VOL',
      className: `fader-vol fader-${lc}`, format: fmtPct,
      onInput: (v) => {
        stampInput(s.fader);
        deck.setVolume(v);
      },
    })) || null;
    s.meter = guard('MeterView', () => new MeterView(s.meterSlot, { orientation: 'vertical', segments: 12 })) || null;
    return s;
  }

  _buildCentre() {
    const app = this.app;
    this.outBtn = h('button.icon-btn.mix-out', { type: 'button', 'aria-label': 'Outputs and headphones' }, icon('outputs'));
    this.outBtn.addEventListener('click', () => app.openOutputs());
    this.masterSlot = trackHold(h('div.vslot.master-slot'));
    this.masterMeterSlot = h('div.mslot');
    this.cueMeterSlot = h('div.mslot.cue-meter');
    this.cueMixSlot = trackHold(h('div.kslot.k-cuemix'));
    this.cueVolSlot = trackHold(h('div.kslot.k-cuevol'));
    this.hp = h('div.hp', { 'aria-label': 'Headphones' },
      h('span.ctl-label.hp-label', {}, icon('headphones'), h('span', { text: 'PHONES' })),
      this.cueMixSlot, this.cueVolSlot);
    this.centre = h('div.mix-centre', {},
      this.outBtn,
      h('div.master', {}, h('span.ctl-label', { text: 'MASTER' }), h('div.vol', {}, this.masterSlot, this.masterMeterSlot)),
      this.hp, this.cueMeterSlot);
    this.master = guard('master Fader', () => new Fader(this.masterSlot, {
      orientation: 'vertical', min: 0, max: 1, value: num(app.getSetting('masterVolume'), 0.8), defaultValue: 0.8,
      label: 'MASTER', className: 'fader-master', format: fmtPct,
      onInput: (v) => {
        stampInput(this.master);
        app.setMasterVolume(v);
      },
    })) || null;
    this.masterMeter = guard('master meter', () => new MeterView(this.masterMeterSlot, { orientation: 'vertical', segments: 14 })) || null;
    this.cueMeter = guard('cue meter', () => new MeterView(this.cueMeterSlot, { orientation: 'vertical', segments: 10 })) || null;
  }

  _buildXfade() {
    const app = this.app;
    this.xfSlot = trackHold(h('div.xf-slot'));
    const mk = (i) => {
      const id = i ? 'B' : 'A';
      const b = h(`button.pfl.xf-pfl.xf-pfl-${id.toLowerCase()}`, { type: 'button', 'aria-pressed': 'false', 'aria-label': `Headphones pre-listen, deck ${id}` },
        icon('headphones'));
      this.unbind.push(bindPress(b, { keys: true, onPress: () => app.togglePfl(i) }));
      return b;
    };
    this.xfPfl = [mk(0), mk(1)];
    this.xfEl = h('section.xf', { 'aria-label': 'Crossfader' },
      this.xfPfl[0], h('span.xf-end.deck-a', { text: 'A', 'aria-hidden': 'true' }), this.xfSlot,
      h('span.xf-end.deck-b', { text: 'B', 'aria-hidden': 'true' }), this.xfPfl[1]);
    const cut = app.settings.get('xfadeCurve') === 'cut';
    this.xfader = guard('crossfader', () => new Fader(this.xfSlot, {
      orientation: 'horizontal', min: -1, max: 1, value: num(app.xfade, 0), defaultValue: 0, detent: 0,
      label: 'CROSSFADER', className: 'fader-xf', format: fmtXfade,
      // Cut curve = scratch cutting: jump to the finger and no double-tap reset (rapid taps are cuts).
      absolute: cut, doubleTapReset: !cut,
      onInput: (v) => {
        stampInput(this.xfader);
        app.setCrossfader(v);
      },
    })) || null;
  }

  /** Crossfader behaviour for the curve: 'cut' = absolute (jump to finger), no double-tap reset. */
  setCurve(curve) {
    const f = this.xfader;
    if (!f) return;
    const cut = curve === 'cut';
    if (typeof f.setAbsolute === 'function') guard('xfader absolute', () => f.setAbsolute(cut));
    if (typeof f.setDoubleTapReset === 'function') guard('xfader reset', () => f.setDoubleTapReset(!cut));
  }

  /**
   * Draw the EQ/filter knobs and the headphone knobs for a layout: bar sliders on phones, rotary knobs on
   * tablets and desktop. Knobs are created once and switched in place (Knob.setBar + --size).
   * @param {'bar'|'rotary'} style
   * @param {number} size knob diameter for rotary knobs (CSS px)
   */
  setKnobStyle(style, size) {
    const sz = Math.round(size || 48);
    if (style === this.style && (style === 'bar' || Math.abs(sz - this.size) < 4)) return;
    this.style = style;
    this.size = sz;
    const bar = style === 'bar';
    const hpSize = Math.max(36, Math.min(sz, 52));
    const restyle = (w, px) => {
      if (!w) return false;
      if (typeof w.setBar === 'function') guard('knob setBar', () => w.setBar(bar));
      if (w.el && w.el.style) w.el.style.setProperty('--size', `${px}px`);
      return true;
    };
    const app = this.app;
    for (const s of this.strips) {
      const mix = (s.deck && s.deck.mix) || {};
      const eq = mix.eq || {};
      for (const b of BANDS) {
        if (restyle(s.knobs[b.key], sz)) continue;
        const isFilter = b.key === 'filter';
        const k = { w: null };
        k.w = guard('Knob', () => new Knob(s.slots[b.key], {
          min: -1, max: 1, value: num(isFilter ? mix.filter : eq[b.key], 0), defaultValue: 0, bipolar: true,
          kill: !isFilter, deadZone: isFilter ? 0.04 : 0, bar, label: b.label, size: sz,
          className: `knob-${b.key}`, format: isFilter ? fmtFilter : fmtEq,
          onInput: (v) => {
            stampInput(k.w);
            if (isFilter) s.deck.setFilter(v);
            else s.deck.setEq(b.key, v);
          },
        })) || null;
        s.knobs[b.key] = k.w;
      }
    }
    // Headphone knobs (shown on tablet/desktop; phones set these in the Outputs sheet)
    if (!restyle(this.cueMix, hpSize)) {
      this.cueMix = guard('cue mix Knob', () => new Knob(this.cueMixSlot, {
        min: 0, max: 1, value: num(app.getSetting('cueMix'), 0), defaultValue: 0, bipolar: false, bar, label: 'CUE/MST',
        size: hpSize, className: 'knob-cuemix', format: fmtCueMix,
        onInput: (v) => {
          stampInput(this.cueMix);
          app.setCueMix(v);
        },
      })) || null;
    }
    if (!restyle(this.cueVol, hpSize)) {
      this.cueVol = guard('cue volume Knob', () => new Knob(this.cueVolSlot, {
        min: 0, max: 1, value: num(app.getSetting('cueVolume'), 0.8), defaultValue: 0.8, bipolar: false, bar, label: 'LEVEL',
        size: hpSize, className: 'knob-cuevol', format: fmtPct,
        onInput: (v) => {
          stampInput(this.cueVol);
          app.setCueVolume(v);
        },
      })) || null;
    }
    this.dirty = true;
  }

  markDirty() {
    this.dirty = true;
  }

  /**
   * Per frame. Meters read the analysers only while the mixer is on screen.
   * @param {boolean} visible is the mixer shown in the current layout/page
   * @param {object|null} mixer engine.mixer when the engine is ready
   */
  render(visible, mixer) {
    if (visible) {
      for (const s of this.strips) {
        const ch = mixer && mixer.channels ? mixer.channels[s.i] : null;
        if (s.meter) s.meter.set(ch ? peakOf(ch.meter) : 0);
      }
      if (this.masterMeter) this.masterMeter.set(mixer ? peakOf(mixer.masterMeter) : 0);
      if (this.cueMeter) this.cueMeter.set(mixer ? peakOf(mixer.cueMeter) : 0);
    }
    this._followCrossfader(mixer);
    // Auto Mix bass swaps are scheduled on the audio clock: keep the knobs moving with them while they run.
    if (this.strips.some((s) => s.deck && s.deck.eqAnimating)) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    const app = this.app;
    for (const s of this.strips) {
      const mix = (s.deck && s.deck.mix) || {};
      const eq = (s.deck && s.deck.eqShown) || mix.eq || {};
      const on = !!mix.cue;
      setClass(s.pfl, 'on', on);
      setAttr(s.pfl, 'aria-pressed', on ? 'true' : 'false');
      setClass(this.xfPfl[s.i], 'on', on);
      setAttr(this.xfPfl[s.i], 'aria-pressed', on ? 'true' : 'false');
      if (s.fader && !isHeld(s.volSlot) && !touchedRecently(s.fader)) syncWidget(s.fader, num(mix.volume, 0.8));
      for (const b of BANDS) {
        const w = s.knobs[b.key];
        if (!w || isHeld(s.slots[b.key]) || touchedRecently(w)) continue;
        syncWidget(w, num(b.key === 'filter' ? mix.filter : eq[b.key], 0));
      }
    }
    if (this.master && !isHeld(this.masterSlot) && !touchedRecently(this.master)) {
      syncWidget(this.master, num(app.getSetting('masterVolume'), 0.8));
    }
    if (this.cueMix && !isHeld(this.cueMixSlot) && !touchedRecently(this.cueMix)) {
      syncWidget(this.cueMix, num(app.getSetting('cueMix'), 0));
    }
    if (this.cueVol && !isHeld(this.cueVolSlot) && !touchedRecently(this.cueVol)) {
      syncWidget(this.cueVol, num(app.getSetting('cueVolume'), 0.8));
    }
    if (this.xfader && !isHeld(this.xfSlot) && !touchedRecently(this.xfader)) syncWidget(this.xfader, num(app.xfade, 0));
  }

  /**
   * The crossfader thumb follows mixer.crossfader every frame: Auto Mix moves it by itself during a mix (a
   * scheduled crossfade on the audio clock). Never while the user holds or just moved it.
   */
  _followCrossfader(mixer) {
    const f = this.xfader;
    if (!f || !mixer) return;
    let x;
    try {
      x = mixer.crossfader;
    } catch {
      return;
    }
    if (typeof x !== 'number' || !Number.isFinite(x)) return;
    if (isHeld(this.xfSlot) || touchedRecently(f)) return;
    const app = this.app;
    if (Math.abs(x - app.xfade) > 1e-4) app.xfade = x;
    syncWidget(f, x);
  }

  destroy() {
    for (const u of this.unbind) if (typeof u === 'function') guard('unbind', u);
    this.unbind = [];
  }
}

function peakOf(meter) {
  if (!meter || typeof meter.read !== 'function') return 0;
  try {
    const r = meter.read();
    return r && Number.isFinite(r.peak) ? r.peak : 0;
  } catch {
    return 0;
  }
}

