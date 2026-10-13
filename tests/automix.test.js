// Tests for the Auto Mix controller (src/deck/automix.js) with fake decks (positions, scheduled starts / jumps and
// tempo ramps integrated on JsCheck's virtual clock, which doubles as the AudioContext clock), a fake mixer and
// sync, and the real Playlist. Checks the exact audio-clock times of a mix, the tempo modes, takeover, MIX NOW,
// skipping songs that fail, the end of the list and the robustness paths.
import { Emitter } from '../src/core/emitter.js';
import { AutoMix } from '../src/deck/automix.js';
import { Playlist } from '../src/deck/playlist.js';
import { Deck } from '../src/deck/deck.js';
import { SyncController } from '../src/deck/sync.js';
import { returnSeconds, crossfadeAt } from '../src/deck/automix-plan.js';
import { waitAnalysis } from '../src/deck/automix-deck.js';
import { beatsAt, timeOfBeat, beatLengthAt } from '../src/deck/sync-math.js';
import { rateAt, travelDistance, travelTime } from '../src/deck/deck-math.js';

const now = () => performance.now() / 1000; // the fake AudioContext clock (no output latency in the fakes)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait (virtual time) until cond() holds; fails after `ms`. */
async function until(cond, ms = 200000, what = 'condition') {
  const end = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > end) {
      fail(`timed out waiting for ${what}`);
      return;
    }
    await sleep(10);
  }
}

// Songs the fake decks can "load" (by library id or 'demo-<n>'). Bounds are the whole song (no waveform).
const CATALOG = {
  s1: { title: 'One', bpm: 128, firstBeat: 0, duration: 120 },
  s2: { title: 'Two', bpm: 126, firstBeat: 0.1, duration: 100 },
  s3: { title: 'Three', bpm: 140, firstBeat: 0.05, duration: 90 },
  s4: { title: 'Four', bpm: null, duration: 80 },
  short: { title: 'Short', bpm: 120, firstBeat: 0, duration: 20 },
  tiny: { title: 'Tiny', bpm: 128, firstBeat: 0, duration: 10 },
  bad: { title: 'Bad', fail: true },
  slow: { title: 'Slow', bpm: 126, firstBeat: 0.1, duration: 100, analysisMs: 90000 }, // analysis later than NEXT_WAIT_MS
  'demo-1': { title: 'Spore Garden', bpm: 128, firstBeat: 0, duration: 96 },
};

class FakeDeck extends Emitter {
  constructor(id) {
    super();
    this.id = id;
    this.index = id === 'B' ? 1 : 0;
    this.calls = [];
    this.track = null;
    this.loading = false;
    this.analyzing = false;
    this.synced = false;
    this.scratching = false;
    this.loop = { active: false };
    this.tempoSource = 'user';
    this.mix = { volume: 0.8, eq: { low: 0, mid: 0, high: 0 } };
    this._playing = false;
    this._startAt = null;
    this._jump = null;
    this._pos = 0;
    this._t = now();
    this._rate = 1;
    this._ramp = null;
    this._lt = 0;
  }
  // ---- state
  get audioTime() {
    return now();
  }
  get bpm() {
    return this.track && this.track.bpm > 0 ? this.track.bpm : null;
  }
  get duration() {
    return this.track ? this.track.duration : 0;
  }
  get rate() {
    return this._ramp ? rateAt({ rate: this._rate, ramp: this._ramp }, now()) : this._rate;
  }
  get targetRate() {
    return this._rate;
  }
  get playing() {
    return this._playing;
  }
  get effectiveBpm() {
    return this.bpm ? this.bpm * this.rate : null;
  }
  get scheduledAt() {
    const t = now();
    let at = this._startAt !== null && this._startAt > t ? this._startAt : null;
    if (this._jump && this._jump.at > t) at = at === null ? this._jump.at : Math.max(at, this._jump.at);
    return at;
  }
  get position() {
    return this.positionAt(now());
  }
  _motion() {
    return { rate: this._rate, bend: 0, ramp: this._ramp };
  }
  positionAt(T) {
    const m = this._motion();
    let p = this._pos;
    const moving = this._playing;
    if (moving) {
      const start = this._startAt !== null ? Math.max(this._t, this._startAt) : this._t;
      if (T > start) p += travelDistance(m, start, T);
    }
    if (this._jump && T >= this._jump.at) p = this._jump.pos + (moving ? travelDistance(m, this._jump.at, T) : 0);
    return Math.max(0, Math.min(this.duration, p));
  }
  timeAtPosition(pos) {
    if (!this._playing || this.loop.active || this.scratching) return null;
    const t = now();
    const from = this._startAt !== null && this._startAt > t ? this._startAt : t;
    const cur = this.positionAt(from);
    if (pos < cur - 1e-9) return null;
    return from + travelTime(this._motion(), from, pos - cur);
  }
  beatsAt(pos) {
    return this.bpm ? beatsAt(pos, this.bpm, this.track.firstBeat, this.track.beats) : null;
  }
  timeOfBeat(k) {
    return this.bpm ? timeOfBeat(k, this.bpm, this.track.firstBeat, this.track.beats) : null;
  }
  beatLengthAt(pos) {
    return this.bpm ? beatLengthAt(pos, this.bpm, this.track.beats) : null;
  }
  /** Re-anchor the trajectory at now (before every change). */
  _settle() {
    const t = now();
    this._pos = this.positionAt(t);
    this._t = t;
    if (this._startAt !== null && t >= this._startAt) this._startAt = null;
    if (this._jump && t >= this._jump.at) this._jump = null;
    if (this._ramp && t >= this._ramp.c1) this._ramp = null;
  }
  _log(...a) {
    this.calls.push([...a, now()]);
  }
  _ua(name, opts) {
    if (!opts || (opts.source !== 'auto' && opts.source !== 'sync')) this.emit('userAction', name);
  }
  count(name) {
    return this.calls.filter((c) => c[0] === name).length;
  }
  last(name) {
    for (let i = this.calls.length - 1; i >= 0; i--) if (this.calls[i][0] === name) return this.calls[i];
    return null;
  }
  /** Called by the test harness every 20 ms: the song stops at its end. */
  _poll() {
    if (this._playing && this.track && this._startAt === null && this.position >= this.duration - 1e-9) {
      this._settle();
      this._playing = false;
      this.emit('change', 'transport');
      this.emit('ended');
    }
  }
  // ---- loading (resolves when playable; the analysis follows 100 ms later)
  loadFile(blob, meta, opts) {
    this._log('loadFile', meta && meta.libraryId, opts && opts.source);
    return this._load(meta && meta.libraryId, opts);
  }
  loadDemo(id, opts) {
    this._log('loadDemo', id, opts && opts.source);
    return this._load(`demo-${id}`, opts);
  }
  async _load(key, opts) {
    const token = ++this._lt;
    this._settle();
    this._playing = false;
    this._startAt = null;
    this._jump = null;
    this.track = null;
    this.loading = true;
    this._pos = 0;
    this._ramp = null;
    if (this.tempoSource !== 'user') {
      this._rate = 1;
      this.tempoSource = 'user';
    }
    this.emit('change', 'loading');
    this._ua('load', opts);
    await sleep(50);
    if (token !== this._lt) return;
    const spec = CATALOG[key];
    if (!spec || spec.fail) {
      this.loading = false;
      this.emit('change', 'loading');
      this.emit('error', "That song couldn't be loaded.");
      throw new Error("That song couldn't be loaded.");
    }
    this.track = {
      title: spec.title, artist: '', duration: spec.duration, bpm: null, firstBeat: 0, beats: null, waveform: null,
      source: key.startsWith('demo-') ? 'demo' : 'file',
    };
    if (key.startsWith('demo-')) this.track.demoId = Number(key.slice(5));
    else this.track.libraryId = key;
    this.loading = false;
    this.analyzing = true;
    this._pos = 0;
    this._t = now();
    this.emit('change', 'loading');
    this.emit('change', 'track');
    setTimeout(() => {
      if (token !== this._lt) return;
      this.analyzing = false;
      this.track.bpm = spec.bpm || null;
      this.track.firstBeat = spec.firstBeat || 0;
      this.emit('change', 'bpm');
      this.emit('change', 'analysis');
      this.emit('analyzed', this.track);
    }, spec.analysisMs || 100);
  }
  // ---- transport
  play(opts) {
    this._settle();
    this._log('play', opts && opts.source);
    if (!this.track) return;
    if (!this._playing) {
      this._playing = true;
      this._startAt = null;
    }
    this.emit('change', 'transport');
    this._ua('play', opts);
  }
  pause(opts) {
    this._settle();
    this._log('pause', opts && opts.source);
    this._playing = false;
    this._startAt = null;
    this._jump = null;
    this.emit('change', 'transport');
    this._ua('pause', opts);
  }
  playAt(t, opts) {
    this._settle();
    this._log('playAt', t, opts && opts.source);
    if (!this._playing) {
      this._playing = true;
      this._startAt = t;
    }
    this.emit('change', 'transport');
    this._ua('play', opts);
  }
  seek(p, opts) {
    this._settle();
    this._log('seek', p, opts && opts.source);
    this._pos = Math.max(0, Math.min(this.duration, p));
    this._jump = null;
    this._ua('seek', opts);
  }
  seekAt(p, t, opts) {
    this._settle();
    this._log('seekAt', p, t, opts && opts.source);
    this._jump = { pos: p, at: t };
    this._ua('seek', opts);
  }
  rampTempo(r, sec = 0) {
    this._settle();
    this._log('rampTempo', r, sec);
    const from = this.rate;
    this._ramp = sec > 0 ? { c0: now(), c1: now() + sec, r0: from, r1: r } : null;
    this._rate = r;
    this.tempoSource = 'auto';
    this.emit('change', 'tempo');
  }
  setTempo(v) {
    this._settle();
    this._ramp = null;
    this._rate = 1 + v * 0.08;
    this.tempoSource = 'user';
    this.emit('change', 'tempo');
    this.emit('userAction', 'tempo');
  }
  applySyncRate(r) {
    this._settle();
    this._ramp = null;
    this._rate = r;
    this.tempoSource = 'sync';
  }
  setEq(band, v, opts) {
    this._log('setEq', band, v, opts && opts.at, opts && opts.ramp, opts && opts.source);
    this.mix.eq[band] = v;
    this._ua('eq', opts);
  }
  setVolume(v, opts) {
    this._log('setVolume', v, opts && opts.source);
    this.mix.volume = v;
    this._ua('volume', opts);
  }
  echoOut(opts) {
    this._log('echoOut', opts && opts.source);
  }
}

