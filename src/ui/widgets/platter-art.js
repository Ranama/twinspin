// Offscreen layer painting for PlatterView (canvas 2D, device pixels). Each function paints one cached
// layer ONCE; per frame the platter only composites and rotates them.
//   disc    (rotates)  rim with grip ticks, iridescent rainbow data side, grooves, clear hub, marker stripe
//   label   (rotates)  track-hue label disc with printed rings and a marker notch
//   overlay (fixed)    specular highlights that make the data side read as a reflective CD, rim bevel, gloss,
//                      optional nudge-ring hint
//   cap     (fixed)    upright deck letter (Unbounded) and the spindle hole
//   glow    (fixed)    deck-colour halo shown while the platter is touched
// Sizes: `S` = disc diameter in device px. Geometry is in fractions of the disc radius (GEOM).

import { mulberry32 } from '../../core/util.js';
import { rgba, hslToRgb } from './color-math.js';
import { makeCanvas } from './dom-util.js';

const TAU = Math.PI * 2;

/** Radii as fractions of the disc radius R. */
export const GEOM = Object.freeze({
  rimInner: 0.86,
  gripIn: 0.872,
  gripOut: 0.928,
  progress: 0.966,
  dataInner: 0.425,
  hubInner: 0.372,
  label: 0.362,
  syncRing: 0.392,
  hole: 0.05,
  letterY: -0.165,
  statusY: 0.185,
});

function annulus(g, r0, r1) {
  g.beginPath();
  g.arc(0, 0, r1, 0, TAU);
  g.moveTo(r0, 0);
  g.arc(0, 0, r0, 0, TAU, true);
}

function circle(g, r) {
  g.beginPath();
  g.arc(0, 0, r, 0, TAU);
}

/** Rainbow fill of an annulus with `cycles` hue cycles; conic gradient, or wedges where unsupported. */
function rainbow(g, r0, r1, cycles, hueOffset, sat, light, alpha) {
  g.save();
  g.globalAlpha = alpha;
  if (typeof g.createConicGradient === 'function') {
    const cg = g.createConicGradient(0, 0, 0);
    const n = 12 * cycles;
    for (let i = 0; i <= n; i++) {
      const hue = (hueOffset + (i / n) * 360 * cycles) % 360;
      cg.addColorStop(i / n, `hsl(${hue.toFixed(1)}, ${sat}%, ${light}%)`);
    }
    g.fillStyle = cg;
    annulus(g, r0, r1);
    g.fill();
  } else {
    const n = 90 * cycles;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * TAU;
      const a1 = ((i + 1.6) / n) * TAU;
      const hue = (hueOffset + (i / n) * 360 * cycles) % 360;
      g.fillStyle = `hsl(${hue.toFixed(1)}, ${sat}%, ${light}%)`;
      g.beginPath();
      g.arc(0, 0, r1, a0, a1);
      g.arc(0, 0, r0, a1, a0, true);
      g.closePath();
      g.fill();
    }
  }
  g.restore();
}

/**
 * The rotating disc: rim + grip ticks + iridescent data side + grooves + hub + marker stripe.
 * @param {number} S diameter (device px) @param {object} theme readTheme() result @param {number} px device px per CSS px
 */
