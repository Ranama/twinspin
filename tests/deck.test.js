// Tests for the Deck controller (src/deck/deck.js) and its pure helpers (src/deck/deck-math.js), with a stub
// engine / player / mixer channel and an injected decoder and analyzer. Positions run on the virtual clock.
import { Emitter } from '../src/core/emitter.js';
import { Deck } from '../src/deck/deck.js';
import { SyncController } from '../src/deck/sync.js';
import {
  fitTaps, loopBounds, beatPhase, rangeForRate, normalizeRange, gridStart, doubleBeatMap, halveBeatMap, rateAt, travelDistance,
  travelTime,
} from '../src/deck/deck-math.js';

const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SR = 2000; // tiny PCM: the fake player only needs lengths

// JsCheck has no AbortController; the deck uses it when present to cancel a stale analysis.
if (typeof globalThis.AbortController !== 'function') {
  globalThis.AbortController = class {
    constructor() {
      this.signal = { aborted: false };
    }
    abort() {
      this.signal.aborted = true;
    }
  };
}

// ---- fakes --------------------------------------------------------------------------------------------------

class FakePlayer extends Emitter {
  constructor() {
    super();
    this.calls = [];
    this.loaded = false;
    this.duration = 0;
    this.playing = false;
    this.rate = 1;
    this.bendV = 0;
    this.brakeMs = 0;
    this.crush = 0;
    this.loopR = null;
    this.scr = false;
    this._pos = 0;
    this._t = now();
  }
  _adv() {
    const t = now();
    if (this.playing && !this.scr) {
      this._pos += ((this.rate + this.bendV) * (t - this._t)) / 1000;
      if (this.loopR && this._pos >= this.loopR.e) this._pos = this.loopR.s + ((this._pos - this.loopR.s) % (this.loopR.e - this.loopR.s));
      if (this._pos >= this.duration) {
        this._pos = this.duration;
        this.playing = false;
        queueMicrotask(() => this.emit('ended'));
      }
    }
    this._t = t;
  }
  log(...a) {
    this.calls.push(a);
  }
  count(name) {
    return this.calls.filter((c) => c[0] === name).length;
  }
  last(name) {
    for (let i = this.calls.length - 1; i >= 0; i--) if (this.calls[i][0] === name) return this.calls[i];
    return null;
  }
  load(ch, sr) {
    this.log('load', ch.length, sr, ch[0].length);
    this.channels = ch;
    this.loaded = true;
    this.duration = ch[0].length / sr;
    this._pos = 0;
    this._t = now();
    this.playing = false;
    this.loopR = null;
  }
  unload() {
    this.log('unload');
    this.loaded = false;
    this.playing = false;
    this.duration = 0;
    this._pos = 0;
  }
  play() {
    this._adv();
    this.playing = true;
    this.log('play');
  }
  pause() {
    this._adv();
    this.playing = false;
    this.log('pause', this.brakeMs);
  }
  setRate(r) {
    this._adv();
    this.rate = r;
    this.log('rate', r);
  }
  setBend(b) {
    this._adv();
    this.bendV = b;
    this.log('bend', b);
  }
  setBrake(ms) {
    this.brakeMs = ms;
    this.log('brake', ms);
  }
  seek(p, declick) {
    this._adv();
    this._pos = p;
    this.log('seek', p, declick);
  }
  scratchBegin() {
    this._adv();
    this.scr = true;
    this.log('scratchBegin', this._pos);
  }
  scratchMove(sec, vel) {
    this._pos = sec;
    this.log('scratchMove', sec, vel);
  }
  scratchEnd() {
    this._t = now();
    this.scr = false;
    this.log('scratchEnd');
  }
  setLoop(s, e) {
    this.loopR = { s, e };
    this.log('loop', s, e);
  }
  clearLoop() {
    this.loopR = null;
    this.log('clearLoop');
  }
  setCrush(v) {
    this.crush = v;
    this.log('crush', v);
  }
  getPosition() {
    this._adv();
    return this.loaded ? this._pos : 0;
  }
}

class FakeFx {
  constructor() {
    this.on = {};
    this.amount = null;
    this.beat = null;
    this.echoOuts = [];
  }
  set(n, v) {
    this.on[n] = v;
  }
  setAmount(a) {
    this.amount = a;
  }
  setBeatSeconds(s) {
    this.beat = s;
  }
  echoOut(beat) {
    this.echoOuts.push(beat);
    return 4 * beat;
  }
}

class FakeChannel {
  constructor() {
    this.state = { xfade: 1 };
    this.fx = new FakeFx();
    this.eq = {};
    this.trimDb = null;
    this.volume = null;
    this.filter = null;
    this.cue = null;
  }
  setTrimDb(db) {
    this.trimDb = db;
  }
  setEq(b, v, opts) {
    this.eq[b] = v;
    this.eqOpts = opts || null;
  }
  setFilter(v) {
    this.filter = v;
  }
  setVolume(v) {
    this.volume = v;
  }
  setCue(on) {
    this.cue = on;
  }
}

class FakeEngine extends Emitter {
  constructor() {
    super();
    this.ready = false;
    this.ctx = null;
    this.state = 'idle';
    this._players = [];
    this.mixer = null;
  }
  get players() {
    return this.ready ? this._players : [];
  }
  _build() {
    this.ctx = { sampleRate: SR };
    this._players = [new FakePlayer(), new FakePlayer()];
    this.mixer = { channels: [new FakeChannel(), new FakeChannel()] };
    this.ready = true;
    this.state = 'running';
  }
  start() {
    this._build();
    this.emit('ready');
  }
  restart() {
    this._build();
    this.emit('restarted');
  }
}

function fakeBuffer(seconds, sr = SR) {
  const n = Math.round(seconds * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i += 97) {
    L[i] = 0.5;
    R[i] = -0.5;
  }
  return { sampleRate: sr, length: n, numberOfChannels: 2, duration: n / sr, getChannelData: (c) => (c ? R : L) };
}

/** A song "file" for the stub decoder. */
function song(name, seconds = 60, extra = {}) {
  return { name, size: 1000 + seconds, seconds, ...extra };
}

function makeDeps(opts = {}) {
  const log = { decodes: [], analyses: [], demos: [] };
  const beats = opts.beats || { bpm: 120, firstBeat: 0.25, confidence: 0.9, variable: false, alternatives: [60, 240] };
  const deps = {
    decodeFile: async (blob, engine, name) => {
      log.decodes.push({ blob, name });
      await sleep(opts.decodeMs || 20);
      if (blob.fail) throw new Error("This browser can't play OGG files. Try an MP3 or WAV.");
      return { buffer: fakeBuffer(blob.seconds), meta: { title: blob.title || '', artist: blob.artist || '', fileName: name }, warning: blob.warning || null };
    },
    analyzeTrack: (mono, rate, { onWaveform, signal } = {}) => {
      const job = { mono, rate, signal };
      log.analyses.push(job);
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if (signal && signal.aborted) {
            const e = new Error('cancelled');
            e.name = 'AbortError';
            reject(e);
            return;
          }
          if (onWaveform) onWaveform({ tag: 'wf' });
          setTimeout(() => {
            if (opts.analysisFails) reject(new Error("Couldn't work out this song's tempo. You can still play it and tap the tempo in."));
            else resolve({ beats: { ...beats }, waveform: { tag: 'wf-final' }, loudness: { gainDb: -4, rmsDb: -16, peakDb: -1 } });
          }, 50);
        }, 50);
      });
    },
    createDemoJob: (id, sr) => {
      log.demos.push({ id, sr });
      let steps = 0;
      return {
        step: () => ++steps >= 3,
        result: () => {
          const b = fakeBuffer(30, sr);
          return { channels: [b.getChannelData(0), b.getChannelData(1)], sampleRate: sr };
        },
      };
    },
  };
  return { deps, log };
}

