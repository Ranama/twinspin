// Regression set on real music: your own WAV files (48 kHz here) in tests/media/, which is gitignored and not
// part of the repository. When a file is missing its test is skipped with a "# SKIP" line, so a fresh clone
// passes without them. Each WAV is parsed here, decimated exactly like src/audio/pcm.js preparePcm
// (D = round(sr / 11025), mean of D frames of (L + R) / 2) and analysed whole. To use your own songs, name the
// files like the tests below (tests/media/<name>.wav) and set the expected values to your hand-checked ones.
//
// Reference values (from a separate, independent beat tracker):
//   Boss Battle Groove   148.1 BPM, constant (beat fit residual 4 ms)
//   Bubble Star Parade   drifts 140.1 -> 140.6
//   Arcade Rush          ~141.9, drifting. NOTE: the reference map has one extra beat in the fill + breakdown at
//                        62-73 s (it speeds up to ~150 and back); the onsets after the fill sit every 2 beats of
//                        a steady ~141.3 grid, so the real average is ~141.5. The +-0.4 tolerance covers both.
//   Kaleidoscopic Loop   ~141.1, drifting (140.4 -> 141.7)
// Checks: bpm, the variable flag, confidence, and that the beat map sits on the music: per chunk of 8 beats the
// kick-band onsets (a detector independent of bpm.js) peak at a steady offset from the map beats (spread ~2 ms),
// while one constant grid through the same beats wanders by 25-30 ms on the drifting songs.
// Run: tools/JsCheck/jscheck run tests/realsongs.test.js   (about 30 s; set globalThis.BPM_VERBOSE = true for details)

import { detectBeats } from '../src/analysis/bpm.js';

const VERBOSE = !!globalThis.BPM_VERBOSE;
const MEDIA = 'tests/media/';

// ---------------------------------------------------------------------------------------------------------
// WAV -> decimated mono (like preparePcm)
// ---------------------------------------------------------------------------------------------------------

/** Parse a RIFF/WAVE header: { format: 'pcm'|'float', channels, sampleRate, bits, dataOffset, frames }. */
function parseWav(buf) {
  const dv = new DataView(buf);
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (buf.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let o = 12, fmt = null;
  while (o + 8 <= buf.byteLength) {
    const id = tag(o), size = dv.getUint32(o + 4, true), body = o + 8;
    if (id === 'fmt ') {
      let code = dv.getUint16(body, true);
      if (code === 0xfffe && size >= 40) code = dv.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE sub-format
      fmt = { code, channels: dv.getUint16(body + 2, true), sampleRate: dv.getUint32(body + 4, true),
        blockAlign: dv.getUint16(body + 12, true), bits: dv.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('data before fmt');
      const bytes = Math.min(size, buf.byteLength - body);
      const format = fmt.code === 1 ? 'pcm' : fmt.code === 3 ? 'float' : null;
      if (!format) throw new Error('unsupported WAV format ' + fmt.code);
      const okBits = format === 'pcm' ? [16, 24, 32].includes(fmt.bits) : [32, 64].includes(fmt.bits);
      if (!okBits || !(fmt.channels > 0)) throw new Error('unsupported WAV layout: ' + fmt.bits + ' bit');
      const frameBytes = fmt.blockAlign || (fmt.channels * fmt.bits) / 8;
      return { format, channels: fmt.channels, sampleRate: fmt.sampleRate, bits: fmt.bits, frameBytes,
        dataOffset: body, frames: Math.floor(bytes / frameBytes) };
    }
    o = body + size + (size & 1);
  }
  throw new Error('no data chunk');
}

/** One sample reader per format: (byteOffset) -> float in [-1, 1). */
function sampleReader(dv, w) {
  if (w.format === 'float') return w.bits === 64 ? (p) => dv.getFloat64(p, true) : (p) => dv.getFloat32(p, true);
  if (w.bits === 16) return (p) => dv.getInt16(p, true) / 32768;
  if (w.bits === 24) {
    return (p) => {
      const v = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getInt8(p + 2) << 16);
      return v / 8388608;
    };
  }
  return (p) => dv.getInt32(p, true) / 2147483648;
}

/** Decimated mono of a WAV file: mean of D frames of (L + R) / 2 (first two channels), D = round(sr / 11025). */
function wavToMono(buf) {
  const w = parseWav(buf);
  const D = Math.max(1, Math.round(w.sampleRate / 11025));
  const nch = Math.min(2, w.channels), n = Math.floor(w.frames / D), mono = new Float32Array(n);
  const scale = 1 / (D * nch);
  if (w.format === 'pcm' && w.bits === 16 && w.dataOffset % 2 === 0 && w.frameBytes === 2 * w.channels) {
    // fast path (the regression files): an Int16 view, no per-sample DataView calls
    const a = new Int16Array(buf, w.dataOffset, w.frames * w.channels), C = w.channels, s16 = scale / 32768;
    for (let j = 0, k = 0; j < n; j++) {
      let s = 0;
      for (let f = 0; f < D; f++, k += C) s += nch === 2 ? a[k] + a[k + 1] : a[k];
      mono[j] = s * s16;
    }
  } else {
    const dv = new DataView(buf), rd = sampleReader(dv, w), bps = w.bits / 8;
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let f = 0; f < D; f++) {
        const p = w.dataOffset + (j * D + f) * w.frameBytes;
        s += rd(p);
        if (nch === 2) s += rd(p + bps);
      }
      mono[j] = s * scale;
    }
  }
  return { mono, rate: w.sampleRate / D, duration: w.frames / w.sampleRate };
}

