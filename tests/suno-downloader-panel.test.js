// The page part of extras/suno-playlist-downloader.js (the Suno playlist helper), run for real on the fake DOM with a
// fake suno.com behind fetch (no network): the panel in its shadow root; waiting for a sign-in when window.Clerk and the
// cookie are missing, then reading the playlist by itself once the page's own request shows one (only on a playlist
// page: Library, then Back); Reload; the counts and downloads left; "A folder I pick" (asked for right inside the Start
// click; Reload does nothing while that question is open); Pause / Resume from the panel (a double click or a quick
// second click never resumes at once; the file in flight is aborted and fetched again); the tab title; the summary
// with the folder and the next step; a redirect away from Suno's hosts refused; a removed playlist subfolder made again;
// Retry failed (the folder permission asked inside the click); Copy log; minimise to the pill and back; dragging kept
// inside the window, also after a resize; the remembered position; Downloads mode (one <a download> per file); Close:
// the page's fetch, title and storage are left as they were (only the suno-dl.* keys, never a token); and pasting the
// script again while a run waits: the old run stops, its panel and its timers go, one panel stays.
import { installFakeDom, FakeEvent, Element } from './helpers/fake-dom.js';

const PL = '0f0e0d0c-1111-4222-8333-444455556666';
const ME = 'user-me';
const cid = (n) => `${String(n).repeat(8).slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CLIPS = [
  { id: cid(1), title: 'Song 1', user_id: ME, status: 'complete', audio_url: 'https://studio-api.prod.suno.com/api/forbidden' },
  { id: cid(2), title: 'Someone else', user_id: 'other', handle: 'dj', status: 'complete' },
  { id: cid(3), title: 'Song <b>3</b>', user_id: ME, status: 'complete', audio_url: 'https://studio-api.prod.suno.com/api/forbidden' },
];
const SCRIPT_URL = new URL('../extras/suno-playlist-downloader.js', import.meta.url);
const SOURCE = await (await fetch(SCRIPT_URL)).text(); // for pasting it a second time (a classic script, run with eval)

installFakeDom({ width: 360, height: 560 });
const consoleLines = []; // the script's own console lines ([suno-dl] ...), kept out of the test output
for (const k of ['log', 'warn']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => (a[0] === '[suno-dl]' ? consoleLines.push(a.slice(1).join(' ')) : orig(...a));
}
// every pending timer and when it is due (Close must clear the panel's and its run's timers)
const timers = new Map();
const setT = globalThis.setTimeout, clearT = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms = 0, ...args) => {
  const id = setT(() => { timers.delete(id); fn(...args); }, ms);
  timers.set(id, Date.now() + ms);
  return id;
};
globalThis.clearTimeout = (id) => { timers.delete(id); clearT(id); };
const latestTimer = () => Math.max(0, ...[...timers.values()].map((due) => due - Date.now()));

Object.assign(location, { hostname: 'suno.com', origin: 'https://suno.com', pathname: `/playlist/${PL}`, href: `https://suno.com/playlist/${PL}` });
document.title = 'Road Trip | Suno';
Element.prototype.attachShadow = function attachShadow() {
  const r = new Element('div');
  this.appendChild(r);
  return r;
};
let objectUrls = 0;
URL.createObjectURL = () => `blob:https://suno.com/${++objectUrls}`;
URL.revokeObjectURL = () => {};
globalThis.Blob = class {
  constructor(parts = [], o = {}) {
    this.type = o.type || '';
    this.size = parts.reduce((n, p) => n + (p.byteLength ?? p.size ?? String(p).length), 0);
  }

  slice() {
    return { arrayBuffer: async () => new Uint8Array([0x49, 0x44, 0x33, 4]).buffer };
  }
};
globalThis.AbortController = class {
  constructor() {
    const fns = [];
    this.signal = { aborted: false, addEventListener: (t, fn) => fns.push(fn) };
    this.abort = () => { this.signal.aborted = true; fns.forEach((fn) => fn()); };
  }
};
let copied = null;
navigator.clipboard = { writeText: async (t) => { copied = t; } };

