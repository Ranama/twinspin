// TwinSpin service worker: keeps the app shell offline for the installed app (classic worker script, no imports).
// src/main.js registers it ('./sw.js') only on HTTPS hosts: never on localhost, in the preview, or with ?nosw.
//
//   install   precache SHELL into this VERSION's cache. Requests use cache: 'reload', so a host's HTTP cache
//             (GitHub Pages: max-age=600) cannot slip old files into a new version.
//   fetch     same-origin GETs inside the app scope:
//               icons/                    cache first (the precached copy of this version)
//               everything else           network first (cache: 'no-cache', 3 s timeout), cached copy as fallback;
//                                          navigations fall back to the cached index.html, then to an offline page
//             Google Fonts (fonts.googleapis.com, fonts.gstatic.com): cache first, opaque responses allowed, kept
//             in their own cache that survives app updates.
//             Not touched: non-GET, Range requests (media), blob:, data:, other origins, other sites on this origin.
//   activate  delete this app's older caches (only ours: every GitHub Pages project site of one user shares one
//             origin and one CacheStorage), then claim open pages.
//   message   'skipWaiting' (string, or { type | t: 'skipWaiting' }) activates a waiting update. There is no
//             automatic skipWaiting: the page shows "Update ready" and posts this when the user taps it.
//             'version' replies { t: 'version', version } on event.ports[0] (or to the sender).
//
// tools/publish-web.ps1 stamps VERSION (twinspin-<UTC timestamp>) and rewrites the SHELL list in the published
// copy (site/sw.js) from the files it actually ships; that copy precaches all-or-nothing. The development copy
// (VERSION 'twinspin-dev', used through tools/phone-link.cmd) keeps a hand-maintained list and precaches it
// best-effort, so a file that does not exist yet never breaks the install.

const VERSION = 'twinspin-dev';

// @shell-begin (tools/publish-web.ps1 replaces everything up to @shell-end in the published copy)
const SHELL = [
  './',
  './index.html',
  './config.js',
  './manifest.webmanifest',
  './css/app.css',
  './css/remote.css',
  './css/widgets.css',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/icon.svg',
  './src/analysis/analyze-worker.js',
  './src/analysis/analyzer.js',
  './src/analysis/bpm.js',
  './src/analysis/loudness.js',
  './src/analysis/waveform.js',
  './src/audio/curves.js',
  './src/audio/deck-dsp.js',
  './src/audio/deck-player.js',
  './src/audio/deck-processor.js',
  './src/audio/deck-worklet-src.js',
  './src/audio/decode.js',
  './src/audio/demo-synth.js',
  './src/audio/effects.js',
  './src/audio/engine.js',
  './src/audio/mixer.js',
  './src/audio/outputs.js',
  './src/audio/pcm.js',
  './src/audio/routing-plan.js',
  './src/audio/tags.js',
  './src/core/emitter.js',
  './src/core/env.js',
  './src/core/settings.js',
  './src/core/util.js',
  './src/deck/automix-deck.js',
  './src/deck/automix-plan.js',
  './src/deck/automix.js',
  './src/deck/cue-logic.js',
  './src/deck/deck-core.js',
  './src/deck/deck-math.js',
  './src/deck/deck.js',
  './src/deck/playlist.js',
  './src/deck/sync-math.js',
  './src/deck/sync.js',
  './src/library/library.js',
  './src/main.js',
  './src/remote/peer.js',
  './src/remote/receiver.js',
  './src/remote/remote-host.js',
  './src/remote/remote-panel.js',
  './src/remote/sdp.js',
  './src/ui/app-info.js',
  './src/ui/app-ui.js',
  './src/ui/automix-text.js',
  './src/ui/automix-ui.js',
  './src/ui/boot-app.js',
  './src/ui/coach-flow.js',
  './src/ui/deck-ui.js',
  './src/ui/dom.js',
  './src/ui/format.js',
  './src/ui/fx-ui.js',
  './src/ui/install.js',
  './src/ui/keyboard.js',
  './src/ui/layout-math.js',
  './src/ui/mixer-ui.js',
  './src/ui/overlays.js',
  './src/ui/setlist-ui.js',
  './src/ui/sheets/deck-sheet.js',
  './src/ui/sheets/help-sheet.js',
  './src/ui/sheets/menu-sheet.js',
  './src/ui/sheets/outputs-sheet.js',
  './src/ui/sheets/settings-sheet.js',
  './src/ui/sheets/sheet.js',
  './src/ui/songs-ui.js',
  './src/ui/track-loader.js',
  './src/ui/widgets/color-math.js',
  './src/ui/widgets/controls.js',
  './src/ui/widgets/dom-util.js',
  './src/ui/widgets/gesture-math.js',
  './src/ui/widgets/platter-art.js',
  './src/ui/widgets/platter.js',
  './src/ui/widgets/slider-core.js',
  './src/ui/widgets/wave-tiles.js',
  './src/ui/widgets/waveview.js',
];
// @shell-end