// ---------------------------------------------------------------------------------------------------------
// independent onset check: kick band (2 x one-pole LP 150 Hz), energy per 2 ms, log, 6 ms rectified rise
// ---------------------------------------------------------------------------------------------------------

function kickFlux(mono, rate) {
  const hop = Math.max(1, Math.round(rate * 0.002)), n = Math.floor(mono.length / hop);
  const a = Math.exp((-2 * Math.PI * 150) / rate);
  const env = new Float64Array(n), flux = new Float64Array(n);
  let y1 = 0, y2 = 0;
  for (let h = 0, i = 0; h < n; h++) {
    let e = 0;
    for (let k = 0; k < hop; k++, i++) {
      y1 = (1 - a) * mono[i] + a * y1;
      y2 = (1 - a) * y1 + a * y2;
      e += y2 * y2;
    }
    env[h] = Math.log(1e-10 + e);
  }
  for (let h = 3; h < n; h++) flux[h] = Math.max(0, env[h] - env[h - 3]);
  return { flux, dt: hop / rate };
}

/**
 * How well beats sit on the kicks: the song is cut into chunks of 8 beats; in each chunk the kick-band flux
 * around the beats is summed into an offset histogram (-60..+60 ms, 2 ms bins) and its peak is the chunk's
 * offset (chunks without a clear kick peak are left out). The detector's own latency is a constant; what
 * matters is the spread of the chunk offsets around their median: a map that follows the music keeps every
 * chunk within a few ms, a constant grid on a drifting song wanders by tens of ms.
 */
function onsetOffsets(beats, kf) {
  const { flux, dt } = kf, W = Math.round(0.06 / dt), nb = 2 * W + 1, offs = [];
  const hist = new Float64Array(nb);
  for (let k0 = 0; k0 + 8 <= beats.length; k0 += 8) {
    hist.fill(0);
    let ok = true;
    for (let k = k0; k < k0 + 8; k++) {
      const c = Math.round(beats[k] / dt);
      if (c - W - 1 < 0 || c + W + 1 >= flux.length) {
        ok = false;
        break;
      }
      for (let o = -W; o <= W; o++) hist[o + W] += flux[c + o - 1] + 2 * flux[c + o] + flux[c + o + 1];
    }
    if (!ok) continue;
    let bi = 0, mean = 0;
    for (let i = 0; i < nb; i++) {
      mean += hist[i] / nb;
      if (hist[i] > hist[bi]) bi = i;
    }
    if (hist[bi] < 2 * mean) continue; // no clear kick in this chunk (breakdown)
    offs.push((bi - W) * dt);
  }
  const s = offs.slice().sort((x, y) => x - y), med = s[s.length >> 1];
  const dev = offs.map((e) => Math.abs(e - med)).sort((x, y) => x - y);
  return {
    n: offs.length,
    offsetMs: med * 1000,
    madMs: dev[dev.length >> 1] * 1000,
    maxMs: dev[dev.length - 1] * 1000,
    within10: dev.filter((d) => d <= 0.0101).length / dev.length,
    offs: VERBOSE ? offs.map((e) => Math.round(e * 1000)).join(' ') : undefined,
  };
}

