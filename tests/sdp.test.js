// Tests for src/remote/sdp.js (Opus stereo munge) plus the rest of the remote feature that runs without a
// browser: peer.js helpers, the RemoteHost protocol against a fake PeerJS (one listener, busy, recall, kick,
// bitrate), the receiver page and the Outputs-sheet panel end to end with a fake DOM, fake RTCPeerConnection
// and fake PeerJS.

// env.js reads its feature flags at import time, so the browser stubs go in before the modules load.
const fakeDom = makeFakeDom();
globalThis.RTCPeerConnection = class FakeRTCPeerConnection {
  addTransceiver() {}
  createOffer() {
    return Promise.resolve({ type: 'offer', sdp: 'v=0\r\nm=audio 9 X 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10\r\n' });
  }
  createAnswer() {
    return Promise.resolve({ type: 'answer', sdp: 'v=0\r\nm=audio 9 X 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10\r\n' });
  }
  setLocalDescription() {
    return Promise.resolve();
  }
  setRemoteDescription() {
    return Promise.resolve();
  }
  close() {}
};

const { addOpusStereo, hasOpusStereo } = await import('../src/remote/sdp.js');
const {
  makeCode, normalizeCode, hostIdFor, makeListenerId, isListenerId, joinLink, iceServers, peerOptions, toRemoteError,
  CODE_ALPHABET, ID_PREFIX, MESSAGES, PEERJS_URLS, PEERJS_SRI, openPeer, takeEarly,
} = await import('../src/remote/peer.js');
const { RemoteHost, setSendBitrate, SEND_BITRATE } = await import('../src/remote/remote-host.js');
const { silentWavUri, delayText, bootReceiver } = await import('../src/remote/receiver.js');

// ------------------------------------------------------------------------------------------------ fake DOM

function makeFakeDom() {
  class FakeEl {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.attrs = {};
      this.listeners = {};
      this.dataset = {};
      this.style = { setProperty(k, v) { this[k] = v; } };
      this.hidden = false;
      this.disabled = false;
      this.value = '';
      this.className = '';
      this._text = '';
      this.paused = true;
      this.plays = 0;
      this.srcObject = null;
      this.src = '';
      const cls = new Set();
      this.classList = {
        add: (c) => cls.add(c),
        remove: (c) => cls.delete(c),
        contains: (c) => cls.has(c),
        toggle: (c, force) => ((force === undefined ? !cls.has(c) : force) ? cls.add(c) : cls.delete(c)),
      };
    }
    get textContent() {
      return this._text + this.children.map((c) => c.textContent).join('');
    }
    set textContent(v) {
      this._text = String(v);
      this.children = [];
    }
    get firstChild() {
      return this.children[0] || null;
    }
    append(...nodes) {
      for (const n of nodes) {
        n.parentNode = this;
        this.children.push(n);
      }
    }
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    }
    removeAttribute(k) {
      delete this.attrs[k];
      if (k === 'src') this.src = '';
    }
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
      this.parentNode = null;
    }
    addEventListener(t, f) {
      (this.listeners[t] = this.listeners[t] || []).push(f);
    }
    fire(t, ev = {}) {
      for (const f of this.listeners[t] || []) f({ type: t, preventDefault() {}, ...ev });
    }
    click() {
      this.fire('click');
    }
    focus() {}
    play() {
      this.plays++;
      if (this.blockPlay) return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    find(cls) {
      if (this.className.split(' ').includes(cls)) return this;
      for (const c of this.children) {
        const hit = c.find && c.find(cls);
        if (hit) return hit;
      }
      return null;
    }
  }
  const docListeners = {};
  const doc = {
    hidden: false,
    title: '',
    documentElement: new FakeEl('html'),
    body: new FakeEl('body'),
    createElement: (tag) => new FakeEl(tag),
    addEventListener: (t, f) => {
      (docListeners[t] = docListeners[t] || []).push(f);
    },
  };
  return { FakeEl, doc, docListeners };
}

// ------------------------------------------------------------------------------------------------ SDP

const CHROME_ANSWER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126',
  'c=IN IP4 0.0.0.0',
  'a=rtcp:9 IN IP4 0.0.0.0',
  'a=ice-ufrag:Ab3d',
  'a=ice-pwd:efghijklmnopqrstuvwxyz12',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 AA:BB:CC',
  'a=setup:active',
  'a=mid:0',
  'a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
  'a=recvonly',
  'a=rtcp-mux',
  'a=rtpmap:111 opus/48000/2',
  'a=rtcp-fb:111 transport-cc',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'a=rtpmap:9 G722/8000',
  'a=rtpmap:0 PCMU/8000',
  'a=rtpmap:8 PCMA/8000',
  'a=rtpmap:13 CN/8000',
  'a=rtpmap:110 telephone-event/48000',
  'a=rtpmap:126 telephone-event/8000',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=mid:1',
  'a=sctp-port:5000',
  '',
].join('\r\n');

