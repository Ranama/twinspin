// Deck sheet (tap a deck's header chip): full title and artist, BPM with ×2 / ½ / TAP, tempo and its range,
// scratch mode, gain trim, Load another song, Eject. Updates live while open.
//   host.open(deckSheet(app, 0));

import { h, icon, setText, fileLabel } from '../dom.js';
import { section, note, switchRow, segmented, sliderRow } from './sheet.js';
import { Fader, bindPress } from '../widgets/controls.js';
import { ACCEPT } from '../../audio/decode.js';
import { fmtBpm, fmtPercent, fmtTime } from '../../core/util.js';
import { fmtRange, songTitle } from '../format.js';

export function deckSheet(app, index) {
  const deck = app.decks[index];
  const id = (deck && deck.id) || (index ? 'B' : 'A');
  return {
    id: `deck-${id}`,
    title: `Deck ${id}`,
    mount(body, host) {
      const lc = id.toLowerCase();
      const titleEl = h('span.ds-title');
      const artistEl = h('span.ds-artist');
      const fileEl = h('span.ds-file');
      const bpmEl = h('span.ds-bpm');
      const bpmNote = h('span.ds-bpm-note');
      const tempoEl = h('span.ds-tempo');

      const half = h('button.btn.btn-sm', { type: 'button', 'aria-label': 'Halve the BPM' }, h('span', { text: '½' }));
      const dbl = h('button.btn.btn-sm', { type: 'button', 'aria-label': 'Double the BPM' }, h('span', { text: '×2' }));
      const tap = h(`button.btn.btn-tap.deck-${lc}`, { type: 'button', 'aria-label': 'Tap tempo: tap along with the beat' }, h('span', { text: 'TAP' }));
      half.addEventListener('click', () => guarded(() => deck.halveBpm()));
      dbl.addEventListener('click', () => guarded(() => deck.doubleBpm()));
      const unTap = bindPress(tap, { keys: true, onPress: () => guarded(() => deck.tapTempo()) });
      const resetTempo = h('button.btn.btn-sm', { type: 'button' }, h('span', { text: 'Reset tempo' }));
      resetTempo.addEventListener('click', () => guarded(() => (app.sync && app.sync.resetTempo ? app.sync.resetTempo(index) : deck.resetTempo())));

      const range = segmented('Tempo range', [0.08, 0.16, 0.5].map((v) => ({ value: v, label: fmtRange(v) })), deck.tempoRange,
        (v) => guarded(() => deck.setTempoRange(v)));
      const vinyl = switchRow('Scratch on the record', 'Off: touching the record nudges the tempo instead.', deck.vinyl !== false,
        (on) => guarded(() => deck.setVinyl(on)));
      const trim = sliderRow('Gain', 'Set automatically from the song’s loudness. Adjust if it is too loud or quiet.');

      // A <label> around the file input opens the picker natively (iOS, sandboxed previews).
      const pick = fileLabel('btn.btn-primary', ACCEPT, false, `Pick a song file for deck ${id}`, (files) => {
        host.close();
        app.loadFiles(index, files);
      }, icon('folder'), h('span', { text: 'Pick a file' }));
      const load = h('button.btn', { type: 'button' }, icon('songs'), h('span', { text: 'From your songs' }));
      load.addEventListener('click', () => {
        host.close();
        app.showSongs(index);
      });
      const eject = h('button.btn.btn-danger-ghost', { type: 'button' }, icon('eject'), h('span', { text: 'Eject' }));
      eject.addEventListener('click', async () => {
        if (deck.playing && deck.audible) {
          const ok = await app.dialog.confirm({ title: `Eject deck ${id}?`, message: `Deck ${id} is playing.`, ok: 'Eject', cancel: 'Keep playing', danger: true });
          if (!ok) return;
        }
        guarded(() => deck.eject());
        host.close();
      });

      body.append(
        h(`div.ds-head.deck-${lc}`, {}, h(`span.ds-badge.deck-${lc}`, { text: id }),
          h('div.ds-names', {}, titleEl, artistEl, fileEl)),
        section('Tempo',
          h('div.ds-bpm-row', {}, h('div.ds-bpm-box', {}, bpmEl, bpmNote, tempoEl), h('div.ds-bpm-btns', {}, half, dbl, tap)),
          note('BPM wrong? Use ×2 or ½, or tap TAP four or more times along with the beat.'),
          h('div.btn-row', {}, resetTempo),
          range.el),
        section('Record', vinyl.el),
        section('Level', trim.el),
        h('div.btn-row.ds-actions', {}, pick.label, load),
        h('div.btn-row.ds-eject', {}, eject));

      const mix = deck.mix || {};
      const t0 = Number.isFinite(mix.trimDb) ? mix.trimDb : 0;
      const fmtDb = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
      trim.valueEl.textContent = fmtDb(t0);
      let trimHeldAt = 0;
      const trimFader = guarded(() => new Fader(trim.slot, {
        orientation: 'horizontal', min: -24, max: 12, value: t0, defaultValue: 0, detent: 0, label: 'GAIN',
        className: 'fader-trim', format: fmtDb,
        onInput: (v) => {
          trimHeldAt = performance.now();
          trim.valueEl.textContent = fmtDb(v);
          deck.setTrimDb(v);
        },
      }));

      const update = () => {
        const t = deck.track;
        setText(titleEl, t ? songTitle(t) : deck.loading ? 'Loading…' : 'No song loaded');
        setText(artistEl, t && t.artist ? t.artist : '');
        setText(fileEl, t ? [t.fileName || (t.source === 'demo' ? 'Demo track' : ''), t.duration > 0 ? fmtTime(t.duration) : '']
          .filter(Boolean).join(' · ') : '');
        setText(bpmEl, fmtBpm(deck.effectiveBpm));
        let n = '';
        if (t) {
          if (deck.analyzing && !(deck.bpm > 0)) n = 'Finding the BPM…';
          else if (deck.bpm > 0) {
            const conf = Number.isFinite(t.confidence) ? t.confidence : null;
            const how = t.bpmDetected && Math.abs(t.bpmDetected - deck.bpm) > 0.01 ? 'set by you' : conf != null && conf < 0.35 ? 'detected, not sure' : 'detected';
            n = `Song: ${fmtBpm(deck.bpm)} BPM (${how})${t.variable ? ' · tempo varies' : ''}`;
          } else n = 'No steady beat found. Tap it in with TAP.';
        }
        setText(bpmNote, n);
        const rate = Number.isFinite(deck.rate) ? deck.rate : 1;
        setText(tempoEl, `Tempo ${fmtPercent(rate - 1)}${deck.synced ? ' · SYNC on' : ''}`);
        range.set(deck.tempoRange);
        vinyl.set(deck.vinyl !== false);
        const m = deck.mix || {};
        if (trimFader && performance.now() - trimHeldAt > 400 && Number.isFinite(m.trimDb) && Math.abs(trimFader.value - m.trimDb) > 0.05) {
          guarded(() => trimFader.set(m.trimDb, { silent: true }));
          trim.valueEl.textContent = fmtDb(m.trimDb);
        }
        eject.disabled = !t;
      };
      update();
      const off = deck.on('change', update);
      return () => {
        off();
        if (typeof unTap === 'function') unTap();
        if (trimFader && typeof trimFader.destroy === 'function') guarded(() => trimFader.destroy());
      };
    },
  };
}

function guarded(fn) {
  try {
    return fn();
  } catch (err) {
    console.warn('[TwinSpin] deck sheet:', err);
    return null;
  }
}