export function paintDisc(S, theme, px) {
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  const R = S / 2;
  const bg = theme.rgb.bg;
  g.translate(R, R);

  // Rim (the jog ring)
  const rim = g.createRadialGradient(0, 0, R * GEOM.rimInner, 0, 0, R);
  rim.addColorStop(0, '#2a2d3b');
  rim.addColorStop(0.35, '#1d1f2a');
  rim.addColorStop(1, '#0a0b10');
  g.fillStyle = rim;
  annulus(g, R * GEOM.rimInner, R);
  g.fill();

  // Grip ticks (they rotate with the disc, so speed is visible even on a dark track)
  const ticks = 60;
  g.lineCap = 'round';
  g.lineWidth = Math.max(1, R * 0.014);
  for (let i = 0; i < ticks; i++) {
    const a = (i / ticks) * TAU;
    const sa = Math.sin(a);
    const ca = -Math.cos(a);
    g.strokeStyle = i % 5 === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.1)';
    g.beginPath();
    g.moveTo(sa * R * GEOM.gripIn, ca * R * GEOM.gripIn);
    g.lineTo(sa * R * GEOM.gripOut, ca * R * GEOM.gripOut);
    g.stroke();
  }

  // Data side
  const r0 = R * GEOM.dataInner;
  const r1 = R * GEOM.rimInner;
  g.fillStyle = rgba([14, 16, 24], 1);
  annulus(g, r0, r1);
  g.fill();
  rainbow(g, r0, r1, 2, 195, 92, 60, 0.46);
  g.save();
  g.rotate(0.9);
  rainbow(g, r0, r1, 3, 20, 85, 66, 0.16);
  g.restore();

  // Depth: darker near the hub and the rim, brightest band in the middle
  const shade = g.createRadialGradient(0, 0, r0, 0, 0, r1);
  shade.addColorStop(0, rgba(bg, 0.62));
  shade.addColorStop(0.16, rgba(bg, 0.16));
  shade.addColorStop(0.55, rgba(bg, 0.1));
  shade.addColorStop(0.85, rgba(bg, 0.3));
  shade.addColorStop(1, rgba(bg, 0.7));
  g.fillStyle = shade;
  annulus(g, r0, r1);
  g.fill();

  // Grooves: faint concentric rings with slight random variation
  const rnd = mulberry32(1337);
  const step = Math.max(1.25, px * 1.1);
  g.lineWidth = Math.max(0.6, px * 0.5);
  for (let r = r0 + step; r < r1 - step * 0.5; r += step) {
    const light = rnd() < 0.5;
    const a = 0.025 + rnd() * 0.05;
    g.strokeStyle = light ? `rgba(255,255,255,${a.toFixed(3)})` : `rgba(0,0,0,${(a * 2).toFixed(3)})`;
    circle(g, r);
    g.stroke();
  }
  // Session gaps (like the visible track boundaries on a pressed CD)
  for (const f of [0.55, 0.665, 0.775]) {
    g.lineWidth = Math.max(1, px * 1.1);
    g.strokeStyle = 'rgba(0,0,0,0.42)';
    circle(g, R * f);
    g.stroke();
    g.lineWidth = Math.max(0.7, px * 0.6);
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    circle(g, R * f + Math.max(1, px));
    g.stroke();
  }

  // Rim lip
  g.lineWidth = Math.max(1, px * 1.2);
  g.strokeStyle = 'rgba(0,0,0,0.65)';
  circle(g, r1);
  g.stroke();
  g.lineWidth = Math.max(0.7, px * 0.7);
  g.strokeStyle = 'rgba(255,255,255,0.1)';
  circle(g, r1 + Math.max(1, px * 1.2));
  g.stroke();

  // Clear hub ring
  g.fillStyle = 'rgba(200,210,235,0.07)';
  annulus(g, R * GEOM.hubInner, r0);
  g.fill();
  g.lineWidth = Math.max(0.7, px * 0.7);
  g.strokeStyle = 'rgba(255,255,255,0.16)';
  circle(g, r0);
  g.stroke();
  circle(g, R * GEOM.hubInner);
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.06)';
  circle(g, (r0 + R * GEOM.hubInner) / 2);
  g.stroke();

  // 12 o'clock marker stripe across the data side, plus a bright dot on the rim
  const mw = Math.max(2.2 * px, R * 0.034);
  g.lineCap = 'round';
  g.strokeStyle = 'rgba(0,0,0,0.45)';
  g.lineWidth = mw + Math.max(2, px * 2);
  g.beginPath();
  g.moveTo(0, -(r0 + mw));
  g.lineTo(0, -(r1 - mw));
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.94)';
  g.lineWidth = mw;
  g.beginPath();
  g.moveTo(0, -(r0 + mw));
  g.lineTo(0, -(r1 - mw));
  g.stroke();
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(0, -R * ((GEOM.gripIn + GEOM.gripOut) / 2), Math.max(1.6 * px, R * 0.024), 0, TAU);
  g.fill();
  return c;
}