const NETWORK_TIMEOUT_MS = 3000;
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const FONT_CACHE_MAX = 40;

// A published copy precaches all-or-nothing, so an update can never replace a complete offline copy with a partial
// one (a failed install keeps the old version running). The development copy ('-dev') is best-effort.
const STRICT_PRECACHE = !/-dev$/.test(VERSION);

const SCOPE = self.registration && self.registration.scope
  ? self.registration.scope
  : new URL('./', self.location.href).href;
const CACHE_PREFIX = 'twinspin-';
const SHELL_CACHE = VERSION + ' ' + SCOPE;
const FONT_CACHE = CACHE_PREFIX + 'fonts ' + SCOPE;

const OFFLINE_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#0b0c12">' +
  '<title>TwinSpin is offline</title><style>html,body{margin:0;height:100%;background:#0b0c12;color:#f1f2f8;' +
  'font:18px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}body{display:flex;flex-direction:column;' +
  'align-items:center;justify-content:center;gap:16px;padding:0 24px;text-align:center;box-sizing:border-box}' +
  'h1{font-size:24px;margin:0}p{margin:0;color:#a9aec0;max-width:28em}button{font:inherit;font-weight:700;' +
  'min-height:56px;padding:0 28px;border:0;border-radius:12px;background:#5be38a;color:#0b0c12}</style></head>' +
  '<body><h1>TwinSpin is offline</h1><p>This device has no connection, and the app is not saved for offline use ' +
  'yet. Connect to the internet once and open TwinSpin again.</p>' +
  '<button onclick="location.reload()">Try again</button></body></html>';

// ------------------------------------------------------------------------------------------------------ lifecycle

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(cleanUp());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  const type = typeof data === 'string' ? data : (data && (data.type || data.t)) || '';
  if (type === 'skipWaiting') {
    self.skipWaiting();
  } else if (type === 'version') {
    const reply = { t: 'version', version: VERSION, scope: SCOPE };
    const port = event.ports && event.ports[0];
    try {
      if (port) port.postMessage(reply);
      else if (event.source && event.source.postMessage) event.source.postMessage(reply);
    } catch {
      /* the page went away */
    }
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.headers && req.headers.has && req.headers.has('range')) return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return; // blob:, data:, extensions
  if (url.origin === self.location.origin) {
    if (!url.href.startsWith(SCOPE)) return; // another site on this origin
    if (isIcon(url)) event.respondWith(cacheFirst(event, req, SHELL_CACHE, false));
    else event.respondWith(networkFirst(event, req, url));
    return;
  }
  if (FONT_HOSTS.indexOf(url.hostname) >= 0) event.respondWith(cacheFirst(event, req, FONT_CACHE, true));
});

// ------------------------------------------------------------------------------------------------------ install

function freshRequest(path) {
  return new Request(path, { cache: 'reload' });
}

async function precache() {
  const cache = await caches.open(SHELL_CACHE);
  if (STRICT_PRECACHE) {
    try {
      await cache.addAll(SHELL.map(freshRequest));
    } catch {
      // One retry for a flaky network; a second failure fails the install and the old version keeps running.
      await wait(1500);
      await cache.addAll(SHELL.map(freshRequest));
    }
    return;
  }
  await Promise.all(SHELL.map(async (path) => {
    try {
      const req = freshRequest(path);
      const res = await fetch(req);
      if (res && res.ok) await cache.put(req, res);
    } catch {
      /* not there in this development copy */
    }
  }));
}

