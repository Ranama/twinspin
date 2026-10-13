// Tests for the deck DSP core (src/audio/deck-dsp.js), the worklet processor protocol
// (src/audio/deck-worklet-src.js) and the main-thread player (src/audio/deck-player.js) with fake contexts.
// Signals are small (8 kHz) because Jint is an interpreter.

import { DeckDSP } from '../src/audio/deck-dsp.js';
import { processorMain } from '../src/audio/deck-worklet-src.js';
import { DeckPlayer } from '../src/audio/deck-player.js';
import { mulberry32 } from '../src/core/util.js';

const SR = 8000;
const BLOCKS = [128, 100, 37, 128, 64, 91, 1, 128];

// ------------------------------------------------------------------------------------------------- helpers

/** Render `frames` samples in irregular blocks through fixed 128-sample scratch arrays (tests `frames`). */
function render(dsp, frames) {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  const sl = new Float32Array(128);
  const sr = new Float32Array(128);
  let i = 0;
  let b = 0;
  while (i < frames) {
    const n = Math.min(BLOCKS[b++ % BLOCKS.length], frames - i);
    dsp.process(sl, sr, n);
    for (let k = 0; k < n; k++) {
      L[i + k] = sl[k];
      R[i + k] = sr[k];
    }
    i += n;
  }
  return { L, R };
}

function sine(freq, seconds, amp = 0.8, sr = SR, phase = 0) {
  const n = Math.round(seconds * sr);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin(phase + (2 * Math.PI * freq * i) / sr);
  return a;
}

function noise(seconds, seed = 1, sr = SR) {
  const rnd = mulberry32(seed);
  const n = Math.round(seconds * sr);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = rnd() * 1.6 - 0.8;
  return a;
}

function maxStep(a, from = 1, to = a.length) {
  let m = 0;
  for (let i = Math.max(1, from); i < to; i++) {
    const d = Math.abs(a[i] - a[i - 1]);
    if (d > m) m = d;
  }
  return m;
}

function peak(a, from = 0, to = a.length) {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i]));
  return m;
}

/** Frames until consumeEnded() turns true (rendering in 128 blocks), or -1. */
function framesUntilEnded(dsp, limit) {
  const l = new Float32Array(128);
  const r = new Float32Array(128);
  let total = 0;
  while (total < limit) {
    dsp.process(l, r, 128);
    total += 128;
    if (dsp.consumeEnded()) return total;
  }
  return -1;
}

const F220_STEP = 2 * 0.8 * Math.sin((Math.PI * 220) / SR); // max sample-to-sample step of the test sine

// ------------------------------------------------------------------------------------------------- DSP core

test('rate 1 reproduces the source sample-exact (mono and stereo)', () => {
  const src = noise(0.6, 7);
  const dsp = new DeckDSP(SR);
  dsp.load([src], SR);
  assert.equal(dsp.loaded, true);
  assert.closeTo(dsp.duration, 0.6, 1e-12);
  dsp.setPlaying(true);
  assert.equal(dsp.playing, true);
  const { L, R } = render(dsp, 4000);
  for (let i = 30; i < 4000; i++) {
    if (L[i] !== src[i]) fail(`sample ${i}: ${L[i]} !== ${src[i]}`);
    if (R[i] !== src[i]) fail(`mono feeds both sides at ${i}`);
  }
  assert.closeTo(dsp.position, 4000 / SR, 1e-12);
  assert.equal(dsp.velocity, 1);

  const a = noise(0.3, 11);
  const b = noise(0.3, 12);
  const st = new DeckDSP(SR);
  st.load([a, b], SR);
  st.setPlaying(true);
  const out = render(st, 2000);
  for (let i = 30; i < 2000; i++) {
    if (out.L[i] !== a[i] || out.R[i] !== b[i]) fail(`stereo sample ${i}`);
  }
});

test('start ramp is short and click-free', () => {
  const src = new Float32Array(SR).fill(0.5);
  const dsp = new DeckDSP(SR);
  dsp.load([src], SR);
  dsp.setPlaying(true);
  const { L } = render(dsp, 200);
  assert(L[0] < 0.05, 'first sample is near silent');
  assert.equal(L[40], 0.5, 'full level after 3 ms');
  assert(maxStep(L, 1, 200) <= 0.5 / 24 + 1e-6, 'ramp steps are tiny');
});

test('rate 1.5 / 0.5 duration math and resampled sources', () => {
  for (const rate of [1.5, 0.5, 2]) {
    const dsp = new DeckDSP(SR);
    dsp.load([noise(1, 3)], SR);
    dsp.setRate(rate);
    dsp.setPlaying(true);
    render(dsp, 1000);
    assert.closeTo(dsp.position, (1000 * rate) / SR, 1e-9, `position at rate ${rate}`);
    assert.equal(dsp.velocity, rate);
    const total = 1000 + framesUntilEnded(dsp, 40000);
    const expected = SR / rate;
    assert(Math.abs(total - expected) <= 128, `rate ${rate}: ended after ${total} frames, expected ~${expected}`);
    assert.equal(dsp.playing, false);
    assert.closeTo(dsp.position, 1, 1e-9);
  }
  // 4 kHz PCM into an 8 kHz output: still one second of output per second of track
  const dsp = new DeckDSP(SR);
  dsp.load([noise(1, 5, 4000)], 4000);
  assert.closeTo(dsp.duration, 1, 1e-12);
  dsp.setPlaying(true);
  render(dsp, 2000);
  assert.closeTo(dsp.position, 0.25, 1e-9);
});

test('reverse play mirrors the source and stops at the start', () => {
  const src = sine(220, 0.4);
  const dsp = new DeckDSP(SR);
  dsp.load([src], SR);
  dsp.seek(0.3);
  dsp.setRate(-1);
  dsp.setPlaying(true);
  const { L } = render(dsp, 800);
  for (let i = 30; i < 800; i++) {
    if (L[i] !== src[2400 - i]) fail(`reverse sample ${i}: ${L[i]} vs ${src[2400 - i]}`);
  }
  assert.closeTo(dsp.position, 0.2, 1e-9);
  assert.equal(dsp.velocity, -1);
  const rest = render(dsp, 2000);
  assert.equal(dsp.playing, false, 'motor stops at the start');
  assert.equal(dsp.consumeEnded(), false, 'running off the start is not "ended"');
  assert.equal(dsp.position, 0);
  assert(maxStep(rest.L) <= F220_STEP * 1.2, 'fades before the start');
});

