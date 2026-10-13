// WaveView: the stacked scrolling waveforms of both decks on one canvas (A on top, B below, touching),
// with ONE shared pixels-per-second and one shared centre playhead so beats line up visually. Deck A's beat
// ticks rise from its bottom edge and deck B's hang from its top edge, meeting at the shared border (bars:
// full height 2 px, beats: 40 % 1 px; they follow the song's beat map, deck.timeOfBeat, when the analysis made
// one for a drifting tempo). Loop region, cue marker, 3-band colouring within each deck colour,
// tiles pre-rendered offscreen per track. Seconds visible = 6 / 8 / 10 (by width) x settings.waveZoom.
// Gestures: two-finger pinch or the wheel zooms (committed to settings.waveZoom on release); dragging a lane
// scrubs (and sets the cue point) when that deck is paused, and nudges it (deck.setBend) while it plays.
//
// OverviewView: one deck's whole-track strip: played part dimmed, cue triangle, loop region, last-30-s
// tint, playhead, and the Auto Mix marker (setMixMarker: planned mix-out / mix-in point). Needle lock: a tap
// seeks when the deck is paused or inaudible, otherwise a 350 ms hold (with a progress ring above the finger)
// is needed.
//
// WaveZoomButtons: optional "-" / "+" buttons that step settings.waveZoom.
//
//   const wv = new WaveView(canvas, { decks: [deckA, deckB], settings });
//   const ovA = new OverviewView(canvasA, { deck: deckA });
//   // in the shared rAF loop: wv.render(); ovA.render(); ovB.render();

import { clamp } from '../../core/util.js';
import { haptic } from '../../core/env.js';
import {
  VelocityTracker, clampZoom, pxPerSecond, pinchZoom, stepZoom, wheelZoom, wheelPixels, firstBeatIndex,
  isBarIndex, tickDensity, scrubTarget, nudgeBend, needleLockMode, holdProgress, xToFraction,
  progressFraction, ChangeSig, TAP_SLOP_PX, NEEDLE_HOLD_MS,
} from './gesture-math.js';
import { rgba, mixRgb, bandPalette } from './color-math.js';
import {
  h, fitCanvas, observeResize, readTheme, onThemeChange, nowMs, eventTime, coalesced, capturePointer,
  releasePointer, isPrimaryPress, HoldRing,
} from './dom-util.js';
import { WaveTiles, paintOverview } from './wave-tiles.js';

function deckColor(theme, deck, index) {
  const id = deck && deck.id ? deck.id : index === 1 ? 'B' : 'A';
  return id === 'B' ? theme.rgb.deckB : theme.rgb.deckA;
}

function seekFraction(deck, f) {
  if (typeof deck.seekFraction === 'function') deck.seekFraction(f);
  else deck.seek(f * (deck.duration || 0));
}

// =========================================================================================================
// WaveView

export class WaveView {
  /**
   * @param {HTMLCanvasElement} canvas  sized by CSS; top half = deck A lane, bottom half = deck B lane
   * @param {{ decks: Array, settings: object, scrubSetsCue?: boolean }} o
   */
  constructor(canvas, { decks = [], settings = null, scrubSetsCue = true } = {}) {
    this.canvas = canvas;
    this.decks = decks;
    this.settings = settings;
    this.scrubSetsCue = scrubSetsCue;
    this.ctx = canvas.getContext('2d');
    canvas.classList.add('ts-wave');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Scrolling waveforms: deck A on top, deck B below. Pinch to zoom.');
    this._tiles = [new WaveTiles(), new WaveTiles()];
    this._zoom = clampZoom(settings && typeof settings.get === 'function' ? settings.get('waveZoom') : 1);
    this._liveZoom = null; // during a pinch / wheel gesture
    this._zoomTimer = 0;
    this._tilePps = 0;
    this._g = null;
    this._theme = null;
    this._pal = [null, null];
    this._laneBg = ['', ''];
    this._palKey = ['', ''];
    this._ptrs = new Map();
    this._drag = null;
    this._pinch = null;
    this._sig = new ChangeSig(32);
    this._refs = [null, null, null, null];
    this._dprSeen = 0;

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onMenu = (e) => e.preventDefault();
    canvas.addEventListener('pointerdown', this._onDown);
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerup', this._onUp);
    canvas.addEventListener('pointercancel', this._onUp);
    canvas.addEventListener('lostpointercapture', this._onUp);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
    canvas.addEventListener('contextmenu', this._onMenu);
    this._offSettings = settings && typeof settings.on === 'function'
      ? settings.on('change', (k, v) => {
        if (k !== 'waveZoom') return;
        this._zoom = clampZoom(v);
        this._sig.invalidate();
      })
      : () => {};
    this._offResize = observeResize(canvas, () => this.resize());
    this._offTheme = onThemeChange(() => {
      this._theme = null;
      this._sig.invalidate();
      this.render();
    });
    this.resize();
  }

