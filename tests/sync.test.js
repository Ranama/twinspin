// Tests for SyncController (src/deck/sync.js) with fake decks whose positions run on JsCheck's virtual clock.
import { Emitter } from '../src/core/emitter.js';
import { SyncController } from '../src/deck/sync.js';
import { phaseError } from '../src/deck/sync-math.js';

const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal Deck stand-in: position integrates (rate + bend) over virtual time while playing. */
class FakeDeck extends Emitter {
  constructor(id, { bpm = 120, firstBeat = 0, duration = 600, variable = false } = {}) {
    super();
    this.id = id;
    this.track = bpm === undefined ? null : { bpm, firstBeat, duration, variable };
    this.rate = 1;
    this.playing = false;
    this.synced = false;
    this.scratching = false;
    this.loading = false;
    this.restoring = false;
    this.lastJumpAt = -Infinity;
    this._bend = 0;
    this._pos = 0;
    this._t = now();
    this.seeks = [];
    this.bendLog = [];
    this.resets = 0;
  }
  get bpm() {
    return this.track && this.track.bpm > 0 ? this.track.bpm : null;
  }
  get effectiveBpm() {
    return this.bpm ? this.bpm * this.rate : null;
  }
  get bend() {
    return this._bend;
  }
  get position() {
    this._adv();
    return this._pos;
  }
  _adv() {
    const t = now();
    if (this.playing && !this.scratching) this._pos += ((this.rate + this._bend) * (t - this._t)) / 1000;
    this._t = t;
  }
  setPos(p) {
    this._adv();
    this._pos = p;
  }
  play() {
    this._adv();
    this.playing = true;
    this.emit('change', 'transport');
  }
  pause() {
    this._adv();
    this.playing = false;
    this.emit('change', 'transport');
  }
  seek(p, opts) {
    this._adv();
    this._pos = p;
    this.seeks.push({ p, source: opts && opts.source });
    this.lastJumpAt = now();
  }
  setBend(v, source) {
    this._adv();
    if (source === 'sync') this._bend = v;
    this.bendLog.push([v, source]);
  }
  applySyncRate(r) {
    this._adv();
    this.rate = r;
    this.emit('change', 'tempo');
  }
  setSynced(on) {
    if (this.synced === !!on) return;
    this.synced = !!on;
    if (!on) this._bend = 0;
    this.emit('change', 'sync');
  }
  setTempo(v) {
    this.emit('tempoTouched');
    this._adv();
    this.rate = 1 + v * 0.08;
  }
  resetTempo() {
    this.emit('tempoTouched');
    this._adv();
    this.rate = 1;
    this.resets++;
  }
}

function settingsWith(values = {}) {
  const v = { autoSync: true, ...values };
  return { get: (k) => v[k], set: (k, x) => (v[k] = x) };
}

function setup(a = {}, b = {}, settings = settingsWith(), deps = {}) {
  const A = new FakeDeck('A', a);
  const B = new FakeDeck('B', b);
  const sync = new SyncController([A, B], settings, deps);
  const errors = [];
  sync.on('error', (m) => errors.push(m));
  return { A, B, sync, errors };
}

const grid = (d) => ({ pos: d.position, bpm: d.bpm, firstBeat: d.track.firstBeat });
const err = (slave, leader, m = 1) => phaseError(grid(slave), grid(leader), m);

test('enable while both play: tempo matched and phase aligned with a sync seek', async () => {
  const { A, B, sync, errors } = setup({ bpm: 128, firstBeat: 0.11 }, { bpm: 125, firstBeat: 0.3 });
  A.setPos(20.37);
  B.setPos(10.13);
  A.play();
  B.play();
  await sleep(100);
  assert.equal(sync.toggle(1), true);
  assert.deepEqual(errors, []);
  assert(B.synced && !A.synced);
  assert.equal(sync.isSynced(1), true);
  assert.equal(sync.leaderOf(1), 0);
  assert.equal(sync.leaderOf(0), null);
  assert.closeTo(B.rate, 128 / 125, 1e-12);
  assert.equal(B.seeks.length, 1);
  assert.equal(B.seeks[0].source, 'sync');
  assert(Math.abs(err(B, A)) < 1e-6, `phase error after align ${err(B, A)}`);
  // they stay locked
  await sleep(3000);
  assert(Math.abs(err(B, A)) < 0.01);
  sync.dispose();
});

