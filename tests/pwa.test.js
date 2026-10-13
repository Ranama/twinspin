// Tests for the PWA files: sw.js (driven through stub self/caches/fetch on JsCheck's virtual clock),
// manifest.webmanifest and the icons it lists (PNG sizes and alpha read from the files).
//   tools/JsCheck/jscheck run tests/pwa.test.js

const realFetch = globalThis.fetch;
const SCOPE = 'https://u.github.io/twinspin/';
const ORIGIN = 'https://u.github.io';

// ------------------------------------------------------------------------------------------------- stubs

class FakeHeaders {
  constructor(init) {
    this.map = new Map();
    if (init instanceof FakeHeaders) init.map.forEach((v, k) => this.map.set(k, v));
    else if (init) for (const k of Object.keys(init)) this.map.set(k.toLowerCase(), String(init[k]));
  }
  has(k) { return this.map.has(k.toLowerCase()); }
  get(k) { return this.map.has(k.toLowerCase()) ? this.map.get(k.toLowerCase()) : null; }
}

class FakeRequest {
  constructor(input, init = {}) {
    const base = input instanceof FakeRequest ? input : null;
    this.url = base ? base.url : new URL(input, selfStub.location.href).href.split('#')[0]; // no fragments
    this.method = init.method || (base ? base.method : 'GET');
    this.mode = init.mode || (base ? base.mode : 'cors');
    this.cache = init.cache || (base ? base.cache : 'default');
    this.headers = new FakeHeaders(init.headers || (base ? base.headers : undefined));
  }
}

class FakeResponse {
  constructor(body = '', init = {}) {
    this.body = body;
    this.status = init.status === undefined ? 200 : init.status;
    this.statusText = init.statusText || '';
    this.headers = new FakeHeaders(init.headers);
    this.type = init.type || 'basic';
    this.redirected = !!init.redirected;
    this.url = init.url || '';
  }
  get ok() { return this.status >= 200 && this.status < 300; }
  clone() {
    return new FakeResponse(this.body, { status: this.status, statusText: this.statusText, headers: this.headers,
      type: this.type, redirected: this.redirected, url: this.url });
  }
  async text() { return String(this.body); }
}

function keyOf(req) {
  return typeof req === 'string' ? new URL(req, selfStub.location.href).href : req.url;
}
function stripSearch(u) {
  const x = new URL(u);
  return x.origin + x.pathname;
}

class FakeCache {
  constructor() { this.entries = new Map(); }
  async match(req, opts = {}) {
    const k = keyOf(req);
    if (this.entries.has(k)) return this.entries.get(k).clone();
    if (opts.ignoreSearch) {
      for (const [key, res] of this.entries) if (stripSearch(key) === stripSearch(k)) return res.clone();
    }
    return undefined;
  }
  async put(req, res) { this.entries.set(keyOf(req), res.clone()); }
  async addAll(reqs) {
    const got = [];
    for (const r of reqs) {
      const res = await globalThis.fetch(r);
      if (!res.ok) throw new TypeError('addAll: ' + r.url + ' ' + res.status);
      got.push([r, res]);
    }
    for (const [r, res] of got) await this.put(r, res);
  }
  async keys() { return [...this.entries.keys()].map((u) => new FakeRequest(u)); }
  async delete(req) { return this.entries.delete(keyOf(req)); }
}

class FakeCacheStorage {
  constructor() { this.map = new Map(); }
  async open(name) {
    if (!this.map.has(name)) this.map.set(name, new FakeCache());
    return this.map.get(name);
  }
  async keys() { return [...this.map.keys()]; }
  async delete(name) { return this.map.delete(name); }
}

// Fake network: url -> { status, body, type, delay }; anything else answers 404. `online = false` fails every fetch.
const net = { routes: new Map(), online: true, calls: [] };
async function fakeFetch(input, init = {}) {
  const req = input instanceof FakeRequest ? input : new FakeRequest(input);
  net.calls.push({ url: req.url, cache: init.cache || req.cache, mode: req.mode });
  const route = net.routes.get(req.url) || net.routes.get(stripSearch(req.url)); // hosts ignore the query
  if (route && route.delay) await new Promise((r) => setTimeout(r, route.delay));
  if (!net.online) throw new TypeError('Failed to fetch');
  if (!route) return new FakeResponse('missing', { status: 404 });
  return new FakeResponse(route.body, { status: route.status || 200, type: route.type || 'basic' });
}