/** Label disc colours for a track hue (null = neutral grey). */
export function labelColors(hue) {
  if (hue === null || hue === undefined || !Number.isFinite(hue)) {
    return { a: [70, 74, 92], b: [36, 38, 50] };
  }
  return { a: hslToRgb(hue, 0.74, 0.52), b: hslToRgb(hue + 28, 0.7, 0.28) };
}

/** The rotating label disc (diameter 2 * GEOM.label * R), coloured from the track hue. */
export function paintLabel(S, hue, px) {
  const R = S / 2;
  const rl = R * GEOM.label;
  const size = Math.ceil(rl * 2) + 2;
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  g.translate(size / 2, size / 2);
  const col = labelColors(hue);
  const grad = g.createRadialGradient(-rl * 0.35, -rl * 0.4, rl * 0.05, 0, 0, rl);
  grad.addColorStop(0, rgba(col.a, 1));
  grad.addColorStop(1, rgba(col.b, 1));
  g.fillStyle = grad;
  circle(g, rl);
  g.fill();
  // printed rings
  g.lineWidth = Math.max(0.8, px * 0.8);
  g.strokeStyle = 'rgba(255,255,255,0.24)';
  circle(g, rl * 0.84);
  g.stroke();
  g.strokeStyle = 'rgba(0,0,0,0.28)';
  circle(g, rl * 0.93);
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.12)';
  circle(g, rl * 0.36);
  g.stroke();
  // a soft brighter crescent so rotation shows on the label too
  g.save();
  circle(g, rl);
  g.clip();
  const sweep = g.createLinearGradient(-rl, -rl, rl, rl);
  sweep.addColorStop(0, 'rgba(255,255,255,0.16)');
  sweep.addColorStop(0.5, 'rgba(255,255,255,0)');
  sweep.addColorStop(1, 'rgba(0,0,0,0.18)');
  g.fillStyle = sweep;
  g.fillRect(-rl, -rl, rl * 2, rl * 2);
  g.restore();
  // marker notch at 12 o'clock
  g.strokeStyle = '#ffffff';
  g.lineCap = 'round';
  g.lineWidth = Math.max(2 * px, R * 0.03);
  g.beginPath();
  g.moveTo(0, -rl * 0.98);
  g.lineTo(0, -rl * 0.72);
  g.stroke();
  // edge
  g.lineWidth = Math.max(1, px);
  g.strokeStyle = 'rgba(0,0,0,0.5)';
  circle(g, rl - g.lineWidth / 2);
  g.stroke();
  return c;
}

function specularStops(cg, peaks, width, alpha) {
  const stops = [[0, 0], [1, 0]];
  for (const p of peaks) {
    stops.push([Math.max(0.001, p - width), 0], [p, alpha], [Math.min(0.999, p + width), 0]);
  }
  stops.sort((a, b) => a[0] - b[0]);
  for (const [o, a] of stops) cg.addColorStop(o, `rgba(255,255,255,${a})`);
}

/**
 * Fixed overlay: specular highlight wedges on the data side, rim bevel and gloss, optional nudge-ring hint
 * (`ringInner` = fraction of R where the ring starts, 0 = none).
 */