  /** Current zoom (settings.waveZoom, or the live value during a pinch). */
  get zoom() {
    return this._liveZoom !== null ? this._liveZoom : this._zoom;
  }

  /** Zoom in one step (fewer seconds visible). */
  zoomIn() {
    this.setZoom(stepZoom(this.zoom, 1));
  }

  /** Zoom out one step (more seconds visible). */
  zoomOut() {
    this.setZoom(stepZoom(this.zoom, -1));
  }

  setZoom(z) {
    this._liveZoom = null;
    this._commitZoom(clampZoom(z));
  }

  _commitZoom(z) {
    this._zoom = clampZoom(z);
    this._sig.invalidate();
    if (this.settings && typeof this.settings.set === 'function') {
      try {
        this.settings.set('waveZoom', Math.round(this._zoom * 1000) / 1000);
      } catch {
        /* ignore */
      }
    }
  }

  /** Re-measure (automatic via ResizeObserver). */
  resize() {
    this._dprSeen = globalThis.devicePixelRatio || 1;
    const f = fitCanvas(this.canvas, 2.5);
    const laneA = Math.floor(f.bh / 2);
    this._g = { w: f.w, h: f.h, bw: f.bw, bh: f.bh, px: f.sx, laneA, laneB: f.bh - laneA, cx: Math.round(f.bw / 2) };
    this._sig.invalidate();
    this.render();
  }

  destroy() {
    if (this._drag && this._drag.mode === 'nudge') this._setBend(this._drag, 0);
    clearTimeout(this._zoomTimer);
    const c = this.canvas;
    c.removeEventListener('pointerdown', this._onDown);
    c.removeEventListener('pointermove', this._onMove);
    c.removeEventListener('pointerup', this._onUp);
    c.removeEventListener('pointercancel', this._onUp);
    c.removeEventListener('lostpointercapture', this._onUp);
    c.removeEventListener('wheel', this._onWheel);
    c.removeEventListener('contextmenu', this._onMenu);
    this._offSettings();
    this._offResize();
    this._offTheme();
    this._tiles[0].clear();
    this._tiles[1].clear();
  }

  _ppsCss() {
    return pxPerSecond(this._g ? this._g.w : 0, this.zoom);
  }

  _ensureTheme() {
    if (this._theme) return;
    const th = (this._theme = readTheme(this.canvas));
    for (let i = 0; i < 2; i++) {
      const c = deckColor(th, this.decks[i], i);
      this._pal[i] = bandPalette(c);
      this._laneBg[i] = rgba(mixRgb(th.rgb.bg, c, th.outdoor ? 0 : 0.07), 1);
      this._palKey[i] = `${th.key}|${i}`;
    }
  }

  /** Draw one frame (call from the shared rAF loop). Skips drawing when nothing visible changed. */
  render() {
    const G = this._g;
    if (!G) return;
    if ((globalThis.devicePixelRatio || 1) !== this._dprSeen) {
      this.resize();
      return;
    }
    if (G.w < 8 || G.h < 8) return;
    const now = nowMs();
    const d = this._drag;
    if (d && d.mode === 'nudge') this._setBend(d, nudgeBend(d.vel.velocity(now), this._ppsCss()));
    this._ensureTheme();

    const ppsCss = this._ppsCss();
    const ppsDev = ppsCss * G.px;
    const zooming = this._liveZoom !== null;
    if ((!zooming || !(this._tilePps > 0)) && this._tilePps !== ppsDev) this._tilePps = ppsDev;

    // change detection: skip the frame when nothing visible moved (both decks paused, no gesture)
    const sig = this._sig;
    sig.begin();
    sig.put(ppsDev);
    sig.put(G.bw * 10000 + G.bh);
    sig.put(this._drag ? this._drag.lane + 1 : 0);
    let refsChanged = false;
    for (let i = 0; i < 2; i++) {
      const deck = this.decks[i];
      const tr = deck ? deck.track : null;
      const wf = tr ? tr.waveform : null;
      if (this._refs[i * 2] !== tr || this._refs[i * 2 + 1] !== wf) {
        this._refs[i * 2] = tr;
        this._refs[i * 2 + 1] = wf;
        refsChanged = true;
      }
      sig.put(deck ? deck.loading : false);
      if (!tr) continue;
      const loop = deck.loop;
      sig.put(Math.round((deck.position || 0) * ppsDev * 4));
      sig.put(deck.cuePoint);
      sig.put(loop && loop.active ? loop.start : -1);
      sig.put(loop && loop.active ? loop.end : -1);
      sig.put(deck.bpm != null ? deck.bpm : tr.bpm);
      sig.put(tr.firstBeat);
      sig.put(deck.analyzing);
      sig.put(deck.duration);
    }
    if (sig.same && !refsChanged) return;

    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.clearRect(0, 0, G.bw, G.bh);
    this._drawLane(g, 0, 0, G.laneA, ppsDev, ppsCss);
    this._drawLane(g, 1, G.laneA, G.laneB, ppsDev, ppsCss);
    this._drawCentre(g);
  }

