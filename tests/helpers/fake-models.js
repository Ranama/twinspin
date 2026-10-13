// Fake engine / router / mixer / decks / sync / library for headless UI tests. They follow the contract APIs
// (docs/CONTRACT.md sections 2.6-2.8, 4, 4.2, 5, 7) closely enough for src/ui to run, and record calls.
//   const engine = new FakeEngine();  const decks = [new FakeDeck('A'), new FakeDeck('B')];

import { Emitter } from '../../src/core/emitter.js';

export class FakeRouter extends Emitter {
  constructor() {
    super();
    this.mode = 'single';
    this.modes = {
      single: { ok: true },
      dual: { ok: false, reason: 'Phones can only play to one output at a time.' },
      split: { ok: true, note: 'Turn off Mono audio and Dolby/spatial effects on the phone.' },
      remote: { ok: true, reason: null },
    };
    this.formFactor = 'phone';
    this.calls = [];
    this.masterDeviceId = 'default';
    this.cueDeviceId = '';
    this.alignmentMs = 0;
    this.splitSwap = false;
    this.remoteBus = 'cue';
  }

  get hint() {
    return this.mode === 'single' ? 'Headphone pre-listen needs a second output. Open Outputs.' : null;
  }

  describe() {
    return { single: 'Phone speaker', dual: 'Speaker + Headphones', split: 'Split cable', remote: 'Second device' }[this.mode];
  }

  setMode(m) {
    this.calls.push(['setMode', m]);
    return Promise.resolve().then(() => {
      if (!this.modes[m] || !this.modes[m].ok) {
        this.mode = 'single';
        this.emit('change', 'mode');
        this.emit('error', this.modes[m] ? this.modes[m].reason : 'bad mode');
        return;
      }
      this.mode = m;
      this.emit('change', 'mode');
    });
  }

  hasDeviceAccess() {
    return false;
  }

  accessInfo() {
    return { needed: true, method: 'mic', label: 'Show my speakers', text: 'Allow the microphone once.' };
  }

  requestDeviceAccess() {
    return Promise.resolve(false);
  }

  listOutputs() {
    return Promise.resolve([{ deviceId: 'default', label: 'System default', hint: null }]);
  }

  setMasterDevice(id) {
    this.masterDeviceId = id;
    return Promise.resolve();
  }

  setCueDevice(id) {
    this.cueDeviceId = id;
    return Promise.resolve();
  }

  setAlignmentMs(ms) {
    this.alignmentMs = ms;
  }

  setSplitSwap(on) {
    this.splitSwap = !!on;
    this.emit('change', 'splitSwap');
    return Promise.resolve();
  }

  test(which) {
    this.calls.push(['test', which]);
    return Promise.resolve();
  }

  getRemoteStream() {
    return {};
  }

  setRemoteBus(b) {
    this.remoteBus = b;
  }
}

const meter = () => ({ read: () => ({ peak: 0.4, rms: 0.2 }) });

export class FakeMixer {
  constructor() {
    this.channels = [{ meter: meter() }, { meter: meter() }];
    this.masterMeter = meter();
    this.cueMeter = meter();
    this.calls = [];
  }

  setCrossfader(x) {
    this.calls.push(['xf', x]);
  }

  setCrossfaderCurve(c) {
    this.calls.push(['curve', c]);
  }

  setMasterVolume(v) {
    this.calls.push(['master', v]);
  }

  setCueVolume(v) {
    this.calls.push(['cueVol', v]);
  }

  setCueMix(v) {
    this.calls.push(['cueMix', v]);
  }
}

export class FakeEngine extends Emitter {
  constructor() {
    super();
    this.ready = false;
    this.state = 'idle';
    this.mixer = null;
    this.outputs = null;
    this.players = [];
    this.startCalls = 0;
    this.restartCalls = 0;
  }

  start() {
    this.startCalls++;
    if (this._p) return this._p;
    this.state = 'starting';
    this._p = Promise.resolve().then(() => {
      this.mixer = new FakeMixer();
      this.outputs = new FakeRouter();
      this.ready = true;
      this.state = 'running';
      this.emit('ready');
    });
    return this._p;
  }

  restart() {
    this.restartCalls++;
    this.state = 'closed';
    this.emit('statechange', 'closed');
    return Promise.resolve().then(() => {
      this.mixer = new FakeMixer();
      this.outputs = new FakeRouter();
      this.state = 'running';
      this.emit('statechange', 'running');
      this.emit('restarted');
    });
  }

  resume() {
    this.state = 'running';
    this.emit('statechange', 'running');
    return Promise.resolve();
  }

  diagnostics() {
    return { sampleRate: 48000, baseLatency: 0.01, usingWorklet: true, state: this.state };
  }
}

export class FakeDeck extends Emitter {
  constructor(id) {
    super();
    this.id = id;
    this.index = id === 'A' ? 0 : 1;
    this.ready = true;
    this.track = null;
    this.loading = false;
    this.analyzing = false;
    this.playing = false;
    this.position = 0;
    this.duration = 0;
    this.audible = false;
    this.tempo = 0;
    this.tempoRange = 0.08;
    this.rate = 1;
    this.bpm = null;
    this.effectiveBpm = null;
    this.beatLength = null;
    this.cuePoint = 0;
    this.loop = { active: false, beats: 4, start: 0, end: 0 };
    this.synced = false;
    this.scratching = false;
    this.vinyl = true;
    this.fx = { echo: false, reverb: false, flanger: false, crush: false, amount: 0.5 };
    this.mix = { volume: 0.8, eq: { low: 0, mid: 0, high: 0 }, filter: 0, trimDb: 0, cue: false };
    this.calls = [];
  }

