// Synthetic test-signal generator for BPM/grid unit tests (deterministic).
(function (global) {
  'use strict';
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function biq(type, f0, Q, fs) {
    const w0 = 2 * Math.PI * f0 / fs, c = Math.cos(w0), s = Math.sin(w0), al = s / (2 * Q);
    let b0, b1, b2;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    else { b0 = al; b1 = 0; b2 = -al; }
    const a0 = 1 + al; return [b0 / a0, b1 / a0, b2 / a0, (-2 * c) / a0, (1 - al) / a0];
  }
  function filt(x, co) { const [b0, b1, b2, a1, a2] = co; let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < x.length; i++) { const xi = x[i], yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = xi; y2 = y1; y1 = yi; x[i] = yi; } return x; }

  function oneShots(sr, rnd) {
    const mk = (sec) => new Float32Array(Math.round(sec * sr));
    const kick = mk(0.35); let ph = 0;
    for (let i = 0; i < kick.length; i++) { const t = i / sr; const f = 45 + 110 * Math.exp(-t / 0.025); ph += 2 * Math.PI * f / sr; kick[i] = Math.sin(ph) * Math.exp(-t / 0.18) + (t < 0.002 ? 0.3 * (rnd() * 2 - 1) : 0); }
    const snare = mk(0.25); const sn = mk(0.25); for (let i = 0; i < sn.length; i++) sn[i] = rnd() * 2 - 1; filt(sn, biq('bp', 2000, 0.7, sr));
    for (let i = 0; i < snare.length; i++) { const t = i / sr; snare[i] = 0.5 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t / 0.05) + 1.2 * sn[i] * Math.exp(-t / 0.07); }
    const clap = mk(0.2); const cn = mk(0.2); for (let i = 0; i < cn.length; i++) cn[i] = rnd() * 2 - 1; filt(cn, biq('bp', 1200, 0.8, sr));
    for (let i = 0; i < clap.length; i++) { const t = i / sr; let env = 0; for (const o of [0, 0.01, 0.02]) if (t >= o) env = Math.max(env, Math.exp(-(t - o) / 0.008)); env = Math.max(env, 0.4 * Math.exp(-t / 0.08)); clap[i] = 1.5 * cn[i] * env; }
    const hatN = mk(0.3); for (let i = 0; i < hatN.length; i++) hatN[i] = rnd() * 2 - 1; filt(hatN, biq('hp', 7000, 0.7, sr)); filt(hatN, biq('hp', 7000, 0.7, sr));
    const hat = mk(0.06), ohat = mk(0.3);
    for (let i = 0; i < hat.length; i++) hat[i] = hatN[i] * Math.exp(-i / sr / 0.015);
    for (let i = 0; i < ohat.length; i++) ohat[i] = hatN[i] * Math.exp(-i / sr / 0.12);
    const bass = mk(0.22);
    for (let i = 0; i < bass.length; i++) { const t = i / sr; const env = Math.min(1, t / 0.008) * Math.min(1, (0.22 - t) / 0.03); bass[i] = Math.sin(2 * Math.PI * 55 * t) * env; }
    return { kick, snare, clap, hat, ohat, bass };
  }

  // pattern entries: [beatPosInBar, sound, gain]
  const PATTERNS = {
    none: [],
    clicks: [[0, 'kick', 1], [1, 'kick', 1], [2, 'kick', 1], [3, 'kick', 1]],
    house: [[0, 'kick', 1], [1, 'kick', 1], [2, 'kick', 1], [3, 'kick', 1], [1, 'clap', 0.6], [3, 'clap', 0.6],
      [0.5, 'ohat', 0.7], [1.5, 'ohat', 0.7], [2.5, 'ohat', 0.7], [3.5, 'ohat', 0.7],
      [0.25, 'hat', 0.25], [0.75, 'hat', 0.25], [1.25, 'hat', 0.25], [1.75, 'hat', 0.25], [2.25, 'hat', 0.25], [2.75, 'hat', 0.25], [3.25, 'hat', 0.25], [3.75, 'hat', 0.25]],
    houseOffbeatBass: null, // filled below
    hiphop: [[0, 'kick', 1], [1.75, 'kick', 0.8], [2.5, 'kick', 0.9], [1, 'snare', 0.8], [3, 'snare', 0.8],
      [0, 'hat', 0.4], [0.5, 'hat', 0.3], [1, 'hat', 0.4], [1.5, 'hat', 0.3], [2, 'hat', 0.4], [2.5, 'hat', 0.3], [3, 'hat', 0.4], [3.5, 'hat', 0.3]],
    dnb: [[0, 'kick', 1], [2.5, 'kick', 0.9], [1, 'snare', 0.9], [3, 'snare', 0.9],
      [0, 'hat', 0.35], [0.5, 'hat', 0.3], [1, 'hat', 0.35], [1.5, 'hat', 0.3], [2, 'hat', 0.35], [2.5, 'hat', 0.3], [3, 'hat', 0.35], [3.5, 'hat', 0.3]],
    dubstep: [[0, 'kick', 1], [2, 'snare', 1], [3.25, 'kick', 0.7],
      [0, 'hat', 0.3], [0.5, 'hat', 0.3], [1, 'hat', 0.3], [1.5, 'hat', 0.3], [2, 'hat', 0.3], [2.5, 'hat', 0.3], [3, 'hat', 0.3], [3.5, 'hat', 0.3]]
  };
  PATTERNS.houseOffbeatBass = PATTERNS.house.concat([[0.5, 'bass', 0.9], [1.5, 'bass', 0.9], [2.5, 'bass', 0.9], [3.5, 'bass', 0.9]]);

  // opts: sr, dur, bpm, rampTo, pattern, start (grid anchor = beat 0 time), introSec (no drums), noiseDb, swing (0.5 straight..0.67), humanizeMs, seed
  function makeTrack(o) {
    o = Object.assign({ sr: 44100, dur: 180, bpm: 128, rampTo: null, pattern: 'house', start: 0.5, introSec: 0, noiseDb: -40, swing: 0.5, humanizeMs: 0, seed: 1, pad: false }, o);
    const rnd = mulberry32(o.seed), sr = o.sr, N = Math.floor(o.sr * o.dur), y = new Float32Array(N);
    const S = oneShots(sr, rnd), pat = PATTERNS[o.pattern];
    const beatTime = (b) => {
      if (o.rampTo == null && !o.wobblePct) return o.start + b * 60 / o.bpm;
      // linear BPM ramp over track duration: integrate numerically
      let t = o.start, beats = 0; const dt = 0.001;
      while (beats < b) { let bpmNow = o.rampTo == null ? o.bpm : o.bpm + (o.rampTo - o.bpm) * Math.min(1, (t - o.start) / (o.dur - o.start)); if (o.wobblePct) bpmNow *= 1 + o.wobblePct / 100 * Math.sin(2 * Math.PI * (t - o.start) / (o.wobblePeriod || 60)); beats += bpmNow / 60 * dt; t += dt; }
      return t - (beats - b) * 60 / o.bpm;
    };
    const drumStart = o.start + o.introSec;
    const gauss = () => { let u = 0, v = 0; while (u === 0) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const sw = (pos) => { const fr = pos - Math.floor(pos); return Math.abs(fr - 0.5) < 1e-6 ? Math.floor(pos) + o.swing : pos; };
    let bars = 0; let lastT = 0;
    // incremental beat times for ramp (cache)
    const bt = []; { let b = 0; while (true) { const t = beatTime(b); bt.push(t); if (t > o.dur + 1) break; b++; if (b > 5000) break; } }
    const timeOfBeatPos = (p) => { const i = Math.floor(p), f = p - i; if (i + 1 >= bt.length) return Infinity; return bt[i] + f * (bt[i + 1] - bt[i]); };
    for (let bar = 0; ; bar++) {
      const barStartT = timeOfBeatPos(bar * 4); if (barStartT > o.dur) break;
      for (const [pos, snd, g] of pat) {
        let t = timeOfBeatPos(bar * 4 + sw(pos));
        if (!isFinite(t) || t < drumStart - 1e-6 || t >= o.dur) continue;
        if (o.breakSec && t >= o.breakSec[0] && t < o.breakSec[1]) continue;
        if (o.humanizeMs) t += gauss() * o.humanizeMs / 1000;
        const s0 = Math.round(t * sr), sm = S[snd];
        for (let i = 0; i < sm.length && s0 + i < N; i++) if (s0 + i >= 0) y[s0 + i] += g * sm[i];
      }
    }
    if (o.pad) { // sustained chord pad from start to end, slow attack chords every 2 bars
      const P = 60 / o.bpm, chordLen = 8 * P; const freqs = [[220, 277.2, 329.6], [196, 246.9, 293.7]];
      for (let i = Math.round(o.start * sr); i < N; i++) {
        const t = i / sr - o.start, ci = Math.floor(t / chordLen) % 2, tc = t % chordLen;
        const env = Math.min(1, tc / 0.6) * 0.12; let v = 0; for (const f of freqs[ci]) v += Math.sin(2 * Math.PI * f * t); y[i] += env * v;
      }
    }
    const ng = Math.pow(10, o.noiseDb / 20);
    for (let i = Math.round(o.start * sr); i < N; i++) y[i] += ng * (rnd() * 2 - 1);
    return y;
  }
  global.makeTrack = makeTrack;
})(typeof self !== 'undefined' ? self : this);
