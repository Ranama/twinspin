// Small pure helpers shared by audio, analysis and UI code. No DOM, no Web Audio: safe in workers,
// worklets and JsCheck tests.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));

/** Decibels -> linear gain. -Infinity -> 0. */
export const dbToGain = (db) => (db === -Infinity ? 0 : Math.pow(10, db / 20));
/** Linear gain -> decibels (0 -> -Infinity). */
export const gainToDb = (g) => (g <= 0 ? -Infinity : 20 * Math.log10(g));

/** Positive modulo: wrap(-1, 4) === 3. */
export const wrap = (x, m) => ((x % m) + m) % m;
/** Wrap a phase difference (in cycles) into [-0.5, 0.5). */
export const wrapPhase = (x) => x - Math.floor(x + 0.5);

/**
 * Format seconds as m:ss (or h:mm:ss). `signed` adds a leading "-" for remaining-time displays.
 * fmtTime(75.4) === '1:15', fmtTime(75.4, true) === '-1:15'.
 */
export function fmtTime(sec, signed = false) {
  if (!Number.isFinite(sec)) return signed ? '-0:00' : '0:00';
  const s = Math.max(0, Math.floor(Math.abs(sec)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const body = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
  return signed ? `-${body}` : body;
}

/** BPM with one decimal, or a placeholder when unknown: fmtBpm(127.96) === '128.0'. */
export const fmtBpm = (bpm) => (Number.isFinite(bpm) && bpm > 0 ? bpm.toFixed(1) : '--.-');

/** Tempo offset as a signed percentage: fmtPercent(0.023) === '+2.3%'. */
export function fmtPercent(fraction, digits = 1) {
  const v = fraction * 100;
  const s = Math.abs(v) < 0.05 ? (0).toFixed(digits) : Math.abs(v).toFixed(digits);
  return (v > 0.0499 ? '+' : v < -0.0499 ? '-' : '±') + s + '%';
}

/** Stable hue 0..359 from a string (track colour on the platter label). */
export function hashHue(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

let uidCounter = 0;
export const uid = (prefix = 'id') => `${prefix}${++uidCounter}`;

/** localStorage read with JSON decode; never throws (private mode, sandboxed frames). */
export function storageGet(key, fallback) {
  try {
    const raw = globalThis.localStorage && globalThis.localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** localStorage write with JSON encode; never throws. Returns true when stored. */
export function storageSet(key, value) {
  try {
    if (!globalThis.localStorage) return false;
    globalThis.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Deterministic PRNG (mulberry32) for synthesis and tests. Returns () => [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