class FakeMixer extends Emitter {
  constructor() {
    super();
    this._x = 0;
    this.sched = null;
    this.calls = [];
  }
  get crossfader() {
    const s = this.sched;
    if (!s) return this._x;
    const t = now();
    if (t >= s.start + s.dur) {
      this._x = s.to;
      this.sched = null;
      return this._x;
    }
    return t < s.start ? s.from : crossfadeAt((t - s.start) / s.dur, s.from, s.to);
  }
  get crossfadeScheduled() {
    return !!this.sched && now() < this.sched.start + this.sched.dur;
  }
  setCrossfader(x, opts) {
    const source = (opts && opts.source) || 'user';
    this.calls.push(['set', x, source, now()]);
    this.sched = null;
    this._x = x;
    this.emit('crossfader', { source, x, scheduled: false });
  }
  scheduleCrossfade(from, to, start, dur) {
    this.calls.push(['schedule', from, to, start, dur]);
    this.sched = { from, to, start, dur };
    this.emit('crossfader', { source: 'auto', scheduled: true });
    return true;
  }
  cancelCrossfade(opts) {
    this.calls.push(['cancel', now()]);
    if (!this.sched) return false;
    this._x = this.crossfader;
    this.sched = null;
    this.emit('crossfader', { source: (opts && opts.source) || 'auto', cancelled: true });
    return true;
  }
  last(name) {
    for (let i = this.calls.length - 1; i >= 0; i--) if (this.calls[i][0] === name) return this.calls[i];
    return null;
  }
}

class FakeSync {
  constructor(decks) {
    this.decks = decks;
    this.calls = [];
  }
  setSync(i, on, opts) {
    this.calls.push([i, !!on, opts || null, now()]);
    this.decks[i].synced = !!on;
    if (on) this.decks[1 - i].synced = false;
    return true;
  }
  isSynced(i) {
    return !!this.decks[i].synced;
  }
  leaderOf(i) {
    return this.decks[i].synced ? 1 - i : null;
  }
}

class FakeSettings extends Emitter {
  constructor(values) {
    super();
    this.v = { mixBeats: 32, automixReturn: true, automixBassSwap: true, setList: [], ...values };
  }
  get(k) {
    return this.v[k];
  }
  set(k, x) {
    if (this.v[k] === x) return;
    this.v[k] = x;
    this.emit('change', k, x);
  }
}

class FakeLibrary extends Emitter {
  constructor() {
    super();
    this.loaded = true;
    this.entries = Object.keys(CATALOG).filter((k) => !k.startsWith('demo-')).map((id) => ({ id, title: CATALOG[id].title, fileName: `${id}.mp3` }));
  }
  get(id) {
    const e = this.entries.find((x) => x.id === id);
    return e ? { ...e } : null;
  }
  list() {
    return this.entries.map((e) => ({ ...e }));
  }
  getBlob(id) {
    return Promise.resolve(this.get(id) ? { name: `${id}.mp3`, size: 1 } : null);
  }
}

function setup({ items = ['s1', 's2', 's3'], settings = {}, start = true, deps = {} } = {}) {
  const st = new FakeSettings(settings);
  const library = new FakeLibrary();
  const playlist = new Playlist({ settings: st, library });
  playlist.add(items.map((id) => (id.startsWith('demo-') ? { kind: 'demo', id: Number(id.slice(5)) } : { id })));
  const decks = [new FakeDeck('A'), new FakeDeck('B')];
  const mixer = new FakeMixer();
  const engine = new Emitter();
  engine.ready = true;
  engine.ctx = { get currentTime() {
    return now();
  } };
  engine.mixer = mixer;
  const sync = new FakeSync(decks);
  const am = new AutoMix({ engine, decks, sync, settings: st, playlist, deps: { hidden: () => false, ...deps } });
  const log = { errors: [], takeovers: [], finished: 0, states: [] };
  am.on('error', (m) => log.errors.push(m));
  am.on('takeover', (m) => log.takeovers.push(m));
  am.on('finished', () => log.finished++);
  am.on('change', (w) => {
    if (w === 'state') log.states.push(am.state);
  });
  const poll = setInterval(() => decks.forEach((d) => d._poll()), 20);
  const s = {
    am, decks, A: decks[0], B: decks[1], mixer, sync, engine, playlist, settings: st, log,
    done() {
      clearInterval(poll);
      am.dispose();
    },
  };
  if (start) am.setEnabled(true);
  return s;
}

/** Enable from idle and wait until the next song is ready on deck B. Returns the time deck A started. */
async function startedAndReady(s) {
  await until(() => s.am.state === 'playing', 5000, 'playing');
  const tA = s.A.last('play')[2];
  await until(() => s.am.nextReady, 5000, 'next ready');
  return tA;
}

