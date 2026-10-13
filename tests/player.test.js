// Tests for the music player facade (src/deck/player.js) on the real AutoMix and Playlist with fake decks, mixer and
// sync on JsCheck's virtual clock (the same fakes as tests/automix.test.js): state transitions, now playing, up next /
// history, the shuffle / repeat / transition controls, play now / next / add to queue, and the Media Session calls
// (a stub navigator.mediaSession and MediaMetadata).
import { Emitter } from '../src/core/emitter.js';
import { hashHue } from '../src/core/util.js';
import { AutoMix } from '../src/deck/automix.js';
import { Playlist } from '../src/deck/playlist.js';
import { Player, PLAYER_ARTWORK } from '../src/deck/player.js';
import { crossfadeAt } from '../src/deck/automix-plan.js';
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

// ---- the player ------------------------------------------------------------------------------------------------

/** A Media Session stand-in that records what the player does with it. */
class StubSession {
  constructor({ refuse = [] } = {}) {
    this.handlers = {};
    this.refuse = new Set(refuse);
    this.metadata = null;
    this._ps = 'none';
    this.states = [];
    this.positions = [];
    this.metas = [];
  }
  get playbackState() {
    return this._ps;
  }
  set playbackState(v) {
    this._ps = v;
    this.states.push(v);
  }
  setActionHandler(action, fn) {
    if (this.refuse.has(action)) throw new TypeError(`${action} is not supported`);
    if (fn) this.handlers[action] = fn;
    else delete this.handlers[action];
  }
  setPositionState(p) {
    this.positions.push(p === undefined ? null : { ...p });
  }
}

class StubMetadata {
  constructor(init) {
    Object.assign(this, init);
    this.stub = true;
  }
}

function rig(opts = {}) {
  const s = setup({ start: false, ...opts });
  const ms = new StubSession(opts.session || {});
  const player = new Player({
    automix: s.am, playlist: s.playlist, decks: s.decks, engine: s.engine, settings: s.settings,
    deps: { mediaSession: ms, MediaMetadata: StubMetadata },
  });
  const events = [];
  player.on('change', (w) => events.push(w));
  const done = s.done;
  s.done = () => {
    player.dispose();
    done();
  };
  return { ...s, player, ms, events, done: s.done };
}

test('state: stopped -> loading -> playing -> paused -> playing -> mixing -> playing -> stopped (finished)', async () => {
  const r = rig({ items: ['s1', 's2'] });
  const { player, events } = r;
  const states = [];
  player.on('change', (w) => {
    if (w === 'state') states.push(player.state);
  });
  assert.equal(player.state, 'stopped');
  assert(player.play());
  assert.equal(player.state, 'loading');
  await until(() => player.state === 'playing', 5000, 'playing');
  assert(player.pause());
  assert.equal(player.state, 'paused');
  assert(player.toggle());
  assert.equal(player.state, 'playing');
  await until(() => player.state === 'mixing', 200000, 'mixing');
  await until(() => player.state === 'playing', 30000, 'after the mix');
  assert.equal(player.nowPlaying.item.id, 's2');
  await until(() => player.state === 'stopped', 200000, 'the end of the list');
  assert.deepEqual(states, ['loading', 'playing', 'paused', 'playing', 'mixing', 'playing', 'stopped']);
  assert(events.includes('track') && events.includes('transport') && events.includes('progress'));
  r.done();
});

