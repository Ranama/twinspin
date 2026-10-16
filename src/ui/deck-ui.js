// One deck's on-screen controls: the header chip (title, BPM, time), the platter with its empty-deck file picker,
// the transport row (CUE / PLAY / SYNC), the tempo field (drag + nudge), the vertical tempo fader (tablet and
// desktop) and the phone "quick row" (headphone PFL + filter). AppUI creates two of these, places `chip` in the
// header and `el` in the layout grid, and calls render() once per animation frame.
//   const ui = new DeckUI(app, 0);  header.append(ui.chip);  shell.append(ui.el);  ui.render();
// State flows one way: the Deck emits 'change' -> markDirty() -> the next frame updates classes and widgets.

import { h, icon, setText, setClass, setAttr, trackHold, isHeld, touchedRecently, stampInput, fileLabel, guard } from './dom.js';
import { deckTime, bpmText, songTitle, fmtFilter } from './format.js';
import { downloadText } from './sources-text.js';
import { fmtPercent } from '../core/util.js';
import { PlatterView } from './widgets/platter.js';
import { Fader, Knob, TempoField, bindPress } from './widgets/controls.js';
import { ACCEPT } from '../audio/decode.js';

export class DeckUI {
  /**
   * @param {object} app the AppUI (decks, sync, settings, toast(), loadFiles(), openDeckSheet(), togglePfl())
   * @param {number} index 0 = A, 1 = B
   */
  constructor(app, index) {
    this.app = app;
    this.index = index;
    this.deck = app.decks[index];
    this.id = (this.deck && this.deck.id) || (index ? 'B' : 'A');
    this.lc = this.id.toLowerCase();
    this.dirty = true;
    this.unbind = [];
    this.pstate = {
      position: 0, duration: 0, playing: false, loading: false, analyzing: false, hue: null, vinyl: true,
      warn: false, synced: false, scratching: false, loaded: false,
    };
    this._buildChip();
    this._buildDeck();
    this._bindDrop();
    this._renderPlatter = () => this.platter.render(this.pstate);
    this._renderTempo = () => this.tempo.render();
  }

  // ---- DOM ------------------------------------------------------------------------------------------------

  _buildChip() {
    const id = this.id;
    this.chipTitle = h('span.chip-title', { text: 'No song' });
    this.chipBpm = h('span.chip-bpm', { text: '--.-' });
    this.chipTime = h('span.chip-time', { text: '' });
    this.chipTag = h('span.chip-tag', { text: 'SYNC' });
    this.chip = h(`button.chip.chip-${this.lc}`, { type: 'button', 'aria-label': `Deck ${id}: song details and options` },
      h(`span.chip-badge.deck-${this.lc}`, { text: id }),
      h('span.chip-main', {}, this.chipTitle, h('span.chip-row', {}, this.chipBpm, this.chipTag, this.chipTime)));
    this.chip.addEventListener('click', () => this.app.openDeckSheet(this.index));
  }

  _buildDeck() {
    const id = this.id;
    const deck = this.deck;

    // Platter + transparent picker label shown while the deck is empty (a native <label> opens the picker
    // reliably on iOS and inside sandboxed previews; PlatterView's onEmptyTap is the fallback).
    this.canvas = h('canvas.platter', { 'aria-label': `Deck ${id} record. Touch and move to scratch.`, role: 'img' });
    const pick = fileLabel('plat-load', ACCEPT, true, `Load a song on deck ${id}`, (files) => this.app.loadFiles(this.index, files));
    this.loadLabel = pick.label;
    this.loadInput = pick.input;
    this.platWrap = h('div.plat-wrap', {}, this.canvas, this.loadLabel);

    // Transport
    this.btnCue = h('button.tbtn.t-cue', { type: 'button', 'aria-label': `Cue, deck ${id}` }, h('span.t-text', { text: 'CUE' }));
    this.btnPlay = h('button.tbtn.t-play', { type: 'button', 'aria-label': `Play or pause deck ${id}` },
      icon('play', 'i-play'), icon('pause', 'i-pause'));
    this.btnSync = h('button.tbtn.t-sync', { type: 'button', 'aria-label': `Sync deck ${id} to the other deck. Hold to reset tempo.` },
      h('span.t-text', { text: 'SYNC' }));
    this.transport = h('div.transport', {}, this.btnCue, this.btnPlay, this.btnSync);

    // Tempo field (drag + nudge buttons, from the widgets module)
    this.tempoSlot = trackHold(h('div.tempo-slot'));
    this.tempoRow = h('div.tempo-row', {}, this.tempoSlot);

    // Vertical tempo fader (tablet / desktop only; CSS hides it on phones)
    this.tfSlot = trackHold(h('div.tf-slot'));
    this.tfWrap = h('div.tf-wrap', {}, h('span.ctl-label', { text: 'TEMPO' }), this.tfSlot);

    // Phone quick row: headphone pre-listen + filter
    this.qPfl = h('button.pfl.q-pfl', { type: 'button', 'aria-pressed': 'false', 'aria-label': `Headphones pre-listen, deck ${id}` },
      icon('headphones'));
    this.qFilterSlot = trackHold(h('div.q-filter'));
    this.quick = h('div.quick', {}, this.qPfl, this.qFilterSlot);

    this.el = h(`section.deck.deck-${this.lc}`, { 'aria-label': `Deck ${id}`, dataset: { deck: id } },
      this.tfWrap, this.platWrap, this.transport, this.tempoRow, this.quick);

    this._bindTransport();
    this._makeWidgets(deck);
  }