test('enable with an empty set list or without audio: a plain error, stays off', () => {
  const s = setup({ items: [], start: false });
  assert.equal(s.am.setEnabled(true), false);
  assert.equal(s.am.enabled, false);
  assert.deepEqual(s.log.errors, ['Add songs to the set list first.']);
  s.done();
  const t = setup({ start: false });
  t.engine.ready = false;
  assert.equal(t.am.toggle(), false);
  assert.match(t.log.errors[0], /Tap Start first/);
  assert.equal(t.am.state, 'off');
  t.done();
});

test('enable from idle: first song on deck A at its in-point, crossfader to A, then the next song preloaded on B', async () => {
  const s = setup();
  assert.equal(s.am.enabled, true);
  assert.equal(s.am.state, 'starting');
  assert.equal(s.am.currentDeck, 0);
  await sleep(1); // (the library hands over the file first)
  assert.deepEqual(s.A.calls[0].slice(0, 3), ['loadFile', 's1', 'auto']);
  const tA = await startedAndReady(s);
  assert.equal(s.A.last('play')[1], 'auto');
  assert.deepEqual(s.mixer.calls.find((c) => c[0] === 'set').slice(0, 3), ['set', -1, 'auto']);
  assert.equal(s.playlist.currentIndex, 0);
  // deck B: the next song, parked on its first beat with the tempo matched and the bass cut
  assert.deepEqual(s.B.calls.find((c) => c[0] === 'loadFile').slice(0, 3), ['loadFile', 's2', 'auto']);
  assert.closeTo(s.B.position, 0.1, 1e-9);
  assert.closeTo(s.B.targetRate, 128 / 126, 1e-12);
  assert.equal(s.B.mix.eq.low, -1);
  assert.equal(s.B.playing, false);
  assert.equal(s.am.nextItem.id, 's2');
  const plan = s.am.plan;
  assert.equal(plan.mode, 'match');
  assert.equal(plan.beats, 32);
  assert.equal(plan.out.beat, 224); // 120 s at 128 BPM = 256 beats -> last 32-beat phrase start
  assert.closeTo(plan.out.at, 105, 1e-9);
  assert.closeTo(plan.in.at, 0.1, 1e-9);
  assert.closeTo(s.am.secondsToMix, tA + 105 - now(), 1e-6);
  assert.deepEqual(s.log.errors, []);
  assert.deepEqual(s.log.states.slice(0, 2), ['starting', 'playing']);
  s.done();
});

test('the mix: exact audio-clock times, bars on bars, bass swap, sync, then the handover', async () => {
  const s = setup();
  const tA = await startedAndReady(s);
  const t0 = tA + 105; // deck A plays from 0 at rate 1: it reaches the out-point (105 s) then
  await until(() => s.am.state === 'preparing', 200000, 'preparing');
  assert(now() >= t0 - 2.05 && now() < t0, 'scheduled about 2 s ahead');
  // deck B: tempo set, parked at its in-point, started exactly at t0
  const playAt = s.B.last('playAt');
  assert.closeTo(playAt[1], t0, 1e-6);
  assert.equal(playAt[2], 'auto');
  assert.closeTo(s.B.last('seek')[1], 0.1, 1e-9);
  assert.closeTo(s.B.targetRate, 128 / 126, 1e-12);
  assert.closeTo(s.A.positionAt(t0), 105, 1e-6, 'deck A is on its out-point at t0');
  // crossfade A -> B over 32 beats at 128 BPM
  const sch = s.mixer.last('schedule');
  assert.deepEqual(sch.slice(0, 3), ['schedule', -1, 1]);
  assert.closeTo(sch[3], t0, 1e-6);
  assert.closeTo(sch[4], 15, 1e-9);
  // bass swap at beat 16 of the mix, over one beat
  const beat = 60 / 128;
  const eqA = s.A.last('setEq');
  const eqB = s.B.last('setEq');
  assert.deepEqual([eqA[1], eqA[2], eqA[5]], ['low', -1, 'auto']);
  assert.deepEqual([eqB[1], eqB[2], eqB[5]], ['low', 0, 'auto']);
  assert.closeTo(eqA[3], t0 + 16 * beat, 1e-6);
  assert.closeTo(eqB[3], t0 + 16 * beat, 1e-6);
  assert.closeTo(eqA[4], beat, 1e-9);
  // during the mix the beats line up: B's beats since its in-point = A's beats since its out-point, bars too
  await until(() => s.am.state === 'mixing', 5000, 'mixing');
  await sleep(3000);
  const T = now();
  const aBeats = s.A.beatsAt(s.A.positionAt(T)) - 224;
  const bBeats = s.B.beatsAt(s.B.positionAt(T)) - s.am.plan.in.beat;
  assert.closeTo(bBeats, aBeats, 1e-6, 'in phase');
  assert.equal(s.am.plan.in.beat % 4, 0);
  assert.closeTo(s.am.progress, (T - t0) / 15, 1e-6);
  assert.equal(s.am.secondsToMix, null);
  // phase keeping handed to the SyncController 0.25 s after t0 (without a jump)
  const syncOn = s.sync.calls.find((c) => c[1] === true);
  assert.deepEqual(syncOn.slice(0, 3), [1, true, { align: false }]);
  assert(syncOn[3] >= t0 + 0.25 - 1e-9 && syncOn[3] < t0 + 0.4);
  // handover after the crossfade
  await until(() => s.am.state === 'playing', 30000, 'handover');
  assert(now() >= t0 + 15.3 - 1e-9);
  assert.equal(s.am.currentDeck, 1);
  assert.equal(s.A.playing, false, 'old deck stopped (here the song itself ended with the mix)');
  assert.equal(s.A.mix.eq.low, 0, 'old deck bass back');
  assert.equal(s.B.mix.eq.low, 0, 'the new song keeps its bass');
  assert.equal(s.B.count('setEq') > 0 ? s.B.last('setEq')[2] : 0, 0, 'and nothing cut it after the swap');
  assert.ok(s.A.calls.some((c) => c[0] === 'rampTempo' && c[1] === 1 && c[2] === 0), 'old deck tempo 0 %');
  assert.deepEqual(s.mixer.last('set').slice(0, 3), ['set', 1, 'auto']);
  const ease = s.B.last('rampTempo');
  assert.equal(ease[1], 1);
  assert.closeTo(ease[2], returnSeconds(126, 128 / 126), 1e-9, 'the new song eases back to its own tempo');
  assert.equal(s.B.synced, false);
  assert.equal(s.playlist.currentIndex, 1);
  // the following song is preloaded on the free deck
  await until(() => s.am.nextReady, 5000, 'next ready');
  assert.deepEqual(s.A.last('loadFile').slice(0, 3), ['loadFile', 's3', 'auto']);
  assert.equal(s.am.nextItem.id, 's3');
  assert.deepEqual(s.log.errors, []);
  s.done();
});