test('loop wrap is continuous and stays inside the loop', () => {
  const src = sine(220, 1);
  const ls = 0.1;
  const le = 0.16023; // 13.25 periods: the raw wrap would be a big step
  const naive = Math.abs(src[Math.round(le * SR)] - src[Math.round(ls * SR)]);
  assert(naive > 3 * F220_STEP, 'the test loop has a real phase jump');
  const dsp = new DeckDSP(SR);
  dsp.load([src], SR);
  dsp.seek(0.09);
  dsp.setLoop(ls, le);
  assert.equal(dsp.looping, true);
  dsp.setPlaying(true);
  const l = new Float32Array(128);
  const all = [];
  for (let b = 0; b < 40; b++) {
    dsp.process(l, null, 128);
    for (let k = 0; k < 128; k++) all.push(l[k]);
    if (b > 2) assert(dsp.position >= ls - 1e-9 && dsp.position < le + 1e-9, `inside loop: ${dsp.position}`);
  }
  const out = Float32Array.from(all);
  const step = maxStep(out, 40);
  assert(step <= F220_STEP * 1.1, `max step ${step} vs signal ${F220_STEP}`);
  assert.equal(dsp.consumeEnded(), false);
  // reverse play wraps too
  dsp.setRate(-1);
  render(dsp, 400);
  const rev = render(dsp, 2000);
  assert(dsp.position >= ls - 1e-9 && dsp.position < le + 1e-9, 'reverse stays in the loop');
  assert(maxStep(rev.L) <= F220_STEP * 1.1, 'reverse wrap is continuous');
  // clearing lets it run out of the loop
  dsp.setRate(1);
  dsp.clearLoop();
  render(dsp, 1200);
  assert(dsp.position > le, 'plays on after clearLoop');
});

test('setLoop behind the head jumps back in, phase kept', () => {
  const dsp = new DeckDSP(SR);
  dsp.load([sine(220, 1)], SR);
  dsp.seek(0.35);
  dsp.setLoop(0.1, 0.3); // head 0.05 s past the end, within one loop length
  assert.closeTo(dsp.position, 0.15, 1e-9);
  dsp.seek(0.9);
  dsp.setLoop(0.1, 0.3); // far outside: armed, no jump
  assert.closeTo(dsp.position, 0.9, 1e-9);
});

test('seek is declicked (and a raw seek is not)', () => {
  const src = sine(220, 1);
  const run = (declick) => {
    const dsp = new DeckDSP(SR);
    dsp.load([src], SR);
    dsp.setPlaying(true);
    const a = render(dsp, 1600).L;
    dsp.seek(0.5123, declick);
    assert.closeTo(dsp.position, 0.5123, 1e-9);
    const b = render(dsp, 800).L;
    const both = new Float32Array(2400);
    both.set(a, 0);
    both.set(b, 1600);
    return maxStep(both, 40);
  };
  const smooth = run(true);
  const raw = run(false);
  assert(smooth <= F220_STEP * 1.1, `declicked step ${smooth}`);
  assert(raw > F220_STEP * 3, `raw seek should click (${raw})`);
});

test('scratch follower reaches a target within ~60 ms, then silence while held', () => {
  const dsp = new DeckDSP(SR);
  dsp.load([noise(2, 9)], SR);
  dsp.seek(0.5);
  dsp.scratchBegin();
  assert.equal(dsp.scratching, true);
  dsp.scratchMove(0.6, 0);
  render(dsp, Math.round(0.06 * SR));
  assert(Math.abs(dsp.position - 0.6) < 0.001, `position after 60 ms: ${dsp.position}`);
  const held = render(dsp, Math.round(0.15 * SR));
  assert(peak(held.L, held.L.length - 400) < 1e-3, 'held still: silent');
  assert(Math.abs(dsp.velocity) < 1e-3);
  assert(Math.abs(dsp.position - 0.6) < 1e-4);
  // speed is clamped to +-12
  dsp.scratchMove(0.84, 0); // 0.24 s away: below the jump threshold, wants 20x
  let maxV = 0;
  const l = new Float32Array(16);
  for (let i = 0; i < 100; i++) {
    dsp.process(l, null, 16);
    maxV = Math.max(maxV, Math.abs(dsp.velocity));
  }
  assert(maxV <= 12 + 1e-9 && maxV > 11, `speed clamp, max ${maxV}`);
});

test('scratch follows a moving finger and decays when moves stop', () => {
  const dsp = new DeckDSP(SR);
  dsp.load([noise(3, 4)], SR);
  dsp.seek(1);
  dsp.scratchBegin(1);
  let target = 1;
  for (let k = 1; k <= 30; k++) {
    target = 1 + k * 0.01; // finger at 1x speed, a move every 10 ms
    dsp.scratchMove(target, 1);
    render(dsp, 80);
  }
  // moves are extrapolated (up to 30 ms): 10 ms after the last move the head is where the finger is now
  assert(Math.abs(dsp.position - (target + 0.01)) < 0.004, `tracks the finger: ${dsp.position} vs ${target + 0.01}`);
  assert(Math.abs(dsp.velocity - 1) < 0.15, `speed ~1: ${dsp.velocity}`);
  const after = render(dsp, Math.round(0.3 * SR));
  assert(Math.abs(dsp.velocity) < 1e-3, 'stale target speed decays to 0');
  assert(Math.abs(dsp.position - target) < 0.01, `settles near the finger: ${dsp.position}`);
  assert(peak(after.L, after.L.length - 400) < 1e-3, 'silent once still');
  // backwards strokes play backwards
  dsp.scratchMove(target - 0.05, -1);
  render(dsp, 200);
  assert(dsp.velocity < 0 && dsp.position < target, 'moves backwards');
});