  _bindTransport() {
    const deck = this.deck;
    const app = this.app;
    const needTrack = () => {
      if (deck.track || deck.loading) return true;
      app.toast(`Load a song on deck ${this.id} first: tap the record or open Songs.`, { deck: this.id });
      return false;
    };
    this.unbind.push(bindPress(this.btnPlay, {
      keys: true,
      onPress: () => {
        if (needTrack()) deck.togglePlay();
      },
    }));
    let cueHeld = false;
    this.unbind.push(bindPress(this.btnCue, {
      keys: true,
      onPress: () => {
        if (!needTrack()) return;
        cueHeld = true;
        deck.cueDown();
      },
      onRelease: () => {
        if (!cueHeld) return;
        cueHeld = false;
        deck.cueUp();
      },
    }));
    this.unbind.push(bindPress(this.btnSync, {
      keys: true,
      onPress: () => app.sync.toggle(this.index),
      onHold: () => {
        app.sync.resetTempo(this.index);
        app.toast(`Deck ${this.id} tempo back to 0%`, { deck: this.id });
      },
    }));
    this.unbind.push(bindPress(this.qPfl, { keys: true, onPress: () => app.togglePfl(this.index) }));
  }

  _makeWidgets(deck) {
    this.platter = guard('PlatterView', () => new PlatterView(this.canvas, {
      deckId: this.id,
      onScratchBegin: () => deck.scratchBegin(),
      onScratchMove: (deltaSec, vel) => deck.scratchMove(deltaSec, vel),
      onScratchEnd: () => deck.scratchEnd(),
      onBend: (v) => deck.setBend(v),
      onEmptyTap: () => this.openPicker(),
    })) || null;
    this.tempo = guard('TempoField', () => new TempoField(this.tempoSlot, { deck })) || null;
    this.tempoFader = guard('tempo Fader', () => new Fader(this.tfSlot, {
      orientation: 'vertical', min: -1, max: 1, value: num(deck.tempo, 0), defaultValue: 0, detent: 0,
      label: 'TEMPO', className: 'fader-tempo',
      format: (v) => fmtPercent(v * num(deck.tempoRange, 0.08)),
      onInput: (v) => {
        stampInput(this.tempoFader);
        deck.setTempo(v);
      },
    })) || null;
    const mix = deck.mix || {};
    this.qFilter = guard('quick filter Knob', () => new Knob(this.qFilterSlot, {
      min: -1, max: 1, value: num(mix.filter, 0), defaultValue: 0, bipolar: true, deadZone: 0.04, bar: true,
      label: 'FILTER', size: 44, className: 'knob-quick', format: fmtFilter,
      onInput: (v) => {
        stampInput(this.qFilter);
        deck.setFilter(v);
      },
    })) || null;
  }

