// PlatterView: the CD jog wheel on a <canvas>. The hero visual: dark rim with grip ticks, an iridescent
// rainbow data side that rotates with the track under a fixed specular highlight, faint grooves, a label
// in the track's hue with the upright deck letter, a 12 o'clock marker, spindle hole, progress arc on the
// rim (deck colour, blinking --warn in the last 30 s), loading/analysing ring, empty "+ LOAD" state, a
// deck-colour glow while touched and a SYNC badge.
//
// Touch: with vinyl on the disc scratches (deltaSec = unwrapped finger angle / 2PI * 1.8 s, coalesced
// pointer samples when available) and is drawn from the finger while held; with vinyl off it bends
// (clamp(angular speed / (2PI/1.8) * 0.06, +-0.12), decaying to 0 within 150 ms after release). On
// platters >= 200 px the outer 30 % ring always bends. Tapping the empty platter calls onEmptyTap from a
// `click` (user activation, so it may open a file picker).
//
// Performance: static art is painted once into offscreen canvases (platter-art.js); each frame only
// composites and rotates them, and a paused, untouched platter is not redrawn at all.
//
//   const pv = new PlatterView(canvas, { deckId: 'A', onScratchBegin: () => deck.scratchBegin(),
//     onScratchMove: (d, v) => deck.scratchMove(d, v), onScratchEnd: () => deck.scratchEnd(),
//     onBend: (b) => deck.setBend(b), onEmptyTap: () => pickFileFor('A') });
//   // in the shared rAF loop:
//   pv.render({ position, duration, playing, loading, analyzing, hue, vinyl, warn, synced, scratching, loaded });

import { clamp } from '../../core/util.js';
import {
  TAU, AngleTracker, VelocityTracker, angleDelta, pointAngle, angleToSeconds, platterAngle,
  bendFromAngularVelocity, bendRelease, platterZone, nudgeRingInner, progressFraction, endWarning,
  wheelPixels, SECONDS_PER_TURN, BEND_RELEASE_MS, MAX_BEND,
} from './gesture-math.js';
import { rgba } from './color-math.js';
import {
  fitCanvas, observeResize, readTheme, onThemeChange, deckRgb, nowMs, eventTime, coalesced, capturePointer,
  releasePointer, isPrimaryPress,
} from './dom-util.js';
import { GEOM, paintDisc, paintLabel, paintOverlay, paintCap, paintGlow } from './platter-art.js';

const noop = () => {};
const DEFAULT_HUE = { A: 212, B: 24 };
const RELEASE_BLEND_MS = 140;

export class PlatterView {
  /**
   * @param {HTMLCanvasElement} canvas  sized by CSS (square works best); the view handles DPR itself
   * @param {object} o
   * @param {'A'|'B'} o.deckId
   * @param {function():void} [o.onScratchBegin]
   * @param {function(number, number):void} [o.onScratchMove]  (deltaSec since begin, finger speed in s/s)
   * @param {function():void} [o.onScratchEnd]
   * @param {function(number):void} [o.onBend]  -0.12..0.12; 0 after release
   * @param {function():void} [o.onEmptyTap]  from a click (user activation)
   */
  constructor(canvas, { deckId = 'A', onScratchBegin, onScratchMove, onScratchEnd, onBend, onEmptyTap } = {}) {
    this.canvas = canvas;
    this.deckId = deckId === 'B' ? 'B' : 'A';
    this._cb = {
      begin: onScratchBegin || noop,
      move: onScratchMove || noop,
      end: onScratchEnd || noop,
      bend: onBend || noop,
      empty: onEmptyTap || null,
    };
    this.ctx = canvas.getContext('2d');
    canvas.classList.add('ts-platter', this.deckId === 'B' ? 'ts-deck-b' : 'ts-deck-a');
    if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '0');

