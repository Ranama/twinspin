// "Second device" section of the Outputs sheet: start/stop sharing, a huge pairing code + QR code + join link,
// the "This phone plays: Speaker / Headphones" switch, listener status, new code / disconnect, plain notes.
//
//   const panel = mountRemotePanel(sheetBody, { router: engine.outputs, settings });
//   panel.destroy();        // when the sheet is torn down (sharing keeps running: the host is page-wide)
//
// Sharing = router.setMode('remote') + sharedHost().start(router.getRemoteStream()). Stopping returns the router to
// the mode used before (the router stops the host whenever it leaves 'remote'). The QR encoder
// (qrcode-generator 1.4.4 UMD) loads lazily from jsDelivr (unpkg as a fallback); without it the panel shows the
// code and the link. Styles: css/remote.css (.rp-*).

import { sharedHost } from './remote-host.js';
import { loadScript, MESSAGES } from './peer.js';

const QR_URLS = Object.freeze([
  'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js',
  'https://unpkg.com/qrcode-generator@1.4.4/qrcode.js',
]);
const SVG_NS = 'http://www.w3.org/2000/svg';
const prevModes = new WeakMap(); // router -> the mode to return to after sharing
const forwarding = new WeakSet(); // routers that already re-emit the host's errors
let qrLoad = null;

/**
 * Re-emit the host's errors on the router (once per router), so the app's toast for router errors also shows
 * remote trouble ("Can't reach the second device...") while the Outputs sheet is closed.
 */
function forwardErrors(host, router) {
  if (!router || typeof router.emit !== 'function' || forwarding.has(router)) return;
  forwarding.add(router);
  host.on('error', (msg) => {
    if (!router._disposed && router.mode === 'remote') router.emit('error', msg);
  });
}

function findQr() {
  return typeof globalThis.qrcode === 'function' ? globalThis.qrcode : null;
}

/** Load qrcode-generator once; resolves with its `qrcode` factory or rejects. */
export function loadQrEncoder() {
  const ready = findQr();
  if (ready) return Promise.resolve(ready);
  if (qrLoad) return qrLoad;
  qrLoad = (async () => {
    let last = null;
    for (const url of QR_URLS) {
      try {
        return await loadScript(url, { timeoutMs: 8000, check: findQr });
      } catch (e) {
        last = e;
      }
    }
    throw last || new Error('QR encoder unavailable');
  })();
  qrLoad.catch(() => {
    qrLoad = null;
  });
  return qrLoad;
}

/**
 * The dark modules of a QR code as one SVG path ('M x,y h1 v1 h-1 z' per module) plus its size in modules,
 * including a `quiet`-module margin. Pure apart from the encoder passed in.
 * @param {Function} qrcode  qrcode-generator factory
 * @param {string} text
 */