function settingsWith(values = {}) {
  const v = { tempoRange: 0.08, quantize: true, vinyl: true, autoSync: true, ...values };
  return { get: (k) => v[k], set: (k, x) => (v[k] = x), on: () => () => {} };
}

function setup(opts = {}) {
  const engine = new FakeEngine();
  const { deps, log } = makeDeps(opts);
  const settings = settingsWith(opts.settings);
  const deck = new Deck(opts.id || 'A', engine, settings, deps);
  const events = [];
  const errors = [];
  deck.on('change', (w) => events.push(w));
  deck.on('error', (m) => errors.push(m));
  if (opts.start !== false) engine.start();
  const idx = deck.index;
  return {
    engine, deck, log, events, errors, settings,
    get player() {
      return engine.players[idx];
    },
    get channel() {
      return engine.mixer.channels[idx];
    },
  };
}

/** Load a song and wait for the analysis. */
async function loaded(opts = {}) {
  const s = setup(opts);
  await s.deck.loadFile(song('Artist - Tune.mp3', opts.seconds || 60));
  await sleep(200);
  return s;
}

// ---- pure helpers ----------------------------------------------------------------------------------------------

test('deck-math: ranges, taps, loops, phase', () => {
  assert.equal(normalizeRange(0.16), 0.16);
  assert.equal(normalizeRange(0.1), 0.08);
  assert.equal(normalizeRange(0.4), 0.5);
  assert.equal(normalizeRange(NaN), 0.08);
  assert.equal(rangeForRate(1.05, 0.08), 0.08);
  assert.equal(rangeForRate(1.12, 0.08), 0.16);
  assert.equal(rangeForRate(0.7, 0.08), 0.5);
  assert.equal(rangeForRate(1.02, 0.16), 0.16);
  assert.equal(rangeForRate(3, 0.08), 0.5);

  const taps = [0, 1, 2, 3, 4].map((k) => 1.7 + k * 0.48 + (k % 2 ? 0.004 : -0.004));
  const fit = fitTaps(taps);
  assert.closeTo(60 / fit.period, 125, 1.5);
  assert.closeTo(fit.anchor, 1.7, 0.01);
  assert.equal(fitTaps([0, 0.5, 1]), null);
  // a missed tap (double gap) and a bounce do not break it
  const sloppy = fitTaps([0, 0.5, 1.0, 2.0, 2.03, 2.5, 3.0]);
  assert.closeTo(sloppy.period, 0.5, 1e-9);
  assert.equal(sloppy.count, 6);

  assert.closeTo(gridStart(10.3, 0.5), 0.3, 1e-9);
  assert.closeTo(gridStart(-0.2, 0.5), 0.3, 1e-9);

  // quantised loop on the nearest beat (beats at 0.25 + k * 0.5)
  let b = loopBounds(10.3, 4, 120, 0.25, 200, true);
  assert.closeTo(b.start, 10.25, 1e-9);
  assert.closeTo(b.end, 12.25, 1e-9);
  b = loopBounds(10.6, 1, 120, 0.25, 200, true);
  assert.closeTo(b.start, 10.75, 1e-9);
  b = loopBounds(10.3, 4, 120, 0.25, 200, false);
  assert.closeTo(b.start, 10.3, 1e-9);
  // near the end it moves back by whole beats
  b = loopBounds(199.1, 4, 120, 0.25, 200, true);
  assert(b.end <= 200 + 1e-9);
  assert.closeTo(((b.start - 0.25) / 0.5) % 1, 0, 1e-9);
  assert.equal(loopBounds(1, 8, 120, 0, 3, true), null);

  assert.closeTo(beatPhase(10.3, 120, 0.1), 0.4, 1e-9);
  assert.equal(beatPhase(10.3, null, 0.1), null);
  assert.closeTo(beatPhase(0, 120, 0.1), 0.8, 1e-9);
});

// ---- engine attachment and loading ------------------------------------------------------------------------------

test('attaches on engine ready and pushes its mixer/FX state into the channel', () => {
  const s = setup({ start: false });
  assert.equal(s.deck.ready, false);
  assert.equal(s.deck.id, 'A');
  assert.equal(s.deck.index, 0);
  s.engine.start();
  assert.equal(s.deck.ready, true);
  const ch = s.channel;
  assert.equal(ch.volume, 0.8);
  assert.deepEqual(ch.eq, { low: 0, mid: 0, high: 0 });
  assert.equal(ch.trimDb, 0);
  assert.equal(ch.filter, 0);
  assert.equal(ch.cue, false);
  assert.equal(ch.fx.amount, 0.5);
  assert.deepEqual(ch.fx.on, { echo: false, reverb: false, flanger: false });
  assert.closeTo(ch.fx.beat, 0.5, 1e-12); // 120 BPM default until a song is known
  assert.equal(s.player.rate, 1);
  const b = new Deck('B', s.engine, settingsWith(), makeDeps().deps);
  assert.equal(b.index, 1);
  assert.equal(b.ready, true, 'a deck made after the engine started attaches at once');
});

test('loading before audio was started fails with a plain message', async () => {
  const s = setup({ start: false });
  await assert.rejects(s.deck.loadFile(song('x.mp3')), /Tap Start first/);
  assert.match(s.errors[0], /Tap Start first so TwinSpin can play sound/);
  assert.equal(s.deck.loading, false);
  assert.equal(s.deck.track, null);
});

test('a load waits for an engine that is still starting', async () => {
  const s = setup({ start: false });
  s.engine.state = 'starting';
  s.engine.ctx = { sampleRate: SR };
  const p = s.deck.loadFile(song('x.mp3', 20));
  await sleep(50);
  assert.equal(s.deck.loading, true);
  s.engine.start();
  await p;
  assert(s.deck.track);
  assert.closeTo(s.deck.duration, 20, 1e-9);
});