test('meet: the current song ramps half way before the mix, the next starts at the meet tempo', async () => {
  const s = setup({ items: ['s2', 's3'] }); // 126 -> 140 BPM (11 %)
  await startedAndReady(s);
  const plan = s.am.plan;
  assert.equal(plan.mode, 'meet');
  const target = Math.sqrt(126 * 140) / 126;
  assert.closeTo(plan.tempo.curTargetRate, target, 1e-12);
  await until(() => s.A.count('rampTempo') > 0, 200000, 'pre-ramp');
  const ramp = s.A.last('rampTempo');
  assert.closeTo(ramp[1], target, 1e-12);
  assert.equal(s.am.state, 'preparing');
  // the ramp covers ~16 beats and ends at least 4 beats and 2.6 s before the mix
  const rampEndPos = s.A.positionAt(ramp[3] + ramp[2]);
  const gapBeats = 176 - s.A.beatsAt(rampEndPos);
  assert(gapBeats >= 4 - 1e-6, `gap ${gapBeats} beats`);
  const beatsRamped = s.A.beatsAt(rampEndPos) - s.A.beatsAt(s.A.positionAt(ramp[3]));
  assert.closeTo(beatsRamped, 16, 0.3);
  await until(() => s.B.count('playAt') > 0, 60000, 'scheduled');
  const t0 = s.B.last('playAt')[1];
  assert(t0 - ramp[3] - ramp[2] >= 2.6 - 1e-6, 'the ramp is over before the mix is scheduled');
  assert.closeTo(s.A.positionAt(t0), plan.out.at, 1e-6, 't0 accounts for the ramp');
  assert.closeTo(s.B.targetRate, (126 * target) / 140, 1e-12);
  const sch = s.mixer.last('schedule');
  assert.closeTo(sch[4], (32 * 60) / 126 / target, 1e-9, '32 beats at the meet tempo');
  await until(() => s.am.state === 'mixing', 5000, 'mixing');
  await sleep(2000);
  const T = now();
  assert.closeTo(s.B.beatsAt(s.B.positionAt(T)) - plan.in.beat, s.A.beatsAt(s.A.positionAt(T)) - plan.out.beat, 1e-6);
  await until(() => s.am.currentDeck === 1, 30000, 'handover');
  assert.equal(s.A.last('pause')[1], 'auto', 'the old song is stopped after the crossfade');
  assert.equal(s.A.playing, false);
  assert.equal(s.A.targetRate, 1, 'and back at 0 %');
  const ease = s.B.last('rampTempo');
  assert.equal(ease[1], 1);
  assert.closeTo(ease[2], returnSeconds(140, (126 * target) / 140), 1e-9);
  // last song: nothing more to preload
  assert.equal(s.am.nextItem, null);
  s.done();
});

test('cut: a next song without BPM starts at its own tempo, an 8-beat blend with an echo out, no sync', async () => {
  const s = setup({ items: ['s1', 's4'] });
  await startedAndReady(s);
  const plan = s.am.plan;
  assert.equal(plan.mode, 'cut');
  assert.equal(plan.beats, 8);
  assert.equal(plan.out.beat, 240);
  assert.equal(s.B.mix.eq.low, 0, 'no bass cut for a cut');
  assert.equal(s.B.targetRate, 1);
  await until(() => s.am.state === 'mixing', 200000, 'mixing');
  const t0 = s.B.last('playAt')[1];
  assert.closeTo(s.A.positionAt(t0), 112.5, 1e-6);
  assert.closeTo(s.mixer.last('schedule')[4], (8 * 60) / 128, 1e-9);
  await sleep(500);
  assert.equal(s.A.count('echoOut'), 1);
  assert.equal(s.A.last('echoOut')[1], 'auto');
  assert.equal(s.sync.calls.filter((c) => c[1]).length, 0, 'no sync in a cut');
  assert.equal(s.B.count('setEq'), 0, 'no bass swap');
  await until(() => s.am.currentDeck === 1, 10000, 'handover');
  assert.equal(s.B.count('rampTempo') > 0 ? s.B.last('rampTempo')[2] : 0, 0, 'already at its own tempo: no ease back');
  s.done();
});

test('takeover: a user action during the mix freezes the automation and switches Auto Mix off', async () => {
  for (const how of ['deck', 'mixer', 'note']) {
    const s = setup();
    await startedAndReady(s);
    await until(() => s.am.state === 'mixing', 200000, 'mixing');
    await sleep(1000);
    if (how === 'deck') s.B.setEq('high', 0.3); // the user grabs an EQ knob
    else if (how === 'mixer') s.mixer.setCrossfader(0.2); // the user moves the crossfader
    else s.am.noteUserCrossfader();
    assert.equal(s.am.enabled, false, how);
    assert.equal(s.am.state, 'off');
    assert.deepEqual(s.log.takeovers, ['Auto Mix off. You took over the mix.']);
    if (how !== 'mixer') assert(s.mixer.calls.some((c) => c[0] === 'cancel'), 'crossfade frozen');
    assert(s.A.playing && s.B.playing, 'both keep playing');
    await sleep(20000);
    assert.equal(s.A.count('pause'), 0, 'no more automation');
    s.done();
  }
});

test('a timing action before the mix starts cancels the prepared mix and re-plans', async () => {
  const s = setup();
  await startedAndReady(s);
  await until(() => s.am.state === 'preparing', 200000, 'preparing');
  const firstT0 = s.B.last('playAt')[1];
  s.A.seek(s.A.position - 30); // the user jumps back 30 s
  assert.equal(s.am.enabled, true);
  assert.equal(s.am.state, 'playing');
  assert.equal(s.B.playing, false, 'the scheduled start was cancelled');
  assert.equal(s.B.last('pause')[1], 'auto');
  assert.equal(s.mixer.last('cancel')[0], 'cancel');
  assert.equal(s.A.mix.eq.low, 0, 'the bass swap was undone');
  assert.equal(s.B.mix.eq.low, -1);
  assert.equal(s.log.takeovers.length, 0);
  assert(s.am.plan);
  await until(() => s.am.state === 'preparing', 60000, 'preparing again');
  const t0 = s.B.last('playAt')[1];
  assert(t0 > firstT0 + 29, 'the new mix is 30 s later');
  assert.closeTo(s.A.positionAt(t0), 105, 1e-6);
  // EQ / volume changes before t0 are fine
  s.A.setVolume(0.7);
  assert.equal(s.am.state, 'preparing');
  s.done();
});

test('MIX NOW: the transition starts at the next bar', async () => {
  const s = setup();
  await startedAndReady(s);
  await sleep(10000);
  assert(s.am.mixNow());
  const plan = s.am.plan;
  assert.equal(plan.late, true);
  assert.equal(plan.out.beat % 4, 0);
  const posSoon = s.A.positionAt(now() + 1);
  assert(plan.out.at >= posSoon - 1e-9 && plan.out.at < posSoon + (4 * 60) / 128 + 1e-9, 'the first bar a second from now');
  await until(() => s.am.state === 'mixing', 5000, 'mixing soon');
  const t0 = s.B.last('playAt')[1];
  assert.closeTo(s.A.positionAt(t0), plan.out.at, 1e-6);
  assert.equal(s.mixer.last('schedule')[4], 15);
  s.done();
});

test('a song the user jumped past its mix point mixes at the next bar; one that ended starts the next at once', async () => {
  const s = setup();
  await startedAndReady(s);
  s.A.seek(108); // past the out-point (105 s)
  await until(() => s.am.state === 'mixing', 5000, 'late mix');
  assert.equal(s.am.plan.late, true);
  assert(s.am.plan.out.at > 108);
  s.done();

  const e = setup();
  await until(() => e.am.state === 'playing', 5000, 'playing');
  e.A.seek(119.95); // the song ends before the next one is ready
  await until(() => e.am.currentDeck === 1, 5000, 'next started');
  assert.equal(e.B.last('play')[1], 'auto');
  assert.equal(e.B.targetRate, 1, 'at its own tempo');
  assert.equal(e.mixer.last('set')[1], 1);
  assert.equal(e.playlist.currentIndex, 1);
  e.done();
});

test('end of the list: the last song plays out, then finished and off', async () => {
  const s = setup({ items: ['short'] });
  await until(() => s.am.state === 'playing', 5000, 'playing');
  assert.equal(s.am.nextItem, null);
  assert.equal(s.am.mixNow(), false);
  assert.match(s.log.errors[0], /last song/);
  await until(() => s.log.finished === 1, 60000, 'finished');
  assert.equal(s.am.state, 'finished');
  assert.equal(s.am.enabled, false);
  assert.equal(s.am.currentDeck, null);
  // enabling again starts the list over
  assert(s.am.setEnabled(true));
  await until(() => s.am.state === 'playing', 5000, 'playing again');
  assert.equal(s.A.last('loadFile')[1], 'short');
  s.done();
});