test('errors: no song, no tempo; the leader that follows this deck is switched off first', () => {
  const s1 = setup({ bpm: 128 }, { bpm: null });
  assert.equal(s1.sync.setSync(1, true), false);
  assert.match(s1.errors[0], /Deck B has no tempo yet\. Wait for the BPM or tap it in\./);
  assert.equal(s1.sync.setSync(0, true), false);
  assert.match(s1.errors[1], /Deck B has no tempo yet/);
  assert(!s1.A.synced && !s1.B.synced);

  const s2 = setup({ bpm: 128 }, { bpm: 120 });
  s2.A.track = null;
  s2.sync.toggle(1);
  assert.match(s2.errors[0], /Load a song on deck A/);
  s2.sync.toggle(0);
  assert.match(s2.errors[1], /Load a song on deck A first/);

  const s3 = setup({ bpm: 128 }, { bpm: 120 });
  assert(s3.sync.setSync(1, true));
  assert(s3.B.synced);
  assert(s3.sync.setSync(0, true));
  assert(s3.A.synced && !s3.B.synced, 'B (which followed A) was switched off');
  assert.closeTo(s3.A.rate, (120 * (128 / 120)) / 128, 1e-12); // B now runs at 128/120 -> eff 128
  s3.sync.dispose();
});

test('the slave follows the leader tempo every 30 ms; disabling keeps the tempo', async () => {
  const { A, B, sync } = setup({ bpm: 126 }, { bpm: 120 });
  let changes = 0;
  sync.on('change', () => changes++);
  sync.setSync(1, true);
  assert.equal(changes, 1);
  assert.closeTo(B.rate, 126 / 120, 1e-12);
  A.rate = 1.04;
  await sleep(40);
  assert.closeTo(B.rate, (126 * 1.04) / 120, 1e-12);
  sync.toggle(1);
  assert(!B.synced);
  assert.equal(changes, 2);
  A.rate = 0.97;
  await sleep(100);
  assert.closeTo(B.rate, (126 * 1.04) / 120, 1e-12, 'unlatched: tempo stays');
  assert.equal(sync._timer, null, 'timer stops when nothing is synced');
});

test('half and double time use the multiplier for tempo and phase', async () => {
  const { A, B, sync } = setup({ bpm: 140, firstBeat: 0.2 }, { bpm: 72, firstBeat: 0.05 });
  A.setPos(30.111);
  B.setPos(12.5);
  A.play();
  B.play();
  sync.setSync(1, true);
  assert.closeTo(B.rate, (140 * 0.5) / 72, 1e-12);
  assert(Math.abs(err(B, A, 0.5)) < 1e-6);
  await sleep(2000);
  assert(Math.abs(err(B, A, 0.5)) < 0.01);
  sync.dispose();
});

test('phase correction: a small error is pulled in by a bend, not a jump', async () => {
  const { A, B, sync } = setup({ bpm: 120 }, { bpm: 120 });
  A.setPos(40);
  B.setPos(10);
  A.play();
  B.play();
  sync.setSync(1, true);
  await sleep(300);
  // push the slave 0.05 beat ahead (an outside drift, not a seek)
  B.setPos(B.position + 0.05 * 0.5);
  const seeks = B.seeks.length;
  await sleep(35);
  const e0 = err(B, A);
  assert(e0 > 0.04, `error ${e0}`);
  assert(B.bend < 0, 'slave ahead -> slows down');
  assert(B.bend >= -0.015);
  await sleep(6000);
  assert(Math.abs(err(B, A)) < 0.006, `error after 6 s ${err(B, A)}`);
  assert.equal(B.seeks.length, seeks, 'no hard re-align for a small error');
  sync.dispose();
});

test('hard re-align after 0.5 s more than 0.2 beat off', async () => {
  const { A, B, sync } = setup({ bpm: 120 }, { bpm: 120 });
  A.setPos(40);
  B.setPos(10);
  A.play();
  B.play();
  sync.setSync(1, true);
  await sleep(300);
  const n = B.seeks.length;
  B.setPos(B.position + 0.35 * 0.5);
  await sleep(300);
  assert.equal(B.seeks.length, n, 'not yet');
  await sleep(400);
  assert.equal(B.seeks.length, n + 1, 're-aligned');
  assert.equal(B.seeks[n].source, 'sync');
  assert(Math.abs(err(B, A)) < 0.02);
  sync.dispose();
});

test('variable-tempo tracks get tempo sync only', async () => {
  const { A, B, sync } = setup({ bpm: 100 }, { bpm: 104, variable: true });
  A.setPos(5.123);
  B.setPos(9);
  A.play();
  B.play();
  sync.setSync(1, true);
  assert.closeTo(B.rate, 100 / 104, 1e-12);
  assert.equal(B.seeks.length, 0);
  await sleep(1000);
  assert.equal(B.seeks.length, 0);
  assert.equal(B.bend, 0);
  sync.dispose();
});