test('adds stereo=1 to the Opus fmtp of a Chrome answer, nothing else changes', () => {
  const out = addOpusStereo(CHROME_ANSWER);
  assert(out.includes('\r\na=fmtp:111 minptime=10;useinbandfec=1;stereo=1\r\n'), out);
  assert(out.includes('\r\na=fmtp:63 111/111\r\n'), 'RED fmtp untouched');
  assert(out.endsWith('\r\n'), 'trailing CRLF kept');
  assert.equal(out.split('\r\n').length, CHROME_ANSWER.split('\r\n').length);
  assert.equal(out.replace(';stereo=1', ''), CHROME_ANSWER);
  assert(!/\n(?!$)[^\r]?\n/.test(out.replace(/\r\n/g, '\u0001')), 'no bare LF introduced');
  assert(hasOpusStereo(out));
  assert(!hasOpusStereo(CHROME_ANSWER));
});

test('idempotent and fixes stereo=0', () => {
  const once = addOpusStereo(CHROME_ANSWER);
  assert.equal(addOpusStereo(once), once);
  const ff = 'm=audio 9 UDP/TLS/RTP/SAVPF 109\r\na=rtpmap:109 opus/48000/2\r\na=fmtp:109 maxplaybackrate=48000;stereo=0;useinbandfec=1\r\n';
  assert.equal(addOpusStereo(ff),
    'm=audio 9 UDP/TLS/RTP/SAVPF 109\r\na=rtpmap:109 opus/48000/2\r\na=fmtp:109 maxplaybackrate=48000;stereo=1;useinbandfec=1\r\n');
  const already = 'm=audio 9 X 109\r\na=rtpmap:109 opus/48000/2\r\na=fmtp:109 maxplaybackrate=48000;stereo=1;useinbandfec=1\r\n';
  assert.equal(addOpusStereo(already), already);
});

test('inserts a missing fmtp line, keeps LF endings, ignores other codecs', () => {
  const noFmtp = 'v=0\nm=audio 9 X 96 0\na=rtpmap:96 OPUS/48000/2\na=rtpmap:0 PCMU/8000\n';
  assert.equal(addOpusStereo(noFmtp), 'v=0\nm=audio 9 X 96 0\na=rtpmap:96 OPUS/48000/2\na=fmtp:96 stereo=1\na=rtpmap:0 PCMU/8000\n');
  const pcmu = 'v=0\r\nm=audio 9 X 0\r\na=rtpmap:0 PCMU/8000\r\na=fmtp:0 foo=1\r\n';
  assert.equal(addOpusStereo(pcmu), pcmu);
  assert.equal(addOpusStereo(''), '');
  assert.equal(addOpusStereo(null), null);
  const noTrail = 'm=audio 9 X 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10';
  assert.equal(addOpusStereo(noTrail), 'm=audio 9 X 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;stereo=1');
});

test('per m-section: the same payload number in another section is left alone', () => {
  const sdp = [
    'v=0',
    'm=audio 9 X 111',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 useinbandfec=1',
    'm=audio 9 X 111 112',
    'a=rtpmap:111 ISAC/16000',
    'a=fmtp:111 foo=1',
    'a=rtpmap:112 opus/48000/2',
    'a=fmtp:112 minptime=10',
    '',
  ].join('\r\n');
  const out = addOpusStereo(sdp).split('\r\n');
  assert.equal(out[3], 'a=fmtp:111 useinbandfec=1;stereo=1');
  assert.equal(out[6], 'a=fmtp:111 foo=1');
  assert.equal(out[8], 'a=fmtp:112 minptime=10;stereo=1');
});

// ------------------------------------------------------------------------------------------------ peer.js

test('codes, ids and links', () => {
  for (let i = 0; i < 200; i++) {
    const c = makeCode();
    assert.equal(c.length, 4);
    for (const ch of c) assert(CODE_ALPHABET.includes(ch), c);
    assert.equal(normalizeCode(c), c);
  }
  assert.equal(normalizeCode(' k7-qf '), 'K7QF');
  assert.equal(normalizeCode('K7Q'), null);
  assert.equal(normalizeCode('K0QF'), null, 'zero is not in the alphabet');
  assert.equal(normalizeCode('KIQF'), null, 'I is not in the alphabet');
  assert.equal(hostIdFor('K7QF'), 'twinspin-v1-K7QF');
  assert(/^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/.test(hostIdFor('K7QF')), 'valid PeerJS id');
  const lid = makeListenerId();
  assert(isListenerId(lid), lid);
  assert(/^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/.test(lid), 'valid PeerJS id');
  assert(lid.startsWith(ID_PREFIX));
  assert.equal(joinLink('K7QF', { origin: 'https://x.github.io', pathname: '/twinspin/' }), 'https://x.github.io/twinspin/?listen=K7QF');
  assert.equal(joinLink('K7QF', { origin: 'https://x.io', pathname: '/index.html' }), 'https://x.io/index.html?listen=K7QF');
});