test('a song that fails to load is skipped with a message', async () => {
  const s = setup({ items: ['s1', 'bad', 's2'] });
  await until(() => s.am.state === 'playing', 5000, 'playing');
  await until(() => s.am.nextReady, 5000, 'next ready');
  assert.deepEqual(s.B.calls.filter((c) => c[0] === 'loadFile').map((c) => c[1]), ['bad', 's2']);
  assert.equal(s.log.errors.length, 1);
  assert.match(s.log.errors[0], /Skipped “Bad”/);
  assert.equal(s.am.nextItem.id, 's2');
  // after the mix the bad song counts as played
  await until(() => s.am.currentDeck === 1, 200000, 'handover');
  assert.equal(s.playlist.currentIndex, 2);
  s.done();
  // a first song that fails: the next one starts instead
  const f = setup({ items: ['bad', 's2', 's3'] });
  await until(() => f.am.state === 'playing', 5000, 'playing');
  assert.equal(f.A.last('loadFile')[1], 's2');
  assert.equal(f.playlist.currentIndex, 1);
  f.done();
});

test('switched on while a deck plays: that deck is current and its song is found in the list', async () => {
  const s = setup({ items: ['s1', 's2', 's3'], start: false });
  s.B.loadFile({}, { libraryId: 's2' });
  await sleep(300);
  s.B.seek(20);
  s.B.play();
  assert(s.am.setEnabled(true));
  assert.equal(s.am.currentDeck, 1);
  assert.equal(s.am.state, 'playing');
  assert.equal(s.playlist.currentIndex, 1);
  await until(() => s.am.nextReady, 5000, 'next ready');
  assert.equal(s.A.last('loadFile')[1], 's3');
  assert.equal(s.am.plan.mode, 'meet');
  s.done();
});

test('the user loads their own song on the prepared deck: Auto Mix mixes into it, the list stays put', async () => {
  const s = setup();
  await startedAndReady(s);
  s.B.loadFile({}, { libraryId: 's3' }); // a user load (no source)
  assert.equal(s.am.nextReady, false);
  await until(() => s.am.nextReady, 5000, 'user song ready');
  assert.equal(s.am.nextItem.kind, 'deck');
  assert.equal(s.am.nextItem.title, 'Three');
  assert.equal(s.am.plan.mode, 'meet'); // 128 -> 140
  await until(() => s.am.currentDeck === 1, 200000, 'handover');
  assert.equal(s.playlist.currentIndex, 0, 'the set list did not advance');
  await until(() => s.am.nextReady, 5000, 'next ready');
  assert.equal(s.A.last('loadFile')[1], 's2', 'the set list goes on with its next song');
  s.done();
});

test('an audio restart cancels a prepared mix and re-plans; switching off undoes a scheduled start', async () => {
  const s = setup();
  await startedAndReady(s);
  await until(() => s.am.state === 'preparing', 200000, 'preparing');
  s.engine.emit('restarted');
  assert.equal(s.am.state, 'playing');
  assert.equal(s.A.mix.eq.low, 0);
  assert.equal(s.B.mix.eq.low, -1);
  assert.equal(s.am.enabled, true);
  // (the fake decks keep playing, so the mix is scheduled again)
  await until(() => s.am.state === 'preparing', 10000, 'preparing again');
  s.am.setEnabled(false);
  assert.equal(s.am.state, 'off');
  assert.equal(s.B.playing, false, 'the pending start is undone');
  assert.equal(s.log.takeovers.length, 0);
  s.done();
});

test('a song shorter than the mix into it: when it has run out, the following song starts at once', async () => {
  const s = setup({ items: ['s1', 'tiny', 's2'] });
  await startedAndReady(s);
  await until(() => s.am.state === 'mixing', 200000, 'mixing');
  await until(() => s.am.currentDeck === 1, 30000, 'handover');
  // 'tiny' (10 s) already ended during the 15 s crossfade: s2 is loaded on A and starts right away
  await until(() => s.am.currentDeck === 0 && s.A.playing, 10000, 's2 playing');
  assert.equal(s.A.track.libraryId, 's2');
  assert.equal(s.playlist.currentIndex, 2);
  assert.equal(s.mixer.last('set')[1], -1);
  assert.deepEqual(s.log.errors, []);
  assert.equal(s.am.enabled, true);
  s.done();
});

test('settings: a different mix length re-plans; no bass swap leaves the bass alone', async () => {
  const s = setup({ settings: { mixBeats: 16, automixBassSwap: false, automixReturn: false } });
  await startedAndReady(s);
  assert.equal(s.am.plan.beats, 16);
  assert.equal(s.B.mix.eq.low, 0);
  s.settings.set('mixBeats', 64);
  assert.equal(s.am.plan.beats, 64);
  assert.equal(s.am.plan.out.beat, 192);
  await until(() => s.am.state === 'mixing', 200000, 'mixing');
  assert.equal(s.A.count('setEq'), 0);
  await until(() => s.am.currentDeck === 1, 60000, 'handover');
  assert.equal(s.B.calls.filter((c) => c[0] === 'rampTempo' && c[2] > 0).length, 0, 'no ease back');
  assert.closeTo(s.B.targetRate, 128 / 126, 1e-12, 'the new song keeps the mix tempo');
  s.done();
});

test('MIX NOW during the meet pre-ramp: the tempo stays where the ramp got to, the next song matches it', async () => {
  const s = setup({ items: ['s2', 's3'] }); // 126 -> 140: meet
  await startedAndReady(s);
  await until(() => s.A.count('rampTempo') > 0, 200000, 'pre-ramp');
  const ramp = s.A.last('rampTempo');
  await sleep(1500);
  const r = s.A.rate;
  assert(r > 1.001 && r < ramp[1] - 1e-3, `part way through the ramp (${r})`);
  assert(s.am.mixNow());
  assert.closeTo(s.A.targetRate, r, 1e-9, 'the ramp stops where it is');
  assert.equal(s.A.last('rampTempo')[2], 0);
  assert.equal(s.am.plan.mode, 'match');
  assert.equal(s.am.plan.late, true);
  await until(() => s.am.state === 'mixing', 10000, 'mixing');
  const t0 = s.B.last('playAt')[1];
  assert.closeTo(s.A.positionAt(t0), s.am.plan.out.at, 1e-6);
  assert.closeTo(s.B.targetRate, (126 * r) / 140, 1e-9, 'the next song starts at the tempo reached');
  await sleep(1000);
  assert.closeTo(s.A.rate, r, 1e-9, 'no tempo change under the mix');
  s.done();
});

test('previewing the next song during the meet pre-ramp leaves the ramp alone; the mix still starts on its in-point', async () => {
  const s = setup({ items: ['s2', 's3'] }); // 126 -> 140: meet
  await startedAndReady(s);
  await until(() => s.A.count('rampTempo') > 0, 200000, 'pre-ramp');
  const ramps = s.A.count('rampTempo');
  const target = s.A.last('rampTempo')[1];
  s.B.seek(20); // the user looks for something in the next song (headphones)...
  s.B.play(); // ...and listens to it
  assert.equal(s.am.state, 'preparing', 'the session goes on');
  assert.equal(s.A.count('rampTempo'), ramps, 'the current song is not pulled back');
  assert.equal(s.A.targetRate, target);
  await until(() => s.B.count('seekAt') > 0, 60000, 'scheduled');
  const jump = s.B.last('seekAt');
  assert.closeTo(jump[1], s.am.plan.in.at, 1e-9, 'the previewed deck jumps onto its in-point...');
  const t0 = jump[2];
  assert.closeTo(s.A.positionAt(t0), s.am.plan.out.at, 1e-6, '...exactly when the current song reaches its out-point');
  assert.equal(s.A.count('rampTempo'), ramps);
  await until(() => s.am.currentDeck === 1, 60000, 'handover');
  assert.deepEqual(s.log.takeovers, []);
  s.done();
});