test('a paused slave is aligned the moment it starts playing', async () => {
  const { A, B, sync } = setup({ bpm: 124, firstBeat: 0.02 }, { bpm: 124, firstBeat: 0.1 });
  A.setPos(33.3);
  A.play();
  B.setPos(8.77);
  sync.setSync(1, true);
  assert.equal(B.seeks.length, 0, 'paused: no jump yet');
  await sleep(500);
  B.play();
  assert.equal(B.seeks.length, 1);
  assert(Math.abs(err(B, A)) < 1e-6);
  sync.dispose();
});

test('no phase correction while scratching or within 150 ms of a jump', async () => {
  const { A, B, sync } = setup({ bpm: 120 }, { bpm: 120 });
  A.setPos(40);
  B.setPos(10);
  A.play();
  B.play();
  sync.setSync(1, true);
  await sleep(300);
  A.seek(A.position + 0.1); // leader jumps (e.g. a loop wrap or the user scrubbed)
  await sleep(40);
  assert.equal(B.bend, 0, 'settling after the leader jumped');
  await sleep(130);
  assert(B.bend !== 0, 'corrects again after the settle time');
  B.scratching = true;
  await sleep(40);
  assert.equal(B.bend, 0);
  B.scratching = false;
  sync.dispose();
});

test('user tempo on the slave, a new song on either deck, or eject switch sync off', () => {
  const s = setup({ bpm: 128 }, { bpm: 120 });
  s.sync.setSync(1, true);
  s.A.setTempo(0.5); // leader tempo move: slave keeps following
  assert(s.B.synced);
  s.B.setTempo(0.2);
  assert(!s.B.synced);

  s.sync.setSync(1, true);
  s.A.loading = true;
  s.A.restoring = true;
  s.A.emit('change', 'loading'); // re-loading after an audio restart: keep sync
  assert(s.B.synced);
  s.A.restoring = false;
  s.A.emit('change', 'loading'); // a new song on the leader
  assert(!s.B.synced);
  s.A.loading = false;

  s.sync.setSync(1, true);
  s.B.track = null;
  s.B.emit('change', 'track'); // eject
  assert(!s.B.synced);
  s.sync.dispose();
});

test('SYNC long-press resets the tempo and drops sync', () => {
  const { B, sync } = setup({ bpm: 128 }, { bpm: 120 });
  sync.setSync(1, true);
  sync.resetTempo(1);
  assert(!B.synced);
  assert.equal(B.rate, 1);
  assert.equal(B.resets, 1);
});

test('auto sync: a stopped deck syncs when its BPM arrives and the other deck plays', () => {
  const s = setup({ bpm: 126 }, { bpm: 120 });
  s.A.play();
  s.B.emit('analyzed');
  assert(s.B.synced);
  assert.closeTo(s.B.rate, 126 / 120, 1e-12);
  s.sync.dispose();

  const off = setup({ bpm: 126 }, { bpm: 120 }, settingsWith({ autoSync: false }));
  off.A.play();
  off.B.emit('analyzed');
  assert(!off.B.synced);

  const playing = setup({ bpm: 126 }, { bpm: 120 });
  playing.A.play();
  playing.B.play();
  playing.B.emit('analyzed'); // the deck was already playing: leave it alone
  assert(!playing.B.synced);

  const idle = setup({ bpm: 126 }, { bpm: 120 });
  idle.B.emit('analyzed'); // the other deck is not playing
  assert(!idle.B.synced);
  assert.deepEqual(idle.errors, []);
});

test('nothing is followed while the page is hidden', async () => {
  let hidden = false;
  const { A, B, sync } = setup({ bpm: 120 }, { bpm: 120 }, settingsWith(), { hidden: () => hidden });
  sync.setSync(1, true);
  hidden = true;
  A.rate = 1.05;
  await sleep(200);
  assert.equal(B.rate, 1);
  hidden = false;
  await sleep(40);
  assert.closeTo(B.rate, 1.05, 1e-12);
  sync.dispose();
});

test('a BPM change on the slave (x2) re-picks the multiplier', async () => {
  const { A, B, sync } = setup({ bpm: 128 }, { bpm: 64 });
  sync.setSync(1, true);
  assert.closeTo(B.rate, 1, 1e-12); // 64 follows 128 at double time
  B.track.bpm = 128;
  await sleep(40);
  assert.closeTo(B.rate, 1, 1e-12);
  assert.equal(sync._mult[1], 1);
  sync.dispose();
});

// ---- beat maps and exact alignment on the audio clock (docs/AUTOMIX.md 4.2) --------------------------------------