/** Least-squares constant grid through the beats (what a constant-tempo analysis would give). */
function constantGrid(beats) {
  const n = beats.length;
  let sk = 0, st = 0, skk = 0, skt = 0;
  for (let k = 0; k < n; k++) {
    sk += k; st += beats[k]; skk += k * k; skt += k * beats[k];
  }
  const P = (n * skt - sk * st) / (n * skk - sk * sk), a = (st - P * sk) / n;
  return Float64Array.from(beats, (_, k) => a + P * k);
}

/** Tempo (bpm) of the map over [t0, t1]: beats in the span / their time. */
function localBpm(beats, t0, t1) {
  const inside = Array.from(beats).filter((t) => t >= t0 && t <= t1);
  return (60 * (inside.length - 1)) / (inside[inside.length - 1] - inside[0]);
}

// ---------------------------------------------------------------------------------------------------------

async function load(name) {
  const res = await fetch(MEDIA + name + '.wav');
  if (!res.ok) return null;
  return wavToMono(await res.arrayBuffer());
}

function analyse(name, song) {
  const r = detectBeats(song.mono, song.rate, { debug: VERBOSE });
  const kf = kickFlux(song.mono, song.rate);
  const map = onsetOffsets(r.beats, kf);
  const grid = onsetOffsets(constantGrid(r.beats), kf);
  if (VERBOSE) {
    console.log(name, JSON.stringify({ bpm: r.bpm, firstBeat: r.firstBeat, conf: r.confidence, variable: r.variable,
      beats: r.beats.length, dur: song.duration, map, grid, dev: r.debug && r.debug.mapDev }));
  }
  return { r, map, grid };
}

function songTest(name, title, fn) {
  test(name + ': ' + title, async () => {
    const song = await load(name);
    if (!song) {
      console.log(`# SKIP ${name}: ${MEDIA}${name}.wav is missing (your own WAV files; not in the repository)`);
      return;
    }
    fn(analyse(name, song), song);
  });
}

test('WAV parser: 16-bit, 24-bit and float stereo decode to the same decimated mono', () => {
  const sr = 44100, frames = 4400, mk = (bits, code) => {
    const bps = bits / 8, data = frames * 2 * bps, buf = new ArrayBuffer(44 + data), dv = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + data, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, code, true); dv.setUint16(22, 2, true); dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * 2 * bps, true); dv.setUint16(32, 2 * bps, true); dv.setUint16(34, bits, true);
    w(36, 'data'); dv.setUint32(40, data, true);
    for (let i = 0; i < frames; i++) {
      const L = 0.5 * Math.sin(i / 7), R = -0.25 * Math.cos(i / 5);
      for (const [c, v] of [[0, L], [1, R]]) {
        const p = 44 + (i * 2 + c) * bps;
        if (code === 3) dv.setFloat32(p, v, true);
        else if (bits === 16) dv.setInt16(p, Math.round(v * 32767), true);
        else {
          const x = Math.round(v * 8388607) & 0xffffff;
          dv.setUint8(p, x & 255); dv.setUint8(p + 1, (x >> 8) & 255); dv.setUint8(p + 2, (x >> 16) & 255);
        }
      }
    }
    return buf;
  };
  const a = wavToMono(mk(16, 1)), b = wavToMono(mk(24, 1)), c = wavToMono(mk(32, 3));
  assert.equal(a.rate, 11025);
  assert.equal(a.mono.length, frames / 4);
  for (let j = 0; j < a.mono.length; j++) {
    let s = 0;
    for (let f = 0; f < 4; f++) s += 0.5 * Math.sin((j * 4 + f) / 7) - 0.25 * Math.cos((j * 4 + f) / 5);
    const want = s / 8;
    assert(Math.abs(a.mono[j] - want) < 1e-4 && Math.abs(b.mono[j] - want) < 1e-6 && Math.abs(c.mono[j] - want) < 1e-6,
      'sample ' + j);
  }
  assert.throws(() => parseWav(new ArrayBuffer(10)), /RIFF/);
});