  _drawLane(g, i, y0, lh, ppsDev, ppsCss) {
    const G = this._g;
    const th = this._theme;
    const px = G.px;
    const deck = this.decks[i];
    const color = deckColor(th, deck, i);
    g.fillStyle = this._laneBg[i];
    g.fillRect(0, y0, G.bw, lh);
    const tr = deck ? deck.track : null;
    const cx = G.cx;
    const fs = Math.max(11 * px, Math.min(13 * px, lh * 0.32));
    if (!tr) {
      this._text(g, `DECK ${deck && deck.id ? deck.id : i ? 'B' : 'A'} · ${deck && deck.loading ? 'LOADING…' : 'EMPTY'}`,
        28 * px, y0 + lh / 2, fs, th.css.faint, 'left');
      this._badge(g, i, y0, lh, color);
      return;
    }
    const pos = Number.isFinite(deck.position) ? deck.position : 0;
    const dur = deck.duration > 0 ? deck.duration : tr.duration > 0 ? tr.duration : 0;
    const xAt = (t) => cx + (t - pos) * ppsDev;

    // outside the track
    g.fillStyle = 'rgba(0,0,0,0.38)';
    const xs = xAt(0);
    if (xs > 0) g.fillRect(0, y0, Math.min(G.bw, xs), lh);
    const xe = xAt(dur);
    if (dur > 0 && xe < G.bw) g.fillRect(Math.max(0, xe), y0, G.bw - Math.max(0, xe), lh);

    // loop region (under the waveform)
    const loop = deck.loop;
    if (loop && loop.active && loop.end > loop.start) {
      const x0 = xAt(loop.start);
      const x1 = xAt(loop.end);
      if (x1 > 0 && x0 < G.bw) {
        g.fillStyle = rgba(th.rgb.play, 0.16);
        g.fillRect(x0, y0, x1 - x0, lh);
      }
    }

    // waveform
    const wf = tr.waveform;
    if (wf && wf.detail && wf.detail.peak && wf.detail.peak.length) {
      const tiles = this._tiles[i];
      tiles.configure(wf, this._tilePps, lh, this._pal[i], this._palKey[i]);
      tiles.draw(g, pos, cx, y0, G.bw, ppsDev, dur);
    } else {
      g.fillStyle = rgba(color, 0.45);
      const x0 = Math.max(0, xs);
      g.fillRect(x0, y0 + lh / 2 - px / 2, Math.max(0, Math.min(G.bw, xe) - x0), Math.max(1, px));
      this._text(g, deck.analyzing ? 'ANALYSING…' : 'NO WAVEFORM', 28 * px, y0 + lh / 2 - fs * 0.7, fs, th.css.dim, 'left');
    }

    // loop edges
    if (loop && loop.active && loop.end > loop.start) {
      g.fillStyle = rgba(th.rgb.play, 0.95);
      const lw = Math.max(1, Math.round(2 * px));
      const x0 = xAt(loop.start);
      const x1 = xAt(loop.end);
      if (x0 > -lw && x0 < G.bw) g.fillRect(Math.round(x0), y0, lw, lh);
      if (x1 > -lw && x1 < G.bw) g.fillRect(Math.round(x1) - lw, y0, lw, lh);
    }

    // beat grid: ticks grow from the shared border (A: bottom edge up, B: top edge down)
    const bpm = deck.bpm != null && deck.bpm > 0 ? deck.bpm : tr.bpm;
    if (bpm > 0) {
      const fb = Number.isFinite(tr.firstBeat) ? tr.firstBeat : 0;
      const pxPerBeatCss = (ppsCss * 60) / bpm;
      const density = tickDensity(pxPerBeatCss);
      if (density !== 'none') {
        const len = 60 / bpm;
        const tLeft = pos - cx / ppsDev;
        const tRight = pos + (G.bw - cx) / ppsDev;
        const thick = th.outdoor ? 1.5 : 1; // outdoor contrast: thicker strokes
        const barW = Math.max(1, Math.round(2 * px * thick));
        const beatW = Math.max(1, Math.round(px * thick));
        const beatH = Math.round(lh * 0.4);
        const fromTop = i === 1;
        const barStyle = rgba(th.rgb.text, 0.78);
        const beatStyle = rgba(th.rgb.text, 0.5);
        // songs whose tempo drifts carry a beat map (track.beats): ticks follow it through the deck's helpers
        const useMap = !!tr.beats && tr.beats.length > 1 && typeof deck.beatsAt === 'function' &&
          typeof deck.timeOfBeat === 'function';
        let kk = firstBeatIndex(tLeft, bpm, fb);
        if (useMap) {
          const k0 = deck.beatsAt(tLeft);
          if (Number.isFinite(k0)) kk = Math.ceil(k0 - 1e-9);
        }
        for (let guard = 0; guard < 2000; guard++, kk++) {
          const t = useMap ? deck.timeOfBeat(kk) : fb + kk * len;
          if (!Number.isFinite(t) || t > tRight) break;
          if (t < 0 || (dur > 0 && t > dur)) continue;
          const bar = isBarIndex(kk);
          if (!bar && density === 'bars') continue;
          const x = Math.round(xAt(t));
          if (bar) {
            g.fillStyle = barStyle;
            g.fillRect(x - (barW >> 1), y0, barW, lh);
          } else {
            g.fillStyle = beatStyle;
            g.fillRect(x - (beatW >> 1), fromTop ? y0 : y0 + lh - beatH, beatW, beatH);
          }
        }
      }
    }

    // cue point: thin line + triangle on the outer edge
    if (Number.isFinite(deck.cuePoint)) {
      const x = xAt(deck.cuePoint);
      if (x > -10 * px && x < G.bw + 10 * px) {
        g.fillStyle = rgba(th.rgb.cue, 0.85);
        g.fillRect(Math.round(x), y0, Math.max(1, Math.round(px)), lh);
        const s = Math.min(7 * px, lh * 0.22);
        g.beginPath();
        if (i === 0) {
          g.moveTo(x - s, y0);
          g.lineTo(x + s, y0);
          g.lineTo(x, y0 + s * 1.2);
        } else {
          g.moveTo(x - s, y0 + lh);
          g.lineTo(x + s, y0 + lh);
          g.lineTo(x, y0 + lh - s * 1.2);
        }
        g.closePath();
        g.fillStyle = rgba(th.rgb.cue, 1);
        g.fill();
      }
    }

    // lane being dragged
    if (this._drag && this._drag.lane === i) {
      const lw = Math.max(1, Math.round(2 * px));
      g.strokeStyle = rgba(color, 0.9);
      g.lineWidth = lw;
      g.strokeRect(lw / 2, y0 + lw / 2, G.bw - lw, lh - lw);
    }
    this._badge(g, i, y0, lh, color);
  }