let registry = {};
const selfStub = {
  registration: { scope: SCOPE },
  location: { href: SCOPE + 'sw.js', origin: ORIGIN },
  clients: { claimed: 0, claim() { this.claimed++; return Promise.resolve(); } },
  skipped: 0,
  skipWaiting() { this.skipped++; return Promise.resolve(); },
  addEventListener(type, fn) { registry[type] = fn; },
};

globalThis.self = selfStub;
globalThis.caches = new FakeCacheStorage();
globalThis.fetch = fakeFetch;
globalThis.Request = FakeRequest;
globalThis.Response = FakeResponse;

function resetWorld() {
  globalThis.caches = new FakeCacheStorage();
  net.routes = new Map();
  net.online = true;
  net.calls = [];
}

function route(path, body = path, extra = {}) {
  net.routes.set(new URL(path, SCOPE).href, { body, ...extra });
}

function fetchEvent(url, { mode = 'cors', method = 'GET', headers } = {}) {
  const ev = {
    request: new FakeRequest(url, { mode, method, headers }),
    responded: null,
    waits: [],
    respondWith(p) { this.responded = Promise.resolve(p); },
    waitUntil(p) { this.waits.push(Promise.resolve(p)); },
  };
  return ev;
}

async function dispatchFetch(handlers, url, opts) {
  const ev = fetchEvent(url, opts);
  handlers.fetch(ev);
  if (!ev.responded) return { ev, res: null };
  const res = await ev.responded;
  await Promise.all(ev.waits);
  return { ev, res };
}

async function install(handlers) {
  let p = null;
  handlers.install({ waitUntil(x) { p = x; } });
  return p;
}

// Load the development copy of sw.js (VERSION 'twinspin-dev').
registry = {};
await import('../sw.js');
const dev = registry;
const SHELL_CACHE = 'twinspin-dev ' + SCOPE;

// ---------------------------------------------------------------------------------------------- lifecycle

test('registers install, activate, fetch and message handlers', () => {
  for (const t of ['install', 'activate', 'fetch', 'message']) assert.equal(typeof dev[t], 'function', t);
});

test('dev install precaches best-effort with cache: reload', async () => {
  resetWorld();
  route('./');
  route('./index.html');
  route('./config.js');
  route('./manifest.webmanifest');
  await install(dev);
  const cache = await caches.open(SHELL_CACHE);
  assert.equal(cache.entries.size, 4);
  assert(await cache.match(SCOPE + 'config.js'));
  assert(net.calls.length > 10, 'tried the whole list');
  assert(net.calls.every((c) => c.cache === 'reload'), 'precache bypasses the HTTP cache');
});

test('activate deletes only this app\'s old caches for this scope, then claims', async () => {
  resetWorld();
  for (const name of [SHELL_CACHE, 'twinspin-fonts ' + SCOPE, 'twinspin-20250101-000000 ' + SCOPE,
    'twinspin-20250101-000000 https://u.github.io/other/', 'otherapp-v4']) await caches.open(name);
  const before = selfStub.clients.claimed;
  let p = null;
  dev.activate({ waitUntil(x) { p = x; } });
  await p;
  assert.deepEqual(await caches.keys(), [SHELL_CACHE, 'twinspin-fonts ' + SCOPE,
    'twinspin-20250101-000000 https://u.github.io/other/', 'otherapp-v4']);
  assert.equal(selfStub.clients.claimed, before + 1);
});

test('message skipWaiting (string or object) and version reply', async () => {
  const before = selfStub.skipped;
  dev.message({ data: 'skipWaiting' });
  dev.message({ data: { type: 'skipWaiting' } });
  dev.message({ data: { t: 'skipWaiting' } });
  dev.message({ data: 'something else' });
  assert.equal(selfStub.skipped, before + 3);
  const replies = [];
  dev.message({ data: 'version', ports: [{ postMessage: (m) => replies.push(m) }] });
  dev.message({ data: { t: 'version' }, source: { postMessage: (m) => replies.push(m) } });
  assert.equal(replies.length, 2);
  assert.equal(replies[0].version, 'twinspin-dev');
  assert.equal(replies[0].scope, SCOPE);
});