test('load flow: playable before analysis, then BPM, trim from loudness and cue on the first beat', async () => {
  const s = setup();
  let analyzed = 0;
  s.deck.on('analyzed', () => analyzed++);
  s.events.length = 0;
  const p = s.deck.loadFile(song('Artist - Tune.mp3', 60, { title: 'Tune', artist: 'Artist' }));
  assert.equal(s.deck.loading, true);
  assert.equal(s.events[0], 'loading');
  await p;
  const t = s.deck.track;
  assert(t, 'track set');
  assert.equal(s.deck.loading, false);
  assert.equal(s.deck.analyzing, true);
  assert.equal(t.title, 'Tune');
  assert.equal(t.artist, 'Artist');
  assert.equal(t.fileName, 'Artist - Tune.mp3');
  assert.equal(t.source, 'file');
  assert.equal(t.sampleRate, SR);
  assert.closeTo(t.duration, 60, 1e-9);
  assert.equal(t.bpm, null);
  assert(Number.isFinite(t.hue));
  assert.equal(s.deck.bpm, null);
  assert.equal(s.player.count('load'), 1);
  assert.equal(s.player.last('load')[1], 2, 'stereo Int16 PCM');
  assert(s.player.channels[0] instanceof Int16Array);
  // decimated mono went to the analysis: D = round(2000 / 11025) -> 1
  assert.equal(s.log.analyses.length, 1);
  assert.equal(s.log.analyses[0].rate, SR);
  assert.equal(s.log.analyses[0].mono.length, 60 * SR);
  // playable now
  s.deck.play();
  assert.equal(s.deck.playing, true);
  s.deck.pause();
  s.deck.seek(0);
  await sleep(60);
  assert.equal(t.waveform.tag, 'wf', 'waveform arrives first');
  assert.equal(t.bpm, null);
  await sleep(100);
  assert.equal(s.deck.analyzing, false);
  assert.equal(t.bpm, 120);
  assert.equal(t.bpmDetected, 120);
  assert.equal(t.firstBeat, 0.25);
  assert.equal(t.confidence, 0.9);
  assert.deepEqual(t.alternatives, [60, 240]);
  assert.equal(t.waveform.tag, 'wf-final');
  assert.equal(t.gainDb, -4);
  assert.equal(s.deck.mix.trimDb, -4);
  assert.equal(s.channel.trimDb, -4);
  assert.equal(s.deck.cuePoint, 0.25);
  assert.closeTo(s.deck.position, 0.25, 1e-9, 'a paused, untouched deck parks on the first beat');
  assert.equal(s.deck.bpm, 120);
  assert.equal(s.deck.effectiveBpm, 120);
  assert.equal(s.deck.beatLength, 0.5);
  assert.equal(analyzed, 1);
  for (const w of ['loading', 'track', 'analysis', 'bpm', 'cue', 'mix']) assert(s.events.includes(w), `emitted ${w}`);
});

test('meta from the library overrides the tags; a warning is passed on', async () => {
  const s = setup();
  await s.deck.loadFile(song('blob', 10, { warning: 'This song is 20 minutes long.' }),
    { title: 'Lib Title', artist: 'Lib Artist', fileName: 'lib.mp3', libraryId: 's123' });
  const t = s.deck.track;
  assert.equal(t.title, 'Lib Title');
  assert.equal(t.artist, 'Lib Artist');
  assert.equal(t.fileName, 'lib.mp3');
  assert.equal(t.libraryId, 's123');
  assert.equal(s.log.decodes[0].name, 'lib.mp3');
  assert.deepEqual(s.errors, ['This song is 20 minutes long.']);
});

test('a newer load wins; the older one resolves quietly and its analysis is dropped', async () => {
  const s = setup();
  const p1 = s.deck.loadFile(song('one.mp3', 30));
  const p2 = s.deck.loadFile(song('two.mp3', 40));
  await p1;
  await p2;
  assert.equal(s.deck.track.fileName, 'two.mp3');
  assert.equal(s.player.count('load'), 1);
  // a third load while the second is analysing cancels that analysis
  const p3 = s.deck.loadFile(song('three.mp3', 50));
  assert.equal(s.log.analyses[0].signal.aborted, true);
  await p3;
  await sleep(200);
  assert.equal(s.deck.track.fileName, 'three.mp3');
  assert.equal(s.deck.bpm, 120);
  assert.deepEqual(s.errors, []);
});

