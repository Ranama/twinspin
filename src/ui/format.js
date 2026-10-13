// Text formatting for the UI (pure, tested in tests/ui-layout.test.js): control value bubbles, song list lines,
// storage sizes, output alignment. Keep every string short and plain; numbers use tabular figures in CSS.
//   fmtEq(-1) === 'KILL'   fmtFilter(-0.5) === 'LOW-PASS 50%'   fmtXfade(0) === 'CENTRE'   fmtBytes(5e6) === '4.8 MB'

import { fmtTime, fmtBpm, gainToDb } from '../core/util.js';

/** EQ value -1..1 -> 'KILL' | '-6.0 dB' | '0 dB' | '+3.0 dB' (mirrors curves.eqGain). */
export function fmtEq(v) {
  if (!Number.isFinite(v)) return '0 dB';
  if (v <= -0.98) return 'KILL';
  const db = v < 0 ? gainToDb(Math.pow(1 + v, 2.5)) : 6 * v;
  if (Math.abs(db) < 0.05) return '0 dB';
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

/** Filter value -1..1 -> 'OFF' | 'LOW-PASS 40%' | 'HIGH-PASS 40%'. */
export function fmtFilter(v) {
  if (!Number.isFinite(v) || Math.abs(v) < 0.04) return 'OFF';
  return `${v < 0 ? 'LOW-PASS' : 'HIGH-PASS'} ${Math.round(Math.abs(v) * 100)}%`;
}

/** Crossfader -1..1 -> 'CENTRE' | 'A 40%' | 'B 100%'. */
export function fmtXfade(v) {
  if (!Number.isFinite(v) || Math.abs(v) < 0.02) return 'CENTRE';
  return `${v < 0 ? 'A' : 'B'} ${Math.round(Math.abs(v) * 100)}%`;
}

/** 0..1 -> '80%'. */
export function fmtPct(v) {
  return `${Math.round((Number.isFinite(v) ? v : 0) * 100)}%`;
}

/** Headphone cue/master blend 0..1 -> 'CUE ONLY' | 'MASTER ONLY' | 'CUE 70 / MST 30'. */
export function fmtCueMix(v) {
  if (!Number.isFinite(v) || v <= 0.02) return 'CUE ONLY';
  if (v >= 0.98) return 'MASTER ONLY';
  const m = Math.round(v * 100);
  return `CUE ${100 - m} / MST ${m}`;
}

/** Signed output alignment in ms (+ delays the speaker path). */
export function fmtAlign(ms) {
  const v = Math.round(Number.isFinite(ms) ? ms : 0);
  if (v === 0) return '0 ms';
  return v > 0 ? `+${v} ms (speaker later)` : `${v} ms (headphones later)`;
}

/** Bytes -> '820 KB' | '4.8 MB' | '1.2 GB'. */
export function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) {
    const mb = n / (1024 * 1024);
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Secondary line for a song row: 'Artist · 124 BPM · 3:45' (parts omitted when unknown). */
export function songMeta(entry) {
  if (!entry) return '';
  const parts = [];
  if (entry.artist) parts.push(String(entry.artist));
  if (Number.isFinite(entry.bpm) && entry.bpm > 0) parts.push(`${Math.round(entry.bpm * 10) / 10} BPM`);
  if (Number.isFinite(entry.duration) && entry.duration > 0) parts.push(fmtTime(entry.duration));
  return parts.join(' · ');
}

/** Song title with fallbacks: title, then file name without extension, then 'Untitled'. */
export function songTitle(entry) {
  if (!entry) return 'Untitled';
  if (entry.title) return String(entry.title);
  if (entry.fileName) return String(entry.fileName).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' ');
  return 'Untitled';
}

/** Deck time readout for the header chips: remaining ('-3:12') or elapsed ('1:05'). */
export function deckTime(position, duration, mode) {
  if (!(duration > 0)) return mode === 'remain' ? '-0:00' : '0:00';
  return mode === 'remain' ? fmtTime(Math.max(0, duration - position), true) : fmtTime(position);
}

/** BPM readout; '…' while analysing with no value yet. */
export function bpmText(bpm, analyzing) {
  if (!(Number.isFinite(bpm) && bpm > 0)) return analyzing ? '…' : '--.-';
  return fmtBpm(bpm);
}

/**
 * Visible waveform seconds for a zoom. `where` is the waveform canvas width in CSS px (WaveView: < 600 px 6 s,
 * < 1000 px 8 s, else 10 s) or, before it is laid out, a layout name (pp/pl 6, tp 8, console 10).
 */
export function waveSeconds(where, zoom) {
  let base;
  if (typeof where === 'number' && where > 0) base = where < 600 ? 6 : where < 1000 ? 8 : 10;
  else base = where === 'console' ? 10 : where === 'tp' ? 8 : 6;
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return Math.round(base * z * 10) / 10;
}

/** Zoom steps offered by the settings sheet and the waveform +/- buttons. */
export const ZOOM_STEPS = Object.freeze([0.33, 0.5, 0.67, 1, 1.5, 2, 3]);

/** Next zoom step in a direction (+1 zooms out: more seconds; -1 zooms in). */
export function stepZoom(zoom, dir) {
  const z = Number.isFinite(zoom) ? zoom : 1;
  let idx = 0;
  let best = Infinity;
  for (let i = 0; i < ZOOM_STEPS.length; i++) {
    const d = Math.abs(ZOOM_STEPS[i] - z);
    if (d < best) {
      best = d;
      idx = i;
    }
  }
  const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, idx + (dir > 0 ? 1 : -1)));
  return ZOOM_STEPS[next];
}

/** Tempo range label: 0.08 -> '±8%'. */
export function fmtRange(r) {
  return `±${Math.round((Number.isFinite(r) ? r : 0) * 100)}%`;
}