test('scratch jump for large targets, relative offset, pre-roll clamp', () => {
  const dsp = new DeckDSP(SR);
  dsp.load([noise(3, 5)], SR);
  dsp.seek(1);
  dsp.scratchBegin(0.9); // caller thinks the head is at 0.9 (latency): targets are taken relative to that
  dsp.scratchMove(1.9, 0); // +1 s: jump
  render(dsp, 1);
  assert(Math.abs(dsp.position - 2) < 0.002, `jumped: ${dsp.position}`);
  dsp.scratchMove(-5, 0); // far before the start: clamps at -2 s
  render(dsp, 400);
  assert(dsp.position >= -2 - 1e-9 && dsp.position < -1.9, `pre-roll clamp: ${dsp.position}`);
  dsp.scratchEnd();
  render(dsp, 4000);
  assert.equal(dsp.velocity, 0, 'stopped deck: platter comes to rest');
});

test('scratchEnd pulls the motor back in (70 ms time constant)', () => {
  const dsp = new DeckDSP(SR);
  dsp.load([noise(3, 6)], SR);
  dsp.setPlaying(true);
  render(dsp, 800);
  dsp.scratchBegin();
  render(dsp, 800);
  assert(Math.abs(dsp.velocity) < 0.01, `held: ${dsp.velocity}`);
  assert.equal(dsp.playing, true, 'motor stays on under the hand');
  const v0 = dsp.velocity;
  dsp.scratchEnd();
  render(dsp, Math.round(0.07 * SR));
  const expect = 1 - (1 - v0) * Math.exp(-1);
  assert(Math.abs(dsp.velocity - expect) < 0.03, `after 70 ms: ${dsp.velocity} (expected ~${expect})`);
  render(dsp, Math.round(1.1 * SR));
  assert.equal(dsp.velocity, 1, 'back at speed (snapped)');
});

test('vinyl brake ramps the speed down linearly', () => {
  const dsp = new DeckDSP(SR);
  dsp.load([sine(220, 3)], SR);
  dsp.setBrake(500);
  dsp.setPlaying(true);
  render(dsp, 800);
  const p0 = dsp.position;
  dsp.setPlaying(false);
  assert.equal(dsp.playing, false, 'motor off immediately');
  render(dsp, 2000);
  assert.closeTo(dsp.velocity, 0.5, 0.01);
  const tail = render(dsp, 2100);
  assert.equal(dsp.velocity, 0);
  assert.closeTo(dsp.position - p0, 0.25, 0.003);
  assert(peak(tail.L, tail.L.length - 50) === 0, 'silent once stopped');
  assert(maxStep(tail.L) <= F220_STEP * 1.05, 'no clicks while braking');
  // brake 0: 3 ms fade (the head runs on under the fade), then it parks where STOP was pressed
  dsp.setBrake(0);
  dsp.setPlaying(true);
  render(dsp, 400);
  const p1 = dsp.position;
  dsp.setPlaying(false);
  render(dsp, 10);
  assert(dsp.position > p1, 'still moving under the fade');
  const stop = render(dsp, 390);
  assert.equal(dsp.position, p1, 'parked exactly at the stop position');
  assert(peak(stop.L, 30) === 0, 'silent after the fade');
  assert(maxStep(stop.L) <= F220_STEP * 1.2, 'stop fade is smooth');
});

test('CDJ cue patterns land exactly: stop-then-seek and seek-then-stop', () => {
  const src = sine(220, 2);
  for (const order of ['stop-seek', 'seek-stop']) {
    const dsp = new DeckDSP(SR);
    dsp.load([src], SR);
    dsp.setPlaying(true);
    const a = render(dsp, 1000).L;
    if (order === 'stop-seek') {
      dsp.setPlaying(false);
      dsp.seek(0.25);
    } else {
      dsp.seek(0.25);
      dsp.setPlaying(false);
    }
    const b = render(dsp, 400).L;
    assert.equal(dsp.position, 0.25, `${order}: parked at the cue point`);
    assert.equal(dsp.playing, false);
    const both = new Float32Array(1400);
    both.set(a, 0);
    both.set(b, 1000);
    assert(maxStep(both, 40) <= F220_STEP * 1.2, `${order}: no click`);
    // seek during a brake: the platter coasts, then parks at the target
    dsp.setBrake(200);
    dsp.setPlaying(true);
    render(dsp, 400);
    dsp.setPlaying(false);
    dsp.seek(1.5);
    render(dsp, 2400);
    assert.equal(dsp.position, 1.5, `${order}: brake + seek parks at the target`);
    // playing again starts exactly there
    dsp.setPlaying(true);
    render(dsp, 80);
    assert.closeTo(dsp.position, 1.51, 1e-9);
  }
});

test('ended flag fires once at the end of the track, with a fade', () => {
  const src = sine(220, 0.3);
  const dsp = new DeckDSP(SR);
  dsp.load([src], SR);
  dsp.setPlaying(true);
  const { L } = render(dsp, 3200);
  assert.equal(dsp.consumeEnded(), true);
  assert.equal(dsp.consumeEnded(), false, 'only once');
  assert.equal(dsp.playing, false);
  assert.closeTo(dsp.position, 0.3, 1e-12);
  assert(maxStep(L, 40) <= F220_STEP * 1.2, 'end fade has no click');
  assert.equal(peak(L, 2400), 0, 'silence after the end');
  // seeking back and playing again works
  dsp.seek(0.1);
  dsp.setPlaying(true);
  render(dsp, 200);
  assert.equal(dsp.playing, true);
  assert(dsp.position > 0.1);
});

test('Int16 PCM is scaled by 1/32768', () => {
  const pcm = new Int16Array(400);
  const vals = [16384, -16384, 32767, -32768, 1, 0, -1, 8192];
  vals.forEach((v, i) => {
    pcm[100 + i] = v;
  });
  const dsp = new DeckDSP(SR);
  dsp.load([pcm, pcm], SR);
  dsp.setPlaying(true);
  const { L, R } = render(dsp, 120);
  vals.forEach((v, i) => {
    assert.equal(L[100 + i], v / 32768);
    assert.equal(R[100 + i], v / 32768);
  });
});