songTest('Boss Battle Groove', '148.1 BPM, constant, confident', ({ r, map }) => {
  assert(Math.abs(r.bpm - 148.1) <= 0.05, 'bpm ' + r.bpm);
  assert.equal(r.variable, false, 'constant tempo');
  assert(r.confidence >= 0.7, 'confidence ' + r.confidence);
  // steady: the map is the grid
  const P = 60 / r.bpm;
  for (let k = 0; k < r.beats.length; k++) {
    assert(Math.abs(r.beats[k] - (r.firstBeat + k * P)) < 1e-9, 'grid beat ' + k);
  }
  assert(map.n >= 20, 'chunks with a kick: ' + map.n);
  assert(map.madMs <= 5 && map.within10 >= 0.8, `grid on the kicks: MAD ${map.madMs.toFixed(1)} ms, ${map.within10}`);
});

songTest('Bubble Star Parade', 'drifts 140.1 -> 140.6, the map follows it', ({ r, map, grid }) => {
  assert(Math.abs(r.bpm - 140.35) <= 0.4, 'average bpm ' + r.bpm);
  assert.equal(r.variable, true, 'variable tempo');
  assert.equal(r.firstBeat, r.beats[0]);
  const start = localBpm(r.beats, 0, 45), end = localBpm(r.beats, r.beats[r.beats.length - 1] - 45, Infinity);
  if (VERBOSE) console.log('Bubble Star Parade tempo start/end', start, end);
  assert(Math.abs(start - 140.1) <= 0.25 && Math.abs(end - 140.6) <= 0.25, `tempo ${start} -> ${end}`);
  assert(map.madMs <= 3 && map.within10 >= 0.75, `map on the kicks: MAD ${map.madMs.toFixed(1)} ms, ${map.within10}`);
  assert(grid.madMs > 3 * map.madMs && grid.within10 < map.within10 - 0.3,
    `the map beats a constant grid: MAD ${map.madMs.toFixed(1)} vs ${grid.madMs.toFixed(1)} ms`);
});

songTest('Arcade Rush', '~141.9 drifting, the map follows it', ({ r, map, grid }) => {
  assert(Math.abs(r.bpm - 141.9) <= 0.4, 'average bpm ' + r.bpm);
  assert.equal(r.variable, true, 'variable tempo');
  assert.equal(r.firstBeat, r.beats[0]);
  assert(map.madMs <= 3 && map.within10 >= 0.75, `map on the kicks: MAD ${map.madMs.toFixed(1)} ms, ${map.within10}`);
  assert(grid.madMs > 3 * map.madMs && grid.within10 < map.within10 - 0.3,
    `the map beats a constant grid: MAD ${map.madMs.toFixed(1)} vs ${grid.madMs.toFixed(1)} ms`);
});

songTest('Kaleidoscopic Loop', '~141.1 drifting, the map follows it', ({ r, map, grid }) => {
  assert(Math.abs(r.bpm - 141.1) <= 0.4, 'average bpm ' + r.bpm);
  assert.equal(r.variable, true, 'variable tempo');
  assert.equal(r.firstBeat, r.beats[0]);
  const start = localBpm(r.beats, 0, 45), end = localBpm(r.beats, r.beats[r.beats.length - 1] - 45, Infinity);
  if (VERBOSE) console.log('Kaleidoscopic Loop tempo start/end', start, end);
  assert(end - start > 0.5, `tempo rises ${start} -> ${end}`);
  assert(map.madMs <= 3 && map.within10 >= 0.75, `map on the kicks: MAD ${map.madMs.toFixed(1)} ms, ${map.within10}`);
  assert(grid.madMs > 3 * map.madMs && grid.within10 < map.within10 - 0.3,
    `the map beats a constant grid: MAD ${map.madMs.toFixed(1)} vs ${grid.madMs.toFixed(1)} ms`);
});