test('nowPlaying, position, duration, upNext and history follow the queue', async () => {
  const r = rig({ items: ['s1', 's2', 's3'] });
  const { player, playlist } = r;
  const [a, b, c] = playlist.items;
  // stopped: the song play() would start, not loaded anywhere yet
  let np = player.nowPlaying;
  assert.equal(np.item, a);
  assert.equal(np.deckIndex, null);
  assert.equal(np.title, 'One');
  assert.equal(np.artist, '');
  assert.equal(np.bpm, null);
  assert.equal(np.hue, hashHue('One|'));
  assert.equal(player.nowPlaying, np, 'the same object while nothing changes');
  assert(Object.isFrozen(np));
  assert.deepEqual(player.upNext, [b, c]);
  assert.equal(player.upNext, player.upNext, 'cached');
  assert(Object.isFrozen(player.upNext));
  assert.deepEqual(player.history, []);
  assert.equal(player.position, 0);
  assert.equal(player.duration, 0, '(the fake library has no durations)');
  player.play();
  await until(() => player.state === 'playing' && r.am.nextReady, 5000, 'playing');
  np = player.nowPlaying;
  assert.equal(np.item, a);
  assert.equal(np.deckIndex, 0);
  assert.equal(np.bpm, 128);
  assert.equal(player.duration, 120);
  await sleep(10000);
  assert.closeTo(player.position, r.A.position, 1e-12);
  assert(player.position > 9.9);
  // skip: s2 on deck B becomes now playing, history has s1
  player.next();
  await until(() => player.state === 'playing' && r.am.currentDeck === 1, 5000, 'next');
  np = player.nowPlaying;
  assert.equal(np.item, b);
  assert.equal(np.deckIndex, 1);
  assert.equal(np.bpm, 126);
  assert.deepEqual(player.upNext, [c]);
  assert.deepEqual(player.history, [a]);
  player.jumpTo(c.uid);
  await until(() => player.nowPlaying.item === c && player.state === 'playing', 5000, 'jump');
  assert.deepEqual(player.upNext, []);
  assert.deepEqual(player.history, [b, a], 'most recent first');
  r.done();
});

test('controls: shuffle, repeat, transition, crossfade length (settings), play now / next / add to queue', async () => {
  const r = rig({ items: ['s1', 's2', 's3'], settings: { playerShuffle: false, playerRepeat: 'off', transitionStyle: 'dj', crossfadeSec: 6 } });
  const { player, playlist, settings, events } = r;
  assert.equal(player.shuffle, false);
  assert.equal(player.repeat, 'off');
  assert.equal(player.transition, 'dj');
  assert.equal(player.crossfadeSec, 6);
  player.setShuffle(true);
  assert.equal(player.shuffle, true);
  assert.equal(settings.get('playerShuffle'), true);
  player.setShuffle(false);
  assert.equal(player.cycleRepeat(), 'all');
  assert.equal(player.cycleRepeat(), 'one');
  assert.equal(player.cycleRepeat(), 'off');
  assert.equal(settings.get('playerRepeat'), 'off');
  assert.equal(player.setRepeat('sometimes'), false);
  assert(player.setRepeat('all'));
  assert.equal(player.repeat, 'all');
  assert(player.setTransition('gapless'));
  assert.equal(settings.get('transitionStyle'), 'gapless');
  assert.equal(player.setTransition('scratch'), false);
  assert.equal(player.transition, 'gapless');
  player.setCrossfadeSec(20);
  assert.equal(settings.get('crossfadeSec'), 12);
  player.setCrossfadeSec(7.3);
  assert.equal(player.crossfadeSec, 7.5);
  player.setCrossfadeSec(0);
  assert.equal(player.crossfadeSec, 2);
  assert(events.includes('mode'));
  // queue: add to the end, play next, play now
  const [s1] = playlist.items;
  const [x] = player.addToQueue({ kind: 'demo', id: 1 });
  assert.equal(playlist.items[3], x);
  const [y] = player.playNext({ id: 's4' });
  assert.equal(player.nowPlaying.item, s1, 'stopped: s1 is shown as ready');
  assert.equal(playlist.items[1], y, 'play next goes right after the song shown as ready...');
  assert.equal(player.upNext[0], y, '...so that one still plays first');
  assert(events.includes('queue'));
  player.setTransition('dj');
  // play now while stopped: in front of the ready song, which follows it
  const [w] = player.playNow({ id: 's2' });
  assert.equal(playlist.items[0], w);
  assert.equal(player.state, 'loading');
  await until(() => player.state === 'playing', 5000, 'playing');
  assert.equal(player.nowPlaying.item, w);
  assert.deepEqual(player.upNext.slice(0, 2), [s1, y]);
  assert.deepEqual(player.history, []);
  // play now while playing: right after the current song, at once (the queue goes on after it)
  const [z] = player.playNow({ id: 's3' });
  assert.equal(playlist.indexOf(z.uid), playlist.indexOf(w.uid) + 1, 'inserted right after the current song');
  assert.equal(player.state, 'loading', 'the song is being loaded');
  await until(() => player.nowPlaying.item === z && player.state === 'playing', 10000, 'playing it');
  assert.equal(r.am.currentDeck, 1);
  assert.deepEqual(player.history, [w]);
  assert.deepEqual(player.upNext.slice(0, 2), [s1, y]);
  // play next while playing: right after it
  const [v] = player.playNext({ id: 's1' });
  assert.equal(player.upNext[0], v);
  // clear queue: the whole Up next list in one change
  const n = events.length;
  const count = player.upNext.length;
  assert.equal(player.clearQueue(), count);
  assert.deepEqual(player.upNext, []);
  assert.equal(events.slice(n).filter((e) => e === 'queue').length, 1, 'one change');
  assert.equal(player.nowPlaying.item, z, 'the current song stays');
  assert.deepEqual(player.history, [w]);
  assert.equal(player.clearQueue(), 0);
  assert.equal(player.repeat, 'all');
  await until(() => r.am.nextItem === w, 5000, 'repeat all: the top of the list is next');
  player.setRepeat('off');
  await until(() => r.am.nextItem === null, 5000, 'nothing next');
  r.done();
});