test('crush: 0 bypasses completely, 1 = 16x hold and 3 bits', () => {
  const src = noise(0.3, 21);
  const plain = new DeckDSP(SR);
  plain.load([src], SR);
  plain.setPlaying(true);
  const ref = render(plain, 1000).L;
  const dsp = new DeckDSP(SR);
  dsp.setCrush(0.5);
  dsp.setCrush(0);
  dsp.load([src], SR);
  dsp.setPlaying(true);
  const out = render(dsp, 1000).L;
  for (let i = 0; i < 1000; i++) if (out[i] !== ref[i]) fail(`crush 0 changed sample ${i}`);

  const c = new DeckDSP(SR);
  c.load([src], SR);
  c.setPlaying(true);
  render(c, 100);
  c.setCrush(1);
  const cr = render(c, 640).L;
  for (let i = 0; i < 640; i++) {
    const q = cr[i] * 4;
    if (Math.abs(q - Math.round(q)) > 1e-6) fail(`3-bit quantised at ${i}: ${cr[i]}`);
    if (i % 16 !== 0 && cr[i] !== cr[i - 1]) fail(`held for 16 samples at ${i}`);
  }
  let changes = 0;
  for (let i = 1; i < 640; i++) if (cr[i] !== cr[i - 1]) changes++;
  assert(changes > 5 && changes <= 40, `changes only at hold boundaries (${changes})`);
});

test('process honours frames, mono output and the unloaded state', () => {
  const dsp = new DeckDSP(SR);
  const l = new Float32Array(128).fill(7);
  const r = new Float32Array(128).fill(7);
  dsp.process(l, r, 128);
  assert.equal(peak(l), 0, 'unloaded: silence');
  dsp.load([noise(0.5, 2)], SR);
  dsp.setPlaying(true);
  l.fill(7);
  r.fill(7);
  dsp.process(l, r, 50);
  assert.equal(l[50], 7);
  assert.equal(r[127], 7);
  assert(l[49] !== 7);
  assert.closeTo(dsp.position, 50 / SR, 1e-12);
  dsp.process(l, null, 128);
  assert.closeTo(dsp.position, 178 / SR, 1e-12);
  dsp.process(l, r, 0);
  assert.closeTo(dsp.position, 178 / SR, 1e-12);
  dsp.unload();
  assert.equal(dsp.loaded, false);
  assert.equal(dsp.duration, 0);
  assert.equal(dsp.position, 0);
  assert.equal(DeckDSP.PLATTER_SECONDS_PER_TURN, 1.8);
});

test('handleMessage drives the same API', () => {
  const dsp = new DeckDSP(SR);
  dsp.handleMessage({ t: 'load', channels: [noise(1, 3)], srcRate: SR });
  dsp.handleMessage({ t: 'rate', v: 1.25 });
  dsp.handleMessage({ t: 'play', on: true });
  render(dsp, 800);
  assert.closeTo(dsp.position, 0.125, 1e-9);
  dsp.handleMessage({ t: 'seek', pos: 0.5, declick: false });
  assert.closeTo(dsp.position, 0.5, 1e-12);
  dsp.handleMessage({ t: 'loop', start: 0.5, end: 0.6 });
  assert.equal(dsp.looping, true);
  dsp.handleMessage({ t: 'loop', off: true });
  assert.equal(dsp.looping, false);
  dsp.handleMessage({ t: 'scratch', phase: 'begin', pos: 0.5 });
  assert.equal(dsp.scratching, true);
  dsp.handleMessage({ t: 'scratch', phase: 'end' });
  assert.equal(dsp.scratching, false);
  dsp.handleMessage({ t: 'brake', ms: 100 });
  dsp.handleMessage({ t: 'play', on: false });
  assert.equal(dsp.playing, false);
  dsp.handleMessage({ t: 'unload' });
  assert.equal(dsp.loaded, false);
});

/** Extract `class DeckDSP { ... }` from the module source (Jint's toString has no source text). */
function extractClass(text) {
  const start = text.indexOf('class DeckDSP');
  assert(start >= 0, 'class found');
  let depth = 0;
  let i = text.indexOf('{', start);
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i) + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      i++;
      while (i < text.length && text[i] !== q) {
        if (text[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced class body');
}

test('DeckDSP source is self-contained (worklet builds it from toString)', async () => {
  let src = DeckDSP.toString();
  if (src.includes('[native code]')) {
    const res = await fetch(new URL('../src/audio/deck-dsp.js', import.meta.url));
    src = extractClass(await res.text());
  }
  assert(!/\bimport\b|\bexport\b/.test(src.replace(/\/\/.*$/gm, '')), 'no import/export inside the class');
  const Iso = new Function(`${src}\nreturn DeckDSP;`)();
  assert.equal(Iso.PLATTER_SECONDS_PER_TURN, 1.8);
  // exercise every feature in the isolated copy and compare with the module copy
  const run = (C) => {
    const d = new C(SR);
    d.load([noise(1, 8), noise(1, 9)], SR);
    d.setBrake(0);
    d.setRate(1.1);
    d.setBend(0.02);
    d.setPlaying(true);
    const a = render(d, 600).L;
    d.seek(0.4);
    d.setLoop(0.4, 0.5);
    d.setCrush(0.3);
    const b = render(d, 1200).L;
    d.setCrush(0);
    d.clearLoop();
    d.scratchBegin(0.45);
    d.scratchMove(0.5, 1);
    const c = render(d, 300).L;
    d.scratchEnd();
    d.setBrake(50);
    d.setPlaying(false);
    const e = render(d, 800).L;
    d.consumeEnded();
    d.handleMessage({ t: 'unload' });
    return [...a, ...b, ...c, ...e];
  };
  const x = run(Iso);
  const y = run(DeckDSP);
  assert.equal(x.length, y.length);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) fail(`isolated copy differs at ${i}`);
});

// ------------------------------------------------------------------------------------------------- worklet

function installWorkletScope(sr) {
  const registered = {};
  const scope = { frame: 0, registered };
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = { onmessage: null, posted: [], peer: null, postMessage(m) { this.posted.push(structuredClone(m)); if (this.peer) this.peer(structuredClone(m)); } };
    }
  };
  globalThis.registerProcessor = (name, cls) => {
    if (registered[name]) throw new Error('NotSupportedError: already registered');
    registered[name] = cls;
  };
  globalThis.sampleRate = sr;
  Object.defineProperty(globalThis, 'currentFrame', { configurable: true, get: () => scope.frame });
  return scope;
}

