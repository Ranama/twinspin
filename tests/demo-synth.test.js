// Tests for src/audio/demo-synth.js at 8000 Hz (JsCheck is an interpreter: keep renders small).
import { DEMO_TRACKS, synthDemo, createDemoJob } from '../src/audio/demo-synth.js';

const SR = 8000;
const PEAK = Math.pow(10, -1 / 20);

// Exact peak via the engine's native typed-array sort (a JS loop over 768k samples is slow in Jint).
function peakOf(ch) {
  if (!ch.length) return 0;
  const s = ch.slice().sort();
  return Math.max(-s[0], s[s.length - 1]);
}

function rms(ch, from, to, stride = 1) {
  let s = 0;
  let n = 0;
  for (let i = from; i < to; i += stride) {
    s += ch[i] * ch[i];
    n++;
  }
  return Math.sqrt(s / Math.max(1, n));
}

test('track list matches the contract', () => {
  assert.equal(DEMO_TRACKS.length, 2);
  assert.deepEqual({ ...DEMO_TRACKS[0] }, { id: 0, title: 'Neon Drift', artist: 'TwinSpin demo', bpm: 124 });
  assert.deepEqual({ ...DEMO_TRACKS[1] }, { id: 1, title: 'Spore Garden', artist: 'TwinSpin demo', bpm: 128 });
});

for (const t of DEMO_TRACKS) {
  test(`${t.title}: 96 s stereo, peak -1 dBFS, first kick at 0, kicks on the grid, quiet-free mix`, () => {
    const r = synthDemo(t.id, SR);
    assert.equal(r.sampleRate, SR);
    assert.equal(r.channels.length, 2);
    const [L, R] = r.channels;
    assert(L instanceof Float32Array && R instanceof Float32Array);
    assert.equal(L.length, 96 * SR);
    assert.equal(R.length, 96 * SR);
    const pk = Math.max(peakOf(L), peakOf(R));
    assert.closeTo(pk, PEAK, 1e-6);
    // The first kick starts at sample 0: loud within 3 ms, nothing can come earlier.
    const beat = (60 / t.bpm) * SR;
    assert(peakOf(L.subarray(0, Math.round(0.003 * SR))) > 0.3, 'kick attack at 0');
    // Kicks every beat in the intro: energy in the first 20 ms after each beat is far above the 20 ms before.
    for (let k = 1; k < 16; k++) {
      const at = Math.round(k * beat);
      const after = rms(L, at, at + 160);
      const before = rms(L, at - 160, at);
      assert(after > before * 1.5, `kick on beat ${k}: ${after.toFixed(3)} vs ${before.toFixed(3)}`);
    }
    // Stereo: not identical channels (stabs, hats and claps are spread), but strongly correlated.
    let diff = 0;
    for (let i = 0; i < L.length; i += 31) diff += Math.abs(L[i] - R[i]);
    assert(diff > 1, 'some stereo width');
    // No section is silent before the very end, and the breakdown (bars 24-27) is quieter than the drop.
    const bar = 4 * beat;
    for (let b = 0; b < 48; b += 2) {
      const lvl = rms(L, Math.round(b * bar), Math.round((b + 2) * bar), 5);
      assert(lvl > 0.02, `bars ${b}-${b + 1} too quiet: ${lvl}`);
    }
    const breakdown = rms(L, Math.round(24 * bar), Math.round(28 * bar), 3);
    const drop = rms(L, Math.round(28 * bar), Math.round(32 * bar), 3);
    assert(breakdown < drop * 0.7 && breakdown > drop * 0.15, `breakdown ${breakdown} drop ${drop}`);
    // Ends with the ring-out: the last 100 ms is quiet.
    assert(rms(L, L.length - 800, L.length) < 0.05);
  });
}

test('deterministic: same input -> identical samples; tracks differ', () => {
  const a = synthDemo(1, SR, 8);
  const b = synthDemo(1, SR, 8);
  assert.equal(a.channels[0].length, 8 * SR);
  let same = true;
  for (let c = 0; c < 2 && same; c++) {
    const x = a.channels[c];
    const y = b.channels[c];
    for (let i = 0; i < x.length; i++) {
      if (x[i] !== y[i]) {
        same = false;
        break;
      }
    }
  }
  assert(same, 'bit-identical renders');
  const other = synthDemo(0, SR, 8);
  let d = 0;
  for (let i = 0; i < other.channels[0].length; i++) d += Math.abs(other.channels[0][i] - a.channels[0][i]);
  assert(d > 100, 'the two demos are different');
});

test('sliced job gives the same result as synthDemo and reports progress', () => {
  const ref = synthDemo(0, SR, 4);
  const job = createDemoJob(0, SR, 4);
  let steps = 0;
  let last = -1;
  while (!job.step(0)) {
    steps++;
    assert(job.progress >= last && job.progress < 1);
    last = job.progress;
  }
  assert.equal(job.progress, 1);
  assert(steps > 5, `job ran in ${steps} steps`);
  const out = job.result();
  for (let i = 0; i < ref.channels[0].length; i += 3) assert.equal(out.channels[0][i], ref.channels[0][i]);
});

test('bad input is rejected; short renders still work', () => {
  assert.throws(() => synthDemo(5, SR), RangeError);
  assert.throws(() => synthDemo(0, 100), RangeError);
  const r = synthDemo(1, SR, 1);
  assert.equal(r.channels[0].length, SR);
  assert.closeTo(Math.max(peakOf(r.channels[0]), peakOf(r.channels[1])), PEAK, 1e-6);
});

// Cross-check with the analysis module: the beat detector must find the demo tempo and a grid at 0.
let detectBeats = null;
try {
  ({ detectBeats } = await import('../src/analysis/bpm.js'));
} catch {
  detectBeats = null;
}

for (const t of DEMO_TRACKS) {
  test(`${t.title}: detectBeats finds ${t.bpm} BPM with the grid on the kicks`, () => {
    if (!detectBeats) {
      console.log('# skipped: src/analysis/bpm.js not available');
      return;
    }
    const sr = 11025;
    const { channels: [L, R] } = synthDemo(t.id, sr, 40);
    const mono = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) mono[i] = 0.5 * (L[i] + R[i]);
    const b = detectBeats(mono, sr);
    assert(b.bpm !== null, 'a tempo was found');
    assert.closeTo(b.bpm, t.bpm, 0.05);
    const P = 60 / t.bpm;
    const off = Math.min(b.firstBeat % P, P - (b.firstBeat % P));
    assert(off < 0.012, `firstBeat ${b.firstBeat} is ${off * 1000} ms off the kick grid`);
    assert(b.confidence > 0.5, `confidence ${b.confidence}`);
  });
}
