// Waveform rasterising for WaveView / OverviewView. Columns are written straight into ImageData (one pass,
// anti-aliased top/bottom edges), coloured in 3 bands within the deck colour family: a saturated deck-colour
// core for the bass share, a lighter tint body that turns near-white with the treble share.
//   const tiles = new WaveTiles();
//   tiles.configure(track.waveform, ppsDevice, laneHeightDevice, palette, paletteKey);
//   tiles.draw(ctx, position, centreX, y0, laneWidth, ppsDevice);      // every frame
//   const strip = paintOverview(waveform, widthDev, heightDev, palette); // once per track/size

import { clamp } from '../../core/util.js';
import { columnStats } from './gesture-math.js';
import { bandColumnColor } from './color-math.js';
import { makeCanvas } from './dom-util.js';

/** Tile width in device px. */
export const TILE_W = 512;

/**
 * Paint one symmetric column into RGBA `data` (row stride `W`): half-height `half` around `mid`, inner
 * `core` half-height in `coreRgb`, the rest in `bodyRgb`, with fractional edge coverage.
 */
export function fillColumn(data, W, H, x, mid, half, core, bodyRgb, coreRgb) {
  const top = mid - half;
  const bot = mid + half;
  const y0 = top < 0 ? 0 : Math.floor(top);
  const y1 = bot > H ? H : Math.ceil(bot);
  const cTop = mid - core;
  const cBot = mid + core;
  for (let y = y0; y < y1; y++) {
    let cov = (y + 1 < bot ? y + 1 : bot) - (y > top ? y : top);
    if (cov <= 0) continue;
    if (cov > 1) cov = 1;
    const yc = y + 0.5;
    const c = yc >= cTop && yc <= cBot ? coreRgb : bodyRgb;
    const i = (y * W + x) * 4;
    data[i] = c[0];
    data[i + 1] = c[1];
    data[i + 2] = c[2];
    data[i + 3] = (cov * 255 + 0.5) | 0;
  }
}

/** Visual height curve: lifts quiet passages a little so intros stay readable. */
const shapePeak = (p) => Math.pow(clamp(p, 0, 1), 0.8);

/** Lazily rendered, LRU-cached waveform tiles for one lane at one px/s. */
export class WaveTiles {
  constructor(cap = 12) {
    this.cap = cap;
    this.wf = null;
    this.pps = 0;
    this.h = 0;
    this.pal = null;
    this.palKey = '';
    this.map = new Map();
    this._stats = { peak: 0, low: 0, high: 0 };
    this._col = [0, 0, 0];
  }

  /** (Re)configure; clears the cache when anything that affects the pixels changed. */
  configure(wf, pps, h, pal, palKey) {
    if (wf === this.wf && pps === this.pps && h === this.h && palKey === this.palKey) return;
    this.map.clear();
    this.wf = wf;
    this.pps = pps;
    this.h = h;
    this.pal = pal;
    this.palKey = palKey;
  }

  clear() {
    this.map.clear();
    this.wf = null;
  }

  tile(k) {
    let c = this.map.get(k);
    if (c) {
      this.map.delete(k);
      this.map.set(k, c);
      return c;
    }
    c = this._render(k);
    this.map.set(k, c);
    while (this.map.size > this.cap) this.map.delete(this.map.keys().next().value);
    return c;
  }

  _render(k) {
    const W = TILE_W;
    const H = Math.max(1, this.h | 0);
    const c = makeCanvas(W, H);
    const g = c.getContext('2d');
    const det = this.wf && this.wf.detail;
    if (!det || !det.peak || !(det.rate > 0) || !(this.pps > 0)) return c;
    const img = g.createImageData(W, H);
    const data = img.data;
    const mid = H / 2;
    const amp = mid - Math.max(1, H * 0.05);
    const st = this._stats;
    const col = this._col;
    const pal = this.pal;
    const inv = 1 / this.pps;
    for (let x = 0; x < W; x++) {
      const t0 = (k * W + x) * inv;
      columnStats(det.peak, det.low, det.high, det.rate, t0, t0 + inv, st);
      if (st.peak <= 0.002) continue;
      const half = shapePeak(st.peak) * amp;
      bandColumnColor(pal, st.high, col);
      const core = half * Math.sqrt(clamp(st.low, 0, 1)) * 0.94;
      fillColumn(data, W, H, x, mid, half, core, col, pal.low);
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  /**
   * Draw the visible tiles. `pos` = track seconds under `cx` (device px); `ppsDraw` = the px/s to draw at
   * (differs from the tile px/s while a pinch is in progress: tiles are scaled until it ends).
   */
  draw(g, pos, cx, y0, width, ppsDraw, duration) {
    if (!this.wf || !(this.pps > 0)) return;
    const s = ppsDraw / this.pps;
    const tLeft = pos - cx / ppsDraw;
    const tRight = pos + (width - cx) / ppsDraw;
    const end = duration > 0 ? duration : tRight;
    if (tRight < 0 || tLeft > end) return;
    const k0 = Math.max(0, Math.floor((Math.max(0, tLeft) * this.pps) / TILE_W));
    const k1 = Math.floor((Math.min(end, tRight) * this.pps) / TILE_W);
    const need = k1 - k0 + 3;
    if (need > this.cap) this.cap = need;
    const h = this.h;
    for (let k = k0; k <= k1; k++) {
      const tile = this.tile(k);
      const x = cx + ((k * TILE_W) / this.pps - pos) * ppsDraw;
      if (s === 1) g.drawImage(tile, Math.round(x), y0);
      else g.drawImage(tile, x, y0, TILE_W * s + 0.5, h);
    }
  }
}

/**
 * Whole-track overview strip (waveform.overview) at width x height device px. Returns a canvas, or null
 * when the waveform has no overview data.
 */
export function paintOverview(wf, W, H, pal) {
  const ov = wf && wf.overview;
  if (!ov || !ov.peak || !ov.peak.length || W < 2 || H < 2) return null;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  const img = g.createImageData(W, H);
  const data = img.data;
  const n = ov.peak.length;
  const st = { peak: 0, low: 0, high: 0 };
  const col = [0, 0, 0];
  const mid = H / 2;
  const amp = mid - Math.max(0.5, H * 0.04);
  for (let x = 0; x < W; x++) {
    columnStats(ov.peak, ov.low, ov.high, n, x / W, (x + 1) / W, st);
    if (st.peak <= 0.002) continue;
    const half = Math.max(0.5, shapePeak(st.peak) * amp);
    bandColumnColor(pal, st.high, col);
    const core = half * Math.sqrt(clamp(st.low, 0, 1)) * 0.94;
    fillColumn(data, W, H, x, mid, half, core, col, pal.low);
  }
  g.putImageData(img, 0, 0);
  return c;
}
