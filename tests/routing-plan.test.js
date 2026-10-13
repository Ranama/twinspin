// Tests for src/audio/routing-plan.js (every platform combination) and src/audio/outputs.js (OutputRouter wiring
// against a fake Web Audio graph: what reaches which output in each mode, device flows, fallbacks).

import {
  availableModes, deviceLabelHint, dedupeOutputs, sameOutput, resolveOutput, sinkIdOf, alignmentDelays, splitSides,
  describeRouting, friendlySinkError, friendlyAccessError, formFactorOf, MODES, SINGLE_HINT,
} from '../src/audio/routing-plan.js';
import { OutputRouter } from '../src/audio/outputs.js';
import { sharedHost } from '../src/remote/remote-host.js';
import { Settings } from '../src/core/settings.js';

// ------------------------------------------------------------------------------------------------ environments

const BASE = {
  secure: true, ios: false, android: false, mobile: false, safari: false, firefox: false, standalone: false,
  embedded: false, preview: false, touch: false, audioWorklet: true, ctxSetSinkId: false, mediaSetSinkId: false,
  selectAudioOutput: false, enumerateDevices: true, getUserMedia: true, webrtc: true, serviceWorker: true,
  wakeLock: true, vibrate: false, audioSession: false, moduleWorker: true,
};
const ENV = {
  chromeDesktop: { ...BASE, ctxSetSinkId: true, mediaSetSinkId: true },
  edgeDesktop: { ...BASE, ctxSetSinkId: true, mediaSetSinkId: true },
  firefoxDesktop: { ...BASE, firefox: true, mediaSetSinkId: true, selectAudioOutput: true },
  safariMac184: { ...BASE, safari: true, mediaSetSinkId: true, audioSession: true },
  safariMacOld: { ...BASE, safari: true, audioSession: true },
  iphone: { ...BASE, ios: true, mobile: true, safari: true, touch: true, mediaSetSinkId: true, audioSession: true },
  ipad: { ...BASE, ios: true, mobile: true, safari: true, touch: true, mediaSetSinkId: true, audioSession: true },
  androidChrome: { ...BASE, android: true, mobile: true, touch: true, ctxSetSinkId: true, vibrate: true },
  androidFirefox: { ...BASE, android: true, mobile: true, firefox: true, touch: true, vibrate: true },
  samsungInternet: { ...BASE, android: true, mobile: true, touch: true, ctxSetSinkId: true, vibrate: true },
  androidDesktopForm: { ...BASE, android: true, mobile: true, touch: true, ctxSetSinkId: true, mediaSetSinkId: true },
  httpLanDesktop: { ...BASE, secure: false, enumerateDevices: false, getUserMedia: false, wakeLock: false },
  httpLanPhone: { ...BASE, secure: false, android: true, mobile: true, enumerateDevices: false, getUserMedia: false },
  preview: { ...BASE, preview: true, embedded: true, webrtc: false, ctxSetSinkId: true, mediaSetSinkId: true },
  noWebrtcDesktop: { ...BASE, webrtc: false, ctxSetSinkId: true, mediaSetSinkId: true },
  noWebrtcPhone: { ...BASE, webrtc: false, android: true, mobile: true },
};

// ------------------------------------------------------------------------------------------------ routing-plan

test('desktop browsers with setSinkId get every mode', () => {
  for (const name of ['chromeDesktop', 'edgeDesktop', 'firefoxDesktop', 'safariMac184', 'androidDesktopForm']) {
    const m = availableModes(ENV[name], { formFactor: name === 'androidDesktopForm' ? 'tablet' : 'computer' });
    assert(m.single.ok, name);
    assert(m.dual.ok, `${name}: ${m.dual.reason}`);
    assert.equal(m.dual.reason, null);
    assert(m.split.ok, name);
    assert(m.remote.ok, name);
  }
});

test('phones: one output only, suggest Split cable or Second device', () => {
  for (const name of ['androidChrome', 'androidFirefox', 'samsungInternet']) {
    const m = availableModes(ENV[name]);
    assert(!m.dual.ok, name);
    assert.match(m.dual.reason, /^Phones can only play to one output at a time\./);
    assert.match(m.dual.reason, /Split cable or Second device/);
    assert(m.split.ok && m.remote.ok, name);
    assert.match(m.split.note, /Mono audio/);
    assert.match(m.split.note, /on the phone/);
  }
  const tab = availableModes(ENV.androidChrome, { formFactor: 'tablet' });
  assert.match(tab.dual.reason, /^Tablets can only play/);
});