test('ICE config: STUN only by default, config overrides; three pinned CDNs with SRI', () => {
  const def = iceServers({});
  assert.equal(def.length, 1);
  assert(def[0].urls.every((u) => u.startsWith('stun:')), 'no dead TURN servers');
  const own = [{ urls: 'turn:t.example.org:443?transport=tcp', username: 'u', credential: 'p' }];
  assert.deepEqual(iceServers({ iceServers: own }), own);
  const o = peerOptions({ peerOptions: { host: 'peer.example.org', port: 443, path: '/p', bogus: 1 } });
  assert.equal(o.host, 'peer.example.org');
  assert.equal(o.path, '/p');
  assert.equal(o.bogus, undefined);
  assert.equal(PEERJS_URLS.length, 3);
  assert(PEERJS_URLS.every((u) => u.includes('1.5.5')));
  assert(PEERJS_SRI.startsWith('sha384-'));
  assert.equal(toRemoteError({ type: 'unavailable-id' }).code, 'unavailable-id');
  assert.equal(toRemoteError({ type: 'socket-error' }).message, MESSAGES.network);
  assert.equal(toRemoteError({ type: 'browser-incompatible' }).code, 'unsupported');
});

// ------------------------------------------------------------------------------------------------ fake PeerJS

class Ev {
  constructor() {
    this.h = {};
  }
  on(t, f) {
    (this.h[t] = this.h[t] || []).push(f);
    return this;
  }
  off(t, f) {
    this.h[t] = (this.h[t] || []).filter((x) => x !== f);
    return this;
  }
  emit(t, ...a) {
    for (const f of (this.h[t] || []).slice()) f(...a);
  }
}

const server = { ids: new Set(), taken: [] };

class FakeSender {
  constructor() {
    this.track = { kind: 'audio' };
    this.params = { transactionId: 't1', encodings: [{ active: true }] };
    this.applied = [];
  }
  getParameters() {
    return JSON.parse(JSON.stringify(this.params));
  }
  setParameters(p) {
    if (p.encodings.length !== this.params.encodings.length) return Promise.reject(new Error('InvalidModificationError'));
    this.applied.push(p);
    this.params = p;
    return Promise.resolve();
  }
}

class FakeCall extends Ev {
  constructor(peer, stream) {
    super();
    this.peer = peer;
    this.stream = stream;
    this.open = true;
    this.closed = false;
    this.sender = new FakeSender();
    const self = this;
    this.peerConnection = {
      iceConnectionState: 'new',
      getSenders: () => [self.sender],
      getStats: () => Promise.resolve(new Map()),
      addEventListener() {},
    };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.emit('close');
  }
}

class FakePeer extends Ev {
  constructor(id) {
    super();
    this.id = id;
    this.destroyed = false;
    this.disconnected = false;
    this.calls = [];
    this.reconnects = 0;
    setTimeout(() => {
      if (server.taken.includes(id)) {
        server.taken = server.taken.filter((x) => x !== id);
        this.emit('error', { type: 'unavailable-id', message: `ID "${id}" is taken` });
        return;
      }
      server.ids.add(id);
      this.emit('open', id);
    }, 5);
  }
  call(id, stream) {
    if (!stream) return undefined;
    const c = new FakeCall(id, stream);
    this.calls.push(c);
    return c;
  }
  reconnect() {
    this.reconnects++;
    this.disconnected = false;
    setTimeout(() => this.emit('open', this.id), 5);
  }
  destroy() {
    this.destroyed = true;
    server.ids.delete(this.id);
  }
}