/** A FakeDeck on the audio clock (= the virtual clock): positionAt(t), seekAt(pos, t), scheduled starts. */
class ClockDeck extends FakeDeck {
  constructor(id, opts = {}) {
    super(id, opts);
    this.jumps = [];
    this.pendingAt = null;
  }
  get audioTime() {
    return now() / 1000;
  }
  get scheduledAt() {
    return this.pendingAt !== null && this.pendingAt > now() / 1000 ? this.pendingAt : null;
  }
  positionAt(t) {
    const p = this.position;
    return this.playing && !this.scratching ? p + (this.rate + this.bend) * (t - now() / 1000) : p;
  }
  seekAt(p, t, opts) {
    this.jumps.push({ p, t, source: opts && opts.source });
    this.pendingAt = t;
    this.lastJumpAt = t * 1000;
    setTimeout(() => {
      this._adv();
      this._pos = p + (this.playing ? (this.rate + this._bend) * (now() / 1000 - t) : 0);
      this.pendingAt = null;
    }, Math.max(0, (t - now() / 1000) * 1000));
  }
}

function clockSetup(a, b) {
  const A = new ClockDeck('A', a);
  const B = new ClockDeck('B', b);
  const sync = new SyncController([A, B], settingsWith());
  return { A, B, sync };
}

test('exact alignment: the slave jump is scheduled 0.1 s ahead on the audio clock and lands in phase', async () => {
  const { A, B, sync } = clockSetup({ bpm: 128, firstBeat: 0.11 }, { bpm: 125, firstBeat: 0.3 });
  A.setPos(20.37);
  B.setPos(10.13);
  A.play();
  B.play();
  await sleep(100);
  const t = now() / 1000;
  sync.setSync(1, true);
  assert.equal(B.seeks.length, 0, 'no immediate jump');
  assert.equal(B.jumps.length, 1);
  assert.closeTo(B.jumps[0].t, t + 0.1, 1e-9);
  assert.equal(B.jumps[0].source, 'sync');
  // where both decks are at that moment: in phase
  const at = B.jumps[0].t;
  const sg = { pos: B.jumps[0].p, bpm: 125, firstBeat: 0.3 };
  const lg = { pos: A.positionAt(at), bpm: 128, firstBeat: 0.11 };
  assert(Math.abs(phaseError(sg, lg, 1)) < 1e-9);
  await sleep(150);
  assert(Math.abs(err(B, A)) < 1e-6, `after the jump ${err(B, A)}`);
  await sleep(2000);
  assert(Math.abs(err(B, A)) < 0.005);
  assert.equal(B.seeks.length, 0, 'no hard re-align needed');
  sync.dispose();
});

test('setSync with { align: false } and a pending scheduled start: no alignment jump', async () => {
  const { A, B, sync } = clockSetup({ bpm: 120 }, { bpm: 120 });
  A.setPos(40);
  B.setPos(10.2);
  A.play();
  B.play();
  sync.setSync(1, true, { align: false });
  assert.equal(B.jumps.length + B.seeks.length, 0);
  sync.setSync(1, false);
  // a slave whose start is scheduled (Auto Mix): no jump, and no phase correction until it runs
  B.pause();
  B.pendingAt = now() / 1000 + 0.5;
  B.play();
  sync.setSync(1, true);
  assert.equal(B.jumps.length + B.seeks.length, 0);
  await sleep(300);
  assert.equal(B.bend, 0, 'no bend while the start is pending');
  await sleep(500);
  assert(B.bend !== 0, 'phase keeping once it runs');
  sync.dispose();
});

test('a variable-tempo track WITH a beat map gets phase lock; the map decides the phase', async () => {
  // the slave drifts: its beats follow a map that runs 0.4 % fast against its average bpm
  const map = Float64Array.from({ length: 400 }, (_, k) => 0.05 + (k * 60) / (104 * 1.004));
  const { A, B, sync } = clockSetup({ bpm: 100 }, { bpm: 104, variable: true });
  B.track.beats = map;
  A.setPos(5.123);
  B.setPos(30);
  A.play();
  B.play();
  sync.setSync(1, true);
  assert.equal(B.jumps.length, 1, 'aligned');
  const j = B.jumps[0];
  const atJump = phaseError({ pos: j.p, bpm: 104, firstBeat: 0, beats: map }, { pos: A.positionAt(j.t), bpm: 100, firstBeat: 0 }, 1);
  assert(Math.abs(atJump) < 1e-9, `map phase at the jump ${atJump}`);
  await sleep(150);
  const mapErr = () => phaseError({ pos: B.position, bpm: 104, firstBeat: 0, beats: map }, grid(A), 1);
  assert(Math.abs(mapErr()) < 0.002, `map phase ${mapErr()}`);
  await sleep(1500);
  assert(Math.abs(mapErr()) < 0.01);
  assert(B.bend !== 0 || Math.abs(mapErr()) < 1e-3, 'phase lock runs');
  sync.dispose();
  // without a map a variable track still gets tempo sync only
  const v = clockSetup({ bpm: 100 }, { bpm: 104, variable: true });
  v.A.play();
  v.B.play();
  v.sync.setSync(1, true);
  assert.equal(v.B.jumps.length + v.B.seeks.length, 0);
  v.sync.dispose();
});