test('worklet processor: protocol, reports, ended, dispose', () => {
  const scope = installWorkletScope(SR);
  processorMain(DeckDSP);
  processorMain(DeckDSP); // second registration is swallowed
  const Proc = scope.registered['twinspin-deck'];
  assert(typeof Proc === 'function', 'registered');
  const p = new Proc();
  const send = (m) => p.port.onmessage({ data: m });
  const L = new Float32Array(128);
  const R = new Float32Array(128);
  const step = () => {
    const alive = p.process([], [[L, R]], {});
    scope.frame += 128;
    return alive;
  };
  send({ t: 'load', channels: [sine(220, 0.5)], srcRate: SR, seq: 1 });
  const loaded = p.port.posted.find((m) => m.t === 'loaded');
  assert(loaded && Math.abs(loaded.duration - 0.5) < 1e-12 && loaded.seq === 1);
  send({ t: 'play', on: true, seq: 2 });
  step();
  const first = p.port.posted.filter((m) => m.t === 'pos');
  assert.equal(first.length, 1, 'reports right after a seq command');
  assert.equal(first[0].seq, 2);
  assert.equal(first[0].frame, 128);
  assert.equal(first[0].playing, true);
  for (let i = 0; i < 8; i++) step();
  const reports = p.port.posted.filter((m) => m.t === 'pos');
  assert.equal(reports.length, 3, 'then every 4 quanta');
  const last = reports[reports.length - 1];
  assert.closeTo(last.pos, (9 * 128) / SR, 1e-9);
  assert.equal(last.frame, 9 * 128);
  assert(R[5] !== 0, 'stereo output written');
  let n = 0;
  while (!p.port.posted.some((m) => m.t === 'ended') && n++ < 100) step();
  const ended = p.port.posted.find((m) => m.t === 'ended');
  assert(ended && ended.seq === 2, 'ended reported with the current seq');
  send({ t: 'dispose' });
  assert.equal(step(), false, 'process returns false after dispose');
});

// ------------------------------------------------------------------------------------------------- player

function fakeCtx(sr) {
  const ctx = {
    sampleRate: sr,
    currentTime: 0,
    baseLatency: 0,
    outputLatency: 0,
    state: 'running',
    destination: { connect() {}, disconnect() {} },
    processors: [],
    createGain() {
      return { gain: { value: 1 }, connect() {}, disconnect() {} };
    },
    createScriptProcessor(size) {
      const node = { bufferSize: size, onaudioprocess: null, connect() {}, disconnect() {} };
      ctx.processors.push(node);
      return node;
    },
  };
  return ctx;
}

test('player (ScriptProcessor): optimistic transport and smooth positions', async () => {
  const ctx = fakeCtx(SR);
  const player = await DeckPlayer.create(ctx, { worklet: false });
  assert.equal(player.usingWorklet, false);
  assert.equal(player.mode, 'script');
  const sp = ctx.processors[0];
  const size = sp.bufferSize;
  const bufs = [new Float32Array(size), new Float32Array(size)];
  const tick = () => {
    sp.onaudioprocess({
      outputBuffer: { numberOfChannels: 2, getChannelData: (c) => bufs[c] },
      playbackTime: ctx.currentTime + size / SR,
    });
    ctx.currentTime += size / SR;
  };
  let loadedDur = 0;
  player.on('loaded', (d) => {
    loadedDur = d;
  });
  player.load([sine(220, 3)], SR);
  assert.equal(player.loaded, true);
  assert.closeTo(player.duration, 3, 1e-12);
  await Promise.resolve();
  assert.closeTo(loadedDur, 3, 1e-12);
  tick();
  tick();
  assert.equal(player.getPosition(), 0);
  player.play();
  assert.equal(player.playing, true);
  let prev = player.getPosition();
  for (let i = 0; i < 6; i++) {
    tick();
    const p = player.getPosition();
    assert(p >= prev - 1e-9, `monotonic while playing (${p} < ${prev})`);
    prev = p;
  }
  assert(prev > 0.5 && prev < 1.6, `advancing: ${prev}`);
  player.seek(2);
  const s = player.getPosition();
  assert(s <= 2 && s > 1.7, `optimistic seek: ${s}`);
  tick();
  tick();
  assert(player.getPosition() >= s, 'continues from the seek');
  player.pause();
  assert.equal(player.playing, false);
  const atPause = player.getPosition();
  let last = atPause;
  for (let i = 0; i < 4; i++) {
    tick();
    const p = player.getPosition();
    assert(p >= last - 1e-9, 'never jumps back after pause');
    last = p;
  }
  tick();
  const rest = player.getPosition();
  tick();
  assert.equal(player.getPosition(), rest, 'stopped');
  // ended event
  let ended = 0;
  player.on('ended', () => ended++);
  player.seek(2.9);
  player.play();
  for (let i = 0; i < 10; i++) tick();
  assert.equal(ended, 1, 'ended once');
  assert.equal(player.playing, false);
  player.dispose();
  assert.equal(sp.onaudioprocess, null);
});