test('iOS and iPadOS never get two outputs, even though setSinkId exists', () => {
  const phone = availableModes(ENV.iphone, { formFactor: 'phone' });
  assert(!phone.dual.ok);
  assert.match(phone.dual.reason, /^iPhones play everything through one output/);
  assert.match(phone.dual.reason, /Second device/);
  const pad = availableModes(ENV.ipad, { formFactor: 'tablet' });
  assert(!pad.dual.ok);
  assert.match(pad.dual.reason, /^iPads /);
  assert(pad.remote.ok && pad.split.ok);
});

test('preview and iframes: no two outputs, no second device', () => {
  const p = availableModes(ENV.preview, { topLevel: false });
  assert(!p.dual.ok && !p.remote.ok);
  assert.match(p.dual.reason, /preview/);
  assert.match(p.remote.reason, /preview/);
  const f = availableModes(ENV.chromeDesktop, { topLevel: false, formFactor: 'computer' });
  assert(!f.dual.ok && !f.remote.ok);
  assert.match(f.dual.reason, /own browser tab/);
  assert.match(f.remote.reason, /own browser tab/);
  assert(f.split.ok && f.single.ok);
});

test('insecure http and missing APIs', () => {
  const d = availableModes(ENV.httpLanDesktop, { formFactor: 'computer' });
  assert(!d.dual.ok);
  assert.match(d.dual.reason, /https/);
  assert(!d.remote.ok);
  assert.match(d.remote.reason, /https/);
  const ph = availableModes(ENV.httpLanPhone);
  assert.match(ph.dual.reason, /^Phones can only/, 'the phone limit is the real reason');
  const old = availableModes(ENV.safariMacOld, { formFactor: 'computer' });
  assert(!old.dual.ok);
  assert.match(old.dual.reason, /can't send sound to a chosen speaker/);
  const nowr = availableModes(ENV.noWebrtcDesktop, { formFactor: 'computer' });
  assert(nowr.dual.ok);
  assert(!nowr.remote.ok);
  assert.match(nowr.remote.reason, /can't stream sound/);
  const nowrPhone = availableModes(ENV.noWebrtcPhone);
  assert.match(nowrPhone.dual.reason, /use Split cable\.$/, 'no Second device suggestion without WebRTC');
  const noEnum = availableModes({ ...ENV.chromeDesktop, enumerateDevices: false }, { formFactor: 'computer' });
  assert(!noEnum.dual.ok);
  assert.match(noEnum.dual.reason, /can't list your speakers/);
  const empty = availableModes(undefined);
  assert(empty.single.ok && !empty.dual.ok && !empty.remote.ok);
});

test('form factor', () => {
  assert.equal(formFactorOf(ENV.chromeDesktop, 1080), 'computer');
  assert.equal(formFactorOf(ENV.iphone, 390), 'phone');
  assert.equal(formFactorOf(ENV.ipad, 820), 'tablet');
  assert.equal(formFactorOf(ENV.androidChrome), 'phone');
  assert.deepEqual(MODES, ['single', 'dual', 'split', 'remote']);
});

test('device label hints', () => {
  assert.match(deviceLabelHint('Headset (WH-1000XM4 Hands-Free AG Audio)'), /^Hands-free/);
  assert.match(deviceLabelHint('Bose QC Handsfree'), /^Hands-free/);
  assert.match(deviceLabelHint('Headset Earphone (HyperX Cloud)'), /Bluetooth headset/);
  assert.match(deviceLabelHint('Communications - Speakers (Realtek)'), /calls device/);
  assert.match(deviceLabelHint('AirPods'), /AirPods/);
  assert.match(deviceLabelHint('JBL Flip 5 (Bluetooth)'), /Bluetooth adds a delay/);
  assert.equal(deviceLabelHint('Speakers (Realtek(R) Audio)'), null);
  assert.equal(deviceLabelHint('Headphones (WH-1000XM4 Stereo)'), null);
  assert.equal(deviceLabelHint(''), null);
  assert.equal(deviceLabelHint(undefined), null);
});

const WIN_CHROME = [
  { kind: 'audioinput', deviceId: 'mic1', label: 'Microphone (Realtek)', groupId: 'g1' },
  { kind: 'audiooutput', deviceId: 'default', label: 'Default - Speakers (Realtek(R) Audio)', groupId: 'g1' },
  { kind: 'audiooutput', deviceId: 'communications', label: 'Communications - Headset (WH-1000XM4 Hands-Free AG Audio)', groupId: 'g2' },
  { kind: 'audiooutput', deviceId: 'spk', label: 'Speakers (Realtek(R) Audio)', groupId: 'g1' },
  { kind: 'audiooutput', deviceId: 'bt-hf', label: 'Headset (WH-1000XM4 Hands-Free AG Audio)', groupId: 'g2' },
  { kind: 'audiooutput', deviceId: 'bt-st', label: 'Headphones (WH-1000XM4 Stereo)', groupId: 'g2' },
  { kind: 'audiooutput', deviceId: 'usb12', label: 'Line 1/2 (DJ Interface)', groupId: 'g3' },
  { kind: 'audiooutput', deviceId: 'usb34', label: 'Line 3/4 (DJ Interface)', groupId: 'g3' },
  { kind: 'audiooutput', deviceId: 'usb12', label: 'Line 1/2 (DJ Interface)', groupId: 'g3' },
];

test('dedupeOutputs: Windows Chrome list', () => {
  const list = dedupeOutputs(WIN_CHROME);
  assert.deepEqual(list.map((d) => d.deviceId), ['default', 'spk', 'bt-st', 'usb12', 'usb34']);
  assert.equal(list[0].label, 'System default (Speakers (Realtek(R) Audio))');
  assert.equal(list[2].label, 'Headphones (WH-1000XM4 Stereo)', 'stereo endpoint kept, hands-free dropped');
});

test('dedupeOutputs: masked, Firefox, Mac and odd inputs', () => {
  assert.deepEqual(dedupeOutputs([{ kind: 'audiooutput', deviceId: '', label: '', groupId: '' }]), [], 'no permission yet');
  assert.deepEqual(dedupeOutputs(null), []);
  const ff = dedupeOutputs([
    { kind: 'audiooutput', deviceId: 'a1', label: 'MacBook Pro Speakers', groupId: '' },
    { kind: 'audiooutput', deviceId: 'a2', label: 'AirPods', groupId: '' },
    { kind: 'audiooutput', deviceId: 'a3', label: 'AirPods', groupId: '' },
  ]);
  assert.equal(ff.length, 3, 'two AirPods without groupId stay apart');
  const unnamed = dedupeOutputs([{ deviceId: 'x1', label: '' }, { deviceId: 'x2', label: '' }]);
  assert.deepEqual(unnamed.map((d) => d.label), ['Output 1', 'Output 2']);
  const dupLabel = dedupeOutputs([
    { kind: 'audiooutput', deviceId: 'p1', label: 'Speakers (USB)', groupId: 'g' },
    { kind: 'audiooutput', deviceId: 'p2', label: 'Speakers (USB)', groupId: 'g' },
  ]);
  assert.equal(dupLabel.length, 1);
  const onlyHf = dedupeOutputs([{ kind: 'audiooutput', deviceId: 'h', label: 'Headset (X Hands-Free)', groupId: 'g' }]);
  assert.equal(onlyHf.length, 1, 'a hands-free-only device is still listed (with a hint)');
});

test('sameOutput resolves the system default to its real endpoint', () => {
  const list = dedupeOutputs(WIN_CHROME);
  assert.equal(resolveOutput('default', list), 'spk');
  assert(sameOutput('default', 'spk', list));
  assert(!sameOutput('default', 'bt-st', list));
  assert(!sameOutput('usb12', 'usb34', list), 'shared groupId is not the same output');
  assert(sameOutput('bt-st', 'bt-st', list));
  assert(sameOutput('default', 'default', []));
  assert(!sameOutput('default', 'x', []));
  assert.equal(sinkIdOf('default'), '');
  assert.equal(sinkIdOf('abc'), 'abc');
  assert.equal(sinkIdOf(''), '');
});

test('alignment, split sides, chip text, hints', () => {
  assert.deepEqual(alignmentDelays(120), { master: 0.12, cue: 0, ms: 120 });
  assert.deepEqual(alignmentDelays(-80), { master: 0, cue: 0.08, ms: -80 });
  assert.deepEqual(alignmentDelays(999), { master: 0.3, cue: 0, ms: 300 });
  assert.deepEqual(alignmentDelays(-999), { master: 0, cue: 0.3, ms: -300 });
  assert.deepEqual(alignmentDelays('x'), { master: 0, cue: 0, ms: 0 });
  assert.deepEqual(splitSides(false), { master: 0, cue: 1 });
  assert.deepEqual(splitSides(true), { master: 1, cue: 0 });
  assert.equal(describeRouting('single', { formFactor: 'phone' }), 'Phone speaker');
  assert.equal(describeRouting('single', { formFactor: 'tablet' }), 'Tablet speaker');
  assert.equal(describeRouting('single', { formFactor: 'computer' }), 'Speakers');
  assert.equal(describeRouting('dual'), 'Speaker + Headphones');
  assert.equal(describeRouting('split'), 'Split cable');
  assert.equal(describeRouting('remote'), 'Second device');
  assert.equal(SINGLE_HINT, 'Headphone pre-listen needs a second output. Open Outputs.');
});

test('friendly setSinkId and permission errors', () => {
  const e = (name, message = '') => ({ name, message });
  assert.match(friendlySinkError(e('NotAllowedError', 'A user gesture is required'), 'cue'), /Tap the button again/);
  assert.match(friendlySinkError(e('NotAllowedError', 'Permissions-Policy disallows speaker selection.')), /own browser tab/);
  assert.match(friendlySinkError(e('NotAllowedError', 'access to the device is not permitted'), 'master'), /speaker output wasn't allowed/);
  assert.match(friendlySinkError(e('NotFoundError'), 'cue'), /headphones output isn't available/);
  assert.match(friendlySinkError(e('SecurityError', 'No permission to use requested device'), 'master'), /No permission to use the speaker/);
  assert.match(friendlySinkError(e('AbortError')), /couldn't be opened/);
  assert.match(friendlySinkError(e('TimeoutError')), /took too long/);
  assert.match(friendlySinkError(e('InvalidStateError')), /resume audio/);
  assert.match(friendlySinkError(e('NotSupportedError')), /can't switch outputs/);
  assert.match(friendlySinkError(null), /Couldn't switch/);
  assert.match(friendlyAccessError(e('NotAllowedError')), /never records/);
  assert.match(friendlyAccessError(e('NotFoundError')), /no microphone was found/);
  assert.match(friendlyAccessError(e('NotReadableError')), /busy/);
});

// ------------------------------------------------------------------------------------------------ fake Web Audio

class FakeParam {
  constructor(v) {
    this.value = v;
  }
  setValueAtTime(v) {
    this.value = v;
  }
  linearRampToValueAtTime(v) {
    this.value = v;
  }
  setTargetAtTime(v) {
    this.value = v;
  }
  cancelScheduledValues() {}
}

class FakeNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.out = [];
  }
  connect(dest, output = 0, input = 0) {
    this.out.push({ dest, input });
    return dest;
  }
  disconnect(dest) {
    this.out = dest === undefined ? [] : this.out.filter((c) => c.dest !== dest);
  }
}

class FakeCtx {
  constructor({ sinkApi = true } = {}) {
    this.currentTime = 1;
    this.state = 'running';
    this.destination = new FakeNode(this, 'destination');
    this.sinkId = '';
    this.sinkCalls = [];
    this.oscillators = [];
    if (sinkApi) {
      this.setSinkId = (id) => {
        this.sinkCalls.push(id);
        this.sinkId = id;
        return Promise.resolve();
      };
    }
  }
  createGain() {
    const n = new FakeNode(this, 'gain');
    n.gain = new FakeParam(1);
    return n;
  }
  createDelay(max) {
    const n = new FakeNode(this, 'delay');
    n.delayTime = new FakeParam(0);
    n.maxDelayTime = max;
    return n;
  }
  createChannelMerger() {
    return new FakeNode(this, 'merger');
  }
  createMediaStreamDestination() {
    const n = new FakeNode(this, 'msd');
    const track = { kind: 'audio', contentHint: '' };
    n.stream = { getAudioTracks: () => [track], getTracks: () => [track], track };
    return n;
  }
  createOscillator() {
    const n = new FakeNode(this, 'osc');
    n.frequency = new FakeParam(440);
    n.start = () => {};
    n.stop = () => {};
    this.oscillators.push(n);
    return n;
  }
}

class FakeAudio {
  constructor(doc) {
    this.doc = doc;
    this.attrs = {};
    this.style = {};
    this.sinkId = '';
    this.paused = true;
    this.plays = 0;
    this.srcObject = null;
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  setSinkId(id) {
    const fail = this.doc.failSink[id];
    if (fail) return Promise.reject(Object.assign(new Error(fail), { name: fail }));
    this.sinkId = id;
    return Promise.resolve();
  }
  play() {
    this.plays++;
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  remove() {}
}

function fakeDoc() {
  const doc = {
    failSink: {},
    audios: [],
    body: { appendChild() {} },
    createElement(tag) {
      assert.equal(tag, 'audio');
      const a = new FakeAudio(doc);
      doc.audios.push(a);
      return a;
    },
  };
  return doc;
}

function fakeMedia(list = []) {
  const md = {
    list,
    gum: 0,
    stopped: 0,
    picks: [],
    listeners: {},
    enumerateDevices: () => Promise.resolve(md.list.slice()),
    getUserMedia: (c) => {
      md.gum++;
      md.lastConstraints = c;
      const tr = { stop: () => md.stopped++ };
      return Promise.resolve({ getTracks: () => [tr] });
    },
    addEventListener(t, f) {
      md.listeners[t] = f;
    },
    removeEventListener(t) {
      delete md.listeners[t];
    },
  };
  return md;
}

let settingsN = 0;
function makeRouter({ env = ENV.chromeDesktop, sinkApi = true, preset = {}, list = WIN_CHROME, formFactor = 'computer' } = {}) {
  const settings = new Settings(`test.routing.${++settingsN}`);
  for (const [k, v] of Object.entries(preset)) settings.set(k, v);
  const ctx = new FakeCtx({ sinkApi });
  const mixer = { masterOut: ctx.createGain(), cueOut: ctx.createGain() };
  const doc = fakeDoc();
  const md = fakeMedia(list);
  const router = new OutputRouter(ctx, mixer, settings, { env, document: doc, mediaDevices: md, formFactor, topLevel: true });
  const errors = [];
  router.on('error', (m) => errors.push(m));
  return { router, ctx, mixer, doc, md, settings, errors };
}

/** Largest gain product along any path from `from` to `to` (0 = not connected or muted). */
function reach(from, to, seen = new Set()) {
  if (from === to) return 1;
  if (seen.has(from)) return 0;
  seen.add(from);
  const own = from.gain ? from.gain.value : 1;
  let best = 0;
  for (const c of from.out) best = Math.max(best, own * reach(c.dest, to, new Set(seen)));
  return best;
}

/** Merger inputs fed (with gain) from a source node. */
function mergerInputs(from, merger) {
  const inputs = new Set();
  const walk = (n, g, seen) => {
    if (seen.has(n)) return;
    seen.add(n);
    const own = n.gain ? n.gain.value : 1;
    for (const c of n.out) {
      if (c.dest === merger && g * own > 0) inputs.add(c.input);
      else walk(c.dest, g * own, new Set(seen));
    }
  };
  walk(from, 1, new Set());
  return [...inputs].sort();
}

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ OutputRouter

test('single: speaker mix to the default output, headphone mix nowhere', () => {
  const { router, ctx, mixer } = makeRouter();
  assert.equal(router.mode, 'single');
  assert.equal(reach(mixer.masterOut, ctx.destination), 1);
  assert.equal(reach(mixer.cueOut, ctx.destination), 0);
  assert.equal(router.describe(), 'Speakers');
  assert.equal(router.hint, SINGLE_HINT);
  assert(router.modes.dual.ok);
});

test('split: mono master left, mono cue right, swappable', async () => {
  const { router, ctx, mixer, settings } = makeRouter({ env: ENV.androidChrome, formFactor: 'phone' });
  await router.setMode('split');
  assert.equal(router.mode, 'split');
  assert.equal(settings.get('outputMode'), 'split');
  const merger = ctx.destination && mixer.masterOut && router._merger;
  assert(merger, 'merger created');
  assert.deepEqual(mergerInputs(mixer.masterOut, merger), [0]);
  assert.deepEqual(mergerInputs(mixer.cueOut, merger), [1]);
  assert.equal(reach(merger, ctx.destination), 1);
  assert.equal(router.describe(), 'Split cable');
  await router.setSplitSwap(true);
  assert.deepEqual(mergerInputs(mixer.masterOut, merger), [1]);
  assert.deepEqual(mergerInputs(mixer.cueOut, merger), [0]);
  await router.setMode('single');
  assert.equal(reach(mixer.cueOut, ctx.destination), 0);
  assert.equal(reach(mixer.masterOut, ctx.destination), 1);
});

test('dual on Chrome: ctx.setSinkId for the speaker, hidden <audio> for the headphones, no cue leak', async () => {
  const { router, ctx, mixer, doc, errors, settings } = makeRouter();
  await router.setMasterDevice('spk');
  await router.setCueDevice('bt-st');
  await router.setMode('dual');
  assert.deepEqual(errors, []);
  assert.equal(router.mode, 'dual');
  assert.deepEqual(ctx.sinkCalls, ['spk']);
  assert.equal(doc.audios.length, 1);
  const cueEl = doc.audios[0];
  assert.equal(cueEl.sinkId, 'bt-st');
  assert(!cueEl.paused && cueEl.plays === 1);
  assert.equal(cueEl.attrs['data-twinspin-output'], 'cue');
  const cueDest = router._els.cue.dest;
  assert.equal(cueEl.srcObject, cueDest.stream);
  assert.equal(reach(mixer.cueOut, cueDest), 1);
  assert.equal(reach(mixer.cueOut, ctx.destination), 0, 'headphone mix never leaks to the speaker');
  assert.equal(reach(mixer.masterOut, ctx.destination), 1);
  assert.equal(reach(mixer.masterOut, cueDest), 0);
  assert.equal(router.describe(), 'Speaker + Headphones');
  router.setAlignmentMs(120);
  assert.equal(router._masterDelay.delayTime.value, 0.12);
  assert.equal(router._cueDelay.delayTime.value, 0);
  router.setAlignmentMs(-80);
  assert.equal(router._masterDelay.delayTime.value, 0);
  assert.equal(router._cueDelay.delayTime.value, 0.08);
  assert.equal(settings.get('alignmentMs'), -80);
  // switching the headphones live
  await router.setCueDevice('usb34');
  assert.equal(cueEl.sinkId, 'usb34');
  assert.equal(settings.get('cueDeviceId'), 'usb34');
  // refuse the same output for both
  await router.setCueDevice('spk');
  assert.match(errors[0], /same output/);
  assert.equal(settings.get('cueDeviceId'), 'usb34');
  // leaving dual: element paused, context back on the default output, delays cleared
  await router.setMode('single');
  assert(cueEl.paused);
  assert.equal(ctx.sinkId, '');
  assert.equal(router._cueDelay.delayTime.value, 0);
  assert.equal(reach(mixer.cueOut, ctx.destination), 0);
});

test('dual on Firefox/Safari: the speaker goes through its own <audio> when not the default', async () => {
  const { router, ctx, mixer, doc } = makeRouter({ env: ENV.firefoxDesktop, sinkApi: false });
  await router.setMasterDevice('spk');
  await router.setCueDevice('bt-st');
  await router.setMode('dual');
  assert.equal(router.mode, 'dual');
  assert.equal(doc.audios.length, 2);
  const masterRec = router._els.master;
  assert.equal(masterRec.el.sinkId, 'spk');
  assert.equal(reach(mixer.masterOut, masterRec.dest), 1);
  assert.equal(reach(mixer.masterOut, ctx.destination), 0, 'master not doubled on the default output');
  assert.equal(reach(mixer.cueOut, ctx.destination), 0);
  // back to the system default speaker: through ctx.destination again
  await router.setMasterDevice('default');
  assert.equal(reach(mixer.masterOut, ctx.destination), 1);
  assert.equal(reach(mixer.masterOut, masterRec.dest), 0);
  assert(masterRec.el.paused);
});

test('dual failures fall back to single with a plain message', async () => {
  const a = makeRouter();
  a.doc.failSink['bt-st'] = 'NotFoundError';
  await a.router.setCueDevice('bt-st');
  await a.router.setMode('dual');
  assert.equal(a.router.mode, 'single');
  assert.equal(a.settings.get('outputMode'), 'single');
  assert.match(a.errors[0], /headphones output isn't available/);
  assert.equal(reach(a.mixer.cueOut, a.ctx.destination), 0);
  assert.equal(reach(a.mixer.masterOut, a.ctx.destination), 1);
  assert.equal(a.ctx.sinkId, '', 'context sink restored');

  const b = makeRouter();
  await b.router.setMode('dual');
  assert.equal(b.router.mode, 'single');
  assert.match(b.errors[0], /Choose which output your headphones/);

  const c = makeRouter();
  await c.router.setCueDevice('spk'); // the system default resolves to 'spk'
  await c.router.listOutputs();
  await c.router.setMode('dual');
  assert.match(c.errors[0], /same output/);

  const d = makeRouter();
  d.doc.failSink.hp = 'SecurityError';
  await d.router.setCueDevice('hp');
  await d.router.setMode('dual');
  assert.match(d.errors[0], /No permission to use the headphones output/);
});

test('phones: dual refused before any device call, getUserMedia never called', async () => {
  const { router, md, errors, doc, ctx } = makeRouter({ env: ENV.androidChrome, formFactor: 'phone' });
  assert.equal(router.describe(), 'Phone speaker');
  await router.setCueDevice('x');
  await router.setMode('dual');
  assert.equal(router.mode, 'single');
  assert.match(errors[0], /^Phones can only play to one output/);
  const ok = await router.requestDeviceAccess('cue');
  assert.equal(ok, false);
  assert.equal(md.gum, 0, 'no getUserMedia on phones');
  assert.equal(doc.audios.length, 0);
  assert.deepEqual(ctx.sinkCalls, []);
  const ios = makeRouter({ env: ENV.iphone, formFactor: 'phone' });
  await ios.router.requestDeviceAccess('master');
  assert.equal(ios.md.gum, 0);
  assert.match(ios.errors[0], /^iPhones/);
});

test('device access: Chrome unlocks with getUserMedia and stops the mic at once; Firefox picks per role', async () => {
  const masked = [{ kind: 'audiooutput', deviceId: '', label: '', groupId: '' }];
  const { router, md } = makeRouter({ list: masked });
  let outs = await router.listOutputs();
  assert.equal(router.hasDeviceAccess(), false);
  assert.deepEqual(outs.map((o) => o.deviceId), ['default']);
  assert.equal(router.accessInfo().method, 'mic');
  md.list = WIN_CHROME;
  assert.equal(await router.requestDeviceAccess('cue'), true);
  assert.equal(md.gum, 1);
  assert.equal(md.stopped, 1, 'tracks stopped');
  assert.equal(md.lastConstraints.audio.echoCancellation, false);
  assert(router.hasDeviceAccess());
  outs = await router.listOutputs();
  assert.equal(outs[0].deviceId, 'default');
  assert(outs.some((o) => o.deviceId === 'bt-st'));
  assert(!outs.some((o) => o.deviceId === 'communications' || o.deviceId === 'bt-hf'));

  const ff = makeRouter({ env: ENV.firefoxDesktop, sinkApi: false, list: [] });
  ff.md.selectAudioOutput = () => Promise.resolve({ deviceId: 'ff-usb', label: 'USB Audio', groupId: 'u' });
  assert.equal(ff.router.accessInfo().method, 'pick');
  assert.equal(await ff.router.requestDeviceAccess('cue'), true);
  assert.equal(ff.settings.get('cueDeviceId'), 'ff-usb');
  assert.equal(ff.md.gum, 0, 'Firefox never needs the microphone');
  const listed = await ff.router.listOutputs();
  assert(listed.some((o) => o.deviceId === 'ff-usb' && o.label === 'USB Audio'));
  ff.md.selectAudioOutput = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
  assert.equal(await ff.router.requestDeviceAccess('master'), false);
  assert.equal(ff.errors.length, 0, 'closing the picker is not an error');
});

test('a vanished device falls back to single', async () => {
  const { router, md, errors, mixer, ctx } = makeRouter();
  await router.setCueDevice('bt-st');
  await router.setMode('dual');
  assert.equal(router.mode, 'dual');
  md.list = WIN_CHROME.filter((d) => d.groupId !== 'g2');
  md.listeners.devicechange();
  await wait(10);
  assert.equal(router.mode, 'single');
  assert.match(errors[0], /headphones output was disconnected/);
  assert.equal(reach(mixer.cueOut, ctx.destination), 0);
});

test('restoring dual at start-up: failure -> single + pick again; an engine setMode call merges with it', async () => {
  const preset = { outputMode: 'dual', cueDeviceId: 'gone', masterDeviceId: 'default' };
  const a = makeRouter({ preset });
  a.doc.failSink.gone = 'NotFoundError';
  assert.equal(a.router.mode, 'single', 'sound works right away');
  await wait(100);
  assert.equal(a.router.mode, 'single');
  assert.equal(a.errors.length, 1);
  assert.match(a.errors[0], /pick the speaker and headphones again/);
  assert.equal(a.settings.get('outputMode'), 'single');

  const b = makeRouter({ preset: { outputMode: 'dual', cueDeviceId: 'bt-st' } });
  const p = b.router.setMode('dual'); // the engine applying settings right after construction
  await p;
  await wait(100);
  assert.equal(b.router.mode, 'dual');
  assert.equal(b.doc.audios[0].plays, 1, 'one start, not two');
  assert.deepEqual(b.errors, []);

  const c = makeRouter({ preset: { outputMode: 'split' } });
  await wait(100);
  assert.equal(c.router.mode, 'split');

  const d = makeRouter({ preset: { outputMode: 'remote' } });
  await wait(100);
  assert.equal(d.router.mode, 'single', 'sharing does not survive a reload');
  assert.match(d.errors[0], /Second device sharing stopped/);
});

test('remote: local plays one bus, the stream carries the other, switching is a gain change', async () => {
  const { router, ctx, mixer } = makeRouter({ env: ENV.iphone, formFactor: 'phone' });
  const stream = router.getRemoteStream();
  assert(stream && stream.track.contentHint === 'music');
  await router.setMode('remote');
  assert.equal(router.describe(), 'Second device');
  const rdest = router._remote.dest;
  assert.equal(reach(mixer.masterOut, ctx.destination), 1, 'this phone plays the speaker mix');
  assert.equal(reach(mixer.cueOut, ctx.destination), 0);
  assert.equal(reach(mixer.cueOut, rdest), 1, 'second device gets the headphone mix');
  assert.equal(reach(mixer.masterOut, rdest), 0);
  router.setRemoteBus('master');
  assert.equal(router.remoteBus, 'master');
  assert.equal(reach(mixer.masterOut, ctx.destination), 0);
  assert.equal(reach(mixer.cueOut, ctx.destination), 1);
  assert.equal(reach(mixer.masterOut, rdest), 1);
  assert.equal(reach(mixer.cueOut, rdest), 0);
  assert.equal(router.getRemoteStream(), stream, 'same stream: no renegotiation');
  // leaving remote stops the page-wide host
  const host = sharedHost();
  let stopped = 0;
  host._state = 'waiting';
  host.stop = () => {
    stopped++;
    host._state = 'idle';
  };
  await router.setMode('single');
  assert.equal(stopped, 1);
  assert.equal(reach(mixer.cueOut, rdest), 0);
  assert.equal(reach(mixer.cueOut, ctx.destination), 0);
  assert.equal(reach(mixer.masterOut, ctx.destination), 1);
});

test('test tones: two high beeps on the speaker, one low long beep on the headphones', async () => {
  const { router, ctx, errors } = makeRouter();
  await router.test('cue');
  assert.match(errors[0], /no separate headphone output/);
  await router.test('master');
  assert.equal(ctx.oscillators.length, 2);
  assert(ctx.oscillators.every((o) => o.frequency.value > 1000));
  const linked = (from, to) => from === to || from.out.some((c) => linked(c.dest, to));
  assert(linked(ctx.oscillators[0], router._masterIn), 'beep enters the speaker path');
  assert(!linked(ctx.oscillators[0], router._cueIn));
  await router.setMode('split');
  await router.test('cue');
  assert.equal(ctx.oscillators.length, 3);
  assert(ctx.oscillators[2].frequency.value < 500);
  router.dispose();
  assert.equal(reach(router.mixer.masterOut, ctx.destination), 0);
});