// ---- a fake suno.com: Suno's API on both API hosts, the signed download bucket
const requests = [];
let slow = null; // (url, signal) => a promise for a slow download (or another answer), or null
let redirect = null; // (url) => the address the bucket's answer finally came from (a redirect), or null
const polls = {};
let used = 3; // downloads used this period (each unlock counts one)
const res = (status, data, headers = {}) => ({
  status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => (data == null ? '' : JSON.stringify(data)), body: null,
});
const originalFetch = async (input, init = {}) => {
  const url = String(input), u = new URL(url), method = init.method || 'GET';
  requests.push({ url, method, headers: init.headers || {}, credentials: init.credentials });
  if (/^studio-api[.-]prod\.suno\.com$/.test(u.hostname)) {
    if ((init.headers || {}).Authorization === 'Bearer stale-token') return res(401, { detail: 'Unauthorized' }); // a sign-in that ran out
    const path = u.pathname + u.search;
    let m;
    if (/^\/api\/feed\//.test(path)) return res(200, { clips: [{ id: 'x', user_id: ME }] });
    if ((m = /^\/api\/playlist\/([^/]+)\/\?page=(\d+)$/.exec(path))) {
      return res(200, { name: 'Road Trip', num_total_results: 3, playlist_clips: m[2] === '1' ? CLIPS.map((clip) => ({ clip })) : [] });
    }
    if (path === '/api/billing/info/') return res(200, { download_usage: { current_period_downloads_limit: 20, current_period_downloads_used: used } });
    if (path === '/api/download/authorize') { used++; return res(200, {}); }
    if ((m = /^\/api\/download\/clip\/([^?]+)\?format=mp3$/.exec(path))) {
      polls[m[1]] = (polls[m[1]] || 0) + 1;
      return res(200, polls[m[1]] === 1 ? { status: 'processing' } : { status: 'ready', download_url: `https://suno-data-uploads.s3.amazonaws.com/${m[1]}.mp3?sig=1` });
    }
    return res(404, { detail: 'Not found' });
  }
  if (u.hostname === 'suno-data-uploads.s3.amazonaws.com') {
    const pending = slow && slow(url, init.signal);
    if (pending) return pending;
    let i = 0;
    const body = { getReader: () => ({ read: async () => (i++ < 3 ? { done: false, value: new Uint8Array(1000) } : { done: true }) }) };
    return { ...res(200, null, { 'content-type': 'audio/mpeg', 'content-length': '3000' }), body, url: (redirect && redirect(url)) || url };
  }
  return res(404, null);
};
globalThis.fetch = originalFetch;

// ---- "A folder I pick": an in-memory folder (goneDirs: subfolders someone removed while the panel was open)
const disk = new Map();
const goneDirs = new Set();
let inClick = false, pickedInClick = null, permInClick = null, pickerGate = null, dirCalls = 0;
function dirHandle(path) {
  const subs = new Map();
  return {
    kind: 'directory', name: path.split('/').pop(),
    async getDirectoryHandle(n) {
      dirCalls++;
      goneDirs.delete(`${path}/${n}`); // ({ create: true } makes it again)
      if (!subs.has(n)) subs.set(n, dirHandle(`${path}/${n}`));
      return subs.get(n);
    },
    async getFileHandle(n, o) {
      if (goneDirs.has(path)) throw Object.assign(new Error('A requested file or directory could not be found.'), { name: 'NotFoundError' });
      const key = `${path}/${n}`;
      if (!disk.has(key) && !(o && o.create)) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
      return {
        getFile: async () => ({ size: disk.has(key) ? disk.get(key).size : 0 }),
        createWritable: async () => ({ write: async (b) => disk.set(key, b), close: async () => {}, abort: async () => {} }),
      };
    },
    requestPermission: async (o) => { permInClick = inClick && o && o.mode === 'readwrite'; return 'granted'; },
  };
}
globalThis.showDirectoryPicker = (o) => {
  pickedInClick = inClick && o && o.mode === 'readwrite';
  return (pickerGate || Promise.resolve()).then(() => dirHandle('Music'));
};

async function until(fn, ms = 10 * 60 * 1000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hosts = () => document.documentElement.children.filter((n) => n.id === 'suno-dl-host');
const host = () => document.getElementById('suno-dl-host');
const $ = (sel) => host().querySelector(sel);
const $$ = (sel) => host().querySelectorAll(sel);
const text = (el) => (el ? el.textContent : '');
const button = (label) => $$('button').find((b) => text(b) === label || text(b).startsWith(label));
const click = (el) => { inClick = true; el.click(); inClick = false; };
const pointer = (el, type, x, y) => el.dispatchEvent(new FakeEvent(type, { button: 0, clientX: x, clientY: y, pointerId: 1 }));
const msg = () => ($('.msg').classList.contains('hidden') ? '' : text($('.msg')));
const rowStates = () => $$('.song .st').map(text);
const box = (label) => $$('input').find((b) => b.parentNode.textContent === label);
const tick = (label, on) => { const b = box(label); b.checked = on; b.dispatchEvent(new FakeEvent('change')); };
const pageRequest = (token = 'page-token') => window.fetch('https://studio-api-prod.suno.com/api/feed/v2?page=0',
  { headers: { Authorization: `Bearer ${token}`, 'Device-Id': 'dev-1' } }); // suno.com's app talking to Suno
const WAITING = 'Waiting for your sign-in. Make sure you are signed in on suno.com, then click something on suno.com in this tab ' +
  '(for example Library, then Back to this playlist): the panel reads the playlist as soon as the page talks to Suno.';

await import('../extras/suno-playlist-downloader.js');

test('the panel opens in its shadow root and waits for a sign-in when there is none to read', async () => {
  assert(host(), 'the panel host is on the page');
  assert.equal(host().parentNode, document.documentElement);
  assert.equal(text($('.head b')), 'Suno playlist downloader');
  assert.match(text($('style')), /\.panel \{/, 'its styles live inside the shadow root');
  assert.equal(typeof window.__sunoPlaylistDl.destroy, 'function');
  assert(await until(() => msg() === WAITING), 'no Clerk, no cookie, no page request yet');
  assert(host().querySelector('.msg.warn'), 'a calm warning, not an error');
  assert.equal(requests.length, 0, 'nothing is sent without a sign-in');
  assert.equal(text($('.pill span')), 'Waiting');
});

test('the sign-in in the page\'s own request reads the playlist by itself, on the playlist page (Library, then Back); Reload', async () => {
  // Library (no playlist in the address): a sign-in is seen, but there is nothing to read there yet
  location.pathname = '/me';
  await pageRequest('stale-token');
  await sleep(2000);
  assert.equal(requests.length, 1, 'only the page\'s own request');
  assert.equal(msg(), WAITING);
  // Back on the playlist: the panel tries by itself, but Suno refuses that sign-in (it ran out)
  location.pathname = `/playlist/${PL}`;
  await pageRequest('stale-token');
  assert(await until(() => /^Suno did not accept your sign-in \(HTTP 401\)\./.test(msg())), msg());
  assert.equal(msg(), 'Suno did not accept your sign-in (HTTP 401). Make sure you are signed in, then click something on suno.com in this ' +
    'tab (for example Library, then Back to this playlist): the panel tries again when the page talks to Suno. Or press Reload.');
  // the page keeps using that refused sign-in: no new try on each of its requests
  let n = requests.length;
  await pageRequest('stale-token');
  await sleep(2000);
  assert.equal(requests.length, n + 1, 'only the page\'s own request');
  // the page renews its sign-in: the panel reads the playlist by itself
  const first = requests.length;
  await pageRequest();
  assert(await until(() => /3 songs: 2 yours, 1 by others/.test(text($('.muted')))), 'loaded without a click');
  const api = requests.slice(first + 1);
  assert(api.length >= 3);
  for (const r of api) {
    assert.match(r.url, /^https:\/\/studio-api-prod\.suno\.com\/api\//, 'the API host the page uses');
    assert.equal(r.headers.Authorization, 'Bearer page-token');
    assert.equal(r.headers['Device-Id'], 'dev-1');
    assert.match(r.headers['Browser-Token'], /^\{"token":"[A-Za-z0-9+/=]+"\}$/);
  }
  assert.equal(text($('.t')), 'Road Trip');
  assert(await until(() => $$('.muted').some((e) => text(e) === 'Suno downloads left this period: 17')));
  // loaded: more page requests do not read it again; Reload does
  n = requests.length;
  await pageRequest();
  await sleep(2000);
  assert.equal(requests.length, n + 1, 'only the page\'s own request');
  n = requests.length;
  click(button('Reload'));
  assert(await until(() => requests.slice(n).some((r) => r.url.endsWith('/api/billing/info/')) && /3 songs/.test(text($('.muted')))));
  assert(requests.slice(n).some((r) => r.url.endsWith(`/api/playlist/${PL}/?page=1`)), 'Reload reads the playlist again');
  assert.deepEqual($$('.song .ti').map(text), ['Song 1', 'Someone else', 'Song <b>3</b>'], 'titles are text, never HTML');
  assert.deepEqual(rowStates(), ['waiting', 'skipped: not yours (@dj)', 'waiting']);
  // the setup: formats (MP3 ticked), numbering, both places to save (this browser can pick a folder), resume, Suno's Download
  const labels = $$('label').map(text);
  assert.deepEqual(labels.slice(0, 6), ['MP3 audio', 'WAV (Pro/Premier)', 'MP4 video', 'Cover image', 'Lyrics (.txt)', 'Metadata (.json)']);
  assert(labels.includes('Number files in playlist order'));
  assert(labels.includes('A folder I pick (a subfolder named after the playlist)'));
  assert(labels.includes('Downloads folder (the browser may ask to allow multiple downloads)'));
  assert(labels.includes('Skip songs saved before'));
  assert(labels.includes('Use Suno\'s own Download when the direct file is blocked (counts toward your plan\'s downloads)'));
  const boxes = $$('input');
  assert.deepEqual(boxes.filter((b) => b.getAttribute('type') === 'checkbox' && b.checked).map((b) => b.value || 'x').length, 4, 'MP3, numbering, skip saved, Suno\'s Download');
  assert.equal(boxes.find((b) => b.getAttribute('type') === 'radio' && b.checked).parentNode.textContent.startsWith('A folder I pick'), true, 'a folder by default');
  assert.equal(text($('.pill span')), 'Ready');
});

test('Start asks for the folder right in the click; Pause and Resume from the panel; the summary and the tab title', async () => {
  let held = 0;
  slow = (url, signal) => {
    if (!url.includes(cid(3)) || held++) return null;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  };
  let openPicker = null;
  pickerGate = new Promise((r) => { openPicker = r; });
  click(button('Start'));
  assert.equal(pickedInClick, true, 'showDirectoryPicker ran inside the click, before any await');
  // while the folder question is open, Reload does nothing (the playlist must not change under the run)
  const n = requests.length;
  click(button('Reload'));
  await sleep(1000);
  assert.equal(requests.length, n, 'no reading while the folder question is open');
  assert.equal(button('Reload').disabled, true);
  openPicker();
  pickerGate = null;
  assert(await until(() => held === 1), 'song 3 is downloading');
  assert(await until(() => /^1\/2 Suno downloader$/.test(document.title)), document.title);
  assert($('.sec').classList.contains('hidden'), 'the setup hides during a run');
  assert.equal(text($('.song.working .ti')), 'Song <b>3</b>');
  // Pause. A quick second click while the button still says Pause, and the second click of a double click that lands
  // after the button says Resume, never resume.
  const pause = button('Pause');
  pause.dispatchEvent(new FakeEvent('click', { button: 0, detail: 1 }));
  await sleep(1);
  assert.equal(window.__sunoPlaylistDl.state().phase, 'paused', 'paused at once');
  assert.equal(text(pause), 'Pause', 'the label follows at the next redraw');
  pause.dispatchEvent(new FakeEvent('click', { button: 0, detail: 1 }));
  await sleep(1);
  assert.equal(window.__sunoPlaylistDl.state().phase, 'paused', 'a quick second click does what the button said: Pause');
  assert(await until(() => text(button('Resume')) === 'Resume'));
  pause.dispatchEvent(new FakeEvent('click', { button: 0, detail: 2 }));
  await sleep(1000);
  assert.equal(window.__sunoPlaylistDl.state().phase, 'paused', 'the second click of a double click is ignored');
  assert.equal(msg(), 'Paused. Press Resume to go on.');
  assert(await until(() => document.title === 'Paused · 1/2 Suno downloader'));
  click(button('Resume'));
  assert(await until(() => document.title === 'Done · Suno downloader'));
  assert.equal(held, 2, 'the aborted file was fetched again');
  assert.deepEqual([...disk.keys()], ['Music/Road Trip/01 - Song 1 [11111111].mp3', 'Music/Road Trip/03 - Song _b_3_b_ [33333333].mp3']);
  assert.equal(disk.get('Music/Road Trip/01 - Song 1 [11111111].mp3').size, 3000, 'the streamed bytes');
  assert(await until(() => !$('.msg.ok').classList.contains('hidden')));
  const summary = $$('.msg').find((e) => !e.classList.contains('hidden') && /Saved 2 songs/.test(text(e)));
  assert(summary, 'the summary shows');
  assert.equal(text(summary), 'Saved 2 songs, 0 failed, 1 skipped.Saved in the folder “Music/Road Trip”.Add them to TwinSpin: Add music > This device, ' +
    'or upload the folder to Google Drive and paste the link.');
  assert.deepEqual($$('.counts b').map(text), ['2', '1', '0', '15']);
  assert.equal(text(button('Start again')), 'Start again');
  assert.equal(button('Retry failed').classList.contains('hidden'), true, 'nothing failed');
  // the files went to the signed bucket without cookies or the sign-in
  for (const r of requests.filter((x) => x.url.startsWith('https://suno-data-uploads'))) {
    assert.equal(r.credentials, 'omit');
    assert.equal(r.headers.Authorization, undefined);
  }
  // only the small resume record is stored
  assert.deepEqual(JSON.parse(localStorage.getItem(`suno-dl.done.${PL}`)), { v: 1, files: { [cid(1)]: ['mp3'], [cid(3)]: ['mp3'] } });
});

test('a redirect away from Suno\'s hosts is refused; a removed playlist folder is made again; Retry failed asks for the folder in the click', async () => {
  tick('Skip songs saved before', false);
  redirect = (url) => (url.includes(cid(1)) ? 'https://evil.example/stolen.mp3' : null);
  slow = (url) => { if (url.includes(cid(3))) goneDirs.add('Music/Road Trip'); return null; }; // someone removes the folder
  click(button('Start again'));
  assert(await until(() => rowStates().join('|') === 'failed: refused: the file came from evil.example (not a Suno address)|skipped: not yours (@dj)|saved'),
    rowStates().join('|'));
  assert.equal(window.__sunoPlaylistDl.state().phase, 'done', 'the removed folder did not stop the run: it was made again');
  assert(!requests.some((r) => r.url.includes('evil.example')));
  assert(await until(() => $$('.msg').some((e) => !e.classList.contains('hidden') && text(e).startsWith('Saved 1 song, 1 failed, 1 skipped.'))));
  assert.equal(text(button('Retry failed')), 'Retry failed (1)');
  assert.equal(button('Retry failed').classList.contains('hidden'), false);
  // Retry failed: the same folder, its permission asked right in the click
  redirect = null;
  slow = null;
  click(button('Retry failed'));
  assert.equal(permInClick, true, 'requestPermission ran inside the click');
  assert(await until(() => rowStates().join('|') === 'saved|skipped: not yours (@dj)|saved'), rowStates().join('|'));
  assert.deepEqual([...disk.keys()].sort(), ['Music/Road Trip/01 - Song 1 [11111111].mp3', 'Music/Road Trip/03 - Song _b_3_b_ [33333333].mp3']);
  tick('Skip songs saved before', true);
});

test('the log, Copy log, minimise to the pill and back, dragging inside the window, a smaller window', async () => {
  const log = $('details');
  log.open = true;
  log.dispatchEvent(new FakeEvent('toggle'));
  assert(await until(() => /Saved Road Trip\/01 - Song 1 \[11111111\]\.mp3 \(3 KB\)\./.test(text($('pre')))));
  click(button('Copy log'));
  assert(await until(() => copied !== null));
  assert.match(copied, /Unlocked "Song 1" with Suno's own Download \(counts 1 of your plan's downloads\)\./);
  assert(!/page-token/.test(copied), 'no sign-in token in the log');
  assert(consoleLines.some((l) => /^Unlocked "Song 1"/.test(l)), 'the log also goes to the console as [suno-dl] lines');
  assert(!consoleLines.some((l) => /page-token/.test(l)));
  // minimise: the pill, bottom-right, says Done
  click($('.head button'));
  const layer = $('.layer'), pill = $('.pill');
  assert(layer.classList.contains('min'));
  assert.equal([pill.style.left, pill.style.top].join(' '), '224px 496px');
  assert(await until(() => text(pill) === 'Done'));
  assert.equal($('.ring').style['--p'], '100');
  // a drag moves the pill (kept inside the window) and does not open the panel; a click does
  pointer(pill, 'pointerdown', 250, 520);
  pointer(pill, 'pointermove', -900, -900);
  pointer(pill, 'pointerup', -900, -900);
  assert.equal([pill.style.left, pill.style.top].join(' '), '0px 0px');
  assert(layer.classList.contains('min'), 'a drag is not a click');
  pointer(pill, 'pointerdown', 10, 10);
  pointer(pill, 'pointerup', 11, 11);
  assert(!layer.classList.contains('min'), 'a click opens the panel again');
  // drag the panel by its header far away: it stays inside the window, and the place is remembered
  const head = $('.head'), panel = $('.panel');
  pointer(head, 'pointerdown', 100, 20);
  pointer(head, 'pointermove', 5000, 5000);
  pointer(head, 'pointerup', 5000, 5000);
  assert.equal([panel.style.left, panel.style.top].join(' '), '240px 512px');
  assert.deepEqual(JSON.parse(localStorage.getItem('suno-dl.pos')), { panel: { x: 240, y: 512 }, pill: { x: 0, y: 0 } });
  // the window gets smaller: the panel moves back inside it
  Object.assign(window, { innerWidth: 300, innerHeight: 400 });
  window.dispatchEvent(new FakeEvent('resize'));
  assert.equal([panel.style.left, panel.style.top].join(' '), '180px 352px');
  Object.assign(window, { innerWidth: 360, innerHeight: 560 });
});

test('Downloads mode saves through <a download>; songs saved before are skipped; Close leaves the page as it was', async () => {
  const clicked = [];
  document.addEventListener('click', (e) => { if (e.target.tagName === 'A') clicked.push([e.target.download, e.target.href]); }, true);
  const radios = $$('input').filter((b) => b.getAttribute('type') === 'radio');
  const downloads = radios.find((b) => b.parentNode.textContent.startsWith('Downloads folder'));
  for (const r of radios) r.checked = r === downloads; // (the fake DOM has no radio groups)
  downloads.dispatchEvent(new FakeEvent('change'));
  assert.equal(JSON.parse(localStorage.getItem('suno-dl.settings')).saveTo, 'downloads');
  const forget = button('Forget saved progress');
  const before = msg();
  click(forget);
  assert.equal(text(forget), 'Click again to forget saved progress');
  assert.equal(msg(), before); // nothing above the button moves between the two clicks
  click(forget);
  assert.equal(text(forget), 'Forget saved progress');
  assert.equal(localStorage.getItem(`suno-dl.done.${PL}`), null);
  click(button('Start again'));
  assert(await until(() => document.title === 'Done · Suno downloader' && clicked.length === 2));
  assert.deepEqual(clicked.map((c) => c[0]), ['01 - Song 1 [11111111].mp3', '03 - Song _b_3_b_ [33333333].mp3']);
  assert(clicked.every((c) => c[1].startsWith('blob:https://suno.com/')));
  assert(await until(() => $$('.msg').some((e) => !e.classList.contains('hidden') && text(e).includes('The files are in your Downloads folder. If ' +
    'some are missing, allow downloads from suno.com (the icon in the address bar), untick “Skip songs saved before” and Start again.'))));
  // again with "Skip songs saved before": nothing new
  click(button('Start again'));
  assert(await until(() => rowStates().join('|') === 'skipped: saved before|skipped: not yours (@dj)|skipped: saved before'));
  assert.equal(clicked.length, 2);
  // close: the panel goes, the page's fetch and title come back, storage holds only the panel's small records
  click($$('.head button')[1]);
  assert.equal(host(), null);
  assert.equal(window.__sunoPlaylistDl, undefined);
  assert.equal(window.fetch, originalFetch, 'the page\'s own fetch is back');
  assert.equal(document.title, 'Road Trip | Suno');
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
  assert.deepEqual(keys.sort(), [`suno-dl.done.${PL}`, 'suno-dl.pos', 'suno-dl.settings']);
  for (const k of keys) assert(!/token|Bearer|dev-1/.test(localStorage.getItem(k)), `${k} holds no sign-in`);
  assert(latestTimer() <= 60000, 'Close cleared every timer (only the blob address clean-ups, 60 s, are left)');
});

test('pasting the script again while a run waits: the old run stops, its panel, timers and title go, one panel stays', async () => {
  (0, eval)(SOURCE); // the user pastes it into the console again
  assert.equal(hosts().length, 1);
  assert(await until(() => msg() === WAITING), 'a fresh panel has no sign-in yet: the old one dropped its own');
  await pageRequest();
  assert(await until(() => /3 songs: 2 yours, 1 by others/.test(text($('.muted')))));
  // a run that waits: Suno's bucket says "too many requests, try again in 5 minutes"
  tick('Skip songs saved before', false);
  slow = (url) => Promise.resolve({ ...res(429, null, { 'retry-after': '300' }), url });
  const n = requests.length;
  click(button('Start'));
  assert(await until(() => requests.slice(n).some((r) => r.url.startsWith('https://suno-data-uploads'))));
  assert(await until(() => document.title === '0/2 Suno downloader'), document.title);
  const old = window.__sunoPlaylistDl, oldState = old.state();
  assert.equal(oldState.phase, 'running');
  assert(latestTimer() > 250000, 'the 5-minute wait is a timer');
  // paste again
  (0, eval)(SOURCE);
  assert.equal(hosts().length, 1, 'one panel');
  assert.notEqual(window.__sunoPlaylistDl, old);
  assert.equal(document.title, 'Road Trip | Suno', 'the old run\'s title is gone');
  assert(await until(() => oldState.run && oldState.run.stopped === true), 'the old run stopped');
  assert(latestTimer() <= 60000, 'the old run\'s 5-minute timer was cleared');
  const sent = requests.length;
  await sleep(10 * 60000);
  assert.equal(requests.length, sent, 'the old run sends nothing more');
  assert.equal(msg(), WAITING);
  // closing the new panel leaves the page's own fetch, exactly
  window.__sunoPlaylistDl.destroy();
  assert.equal(hosts().length, 0);
  assert.equal(window.fetch, originalFetch);
  assert.equal(document.title, 'Road Trip | Suno');
  slow = null;
});

test('Close while the folder question is open: nothing is made in the folder and nothing starts', async () => {
  (0, eval)(SOURCE);
  await pageRequest();
  assert(await until(() => /3 songs: 2 yours, 1 by others/.test(text($('.muted')))));
  const radios = $$('input').filter((b) => b.getAttribute('type') === 'radio');
  for (const r of radios) r.checked = r.parentNode.textContent.startsWith('A folder I pick');
  radios[0].dispatchEvent(new FakeEvent('change'));
  let openPicker = null;
  pickerGate = new Promise((r) => { openPicker = r; });
  click(button('Start'));
  assert.equal(pickedInClick, true);
  click($$('.head button')[1]); // x: no run yet, so it closes at once
  assert.equal(hosts().length, 0);
  const calls = dirCalls, sent = requests.length;
  openPicker(); // the user picks a folder after all
  pickerGate = null;
  await sleep(60000);
  assert.equal(dirCalls, calls, 'no playlist subfolder made in the picked folder');
  assert.equal(requests.length, sent, 'nothing sent');
  assert.equal(window.fetch, originalFetch);
});