  _bindDrop() {
    const el = this.el;
    const hasFiles = (e) => {
      const types = e.dataTransfer && e.dataTransfer.types;
      if (!types) return false;
      for (let i = 0; i < types.length; i++) if (types[i] === 'Files') return true;
      return false;
    };
    let depth = 0;
    el.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      el.classList.add('drop');
    });
    el.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      try {
        e.dataTransfer.dropEffect = 'copy';
      } catch {
        /* ignore */
      }
    });
    el.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) el.classList.remove('drop');
    });
    el.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth = 0;
      el.classList.remove('drop');
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) this.app.loadFiles(this.index, files);
    });
  }

  /** Open the file picker for this deck (must run inside a click). */
  openPicker() {
    try {
      this.loadInput.click();
    } catch {
      /* ignore */
    }
  }

  markDirty() {
    this.dirty = true;
  }

  // ---- per frame --------------------------------------------------------------------------------------------

  /**
   * Per animation frame. The header chip always updates; the platter and tempo field only while the deck is on
   * screen (`visible` false on the phone MIX / FX / SONGS pages).
   */
  render(visible = true) {
    const d = this.deck;
    if (!d) return;
    const t = d.track || null;
    const pos = num(d.position, 0);
    const dur = num(d.duration, t ? num(t.duration, 0) : 0);
    const playing = !!d.playing;

    const st = this.pstate;
    st.position = pos;
    st.duration = dur;
    st.playing = playing;
    st.loading = !!d.loading;
    st.analyzing = !!d.analyzing;
    st.hue = t && Number.isFinite(t.hue) ? t.hue : null;
    st.vinyl = d.vinyl !== false;
    st.warn = playing && dur > 0 && dur - pos < 30;
    // SYNC badge: read live from the deck every frame (a new song switches sync off), never cached
    st.synced = !!d.synced && !!t;
    st.scratching = !!d.scratching;
    st.loaded = !!t;
    if (visible) {
      if (!this._shown && this.platter && typeof this.platter.invalidate === 'function') this.platter.invalidate();
      if (this.platter) guard('platter render', this._renderPlatter);
      if (this.tempo) guard('tempo render', this._renderTempo);
    }
    this._shown = !!visible;

    // Header chip: time every frame, BPM (may move with sync)
    setText(this.chipTime, t ? deckTime(pos, dur, this.app.settings.get('timeMode')) : '');
    setText(this.chipBpm, t ? bpmText(d.effectiveBpm, d.analyzing) : '--.-');
    setClass(this.chip, 'warn', st.warn);

    // Cue button: lit while paused on the cue point
    const atCue = !!t && !playing && Math.abs(pos - num(d.cuePoint, 0)) < 0.03;
    setClass(this.btnCue, 'on', atCue);

    if (this.dirty) {
      this.dirty = false;
      this._syncState(t, playing);
    }
  }

  _syncState(t, playing) {
    const d = this.deck;
    // a song from the music server downloads before the deck loads it (SourcesUI keeps the progress)
    const src = this.app.sourcesUI;
    const dl = src && typeof src.deckDownload === 'function' ? src.deckDownload(this.index) : null;
    const loading = !!d.loading || (!!dl && !t);
    // any deck change (sync, track, loading) repaints the record from scratch on the next frame
    if (this.platter && typeof this.platter.invalidate === 'function') guard('platter invalidate', () => this.platter.invalidate());
    let title;
    if (dl) title = downloadText(dl.p);
    else if (t) title = songTitle(t);
    else if (loading) title = 'Loading…';
    else title = 'Empty: tap to load';
    setText(this.chipTitle, title);
    setClass(this.chip, 'downloading', !!dl);
    setAttr(this.chip, 'title', dl ? `Downloading “${dl.title}” from your music server`
      : t ? `${songTitle(t)}${t.artist ? ` – ${t.artist}` : ''}` : null);
    setClass(this.chip, 'empty', !t);
    setClass(this.chip, 'synced', !!d.synced);
    setClass(this.chip, 'playing', playing);

    setClass(this.el, 'is-empty', !t && !loading);
    setClass(this.el, 'is-loading', loading);
    setClass(this.el, 'is-playing', playing);
    this.loadLabel.hidden = !!t || loading;

    setClass(this.btnPlay, 'on', playing);
    setClass(this.btnPlay, 'ready', !!t && !playing);
    setClass(this.btnPlay, 'off', !t);
    setAttr(this.btnPlay, 'aria-pressed', playing ? 'true' : 'false');
    setClass(this.btnCue, 'off', !t);
    setClass(this.btnSync, 'on', !!d.synced);
    setAttr(this.btnSync, 'aria-pressed', d.synced ? 'true' : 'false');

    const mix = d.mix || {};
    setClass(this.qPfl, 'on', !!mix.cue);
    setAttr(this.qPfl, 'aria-pressed', mix.cue ? 'true' : 'false');
    if (this.qFilter && !isHeld(this.qFilterSlot) && !touchedRecently(this.qFilter)) {
      syncWidget(this.qFilter, num(mix.filter, 0));
    }
    if (this.tempoFader && !isHeld(this.tfSlot) && !touchedRecently(this.tempoFader)) {
      syncWidget(this.tempoFader, num(d.tempo, 0));
    }
  }

  destroy() {
    for (const u of this.unbind) {
      try {
        if (typeof u === 'function') u();
      } catch {
        /* ignore */
      }
    }
    this.unbind = [];
    for (const w of [this.platter, this.tempo, this.tempoFader, this.qFilter]) {
      if (w && typeof w.destroy === 'function') guard('destroy', () => w.destroy());
    }
  }
}

/** Finite number or a fallback. */
export function num(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/** Move a Fader/Knob to a value without firing onInput, only when it differs. */
export function syncWidget(w, v) {
  if (!w) return;
  const cur = w.value;
  if (!Number.isFinite(cur) || Math.abs(cur - v) > 1e-4) guard('widget set', () => w.set(v, { silent: true }));
}