test('player (worklet): messages, transfer, seq filtering, end-to-end with the processor', async () => {
  const ctx = fakeCtx(SR);
  const scope = installWorkletScope(SR);
  processorMain(DeckDSP);
  const proc = new scope.registered['twinspin-deck']();
  const sent = [];
  const node = {
    port: {
      onmessage: null,
      postMessage(m, transfer) {
        sent.push({ m, transfer });
        proc.port.onmessage({ data: m });
      },
    },
    connect() {},
    disconnect() {},
  };
  proc.port.peer = (m) => node.port.onmessage && node.port.onmessage({ data: m });
  const player = new DeckPlayer(ctx, { node, mode: 'blob' });
  assert.equal(player.usingWorklet, true);
  const L = new Float32Array(128);
  const R = new Float32Array(128);
  const quantum = () => {
    proc.process([], [[L, R]], {});
    scope.frame += 128;
    ctx.currentTime = scope.frame / SR;
  };
  let loaded = 0;
  player.on('loaded', () => loaded++);
  const ch = new Int16Array(SR * 2);
  const ch2 = new Int16Array(SR * 2);
  player.load([ch, ch2], SR);
  assert.equal(sent[0].m.t, 'load');
  assert.equal(sent[0].transfer.length, 2, 'both buffers transferred');
  assert.equal(loaded, 1);
  player.play();
  // a 'loaded' that arrives after later commands still counts (it carries the load's seq)
  node.port.onmessage({ data: { t: 'loaded', duration: 2, seq: 1 } });
  assert.equal(loaded, 2);
  node.port.onmessage({ data: { t: 'loaded', duration: 2, seq: 0 } });
  assert.equal(loaded, 2, 'a previous track does not count');
  for (let i = 0; i < 20; i++) quantum();
  const pos = player.getPosition();
  assert.closeTo(pos, ctx.currentTime, 0.02);
  // a stale report (older seq) is ignored
  player.seek(1);
  assert.closeTo(player.getPosition(), 1, 1e-9, 'optimistic: right after seek it returns the new position');
  node.port.onmessage({ data: { t: 'pos', pos: 0.1, vel: 1, playing: true, frame: scope.frame, seq: 0 } });
  assert.closeTo(player.getPosition(), 1, 1e-9, 'stale report ignored');
  for (let i = 0; i < 8; i++) quantum();
  assert.closeTo(player.getPosition(), 1 + (8 * 128) / SR, 0.02);
  // stale 'ended' is ignored, current one is delivered
  let ended = 0;
  player.on('ended', () => ended++);
  node.port.onmessage({ data: { t: 'ended', seq: 1 } });
  assert.equal(ended, 0);
  player.seek(1.95);
  for (let i = 0; i < 20; i++) quantum();
  assert.equal(ended, 1);
  assert.equal(player.playing, false);
  // scratch messages carry the reference position
  player.seek(1);
  player.scratchBegin();
  player.scratchMove(1.05, 0.5);
  player.scratchEnd();
  const kinds = sent.slice(-3).map((s) => s.m.phase);
  assert.deepEqual(kinds, ['begin', 'move', 'end']);
  assert.closeTo(sent[sent.length - 3].m.pos, 1, 1e-9);
  player.setLoop(1, 1.5);
  assert.deepEqual(sent[sent.length - 1].m, { t: 'loop', start: 1, end: 1.5 });
  player.clearLoop();
  assert.equal(sent[sent.length - 1].m.off, true);
  player.setCrush(2);
  assert.equal(sent[sent.length - 1].m.v, 1);
  player.dispose();
  assert.equal(node.port.onmessage, null);
});

// ------------------------------------------------------------------------------------------------- scheduling
// Scheduled start / jump and tempo ramps (Auto Mix): sample-exact on the DSP's output-frame clock.

/** Render `frames` samples in blocks of `block`, passing the absolute start frame like the worklet does. */
function renderClock(dsp, frames, startFrame, block = 128) {
  const L = new Float32Array(frames);
  const l = new Float32Array(block);
  const r = new Float32Array(block);
  let i = 0;
  while (i < frames) {
    const n = Math.min(block, frames - i);
    dsp.process(l, r, n, startFrame + i);
    for (let k = 0; k < n; k++) L[i + k] = l[k];
    i += n;
  }
  return L;
}

test('setPlayingAt starts on the exact frame, inside a block', () => {
  const src = noise(1, 31);
  const dsp = new DeckDSP(SR);
  dsp.load([src], SR);
  dsp.seek(0.25);
  const base = 1000; // the output clock does not start at 0
  renderClock(dsp, 256, base);
  assert.equal(dsp.frame, base + 256);
  const at = base + 256 + 77; // in the middle of the next block
  dsp.setPlayingAt(at);
  assert.equal(dsp.playing, false, 'not before its frame');
  assert.equal(dsp.pendingStartFrame, at);
  const out = renderClock(dsp, 1024, base + 256);
  for (let k = 0; k < 77; k++) if (out[k] !== 0) fail(`silent before the start, sample ${k}`);
  assert(out[77] !== 0, 'sound on the start frame (fade-in begins)');
  assert.equal(dsp.playing, true);
  assert.equal(dsp.pendingStartFrame, -1);
  // the head moved exactly from the start frame: 1024 - 77 frames at rate 1
  assert.closeTo(dsp.position, 0.25 + (1024 - 77) / SR, 1e-12);
  // after the 3 ms fade the output is the source, sample-aligned with the start frame
  for (let k = 77 + 30; k < 1024; k++) {
    if (out[k] !== src[2000 + k - 77]) fail(`sample ${k}: aligned to the start frame`);
  }
});

test('setPlayingAt: late frames land on the timeline, pause / seek cancel, playing deck ignores it', () => {
  const dsp = new DeckDSP(SR);
  dsp.load([noise(2, 32)], SR);
  renderClock(dsp, 512, 0);
  dsp.setPlayingAt(512 - 200); // 200 frames late: starts now, as if it had started on time
  assert.equal(dsp.playing, true);
  assert.closeTo(dsp.position, 200 / SR, 1e-12);
  renderClock(dsp, 128, 512);
  assert.closeTo(dsp.position, 328 / SR, 1e-12);
  // far too late (> 0.5 s): starts now without the jump
  const d2 = new DeckDSP(SR);
  d2.load([noise(2, 33)], SR);
  renderClock(d2, 8192, 0);
  d2.setPlayingAt(10);
  assert.equal(d2.position, 0);
  // pause cancels a pending start
  const d3 = new DeckDSP(SR);
  d3.load([noise(2, 34)], SR);
  d3.setPlayingAt(300);
  d3.setPlaying(false);
  renderClock(d3, 640, 0);
  assert.equal(d3.playing, false, 'pause cancelled the start');
  assert.equal(d3.position, 0);
  // an immediate seek cancels it too; a scheduled seek does not
  d3.setPlayingAt(1000);
  d3.seek(0.5);
  renderClock(d3, 640, 640);
  assert.equal(d3.playing, false, 'seek cancelled the start');
  d3.setPlayingAt(1400);
  d3.seekAt(0.9, 1300);
  renderClock(d3, 512, 1280);
  assert.equal(d3.playing, true, 'seekAt kept the start');
  assert.closeTo(d3.position, 0.9 + (1792 - 1400) / SR, 1e-12);
  // a running motor ignores it
  d3.setPlayingAt(5000);
  assert.equal(d3.pendingStartFrame, -1);
  // unloaded: nothing
  const d4 = new DeckDSP(SR);
  d4.setPlayingAt(10);
  renderClock(d4, 128, 0);
  assert.equal(d4.playing, false);
});