test('Media Session: handlers, metadata, playbackState and position state', async () => {
  const r = rig({ items: ['s1', 's2'] });
  const { player, ms } = r;
  assert.deepEqual(Object.keys(ms.handlers).sort(), ['nexttrack', 'pause', 'play', 'previoustrack', 'seekto']);
  assert.equal(ms.metadata, null, 'stopped: nothing on the lock screen');
  assert.equal(ms.playbackState, 'none');
  ms.handlers.play();
  await until(() => player.state === 'playing', 5000, 'playing');
  assert(ms.metadata && ms.metadata.stub, 'a MediaMetadata object');
  assert.equal(ms.metadata.title, 'One');
  assert.equal(ms.metadata.artist, '');
  assert.equal(ms.metadata.album, 'TwinSpin');
  assert.deepEqual(ms.metadata.artwork, PLAYER_ARTWORK.map((a) => ({ ...a })));
  assert.equal(ms.metadata.artwork[0].src, 'icons/icon-192.png');
  assert.equal(ms.playbackState, 'playing');
  const pos = ms.positions[ms.positions.length - 1];
  assert.equal(pos.duration, 120);
  assert.equal(pos.playbackRate, 1);
  assert(pos.position >= 0 && pos.position <= 120);
  await sleep(20000);
  ms.handlers.pause();
  assert.equal(player.state, 'paused');
  assert.equal(ms.playbackState, 'paused');
  const p2 = ms.positions[ms.positions.length - 1];
  assert.closeTo(p2.position, r.A.position, 1e-9);
  ms.handlers.seekto({ seekTime: 42 });
  assert.closeTo(r.A.position, 42, 1e-9);
  assert.closeTo(ms.positions[ms.positions.length - 1].position, 42, 1e-9);
  ms.handlers.seekto({});
  assert.closeTo(r.A.position, 42, 1e-9, 'no seekTime: ignored');
  ms.handlers.play();
  assert.equal(ms.playbackState, 'playing');
  await until(() => r.am.nextReady, 5000, 'next ready');
  ms.handlers.nexttrack();
  await until(() => player.nowPlaying.item.id === 's2' && player.state === 'playing', 5000, 'next track');
  assert.equal(ms.metadata.title, 'Two');
  const p3 = ms.positions[ms.positions.length - 1];
  assert.equal(p3.duration, 100);
  ms.handlers.previoustrack();
  await until(() => player.nowPlaying.item.id === 's1' && player.state === 'playing', 5000, 'previous track');
  assert.equal(ms.metadata.title, 'One');
  // switched off: the lock screen is cleared
  r.am.setEnabled(false);
  assert.equal(player.state, 'stopped');
  assert.equal(ms.playbackState, 'none');
  assert.equal(ms.metadata, null);
  assert.equal(ms.positions[ms.positions.length - 1], null, 'position state cleared');
  // dispose hands the handlers back
  player.dispose();
  assert.deepEqual(Object.keys(ms.handlers), []);
  r.done();
});