export function qrPath(qrcode, text, quiet = 2) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet},${r + quiet}h1v1h-1z`;
  }
  return { d, size: n + quiet * 2 };
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function button(cls, text, onClick) {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function deviceNoun(router) {
  const ff = router && router.formFactor;
  return ff === 'computer' ? 'computer' : ff === 'tablet' ? 'tablet' : 'phone';
}

function delayLabel(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return ms < 150 ? 'less than 0.2 s late' : `about ${(Math.round(ms / 100) / 10).toFixed(1)} s late`;
}

/**
 * Mount the Second device panel.
 * @param {HTMLElement} container
 * @param {{ router: import('../audio/outputs.js').OutputRouter|null, settings?: object }} opts
 * @returns {{ el: HTMLElement, refresh(): void, destroy(): void }}
 */
export function mountRemotePanel(container, { router = null, settings = null } = {}) {
  void settings; // the router owns the remote settings (remoteBus); kept for the contract signature
  const host = sharedHost();
  const root = el('section', 'rp');
  root.setAttribute('aria-label', 'Second device');
  let lastError = '';
  let busy = false;
  let qrFor = '';
  let copiedTimer = null;

  // --- skeleton -------------------------------------------------------------------------------------------
  const head = el('div', 'rp-head');
  const intro = el('p', 'rp-intro');
  head.append(intro); // the Outputs sheet titles this section 'Second device'

  const reason = el('p', 'rp-reason');

  const plays = el('div', 'rp-plays');
  const playsLabel = el('span', 'rp-plays-label');
  const seg = el('div', 'rp-seg');
  seg.setAttribute('role', 'group');
  const segSpeaker = button('rp-seg-btn', 'Speaker', () => setLocal('speaker'));
  const segPhones = button('rp-seg-btn', 'Headphones', () => setLocal('headphones'));
  seg.append(segSpeaker, segPhones);
  const playsNote = el('p', 'rp-plays-note');
  plays.append(playsLabel, seg, playsNote);

  const startBtn = button('rp-btn rp-primary', 'Start sharing', () => start());

  const pair = el('div', 'rp-pair');
  const qrBox = el('div', 'rp-qr');
  const codeBox = el('div', 'rp-codebox');
  const codeLabel = el('div', 'rp-code-label', 'Code');
  const code = el('div', 'rp-code');
  code.setAttribute('aria-live', 'polite');
  const link = el('a', 'rp-link');
  link.target = '_blank';
  link.rel = 'noopener';
  const linkRow = el('div', 'rp-linkrow');
  const copyBtn = button('rp-btn rp-small', 'Copy link', () => copyLink());
  linkRow.append(copyBtn);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const shareBtn = canShare ? button('rp-btn rp-small', 'Send link', () => shareLink()) : null;
  if (shareBtn) linkRow.append(shareBtn);
  codeBox.append(codeLabel, code, link, linkRow);
  pair.append(qrBox, codeBox);
  const how = el('p', 'rp-how', 'On the second device: scan the QR code with the camera, or open the link, '
    + 'or open TwinSpin there and type the code.');

  const status = el('div', 'rp-status');
  status.setAttribute('role', 'status');
  const statusDot = el('span', 'rp-dot');
  statusDot.setAttribute('aria-hidden', 'true');
  const statusText = el('span', 'rp-status-text');
  status.append(statusDot, statusText);
  const signal = el('p', 'rp-signal');
  const notice = el('p', 'rp-notice');
  const error = el('p', 'rp-error');
  error.setAttribute('role', 'alert');

  const actions = el('div', 'rp-actions');
  const kickBtn = button('rp-btn', 'Disconnect device', () => host.kick());
  const newBtn = button('rp-btn', 'New code', () => newCode());
  const stopBtn = button('rp-btn rp-danger', 'Stop sharing', () => stop());
  actions.append(kickBtn, newBtn, stopBtn);

  const notes = el('ul', 'rp-notes');
  for (const n of [
    'Both devices on the same Wi-Fi or a phone hotspot. Guest Wi-Fi may block it.',
    'The second device runs about half a second late: use SYNC for beatmatching, and keep both screens on.',
    'Anyone with the code can listen while you share. Use New code if someone else joined.',
  ]) notes.append(el('li', '', n));

  root.append(head, reason, plays, startBtn, pair, how, status, signal, notice, error, actions, notes);
  container.append(root);

  // --- actions -----------------------------------------------------------------------------------------------
  function setLocal(which) {
    if (!router) return;
    // this device plays the speaker -> the second device plays the headphones ('cue'), and vice versa
    const bus = which === 'speaker' ? 'cue' : 'master';
    router.setRemoteBus(bus);
    host.setBus(bus);
    render();
  }

  async function start() {
    if (!router || busy) return;
    busy = true;
    lastError = '';
    render();
    try {
      if (router.mode !== 'remote') prevModes.set(router, router.mode);
      host.setBus(router.remoteBus);
      await router.setMode('remote');
      if (router.mode !== 'remote') return; // the router explained why ('error')
      const stream = router.getRemoteStream();
      if (!stream) {
        lastError = MESSAGES.unsupported;
        await router.setMode(prevModes.get(router) || 'single');
        return;
      }
      await host.start(stream);
      if (host.state === 'error') {
        lastError = host.error || MESSAGES.error;
        await router.setMode(prevModes.get(router) || 'single');
      }
    } finally {
      busy = false;
      render();
    }
  }

  function stop() {
    lastError = '';
    const prev = (router && prevModes.get(router)) || 'single';
    if (router && router.mode === 'remote') router.setMode(prev === 'remote' ? 'single' : prev);
    if (host.active) host.stop();
    render();
  }

  function newCode() {
    lastError = '';
    qrFor = '';
    host.newCode();
  }

  function copyLink() {
    const text = host.link;
    if (!text) return;
    const done = () => {
      copyBtn.textContent = 'Copied';
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => {
        copyBtn.textContent = 'Copy link';
      }, 1600);
    };
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text).then(done, () => selectLink());
        return;
      }
    } catch {
      /* fall through */
    }
    selectLink();
  }

  function selectLink() {
    try {
      const range = document.createRange();
      range.selectNodeContents(link);
      const sel = globalThis.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {
      /* ignore */
    }
  }

  function shareLink() {
    const url = host.link;
    if (!url) return;
    try {
      navigator.share({ title: 'TwinSpin', text: `Listen to my DJ mix (code ${host.code})`, url }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  function drawQr(text) {
    qrBox.textContent = '';
    qrBox.classList.remove('rp-qr-failed');
    qrBox.classList.add('rp-qr-loading');
    qrBox.setAttribute('aria-label', 'Loading the QR code');
    loadQrEncoder().then((qrcode) => {
      if (qrFor !== text) return;
      const { d, size } = qrPath(qrcode, text);
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
      svg.setAttribute('shape-rendering', 'crispEdges');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', 'QR code of the join link');
      const bg = document.createElementNS(SVG_NS, 'rect');
      bg.setAttribute('width', String(size));
      bg.setAttribute('height', String(size));
      bg.setAttribute('fill', '#ffffff');
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', '#0b0c12');
      svg.append(bg, path);
      qrBox.textContent = '';
      qrBox.classList.remove('rp-qr-loading');
      qrBox.removeAttribute('aria-label');
      qrBox.append(svg);
    }, () => {
      if (qrFor !== text) return;
      qrBox.classList.remove('rp-qr-loading');
      qrBox.classList.add('rp-qr-failed');
      qrBox.textContent = 'QR code unavailable offline. Use the code or the link.';
    });
  }

  // --- render ------------------------------------------------------------------------------------------------
  function statusLine() {
    const L = host.listener;
    switch (host.state) {
      case 'starting': return ['wait', 'Getting a code…'];
      case 'waiting': return ['wait', 'Waiting for the second device…'];
      case 'connecting':
        if (L && L.state === 'unreachable') return ['bad', MESSAGES.unreachableHost];
        if (L && L.state === 'reconnecting') return ['wait', 'Second device reconnecting…'];
        return ['wait', 'Second device found. Linking up…'];
      case 'live': {
        const late = L ? delayLabel(L.delayMs) : '';
        return ['ok', `Second device connected${late ? ` · ${late}` : ''}${L && L.relay ? ' (through a relay)' : ''}`];
      }
      default: return ['off', ''];
    }
  }

  function render() {
    const modes = router ? router.modes : null;
    const remoteOk = !!(modes && modes.remote && modes.remote.ok);
    const noun = deviceNoun(router);
    const bus = router ? router.remoteBus : 'cue';
    intro.textContent = bus === 'master'
      ? 'Play the speaker mix on another phone, tablet or laptop (plugged into the speaker).'
      : 'Play your headphone mix on another phone, tablet or laptop, e.g. with Bluetooth headphones on it.';
    reason.hidden = remoteOk && !!router;
    reason.textContent = !router ? 'Start the audio first (tap Start).' : remoteOk ? '' : modes.remote.reason;
    const show = remoteOk && !!router;
    const active = host.active;

    plays.hidden = !show;
    playsLabel.textContent = `This ${noun} plays:`;
    segSpeaker.setAttribute('aria-pressed', String(bus === 'cue'));
    segPhones.setAttribute('aria-pressed', String(bus === 'master'));
    playsNote.textContent = bus === 'cue'
      ? `The speaker mix plays here; the second device gets the headphone mix.`
      : `The headphone mix plays here; the second device gets the speaker mix.`;

    startBtn.hidden = !show || active;
    startBtn.disabled = busy;
    startBtn.textContent = busy ? 'Starting…' : 'Start sharing';

    const hasCode = show && active && !!host.code;
    pair.hidden = !hasCode;
    how.hidden = !hasCode;
    if (hasCode) {
      code.textContent = host.code;
      const url = host.link;
      link.textContent = url.replace(/^https?:\/\//, '');
      link.href = url;
      if (qrFor !== url) {
        qrFor = url;
        drawQr(url);
      }
    } else {
      qrFor = '';
    }

    const [tone, text] = statusLine();
    status.hidden = !show || !active;
    status.dataset.tone = tone;
    statusText.textContent = text;

    signal.hidden = !(active && host.signal !== 'ok');
    signal.textContent = host.signal === 'lost'
      ? 'The pairing server is unreachable. A connected device keeps playing; tap New code if it stays like this.'
      : 'Reconnecting to the pairing server. A connected device keeps playing.';

    notice.hidden = !(active && host.notice);
    notice.textContent = host.notice || '';

    const err = lastError || (host.state === 'error' ? host.error : '');
    error.hidden = !err;
    error.textContent = err || '';

    actions.hidden = !show || !active;
    kickBtn.hidden = !host.listener;
    newBtn.disabled = host.state === 'starting';
    notes.hidden = !show;
  }

  const offs = [
    host.on('change', () => {
      if (host.state === 'live') lastError = ''; // a recovered link clears the old message
      render();
    }),
    host.on('error', (msg) => {
      lastError = msg;
      render();
    }),
  ];
  forwardErrors(host, router);
  if (router && typeof router.on === 'function') offs.push(router.on('change', render));
  render();

  return {
    el: root,
    refresh: render,
    destroy() {
      for (const off of offs) off();
      clearTimeout(copiedTimer);
      root.remove();
    },
  };
}
