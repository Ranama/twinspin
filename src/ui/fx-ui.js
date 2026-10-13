// FX and loop panel for one deck: four FX pads (tap = latch, hold = only while held), the shared FX amount
// slider, beat loops 1/2/4/8, and the ECHO OUT / BRAKE one-shots. Phones and tablets show one panel at a time
// with an A|B target switch (settings.fxDeck); the desktop console shows both, one under each deck.
//   const fx = new FxUI(app, 0);  shell.append(fx.el);  fx.render();

import { h, setClass, setAttr, setText, trackHold, isHeld, touchedRecently, stampInput, guard } from './dom.js';
import { fmtPct } from './format.js';
import { Fader, bindPress } from './widgets/controls.js';
import { num, syncWidget } from './deck-ui.js';

// `text` carries soft hyphens (U+00AD): a pad too narrow for the word breaks it onto two lines ("FLAN-" / "GER")
// instead of letting it spill out; at normal widths no hyphen shows.
export const SHY = String.fromCharCode(0xad);
const PADS = [
  { key: 'echo', label: 'ECHO', text: 'ECHO', sub: '¾ beat' },
  { key: 'reverb', label: 'REVERB', text: `RE${SHY}VERB`, sub: 'space' },
  { key: 'flanger', label: 'FLANGER', text: `FLAN${SHY}GER`, sub: 'jet' },
  { key: 'crush', label: 'CRUSH', text: 'CRUSH', sub: 'lo-fi' },
];
const LOOPS = [1, 2, 4, 8];
const MOMENTARY_MS = 350;

export class FxUI {
  /**
   * @param {object} app the AppUI (decks, setFxDeck())
   * @param {number} index deck index
   */
  constructor(app, index) {
    this.app = app;
    this.index = index;
    this.deck = app.decks[index];
    this.id = (this.deck && this.deck.id) || (index ? 'B' : 'A');
    this.lc = this.id.toLowerCase();
    this.dirty = true;
    this.unbind = [];
    this._build();
  }

  _build() {
    const id = this.id;
    const app = this.app;
    // Target switch (A | B) for single-panel layouts, a plain title on the console.
    this.tgt = ['A', 'B'].map((t) => {
      const b = h(`button.seg-btn.fx-tgt.deck-${t.toLowerCase()}`, { type: 'button', role: 'radio', 'aria-checked': t === id ? 'true' : 'false',
        'aria-label': `Effects for deck ${t}`, text: t });
      b.addEventListener('click', () => app.setFxDeck(t));
      return b;
    });
    this.title = h('span.fx-title', {}, h(`span.fx-badge.deck-${this.lc}`, { text: id }), h('span', { text: 'FX' }));
    this.amountSlot = trackHold(h('div.fx-amount'));
    const amount = h('div.fx-amt', {}, h('span.ctl-label.fx-amt-label', { text: 'AMOUNT', 'aria-hidden': 'true' }), this.amountSlot);
    const head = h('div.fx-head', {}, h('div.seg.fx-switch', { role: 'radiogroup', 'aria-label': 'Effects target deck' }, this.tgt),
      this.title, amount);

    this.pads = PADS.map((p) => {
      const b = h(`button.pad.fx-pad.pad-${p.key}`, { type: 'button', 'aria-pressed': 'false', 'aria-label': `${p.label} effect, deck ${id}` },
        h('span.pad-label', { text: p.text }), h('span.pad-sub', { text: p.sub }));
      this._bindPad(b, p.key);
      return { key: p.key, el: b };
    });
    this.padGrid = h('div.fx-pads', {}, this.pads.map((p) => p.el));

    this.loops = LOOPS.map((n) => {
      // 'LOOP' under the number shows only where the row's LOOP label is hidden (narrow desktop FX panels)
      const b = h('button.pad.loop-pad', { type: 'button', 'aria-pressed': 'false', 'aria-label': `${n} beat loop, deck ${id}` },
        h('span.pad-label', { text: String(n) }), h('span.pad-sub.loop-sub', { text: 'LOOP', 'aria-hidden': 'true' }));
      this.unbind.push(bindPress(b, { keys: true, onPress: () => this._loop(n) }));
      return { n, el: b };
    });
    this.loopHint = h('span.loop-hint', { text: 'LOOP' });
    this.loopRow = h('div.fx-loops', {}, h('span.ctl-label.loop-label', {}, this.loopHint), this.loops.map((l) => l.el));

    this.echoOut = h('button.pad.shot.shot-echo', { type: 'button', 'aria-label': `Echo out deck ${id}` },
      h('span.pad-label', { text: 'ECHO OUT' }));
    // (two words: a narrow pad wraps them onto two lines)
    this.brake = h('button.pad.shot.shot-brake', { type: 'button', 'aria-label': `Brake stop deck ${id}` },
      h('span.pad-label', { text: 'BRAKE' }));
    const shot = (fn) => () => {
      const d = this.deck;
      if (!d.playing) {
        app.toast(`Deck ${id} is not playing.`, { deck: id });
        return;
      }
      fn(d);
    };
    const echo = shot((d) => d.echoOut());
    const brake = shot((d) => d.brake());
    this.unbind.push(bindPress(this.echoOut, { keys: true, onPress: echo }));
    this.unbind.push(bindPress(this.brake, { keys: true, onPress: brake }));
    this.shots = h('div.fx-shots', {}, this.echoOut, this.brake);

    this.el = h(`section.fx.fx-${this.lc}`, { 'aria-label': `Effects and loops, deck ${id}` },
      head, this.padGrid, this.loopRow, this.shots);

    const fx = (this.deck && this.deck.fx) || {};
    this.amount = guard('FX amount Fader', () => new Fader(this.amountSlot, {
      orientation: 'horizontal', min: 0, max: 1, value: num(fx.amount, 0.5), defaultValue: 0.5, label: 'AMOUNT',
      className: `fader-amount fader-${this.lc}`, format: fmtPct,
      onInput: (v) => {
        stampInput(this.amount);
        this.deck.setFxAmount(v);
      },
    })) || null;
  }