// ------------------------------------------------------------------------------------------------- fetch

test('ignores non-GET, Range, blob:, other origins and other sites on the origin', async () => {
  resetWorld();
  const cases = [
    [SCOPE + 'x.js', { method: 'POST' }],
    [SCOPE + 'song.mp3', { headers: { Range: 'bytes=0-' } }],
    ['blob:https://u.github.io/1234', {}],
    ['data:text/plain,hi', {}],
    ['https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js', {}],
    ['https://u.github.io/otherapp/index.html', { mode: 'navigate' }],
  ];
  for (const [url, opts] of cases) {
    const { res } = await dispatchFetch(dev, url, opts);
    assert.equal(res, null, url);
  }
});

test('network first: fresh answer stored with cache: no-cache, cached copy used offline', async () => {
  resetWorld();
  route('./src/main.js', 'v1');
  let { res } = await dispatchFetch(dev, SCOPE + 'src/main.js', { mode: 'cors' });
  assert.equal(res.body, 'v1');
  assert.equal(net.calls[0].cache, 'no-cache');
  route('./src/main.js', 'v2');
  ({ res } = await dispatchFetch(dev, SCOPE + 'src/main.js'));
  assert.equal(res.body, 'v2', 'network wins when online');
  net.online = false;
  ({ res } = await dispatchFetch(dev, SCOPE + 'src/main.js'));
  assert.equal(res.body, 'v2', 'latest copy offline');
  ({ res } = await dispatchFetch(dev, SCOPE + 'src/main.js?v=9'));
  assert.equal(res.body, 'v2', 'query ignored as a last resort');
});

test('network first: offline without a copy fails for scripts', async () => {
  resetWorld();
  net.online = false;
  const ev = fetchEvent(SCOPE + 'src/none.js');
  dev.fetch(ev);
  await assert.rejects(ev.responded, TypeError);
});

test('network first: slow network answers from the cache after 3 s', async () => {
  resetWorld();
  route('./css/app.css', 'old');
  await dispatchFetch(dev, SCOPE + 'css/app.css');
  route('./css/app.css', 'new', { delay: 8000 });
  const t0 = Date.now();
  const ev = fetchEvent(SCOPE + 'css/app.css');
  dev.fetch(ev);
  const res = await ev.responded;
  const waited = Date.now() - t0;
  assert.equal(res.body, 'old');
  assert(waited >= 3000 && waited < 3500, 'answered after the timeout, waited ' + waited);
  await Promise.all(ev.waits);
  const cache = await caches.open(SHELL_CACHE);
  assert.equal((await cache.match(SCOPE + 'css/app.css')).body, 'new', 'slow answer still refreshes the cache');
});

test('network first: slow network without a copy keeps waiting', async () => {
  resetWorld();
  route('./src/slow.js', 'late', { delay: 6000 });
  const t0 = Date.now();
  const { res } = await dispatchFetch(dev, SCOPE + 'src/slow.js');
  assert.equal(res.body, 'late');
  assert(Date.now() - t0 >= 6000);
});

test('network first: a 5xx answer falls back to the cached copy', async () => {
  resetWorld();
  route('./config.js', 'good');
  await dispatchFetch(dev, SCOPE + 'config.js');
  route('./config.js', 'oops', { status: 503 });
  let { res } = await dispatchFetch(dev, SCOPE + 'config.js');
  assert.equal(res.body, 'good');
  route('./other.js', 'oops', { status: 502 });
  ({ res } = await dispatchFetch(dev, SCOPE + 'other.js'));
  assert.equal(res.status, 502, 'no copy: the error answer passes through');
  route('./gone.js', 'nope', { status: 404 });
  ({ res } = await dispatchFetch(dev, SCOPE + 'gone.js'));
  assert.equal(res.status, 404);
  const cache = await caches.open(SHELL_CACHE);
  assert.equal(await cache.match(SCOPE + 'gone.js'), undefined, 'errors are never stored');
});