export function paintOverlay(S, px, ringInner = 0) {
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  const R = S / 2;
  g.translate(R, R);
  const r0 = R * GEOM.dataInner;
  const r1 = R * GEOM.rimInner;

  // Specular light: two opposite soft wedges (a light source over the booth)
  const a1 = TAU - 0.95; // upper right (conic angle 0 = 3 o'clock, clockwise)
  const a2 = Math.PI - 0.95; // lower left
  if (typeof g.createConicGradient === 'function') {
    const cg = g.createConicGradient(0, 0, 0);
    specularStops(cg, [a1 / TAU, a2 / TAU], 0.075, 0.3);
    g.fillStyle = cg;
    annulus(g, r0, r1);
    g.fill();
    const cg2 = g.createConicGradient(0, 0, 0);
    specularStops(cg2, [a1 / TAU, a2 / TAU], 0.02, 0.22);
    g.fillStyle = cg2;
    annulus(g, r0, r1);
    g.fill();
  } else {
    for (const a of [a1, a2]) {
      for (let k = 0; k < 6; k++) {
        const w = 0.42 * (1 - k / 6);
        g.fillStyle = `rgba(255,255,255,${(0.05).toFixed(3)})`;
        g.beginPath();
        g.arc(0, 0, r1, a - w, a + w);
        g.arc(0, 0, r0, a + w, a - w, true);
        g.closePath();
        g.fill();
      }
    }
  }
  // fade the highlight toward the hub and the rim
  const fade = g.createRadialGradient(0, 0, r0, 0, 0, r1);
  fade.addColorStop(0, 'rgba(10,11,16,0.35)');
  fade.addColorStop(0.45, 'rgba(10,11,16,0)');
  fade.addColorStop(1, 'rgba(10,11,16,0.3)');
  g.fillStyle = fade;
  annulus(g, r0, r1);
  g.fill();

  // Gloss across the whole disc
  const gloss = g.createLinearGradient(-R, -R, R * 0.4, R * 0.4);
  gloss.addColorStop(0, 'rgba(255,255,255,0.09)');
  gloss.addColorStop(0.5, 'rgba(255,255,255,0.02)');
  gloss.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gloss;
  circle(g, R);
  g.fill();

  // Rim bevel: light from the top left, shadow bottom right
  const bevel = g.createLinearGradient(-R, -R, R, R);
  bevel.addColorStop(0, 'rgba(255,255,255,0.32)');
  bevel.addColorStop(0.5, 'rgba(255,255,255,0.04)');
  bevel.addColorStop(1, 'rgba(0,0,0,0.5)');
  g.strokeStyle = bevel;
  g.lineWidth = Math.max(1, px * 1.4);
  circle(g, R - g.lineWidth / 2);
  g.stroke();

  if (ringInner > 0) {
    g.setLineDash([Math.max(2, px * 3), Math.max(3, px * 5)]);
    g.lineWidth = Math.max(1, px);
    g.strokeStyle = 'rgba(255,255,255,0.2)';
    circle(g, R * ringInner);
    g.stroke();
    g.setLineDash([]);
  }
  return c;
}

/** Fixed cap: the upright deck letter on the label and the spindle hole. */
export function paintCap(S, theme, deckId, px) {
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  const R = S / 2;
  g.translate(R, R);
  // spindle hole
  const hr = R * GEOM.hole;
  g.fillStyle = 'rgba(0,0,0,0.22)';
  circle(g, hr * 1.9);
  g.fill();
  g.fillStyle = theme.css.bg;
  circle(g, hr);
  g.fill();
  g.lineWidth = Math.max(1, px * 0.9);
  g.strokeStyle = 'rgba(255,255,255,0.4)';
  circle(g, hr);
  g.stroke();
  // deck letter, upright
  const fs = Math.max(11 * px, R * 0.25);
  g.font = `700 ${fs.toFixed(1)}px ${theme.fontDisplay}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.55)';
  g.shadowBlur = Math.max(2, R * 0.03);
  g.shadowOffsetY = Math.max(1, R * 0.008);
  g.fillStyle = '#ffffff';
  g.fillText(deckId, 0, R * GEOM.letterY);
  return c;
}

/** Deck-colour halo ring around the disc (size S + 2 * margin). */
export function paintGlow(S, margin, color) {
  const size = Math.ceil(S + margin * 2);
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const R = S / 2;
  g.translate(size / 2, size / 2);
  const inner = R * 0.88;
  const outer = R + margin;
  const grad = g.createRadialGradient(0, 0, inner, 0, 0, outer);
  const edge = (R - inner) / (outer - inner);
  grad.addColorStop(0, rgba(color, 0));
  grad.addColorStop(edge, rgba(color, 0.9));
  grad.addColorStop(Math.min(1, edge + (1 - edge) * 0.35), rgba(color, 0.35));
  grad.addColorStop(1, rgba(color, 0));
  g.fillStyle = grad;
  circle(g, outer);
  g.fill();
  return c;
}