  _badge(g, i, y0, lh, color) {
    const G = this._g;
    const px = G.px;
    if (lh < 22 * px) return;
    const s = 18 * px;
    const x = 5 * px;
    const y = i === 0 ? y0 + 4 * px : y0 + lh - s - 4 * px;
    g.fillStyle = rgba(color, 1);
    g.beginPath();
    if (typeof g.roundRect === 'function') g.roundRect(x, y, s, s, 4 * px);
    else g.rect(x, y, s, s);
    g.fill();
    const th = this._theme;
    g.font = `700 ${(11 * px).toFixed(1)}px ${th.fontDisplay}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = th.css.bg;
    const deck = this.decks[i];
    g.fillText(deck && deck.id ? deck.id : i ? 'B' : 'A', x + s / 2, y + s / 2 + px * 0.5);
  }

  _text(g, text, x, y, fs, color, align) {
    g.font = `600 ${fs.toFixed(1)}px ${this._theme.fontUi}`;
    g.textAlign = align;
    g.textBaseline = 'middle';
    g.fillStyle = color;
    g.fillText(text, x, y);
  }

  _drawCentre(g) {
    const G = this._g;
    const th = this._theme;
    const px = G.px;
    // shared border
    g.fillStyle = rgba(th.rgb.line, 1);
    g.fillRect(0, G.laneA - Math.floor(px / 2), G.bw, Math.max(1, Math.round(px)));
    // playhead with a dark outline and small triangles
    const w = Math.max(2, Math.round(2 * px * (th.outdoor ? 1.5 : 1)));
    const x = G.cx - (w >> 1);
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(x - Math.round(px), 0, w + Math.round(2 * px), G.bh);
    g.fillStyle = th.css.text;
    g.fillRect(x, 0, w, G.bh);
    const s = 5 * px;
    g.beginPath();
    g.moveTo(G.cx - s, 0);
    g.lineTo(G.cx + s, 0);
    g.lineTo(G.cx, s * 1.1);
    g.closePath();
    g.moveTo(G.cx - s, G.bh);
    g.lineTo(G.cx + s, G.bh);
    g.lineTo(G.cx, G.bh - s * 1.1);
    g.closePath();
    g.fill();
  }

  // -------------------------------------------------------------------------------------------------------
  // input

  _onDown(e) {
    if (!isPrimaryPress(e) || this._ptrs.size >= 2 || !this._g) return;
    e.preventDefault();
    this._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    capturePointer(this.canvas, e.pointerId);
    if (this._ptrs.size === 2) {
      this._endLaneDrag(false);
      const [a, b] = [...this._ptrs.values()];
      this._pinch = { d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), z0: this.zoom };
      this._liveZoom = this.zoom;
      clearTimeout(this._zoomTimer);
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const lane = e.clientY - rect.top < rect.height / 2 ? 0 : 1;
    const deck = this.decks[lane];
    if (!deck || !deck.track) return;
    const vel = new VelocityTracker(60);
    vel.push(eventTime(e), e.clientX);
    this._drag = {
      id: e.pointerId, lane, deck, mode: deck.playing ? 'nudge' : 'scrub', x0: e.clientX,
      pos0: Number.isFinite(deck.position) ? deck.position : 0, lastSeek: NaN, moved: false, vel, bend: 0,
    };
    this._sig.invalidate();
  }

  _onMove(e) {
    const p = this._ptrs.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this._pinch && this._ptrs.size === 2) {
      const [a, b] = [...this._ptrs.values()];
      this._liveZoom = pinchZoom(this._pinch.z0, this._pinch.d0, Math.hypot(a.x - b.x, a.y - b.y));
      return;
    }
    const d = this._drag;
    if (!d || d.id !== e.pointerId) return;
    const deck = d.deck;
    if (d.mode === 'scrub' && deck.playing) {
      d.mode = 'nudge';
      d.vel.reset();
    } else if (d.mode === 'nudge' && !deck.playing) {
      this._setBend(d, 0);
      d.mode = 'scrub';
      d.x0 = e.clientX;
      d.pos0 = Number.isFinite(deck.position) ? deck.position : 0;
    }
    const dx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dx) > TAP_SLOP_PX) d.moved = true;
    const pps = this._ppsCss();
    if (d.mode === 'scrub') {
      if (!d.moved) return;
      const target = scrubTarget(d.pos0, dx, pps, deck.duration || (deck.track && deck.track.duration) || 0);
      if (!(Math.abs(target - d.lastSeek) * pps < 0.5)) {
        d.lastSeek = target;
        deck.seek(target);
      }
    } else {
      const list = coalesced(e);
      for (let i = 0; i < list.length; i++) d.vel.push(eventTime(list[i]), list[i].clientX);
      this._setBend(d, nudgeBend(d.vel.velocity(), pps));
    }
  }

  _onUp(e) {
    if (!this._ptrs.has(e.pointerId)) return;
    this._ptrs.delete(e.pointerId);
    releasePointer(this.canvas, e.pointerId);
    if (this._pinch && this._ptrs.size < 2) {
      const z = this._liveZoom !== null ? this._liveZoom : this._zoom;
      this._pinch = null;
      this._liveZoom = null;
      this._commitZoom(z); // the remaining finger does not start a lane drag (_drag ended with the pinch)
    }
    if (this._drag && this._drag.id === e.pointerId) this._endLaneDrag(e.type === 'pointerup');
  }

  _endLaneDrag(commit) {
    const d = this._drag;
    if (!d) return;
    this._drag = null;
    this._sig.invalidate();
    if (d.mode === 'nudge') {
      this._setBend(d, 0);
    } else if (commit && d.moved && this.scrubSetsCue && !d.deck.playing) {
      // CDJ: paused + CUE = set the cue point here (Deck snaps it to the grid when quantize is on)
      const deck = d.deck;
      if (typeof deck.cueDown === 'function' && Math.abs((deck.position || 0) - (deck.cuePoint || 0)) > 0.02) {
        deck.cueDown();
        deck.cueUp();
      }
    }
  }

  _setBend(d, b) {
    if (b === d.bend) return;
    if (b !== 0 && Math.abs(b - d.bend) < 0.001) return;
    d.bend = b;
    if (typeof d.deck.setBend === 'function') d.deck.setBend(b);
  }

  _onWheel(e) {
    e.preventDefault();
    const z = wheelZoom(this.zoom, -wheelPixels(e.deltaX, e.deltaY, e.deltaMode));
    this._liveZoom = z;
    clearTimeout(this._zoomTimer);
    this._zoomTimer = setTimeout(() => {
      if (this._pinch) return;
      const v = this._liveZoom;
      this._liveZoom = null;
      if (v !== null) this._commitZoom(v);
    }, 250);
  }
}

// =========================================================================================================
// OverviewView

export class OverviewView {
  /** @param {HTMLCanvasElement} canvas  @param {{ deck: object }} o */
  constructor(canvas, { deck } = {}) {
    this.canvas = canvas;
    this.deck = deck;
    this.ctx = canvas.getContext('2d');
    canvas.classList.add('ts-overview');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `Deck ${deck && deck.id ? deck.id : ''} track overview. Tap to jump when paused; hold while playing.`);
    this._g = null;
    this._theme = null;
    this._pal = null;
    this._bg = '';
    this._static = null;
    this._staticKey = '';
    this._staticWf = null;
    this._sig = new ChangeSig(16);
    this._pid = null;
    this._seeking = false;
    this._lastF = NaN;
    this._hold = null; // { t0, f, done }
    this._holdTimer = 0;
    this._ring = new HoldRing('HOLD');
    this._dprSeen = 0;
    this._mark = NaN; // Auto Mix marker: track time of the planned mix-out (current deck) or mix-in (next deck)
    this._markKind = 0; // 0 = out, 1 = in

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onMenu = (e) => e.preventDefault();
    canvas.addEventListener('pointerdown', this._onDown);
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerup', this._onUp);
    canvas.addEventListener('pointercancel', this._onUp);
    canvas.addEventListener('lostpointercapture', this._onUp);
    canvas.addEventListener('contextmenu', this._onMenu);
    this._offResize = observeResize(canvas, () => this.resize());
    this._offTheme = onThemeChange(() => {
      this._theme = null;
      this._sig.invalidate();
      this.render();
    });
    this.resize();
  }

  resize() {
    this._dprSeen = globalThis.devicePixelRatio || 1;
    const f = fitCanvas(this.canvas, 2.5);
    this._g = { w: f.w, h: f.h, bw: f.bw, bh: f.bh, px: f.sx };
    this._sig.invalidate();
    this.render();
  }

  /**
   * Auto Mix marker in the deck colour: where the current song starts mixing out (kind 'out', a notch hanging
   * from the top edge with a line) or where the next song comes in (kind 'in', a notch rising from the bottom).
   * @param {number|null} at track time in seconds; null / NaN removes it
   * @param {'out'|'in'} [kind]
   */
  setMixMarker(at, kind = 'out') {
    this._mark = Number.isFinite(at) && at >= 0 ? at : NaN;
    this._markKind = kind === 'in' ? 1 : 0;
  }

  destroy() {
    clearTimeout(this._holdTimer);
    const c = this.canvas;
    c.removeEventListener('pointerdown', this._onDown);
    c.removeEventListener('pointermove', this._onMove);
    c.removeEventListener('pointerup', this._onUp);
    c.removeEventListener('pointercancel', this._onUp);
    c.removeEventListener('lostpointercapture', this._onUp);
    c.removeEventListener('contextmenu', this._onMenu);
    this._offResize();
    this._offTheme();
    this._ring.destroy();
    this._static = null;
  }

  render() {
    const G = this._g;
    if (!G) return;
    if ((globalThis.devicePixelRatio || 1) !== this._dprSeen) {
      this.resize();
      return;
    }
    if (G.w < 4 || G.h < 4) return;
    const now = nowMs();
    const hold = this._hold;
    if (hold && !hold.done) {
      const p = holdProgress(now - hold.t0, NEEDLE_HOLD_MS);
      this._ring.progress(p);
      if (p >= 1) this._completeHold();
    }
    if (!this._theme) {
      const th = (this._theme = readTheme(this.canvas));
      const c = deckColor(th, this.deck, 0);
      this._pal = bandPalette(c);
      this._bg = rgba(mixRgb(th.rgb.bg, c, th.outdoor ? 0 : 0.07), 1);
      this._staticKey = null;
    }
    const deck = this.deck;
    const tr = deck ? deck.track : null;
    const wf = tr ? tr.waveform : null;
    if (wf !== this._staticWf || this._staticKey !== G) {
      this._staticWf = wf;
      this._staticKey = G;
      this._static = wf ? paintOverview(wf, G.bw, G.bh, this._pal) : null;
      this._sig.invalidate();
    }
    // change detection
    const dur = deck && deck.duration > 0 ? deck.duration : tr && tr.duration > 0 ? tr.duration : 0;
    const playX = tr ? Math.round(progressFraction(deck.position, dur) * G.bw) : -1;
    const loop = deck ? deck.loop : null;
    const sig = this._sig;
    sig.begin();
    sig.put(G.bw);
    sig.put(!!tr);
    sig.put(playX);
    sig.put(dur);
    sig.put(deck ? deck.cuePoint : 0);
    sig.put(loop && loop.active ? loop.start : -1);
    sig.put(loop && loop.active ? loop.end : -1);
    sig.put(!!this._static);
    sig.put(hold && !hold.done ? Math.round(hold.f * G.bw) : -1);
    sig.put(deck ? deck.analyzing : false);
    sig.put(deck ? deck.loading : false);
    sig.put(Number.isFinite(this._mark) && dur > 0 ? Math.round((this._mark / dur) * G.bw) : -1);
    sig.put(this._markKind);
    if (sig.same) return;
    this._draw(tr, dur, playX);
  }

  _draw(tr, dur, playX) {
    const G = this._g;
    const th = this._theme;
    const g = this.ctx;
    const px = G.px;
    const deck = this.deck;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.clearRect(0, 0, G.bw, G.bh);
    g.fillStyle = this._bg;
    g.fillRect(0, 0, G.bw, G.bh);
    if (!tr) return;
    if (this._static) {
      g.drawImage(this._static, 0, 0);
    } else {
      g.fillStyle = rgba(deckColor(th, deck, 0), 0.4);
      g.fillRect(0, G.bh / 2 - px / 2, G.bw, Math.max(1, px));
    }
    if (!(dur > 0)) return;
    const xAt = (t) => (t / dur) * G.bw;
    // last 30 s tint
    if (dur > 60) {
      const xw = xAt(dur - 30);
      g.fillStyle = rgba(th.rgb.warn, 0.16);
      g.fillRect(xw, 0, G.bw - xw, G.bh);
    }
    // played part dimmed to ~40 %
    if (playX > 0) {
      g.fillStyle = rgba(th.rgb.bg, 0.6);
      g.fillRect(0, 0, playX, G.bh);
    }
    // loop
    const loop = deck.loop;
    if (loop && loop.active && loop.end > loop.start) {
      const x0 = xAt(loop.start);
      const x1 = Math.max(x0 + 2 * px, xAt(loop.end));
      g.fillStyle = rgba(th.rgb.play, 0.35);
      g.fillRect(x0, 0, x1 - x0, G.bh);
    }
    // Auto Mix: planned mix-out (top notch) / mix-in (bottom notch) in the deck colour
    if (Number.isFinite(this._mark) && this._mark <= dur) {
      const x = Math.round(xAt(this._mark));
      const col = deckColor(th, deck, 0);
      const s = Math.min(5 * px, G.bh * 0.4);
      const lw = Math.max(1, Math.round(px));
      g.fillStyle = rgba(col, 0.85);
      g.fillRect(x - (lw >> 1), 0, lw, G.bh);
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(x + lw - (lw >> 1), 0, lw, G.bh);
      g.fillStyle = rgba(col, 1);
      g.beginPath();
      if (this._markKind === 1) {
        g.moveTo(x - s, G.bh);
        g.lineTo(x + s, G.bh);
        g.lineTo(x, G.bh - s * 1.2);
      } else {
        g.moveTo(x - s, 0);
        g.lineTo(x + s, 0);
        g.lineTo(x, s * 1.2);
      }
      g.closePath();
      g.fill();
    }
    // cue triangle on the bottom edge
    if (Number.isFinite(deck.cuePoint)) {
      const x = xAt(clamp(deck.cuePoint, 0, dur));
      const s = Math.min(6 * px, G.bh * 0.42);
      g.fillStyle = rgba(th.rgb.cue, 1);
      g.beginPath();
      g.moveTo(x - s, G.bh);
      g.lineTo(x + s, G.bh);
      g.lineTo(x, G.bh - s * 1.15);
      g.closePath();
      g.fill();
    }
    // hold target
    const hold = this._hold;
    if (hold && !hold.done) {
      g.fillStyle = rgba(th.rgb.focus, 0.95);
      g.fillRect(Math.round(hold.f * G.bw) - px, 0, Math.max(2, Math.round(2 * px)), G.bh);
    }
    // playhead
    const w = Math.max(2, Math.round(2 * px));
    g.fillStyle = 'rgba(0,0,0,0.6)';
    g.fillRect(playX - (w >> 1) - Math.round(px), 0, w + Math.round(2 * px), G.bh);
    g.fillStyle = th.css.text;
    g.fillRect(playX - (w >> 1), 0, w, G.bh);
  }

  _fraction(e) {
    const r = this.canvas.getBoundingClientRect();
    return xToFraction(e.clientX - r.left, r.width);
  }

  _seek(f) {
    if (Math.abs(f - this._lastF) * (this._g ? this._g.w : 300) < 0.5) return;
    this._lastF = f;
    seekFraction(this.deck, f);
  }

  _onDown(e) {
    const deck = this.deck;
    if (this._pid !== null || !isPrimaryPress(e) || !deck || !deck.track || !(deck.duration > 0)) return;
    e.preventDefault();
    this._pid = e.pointerId;
    capturePointer(this.canvas, e.pointerId);
    const f = this._fraction(e);
    this._lastF = NaN;
    if (needleLockMode(deck) === 'tap') {
      this._seeking = true;
      this._seek(f);
    } else {
      this._seeking = false;
      this._hold = { t0: nowMs(), f, done: false };
      this._ring.show(e.clientX, e.clientY);
      this._ring.progress(0);
      clearTimeout(this._holdTimer);
      this._holdTimer = setTimeout(() => this._completeHold(), NEEDLE_HOLD_MS + 10);
    }
  }

  _onMove(e) {
    if (e.pointerId !== this._pid) return;
    const f = this._fraction(e);
    if (this._seeking) {
      this._seek(f);
    } else if (this._hold && !this._hold.done) {
      this._hold.f = f;
      this._ring.show(e.clientX, e.clientY);
    }
  }

  _completeHold() {
    const hold = this._hold;
    if (!hold || hold.done || this._pid === null) return;
    hold.done = true;
    clearTimeout(this._holdTimer);
    this._ring.progress(1);
    haptic(15);
    this._seeking = true;
    this._seek(hold.f);
    setTimeout(() => this._ring.hide(), 200);
  }

  _onUp(e) {
    if (e.pointerId !== this._pid) return;
    const id = this._pid;
    this._pid = null;
    releasePointer(this.canvas, id);
    clearTimeout(this._holdTimer);
    if (this._hold && !this._hold.done) this._ring.hide();
    this._hold = null;
    this._seeking = false;
    this._sig.invalidate();
  }
}

// =========================================================================================================
// WaveZoomButtons

/**
 * Optional "-" / "+" zoom buttons for the waveform block (step settings.waveZoom; a WaveView listening to
 * the same settings follows). Mount anywhere, e.g. absolutely positioned in the waveform block's corner.
 */
export class WaveZoomButtons {
  constructor(container, { settings, waveView = null, className } = {}) {
    this.settings = settings;
    this.waveView = waveView;
    this.el = h('div', 'ts-wzoom');
    if (className) this.el.classList.add(...String(className).split(/\s+/).filter(Boolean));
    this.out = h('button', 'ts-wzoom__btn', { type: 'button', 'aria-label': 'Show more of the waveform (zoom out)' }, ['−']);
    this.in = h('button', 'ts-wzoom__btn', { type: 'button', 'aria-label': 'Show less of the waveform (zoom in)' }, ['+']);
    this.el.append(this.out, this.in);
    this._onOut = () => this._step(-1);
    this._onIn = () => this._step(1);
    this.out.addEventListener('click', this._onOut);
    this.in.addEventListener('click', this._onIn);
    container.appendChild(this.el);
  }

  _step(dir) {
    if (this.waveView) {
      if (dir > 0) this.waveView.zoomIn();
      else this.waveView.zoomOut();
      return;
    }
    const s = this.settings;
    if (!s) return;
    try {
      s.set('waveZoom', Math.round(stepZoom(s.get('waveZoom'), dir) * 1000) / 1000);
    } catch {
      /* ignore */
    }
  }

  destroy() {
    this.out.removeEventListener('click', this._onOut);
    this.in.removeEventListener('click', this._onIn);
    this.el.remove();
  }
}
