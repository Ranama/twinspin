// TwinSpin boot (the only module with side effects at import time).
//  - ?listen=CODE or #listen=CODE: this device is the "second device" listener -> remote/receiver.js.
//  - Otherwise the DJ app: ui/boot-app.js (Settings, AudioEngine, Library, Deck A/B, SyncController, AppUI; all
//    static imports), then the service worker.
// Each page type is ONE dynamic import on purpose: the receiver page (often a second phone on mobile data) never
// downloads or evaluates the DJ engine, and a module that fails to load (old browser, flaky network, a broken
// deploy) ends in a readable message with a Reload button instead of a blank page. No top-level await and no
// circular imports (Safari < 27 module loader bugs).

import { env } from './core/env.js';
import { initInstall } from './ui/install.js';

const root = document.getElementById('app') || document.body;
const SLOW_BOOT_MS = 20000;
let booted = false;

/** The listen code from ?listen=CODE or #listen=CODE, '' when present but empty, null when absent. */
function listenCode() {
  try {
    const q = new URLSearchParams(location.search);
    if (q.has('listen')) return clean(q.get('listen'));
    const hash = (location.hash || '').replace(/^#/, '');
    if (hash) {
      const hq = new URLSearchParams(hash);
      if (hq.has('listen')) return clean(hq.get('listen'));
    }
  } catch {
    /* ignore */
  }
  return null;
}

function clean(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function reloadButton() {
  const btn = el('button', 'btn btn-primary', 'Reload');
  btn.type = 'button';
  btn.addEventListener('click', () => location.reload());
  return btn;
}

function showBootError(err) {
  booted = true;
  console.error('[TwinSpin] boot failed', err);
  try {
    root.classList.remove('booting');
    root.textContent = '';
    const box = el('div', 'boot-error');
    box.setAttribute('role', 'alert');
    box.append(
      el('h1', '', 'TwinSpin could not start'),
      el('p', '', 'Something went wrong while loading. Check your connection and reload. If it keeps happening, ' +
        'update your browser (TwinSpin needs a recent Chrome, Safari, Edge or Firefox).'),
      el('p', 'boot-error-detail', String((err && (err.message || err)) || 'Unknown error')),
      reloadButton());
    root.append(box);
  } catch {
    /* nothing else we can do */
  }
}

/** Still on the splash after a long wait (very slow network): say so and offer Reload, keep waiting. */
function watchSlowBoot() {
  setTimeout(() => {
    if (booted) return;
    try {
      const text = root.querySelector('.boot-text');
      if (text) text.textContent = 'Still loading. Check your connection.';
      const splash = root.querySelector('.boot-splash');
      if (splash && !splash.querySelector('button')) splash.append(reloadButton());
    } catch {
      /* ignore */
    }
  }, SLOW_BOOT_MS);
}

function bootReceiverPage(code) {
  document.documentElement.dataset.mode = 'receiver';
  import('./remote/receiver.js')
    .then((m) => {
      booted = true;
      root.classList.remove('booting');
      root.textContent = '';
      m.bootReceiver(root, { code });
    })
    .catch(showBootError);
}

function bootApp() {
  document.documentElement.dataset.mode = 'dj';
  import('./ui/boot-app.js')
    .then((m) => {
      booted = true;
      const app = m.startApp(root);
      setupServiceWorker(app.ui);
    })
    .catch(showBootError);
}

function isLocalHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
}

/**
 * Register sw.js (contract section 8): only when env.serviceWorker, never on localhost, and ?nosw unregisters.
 * A new worker waits until the user taps "Reload" in the update toast (no automatic skipWaiting).
 */
function setupServiceWorker(ui) {
  let sw;
  try {
    sw = navigator.serviceWorker; // the getter throws SecurityError in sandboxed frames
  } catch {
    return;
  }
  if (!sw) return;
  let noSw = false;
  try {
    noSw = new URLSearchParams(location.search).has('nosw');
  } catch {
    noSw = false;
  }
  if (noSw || isLocalHost(location.hostname)) {
    try {
      sw.getRegistrations().then((regs) => regs.forEach((r) => r.unregister())).catch(() => {});
    } catch {
      /* ignore */
    }
    return;
  }
  if (!env.serviceWorker) return;

  let reloadRequested = false;
  try {
    sw.addEventListener('controllerchange', () => {
      if (!reloadRequested) return; // the first install claims the page: never reload mid-session
      reloadRequested = false;
      location.reload();
    });
  } catch {
    /* ignore */
  }

  const offered = new WeakSet();
  const offer = (worker) => {
    if (!worker || offered.has(worker)) return;
    offered.add(worker);
    ui.showUpdateReady(() => {
      reloadRequested = true;
      try {
        worker.postMessage('skipWaiting');
      } catch {
        location.reload();
        return;
      }
      // If the new worker never takes control (it was replaced meanwhile), reload anyway.
      setTimeout(() => {
        if (reloadRequested) location.reload();
      }, 3000);
    });
  };

  const register = () => {
    try {
      sw.register('./sw.js')
        .then((reg) => {
          if (reg.waiting && sw.controller) offer(reg.waiting);
          reg.addEventListener('updatefound', () => {
            const w = reg.installing;
            if (!w) return;
            w.addEventListener('statechange', () => {
              if (w.state === 'installed' && sw.controller) offer(w);
            });
          });
          let lastCheck = Date.now();
          document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible' || Date.now() - lastCheck < 60000) return;
            lastCheck = Date.now();
            try {
              reg.update().catch(() => {});
            } catch {
              /* ignore */
            }
          });
        })
        .catch((err) => console.warn('[TwinSpin] service worker not registered', err));
    } catch (err) {
      console.warn('[TwinSpin] service worker not registered', err);
    }
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

// Catch Android's install prompt as early as possible (it can fire before the app modules finish loading).
initInstall();
watchSlowBoot();
const code = listenCode();
if (code !== null) bootReceiverPage(code);
else bootApp();
