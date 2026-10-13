// Feature detection, read once at start-up. UI and audio code branch on these flags instead of sniffing
// browsers themselves. `config` is window.TWINSPIN_CONFIG from config.js (classic script loaded first).

const g = globalThis;
const nav = g.navigator || {};
const ua = nav.userAgent || '';

export const config = Object.freeze({
  preview: false,          // true inside the claude.ai artifact preview: no service worker, no WebRTC, no mic
  peerJsUrl: null,         // optional override of the PeerJS 1.5.5 UMD URL (see src/remote/peer.js)
  peerOptions: null,       // optional PeerJS options (host/port/path/key) for a self-hosted signalling server
  iceServers: null,        // optional RTCIceServer[] override
  ...(g.TWINSPIN_CONFIG || {}),
});

const isIOS = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1);
const isAndroid = /Android/.test(ua);

function inFrame() {
  try {
    return g.self !== g.top;
  } catch {
    return true;
  }
}

function proto(name) {
  return g[name] && g[name].prototype;
}

const secure = !!g.isSecureContext;
const media = nav.mediaDevices || null;

export const env = Object.freeze({
  secure,
  ios: isIOS,
  android: isAndroid,
  mobile: isIOS || isAndroid || /Mobi/.test(ua),
  safari: /Safari/.test(ua) && !/Chrome|CriOS|FxiOS|EdgiOS|Android/.test(ua),
  firefox: /Firefox|FxiOS/.test(ua),
  standalone: !!(g.matchMedia && g.matchMedia('(display-mode: standalone)').matches) || nav.standalone === true,
  embedded: inFrame(),
  preview: !!config.preview,
  touch: (nav.maxTouchPoints || 0) > 0 || 'ontouchstart' in g,
  audioWorklet: secure && typeof g.AudioWorkletNode === 'function',
  ctxSetSinkId: !!(proto('AudioContext') && 'setSinkId' in proto('AudioContext')),
  mediaSetSinkId: !!(proto('HTMLMediaElement') && 'setSinkId' in proto('HTMLMediaElement')),
  selectAudioOutput: !!(media && typeof media.selectAudioOutput === 'function'),
  enumerateDevices: !!(media && typeof media.enumerateDevices === 'function'),
  getUserMedia: !!(media && typeof media.getUserMedia === 'function'),
  webrtc: typeof g.RTCPeerConnection === 'function' && !config.preview,
  serviceWorker: 'serviceWorker' in nav && secure && !config.preview,
  wakeLock: 'wakeLock' in nav,
  vibrate: typeof nav.vibrate === 'function',
  audioSession: 'audioSession' in nav,
  moduleWorker: typeof g.Worker === 'function',
});

let hapticsOn = true;
/** Enable/disable haptic ticks (wired to settings 'haptics'). */
export function setHaptics(on) {
  hapticsOn = !!on;
}

/** Short vibration tick on devices that support it (Android). No-op elsewhere. */
export function haptic(ms = 8) {
  if (!hapticsOn || !env.vibrate) return;
  try {
    nav.vibrate(ms);
  } catch {
    /* ignore */
  }
}