test('Media Session is optional and every call is guarded', async () => {
  // no Media Session at all (JsCheck, old browsers): nothing breaks
  const bare = setup({ start: false });
  const p = new Player({ automix: bare.am, playlist: bare.playlist, decks: bare.decks, engine: bare.engine, settings: bare.settings, deps: { mediaSession: null } });
  assert(p.play());
  await until(() => p.state === 'playing', 5000, 'playing');
  p.pause();
  p.dispose();
  bare.done();
  // a session that refuses some actions, throws on setPositionState and has no MediaMetadata
  const r = rig({ session: { refuse: ['seekto', 'previoustrack'] } });
  r.ms.setPositionState = () => {
    throw new TypeError('bad position');
  };
  assert.deepEqual(Object.keys(r.ms.handlers).sort(), ['nexttrack', 'pause', 'play']);
  const q = new Player({ automix: r.am, playlist: r.playlist, decks: r.decks, settings: r.settings, deps: { mediaSession: r.ms, MediaMetadata: null } });
  r.player.play();
  await until(() => r.player.state === 'playing', 5000, 'playing');
  assert.equal(r.ms.metadata.title, 'One', 'a plain object when MediaMetadata is missing');
  assert.equal(r.ms.metadata.stub, undefined);
  q.dispose();
  // the default: navigator.mediaSession when the browser has one
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const ms = new StubSession();
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { mediaSession: ms }, configurable: true, writable: true });
    const d = new Player({ automix: r.am, playlist: r.playlist, decks: r.decks, settings: r.settings });
    assert.deepEqual(Object.keys(ms.handlers).sort(), ['nexttrack', 'pause', 'play', 'previoustrack', 'seekto']);
    assert.equal(ms.playbackState, 'playing');
    d.dispose();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete globalThis.navigator;
  }
  r.done();
});

test('stopped while a deck plays by hand: that song is now playing; play adopts it without a reload', async () => {
  const r = rig({ items: ['s1', 's2', 's3'] });
  r.B.loadFile({}, { libraryId: 's2' });
  await sleep(300);
  r.B.play();
  const np = r.player.nowPlaying;
  assert.equal(r.player.state, 'stopped');
  assert.equal(np.deckIndex, 1);
  assert.equal(np.item.id, 's2');
  assert.equal(np.bpm, 126);
  assert(r.player.play());
  assert.equal(r.player.state, 'playing');
  assert.equal(r.am.currentDeck, 1);
  assert.equal(r.B.calls.filter((c) => c[0] === 'loadFile').length, 1);
  assert.equal(r.player.nowPlaying.item.id, 's2');
  assert.deepEqual(r.player.upNext.map((x) => x.id), ['s3']);
  r.done();
});

test('the player during a mix: nowPlaying is the song being mixed out, seek is refused, next completes the mix', async () => {
  const r = rig({ items: ['s1', 's2', 's3'] });
  r.player.play();
  await until(() => r.player.state === 'mixing', 200000, 'mixing');
  assert.equal(r.player.nowPlaying.item.id, 's1');
  assert.equal(r.player.seek(30), false);
  const t0 = r.B.last('playAt')[1];
  await sleep(4000);
  // pause and resume keep the crossfade on its curve
  r.player.toggle();
  assert.equal(r.player.state, 'paused');
  const x = r.mixer.crossfader;
  assert.closeTo(x, crossfadeAt((now() - t0) / 15), 1e-9);
  r.player.toggle();
  assert.equal(r.player.state, 'mixing');
  r.player.next();
  assert.equal(r.player.state, 'playing');
  assert.equal(r.player.nowPlaying.item.id, 's2');
  assert.equal(r.player.nowPlaying.deckIndex, 1);
  assert.deepEqual(r.log.takeovers, []);
  r.done();
});