async function cleanUp() {
  try {
    const names = await caches.keys();
    await Promise.all(names.filter(isOldCache).map((name) => caches.delete(name)));
  } catch {
    /* storage unavailable: nothing to clean */
  }
  try {
    await self.clients.claim();
  } catch {
    /* another worker took over */
  }
}

function isOldCache(name) {
  return name !== SHELL_CACHE && name !== FONT_CACHE &&
    name.indexOf(CACHE_PREFIX) === 0 && name.slice(-(SCOPE.length + 1)) === ' ' + SCOPE;
}

// -------------------------------------------------------------------------------------------------- strategies

function isIcon(url) {
  return url.href.indexOf(SCOPE + 'icons/') === 0;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Same-origin (or rebuilt by withoutRedirect), complete answer that may be stored. */
function cacheable(res) {
  return !!res && res.status === 200 && (res.type === 'basic' || res.type === 'default');
}

// Navigations are stored without their query (?listen=CODE etc.) so one copy of the page serves every link.
function navigationKey(url) {
  return url.origin + url.pathname;
}

async function putInCache(cacheName, key, res) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(key, res);
    if (cacheName === FONT_CACHE) {
      const keys = await cache.keys();
      for (let i = 0; i < keys.length - FONT_CACHE_MAX; i++) await cache.delete(keys[i]);
    }
  } catch {
    /* quota or storage blocked: the app still works online */
  }
}

async function fromCache(req, url) {
  try {
    const cache = await caches.open(SHELL_CACHE);
    if (req.mode === 'navigate') {
      const hit = (await cache.match(navigationKey(url), { ignoreSearch: true, ignoreVary: true })) ||
        (await cache.match(SCOPE + 'index.html', { ignoreVary: true })) ||
        (await cache.match(SCOPE, { ignoreVary: true }));
      return hit ? withoutRedirect(hit) : null;
    }
    return (await cache.match(req)) || (await cache.match(req, { ignoreSearch: true, ignoreVary: true })) || null;
  } catch {
    return null;
  }
}

// Browsers refuse a redirected response for a navigation; rebuild it as a plain response.
function withoutRedirect(res) {
  if (!res.redirected) return res;
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

function offlineResponse() {
  return new Response(OFFLINE_PAGE, {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function networkFirst(event, req, url) {
  const navigate = req.mode === 'navigate';
  const key = navigate ? navigationKey(url) : req;
  let saving = Promise.resolve();
  // A navigation request cannot be re-issued with a RequestInit in every engine, so navigations are fetched by
  // URL; 'no-cache' revalidates with the host, so a fresh deploy never meets a 10-minute-old page.
  const request = navigate
    ? fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }).then(withoutRedirect)
    : fetch(req, { cache: 'no-cache' });
  const network = request.then((res) => {
    if (cacheable(res)) saving = putInCache(SHELL_CACHE, key, res.clone());
    return res;
  });
  // Keep the worker alive until the fresh copy is stored, even when the cached copy answered first.
  event.waitUntil(network.then(() => saving, () => undefined));

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = 0;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    // failure: undefined = only the timeout fired (keep waiting when there is no copy),
    // { res } = the host answered 5xx, { err } = the network failed.
    const fallBack = (failure) => fromCache(req, url).then((cached) => {
      if (cached) settle(resolve, cached);
      else if (!failure) return;
      else if (failure.res) settle(resolve, failure.res);
      else if (navigate) settle(resolve, offlineResponse());
      else settle(reject, failure.err);
    });
    // Slow network: answer from the cache after 3 s when there is a copy.
    timer = setTimeout(() => {
      if (!settled) fallBack(undefined);
    }, NETWORK_TIMEOUT_MS);
    network.then((res) => {
      if (res.status >= 500) fallBack({ res }); // host hiccup: a cached copy beats an error page
      else settle(resolve, res);
    }, (err) => fallBack({ err: err || new TypeError('Network error') }));
  });
}

async function cacheFirst(event, req, cacheName, allowOpaque) {
  let cache = null;
  try {
    cache = await caches.open(cacheName);
    const hit = await cache.match(req, { ignoreVary: true });
    if (hit) return hit;
  } catch {
    cache = null;
  }
  const res = await fetch(req);
  if (cache && (cacheable(res) || (res.ok && res.type === 'cors') || (allowOpaque && res.type === 'opaque'))) {
    event.waitUntil(putInCache(cacheName, req, res.clone()));
  }
  return res;
}