test('seekAt jumps on the exact frame (declicked) and late jumps land on the timeline', () => {
  const src = sine(220, 3);
  const dsp = new DeckDSP(SR);
  dsp.load([src], SR);
  dsp.setPlaying(true);
  const a = renderClock(dsp, 1000, 0);
  dsp.seekAt(2.0123, 1000 + 333);
  assert.equal(dsp.pendingSeekFrame, 1333);
  const b = renderClock(dsp, 1000, 1000);
  assert.equal(dsp.pendingSeekFrame, -1);
  assert.closeTo(dsp.position, 2.0123 + (2000 - 1333) / SR, 1e-9, 'jumped on frame 1333');
  const both = new Float32Array(2000);
  both.set(a, 0);
  both.set(b, 1000);
  assert(maxStep(both, 40) <= F220_STEP * 1.1, 'declicked');
  // after the ghost crossfade the output is the source from the target, in phase
  for (let k = 333 + DeckDSP.XFADE_FRAMES + 2; k < 1000; k++) {
    const x = (2.0123 * SR) + (k - 333);
    const want = 0.8 * Math.sin((2 * Math.PI * 220 * x) / SR);
    if (Math.abs(b[k] - want) > 2e-3) fail(`sample ${k}: ${b[k]} vs ${want}`);
  }
  // late: jumps now to where the head would be by now
  dsp.seekAt(0.5, 2000 - 100);
  assert.closeTo(dsp.position, 0.5 + 100 / SR, 1e-9);
  // a newer seekAt replaces a pending one; an immediate seek, a pause or a scratch cancels it
  dsp.seekAt(1, 2500);
  dsp.seekAt(1.5, 2600);
  renderClock(dsp, 1000, 2000);
  assert.closeTo(dsp.position, 1.5 + (3000 - 2600) / SR, 1e-9);
  dsp.seekAt(0.1, 3500);
  dsp.seek(2.5);
  renderClock(dsp, 1000, 3000);
  assert.closeTo(dsp.position, 2.5 + 1000 / SR, 1e-9, 'immediate seek cancelled it');
  dsp.seekAt(0.1, 4500);
  dsp.scratchBegin();
  assert.equal(dsp.pendingSeekFrame, -1, 'scratch cancels it');
  dsp.scratchEnd();
  dsp.seekAt(0.1, 4500);
  dsp.setPlaying(false);
  assert.equal(dsp.pendingSeekFrame, -1, 'pause cancels it');
});

test('cued start: seekAt + setPlayingAt on the same frame start exactly at the target', () => {
  const src = noise(3, 35);
  for (const order of ['seek-first', 'play-first']) {
    const dsp = new DeckDSP(SR);
    dsp.load([src], SR);
    dsp.seek(0.1);
    renderClock(dsp, 256, 0);
    if (order === 'seek-first') {
      dsp.seekAt(1.5, 400);
      dsp.setPlayingAt(400);
    } else {
      dsp.setPlayingAt(400);
      dsp.seekAt(1.5, 400);
    }
    const out = renderClock(dsp, 1024, 256);
    const s0 = 400 - 256;
    for (let k = 0; k < s0; k++) if (out[k] !== 0) fail(`${order}: silent before the start`);
    for (let k = s0 + 30; k < 1024; k++) {
      if (out[k] !== src[Math.round(1.5 * SR) + k - s0]) fail(`${order}: sample ${k} plays the target`);
    }
    assert.closeTo(dsp.position, 1.5 + (1024 - s0) / SR, 1e-12);
  }
  // both late by 100 frames: still on the planned timeline
  const dsp = new DeckDSP(SR);
  dsp.load([src], SR);
  renderClock(dsp, 512, 0);
  dsp.seekAt(1.5, 412);
  dsp.setPlayingAt(412);
  assert.closeTo(dsp.position, 1.5 + 100 / SR, 1e-12);
});

test('setRate ramp: linear per sample, exact duration, position is the integral', () => {
  const dsp = new DeckDSP(SR);
  dsp.load([noise(4, 36)], SR);
  dsp.setPlaying(true);
  renderClock(dsp, 800, 0);
  const p0 = dsp.position;
  dsp.setRate(1.5, 0.5); // 4000 samples
  assert.equal(dsp.ramping, true);
  renderClock(dsp, 2000, 800);
  assert.closeTo(dsp.rate, 1.25, 1e-9, 'half way after half the samples');
  assert.closeTo(dsp.velocity, dsp.rate, 1e-12, 'the motor follows the ramp exactly');
  renderClock(dsp, 2000, 2800);
  assert.equal(dsp.rate, 1.5, 'ends exactly on the target');
  assert.equal(dsp.ramping, false);
  assert.equal(dsp.velocity, 1.5);
  // integral of a linear 1 -> 1.5 ramp over 0.5 s = 0.625 s (+ half a sample of discretisation)
  assert.closeTo(dsp.position - p0, 0.625, 5e-5);
  // a new ramp during a ramp starts from where it is
  dsp.setRate(1, 0.5);
  renderClock(dsp, 1000, 4800);
  assert.closeTo(dsp.rate, 1.375, 1e-9);
  dsp.setRate(1.25, 0.25); // from 1.375 to 1.25 over 2000 samples
  renderClock(dsp, 1000, 5800);
  assert.closeTo(dsp.rate, 1.3125, 1e-9);
  renderClock(dsp, 1000, 6800);
  assert.equal(dsp.rate, 1.25);
  // the bend adds on top of a ramp
  dsp.setBend(0.1);
  dsp.setRate(1.05, 0.5);
  renderClock(dsp, 2000, 7800);
  assert.closeTo(dsp.velocity, dsp.rate + 0.1, 1e-9);
  // an immediate rate ends a ramp
  dsp.setRate(1);
  assert.equal(dsp.ramping, false);
  assert.equal(dsp.rate, 1);
});