  _c(name, ...args) {
    this.calls.push([name, ...args]);
  }

  count(name) {
    return this.calls.filter((c) => c[0] === name).length;
  }

  loadFile(file, meta) {
    this._c('loadFile', file, meta);
    this.track = {
      id: 't1', title: (meta && meta.title) || 'Song', artist: 'Artist', fileName: file && file.name, source: 'file', duration: 200,
      sampleRate: 44100, bpm: 124, bpmDetected: 124, firstBeat: 0.1, confidence: 0.9, variable: false, alternatives: [],
      waveform: null, gainDb: 0, hue: 200, libraryId: meta && meta.libraryId,
    };
    this.duration = 200;
    this.bpm = 124;
    this.effectiveBpm = 124;
    this.emit('change', 'track');
    return Promise.resolve();
  }

  loadDemo(id) {
    this._c('loadDemo', id);
    return this.loadFile({ name: '' }, { title: id ? 'Spore Garden' : 'Neon Drift' });
  }

  eject() {
    this._c('eject');
    this.track = null;
    this.emit('change', 'track');
  }

  togglePlay() {
    this._c('togglePlay');
    this.playing = !this.playing;
    this.emit('change', 'transport');
  }

  play() {
    this._c('play');
  }

  pause() {
    this._c('pause');
  }

  cueDown() {
    this._c('cueDown');
  }

  cueUp() {
    this._c('cueUp');
  }

  seek(s) {
    this._c('seek', s);
  }

  seekFraction(f) {
    this._c('seekFraction', f);
  }

  brake() {
    this._c('brake');
  }

  echoOut() {
    this._c('echoOut');
  }

  setTempo(v) {
    this._c('setTempo', v);
    this.tempo = v;
  }

  resetTempo() {
    this._c('resetTempo');
  }

  setTempoRange(r) {
    this._c('setTempoRange', r);
    this.tempoRange = r;
  }

  applySyncRate(r) {
    this.rate = r;
  }

  setBend(v) {
    this._c('setBend', v);
  }

  scratchBegin() {}

  scratchMove() {}

  scratchEnd() {}

  setVinyl(on) {
    this.vinyl = on;
  }

  toggleLoop(n) {
    this._c('toggleLoop', n);
  }

  loopHalve() {}

  loopDouble() {}

  exitLoop() {}

  doubleBpm() {
    this._c('doubleBpm');
  }

  halveBpm() {
    this._c('halveBpm');
  }

  tapTempo() {
    this._c('tapTempo');
  }

  beatPhase() {
    return 0;
  }

  setFx(name, on) {
    this._c('setFx', name, on);
    this.fx = { ...this.fx, [name]: on };
    this.emit('change', 'fx');
  }

  setFxAmount(v) {
    this.fx = { ...this.fx, amount: v };
  }

  setVolume(v) {
    this.mix = { ...this.mix, volume: v };
  }

  setEq(b, v) {
    this.mix = { ...this.mix, eq: { ...this.mix.eq, [b]: v } };
  }

  setFilter(v) {
    this.mix = { ...this.mix, filter: v };
  }

  setTrimDb(db) {
    this.mix = { ...this.mix, trimDb: db };
  }

  setCue(on) {
    this._c('setCue', on);
    this.mix = { ...this.mix, cue: on };
    this.emit('change', 'mix');
  }
}

export class FakeSync extends Emitter {
  constructor(decks) {
    super();
    this.decks = decks;
    this.calls = [];
  }

  toggle(i) {
    this.calls.push(['toggle', i]);
  }

  setSync(i, on) {
    this.calls.push(['setSync', i, on]);
  }

  isSynced() {
    return false;
  }

  leaderOf(i) {
    return 1 - i;
  }

  resetTempo(i) {
    this.calls.push(['resetTempo', i]);
  }
}

export class FakeLibrary extends Emitter {
  constructor() {
    super();
    this.persistent = true;
    this.entries = [];
    this.calls = [];
  }

  init() {
    return Promise.resolve();
  }

  list() {
    return this.entries.map((e) => ({ ...e })).concat([{ id: 'demo-0', demo: true, source: 'demo', title: 'Neon Drift', bpm: 124 }]);
  }

  add(files) {
    this.calls.push(['add', files.length]);
    const songs = files.filter((f) => /^audio\//.test(f.type || '') || /\.(mp3|wav|m4a|flac|ogg)$/i.test(f.name || ''));
    if (songs.length < files.length) this.emit('error', 'Some files are not song files, so they were skipped.');
    const out = songs.map((f, i) => ({ id: `s${this.entries.length + i + 1}`, title: '', artist: '', fileName: f.name, size: f.size, addedAt: 1 }));
    this.entries.push(...out);
    this.emit('change');
    return Promise.resolve(out);
  }

  getBlob(id) {
    this.calls.push(['getBlob', id]);
    return Promise.resolve({ size: 10, type: 'audio/mpeg', name: 'blob.mp3' });
  }

  update(id, patch) {
    this.calls.push(['update', id, patch]);
    return Promise.resolve();
  }

  remove(id) {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.emit('change');
    return Promise.resolve();
  }

  clear() {
    this.entries = [];
    this.emit('change');
    return Promise.resolve();
  }

  usage() {
    return Promise.resolve({ usedBytes: 5e6, quotaBytes: 2e9 });
  }
}