test('navigations: stored without the query, offline links fall back to the cached page', async () => {
  resetWorld();
  route('./', 'page');
  let { res } = await dispatchFetch(dev, SCOPE + '?listen=ABCD', { mode: 'navigate' });
  assert.equal(res.body, 'page');
  assert.equal(net.calls[0].url, SCOPE + '?listen=ABCD');
  assert.equal(net.calls[0].cache, 'no-cache', 'navigations revalidate with the host');
  assert.notEqual(net.calls[0].mode, 'navigate', 're-issued by URL, not as the navigate request');
  const cache = await caches.open(SHELL_CACHE);
  assert(await cache.match(SCOPE), 'stored under the page address without ?listen');
  assert.equal(cache.entries.size, 1);
  net.online = false;
  ({ res } = await dispatchFetch(dev, SCOPE + '?listen=WXYZ#x', { mode: 'navigate' }));
  assert.equal(res.body, 'page');
  ({ res } = await dispatchFetch(dev, SCOPE + 'index.html', { mode: 'navigate' }));
  assert.equal(res.body, 'page', 'any page in scope falls back to the app shell');
});

test('navigations: offline with nothing cached shows the offline page', async () => {
  resetWorld();
  net.online = false;
  const { res } = await dispatchFetch(dev, SCOPE, { mode: 'navigate' });
  assert.equal(res.status, 503);
  assert.match(String(res.body), /offline/i);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
});

test('navigations: a redirected cached page is rebuilt as a plain response', async () => {
  resetWorld();
  const cache = await caches.open(SHELL_CACHE);
  await cache.put(SCOPE + 'index.html', new FakeResponse('shell', { redirected: true }));
  net.online = false;
  const { res } = await dispatchFetch(dev, SCOPE + 'deep/link', { mode: 'navigate' });
  assert.equal(res.body, 'shell');
  assert.equal(res.redirected, false);
});

test('navigations: a redirected network answer is rebuilt too', async () => {
  resetWorld();
  const realFake = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const res = await realFake(input, init);
    return new FakeResponse(res.body, { status: res.status, redirected: true });
  };
  try {
    route('./', 'page');
    const { res } = await dispatchFetch(dev, SCOPE, { mode: 'navigate' });
    assert.equal(res.body, 'page');
    assert.equal(res.redirected, false);
  } finally {
    globalThis.fetch = realFake;
  }
});

test('icons: cache first', async () => {
  resetWorld();
  route('./icons/icon-192.png', 'png1');
  let { res } = await dispatchFetch(dev, SCOPE + 'icons/icon-192.png', { mode: 'no-cors' });
  assert.equal(res.body, 'png1');
  route('./icons/icon-192.png', 'png2');
  const calls = net.calls.length;
  ({ res } = await dispatchFetch(dev, SCOPE + 'icons/icon-192.png', { mode: 'no-cors' }));
  assert.equal(res.body, 'png1', 'served from the cache');
  assert.equal(net.calls.length, calls, 'no network request');
});

test('Google Fonts: cache first in a long-lived cache, opaque answers allowed', async () => {
  resetWorld();
  const css = 'https://fonts.googleapis.com/css2?family=Barlow&display=swap';
  const font = 'https://fonts.gstatic.com/s/barlow/v1/x.woff2';
  net.routes.set(css, { body: '@font-face{}', status: 0, type: 'opaque' });
  net.routes.set(font, { body: 'woff2', type: 'cors' });
  let { res } = await dispatchFetch(dev, css, { mode: 'no-cors' });
  assert.equal(res.type, 'opaque');
  ({ res } = await dispatchFetch(dev, font));
  assert.equal(res.body, 'woff2');
  const fonts = await caches.open('twinspin-fonts ' + SCOPE);
  assert.equal(fonts.entries.size, 2);
  net.online = false;
  ({ res } = await dispatchFetch(dev, font));
  assert.equal(res.body, 'woff2', 'offline from the font cache');
});

// --------------------------------------------------------------------------------- published (strict) copy

