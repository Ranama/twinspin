// Pure colour helpers for the canvas widgets (no DOM): parse CSS colours read from custom properties,
// mix them, convert HSL, and build the 3-band waveform palette. Colours are [r, g, b] arrays (0..255).
//   const blue = parseColor('#3da5ff');  rgba(blue, 0.5)  mixRgb(blue, WHITE, 0.6)  hslToRgb(210, 0.7, 0.5)

import { clamp } from '../../core/util.js';

export const WHITE = Object.freeze([255, 255, 255]);
export const BLACK = Object.freeze([0, 0, 0]);

/** Parse '#rgb', '#rrggbb', '#rrggbbaa', 'rgb(r, g, b)' / 'rgba(...)' (also space-separated). Else null. */
export function parseColor(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim().toLowerCase();
  if (s[0] === '#') {
    const hex = s.slice(1);
    if (/^[0-9a-f]{3,4}$/.test(hex)) {
      return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16)];
    }
    if (/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(hex)) {
      return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
    }
    return null;
  }
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (m) return [clamp(Math.round(+m[1]), 0, 255), clamp(Math.round(+m[2]), 0, 255), clamp(Math.round(+m[3]), 0, 255)];
  return null;
}

/** CSS string for an [r, g, b] colour with alpha. */
export function rgba(c, a = 1) {
  return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a >= 1 ? 1 : a <= 0 ? 0 : +a.toFixed(3)})`;
}

/** Linear mix: t = 0 -> a, t = 1 -> b. */
export function mixRgb(a, b, t) {
  const k = clamp(t, 0, 1);
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

/** HSL (h degrees, s and l 0..1) -> [r, g, b]. */
export function hslToRgb(h, s, l) {
  const hh = (((h % 360) + 360) % 360) / 360;
  const ss = clamp(s, 0, 1);
  const ll = clamp(l, 0, 1);
  if (ss === 0) {
    const v = Math.round(ll * 255);
    return [v, v, v];
  }
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const f = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [Math.round(f(hh + 1 / 3) * 255), Math.round(f(hh) * 255), Math.round(f(hh - 1 / 3) * 255)];
}

/** Relative luminance 0..1 (sRGB), for picking readable text colours. */
export function luminance(c) {
  const ch = (v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
}

/**
 * 3-band waveform palette within one deck colour family: low = saturated deck colour, mid = lighter tint,
 * high = near-white. Returns { low, mid, high } as [r, g, b].
 */
export function bandPalette(deck) {
  return {
    low: deck.slice(0, 3),
    mid: mixRgb(deck, WHITE, 0.45),
    high: mixRgb(deck, WHITE, 0.86),
  };
}

/**
 * Colour of one waveform column from its band shares (0..1): the outer body blends mid tint -> near-white
 * with the high share. Writes into `out` ([r, g, b]) to avoid allocation.
 */
export function bandColumnColor(pal, high, out) {
  const t = clamp(high * 1.8, 0, 1);
  out[0] = pal.mid[0] + (pal.high[0] - pal.mid[0]) * t;
  out[1] = pal.mid[1] + (pal.high[1] - pal.mid[1]) * t;
  out[2] = pal.mid[2] + (pal.high[2] - pal.mid[2]) * t;
  return out;
}