test('a file that cannot be decoded: error event, rejected promise, empty deck', async () => {
  const s = setup();
  await assert.rejects(s.deck.loadFile(song('x.ogg', 10, { fail: true })), /can't play OGG/);
  assert.deepEqual(s.errors, ["This browser can't play OGG files. Try an MP3 or WAV."]);
  assert.equal(s.deck.loading, false);
  assert.equal(s.deck.track, null);
  await assert.rejects(s.deck.loadFile(null), /No song file/);
});

test('analysis failure keeps the song playable and says how to set the tempo', async () => {
  const s = setup({ analysisFails: true });
  await s.deck.loadFile(song('a.mp3', 20));
  await sleep(200);
  assert(s.deck.track);
  assert.equal(s.deck.analyzing, false);
  assert.equal(s.deck.bpm, null);
  assert.match(s.errors[0], /tap the tempo in/);
});

test('demo tracks: synthesised at the context rate, exact BPM and grid', async () => {
  const s = setup({ beats: { bpm: 123.9, firstBeat: 0.01, confidence: 0.8 } });
  await s.deck.loadDemo(0);
  assert.equal(s.log.demos[0].id, 0);
  assert.equal(s.log.demos[0].sr, SR);
  const t = s.deck.track;
  assert.equal(t.title, 'Neon Drift');
  assert.equal(t.artist, 'TwinSpin demo');
  assert.equal(t.source, 'demo');
  assert.equal(t.demoId, 0);
  await sleep(200);
  assert.equal(t.bpm, 124);
  assert.equal(t.firstBeat, 0);
  assert.equal(t.variable, false);
  assert.equal(s.deck.cuePoint, 0);
  await assert.rejects(s.deck.loadDemo(7), /does not exist/);
});

test('eject stops and empties the deck', async () => {
  const s = await loaded();
  s.deck.play();
  s.deck.eject();
  assert.equal(s.deck.track, null);
  assert.equal(s.deck.playing, false);
  assert.equal(s.deck.duration, 0);
  assert.equal(s.deck.position, 0);
  assert(s.player.count('unload') >= 1);
  assert(s.events.includes('track'));
});

// ---- transport and cue -------------------------------------------------------------------------------------------

test('CDJ cue: preview while held, jump back on release, PLAY while holding keeps playing', async () => {
  const s = await loaded();
  const d = s.deck;
  assert.equal(d.cuePoint, 0.25);
  d.cueDown(); // paused at the cue: preview
  assert.equal(d.playing, true);
  await sleep(1000);
  assert.closeTo(d.position, 1.25, 0.02);
  d.cueUp();
  assert.equal(d.playing, false);
  assert.closeTo(d.position, 0.25, 1e-9);
  d.cueDown();
  d.play();
  d.cueUp();
  assert.equal(d.playing, true, 'latched by PLAY');
  await sleep(500);
  d.cueDown(); // playing: back to the cue and pause
  assert.equal(d.playing, false);
  assert.closeTo(d.position, 0.25, 1e-9);
  d.cueUp();
  // paused elsewhere: CUE sets the cue there, snapped to the grid (quantize)
  d.seek(10.37);
  d.cueDown();
  d.cueUp();
  assert.closeTo(d.cuePoint, 10.25, 1e-9);
  assert.closeTo(d.position, 10.25, 1e-9);
  assert.equal(d.playing, false);
  // quantize off: exact
  s.settings.set('quantize', false);
  d.seek(20.37);
  d.cueDown();
  d.cueUp();
  assert.closeTo(d.cuePoint, 20.37, 1e-9);
  // togglePlay
  d.togglePlay();
  assert.equal(d.playing, true);
  d.togglePlay();
  assert.equal(d.playing, false);
});

test('end of the song: ended event, then PLAY starts again from the cue point', async () => {
  const s = await loaded({ seconds: 4 });
  let ended = 0;
  s.deck.on('ended', () => ended++);
  s.deck.seek(3.5);
  s.deck.play();
  await sleep(700);
  void s.deck.position; // the fake player notices the end when it is read
  await sleep(10);
  assert.equal(ended, 1);
  assert.equal(s.deck.playing, false);
  s.deck.play();
  assert.equal(s.deck.playing, true);
  assert.closeTo(s.deck.position, 0.25, 0.01);
});

test('seekFraction, and a user seek outside a loop leaves the loop', async () => {
  const s = await loaded({ seconds: 100 });
  s.deck.seekFraction(0.5);
  assert.closeTo(s.deck.position, 50, 1e-9);
  s.deck.seekFraction(2);
  assert.closeTo(s.deck.position, 100, 1e-9);
  s.deck.seek(20.1);
  s.deck.toggleLoop(4);
  assert(s.deck.loop.active);
  s.deck.seek(21); // inside: the loop stays
  assert(s.deck.loop.active);
  s.deck.seek(30, { source: 'sync' }); // sync jumps wrap into the loop
  assert(s.deck.loop.active);
  const L = s.deck.loop;
  assert(s.deck.position >= L.start && s.deck.position < L.end);
  s.deck.seek(60);
  assert.equal(s.deck.loop.active, false);
  assert.equal(s.player.count('clearLoop'), 1);
});

test('brake: one-beat vinyl stop; echo out pauses after the echo, unless the user acted', async () => {
  const s = await loaded();
  const d = s.deck;
  d.play();
  d.brake();
  assert.equal(d.playing, false);
  const i = s.player.calls.findIndex((c) => c[0] === 'brake' && c[1] === 500);
  assert(i >= 0, 'brake over one beat (120 BPM -> 500 ms)');
  assert.equal(s.player.calls[i + 1][0], 'pause');
  assert.equal(s.player.calls[i + 2][0], 'brake');
  assert.equal(s.player.calls[i + 2][1], 0);
  d.brake(); // not playing: nothing
  assert.equal(s.player.count('pause'), 1);

  d.play();
  d.echoOut();
  assert.deepEqual(s.channel.fx.echoOuts, [0.5]);
  await sleep(1900);
  assert.equal(d.playing, true);
  await sleep(200);
  assert.equal(d.playing, false, 'paused after 4 beats');

  d.play();
  d.echoOut();
  await sleep(500);
  d.pause();
  d.play(); // the user took over
  await sleep(2500);
  assert.equal(d.playing, true);
});

// ---- tempo, bend, scratch ---------------------------------------------------------------------------------------

test('tempo: user moves emit tempoTouched, sync rates widen the range without it', async () => {
  const s = await loaded();
  const d = s.deck;
  let touched = 0;
  d.on('tempoTouched', () => touched++);
  d.setTempo(0.5);
  assert.equal(touched, 1);
  assert.closeTo(d.rate, 1.04, 1e-12);
  assert.closeTo(s.player.rate, 1.04, 1e-12);
  assert.closeTo(d.effectiveBpm, 124.8, 1e-9);
  assert.closeTo(s.channel.fx.beat, 60 / 124.8, 1e-12, 'echo time follows the tempo');
  d.setTempoRange(0.16); // keeps the speed, the fader moves
  assert.closeTo(d.rate, 1.04, 1e-12);
  assert.closeTo(d.tempo, 0.25, 1e-12);
  assert.equal(touched, 1);
  d.setTempo(1); // +16 %
  d.setTempoRange(0.08); // no longer fits: clamped to +8 %
  assert.closeTo(d.rate, 1.08, 1e-12);
  assert.equal(d.tempo, 1);
  assert.equal(touched, 3);
  d.applySyncRate(1.12);
  assert.equal(touched, 3);
  assert.equal(d.tempoRange, 0.16);
  assert.closeTo(d.tempo, 0.75, 1e-12);
  assert.closeTo(s.player.rate, 1.12, 1e-12);
  d.applySyncRate(0.7);
  assert.equal(d.tempoRange, 0.5);
  assert.closeTo(d.tempo, -0.6, 1e-12);
  d.resetTempo();
  assert.equal(d.rate, 1);
  assert.equal(d.tempo, 0);
  assert.equal(touched, 4);
  assert(s.events.includes('tempo'));
});

test('bend: user nudge and sync correction add up', async () => {
  const s = await loaded();
  const d = s.deck;
  d.setBend(0.04);
  d.setBend(0.01, 'sync');
  assert.closeTo(s.player.bendV, 0.05, 1e-12);
  assert.closeTo(d.bend, 0.05, 1e-12);
  d.setBend(0);
  assert.closeTo(s.player.bendV, 0.01, 1e-12);
  d.setBend(5);
  assert.closeTo(s.player.bendV, 0.91, 1e-12, 'clamped to 0.9 + sync');
  d.setBend(0);
  d.setBend(0, 'sync');
  assert.equal(s.player.bendV, 0);
  assert.equal(d.rate, 1, 'bend never changes the rate');
});

test('scratch: deltaSec is relative to the position at scratchBegin', async () => {
  const s = await loaded();
  const d = s.deck;
  d.seek(30);
  d.play();
  await sleep(500);
  d.scratchBegin();
  assert.equal(d.scratching, true);
  const ref = s.player.last('scratchBegin')[1];
  assert.closeTo(ref, 30.5, 0.01);
  d.scratchMove(-0.25, -3);
  let m = s.player.last('scratchMove');
  assert.closeTo(m[1], ref - 0.25, 1e-9);
  assert.equal(m[2], -3);
  d.scratchMove(0.4, 2);
  m = s.player.last('scratchMove');
  assert.closeTo(m[1], ref + 0.4, 1e-9);
  d.scratchEnd();
  assert.equal(d.scratching, false);
  assert.equal(s.player.count('scratchEnd'), 1);
  d.scratchMove(1, 1); // after release: ignored
  assert.equal(s.player.count('scratchMove'), 2);
  d.setVinyl(false);
  assert.equal(d.vinyl, false);
  assert(s.events.includes('vinyl'));
});

// ---- loops and BPM ----------------------------------------------------------------------------------------------

test('loops: quantised start, same size exits, other size resizes, halve and double', async () => {
  const s = await loaded({ seconds: 100 });
  const d = s.deck;
  d.seek(10.3);
  d.toggleLoop(4);
  let L = d.loop;
  assert.equal(L.active, true);
  assert.equal(L.beats, 4);
  assert.closeTo(L.start, 10.25, 1e-9);
  assert.closeTo(L.end, 12.25, 1e-9);
  assert.deepEqual(s.player.last('loop').slice(1).map((x) => Math.round(x * 1000) / 1000), [10.25, 12.25]);
  d.toggleLoop(8);
  assert.closeTo(d.loop.end, 14.25, 1e-9);
  assert.closeTo(d.loop.start, 10.25, 1e-9);
  d.loopHalve();
  assert.equal(d.loop.beats, 4);
  assert.closeTo(d.loop.end, 12.25, 1e-9);
  d.loopDouble();
  d.loopDouble();
  assert.equal(d.loop.beats, 16);
  assert.closeTo(d.loop.end, 18.25, 1e-9);
  d.toggleLoop(16);
  assert.equal(d.loop.active, false);
  assert.equal(s.player.count('clearLoop'), 1);
  // the loop plays around
  d.seek(40.1);
  d.toggleLoop(1);
  d.play();
  await sleep(2000);
  L = d.loop;
  assert(d.position >= L.start && d.position < L.end, `inside the loop: ${d.position}`);
  d.exitLoop();
  assert.equal(d.loop.active, false);
  for (let k = 0; k < 8; k++) d.loopHalve(); // nothing happens without a loop
  assert.equal(d.loop.active, false);
});

test('loops need a BPM', async () => {
  const s = setup();
  await s.deck.loadFile(song('a.mp3'));
  s.deck.toggleLoop(4);
  assert.equal(s.deck.loop.active, false);
  assert.match(s.errors[0], /Loops need the tempo/);
});

test('x2 and /2 keep the grid; an active loop keeps its beat count', async () => {
  const s = await loaded({ seconds: 100 });
  const d = s.deck;
  d.seek(10.3);
  d.toggleLoop(4);
  d.doubleBpm();
  assert.equal(d.bpm, 240);
  assert.equal(d.track.bpmDetected, 120);
  assert.closeTo(d.track.firstBeat, 0.0, 1e-9); // 0.25 mod 0.25
  assert.closeTo(d.loop.end, 10.25 + 1, 1e-9);
  d.halveBpm();
  d.halveBpm();
  assert.equal(d.bpm, 60);
  assert.closeTo(d.loop.end, 10.25 + 4, 1e-9);
  assert(s.events.includes('bpm'));
  d.halveBpm();
  d.halveBpm(); // 15 BPM: refused
  assert.equal(d.bpm, 30);
  assert.match(s.errors[s.errors.length - 1], /out of range/);
});

test('tap tempo while playing: BPM and grid from the heard positions', async () => {
  const s = await loaded({ seconds: 100 });
  const d = s.deck;
  d.seek(20);
  d.play();
  await sleep(110); // first tap at 20.11
  const P = 60 / 125;
  for (let k = 0; k < 8; k++) {
    if (k === 5) {
      await sleep(P * 1000); // a missed tap
      continue;
    }
    d.tapTempo();
    await sleep(P * 1000);
  }
  assert.closeTo(d.bpm, 125, 0.05);
  assert.closeTo(d.track.bpmDetected, 120, 1e-9);
  // grid through the taps: 20.11 is on a beat
  assert.closeTo(d.beatPhase(20.11), 0, 0.01);
  // paused: tempo from the tap times only, grid kept
  d.pause();
  const fb = d.track.firstBeat;
  await sleep(3000);
  for (let k = 0; k < 5; k++) {
    d.tapTempo();
    await sleep(500);
  }
  assert.closeTo(d.bpm, 120, 0.05);
  assert.closeTo(d.track.firstBeat, gridStart(fb, 0.5), 1e-9);
});

test('beatPhase', async () => {
  const s = await loaded();
  assert.closeTo(s.deck.beatPhase(10.5), 0.5, 1e-9);
  assert.closeTo(s.deck.beatPhase(10.25), 0, 1e-9);
  s.deck.seek(1.0);
  assert.closeTo(s.deck.beatPhase(), 0.5, 1e-9);
  const e = setup();
  assert.equal(e.deck.beatPhase(3), null);
});

// ---- FX and mixer -------------------------------------------------------------------------------------------------

test('FX: rack effects go to the channel, crush to the player with the amount', async () => {
  const s = await loaded();
  const d = s.deck;
  d.setFx('echo', true);
  assert.equal(s.channel.fx.on.echo, true);
  assert.equal(d.fx.echo, true);
  d.setFx('crush', true);
  assert.equal(s.player.crush, 0.5);
  d.setFxAmount(0.8);
  assert.equal(s.channel.fx.amount, 0.8);
  assert.equal(s.player.crush, 0.8);
  d.setFx('crush', false);
  assert.equal(s.player.crush, 0);
  d.setFxAmount(0.3);
  assert.equal(s.player.crush, 0);
  d.setFx('nope', true);
  assert.equal(d.fx.nope, undefined);
  assert(s.events.includes('fx'));
});

test('mixer channel state is kept and forwarded; audible follows volume x crossfader', async () => {
  const s = await loaded();
  const d = s.deck;
  d.setVolume(0.6);
  d.setEq('low', -1);
  d.setEq('mid', 0.3);
  d.setEq('bogus', 1);
  d.setFilter(-0.4);
  d.setTrimDb(3);
  d.setCue(true);
  assert.deepEqual(d.mix, { volume: 0.6, eq: { low: -1, mid: 0.3, high: 0 }, filter: -0.4, trimDb: 3, cue: true });
  const ch = s.channel;
  assert.equal(ch.volume, 0.6);
  assert.deepEqual(ch.eq, { low: -1, mid: 0.3, high: 0 });
  assert.equal(ch.filter, -0.4);
  assert.equal(ch.trimDb, 3);
  assert.equal(ch.cue, true);
  d.setTrimDb(99);
  assert.equal(d.mix.trimDb, 12);
  assert.equal(d.audible, false, 'paused');
  d.play();
  assert.equal(d.audible, true);
  d.setVolume(0.05); // 0.0025 < -40 dB
  assert.equal(d.audible, false);
  d.setVolume(1);
  ch.state.xfade = 0.005;
  assert.equal(d.audible, false);
  ch.state.xfade = 0.7;
  assert.equal(d.audible, true);
});

// ---- audio restart ---------------------------------------------------------------------------------------------

test('engine restart: the song is re-decoded into the new player and the deck state restored', async () => {
  const s = await loaded({ seconds: 100 });
  const d = s.deck;
  const blob = s.log.decodes[0].blob;
  d.setTempo(0.5);
  d.setVolume(0.7);
  d.setEq('high', -0.5);
  d.setFilter(0.2);
  d.setCue(true);
  d.setFx('reverb', true);
  d.setFx('crush', true);
  d.seek(30.1);
  d.cueDown();
  d.cueUp(); // cue at 30.25 (snapped)
  d.toggleLoop(2);
  d.play();
  await sleep(300);
  const pos = d.position;
  const track = d.track;
  const oldPlayer = s.player;
  s.engine.restart();
  assert.notEqual(s.player, oldPlayer);
  assert.equal(d.restoring, true);
  assert.equal(d.loading, true);
  assert.equal(d.playing, false);
  assert.closeTo(d.position, pos, 1e-9, 'shows the old position while re-loading');
  await sleep(100);
  assert.equal(d.restoring, false);
  assert.equal(d.loading, false);
  assert.equal(s.log.decodes.length, 2);
  assert.equal(s.log.decodes[1].blob, blob, 'the kept file');
  assert.equal(s.log.analyses.length, 1, 'no new analysis');
  assert.equal(d.track, track);
  assert.equal(d.bpm, 120);
  const p = s.player;
  assert.equal(p.count('load'), 1);
  assert.closeTo(p.last('seek')[1], pos, 1e-9);
  assert.closeTo(d.position, pos, 1e-9);
  assert.closeTo(p.rate, 1.04, 1e-12);
  assert.equal(p.crush, 0.5);
  assert(p.loopR, 'loop restored');
  assert.closeTo(p.loopR.s, d.loop.start, 1e-12);
  assert.equal(d.loop.active, true);
  assert.equal(d.cuePoint, 30.25);
  const ch = s.channel;
  assert.equal(ch.volume, 0.7);
  assert.equal(ch.eq.high, -0.5);
  assert.equal(ch.filter, 0.2);
  assert.equal(ch.cue, true);
  assert.equal(ch.trimDb, -4);
  assert.equal(ch.fx.on.reverb, true);
  assert.equal(d.playing, false, 'a restarted engine starts paused');
  d.play();
  assert.equal(p.playing, true);
});

test('engine restart re-renders a demo and restarts a load that was decoding', async () => {
  const s = setup();
  await s.deck.loadDemo(1);
  await sleep(200);
  s.engine.restart();
  await sleep(50);
  assert.equal(s.log.demos.length, 2);
  assert.equal(s.log.demos[1].id, 1);
  assert.equal(s.player.count('load'), 1);
  assert.equal(s.deck.track.title, 'Spore Garden');

  const p = s.deck.loadFile(song('slow.mp3', 30));
  await sleep(5);
  s.engine.restart(); // while decoding in the old context
  await p;
  await sleep(100);
  assert.equal(s.deck.track.fileName, 'slow.mp3');
  assert.equal(s.player.count('load'), 1, 'loaded once, into the new player');
  assert.deepEqual(s.errors, []);
});

// ---- with the real SyncController --------------------------------------------------------------------------------

test('two decks + SyncController: auto sync on BPM arrival, sync survives an audio restart', async () => {
  const engine = new FakeEngine();
  const settings = settingsWith();
  const { deps } = makeDeps();
  const A = new Deck('A', engine, settings, deps);
  const B = new Deck('B', engine, settings, makeDeps({ beats: { bpm: 125, firstBeat: 0.1, confidence: 1 } }).deps);
  const sync = new SyncController([A, B], settings);
  const errors = [];
  sync.on('error', (m) => errors.push(m));
  engine.start();
  await A.loadFile(song('a.mp3', 120));
  await sleep(200);
  A.play();
  await B.loadFile(song('b.mp3', 120));
  assert.equal(B.synced, false);
  await sleep(200); // B's BPM arrives -> auto sync
  assert.equal(B.synced, true);
  assert.closeTo(B.rate, 120 / 125, 1e-9);
  assert.closeTo(B.effectiveBpm, 120, 1e-9);
  B.play();
  await sleep(500);
  const err = sync._mult[1] === 1 ? ((B.position - 0.1) * 125 / 60) - ((A.position - 0.25) * 120 / 60) : NaN;
  assert(Math.abs(err - Math.round(err)) < 0.02, `in phase: ${err}`);
  engine.restart();
  await sleep(100);
  assert.equal(B.synced, true, 'kept through the restart');
  assert.closeTo(engine.players[1].rate, 120 / 125, 1e-9);
  B.setTempo(0.1); // user tempo move
  assert.equal(B.synced, false);
  sync.toggle(1);
  assert.equal(B.synced, true);
  await A.loadFile(song('c.mp3', 60)); // new song on the leader
  assert.equal(B.synced, false);
  assert.deepEqual(errors, []);
  sync.dispose();
});

// ---- Auto Mix support (docs/AUTOMIX.md 4.1) ---------------------------------------------------------------------

const ctxNow = () => performance.now() / 1000; // the fake AudioContext clock
const AUTO = { source: 'auto' };

/** A player on the audio clock like DeckPlayer: tempo ramps, playAt / seekAt, positionAt (no output latency). */
class ClockPlayer extends Emitter {
  constructor() {
    super();
    this.calls = [];
    this.loaded = false;
    this.duration = 0;
    this.scratching = false;
    this.loopR = null;
    this._run = false; // motor on (also while a start is pending)
    this._start = null; // pending playAt time
    this._jump = null; // pending seekAt { pos, at }
    this._p = 0;
    this._t = ctxNow();
    this._rate = 1;
    this._ramp = null;
    this._bend = 0;
  }
  _m() {
    return { rate: this._rate, bend: this._bend, ramp: this._ramp };
  }
  get rate() {
    return this._ramp ? rateAt(this._m(), ctxNow()) : this._rate;
  }
  get targetRate() {
    return this._rate;
  }
  get playing() {
    this._settle();
    return this._run && this._start === null;
  }
  get scheduledStart() {
    this._settle();
    return this._start;
  }
  get scheduledSeek() {
    this._settle();
    return this._jump ? { ...this._jump } : null;
  }
  positionAt(T) {
    let p = this._p;
    if (this._run) {
      const s = this._start !== null ? Math.max(this._t, this._start) : this._t;
      if (T > s) p += travelDistance(this._m(), s, T);
    }
    if (this._jump && T >= this._jump.at) p = this._jump.pos + (this._run ? travelDistance(this._m(), this._jump.at, T) : 0);
    return Math.max(0, Math.min(this.duration, p));
  }
  audibleTime() {
    return ctxNow();
  }
  getPosition() {
    return this.loaded ? this.positionAt(ctxNow()) : 0;
  }
  _settle() {
    const t = ctxNow();
    this._p = this.positionAt(t);
    this._t = t;
    if (this._start !== null && t >= this._start) this._start = null;
    if (this._jump && t >= this._jump.at) this._jump = null;
    if (this._ramp && t >= this._ramp.c1) this._ramp = null;
  }
  log(...a) {
    this.calls.push(a);
  }
  last(name) {
    for (let i = this.calls.length - 1; i >= 0; i--) if (this.calls[i][0] === name) return this.calls[i];
    return null;
  }
  load(ch, sr) {
    this.log('load');
    this.loaded = true;
    this.duration = ch[0].length / sr;
    this._p = 0;
    this._t = ctxNow();
    this._run = false;
    this._start = null;
    this._jump = null;
  }
  unload() {
    this.log('unload');
    this.loaded = false;
    this._run = false;
    this._start = null;
    this._jump = null;
    this._p = 0;
    this.duration = 0;
  }
  play() {
    this._settle();
    this.log('play');
    this._run = true;
    this._start = null;
  }
  pause() {
    this._settle();
    this.log('pause');
    this._run = false;
    this._start = null;
    this._jump = null;
  }
  playAt(t) {
    this._settle();
    this.log('playAt', t);
    if (this._run) return;
    this._run = true;
    this._start = t;
  }
  setRate(r, sec = 0) {
    this._settle();
    if (sec > 0) this.log('rate', r, sec);
    else this.log('rate', r);
    const from = this.rate;
    this._ramp = sec > 0 ? { c0: ctxNow(), c1: ctxNow() + sec, r0: from, r1: r } : null;
    this._rate = r;
  }
  setBend(b) {
    this._settle();
    this._bend = b;
  }
  setBrake() {}
  seek(p) {
    this._settle();
    this.log('seek', p);
    this._p = p;
    if (this._start !== null) this._run = false; // like DeckPlayer: a seek drops a pending start
    this._start = null;
    this._jump = null;
  }
  seekAt(p, t) {
    this._settle();
    this.log('seekAt', p, t);
    this._jump = { pos: p, at: t };
  }
  scratchBegin() {
    this.scratching = true;
  }
  scratchMove() {}
  scratchEnd() {
    this.scratching = false;
  }
  setLoop(s, e) {
    this.loopR = { s, e };
  }
  clearLoop() {
    this.loopR = null;
  }
  setCrush() {}
}

class ClockEngine extends FakeEngine {
  _build() {
    super._build();
    this.ctx = {
      sampleRate: SR,
      get currentTime() {
        return ctxNow();
      },
    };
    this._players = [new ClockPlayer(), new ClockPlayer()];
  }
}

async function clockLoaded(opts = {}) {
  const engine = new ClockEngine();
  const { deps } = makeDeps(opts);
  const deck = new Deck('A', engine, settingsWith(opts.settings), deps);
  const names = [];
  let touched = 0;
  deck.on('userAction', (n) => names.push(n));
  deck.on('tempoTouched', () => touched++);
  engine.start();
  await deck.loadFile(song('x.mp3', opts.seconds || 120), undefined, AUTO);
  await sleep(200);
  names.length = 0;
  return {
    engine, deck, names, touched: () => touched,
    get player() {
      return engine.players[0];
    },
    get channel() {
      return engine.mixer.channels[0];
    },
  };
}

test('tempo source: a sync or Auto Mix tempo goes back to 0 % with the next song, a user tempo stays', async () => {
  const s = await loaded();
  const d = s.deck;
  assert.equal(d.tempoSource, 'user');
  d.applySyncRate(0.88);
  assert.equal(d.tempoSource, 'sync');
  assert.equal(d.tempoRange, 0.16);
  await d.loadFile(song('next.mp3', 30));
  assert.equal(d.rate, 1, 'the sync rate does not carry into the next song');
  assert.equal(d.tempo, 0);
  assert.equal(d.tempoRange, 0.08, 'back to the range the user picked');
  assert.equal(s.player.rate, 1);
  assert.equal(d.tempoSource, 'user');
  d.setTempo(0.5);
  await d.loadFile(song('third.mp3', 30));
  assert.closeTo(d.rate, 1.04, 1e-12, 'a user tempo stays');
  d.rampTempo(1.02, 0);
  assert.equal(d.tempoSource, 'auto');
  assert.closeTo(d.rate, 1.02, 1e-12);
  await d.loadFile(song('fourth.mp3', 30));
  assert.equal(d.rate, 1);
  // resetTempo({ source: 'auto' }): 0 % without tempoTouched
  let touched = 0;
  d.on('tempoTouched', () => touched++);
  d.applySyncRate(1.05);
  d.resetTempo(AUTO);
  assert.equal(d.rate, 1);
  assert.equal(d.tempoSource, 'auto');
  assert.equal(touched, 0);
  d.setTempoRange(0.16);
  d.applySyncRate(1.1);
  await d.loadFile(song('fifth.mp3', 30));
  assert.equal(d.tempoRange, 0.16, 'the range the user picked');
});

test('userAction: user-facing controls report, Auto Mix and sync calls stay quiet', async () => {
  const s = await loaded();
  const d = s.deck;
  const names = [];
  d.on('userAction', (n) => names.push(n));
  // quiet
  d.play(AUTO);
  d.seek(20, AUTO);
  d.seek(21, { source: 'sync' });
  d.pause(AUTO);
  d.setEq('low', -1, AUTO);
  d.setVolume(0.6, AUTO);
  d.setFilter(0.1, AUTO);
  d.rampTempo(1.03, 0);
  d.applySyncRate(1.01);
  d.resetTempo(AUTO);
  d.setBend(0.02);
  d.setBend(0);
  d.setFx('echo', true);
  await d.loadFile(song('quiet.mp3', 60), undefined, AUTO);
  await sleep(200);
  await d.loadDemo(1, AUTO);
  await sleep(200);
  assert.deepEqual(names, []);
  // reported
  d.play();
  d.pause();
  d.togglePlay();
  d.togglePlay();
  d.cueDown();
  d.cueUp();
  d.seek(10);
  d.seekFraction(0.5);
  d.setTempo(0.1);
  d.resetTempo();
  d.setEq('low', -0.5);
  d.setVolume(0.5);
  d.setFilter(0.2);
  d.scratchBegin();
  d.scratchEnd();
  d.toggleLoop(4);
  d.exitLoop();
  d.doubleBpm();
  d.eject();
  const expected = ['play', 'pause', 'play', 'pause', 'cue', 'seek', 'seek', 'tempo', 'tempo', 'eq', 'volume', 'filter',
    'scratch', 'loop', 'loop', 'bpm', 'eject'];
  assert.deepEqual(names, expected);
  names.length = 0;
  await d.loadFile(song('user.mp3', 30));
  assert.equal(names.join(), 'load');
});

test('beat map: stored from the analysis; beatsAt / timeOfBeat / beatPhase / loops / cue follow it', async () => {
  // 120 BPM grid from 0.25 s, but the music drifts: every beat from 20 on is 30 ms later
  const map = Float64Array.from({ length: 110 }, (_, k) => 0.25 + 0.5 * k + (k >= 20 ? 0.03 : 0));
  const beats = { bpm: 120, firstBeat: 0.25, confidence: 0.9, variable: true, alternatives: [], beats: Array.from(map) };
  const s = await loaded({ beats });
  const d = s.deck;
  const t = d.track;
  assert(t.beats instanceof Float64Array);
  assert.equal(t.beats.length, 110);
  assert.closeTo(d.beatsAt(map[30]), 30, 1e-9);
  assert.closeTo(d.timeOfBeat(30.5), 0.5 * (map[30] + map[31]), 1e-12);
  assert.closeTo(d.beatPhase(map[30] + 0.125), 0.25, 1e-9);
  assert.closeTo(d.beatLengthAt(map[30]), 0.5, 1e-9);
  assert.closeTo(d.timeOfBeat(120), map[109] + 11 * 0.5, 1e-9, 'extrapolated past the end of the map');
  // quantised loop: on a map beat, 4 map beats long
  d.seek(map[40] + 0.1);
  d.toggleLoop(4);
  assert.closeTo(d.loop.start, map[40], 1e-9);
  assert.closeTo(d.loop.end, map[44], 1e-9);
  d.exitLoop();
  // quantised cue point on a map beat
  d.seek(map[50] + 0.08);
  d.cueDown();
  d.cueUp();
  assert.closeTo(d.cuePoint, map[50], 1e-9);
  // x2 / ½ transform the map; a tapped tempo replaces it
  d.doubleBpm();
  assert.equal(t.beats.length, 219);
  assert.closeTo(d.beatsAt(map[30]) - d.beatsAt(map[0]), 60, 1e-9);
  d.halveBpm();
  assert.equal(t.beats.length, 110);
  assert.closeTo(d.beatsAt(map[30]), 30, 1e-9);
  assert.closeTo(d.beatsAt(map[31]) - d.beatsAt(map[30]), 1, 1e-9);
  // without a map: the grid; a broken map is dropped
  const g = await loaded({ beats: { bpm: 120, firstBeat: 0.25, confidence: 1, variable: false, alternatives: [], beats: [1, 1, 2] } });
  assert.equal(g.deck.track.beats, null);
  assert.closeTo(g.deck.beatsAt(10.25), 20, 1e-12);
  assert.closeTo(g.deck.timeOfBeat(20), 10.25, 1e-12);
  const e = setup();
  assert.equal(e.deck.beatsAt(3), null);
  assert.equal(e.deck.timeOfBeat(3), null);
});

test('deck-math: beat map x2 / ½ and tempo-ramp kinematics', () => {
  const m = Float64Array.from([0.2, 0.7, 1.2, 1.8]);
  const dbl = doubleBeatMap(m);
  [0.2, 0.45, 0.7, 0.95, 1.2, 1.5, 1.8].forEach((v, i) => assert.closeTo(dbl[i], v, 1e-12));
  assert.equal(dbl.length, 7);
  assert.deepEqual(Array.from(halveBeatMap(m, 120, 0.2)), [0.2, 1.2]);
  assert.deepEqual(Array.from(halveBeatMap(m, 120, -0.3)), [0.7, 1.8], 'keeps the beats with an even index');
  assert.equal(halveBeatMap(Float64Array.from([0.2, 0.7]), 120, 0.2), null);
  const ramp = { rate: 1.1, bend: 0, ramp: { c0: 10, c1: 14, r0: 1, r1: 1.1 } };
  assert.equal(rateAt(ramp, 9), 1);
  assert.closeTo(rateAt(ramp, 12), 1.05, 1e-12);
  assert.equal(rateAt(ramp, 20), 1.1);
  assert.closeTo(travelDistance(ramp, 8, 16), 2 * 1 + 4 * 1.05 + 2 * 1.1, 1e-12);
  assert.closeTo(travelDistance(ramp, 11, 13), 2 * 1.05, 1e-12);
  for (const [a, d] of [[8, 1], [8, 5], [11, 3.3], [9, 12], [15, 2]]) {
    const dt = travelTime(ramp, a, d);
    assert.closeTo(travelDistance(ramp, a, a + dt), d, 1e-9);
  }
  assert.closeTo(travelTime({ rate: 1.2, bend: 0.01, ramp: null }, 0, 12.1), 10, 1e-12);
  assert.equal(travelTime({ rate: 0, bend: 0, ramp: null }, 0, 1), Infinity);
  assert.equal(travelTime(ramp, 3, 0), 0);
  // loops on a beat map
  const map = Float64Array.from({ length: 40 }, (_, k) => 0.1 + 0.5 * k + (k >= 10 ? 0.02 : 0));
  const b = loopBounds(6.0, 4, 120, 0.1, 30, true, map);
  assert.closeTo(b.start, map[12], 1e-12);
  assert.closeTo(b.end, map[16], 1e-12);
  const late = loopBounds(19.7, 8, 120, 0.1, 20, true, map); // would run past the end: moved back by whole beats
  assert(late.end <= 20 + 1e-9);
  assert.closeTo(late.start, map[31], 1e-9);
  assert.equal(loopBounds(1, 64, 120, 0.1, 20, true, map), null);
});

test('rampTempo: a smooth tempo change on the audio clock, no tempoTouched', async () => {
  const s = await clockLoaded();
  const d = s.deck;
  d.rampTempo(1.06, 4);
  assert.deepEqual(s.player.last('rate'), ['rate', 1.06, 4]);
  assert.equal(d.ramping, true);
  assert.equal(d.targetRate, 1.06);
  assert.equal(d.tempoSource, 'auto');
  assert.equal(s.touched(), 0);
  assert.deepEqual(s.names, []);
  await sleep(2000);
  assert.closeTo(d.rate, 1.03, 1e-6);
  assert.closeTo(d.tempo, 0.375, 1e-5, 'the fader follows the ramp');
  assert.closeTo(d.effectiveBpm, 120 * 1.03, 1e-4);
  await sleep(2100);
  assert.equal(d.ramping, false);
  assert.equal(d.rate, 1.06);
  assert.closeTo(d.tempo, 0.75, 1e-12);
  // a wider target widens the range for the ramp; easing back to 1 returns to the user's range
  d.rampTempo(1.12, 2);
  assert.equal(d.tempoRange, 0.16);
  await sleep(2100);
  d.rampTempo(1, 3);
  assert.equal(d.tempoRange, 0.16, 'wide while the ramp runs');
  await sleep(1500);
  assert(d.tempo > 0 && d.tempo < 0.75);
  await sleep(1600);
  assert.equal(d.rate, 1);
  assert.equal(d.tempoRange, 0.08);
  assert.equal(d.tempo, 0);
  // a user tempo move ends a ramp at once
  d.rampTempo(1.05, 5);
  await sleep(1000);
  d.setTempo(-0.5);
  assert.equal(d.ramping, false);
  assert.closeTo(d.rate, 0.96, 1e-12);
  assert.deepEqual(s.player.last('rate'), ['rate', 0.96]);
  assert.equal(d.tempoSource, 'user');
});

test('rampTempo on a player that cannot ramp: small steps', async () => {
  const s = await clockLoaded();
  const d = s.deck;
  const p = s.player;
  const steps = [];
  Object.defineProperty(p, 'rate', { get: () => undefined, configurable: true }); // an older player
  p.setRate = (r) => steps.push(r);
  d.rampTempo(1.04, 1);
  await sleep(1200);
  assert(steps.length >= 20, `${steps.length} steps`);
  for (let i = 1; i < steps.length; i++) assert(steps[i] >= steps[i - 1] - 1e-12, 'rising');
  assert.closeTo(steps[steps.length - 1], 1.04, 1e-12);
  assert.closeTo(d.rate, 1.04, 1e-12);
});

test('playAt / seekAt / positionAt / timeAtPosition on the audio clock', async () => {
  const s = await clockLoaded();
  const d = s.deck;
  const p = s.player;
  d.seek(10, AUTO);
  const t0 = ctxNow() + 0.5;
  d.playAt(t0, AUTO);
  assert.equal(d.playing, true, 'the deck counts as playing at once');
  assert.deepEqual(p.last('playAt'), ['playAt', t0]);
  assert.equal(d.scheduledAt, t0);
  assert.deepEqual(s.names, []);
  assert.closeTo(d.positionAt(t0 + 1), 11, 1e-9);
  assert.closeTo(d.timeAtPosition(12), t0 + 2, 1e-9);
  await sleep(300);
  assert.closeTo(d.position, 10, 1e-9, 'still until the start');
  // a user seek while the start is pending keeps the start
  d.seek(20);
  assert.equal(d.scheduledAt, t0);
  assert.deepEqual(p.last('playAt'), ['playAt', t0]);
  await sleep(400);
  assert.equal(d.scheduledAt, null);
  assert.closeTo(d.position, 20.2, 1e-6);
  // seekAt: the jump happens exactly then
  const tj = ctxNow() + 0.3;
  d.seekAt(50, tj, { source: 'sync' });
  assert.deepEqual(p.last('seekAt'), ['seekAt', 50, tj]);
  assert.equal(d.scheduledAt, tj);
  assert.closeTo(d.positionAt(tj + 0.2), 50.2, 1e-9);
  await sleep(500);
  assert.closeTo(d.position, 50.2, 1e-6);
  // timeAtPosition with a running ramp
  d.rampTempo(1.1, 4);
  const target = d.position + 10;
  const ta = d.timeAtPosition(target);
  assert.closeTo(d.positionAt(ta), target, 1e-6);
  assert(ta - ctxNow() < 10 && ta - ctxNow() > 9);
  assert.equal(d.timeAtPosition(d.position - 1), null, 'already past');
  d.toggleLoop(4);
  assert.equal(d.timeAtPosition(target), null, 'a loop never gets there');
  d.exitLoop();
  // pause drops a pending start
  d.pause(AUTO);
  d.playAt(ctxNow() + 1, AUTO);
  d.pause(AUTO);
  assert.equal(d.scheduledAt, null);
  assert.equal(d.playing, false);
  await sleep(1100);
  assert.equal(p.playing, false);
  assert.equal(d.timeAtPosition(100), null, 'paused');
  // without an audio clock: playAt plays at once, positionAt is unknown
  const plain = await loaded();
  plain.deck.playAt(5, AUTO);
  assert.equal(plain.player.playing, true);
  assert.equal(plain.deck.positionAt(3), null);
  assert.equal(plain.deck.audioTime, null);
});

test('timed EQ passes through to the channel; the deck shows the new value at once', async () => {
  const s = await clockLoaded();
  const d = s.deck;
  const at = ctxNow() + 3;
  d.setEq('low', -1, { at, ramp: 0.5, source: 'auto' });
  assert.equal(d.mix.eq.low, -1);
  assert.equal(s.channel.eq.low, -1);
  assert.deepEqual(s.channel.eqOpts, { at, ramp: 0.5 });
  assert.deepEqual(s.names, []);
  // the same value again from Auto Mix is still sent (it cancels the pending glide)
  s.channel.eqOpts = 'x';
  d.setEq('low', -1, AUTO);
  assert.equal(s.channel.eqOpts, null);
  d.setEq('mid', 0.2);
  assert.deepEqual(s.names, ['eq']);
});