test('published copy: all-or-nothing precache with one retry', async () => {
  const src = await (await realFetch(new URL('../sw.js', import.meta.url))).text();
  const stamped = src.replace("const VERSION = 'twinspin-dev';", "const VERSION = 'twinspin-20261006-120000';");
  assert(stamped !== src, 'VERSION line is in the form publish-web.ps1 stamps');
  assert(/\/\/[ \t]*@shell-begin[\s\S]*?\/\/[ \t]*@shell-end/.test(src), 'SHELL block markers for publish-web.ps1');
  registry = {};
  new Function(stamped)();
  const pub = registry;
  const name = 'twinspin-20261006-120000 ' + SCOPE;

  resetWorld();
  route('./');
  route('./index.html');
  const p = install(pub);
  await assert.rejects(p);
  assert.equal((await caches.open(name)).entries.size, 0, 'nothing half-stored');

  resetWorld();
  const shell = src.match(/const SHELL = \[([\s\S]*?)\];/)[1].match(/'[^']+'/g).map((s) => s.slice(1, -1));
  for (const path of shell) route(path);
  await install(pub);
  assert.equal((await caches.open(name)).entries.size, shell.length);
});

test('dev SHELL list is well-formed', async () => {
  const src = await (await realFetch(new URL('../sw.js', import.meta.url))).text();
  const shell = src.match(/const SHELL = \[([\s\S]*?)\];/)[1].match(/'[^']+'/g).map((s) => s.slice(1, -1));
  assert.equal(new Set(shell).size, shell.length, 'no duplicates');
  for (const p of shell) assert(p.startsWith('./') && !p.includes('..') && !p.includes('\\'), p);
  for (const p of ['./', './index.html', './config.js', './manifest.webmanifest', './src/main.js',
    './icons/icon-192.png']) assert(shell.includes(p), p);
  assert(!shell.includes('./sw.js'), 'the worker never caches itself');
  const missing = [];
  for (const p of shell) {
    if (p === './') continue;
    const r = await realFetch(new URL('.' + p, import.meta.url));
    if (!r.ok) missing.push(p);
  }
  if (missing.length) console.log('note: the dev SHELL lists files that do not exist (yet): ' + missing.join(', '));
});

// ------------------------------------------------------------------------------------- manifest and icons

function pngInfo(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;
  const be = (o) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  return { width: be(16), height: be(20), bitDepth: bytes[24], colorType: bytes[25] };
}

async function readBytes(rel) {
  const r = await realFetch(new URL(rel, import.meta.url));
  assert(r.ok, rel + ' exists');
  return new Uint8Array(await r.arrayBuffer());
}

test('manifest has the installability fields', async () => {
  const m = JSON.parse(await (await realFetch(new URL('../manifest.webmanifest', import.meta.url))).text());
  assert.equal(m.id, './');
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  assert.equal(m.name, 'TwinSpin DJ');
  assert.equal(m.short_name, 'TwinSpin');
  assert.equal(m.display, 'standalone');
  assert.equal(m.orientation, 'any');
  assert.equal(m.background_color, '#0b0c12');
  assert.equal(m.theme_color, '#0b0c12');
  assert(m.categories.includes('music'));
  const find = (size, purpose) => m.icons.find((i) => i.sizes === size && (i.purpose || 'any').split(' ').includes(purpose));
  assert(find('192x192', 'any'), '192 any');
  assert(find('512x512', 'any'), '512 any');
  assert(find('512x512', 'maskable'), '512 maskable');
  for (const icon of m.icons) {
    assert(!icon.src.startsWith('/') && !/^[a-z]+:/i.test(icon.src), 'relative icon url ' + icon.src);
    const bytes = await readBytes('../' + icon.src);
    if (icon.type === 'image/png') {
      const info = pngInfo(bytes);
      assert(info, icon.src + ' is a PNG');
      assert.equal(info.width + 'x' + info.height, icon.sizes, icon.src + ' size');
    } else {
      assert.match(new TextDecoder().decode(bytes.slice(0, 200)), /<svg/, icon.src + ' is SVG');
    }
  }
});

test('icon files: sizes, and opaque where iOS / maskable need it', async () => {
  const expect = [
    ['../icons/icon-192.png', 192, 6],
    ['../icons/icon-512.png', 512, 6],
    ['../icons/icon-maskable-512.png', 512, 2],
    ['../icons/apple-touch-icon.png', 180, 2],
    ['../icons/favicon-32.png', 32, 6],
  ];
  for (const [path, size, colorType] of expect) {
    const info = pngInfo(await readBytes(path));
    assert(info, path);
    assert.equal(info.width, size, path);
    assert.equal(info.height, size, path);
    assert.equal(info.bitDepth, 8, path);
    assert.equal(info.colorType, colorType, path + (colorType === 2 ? ' must be opaque RGB' : ' RGBA'));
  }
});