test('a user action just after t0 (before the tick saw the mix start) is a takeover, not a re-plan', async () => {
  const gate = { paused: false };
  const s = setup({ deps: { setInterval: (fn, ms) => setInterval(() => gate.paused || fn(), ms) } });
  await startedAndReady(s);
  await until(() => s.am.state === 'preparing' && s.B.count('playAt') > 0, 200000, 'scheduled');
  const t0 = s.B.last('playAt')[1];
  gate.paused = true;
  await until(() => now() >= t0 + 0.03, 5000, 't0 passed');
  assert.equal(s.am.state, 'preparing', '(the tick has not seen it yet)');
  assert(s.B.playing, 'the next song is playing on the audio clock');
  s.A.seek(s.A.position - 10); // a timing action on the current deck
  assert.equal(s.am.enabled, false);
  assert.deepEqual(s.log.takeovers, ['Auto Mix off. You took over the mix.']);
  assert(s.mixer.calls.some((c) => c[0] === 'cancel'), 'crossfade frozen');
  gate.paused = false;
  await sleep(5000);
  assert(s.B.playing, 'the next song keeps playing');
  assert.equal(s.B.count('seekAt') + s.B.count('pause'), 0, 'and is not restarted or stopped');
  s.done();
});

test('a next song whose BPM arrives late (inside the last 30 s) is re-planned and parked again', async () => {
  const s = setup({ items: ['s1', 'slow'] });
  await until(() => s.am.state === 'playing', 5000, 'playing');
  await until(() => s.am.nextReady, 40000, 'next ready without its analysis');
  assert.equal(s.B.bpm, null);
  assert.equal(s.am.plan.mode, 'cut', 'no BPM yet: a quick blend');
  assert.equal(s.B.mix.eq.low, 0);
  await until(() => s.B.bpm === 126, 100000, 'late BPM');
  assert(s.am.secondsToMix < 30, `(inside the freeze window: ${s.am.secondsToMix})`);
  assert.equal(s.am.plan.mode, 'match');
  assert.equal(s.B.mix.eq.low, -1, 'parked again with the bass cut');
  assert.closeTo(s.B.targetRate, 128 / 126, 1e-12);
  assert.closeTo(s.B.position, 0.1, 1e-9, 'on its first beat');
  await until(() => s.am.state === 'mixing', 60000, 'mixing');
  await sleep(500);
  assert.deepEqual(s.sync.calls.find((c) => c[1]).slice(0, 2), [1, true], 'beat-matched: sync keeps the phase');
  s.done();
});

test('the user loads a song on deck B while the first song starts: the start goes on and that song is next', async () => {
  const s = setup();
  assert.equal(s.am.state, 'starting');
  s.B.loadFile({}, { libraryId: 's3' }); // a user load (no source)
  assert.equal(s.am.nextItem.kind, 'deck');
  await until(() => s.am.state === 'playing' && s.am.nextReady, 5000, 'playing + next ready');
  assert.equal(s.A.playing, true, 'the first song still started');
  assert.equal(s.A.track.libraryId, 's1');
  assert.equal(s.playlist.currentIndex, 0);
  assert.equal(s.B.track.libraryId, 's3', 'the user song stays on deck B');
  assert.equal(s.B.calls.filter((c) => c[0] === 'loadFile').length, 1, 'Auto Mix loaded nothing over it');
  assert.equal(s.am.nextItem.title, 'Three');
  assert.equal(s.am.plan.mode, 'meet'); // 128 -> 140
  assert.equal(s.B.mix.eq.low, -1, 'parked for the mix');
  s.done();
});

test('the user starts deck B while deck A is starting: B is current, the first song is mixed into next', async () => {
  const s = setup({ start: false });
  s.B.loadFile({}, { libraryId: 'short' }); // a song that is not in the set list
  await sleep(300);
  assert(s.am.setEnabled(true));
  assert.equal(s.am.state, 'starting');
  await until(() => !!s.A.track, 5000, 'first song on A');
  assert.equal(s.playlist.currentIndex, 0);
  s.B.play(); // the user starts deck B by hand
  assert.equal(s.am.state, 'playing');
  assert.equal(s.am.currentDeck, 1);
  assert.equal(s.playlist.currentIndex, -1, 'the first song was never started: it is still to come');
  await until(() => s.am.nextReady, 5000, 'next ready');
  assert.equal(s.A.playing, false, 'the automatic start was dropped');
  assert.equal(s.am.nextItem.id, 's1');
  assert.equal(s.A.calls.filter((c) => c[0] === 'loadFile').length, 1, 'the first song already on A is used, not loaded again');
  assert.equal(s.A.mix.eq.low, -1, 'parked for the mix');
  s.done();
});

test('the user loads a song on B while A is starting, then plays it: B is current (never parked), the list goes on', async () => {
  const s = setup();
  s.B.loadFile({}, { libraryId: 's2' }); // a user load while deck A is being started
  await until(() => !!s.B.track, 5000, 'song on B');
  assert.equal(s.am.state, 'starting');
  s.B.play(); // ...and the user starts it
  assert.equal(s.am.currentDeck, 1);
  assert.equal(s.playlist.currentIndex, 1, 'B plays the list\'s second song');
  await until(() => s.am.nextReady, 5000, 'next ready');
  assert.equal(s.am.nextItem.id, 's3');
  assert.equal(s.A.track.libraryId, 's3');
  assert.equal(s.A.mix.eq.low, -1, 'the next deck is parked');
  assert.equal(s.B.mix.eq.low, 0, 'the playing deck keeps its bass');
  assert.equal(s.B.calls.filter((c) => c[0] === 'setEq').length, 0, 'nothing parked the playing deck');
  assert.equal(s.B.playing, true);
  s.done();
});

test('letting go of a prepared deck gives it its bass back (switched off, rest of the list removed)', async () => {
  const s = setup();
  await startedAndReady(s);
  assert.equal(s.B.mix.eq.low, -1);
  s.am.setEnabled(false);
  assert.equal(s.B.mix.eq.low, 0);
  assert.equal(s.B.last('setEq')[5], 'auto');
  s.done();
  const t = setup();
  await startedAndReady(t);
  for (const it of t.playlist.items.slice(1)) t.playlist.remove(it.uid);
  assert.equal(t.am.nextItem, null);
  assert.equal(t.B.mix.eq.low, 0);
  assert.equal(t.am.enabled, true);
  t.done();
});

// ---- end to end: real Decks, SyncController and Playlist; players and mixer faked on the audio clock ------------

const SR = 2000; // tiny PCM: the players only need lengths

