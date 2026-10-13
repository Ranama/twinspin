// Prototype BPM + beat-grid analyzer (pure JS, worker-safe, no FFT).
// analyzeBeats(mono: Float32Array, sr: number, opts?) -> result
(function (global) {
  'use strict';

  function biq(type, f0, Q, fs) {
    const w0 = 2 * Math.PI * f0 / fs, c = Math.cos(w0), s = Math.sin(w0), al = s / (2 * Q);
    let b0, b1, b2;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    const a0 = 1 + al;
    return [b0 / a0, b1 / a0, b2 / a0, (-2 * c) / a0, (1 - al) / a0];
  }

  // ---------- Stage 1: onset strength (3-band log-energy flux) ----------
  function onsetBands(mono, sr, H) {
    const D = Math.max(1, Math.round(sr / 11025));
    const fsd = sr / D, nd = Math.floor(mono.length / D), nf = Math.floor(nd / H);
    const sL = new Float64Array(nf), sM = new Float64Array(nf), sH = new Float64Array(nf);
    const [l0, l1, l2, la1, la2] = biq('lp', 150, Math.SQRT1_2, fsd);
    const [m0, m1, m2, ma1, ma2] = biq('hp', 200, Math.SQRT1_2, fsd);
    const [n0, n1, n2, na1, na2] = biq('lp', 2500, Math.SQRT1_2, fsd);
    const [h0, h1, h2, ha1, ha2] = biq('hp', 2500, Math.SQRT1_2, fsd);
    // states
    let ax1 = 0, ax2 = 0, ay1 = 0, ay2 = 0;  // low stage 1
    let by1 = 0, by2 = 0, bx1 = 0, bx2 = 0;  // low stage 2
    let cx1 = 0, cx2 = 0, cy1 = 0, cy2 = 0;  // mid hp
    let dx1 = 0, dx2 = 0, dy1 = 0, dy2 = 0;  // mid lp
    let ex1 = 0, ex2 = 0, ey1 = 0, ey2 = 0;  // high hp
    let idx = 0; const invD = 1 / D;
    for (let n = 0; n < nf; n++) {
      let el = 0, em = 0, eh = 0;
      for (let k = 0; k < H; k++) {
        let x = 0;
        for (let d = 0; d < D; d++) x += mono[idx++];
        x *= invD;
        // low: LP150 x2
        let y = l0 * x + l1 * ax1 + l2 * ax2 - la1 * ay1 - la2 * ay2;
        ax2 = ax1; ax1 = x; ay2 = ay1; ay1 = y;
        let y2 = l0 * y + l1 * bx1 + l2 * bx2 - la1 * by1 - la2 * by2;
        bx2 = bx1; bx1 = y; by2 = by1; by1 = y2;
        el += y2 * y2;
        // mid: HP200 -> LP2500
        let ym = m0 * x + m1 * cx1 + m2 * cx2 - ma1 * cy1 - ma2 * cy2;
        cx2 = cx1; cx1 = x; cy2 = cy1; cy1 = ym;
        let ym2 = n0 * ym + n1 * dx1 + n2 * dx2 - na1 * dy1 - na2 * dy2;
        dx2 = dx1; dx1 = ym; dy2 = dy1; dy1 = ym2;
        em += ym2 * ym2;
        // high: HP2500
        let yh = h0 * x + h1 * ex1 + h2 * ex2 - ha1 * ey1 - ha2 * ey2;
        ex2 = ex1; ex1 = x; ey2 = ey1; ey1 = yh;
        eh += yh * yh;
      }
      sL[n] = el; sM[n] = em; sH[n] = eh;
    }
    const fps = fsd / H;
    function flux(s) {
      // energy over 2 hops, log-compressed relative to track mean, half-wave rectified lag-2 difference
      const E = new Float64Array(nf); let mean = 0;
      for (let n = 0; n < nf; n++) { E[n] = s[n] + (n ? s[n - 1] : 0); mean += E[n]; }
      mean = mean / nf + 1e-20;
      const g = 100 / mean, L = new Float64Array(nf), Dx = new Float32Array(nf);
      for (let n = 0; n < nf; n++) L[n] = Math.log1p(g * E[n]);
      for (let n = 2; n < nf; n++) { const d = L[n] - L[n - 2]; Dx[n] = d > 0 ? d : 0; }
      return Dx;
    }
    return { fps, nf, low: flux(sL), mid: flux(sM), high: flux(sH), eLow: sL, eMid: sM, eHigh: sH };
  }

  function subtractLocalMean(x, half) {
    const n = x.length, c = new Float64Array(n + 1), y = new Float32Array(n);
    for (let i = 0; i < n; i++) c[i + 1] = c[i] + x[i];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - half), b = Math.min(n, i + half + 1);
      const v = x[i] - (c[b] - c[a]) / (b - a);
      y[i] = v > 0 ? v : 0;
    }
    return y;
  }

  // ---------- Stage 2: global ACF + harmonic comb + log-Gaussian prior ----------
  function tempoCandidates(oss, fps, opt) {
    // decimate OSS x2 for speed
    const n2 = oss.length >> 1, x = new Float64Array(n2), fps2 = fps / 2;
    let mean = 0;
    for (let i = 0; i < n2; i++) { x[i] = oss[2 * i] + oss[2 * i + 1]; mean += x[i]; }
    mean /= n2; for (let i = 0; i < n2; i++) x[i] -= mean;
    const maxLag = Math.ceil(4 * 60 * fps2 / opt.searchMin) + 2;
    const A = new Float64Array(maxLag + 1);
    for (let L = 0; L <= maxLag; L++) {
      let s = 0; const end = n2 - L;
      for (let i = 0; i < end; i++) s += x[i] * x[i + L];
      A[L] = s;
    }
    const a0 = A[0] || 1; for (let L = 0; L <= maxLag; L++) A[L] /= a0;
    const interp = (t) => { const i = Math.floor(t), f = t - i; return i + 1 > maxLag ? 0 : A[i] * (1 - f) + A[i + 1] * f; };
    const tMin = 60 * fps2 / opt.searchMax, tMax = 60 * fps2 / opt.searchMin, step = 0.05;
    const taus = [], score = [];
    for (let t = tMin; t <= tMax; t += step) {
      const c = interp(t) + interp(2 * t) + interp(4 * t);
      const bpm = 60 * fps2 / t;
      const lp = Math.log2(bpm / opt.priorCenter) / opt.priorSigma;
      taus.push(t); score.push(Math.max(0, c) * Math.exp(-0.5 * lp * lp));
    }
    // local maxima -> candidates
    const cands = [];
    for (let i = 1; i < score.length - 1; i++) {
      if (score[i] > score[i - 1] && score[i] >= score[i + 1] && score[i] > 0) {
        const y0 = score[i - 1], y1 = score[i], y2 = score[i + 1], den = y0 - 2 * y1 + y2;
        const off = den !== 0 ? 0.5 * (y0 - y2) / den : 0;
        const t = taus[i] + off * step;
        cands.push({ bpm: 60 * fps2 / t, score: y1 });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    return cands.slice(0, 6);
  }

  // ---------- Stage 3a: whole-track zoomed DFT (harmonics 1..2) ----------
  function combPower(x, fps, fHz, harmonics) {
    let P = 0;
    for (let h = 1; h <= harmonics; h++) {
      const w = 2 * Math.PI * h * fHz / fps, cw = Math.cos(w), sw = Math.sin(w);
      let cr = 1, ci = 0, re = 0, im = 0;
      for (let n = 0; n < x.length; n++) {
        const v = x[n]; re += v * cr; im -= v * ci;
        const t = cr * cw - ci * sw; ci = cr * sw + ci * cw; cr = t;
        if ((n & 1023) === 1023) { const m = 1 / Math.sqrt(cr * cr + ci * ci); cr *= m; ci *= m; }
      }
      P += re * re + im * im;
    }
    return P;
  }
  function zoomRefine(x, fps, bpm, frac, steps) {
    let best = -1, bi = 0; const vals = [];
    for (let i = -steps; i <= steps; i++) {
      const b = bpm * (1 + frac * i / steps);
      const p = combPower(x, fps, b / 60, 2);
      vals.push(p); if (p > best) { best = p; bi = i + steps; }
    }
    let off = 0;
    if (bi > 0 && bi < vals.length - 1) {
      const y0 = vals[bi - 1], y1 = vals[bi], y2 = vals[bi + 1], den = y0 - 2 * y1 + y2;
      off = den !== 0 ? 0.5 * (y0 - y2) / den : 0;
    }
    return bpm * (1 + frac * (bi - steps + off) / steps);
  }

  // ---------- Stage 3b: windowed Fourier phase, unwrap, robust line fit ----------
  function phaseFit(x, fps, bpm, winSec, hopSec) {
    const f = bpm / 60, W = Math.round(winSec * fps), Hh = Math.round(hopSec * fps);
    const hann = new Float64Array(W);
    for (let j = 0; j < W; j++) hann[j] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (j + 0.5) / W);
    const w = 2 * Math.PI * f / fps, cw = Math.cos(w), sw = Math.sin(w);
    const wins = [];
    for (let s = 0; s + W <= x.length; s += Hh) {
      let cr = Math.cos(w * s), ci = Math.sin(w * s), re = 0, im = 0, S = 0;
      for (let j = 0; j < W; j++) {
        const v = x[s + j] * hann[j]; re += v * cr; im -= v * ci; S += v;
        const t = cr * cw - ci * sw; ci = cr * sw + ci * cw; cr = t;
      }
      const mag = Math.sqrt(re * re + im * im);
      wins.push({ t: (s + W / 2) / fps, beta: -Math.atan2(im, re) / (2 * Math.PI), r: S > 0 ? mag / S : 0, mag, S });
    }
    if (!wins.length) return null;
    let maxMag = 0, anchor = 0;
    wins.forEach((v, i) => { if (v.mag > maxMag) { maxMag = v.mag; anchor = i; } });
    const conf = (v) => v.r > 0.15 && v.mag > 0.1 * maxMag;
    wins.forEach((v) => { v.ok = conf(v); });
    // unwrap from anchor outward, referencing last confident window
    wins[anchor].u = wins[anchor].beta;
    for (const dir of [1, -1]) {
      let ref = wins[anchor].u;
      for (let i = anchor + dir; i >= 0 && i < wins.length; i += dir) {
        let d = wins[i].beta - ref; d -= Math.round(d);
        wins[i].u = ref + d; if (wins[i].ok) ref = wins[i].u;
      }
    }
    // weighted LS: u = a + s*t, iterative outlier rejection (30 ms)
    let use = wins.filter(conf), a = 0, sl = 0;
    for (let it = 0; it < 3; it++) {
      let sw0 = 0, st = 0, su = 0, stt = 0, stu = 0;
      for (const v of use) { const wt = v.mag; sw0 += wt; st += wt * v.t; su += wt * v.u; stt += wt * v.t * v.t; stu += wt * v.t * v.u; }
      const den = sw0 * stt - st * st;
      sl = den > 1e-12 ? (sw0 * stu - st * su) / den : 0;
      a = (su - sl * st) / sw0;
      const keep = use.filter((v) => Math.abs((v.u - a - sl * v.t) / f) < 0.03);
      if (keep.length === use.length || keep.length < 3) break;
      use = keep;
    }
    // residuals (ms) over confident windows
    let rw = 0, rs = 0, rmax = 0, magSum = 0, Ssum = 0;
    for (const v of wins) {
      if (!v.ok) continue;
      const res = (v.u - a - sl * v.t) / f * 1000; v.resMs = res;
      rw += v.mag; rs += v.mag * res * res; rmax = Math.max(rmax, Math.abs(res));
      magSum += v.mag; Ssum += v.S;
    }
    const fNew = f - sl; // pulses at t = (k + a)/fNew
    const P = 1 / fNew;
    let t0 = a / fNew; t0 = ((t0 % P) + P) % P;
    const okW = wins.filter((v) => v.ok);
    return {
      bpm: 60 * fNew, t0, residRmsMs: Math.sqrt(rs / (rw || 1)), residMaxMs: rmax,
      coherence: Ssum > 0 ? magSum / Ssum : 0, coverage: okW.length / wins.length,
      span: okW.length ? okW[okW.length - 1].t - okW[0].t : 0, nWin: wins.length, nUsed: use.length,
      wins
    };
  }


  // linear (non-log) energy flux: keeps loudness dominance (snare/clap > kick click in >2.5 kHz)
  function linFlux(s) {
    const n = s.length, d = new Float32Array(n); let prev2 = 0, prev1 = 0;
    for (let i = 0; i < n; i++) { const E = s[i] + (i ? s[i - 1] : 0); if (i >= 2) { const v = E - prev2; d[i] = v > 0 ? v : 0; } prev2 = prev1; prev1 = E; }
    return d;
  }

  // ---------- Stage 4: octave test - backbeat (snare/clap) period in the >2.5 kHz band ----------
  // Fold linear high-band flux on a 4-fast-beat cycle. Backbeat on "2 and 4" of the FAST grid
  // -> the two strongest slots are opposite (rho ~ 1) -> fast tempo is the beat.
  // Backbeat every 4 fast beats (= every 2 slow beats) -> rho small -> slow tempo is the beat.
  function backbeatRatio(x, fps, fastBpm, t0) {
    const f = fastBpm / 60, v = [0, 0, 0, 0];
    for (let n = 0; n < x.length; n++) {
      const pos = (n / fps - t0) * f, k = Math.round(pos);
      if (Math.abs(pos - k) < 0.12) v[((k % 4) + 4) % 4] += x[n];
    }
    let sm = 0; for (let i = 1; i < 4; i++) if (v[i] > v[sm]) sm = i;
    return { rho: v[(sm + 2) % 4] / (v[sm] || 1), v };
  }

  // ---------- Stage 5: beat phase by folding (synchronous averaging) ----------
  function foldPhase(x, fps, bpm) {
    const B = 128, f = bpm / 60, prof = new Float64Array(B);
    for (let n = 0; n < x.length; n++) {
      let p = (n / fps) * f; p -= Math.floor(p); const q = p * B, i = Math.floor(q), fr = q - i;
      prof[i % B] += x[n] * (1 - fr); prof[(i + 1) % B] += x[n] * fr;
    }
    // circular gaussian smoothing, sigma = 1.5 bins
    const sm = new Float64Array(B), K = 4, g = [];
    for (let k = -K; k <= K; k++) g.push(Math.exp(-0.5 * (k / 1.5) ** 2));
    for (let i = 0; i < B; i++) { let s = 0; for (let k = -K; k <= K; k++) s += prof[(i + k + B) % B] * g[k + K]; sm[i] = s; }
    let bi = 0; for (let i = 1; i < B; i++) if (sm[i] > sm[bi]) bi = i;
    const y0 = sm[(bi - 1 + B) % B], y1 = sm[bi], y2 = sm[(bi + 1) % B], den = y0 - 2 * y1 + y2;
    const off = den !== 0 ? 0.5 * (y0 - y2) / den : 0;
    const frac = ((bi + off) / B + 1) % 1;
    const sorted = Array.from(sm).sort((a, b) => a - b), med = sorted[B >> 1];
    return { t0: frac / f, contrast: y1 > 0 ? (y1 - med) / y1 : 0, profile: sm };
  }

  function analyzeBeats(mono, sr, opts) {
    opts = Object.assign({
      rangeMin: 78, fastMax: 180, slowAmbigMax: 90, priorCenter: 120, priorSigma: 1.0,
      searchMin: 60, searchMax: 200, rhoFast: 0.5, phaseBiasMs: 2.6, snap: true
    }, opts || {});
    const tm = {}; let t = performance.now();
    const H = 64;
    const b = onsetBands(mono, sr, H); const fps = b.fps;
    tm.onset = performance.now() - t; t = performance.now();
    const nf = b.nf, ossT = new Float32Array(nf), ossP = new Float32Array(nf);
    for (let n = 0; n < nf; n++) { ossT[n] = b.low[n] + b.mid[n] + 0.5 * b.high[n]; ossP[n] = b.low[n] + b.mid[n]; }
    const half = Math.round(0.25 * fps);
    const ossTa = subtractLocalMean(ossT, half), ossPa = subtractLocalMean(ossP, half);
    const cands = tempoCandidates(ossTa, fps, opts);
    tm.acf = performance.now() - t; t = performance.now();
    if (!cands.length) return { bpm: 0, confidence: 0, timings: tm, debug: null };
    let bpm = cands[0].bpm;
    while (bpm < opts.rangeMin) bpm *= 2;
    while (bpm >= 2 * opts.rangeMin) bpm /= 2;
    const bpmAcf = bpm;
    const n2 = ossPa.length >> 1, x2 = new Float32Array(n2);
    for (let i = 0; i < n2; i++) x2[i] = ossPa[2 * i] + ossPa[2 * i + 1];
    bpm = zoomRefine(x2, fps / 2, bpm, 0.006, 24);
    bpm = zoomRefine(x2, fps / 2, bpm, 0.0006, 6);
    const bpmZoom = bpm;
    tm.zoom = performance.now() - t; t = performance.now();
    let pf = phaseFit(ossPa, fps, bpm, 8, 4);
    pf = phaseFit(ossPa, fps, pf.bpm, 8, 4);
    tm.phase = performance.now() - t; t = performance.now();
    let octave = null;
    if (pf.bpm < opts.slowAmbigMax && 2 * pf.bpm <= opts.fastMax) {
      const fastBpm = 2 * pf.bpm, fp = foldPhase(ossPa, fps, fastBpm);
      const bb = backbeatRatio(linFlux(b.eHigh), fps, fastBpm, fp.t0);
      octave = { rho: bb.rho, v: bb.v.map((z) => +z.toExponential(2)), choseFast: bb.rho > opts.rhoFast };
      if (octave.choseFast) pf = phaseFit(ossPa, fps, fastBpm, 8, 4);
    }
    const variable = pf.residRmsMs > 12 || pf.residMaxMs > 40;
    let snapped = null;
    if (opts.snap && !variable && pf.span > 20) {
      const tol = pf.bpm * 0.008 / pf.span;
      for (const q of [1, 2]) {
        const c = Math.round(pf.bpm * q) / q;
        if (Math.abs(c - pf.bpm) < tol) { snapped = c; break; }
      }
      if (snapped !== null) pf = Object.assign({}, pf, { bpm: snapped });
    }
    const fpFinal = foldPhase(ossPa, fps, pf.bpm);
    tm.fold = performance.now() - t;
    const P = 60 / pf.bpm;
    let t0 = (variable ? pf.t0 : fpFinal.t0) - opts.phaseBiasMs / 1000; t0 = ((t0 % P) + P) % P;
    let tF = pf.t0 - opts.phaseBiasMs / 1000; tF = ((tF % P) + P) % P;
    const conf = Math.max(0, Math.min(1, (fpFinal.contrast - 0.3) / 0.5)) * Math.min(1, pf.coverage / 0.5) * (variable ? 0.5 : 1);
    tm.total = Object.values(tm).reduce((a, c) => a + c, 0);
    return {
      bpm: pf.bpm, firstBeat: t0, confidence: conf, variableTempo: variable,
      debug: { fps, bpmAcf, bpmZoom, cands: cands.map((c) => +c.bpm.toFixed(3)), coherence: pf.coherence, coverage: pf.coverage,
        contrast: fpFinal.contrast, fourierT0: tF,
        residRmsMs: pf.residRmsMs, residMaxMs: pf.residMaxMs, octave, snapped, nWin: pf.nWin, nUsed: pf.nUsed },
      timings: tm
    };
  }

  global.analyzeBeats = analyzeBeats;
  global.__bpmInternals = { onsetBands, subtractLocalMean, tempoCandidates, zoomRefine, phaseFit, backbeatRatio, foldPhase, linFlux };
})(typeof self !== 'undefined' ? self : this);
