// Install and full-screen helpers. main.js calls initInstall() at boot so Android's beforeinstallprompt event is
// caught early; the menu sheet then offers "Install app" (Android/desktop Chrome), an "Add to Home Screen" hint
// (iPhone/iPad Safari, which has no install prompt) and a Full screen button (only where the Fullscreen API
// exists and not on iOS: iPhone has none, and on iPad a swipe down exits it mid-scratch).
//   initInstall();  if (canInstall()) promptInstall();  if (canFullscreen()) toggleFullscreen();

import { env } from '../core/env.js';

let deferred = null;
let installed = false;
const listeners = new Set();

function notify() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

/** Start listening for the install prompt (call once, early). */
export function initInstall() {
  if (typeof window === 'undefined' || !window.addEventListener) return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installed = true;
    notify();
  });
}

/** Subscribe to install availability changes. Returns an unsubscribe function. */
export function onInstallChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** True when running as an installed app (any display mode other than a browser tab). */
export function isStandalone() {
  if (env.standalone || installed) return true;
  try {
    const mm = window.matchMedia;
    return !!mm && ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay']
      .some((m) => mm(`(display-mode: ${m})`).matches);
  } catch {
    return false;
  }
}

/** An install prompt is available (Chrome/Edge/Samsung). */
export function canInstall() {
  return !!deferred && !isStandalone();
}

/** Show the browser's install prompt. Call from a click. Resolves true when accepted. */
export function promptInstall() {
  const e = deferred;
  if (!e) return Promise.resolve(false);
  deferred = null;
  notify();
  try {
    e.prompt();
    return Promise.resolve(e.userChoice).then((c) => !!c && c.outcome === 'accepted').catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

/** iPhone/iPad Safari tab: show the "Share, then Add to Home Screen" hint. */
export function showIosInstallHint() {
  return env.ios && !isStandalone() && !env.embedded;
}

/** The Fullscreen API is usable here (never on iOS). */
export function canFullscreen() {
  try {
    return !env.ios && !!document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === 'function';
  } catch {
    return false;
  }
}

export function isFullscreen() {
  try {
    return !!document.fullscreenElement;
  } catch {
    return false;
  }
}

/** Enter or leave full screen. Call from a click. */
export function toggleFullscreen() {
  try {
    if (document.fullscreenElement) return Promise.resolve(document.exitFullscreen()).catch(() => {});
    return Promise.resolve(document.documentElement.requestFullscreen({ navigationUI: 'hide' })).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}