/** A DeckPlayer look-alike on the audio clock: ramps, playAt / seekAt, positionAt, 'ended'. */
class ClockPlayer extends Emitter {
  constructor() {
    super();
    this.calls = [];
    this.loaded = false;
    this.duration = 0;
    this.scratching = false;
    this._run = false;
    this._start = null;
    this._jump = null;
    this._p = 0;
    this._t = now();
    this._rate = 1;
    this._ramp = null;
    this._bend = 0;
  }
  _m() {
    return { rate: this._rate, bend: this._bend, ramp: this._ramp };
  }
  get rate() {
    return this._ramp ? rateAt(this._m(), now()) : this._rate;
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
    return now();
  }
  getPosition() {
    return this.loaded ? this.positionAt(now()) : 0;
  }
  _settle() {
    const t = now();
    this._p = this.positionAt(t);
    this._t = t;
    if (this._start !== null && t >= this._start) this._start = null;
    if (this._jump && t >= this._jump.at) this._jump = null;
    if (this._ramp && t >= this._ramp.c1) this._ramp = null;
  }
  _poll() {
    if (this.loaded && this.playing && this.getPosition() >= this.duration - 1e-9) {
      this._settle();
      this._run = false;
      this.emit('ended');
    }
  }
  log(...a) {
    this.calls.push([...a, now()]);
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
    this._t = now();
    this._run = false;
    this._start = null;
    this._jump = null;
  }
  unload() {
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
    this.log('rate', r, sec);
    const from = this.rate;
    this._ramp = sec > 0 ? { c0: now(), c1: now() + sec, r0: from, r1: r } : null;
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
    if (this._start !== null) this._run = false;
    this._start = null;
    this._jump = null;
  }
  seekAt(p, t) {
    this._settle();
    this.log('seekAt', p, t);
    this._jump = { pos: p, at: t };
  }
  scratchBegin() {}
  scratchMove() {}
  scratchEnd() {}
  setLoop() {}
  clearLoop() {}
  setCrush() {}
}

class StripStub {
  constructor() {
    this.state = { xfade: 1 };
    this.eqLog = [];
    this.fx = { set() {}, setAmount() {}, setBeatSeconds() {}, echoOut: (beat) => 4 * beat };
  }
  setTrimDb() {}
  setEq(b, v, opts) {
    this.eqLog.push([b, v, opts || null]);
  }
  setFilter() {}
  setVolume() {}
  setCue() {}
}

const SONGS_E2E = {
  e1: { bpm: 128, firstBeat: 0, seconds: 60 },
  e2: { bpm: 124, firstBeat: 0.12, seconds: 50 },
  e3: { bpm: 128, firstBeat: 0.05, seconds: 40 },
};

/**
 * Real Decks, SyncController, Playlist and AutoMix on ClockPlayers and a fake mixer. Songs are told apart by
 * their length (the fake analysis looks them up by it).
 */
function realRig({ songsE2E = SONGS_E2E, items = ['e1', 'e2', 'e3'], settings = {} } = {}) {
  const st = new FakeSettings({ mixBeats: 16, autoSync: true, quantize: true, tempoRange: 0.08, vinyl: true, ...settings });
  const library = new FakeLibrary();
  library.entries = Object.keys(songsE2E).map((id) => ({ id, title: id.toUpperCase(), fileName: `${id}.mp3` }));
  library.getBlob = (id) => Promise.resolve({ name: `${id}.mp3`, size: 1, id });
  const playlist = new Playlist({ settings: st, library });
  playlist.add(items.map((id) => ({ id })));
  const mixer = new FakeMixer();
  mixer.channels = [new StripStub(), new StripStub()];
  const engine = new Emitter();
  engine.ready = true;
  engine.state = 'running';
  engine.ctx = {
    sampleRate: SR,
    get currentTime() {
      return now();
    },
  };
  engine.mixer = mixer;
  engine.players = [new ClockPlayer(), new ClockPlayer()];
  const deps = {
    decodeFile: async (blob) => {
      await sleep(20);
      const n = Math.round(songsE2E[blob.id].seconds * SR);
      const ch = new Float32Array(n);
      return { buffer: { sampleRate: SR, length: n, numberOfChannels: 1, duration: n / SR, getChannelData: () => ch }, meta: {} };
    },
    analyzeTrack: async (mono, rate, { onWaveform } = {}) => {
      await sleep(80);
      if (onWaveform) onWaveform(null);
      const spec = Object.values(songsE2E).find((x) => Math.abs(x.seconds - mono.length / rate) < 0.5);
      return { beats: { bpm: spec.bpm, firstBeat: spec.firstBeat, confidence: 1, variable: false, alternatives: [] }, waveform: null, loudness: { gainDb: 0 } };
    },
  };
  const decks = [new Deck('A', engine, st, deps), new Deck('B', engine, st, deps)];
  const sync = new SyncController(decks, st);
  const am = new AutoMix({ engine, decks, sync, settings: st, playlist, deps: { hidden: () => false } });
  const log = { errors: [], takeovers: [], finished: 0, deckErrors: [], syncErrors: [] };
  am.on('error', (m) => log.errors.push(m));
  am.on('takeover', (m) => log.takeovers.push(m));
  am.on('finished', () => log.finished++);
  decks.forEach((d) => d.on('error', (m) => log.deckErrors.push(m)));
  sync.on('error', (m) => log.syncErrors.push(m));
  const poll = setInterval(() => engine.players.forEach((p) => p._poll()), 20);
  const [A, B] = decks;
  const [pA, pB] = engine.players;
  return {
    st, library, playlist, mixer, engine, decks, sync, am, log, poll, A, B, pA, pB,
    done() {
      clearInterval(poll);
      sync.dispose();
      am.dispose();
    },
  };
}

test('end to end: real decks, sync and set list play three songs with two beat-matched mixes', async () => {
  const { playlist, am, log, poll, sync, A, B, pA, pB } = realRig();

  assert(am.setEnabled(true));
  await until(() => am.state === 'playing' && am.nextReady, 10000, 'first song + next ready');
  assert.equal(A.playing, true);
  assert.equal(B.track.libraryId, 'e2');
  assert.equal(B.mix.eq.low, -1);
  assert.equal(B.synced, false, 'auto sync is kept off on the prepared deck');
  assert.closeTo(B.rate, 128 / 124, 1e-12);
  const plan1 = am.plan;
  assert.equal(plan1.mode, 'match');
  assert.equal(plan1.beats, 16);

  // mix 1: A -> B
  await until(() => am.state === 'mixing', 120000, 'mix 1');
  const t0 = pB.last('playAt')[1];
  assert.closeTo(pA.positionAt(t0), plan1.out.at, 1e-6, 'A is on its out-point when B starts');
  assert.closeTo(pB.positionAt(t0), plan1.in.at, 1e-9);
  await sleep(2000);
  assert.equal(B.synced, true, 'phase keeping by the SyncController during the mix');
  const T = now();
  const aBeats = A.beatsAt(pA.positionAt(T)) - plan1.out.beat;
  const bBeats = B.beatsAt(pB.positionAt(T)) - plan1.in.beat;
  assert.closeTo(bBeats, aBeats, 1e-4, 'in phase on the audio clock');
  const jumps = pB.calls.filter((c) => (c[0] === 'seekAt' || c[0] === 'seek') && c[c.length - 1] >= t0);
  assert.deepEqual(jumps, [], 'no correcting jumps after the start');
  await until(() => am.state === 'playing' && am.currentDeck === 1, 30000, 'handover 1');
  assert.equal(A.playing, false);
  assert.equal(B.mix.eq.low, 0, 'the new song keeps its bass');
  assert.equal(B.synced, false);
  assert.equal(B.tempoSource, 'auto');
  assert.equal(B.targetRate, 1, 'easing back to its own tempo');
  assert.equal(B.ramping, true);
  assert.equal(playlist.currentIndex, 1);

  // the third song is preloaded on A; its sync / tempo come from Auto Mix, not from the old song
  await until(() => am.nextReady, 10000, 'next ready 2');
  assert.equal(A.track.libraryId, 'e3');
  assert.equal(A.synced, false);

  // mix 2: B -> A, then the set ends
  await until(() => am.state === 'mixing', 120000, 'mix 2');
  await until(() => log.finished === 1, 120000, 'finished');
  assert.equal(am.state, 'finished');
  assert.equal(am.enabled, false);
  assert.equal(playlist.currentIndex, 2);
  assert.deepEqual(log.takeovers, [], 'Auto Mix never mistook its own moves (or sync) for the user');
  assert.deepEqual(log.errors, []);
  assert.deepEqual(log.deckErrors, []);
  assert.deepEqual(log.syncErrors, []);
  clearInterval(poll);
  sync.dispose();
  am.dispose();
});