test('setRate ramp: scheduled start frame, late start, paused decks keep ramping', () => {
  const dsp = new DeckDSP(SR);
  dsp.load([noise(2, 37)], SR);
  dsp.setPlaying(true);
  renderClock(dsp, 1000, 0);
  dsp.setRate(2, 0.1, 1500); // 800 samples from frame 1500
  renderClock(dsp, 500, 1000);
  assert.equal(dsp.rate, 1, 'waits for its frame');
  assert(dsp.ramping);
  renderClock(dsp, 400, 1500);
  assert.closeTo(dsp.rate, 1.5, 1e-9);
  renderClock(dsp, 400, 1900);
  assert.equal(dsp.rate, 2);
  // late by 200 samples: starts part way
  dsp.setRate(1, 0.1, 2300 - 200);
  assert.closeTo(dsp.rate, 1.75, 1e-9);
  // paused (idle fast path): the ramp still runs on the clock
  dsp.setPlaying(false);
  renderClock(dsp, 400, 2300);
  assert.closeTo(dsp.rate, 1.25, 1e-9, 'the 2 -> 1 ramp went on through the stop');
  renderClock(dsp, 400, 2700);
  assert.equal(dsp.rate, 1);
  dsp.setRate(1.2, 0.1);
  renderClock(dsp, 400, 3100);
  assert.closeTo(dsp.rate, 1.1, 1e-9, 'idle blocks advance it');
  renderClock(dsp, 800, 3500);
  assert.equal(dsp.rate, 1.2);
  // playing again starts at the ramped rate
  dsp.setPlaying(true);
  renderClock(dsp, 100, 4300);
  assert.equal(dsp.velocity, 1.2);
});

test('handleMessage carries at / ramp; the worklet passes currentFrame', () => {
  const dsp = new DeckDSP(SR);
  dsp.handleMessage({ t: 'load', channels: [noise(1, 38)], srcRate: SR });
  renderClock(dsp, 128, 0);
  dsp.handleMessage({ t: 'seek', pos: 0.5, declick: true, at: 200 });
  dsp.handleMessage({ t: 'play', on: true, at: 200 });
  dsp.handleMessage({ t: 'rate', v: 1.5, ramp: 0.1, at: 200 });
  assert.equal(dsp.pendingSeekFrame, 200);
  assert.equal(dsp.pendingStartFrame, 200);
  renderClock(dsp, 128, 128);
  assert.equal(dsp.playing, true);
  // 56 samples of the ramp: rate 1 + 0.5 * k / 800 on sample k
  let expect = 0.5;
  for (let k = 1; k <= 56; k++) expect += (1 + (0.5 * k) / 800) / SR;
  assert.closeTo(dsp.position, expect, 1e-9);

  const scope = installWorkletScope(SR);
  processorMain(DeckDSP);
  const p = new scope.registered['twinspin-deck']();
  const send = (m) => p.port.onmessage({ data: m });
  const L = new Float32Array(128);
  const R = new Float32Array(128);
  scope.frame = 48000; // a context that has been running for a while
  send({ t: 'load', channels: [new Float32Array(SR).fill(0.5)], srcRate: SR, seq: 1 });
  send({ t: 'play', on: true, at: 48000 + 128 + 50, seq: 2 });
  p.process([], [[L, R]], {});
  scope.frame += 128;
  assert.equal(L[127], 0, 'not yet');
  p.process([], [[L, R]], {});
  scope.frame += 128;
  assert.equal(L[49], 0);
  assert(L[50] > 0, 'starts on frame +50 of the second block');
  for (let b = 0; b < 3; b++) {
    p.process([], [[L, R]], {});
    scope.frame += 128;
  }
  const rep = p.port.posted.filter((m) => m.t === 'pos').pop();
  assert.equal(rep.playing, true);
  assert.equal(rep.frame, scope.frame);
  assert.closeTo(rep.pos, (78 + 3 * 128) / SR, 1e-12);
});

test('isolated DeckDSP copy behaves identically with scheduling and ramps', async () => {
  let src = DeckDSP.toString();
  if (src.includes('[native code]')) {
    const res = await fetch(new URL('../src/audio/deck-dsp.js', import.meta.url));
    src = extractClass(await res.text());
  }
  const Iso = new Function(`${src}\nreturn DeckDSP;`)();
  const run = (C) => {
    const d = new C(SR);
    d.load([noise(1, 40)], SR);
    const out = [];
    const push = (a) => {
      for (let i = 0; i < a.length; i++) out.push(a[i]);
    };
    d.setPlayingAt(150);
    d.setRate(1.3, 0.05, 200);
    push(renderClock(d, 500, 0, 100));
    d.seekAt(0.2, 700);
    d.setRate(0.9, 0.02);
    push(renderClock(d, 500, 500, 64));
    d.setPlaying(false);
    d.setRate(1.1, 0.05);
    push(renderClock(d, 300, 1000));
    return out;
  };
  const x = run(Iso);
  const y = run(DeckDSP);
  assert.equal(x.length, y.length);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) fail(`isolated copy differs at ${i}`);
});

test('overdue scheduled events (the clock jumped past them) still land on their timeline', () => {
  const dsp = new DeckDSP(SR);
  dsp.load([noise(3, 41)], SR);
  dsp.seek(1);
  renderClock(dsp, 256, 0);
  dsp.setPlayingAt(400);
  dsp.process(new Float32Array(128), null, 128, 600); // the next block starts 200 frames after the start
  assert.equal(dsp.playing, true);
  assert.closeTo(dsp.position, 1 + (200 + 128) / SR, 1e-12);
  dsp.seekAt(2, 900);
  dsp.process(new Float32Array(128), null, 128, 1000);
  assert.closeTo(dsp.position, 2 + (100 + 128) / SR, 1e-12);
});