class FakeDC extends Ev {
  constructor(peerId) {
    super();
    this.peer = peerId;
    this.metadata = { app: 'twinspin', v: 1 };
    this.open = false;
    this.sent = [];
    this.closed = false;
  }
  send(m) {
    this.sent.push(m);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.emit('close');
  }
  openNow() {
    this.open = true;
    this.emit('open');
  }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const STREAM = { id: 'remote-stream' };

async function startedHost(timing = {}) {
  const host = new RemoteHost({ Peer: FakePeer, timing, location: { origin: 'https://dj.example', pathname: '/' } });
  const errors = [];
  host.on('error', (m) => errors.push(m));
  await host.start(STREAM);
  return { host, errors, peer: host._peer };
}

test('openPeer buffers connections that arrive with open', async () => {
  const p = openPeer(FakePeer, 'twinspin-v1-ABCD', {});
  await tick(1);
  const early = new FakeDC('x');
  // the fake emits 'open' at 5 ms; deliver a connection first
  const peerObj = await (async () => {
    await tick(10);
    return p;
  })();
  peerObj.emit('connection', early); // after open: not buffered any more? it is, until takeEarly
  const list = takeEarly(peerObj);
  assert.equal(list.length, 1);
  assert.equal(takeEarly(peerObj).length, 0);
});

test('host registers a code and calls the one listener, then raises the bitrate in place', async () => {
  localStorage.clear();
  const { host, errors, peer } = await startedHost();
  assert.equal(host.state, 'waiting');
  assert.equal(normalizeCode(host.code), host.code);
  assert.equal(peer.id, 'twinspin-v1-' + host.code);
  assert.equal(host.link, 'https://dj.example/?listen=' + host.code);
  const dc = new FakeDC('twinspin-v1-l-aaaaaaaaaa');
  peer.emit('connection', dc);
  dc.openNow();
  assert.equal(dc.sent[0].t, 'hello');
  assert.equal(peer.calls.length, 1, 'host is the caller');
  assert.equal(peer.calls[0].peer, dc.peer);
  assert.equal(peer.calls[0].stream, STREAM);
  assert.equal(host.state, 'connecting');
  peer.calls[0].emit('iceStateChanged', 'connected');
  assert.equal(host.state, 'live');
  await tick(5);
  const s = peer.calls[0].sender;
  assert.equal(s.applied.length, 1);
  assert.equal(s.applied[0].encodings.length, 1, 'never adds encodings');
  assert.equal(s.applied[0].encodings[0].maxBitrate, SEND_BITRATE);
  assert.equal(s.applied[0].transactionId, 't1', 'same parameters object passed back');
  // listener stats
  dc.emit('data', { t: 'stats', delayMs: 420, level: 0.3, live: true });
  assert.equal(host.listener.delayMs, 420);
  // a second device is refused politely
  const dc2 = new FakeDC('twinspin-v1-l-bbbbbbbbbb');
  peer.emit('connection', dc2);
  dc2.openNow();
  assert.deepEqual(dc2.sent, [{ t: 'busy' }]);
  await tick(500);
  assert(dc2.closed, 'busy link closed');
  assert.equal(host.listener.id, dc.peer);
  assert.equal(peer.calls.length, 1);
  // recall -> a fresh call, the old one closed
  dc.emit('data', { t: 'recall' });
  assert.equal(peer.calls.length, 2);
  assert(peer.calls[0].closed);
  assert.equal(errors.length, 0);
  host.stop();
  assert.equal(host.state, 'idle');
  assert.equal(dc.sent[dc.sent.length - 1].t, 'bye');
  await tick(600);
  assert(peer.destroyed);
});

test('ICE failure reports the Wi-Fi hint once; kick bans the device', async () => {
  const { host, errors, peer } = await startedHost();
  const dc = new FakeDC('twinspin-v1-l-cccccccccc');
  peer.emit('connection', dc);
  dc.openNow();
  peer.calls[0].emit('iceStateChanged', 'failed');
  assert.equal(host.listener.state, 'unreachable');
  assert.deepEqual(errors, [MESSAGES.unreachableHost]);
  dc.emit('data', { t: 'recall' });
  peer.calls[1].emit('error', { type: 'negotiation-failed' });
  assert.equal(errors.length, 1, 'not repeated');
  peer.calls[1].emit('iceStateChanged', 'connected');
  assert.equal(host.state, 'live');
  host.kick();
  assert.equal(host.listener, null);
  assert.equal(host.state, 'waiting');
  assert.equal(dc.sent[dc.sent.length - 1].t, 'kicked');
  const again = new FakeDC('twinspin-v1-l-cccccccccc');
  peer.emit('connection', again);
  again.openNow();
  assert.deepEqual(again.sent, [{ t: 'kicked' }]);
  assert.equal(host.listener, null);
  host.stop();
});

test('control link drop: grace period, same device may return without a new call', async () => {
  const { host, peer } = await startedHost({ graceMs: 1000, deadMs: 60000 });
  const dc = new FakeDC('twinspin-v1-l-dddddddddd');
  peer.emit('connection', dc);
  dc.openNow();
  peer.calls[0].emit('iceStateChanged', 'connected');
  peer.calls[0].peerConnection.iceConnectionState = 'connected';
  dc.close();
  assert.equal(host.state, 'connecting');
  assert.equal(host.listener.state, 'reconnecting');
  const back = new FakeDC('twinspin-v1-l-dddddddddd');
  peer.emit('connection', back);
  back.openNow();
  assert.equal(peer.calls.length, 1, 'live call kept');
  assert.equal(host.listener.state, 'live');
  back.close();
  await tick(1100);
  assert.equal(host.listener, null, 'dropped after the grace period');
  assert.equal(host.state, 'waiting');
  assert(peer.calls[0].closed);
  host.stop();
});

test('signalling loss reconnects; a taken saved code falls back to a new one with a notice', async () => {
  const { host, peer } = await startedHost({ reconnectMs: 100 });
  peer.disconnected = true;
  peer.emit('disconnected');
  assert.equal(host.signal, 'reconnecting');
  await tick(150);
  assert.equal(peer.reconnects, 1);
  assert.equal(host.signal, 'ok');
  const code = host.code;
  host.stop();
  await tick(700);
  // the saved code is taken by someone else now
  server.taken.push('twinspin-v1-' + code);
  const h2 = new RemoteHost({ Peer: FakePeer });
  await h2.start(STREAM);
  assert.equal(h2.state, 'waiting');
  assert(h2.code !== code);
  assert(/new one/.test(h2.notice), h2.notice);
  // newCode drops the listener and registers a different code
  const dc = new FakeDC('twinspin-v1-l-eeeeeeeeee');
  h2._peer.emit('connection', dc);
  dc.openNow();
  const before = h2.code;
  await h2.newCode();
  assert(h2.code && h2.code !== before);
  assert.deepEqual(dc.sent[dc.sent.length - 1], { t: 'bye', reason: 'newcode' });
  assert.equal(h2.listener, null);
  h2.stop();
});

test('setSendBitrate never adds encodings; start without PeerJS fails gracefully', async () => {
  const sender = new FakeSender();
  sender.params.encodings = [];
  const pc = { getSenders: () => [sender] };
  assert.equal(await setSendBitrate(pc, 192000), false);
  assert.equal(sender.applied.length, 0);
  const host = new RemoteHost(); // no injected Peer -> loadPeerJs -> no document in JsCheck
  const errors = [];
  host.on('error', (m) => errors.push(m));
  await host.start(STREAM);
  assert.equal(host.state, 'error');
  assert.equal(errors.length, 1);
  assert(host.error.length > 10);
  const noStream = new RemoteHost({ Peer: FakePeer });
  const e2 = [];
  noStream.on('error', (m) => e2.push(m));
  await noStream.start(null);
  assert.equal(noStream.state, 'idle');
  assert.equal(e2.length, 1);
});

// ------------------------------------------------------------------------------------------------ receiver helpers

test('receiver helpers: silent WAV and delay text', () => {
  const uri = silentWavUri(0.25, 8000);
  assert(uri.startsWith('data:audio/wav;base64,UklGR'), 'RIFF header');
  const bin = atob(uri.slice(uri.indexOf(',') + 1));
  assert.equal(bin.length, 44 + 2000);
  assert.equal(bin.slice(8, 12), 'WAVE');
  assert.equal(bin.charCodeAt(44), 128, 'silence at mid level');
  assert.equal(delayText(420), 'About 0.4 s behind the DJ');
  assert.equal(delayText(90), 'Less than 0.2 s behind the DJ');
  assert.equal(delayText(null), '');
});

// ------------------------------------------------------------------------------------------------ receiver page

class ListenerPeer extends Ev {
  constructor(id) {
    super();
    this.id = id;
    this.destroyed = false;
    this.disconnected = false;
    this.links = [];
    ListenerPeer.last = this;
    setTimeout(() => this.emit('open', id), 5);
  }
  connect(id, opts) {
    const dc = new FakeDC(id);
    dc.options = opts;
    this.links.push(dc);
    return dc;
  }
  reconnect() {
    this.disconnected = false;
  }
  destroy() {
    this.destroyed = true;
  }
}

class ListenerCall extends Ev {
  constructor(peer) {
    super();
    this.peer = peer;
    this.open = false;
    this.answers = [];
    let n = 0;
    this.peerConnection = {
      getStats: () => {
        n++;
        return Promise.resolve(new Map([
          ['in', { type: 'inbound-rtp', kind: 'audio', bytesReceived: 1000 * n, jitterBufferDelay: 0.08 * n * 50,
            jitterBufferEmittedCount: 50 * n, audioLevel: 0.2 }],
          ['tr', { type: 'transport', selectedCandidatePairId: 'cp' }],
          ['cp', { type: 'candidate-pair', currentRoundTripTime: 0.04, localCandidateId: 'l', remoteCandidateId: 'r' }],
          ['l', { type: 'local-candidate', candidateType: 'host' }],
          ['r', { type: 'remote-candidate', candidateType: 'srflx' }],
        ]));
      },
      getReceivers: () => [],
    };
  }
  answer(stream, opts) {
    this.answers.push({ stream, opts });
    this.open = true;
  }
  close() {
    this.open = false;
    this.emit('close');
  }
}

test('receiver: tap to listen unlocks audio in the tap, links up, plays, and explains problems', async () => {
  const { doc, docListeners, FakeEl } = fakeDom;
  globalThis.document = doc;
  const winListeners = {};
  globalThis.addEventListener = (t, f) => {
    (winListeners[t] = winListeners[t] || []).push(f);
  };
  const urls = [];
  globalThis.location = { pathname: '/twinspin/', search: '', hash: '#listen=k7qf', origin: 'https://x.io' };
  globalThis.history = { replaceState: (a, b, url) => urls.push(url) };
  globalThis.peerjs = { Peer: ListenerPeer };
  sessionStorage.clear();

  const root = new FakeEl('div');
  const rx = bootReceiver(root, { code: 'k7qf' });
  assert(doc.documentElement.classList.contains('ts-rx'));
  const page = root.find('rx');
  const title = root.find('rx-title');
  const detail = root.find('rx-detail');
  const go = root.find('rx-go');
  const stop = root.find('rx-stop');
  const audio = root.find('rx-audio');
  const codeInput = root.find('rx-code');
  assert.equal(codeInput.value, 'K7QF');
  assert.equal(title.textContent, 'Listen to the DJ');
  assert.equal(go.textContent, 'Tap to listen');
  assert(!go.disabled && !go.hidden && stop.hidden);

  // an invalid code is refused
  codeInput.value = 'k0';
  codeInput.fire('input');
  assert(go.disabled);
  codeInput.value = 'k7-qf';
  codeInput.fire('input');
  assert.equal(codeInput.value, 'K7QF');
  assert(!go.disabled);

  go.click();
  // synchronously inside the tap: the element already started (silent clip, looping)
  assert.equal(audio.plays, 1, 'play() called inside the tap');
  assert(audio.src.startsWith('data:audio/wav;base64,'));
  assert.equal(audio.loop, true);
  assert.equal(page.dataset.state, 'loading');
  assert.deepEqual(urls, ['/twinspin/?listen=K7QF']);
  await tick(50);
  const peer = ListenerPeer.last;
  assert(isListenerId(peer.id), peer.id);
  assert.equal(sessionStorage.getItem('twinspin.listener.id'), peer.id, 'same id after a reload');
  assert.equal(peer.links.length, 1);
  const dc = peer.links[0];
  assert.equal(dc.peer, 'twinspin-v1-K7QF');
  assert.equal(dc.options.serialization, 'json');
  assert.equal(dc.options.metadata.app, 'twinspin');
  assert.equal(title.textContent, 'Connecting…');

  // the DJ is not sharing yet
  peer.emit('error', { type: 'peer-unavailable', message: 'Could not connect to peer twinspin-v1-K7QF' });
  assert.equal(page.dataset.state, 'waiting');
  assert.match(detail.textContent, /Code K7QF\. Ask the DJ to open Outputs/);
  await tick(6100); // watchdog every 2 s, 5 s between tries while the DJ isn't sharing
  assert.equal(peer.links.length, 2, 'retries while waiting');
  const dc2 = peer.links[1];
  dc2.openNow();
  assert.equal(page.dataset.state, 'linking');
  dc2.emit('data', { t: 'hello', v: 1, bus: 'cue' });

  // the DJ calls: receive-only answer with the stereo munge
  const call = new ListenerCall('twinspin-v1-K7QF');
  peer.emit('call', call);
  assert.equal(call.answers.length, 1);
  assert.equal(call.answers[0].stream, undefined, 'receive-only');
  const transform = call.answers[0].opts.sdpTransform;
  assert.equal(typeof transform, 'function');
  assert(hasOpusStereo(transform('m=audio 9 X 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10\r\n')));
  const stream = { id: 'dj-stream' };
  call.emit('stream', stream);
  await tick(1);
  assert.equal(audio.srcObject, stream);
  assert.equal(audio.src, '', 'silent clip removed');
  assert.equal(audio.loop, false);
  assert.equal(page.dataset.state, 'live');
  assert.equal(title.textContent, 'Listening');
  assert.equal(detail.textContent, 'Playing the DJ\'s headphone mix.');
  assert.equal(stop.textContent, 'Stop listening');
  await tick(2100);
  const delay = root.find('rx-delay');
  assert.match(delay.textContent, /^About 0\.\d s behind the DJ$/);
  const stats = dc2.sent.filter((m) => m.t === 'stats');
  assert(stats.length >= 1 && stats[stats.length - 1].live === true);
  dc2.emit('data', { t: 'info', bus: 'master' });
  assert.equal(detail.textContent, 'Playing the DJ\'s speaker mix.');

  // a browser that refuses the munged answer: ask for a plain call
  peer.emit('error', { type: 'webrtc', message: 'setLocalDescription failed' });
  assert.deepEqual(dc2.sent[dc2.sent.length - 1], { t: 'recall' });
  const call2 = new ListenerCall('twinspin-v1-K7QF');
  peer.emit('call', call2);
  assert.deepEqual(call2.answers[0].opts, {}, 'plain answer');
  // calls from anyone else are refused
  const stranger = new ListenerCall('twinspin-v1-ZZZZ');
  peer.emit('call', stranger);
  assert.equal(stranger.answers.length, 0);

  // ICE fails: the plain-language Wi-Fi message
  call2.emit('iceStateChanged', 'failed');
  assert.equal(page.dataset.state, 'unreachable');
  assert.equal(title.textContent, 'Can\'t reach the DJ device');
  assert.match(detail.textContent, /^Can't reach the DJ device\. Both must be on the same Wi-Fi or hotspot\./);

  // someone else is listening
  dc2.emit('data', { t: 'busy' });
  assert.equal(page.dataset.state, 'busy');
  assert.equal(go.textContent, 'Try again');
  assert(!codeInput.parentNode.hidden, 'code field back');

  // try again; this time the browser blocks play() outside the tap: one more tap
  go.click();
  await tick(50);
  const peer2 = ListenerPeer.last;
  const dc3 = peer2.links[0];
  dc3.openNow();
  const call3 = new ListenerCall('twinspin-v1-K7QF');
  peer2.emit('call', call3);
  audio.blockPlay = true;
  call3.emit('stream', stream);
  await tick(1);
  assert.equal(page.dataset.state, 'needs-tap');
  assert.equal(go.textContent, 'Start sound');
  audio.blockPlay = false;
  go.click();
  await tick(1);
  assert.equal(page.dataset.state, 'live');

  // the DJ stops sharing: wait for them, reconnect by itself
  dc3.emit('data', { t: 'bye' });
  assert.equal(page.dataset.state, 'ended');

  rx.stop();
  assert.equal(page.dataset.state, 'idle');
  assert.equal(title.textContent, 'Listen to the DJ');
  assert(audio.paused);
  await tick(200);
  assert(peer2.destroyed);
  assert(Array.isArray(docListeners.visibilitychange) && winListeners.pagehide.length === 1);
  delete globalThis.peerjs;
});

test('receiver: a link that never opens ends in the Wi-Fi message', async () => {
  const { FakeEl } = fakeDom;
  globalThis.peerjs = { Peer: ListenerPeer };
  const root = new FakeEl('div');
  const rx = bootReceiver(root, { code: 'ABCD' });
  root.find('rx-go').click();
  await tick(50);
  const peer = ListenerPeer.last;
  const first = peer.links[0];
  first.emit('error', { type: 'negotiation-failed' });
  assert.equal(root.find('rx').dataset.state, 'unreachable');
  assert.match(root.find('rx-detail').textContent, /same Wi-Fi or hotspot/);
  await tick(30000);
  assert(peer.links.length >= 2, 'keeps retrying, more slowly');
  const last = peer.links[peer.links.length - 1];
  last.openNow();
  assert.equal(root.find('rx').dataset.state, 'linking');
  rx.stop();
  delete globalThis.peerjs;
});

// ------------------------------------------------------------------------------------------------ remote panel

test('panel: start sharing shows a big code, QR and link; listener status; disconnect; stop', async () => {
  const { doc, FakeEl } = fakeDom;
  globalThis.document = doc;
  doc.createElementNS = (ns, tag) => new FakeEl(tag);
  globalThis.peerjs = { Peer: FakePeer };
  globalThis.location = { origin: 'https://dj.example', pathname: '/app/' };
  // a tiny stand-in for qrcode-generator: a 21x21 checkerboard
  globalThis.qrcode = () => ({ addData() {}, make() {}, getModuleCount: () => 21, isDark: (r, c) => (r + c) % 2 === 0 });
  localStorage.clear();
  const { mountRemotePanel, qrPath } = await import('../src/remote/remote-panel.js');
  const { sharedHost } = await import('../src/remote/remote-host.js');
  const host = sharedHost();

  const subs = {};
  const router = {
    mode: 'single', remoteBus: 'cue', formFactor: 'phone', modes: { remote: { ok: true, reason: null } },
    stream: { id: 'remote-stream' }, modeCalls: [], errors: [],
    on(t, f) {
      (subs[t] = subs[t] || new Set()).add(f);
      return () => subs[t].delete(f);
    },
    emit(t, ...a) {
      if (t === 'error') this.errors.push(a[0]);
      for (const f of subs[t] || []) f(...a);
    },
    setMode(m) {
      this.modeCalls.push(m);
      this.mode = m;
      if (m !== 'remote' && host.active) host.stop();
      this.emit('change', 'mode');
      return Promise.resolve();
    },
    getRemoteStream() {
      return this.stream;
    },
    setRemoteBus(b) {
      this.remoteBus = b;
      this.emit('change', 'remoteBus');
    },
  };

  const container = new FakeEl('div');
  const panel = mountRemotePanel(container, { router, settings: null });
  const q = (cls) => container.find(cls);
  assert(!q('rp-primary').hidden, 'Start sharing visible');
  assert.equal(q('rp-primary').textContent, 'Start sharing');
  assert(q('rp-pair').hidden);
  assert.equal(q('rp-plays-label').textContent, 'This phone plays:');
  const [speakerBtn, phonesBtn] = q('rp-seg').children;
  assert.equal(speakerBtn.attrs['aria-pressed'], 'true');

  // this phone plays the headphones -> the second device gets the speaker mix
  phonesBtn.click();
  assert.equal(router.remoteBus, 'master');
  assert.equal(host.bus, 'master');
  assert.equal(phonesBtn.attrs['aria-pressed'], 'true');
  speakerBtn.click();
  assert.equal(router.remoteBus, 'cue');

  q('rp-primary').click();
  await tick(30);
  assert.deepEqual(router.modeCalls, ['remote']);
  assert.equal(host.state, 'waiting');
  assert(q('rp-primary').hidden);
  assert(!q('rp-pair').hidden);
  assert.equal(q('rp-code').textContent, host.code);
  assert.equal(q('rp-link').textContent, `dj.example/app/?listen=${host.code}`);
  assert.equal(q('rp-link').href, `https://dj.example/app/?listen=${host.code}`);
  await tick(5);
  const svg = q('rp-qr').children[0];
  assert(svg && svg.tagName === 'SVG', 'QR drawn as SVG');
  assert.equal(svg.attrs.viewBox, '0 0 25 25');
  assert.equal(qrPath(globalThis.qrcode, 'x').size, 25);
  assert.match(q('rp-status-text').textContent, /Waiting for the second device/);

  // a listener arrives
  const peer = host._peer;
  const dc = new FakeDC('twinspin-v1-l-pppppppppp');
  peer.emit('connection', dc);
  dc.openNow();
  assert.match(q('rp-status-text').textContent, /Linking up/);
  peer.calls[0].emit('iceStateChanged', 'connected');
  dc.emit('data', { t: 'stats', delayMs: 380, level: 0.2, live: true });
  assert.equal(q('rp-status').dataset.tone, 'ok');
  assert.equal(q('rp-status-text').textContent, 'Second device connected · about 0.4 s late');
  const kick = q('rp-actions').children[0];
  assert(!kick.hidden);
  assert.equal(kick.textContent, 'Disconnect device');

  // host errors reach the app's toast through the router while sharing
  peer.calls[0].emit('iceStateChanged', 'failed');
  assert.equal(router.errors.length, 1);
  assert.match(q('rp-error').textContent, /same Wi-Fi or hotspot/);
  peer.calls[0].emit('iceStateChanged', 'connected');
  assert(q('rp-error').hidden, 'cleared once live again');

  kick.click();
  assert.equal(host.listener, null);
  assert(kick.hidden);

  // stop sharing: back to the previous mode, host stopped
  const stopBtn = q('rp-actions').children[2];
  assert.equal(stopBtn.textContent, 'Stop sharing');
  stopBtn.click();
  await tick(1);
  assert.equal(router.mode, 'single');
  assert.equal(host.state, 'idle');
  assert(!q('rp-primary').hidden);
  assert(q('rp-pair').hidden);

  // unavailable on this device: just the reason
  router.modes = { remote: { ok: false, reason: 'Second device doesn\'t work inside the preview.' } };
  panel.refresh();
  assert(!q('rp-reason').hidden);
  assert.equal(q('rp-reason').textContent, 'Second device doesn\'t work inside the preview.');
  assert(q('rp-primary').hidden && q('rp-plays').hidden);
  panel.destroy();
  assert.equal(container.children.length, 0, 'panel removed');
  await tick(1000);
  delete globalThis.peerjs;
  delete globalThis.qrcode;
});