test('waitAnalysis on a real Deck that is still loading waits for the analysis, not just the load', async () => {
  const r = realRig({ items: ['e1'] });
  const timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };
  const p = r.B.loadFile({ name: 'e2.mp3', size: 1, id: 'e2' }, { libraryId: 'e2' });
  assert.equal(r.B.loading, true);
  let resolvedAt = null;
  waitAnalysis(r.B, 30000, timers).then(() => {
    resolvedAt = now();
  });
  await p;
  assert.equal(r.B.analyzing, true, '(the song is playable, its analysis runs)');
  await until(() => resolvedAt !== null, 5000, 'resolved');
  assert.equal(r.B.bpm, 124, 'resolved only once the BPM was known');
  assert.equal(r.B.analyzing, false);
  r.done();
});

test('end to end: the user loads their own song on the prepared deck; it is analysed before it is planned', async () => {
  const r = realRig({ items: ['e1', 'e2'] });
  const { am, A, B, pA, pB, log } = r;
  assert(am.setEnabled(true));
  await until(() => am.state === 'playing' && am.nextReady, 10000, 'first song + next ready');
  assert.equal(B.track.libraryId, 'e2');
  B.loadFile({ name: 'e3.mp3', size: 1, id: 'e3' }, { libraryId: 'e3', title: 'E3' }); // the user's own pick
  assert.equal(am.nextReady, false);
  await until(() => am.nextReady, 10000, 'user song ready');
  assert.equal(B.bpm, 128, 'ready means analysed');
  assert.equal(am.nextItem.kind, 'deck');
  assert.equal(am.nextItem.title, 'E3');
  const plan = am.plan;
  assert.equal(plan.mode, 'match', '128 -> 128: beat-matched, not a quick blend');
  assert.equal(plan.beats, 16);
  assert.equal(plan.bassSwap, true);
  assert.equal(B.mix.eq.low, -1, 'bass cut for the swap');
  assert.closeTo(B.rate, (128 * A.rate) / 128, 1e-12);
  await until(() => am.state === 'mixing', 120000, 'mix');
  const t0 = pB.last('playAt')[1];
  assert.closeTo(pA.positionAt(t0), plan.out.at, 1e-6, 'A on its out-point when B starts');
  assert.closeTo(pB.positionAt(t0), plan.in.at, 1e-9);
  await until(() => am.currentDeck === 1 && am.state === 'playing', 30000, 'handover');
  assert.equal(r.playlist.currentIndex, 0, 'the set list did not advance for the user song');
  await until(() => am.nextReady, 10000, 'next ready after the handover'); // (auto sync on the preloaded deck is off again)
  assert.deepEqual(log.takeovers, []);
  assert.deepEqual(log.errors, []);
  assert.deepEqual(log.deckErrors, []);
  r.done();
});

test('end to end: a meet transition (pre-ramp, ease back) then a cut (echo out, no sync) to the end of the set', async () => {
  const songsE2E = {
    m1: { bpm: 128, firstBeat: 0, seconds: 60 },
    m2: { bpm: 140, firstBeat: 0.02, seconds: 50 },
    m3: { bpm: null, firstBeat: 0, seconds: 40 },
  };
  const r = realRig({ songsE2E, items: ['m1', 'm2', 'm3'] });
  const { am, A, B, pA, pB, log, playlist } = r;
  assert(am.setEnabled(true));
  await until(() => am.state === 'playing' && am.nextReady, 10000, 'first song + next ready');
  const plan1 = am.plan;
  assert.equal(plan1.mode, 'meet');
  const target = Math.sqrt(128 * 140) / 128;
  assert.closeTo(plan1.tempo.curTargetRate, target, 1e-12);
  assert.closeTo(B.targetRate, (128 * target) / 140, 1e-12, 'B parked at the meet tempo');
  // the pre-ramp on the real deck (player ramps on the audio clock)
  await until(() => A.ramping, 120000, 'pre-ramp');
  assert.equal(A.tempoSource, 'auto');
  assert.equal(am.state, 'preparing');
  // (the clock players extrapolate forward only: check the trajectories while the mix is still ahead)
  await until(() => !!pB.last('playAt'), 60000, 'mix 1 scheduled');
  const t0 = pB.last('playAt')[1];
  assert(now() < t0);
  assert.closeTo(pA.positionAt(t0), plan1.out.at, 1e-6, 'A reaches its out-point at t0 (ramp included)');
  assert.closeTo(pB.positionAt(t0), plan1.in.at, 1e-9);
  await until(() => am.state === 'mixing', 5000, 'mix 1');
  assert.equal(A.ramping, false, 'the pre-ramp is over before the mix');
  assert.closeTo(A.rate, target, 1e-9);
  assert.closeTo(B.rate, (128 * target) / 140, 1e-9);
  await sleep(2000);
  assert.equal(B.synced, true);
  const T = now();
  assert.closeTo(B.beatsAt(pB.positionAt(T)) - plan1.in.beat, A.beatsAt(pA.positionAt(T)) - plan1.out.beat, 1e-4, 'in phase');
  await until(() => am.state === 'playing' && am.currentDeck === 1, 30000, 'handover 1');
  assert.equal(A.playing, false);
  assert.equal(B.mix.eq.low, 0, 'the new song keeps its bass');
  assert.equal(A.targetRate, 1, 'the old deck is back at 0 %');
  assert.equal(B.ramping, true, 'the new song eases back to its own tempo');
  assert.equal(B.targetRate, 1);
  assert.equal(playlist.currentIndex, 1);

  // m3 has no BPM: a cut with an echo out of m2
  await until(() => am.nextReady, 10000, 'next ready 2');
  const plan2 = am.plan;
  assert.equal(A.track.libraryId, 'm3');
  assert.equal(plan2.mode, 'cut');
  assert.equal(plan2.echoOut, true);
  assert.equal(plan2.beats, 8);
  assert.equal(A.mix.eq.low, 0, 'no bass cut for a cut');
  assert.equal(A.targetRate, 1);
  await until(() => !!pA.last('playAt'), 120000, 'mix 2 scheduled');
  const t0b = pA.last('playAt')[1];
  assert(now() < t0b);
  assert.closeTo(pB.positionAt(t0b), plan2.out.at, 1e-6);
  await until(() => am.state === 'mixing', 5000, 'mix 2');
  assert.equal(B.ramping, false, '(the ease back finished long before)');
  const dur = r.mixer.last('schedule')[4];
  assert.closeTo(dur, (8 * 60) / 140, 1e-6, '8 beats of m2 at its own tempo');
  await until(() => !B.playing, 5000, 'echo out stops m2');
  assert(now() < t0b + dur, 'within the blend');
  assert.equal(A.synced || B.synced, false, 'no sync in a cut');
  await until(() => am.currentDeck === 0 && am.state === 'playing', 10000, 'handover 2');
  assert.equal(am.nextItem, null, 'the last song');
  await until(() => log.finished === 1, 60000, 'finished');
  assert.equal(am.enabled, false);
  assert.equal(playlist.currentIndex, 2);
  assert.deepEqual(log.takeovers, []);
  assert.deepEqual(log.errors, []);
  assert.deepEqual(log.deckErrors, []);
  assert.deepEqual(log.syncErrors, []);
  r.done();
});