    this._st = {
      position: 0, duration: 0, playing: false, loading: false, analyzing: false, hue: null, vinyl: true,
      warn: null, synced: false, scratching: false, loaded: false,
    };
    this._g = null; // geometry
    this._theme = null;
    this._L = { disc: null, discKey: '', label: null, labelKey: '', overlay: null, overlayKey: '', cap: null,
      capKey: '', glow: null, glowKey: '' };
    this._last = { angle: NaN, frac: NaN, flags: -1, glow: -1, w: 0 };
    this._ariaKey = -1;

    // touch state
    this._pid = null;
    this._mode = null; // 'scratch' | 'bend' | null
    this._cx = 0;
    this._cy = 0;
    this._turn = new AngleTracker(8);
    this._vel = new VelocityTracker(45);
    this._baseAngle = 0;
    this._fingerAngle = 0;
    this._displayAngle = 0;
    this._blend = null; // { angle, t0, offset }
    this._bendSent = 0;
    this._bendRel = null; // { from, t0 }
    this._bendTimer = 0;
    this._glow = 0;
    this._lastNow = 0;
    this._pendingResize = false;
    this._dprSeen = 0;

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onClick = this._onClick.bind(this);
    this._onKey = this._onKey.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onMenu = (e) => e.preventDefault();
    canvas.addEventListener('pointerdown', this._onDown);
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerup', this._onUp);
    canvas.addEventListener('pointercancel', this._onUp);
    canvas.addEventListener('lostpointercapture', this._onUp);
    canvas.addEventListener('click', this._onClick);
    canvas.addEventListener('keydown', this._onKey);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
    canvas.addEventListener('contextmenu', this._onMenu);
    this._offResize = observeResize(canvas, () => this.resize());
    this._offTheme = onThemeChange(() => {
      this._theme = null;
      this._draw(nowMs(), true);
    });
    this._updateAria();
    this.resize();
  }

  /**
   * Draw one frame from deck state. Cheap when nothing moved (paused, untouched): no redraw.
   * @param {object} state { position, duration, playing, loading, analyzing, hue, vinyl, warn, synced,
   *   scratching, loaded }
   */
  render(state) {
    if (state) {
      const s = this._st;
      s.position = Number.isFinite(state.position) ? state.position : 0;
      s.duration = Number.isFinite(state.duration) ? state.duration : 0;
      s.playing = !!state.playing;
      s.loading = !!state.loading;
      s.analyzing = !!state.analyzing;
      s.hue = Number.isFinite(state.hue) ? state.hue : null;
      s.vinyl = state.vinyl !== false;
      s.warn = state.warn === undefined || state.warn === null ? null : !!state.warn;
      s.synced = !!state.synced;
      s.scratching = !!state.scratching;
      s.loaded = !!state.loaded;
    }
    const dpr = globalThis.devicePixelRatio || 1;
    if (dpr !== this._dprSeen) this.resize();
    const now = nowMs();
    this._stepBend(now);
    this._updateAria();
    this._draw(now, false);
  }

  /**
   * Force a full redraw on the next render() (deck state that is not part of the per-frame flags changed, or a
   * canvas that was hidden comes back: never show stale pixels such as an old SYNC badge).
   */
  invalidate() {
    this._last.flags = -1;
    this._last.w = -1;
  }

  /** Re-measure the canvas (called automatically by a ResizeObserver). Deferred while touched. */
  resize() {
    if (this._pid !== null) {
      this._pendingResize = true;
      return;
    }
    this._pendingResize = false;
    this._dprSeen = globalThis.devicePixelRatio || 1;
    const f = fitCanvas(this.canvas, 3);
    const D = Math.min(f.w, f.h);
    const margin = Math.max(4, Math.round(D * 0.045));
    const Rcss = Math.max(1, D / 2 - margin);
    const px = f.sx;
    this._g = {
      w: f.w, h: f.h, bw: f.bw, bh: f.bh, px, D, margin, Rcss,
      R: Rcss * px,
      S: Math.max(2, Math.round(Rcss * px * 2)),
      ring: nudgeRingInner(Rcss, D),
    };
    this._last.w = -1;
    this._draw(nowMs(), true);
  }

  destroy() {
    if (this._mode === 'scratch') this._cb.end();
    if (this._bendSent !== 0) this._cb.bend(0);
    clearTimeout(this._bendTimer);
    const c = this.canvas;
    c.removeEventListener('pointerdown', this._onDown);
    c.removeEventListener('pointermove', this._onMove);
    c.removeEventListener('pointerup', this._onUp);
    c.removeEventListener('pointercancel', this._onUp);
    c.removeEventListener('lostpointercapture', this._onUp);
    c.removeEventListener('click', this._onClick);
    c.removeEventListener('keydown', this._onKey);
    c.removeEventListener('wheel', this._onWheel);
    c.removeEventListener('contextmenu', this._onMenu);
    this._offResize();
    this._offTheme();
    this._L = null;
  }

  // -------------------------------------------------------------------------------------------------------
  // state helpers

  _isEmpty() {
    const s = this._st;
    return !s.loaded && !s.loading;
  }

  _updateAria() {
    const empty = this._isEmpty();
    const key = (empty ? 1 : 0) | (this._st.loading ? 2 : 0);
    if (key === this._ariaKey) return;
    this._ariaKey = key;
    const c = this.canvas;
    c.setAttribute('role', empty ? 'button' : 'img');
    c.setAttribute('aria-label', empty ? `Deck ${this.deckId}: load a song` : this._st.loading
      ? `Deck ${this.deckId}: loading` : `Deck ${this.deckId} platter. Drag in a circle to scratch.`);
    c.classList.toggle('is-empty', empty);
  }

  _ensureLayers() {
    const G = this._g;
    if (!this._theme) this._theme = readTheme(this.canvas);
    const th = this._theme;
    const L = this._L;
    const S = G.S;
    const k1 = `${S}|${th.key}`;
    if (L.discKey !== k1) {
      L.disc = paintDisc(S, th, G.px);
      L.discKey = k1;
    }
    const hue = this._st.hue !== null ? this._st.hue : this._st.loaded ? DEFAULT_HUE[this.deckId] : null;
    const k2 = `${S}|${hue}`;
    if (L.labelKey !== k2) {
      L.label = paintLabel(S, hue, G.px);
      L.labelKey = k2;
    }
    const k3 = `${S}|${G.ring}`;
    if (L.overlayKey !== k3) {
      L.overlay = paintOverlay(S, G.px, G.ring);
      L.overlayKey = k3;
    }
    const k4 = `${S}|${th.key}|${this.deckId}`;
    if (L.capKey !== k4) {
      L.cap = paintCap(S, th, this.deckId, G.px);
      L.capKey = k4;
    }
    const m = Math.round(G.margin * G.px);
    const k5 = `${S}|${m}|${th.key}`;
    if (L.glowKey !== k5) {
      L.glow = paintGlow(S, m, deckRgb(th, this.deckId));
      L.glowKey = k5;
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // drawing

  _draw(now, force) {
    const G = this._g;
    if (!G || G.D < 16 || !this._L) return;
    const st = this._st;
    const dt = this._lastNow ? clamp((now - this._lastNow) / 1000, 0, 0.1) : 0;
    this._lastNow = now;
    this._ensureLayers();
    const th = this._theme;
    const reduced = th.reducedMotion;
    const empty = this._isEmpty();
    const loaded = st.loaded;

    // rotation: from the finger while scratching, else from the audio position (with a short blend after
    // release so the disc does not jump while the audio catches up with the finger)
    let angle = 0;
    if (loaded) {
      if (this._mode === 'scratch') {
        angle = this._fingerAngle;
      } else {
        angle = platterAngle(st.position, SECONDS_PER_TURN);
        const b = this._blend;
        if (b) {
          if (b.offset === null) b.offset = angleDelta(angle, b.angle);
          const k = 1 - (now - b.t0) / RELEASE_BLEND_MS;
          if (k <= 0) this._blend = null;
          else angle += b.offset * k;
        }
      }
    }
    this._displayAngle = angle;

    const touched = this._mode !== null || st.scratching;
    const target = touched ? 1 : 0;
    if (this._glow !== target) {
      const step = dt > 0 ? dt / 0.09 : 1;
      this._glow = this._glow < target ? Math.min(target, this._glow + step) : Math.max(target, this._glow - step * 0.7);
    }
    const warnOn = loaded && (st.warn !== null ? st.warn : endWarning(st.position, st.duration));
    const frac = loaded ? progressFraction(st.position, st.duration) : 0;
    const animating = st.loading || st.analyzing || (warnOn && st.playing && !reduced) || (this._glow > 0 && this._glow < 1) ||
      this._blend !== null || (empty && !reduced);
    const flags = (loaded ? 1 : 0) | (st.loading ? 2 : 0) | (st.analyzing ? 4 : 0) | (st.synced ? 8 : 0) |
      (warnOn ? 16 : 0) | (empty ? 32 : 0) | (st.playing ? 64 : 0);
    const last = this._last;
    if (!force && !animating && last.w === G.bw && last.flags === flags && last.glow === this._glow &&
      Math.abs(last.angle - angle) < 0.0005 && Math.abs(last.frac - frac) < 0.0004) {
      return;
    }
    last.w = G.bw;
    last.flags = flags;
    last.glow = this._glow;
    last.angle = angle;
    last.frac = frac;

    const g = this.ctx;
    const L = this._L;
    const cx = G.bw / 2;
    const cy = G.bh / 2;
    const R = G.S / 2;
    const px = G.px;
    const deck = deckRgb(th, this.deckId);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, G.bw, G.bh);

    if (this._glow > 0.01) {
      g.globalAlpha = this._glow;
      g.drawImage(L.glow, Math.round(cx - L.glow.width / 2), Math.round(cy - L.glow.height / 2));
      g.globalAlpha = 1;
    }

    // rotating layers
    g.save();
    g.translate(cx, cy);
    if (!loaded) g.globalAlpha = 0.34;
    g.rotate(angle);
    g.drawImage(L.disc, -R, -R, G.S, G.S);
    g.drawImage(L.label, -L.label.width / 2, -L.label.height / 2);
    g.restore();
    g.globalAlpha = loaded ? 1 : 0.6;
    g.drawImage(L.overlay, cx - R, cy - R, G.S, G.S);
    g.globalAlpha = 1;

    if (empty) {
      this._drawEmpty(g, cx, cy, R, px, deck, now, reduced);
      return;
    }
    g.drawImage(L.cap, cx - R, cy - R, G.S, G.S);

    // progress ring on the rim
    const pr = R * GEOM.progress;
    const lw = clamp(R * 0.05, 3 * px, 6 * px) * (th.outdoor ? 1.35 : 1);
    g.lineWidth = lw;
    g.lineCap = 'butt';
    g.strokeStyle = 'rgba(255,255,255,0.1)';
    g.beginPath();
    g.arc(cx, cy, pr, 0, TAU);
    g.stroke();

    if (st.loading || st.analyzing) {
      const a0 = reduced ? -Math.PI / 2 : (now / 1000) * TAU * 0.7;
      g.strokeStyle = rgba(deck, st.loading ? 0.95 : 0.55);
      g.lineCap = 'round';
      for (let k = 0; k < 3; k++) {
        const s = a0 + (k * TAU) / 3;
        g.beginPath();
        g.arc(cx, cy, pr, s, s + TAU * 0.11);
        g.stroke();
      }
    }

    if (loaded && frac > 0.0005) {
      let col = deck;
      let blinkOn = false;
      if (warnOn) {
        blinkOn = reduced || !st.playing || Math.floor(now / 250) % 2 === 0;
        col = blinkOn ? th.rgb.warn : deck;
      }
      g.strokeStyle = rgba(col, 1);
      g.lineCap = 'round';
      g.beginPath();
      g.arc(cx, cy, pr, -Math.PI / 2, -Math.PI / 2 + frac * TAU);
      g.stroke();
      if (warnOn && blinkOn) {
        g.lineWidth = Math.max(1.5 * px, R * 0.012);
        g.strokeStyle = rgba(th.rgb.warn, 0.7);
        g.beginPath();
        g.arc(cx, cy, R - g.lineWidth / 2, 0, TAU);
        g.stroke();
      }
    }

    // touched: deck-colour edge
    if (this._glow > 0.01) {
      g.lineWidth = Math.max(2 * px, R * 0.018);
      g.strokeStyle = rgba(deck, 0.9 * this._glow);
      g.beginPath();
      g.arc(cx, cy, R - g.lineWidth / 2, 0, TAU);
      g.stroke();
    }

    // sync badge: deck-colour ring around the label and SYNC under the spindle
    const fsSmall = Math.max(11 * px, R * 0.1);
    if (st.synced && loaded) {
      g.lineWidth = Math.max(2 * px, R * 0.024);
      g.strokeStyle = rgba(deck, 1);
      g.beginPath();
      g.arc(cx, cy, R * GEOM.syncRing, 0, TAU);
      g.stroke();
      this._label(g, 'SYNC', cx, cy + R * GEOM.statusY, fsSmall, th, '#ffffff');
    } else if (st.loading || st.analyzing) {
      const text = st.loading ? 'LOADING' : G.Rcss >= 90 ? 'ANALYSING' : 'BPM…';
      this._label(g, text, cx, cy + R * GEOM.statusY, fsSmall, th, '#ffffff');
    }
  }

  _label(g, text, x, y, fs, th, color) {
    g.save();
    g.font = `700 ${fs.toFixed(1)}px ${th.fontUi}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0,0,0,0.6)';
    g.shadowBlur = fs * 0.25;
    g.fillStyle = color;
    g.fillText(text, x, y);
    g.restore();
  }

  _drawEmpty(g, cx, cy, R, px, deck, now, reduced) {
    const th = this._theme;
    // dashed invitation ring (slowly turning unless reduced motion)
    g.save();
    g.lineWidth = Math.max(2 * px, R * 0.022);
    g.strokeStyle = rgba(deck, 0.85);
    const dash = Math.max(4 * px, R * 0.09);
    g.setLineDash([dash, dash * 0.75]);
    g.lineDashOffset = reduced ? 0 : -(now / 1000) * dash * 0.8;
    g.beginPath();
    g.arc(cx, cy, R * GEOM.progress, 0, TAU);
    g.stroke();
    g.restore();
    // central "+ LOAD" button
    const br = R * GEOM.label;
    g.fillStyle = rgba(deck, 1);
    g.beginPath();
    g.arc(cx, cy, br, 0, TAU);
    g.fill();
    g.lineWidth = Math.max(1, px);
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.stroke();
    const dark = th.css.bg;
    g.fillStyle = dark;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const plus = Math.max(14 * px, br * 0.62);
    g.font = `700 ${plus.toFixed(1)}px ${th.fontDisplay}`;
    g.fillText('+', cx, cy - br * 0.2);
    const fs = Math.max(11 * px, br * 0.34);
    g.font = `700 ${fs.toFixed(1)}px ${th.fontUi}`;
    g.fillText('LOAD', cx, cy + br * 0.38);
    // deck letter on the data side
    const ls = Math.max(12 * px, R * 0.17);
    g.font = `700 ${ls.toFixed(1)}px ${th.fontDisplay}`;
    g.fillStyle = rgba(deck, 1);
    g.fillText(this.deckId, cx, cy - R * 0.63);
  }

  // -------------------------------------------------------------------------------------------------------
  // input

  _hit(e) {
    const r = this.canvas.getBoundingClientRect();
    this._cx = r.left + r.width / 2;
    this._cy = r.top + r.height / 2;
    return Math.hypot(e.clientX - this._cx, e.clientY - this._cy);
  }

  _onDown(e) {
    if (this._pid !== null || !isPrimaryPress(e) || !this._g) return;
    const st = this._st;
    if (!st.loaded || st.loading) return; // empty: the click handler loads
    const r = this._hit(e);
    const zone = platterZone(r, this._g.Rcss, this._g.D, st.vinyl);
    if (zone === 'outside') return;
    e.preventDefault();
    this._pid = e.pointerId;
    capturePointer(this.canvas, e.pointerId);
    const t = eventTime(e);
    this._turn.minRadius = Math.max(8, this._g.Rcss * 0.12);
    this._turn.begin(pointAngle(e.clientX, e.clientY, this._cx, this._cy), r);
    this._vel.reset();
    this._vel.push(t, 0);
    this._blend = null;
    if (zone === 'scratch') {
      this._mode = 'scratch';
      this._baseAngle = this._displayAngle;
      this._fingerAngle = this._baseAngle;
      this._cb.begin();
    } else {
      this._mode = 'bend';
      this._bendRel = null;
      clearTimeout(this._bendTimer);
    }
    this.canvas.classList.add('is-touched');
    this._draw(nowMs(), true);
  }

  _onMove(e) {
    if (e.pointerId !== this._pid) return;
    const list = coalesced(e);
    for (let i = 0; i < list.length; i++) {
      const ev = list[i];
      const r = Math.hypot(ev.clientX - this._cx, ev.clientY - this._cy);
      this._turn.update(pointAngle(ev.clientX, ev.clientY, this._cx, this._cy), r);
      this._vel.push(eventTime(ev), this._turn.total);
    }
    if (this._mode === 'scratch') {
      this._fingerAngle = this._baseAngle + this._turn.total;
      const vel = angleToSeconds(this._vel.velocity(), SECONDS_PER_TURN);
      this._cb.move(angleToSeconds(this._turn.total, SECONDS_PER_TURN), clamp(vel, -12, 12));
    } else if (this._mode === 'bend') {
      this._sendBend(bendFromAngularVelocity(this._vel.velocity()));
    }
  }

  _onUp(e) {
    if (e.pointerId !== this._pid) return;
    const id = this._pid;
    this._pid = null;
    releasePointer(this.canvas, id);
    const now = nowMs();
    if (this._mode === 'scratch') {
      this._cb.end();
      this._blend = { angle: this._fingerAngle, t0: now, offset: null };
    } else if (this._mode === 'bend') {
      this._startBendRelease(now);
    }
    this._mode = null;
    this.canvas.classList.remove('is-touched');
    if (this._pendingResize) this.resize();
  }

  _startBendRelease(now) {
    if (this._bendSent === 0) return;
    this._bendRel = { from: this._bendSent, t0: now };
    clearTimeout(this._bendTimer);
    this._bendTimer = setTimeout(() => {
      if (this._bendRel) {
        this._bendRel = null;
        this._sendBend(0);
      }
    }, BEND_RELEASE_MS + 30);
  }

  _stepBend(now) {
    if (this._mode === 'bend') {
      this._sendBend(bendFromAngularVelocity(this._vel.velocity(now)));
    } else if (this._bendRel) {
      const b = bendRelease(this._bendRel.from, now - this._bendRel.t0);
      if (b === 0) this._bendRel = null;
      this._sendBend(b);
    }
  }

  _sendBend(b) {
    const v = clamp(b, -MAX_BEND, MAX_BEND);
    if (v === this._bendSent) return;
    if (v !== 0 && Math.abs(v - this._bendSent) < 0.0008) return;
    this._bendSent = v;
    this._cb.bend(v);
  }

  _onClick(e) {
    if (!this._isEmpty() || !this._cb.empty) return;
    if (e.detail !== 0 && this._g) {
      const r = this._hit(e);
      if (r > this._g.Rcss * 1.06) return;
    }
    this._cb.empty();
  }

  _onKey(e) {
    if ((e.key === 'Enter' || e.key === ' ') && !e.repeat && this._isEmpty() && this._cb.empty) {
      e.preventDefault();
      this._cb.empty();
    }
  }

  _onWheel(e) {
    if (!this._st.loaded || this._pid !== null) return;
    e.preventDefault();
    const px = wheelPixels(e.deltaX, e.deltaY, e.deltaMode);
    const b = clamp(this._bendSent + px * 0.0004, -MAX_BEND, MAX_BEND);
    this._sendBend(b);
    this._startBendRelease(nowMs());
  }
}