  _bindPad(el, key) {
    // Tap latches; a press longer than MOMENTARY_MS that switched the FX on switches it off again on release.
    let turnedOnAt = 0;
    const press = () => {
      const d = this.deck;
      const on = !!(d.fx && d.fx[key]);
      if (on) {
        turnedOnAt = 0;
        d.setFx(key, false);
      } else {
        turnedOnAt = performance.now();
        d.setFx(key, true);
      }
    };
    const release = () => {
      if (turnedOnAt && performance.now() - turnedOnAt >= MOMENTARY_MS) this.deck.setFx(key, false);
      turnedOnAt = 0;
    };
    this.unbind.push(bindPress(el, { keys: true, onPress: press, onRelease: release }));
  }

  _loop(n) {
    const d = this.deck;
    if (!d.track) {
      this.app.toast(`Load a song on deck ${this.id} first.`, { deck: this.id });
      return;
    }
    if (!(d.bpm > 0)) {
      this.app.toast(`Loops need the tempo. Wait for the BPM on deck ${this.id} or tap it in.`, { deck: this.id });
      return;
    }
    d.toggleLoop(n);
  }

  markDirty() {
    this.dirty = true;
  }

  render() {
    if (!this.dirty) return;
    this.dirty = false;
    const d = this.deck;
    if (!d) return;
    const fx = d.fx || {};
    for (const p of this.pads) {
      const on = !!fx[p.key];
      setClass(p.el, 'on', on);
      setAttr(p.el, 'aria-pressed', on ? 'true' : 'false');
    }
    const loop = d.loop || {};
    const hasBpm = d.bpm > 0 && !!d.track;
    for (const l of this.loops) {
      const on = !!loop.active && loop.beats === l.n;
      setClass(l.el, 'on', on);
      setClass(l.el, 'dim', !hasBpm);
      setAttr(l.el, 'aria-pressed', on ? 'true' : 'false');
    }
    setText(this.loopHint, loop.active && !LOOPS.includes(loop.beats) && loop.beats > 0 ? `LOOP ${fmtBeats(loop.beats)}` : 'LOOP');
    const playing = !!d.playing;
    setClass(this.echoOut, 'dim', !playing);
    setClass(this.brake, 'dim', !playing);
    if (this.amount && !isHeld(this.amountSlot) && !touchedRecently(this.amount)) syncWidget(this.amount, num(fx.amount, 0.5));
  }

  /** Reflect which deck the single-panel FX page targets. */
  setTarget(deckId) {
    for (const b of this.tgt) b.setAttribute('aria-checked', b.textContent === deckId ? 'true' : 'false');
  }

  destroy() {
    for (const u of this.unbind) if (typeof u === 'function') guard('unbind', u);
    this.unbind = [];
  }
}

function fmtBeats(b) {
  if (b >= 1) return String(Math.round(b * 100) / 100);
  if (Math.abs(b - 0.5) < 1e-6) return '½';
  if (Math.abs(b - 0.25) < 1e-6) return '¼';
  return String(Math.round(b * 100) / 100);
}
