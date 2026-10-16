// Tests for src/sources/gdrive.js with stubbed Google globals and fetch (no network): Drive link parsing, script
// preloading (and its failure / retry), the GIS token flow (requestAccessToken called synchronously inside pick(),
// prompt 'consent' then '', popup blocked / closed, scopes not granted, expiry, sign-out), the Picker configuration
// and callback, downloads with progress (2 at a time, Content-Length or not), File objects, public link imports
// (file, folder with paging, resource keys, the 60-song limit), plain-words errors, cancel, library dedupe, and
// importLink's onInfo (what a saved link records: kind, name, songs found; only for links that lead to songs).
import {
  AUDIO_MIME_TYPES, DRIVE_SCOPE, GAPI_URL, GSI_URL, GoogleDriveSource, MSG, PICKER_CSS, PICKER_MAX_ITEMS,
  parseDriveUrl,
} from '../src/sources/gdrive.js';
import { Library, LIBRARY_CAP } from '../src/library/library.js';
import { makeAbort } from '../src/sources/net.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CFG = { google: { clientId: '123-abc.apps.googleusercontent.com', apiKey: 'AIzaTESTKEY', appId: '123456789012' } };
const ID1 = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const ID2 = '1ZyXwVuTsRqPoNmLkJiHgFeDcBa987654';
const FOLDER = '0BwwA4oUTeiV1TGRPeTVjaWRDY1E';

// ---- stubs ----------------------------------------------------------------------------------------------------------

function recorder(log, key) {
  const calls = [];
  log[key] = calls;
  return new Proxy({}, {
    get(target, name) {
      if (name === 'then') return undefined;
      return (...args) => {
        calls.push([name, ...args]);
        return target.__self;
      };
    },
  });
}

/** A fake google.picker that records the builder / view calls; log.respond(data) plays the user's answer. */
function pickerApi(log) {
  const P = {
    ViewId: { DOCS: 'all' },
    DocsViewMode: { LIST: 'list', GRID: 'grid' },
    Feature: { MULTISELECT_ENABLED: 'multiselectEnabled', SUPPORT_DRIVES: 'sdr' },
    Response: { ACTION: 'action', DOCUMENTS: 'docs' },
    Action: { PICKED: 'picked', CANCEL: 'cancel', LOADED: 'loaded', ERROR: 'error' },
    Document: { ID: 'id' },
  };
  P.DocsView = class {
    constructor(id) {
      this.calls = [['new', id]];
      log.view = this;
    }
  };
  P.PickerBuilder = class {
    constructor() {
      this.calls = [];
      log.builder = this;
    }
    build() {
      const self = this;
      const cb = (self.calls.find((c) => c[0] === 'setCallback') || [])[1];
      log.respond = (data) => cb(data);
      log.pickers = (log.pickers || 0) + 1;
      return {
        setVisible(v) {
          log.visible = v;
        },
        dispose() {
          log.disposed = (log.disposed || 0) + 1;
        },
      };
    }
  };
  const methods = {
    DocsView: ['setMimeTypes', 'setIncludeFolders', 'setSelectFolderEnabled', 'setParent', 'setMode'],
    PickerBuilder: ['addView', 'enableFeature', 'setMaxItems', 'setOAuthToken', 'setDeveloperKey', 'setAppId', 'setOrigin',
      'setTitle', 'setLocale', 'setCallback'],
  };
  for (const [cls, names] of Object.entries(methods)) {
    for (const n of names) {
      P[cls].prototype[n] = function rec(...args) {
        this.calls.push([n, ...args]);
        return this;
      };
    }
  }
  return P;
}

/** Google's globals as the two scripts would install them; loadScript records the URLs. */
function googleWorld({ failScripts = false } = {}) {
  const log = { scripts: [], requests: [], revoked: [], tokenCfg: null };
  const g = {};
  const install = (src) => {
    if (src === GAPI_URL) {
      g.gapi = {
        load(name, opts) {
          log.gapiLoad = name;
          setTimeout(() => {
            g.google = g.google || {};
            g.google.picker = pickerApi(log);
            opts.callback();
          }, 5);
        },
      };
    }
    if (src === GSI_URL) {
      g.google = g.google || {};
      g.google.accounts = {
        oauth2: {
          initTokenClient(cfg) {
            log.tokenCfg = cfg;
            return {
              requestAccessToken(opts) {
                log.requests.push(opts);
                if (log.onRequest) log.onRequest(opts);
              },
            };
          },
          hasGrantedAllScopes(resp, scope) {
            return String(resp.scope || '').split(' ').includes(scope);
          },
          revoke(token, done) {
            log.revoked.push(token);
            if (done) done();
          },
        },
      };
    }
  };
  const loadScript = (src) => {
    log.scripts.push(src);
    return sleep(3).then(() => {
      if (failScripts) {
        const err = new Error(`Could not load ${src}`);
        err.code = 'load-failed';
        throw err;
      }
      install(src);
    });
  };
  const head = [];
  const document = {
    head: { appendChild: (el) => head.push(el) },
    createElement: (tag) => ({ tagName: tag.toUpperCase() }),
    getElementById: (id) => head.find((el) => el.id === id) || null,
  };
  return { g, log, loadScript, document, head };
}

/** A media response whose body arrives in chunks (after `delay` ms each). */
function streamResponse(chunks, { status = 200, headers = {}, delay = 0 } = {}) {
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    body: {
      getReader: () => ({
        read: async () => {
          if (delay) await sleep(delay);
          return i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined };
        },
        cancel: async () => {},
      }),
    },
    json: async () => {
      throw new SyntaxError('not JSON');
    },
  };
}

const driveError = (status, reason, message = '') => Response.json({ error: { code: status, message, errors: [{ reason, message }] } }, { status });

/** fetch stub for the Drive API: media by id, metadata by id, folder pages. */
function driveApi({ media = {}, meta = {}, pages = [], fail = {} } = {}) {
  const calls = [];
  let active = 0;
  const state = { maxActive: 0 };
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (fail.network) throw new TypeError('Failed to fetch');
    const m = /\/drive\/v3\/files(?:\/([^?]+))?\?(.*)$/.exec(url);
    if (!m) return new Response('no', { status: 404 });
    const id = m[1] ? decodeURIComponent(m[1]) : null;
    const q = m[2];
    if (id && /(^|&)alt=media(&|$)/.test(q)) {
      if (fail[id]) return fail[id]();
      const bytes = media[id];
      if (!bytes) return driveError(404, 'notFound', 'File not found');
      active++;
      state.maxActive = Math.max(state.maxActive, active);
      const half = Math.floor(bytes.length / 2);
      const res = streamResponse([bytes.slice(0, half), bytes.slice(half)], {
        delay: 10, headers: bytes.hideLength ? {} : { 'content-length': String(bytes.length) },
      });
      const read = res.body.getReader;
      res.body.getReader = () => {
        const r = read();
        return {
          read: async () => {
            const x = await r.read();
            if (x.done) active--;
            return x;
          },
          cancel: r.cancel,
        };
      };
      return res;
    }
    if (id) {
      if (fail[`meta:${id}`]) return fail[`meta:${id}`]();
      return meta[id] ? Response.json(meta[id]) : driveError(404, 'notFound', 'File not found');
    }
    // files.list
    const token = /pageToken=([^&]+)/.exec(q);
    const page = token ? Number(decodeURIComponent(token[1]).replace('p', '')) : 0;
    return Response.json(pages[page] || { files: [] });
  };
  return { fetch, calls, state };
}

function bytesOf(n, seed = 1) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * seed) & 255;
  return b;
}

function memStorage() {
  return new Storage();
}

function makeDrive(world, api, extra = {}) {
  return new GoogleDriveSource({
    config: CFG,
    library: extra.library || null,
    deps: {
      global: world.g, document: world.document, fetch: api.fetch, loadScript: world.loadScript,
      location: { origin: 'https://ranama.github.io' }, storage: extra.storage || memStorage(),
      now: extra.now || (() => 1000), language: 'sv-SE',
    },
  });
}

function track(src) {
  const log = { progress: [], errors: [], states: 0 };
  src.on('progress', (p) => log.progress.push(p));
  src.on('error', (m) => log.errors.push(m));
  src.on('state', () => log.states++);
  return log;
}

const tokenResp = (extra = {}) => ({ access_token: 'ya29.token', expires_in: 3599, scope: `${DRIVE_SCOPE} openid`, token_type: 'Bearer', ...extra });

// ---- link parsing ---------------------------------------------------------------------------------------------------

test('parseDriveUrl: file and folder links in every common shape; anything else is null', () => {
  const file = (id, extra = {}) => ({ kind: 'file', id, ...extra });
  const folder = (id, extra = {}) => ({ kind: 'folder', id, ...extra });
  const cases = [
    [`https://drive.google.com/file/d/${ID1}/view?usp=sharing`, file(ID1)],
    [`https://drive.google.com/file/d/${ID1}/view?usp=drive_link&resourcekey=0-abcDEF_12`, file(ID1, { resourceKey: '0-abcDEF_12' })],
    [`https://drive.google.com/file/d/${ID1}`, file(ID1)],
    [`https://drive.google.com/file/u/1/d/${ID1}/edit`, file(ID1)],
    [`drive.google.com/file/d/${ID1}/view`, file(ID1)],
    [`  https://drive.google.com/open?id=${ID1}  `, file(ID1)],
    [`https://drive.google.com/uc?id=${ID1}&export=download`, file(ID1)],
    [`https://drive.google.com/uc?export=download&id=${ID1}`, file(ID1)],
    [`https://docs.google.com/uc?id=${ID1}`, file(ID1)],
    [`https://drive.usercontent.google.com/download?id=${ID1}&export=download`, file(ID1)],
    [`https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`, folder(FOLDER)],
    [`https://drive.google.com/drive/u/0/folders/${FOLDER}`, folder(FOLDER)],
    [`https://drive.google.com/drive/mobile/folders/${FOLDER}?resourcekey=0-XYZ`, folder(FOLDER, { resourceKey: '0-XYZ' })],
    [`https://drive.google.com/folderview?id=${FOLDER}`, folder(FOLDER)],
    [`https://drive.google.com/embeddedfolderview?id=${FOLDER}#list`, folder(FOLDER)],
    [`HTTPS://DRIVE.GOOGLE.COM/file/d/${ID1}/view`, file(ID1)],
  ];
  for (const [url, want] of cases) assert.deepEqual(parseDriveUrl(url), want, url);
  for (const bad of [
    '', null, undefined, 'hello', `https://example.com/file/d/${ID1}/view`, 'https://drive.google.com/drive/my-drive',
    `https://docs.google.com/document/d/${ID1}/edit`, 'https://drive.google.com/file/d/short/view',
    `https://evil.com/?u=https://drive.google.com/file/d/${ID1}`, `https://drive.google.com.evil.com/file/d/${ID1}`,
    `https://drive.google.com/file/d/${ID1} extra`, `https://drive.google.com/open?id=bad!id`,
  ]) {
    assert.equal(parseDriveUrl(bad), null, String(bad));
  }
});

// ---- scripts and sign-in ------------------------------------------------------------------------------------------------

test('not configured: nothing loads and pick() explains; preload() loads both scripts once and injects the phone CSS', async () => {
  const world = googleWorld();
  const api = driveApi();
  const off = new GoogleDriveSource({ config: { google: { clientId: '', apiKey: '', appId: '' } }, deps: { global: world.g, loadScript: world.loadScript, document: world.document } });
  assert.equal(off.configured, false);
  assert.equal(off.linkReady, false);
  await off.preload();
  assert.deepEqual(world.log.scripts, []);
  await assert.rejects(off.pick(), (err) => err.code === 'not-configured' && err.message === MSG.notConfigured);
  await assert.rejects(off.importLink(`https://drive.google.com/file/d/${ID1}/view`), (err) => err.code === 'not-configured');
  await assert.rejects(off.importLink('not a link'), (err) => err.code === 'bad-link' && err.message === MSG.badLink);

  const drive = makeDrive(world, api);
  const log = track(drive);
  assert.equal(drive.configured, true);
  assert.equal(drive.ready, false);
  const p1 = drive.preload();
  const p2 = drive.preload();
  assert.equal(p1, p2);
  assert.equal(drive.loading, true);
  await p1;
  assert.equal(drive.ready, true);
  assert.equal(drive.loading, false);
  assert.deepEqual(world.log.scripts.sort(), [GAPI_URL, GSI_URL].sort());
  assert.equal(world.log.gapiLoad, 'picker');
  assert.equal(world.log.tokenCfg.client_id, CFG.google.clientId);
  assert.equal(world.log.tokenCfg.scope, DRIVE_SCOPE);
  assert(log.states >= 2);
  await drive.preload();
  assert.equal(world.log.scripts.length, 2, 'loaded once');
  const style = world.head.find((el) => el.id === 'twinspin-picker-css');
  assert(style && style.tagName === 'STYLE');
  assert.equal(style.textContent, PICKER_CSS);
  assert.match(PICKER_CSS, /@media \(max-width:600px\)\{\n\.picker-dialog\{left:0!important;top:0!important;width:100vw!important/);
  assert.equal(world.head.length, 1);
});

test('scripts that fail to load: preload() rejects and keeps loadError, pick() explains, the next preload tries again', async () => {
  const world = googleWorld({ failScripts: true });
  const drive = makeDrive(world, driveApi());
  await assert.rejects(drive.preload(), (err) => err.code === 'load-failed' && err.message === MSG.loadFailed);
  assert.equal(drive.ready, false);
  assert.equal(drive.loading, false);
  assert.equal(drive.loadError, MSG.loadFailed);
  await assert.rejects(drive.pick(), (err) => err.code === 'load-failed' && err.message === MSG.loadFailed);
  await sleep(10); // the retry pick() started fails quietly (no unhandled rejection)
  assert.equal(world.log.scripts.length, 4, 'pick() tried to load the scripts again');
  const fresh = makeDrive(googleWorld(), driveApi());
  await assert.rejects(fresh.pick(), (err) => err.code === 'loading' && err.message === MSG.loading, 'not preloaded yet: tap again');
  assert.equal(fresh.loading, true, 'pick() started the preload');
  await fresh.preload();
  assert.equal(fresh.ready, true);
});

test('token flow: requestAccessToken runs synchronously inside pick(); prompt consent first, then none; expiry; sign-out', async () => {
  const world = googleWorld();
  const storage = memStorage();
  let now = 1000;
  const drive = makeDrive(world, driveApi(), { storage, now: () => now });
  await drive.preload();
  world.log.onRequest = () => setTimeout(() => world.log.tokenCfg.callback(tokenResp()), 20);
  const p = drive.pick();
  assert.equal(world.log.requests.length, 1, 'asked for the token before pick() returned (still inside the tap)');
  assert.deepEqual(world.log.requests[0], { prompt: 'consent' });
  assert.equal(drive.busy, true);
  await sleep(30);
  assert.equal(world.log.visible, true, 'the Picker opened with the token');
  assert.equal(drive.signedIn, true);
  await assert.rejects(drive.pick(), (err) => err.code === 'busy' && err.message === MSG.busy);
  world.log.respond({ action: 'cancel' });
  assert.deepEqual(await p, []);
  assert.equal(drive.busy, false);
  assert.equal(world.log.visible, false);
  // signed in: no popup at all
  const p2 = drive.pick();
  assert.equal(world.log.requests.length, 1);
  await sleep(1);
  world.log.respond({ action: 'loaded' });
  world.log.respond({ action: 'cancel' });
  assert.deepEqual(await p2, []);
  // an hour later: a new token, without the consent screen this time
  now += 3600 * 1000;
  assert.equal(drive.signedIn, false);
  world.log.onRequest = () => world.log.tokenCfg.error_callback({ type: 'popup_closed' });
  assert.deepEqual(await drive.pick(), [], 'closing Google\'s popup is a cancel');
  assert.deepEqual(world.log.requests[1], { prompt: '' });
  world.log.onRequest = () => world.log.tokenCfg.error_callback({ type: 'popup_failed_to_open' });
  await assert.rejects(drive.pick(), (err) => err.code === 'popup-blocked' && err.message === MSG.popupBlocked);
  assert.equal(MSG.popupBlocked, "Allow pop-ups for TwinSpin, or use Add music > Google Drive in your phone's file picker.");
  world.log.onRequest = () => world.log.tokenCfg.error_callback({ type: 'unknown' });
  await assert.rejects(drive.pick(), (err) => err.code === 'sign-in');
  world.log.onRequest = () => world.log.tokenCfg.callback({ error: 'access_denied' });
  assert.deepEqual(await drive.pick(), [], 'saying no on Google\'s screen is a cancel');
  world.log.onRequest = () => world.log.tokenCfg.callback(tokenResp({ scope: 'openid' }));
  await assert.rejects(drive.pick(), (err) => err.code === 'denied' && err.message === MSG.denied);
  assert.equal(drive.signedIn, false);
  // sign in, then sign out: the token is revoked and the consent screen comes back next time
  world.log.onRequest = () => world.log.tokenCfg.callback(tokenResp({ access_token: 'tok-2' }));
  const p3 = drive.pick();
  await sleep(1);
  world.log.respond({ action: 'cancel' });
  await p3;
  assert.equal(drive.signedIn, true);
  drive.signOut();
  assert.deepEqual(world.log.revoked, ['tok-2']);
  assert.equal(drive.signedIn, false);
  world.log.onRequest = () => world.log.tokenCfg.error_callback({ type: 'popup_closed' });
  await drive.pick();
  assert.deepEqual(world.log.requests[world.log.requests.length - 1], { prompt: 'consent' });
  // Google's popup never answers (iPhone home-screen apps): tapping again asks again instead of "busy"
  world.log.onRequest = null;
  const stuck = drive.pick();
  const asked = world.log.requests.length;
  world.log.onRequest = () => world.log.tokenCfg.callback(tokenResp({ access_token: 'tok-3' }));
  const retry = drive.pick();
  assert.equal(world.log.requests.length, asked + 1, 'asked Google again');
  assert.deepEqual(await stuck, [], 'the stuck pick ends quietly');
  await sleep(1);
  assert.equal(world.log.visible, true);
  world.log.respond({ action: 'cancel' });
  assert.deepEqual(await retry, []);
  assert.equal(drive.busy, false);
  drive.signOut();
  // a pick cancelled while Google's popup is open
  world.log.onRequest = null;
  const ctl = makeAbort();
  const p4 = drive.pick({ signal: ctl.signal });
  ctl.abort();
  assert.deepEqual(await p4, []);
  assert.equal(drive.busy, false);
});

test('Picker: configured per the spec; picked songs download 2 at a time with progress into File objects', async () => {
  const world = googleWorld();
  const a = bytesOf(1000, 3);
  const b = bytesOf(600, 5);
  const c = bytesOf(400, 7);
  const ID3 = '1Third_File_Id_0000000000';
  const api = driveApi({ media: { [ID1]: a, [ID2]: b, [ID3]: c } });
  const drive = makeDrive(world, api);
  const log = track(drive);
  await drive.preload();
  world.log.onRequest = () => world.log.tokenCfg.callback(tokenResp());
  const p = drive.pick();
  await sleep(1);
  const v = world.log.view.calls;
  assert.deepEqual(v[0], ['new', 'all']);
  const viewCall = (n) => v.find((x) => x[0] === n);
  const mimes = viewCall('setMimeTypes')[1].split(',');
  for (const t of ['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/ogg', 'audio/aac']) {
    assert(mimes.includes(t), t);
  }
  assert.deepEqual(mimes, [...AUDIO_MIME_TYPES]);
  assert.deepEqual(viewCall('setIncludeFolders'), ['setIncludeFolders', true]);
  assert.deepEqual(viewCall('setSelectFolderEnabled'), ['setSelectFolderEnabled', false]);
  assert.deepEqual(viewCall('setMode'), ['setMode', 'list']);
  const bc = world.log.builder.calls;
  const bcall = (n) => bc.find((x) => x[0] === n);
  assert.equal(bcall('addView')[1], world.log.view);
  assert.deepEqual(bcall('enableFeature'), ['enableFeature', 'multiselectEnabled']);
  assert.deepEqual(bcall('setMaxItems'), ['setMaxItems', PICKER_MAX_ITEMS]);
  assert.equal(PICKER_MAX_ITEMS, LIBRARY_CAP, 'never more songs per pick than the library keeps');
  assert.deepEqual(bcall('setOAuthToken'), ['setOAuthToken', 'ya29.token']);
  assert.deepEqual(bcall('setDeveloperKey'), ['setDeveloperKey', CFG.google.apiKey]);
  assert.deepEqual(bcall('setAppId'), ['setAppId', CFG.google.appId]);
  assert.deepEqual(bcall('setOrigin'), ['setOrigin', 'https://ranama.github.io']);
  assert.deepEqual(bcall('setLocale'), ['setLocale', 'sv']);
  assert.equal(world.log.visible, true);
  world.log.respond({
    action: 'picked',
    docs: [
      { id: ID1, name: 'Artist - First.mp3', mimeType: 'audio/mpeg', sizeBytes: '1000', lastEditedUtc: 1700000000000, resourceKey: '' },
      { id: 'folder-id-000000000', name: 'A folder', mimeType: 'application/vnd.google-apps.folder' },
      { id: ID2, name: 'Second.flac', mimeType: 'audio/flac', sizeBytes: 600, lastEditedUtc: 1700000001000, resourceKey: 'rk-2' },
      { id: 'doc-id-00000000000', name: 'Notes', mimeType: 'application/vnd.google-apps.document' },
      { id: ID3, name: 'Third.m4a', mimeType: 'audio/x-m4a', sizeBytes: 400, lastEditedUtc: 1700000002000 },
    ],
  });
  const files = await p;
  assert.equal(world.log.disposed, 1);
  assert.equal(files.length, 3);
  assert.deepEqual(files.map((f) => [f.name, f.type, f.size, f.lastModified]), [
    ['Artist - First.mp3', 'audio/mpeg', 1000, 1700000000000],
    ['Second.flac', 'audio/flac', 600, 1700000001000],
    ['Third.m4a', 'audio/x-m4a', 400, 1700000002000],
  ]);
  assert.deepEqual({ ...files[0].remote }, { kind: 'gdrive', fileId: ID1 });
  assert.equal(files[1].driveFileId, ID2);
  assert.deepEqual({ ...files[1].remote }, { kind: 'gdrive', fileId: ID2, resourceKey: 'rk-2' });
  const bytes = new Uint8Array(await files[0].arrayBuffer());
  assert.equal(bytes[10], a[10]);
  assert.equal(api.state.maxActive, 2, 'two downloads at a time');
  const media = api.calls.filter((x) => x.url.includes('alt=media'));
  assert.equal(media.length, 3);
  assert(media[0].url.startsWith(`https://www.googleapis.com/drive/v3/files/${ID1}?alt=media&supportsAllDrives=true`));
  assert.equal(media[0].init.headers.Authorization, 'Bearer ya29.token');
  assert.equal(media[0].url.includes('key='), false, 'signed-in downloads use the token, not the key');
  assert.equal(media[1].init.headers['X-Goog-Drive-Resource-Keys'], `${ID2}/rk-2`);
  // progress: n of m and bytes of the known total
  const first = log.progress[0];
  assert.deepEqual(first, { done: 0, total: 3, bytes: 0, totalBytes: 2000, name: 'Artist - First.mp3' });
  const last = log.progress[log.progress.length - 1];
  assert.equal(last.done, 3);
  assert.equal(last.bytes, 2000);
  assert.equal(last.totalBytes, 2000);
  assert(log.progress.some((x) => x.bytes > 0 && x.bytes < 2000 && x.done < 3), 'progress while downloading');
  assert.deepEqual(log.errors, ['One file is not a song, so it was skipped.'], 'folders cannot be picked; the document can');
  assert.equal(drive.progress, null, 'cleared when done');
});

test('download progress: an unknown size is indeterminate; a known Picker size fills in', async () => {
  const world = googleWorld();
  const hidden = bytesOf(500);
  hidden.hideLength = true;
  const api = driveApi({ media: { [ID1]: hidden, [ID2]: hidden } });
  const drive = makeDrive(world, api);
  const log = track(drive);
  await drive.preload();
  world.log.onRequest = () => world.log.tokenCfg.callback(tokenResp());
  let p = drive.pick();
  await sleep(1);
  world.log.respond({ action: 'picked', docs: [{ id: ID1, name: 'x.mp3', mimeType: 'audio/mpeg' }] });
  await p;
  assert(log.progress.slice(0, -1).every((x) => x.totalBytes === 0), 'no size anywhere: indeterminate while it downloads');
  assert.equal(log.progress[log.progress.length - 1].totalBytes, 500, 'known once it is done');
  assert.equal(log.progress[log.progress.length - 1].bytes, 500);
  log.progress.length = 0;
  p = drive.pick();
  await sleep(1);
  world.log.respond({ action: 'picked', docs: [{ id: ID2, name: 'y.mp3', mimeType: 'audio/mpeg', sizeBytes: 500 }] });
  await p;
  assert(log.progress.every((x) => x.totalBytes === 500), 'the Picker size stands in for a hidden Content-Length');
});

test('picked downloads that fail: plain words; partial success keeps the rest; 401 drops the token', async () => {
  const world = googleWorld();
  const api = driveApi({
    media: { [ID1]: bytesOf(100) },
    fail: {
      [ID2]: () => driveError(403, 'cannotDownloadFile', 'The user does not have sufficient permissions'),
    },
  });
  const drive = makeDrive(world, api);
  const log = track(drive);
  await drive.preload();
  world.log.onRequest = () => world.log.tokenCfg.callback(tokenResp());
  let p = drive.pick();
  await sleep(1);
  world.log.respond({ action: 'picked', docs: [{ id: ID1, name: 'Good.mp3', mimeType: 'audio/mpeg' }, { id: ID2, name: 'Locked.mp3', mimeType: 'audio/mpeg' }] });
  const files = await p;
  assert.deepEqual(files.map((f) => f.name), ['Good.mp3']);
  assert.deepEqual(log.errors, ["The owner of “Locked.mp3” doesn't allow downloads."]);
  // every file failed: pick() rejects with the reason
  p = drive.pick();
  await sleep(1);
  world.log.respond({ action: 'picked', docs: [{ id: 'missing-id-000000', name: 'Gone.mp3', mimeType: 'audio/mpeg' }] });
  await assert.rejects(p, (err) => err.code === 'not-found' && /couldn't find “Gone\.mp3”/.test(err.message));
  // an expired token: reconnect
  api.calls.length = 0;
  const api401 = driveApi({ fail: { [ID1]: () => driveError(401, 'authError', 'Invalid Credentials') } });
  drive._fetch = api401.fetch;
  p = drive.pick();
  await sleep(1);
  world.log.respond({ action: 'picked', docs: [{ id: ID1, name: 'a.mp3', mimeType: 'audio/mpeg' }] });
  await assert.rejects(p, (err) => err.code === 'auth' && err.message === MSG.auth);
  assert.equal(drive.signedIn, false);
  // a bad API key / referrer setup
  const apiKey = driveApi({ fail: { [ID1]: () => driveError(403, 'forbidden', 'Requests from referer <empty> are blocked.') } });
  drive._fetch = apiKey.fetch;
  world.log.onRequest = () => world.log.tokenCfg.callback(tokenResp());
  p = drive.pick();
  await sleep(1);
  world.log.respond({ action: 'picked', docs: [{ id: ID1, name: 'a.mp3', mimeType: 'audio/mpeg' }] });
  await assert.rejects(p, (err) => err.code === 'setup' && err.message === MSG.keyProblem);
  // only non-songs picked
  p = drive.pick();
  await sleep(1);
  world.log.respond({ action: 'picked', docs: [{ id: 'doc-id-00000000000', name: 'Notes.pdf', mimeType: 'application/pdf' }] });
  await assert.rejects(p, (err) => err.code === 'not-audio' && /not a song/.test(err.message));
  // offline
  drive._fetch = driveApi({ fail: { network: true } }).fetch;
  p = drive.pick();
  await sleep(1);
  world.log.respond({ action: 'picked', docs: [{ id: ID1, name: 'a.mp3', mimeType: 'audio/mpeg' }] });
  await assert.rejects(p, (err) => err.code === 'network' && err.message === MSG.network);
});

test('cancel during the downloads: the songs finished so far come back', async () => {
  const world = googleWorld();
  const ID3 = '1Third_File_Id_0000000000';
  const api = driveApi({ media: { [ID1]: bytesOf(100), [ID2]: bytesOf(100), [ID3]: bytesOf(100) } });
  const drive = makeDrive(world, api);
  await drive.preload();
  world.log.onRequest = () => world.log.tokenCfg.callback(tokenResp());
  const p = drive.pick();
  await sleep(1);
  world.log.respond({ action: 'picked', docs: [ID1, ID2, ID3].map((id, i) => ({ id, name: `${i}.mp3`, mimeType: 'audio/mpeg' })) });
  await sleep(35); // the first two finish (3 reads x 10 ms), the third has started
  drive.cancel();
  const files = await p;
  assert.deepEqual(files.map((f) => f.name), ['0.mp3', '1.mp3']);
  assert.equal(drive.busy, false);
});

test('a Drive song already in the library is not downloaded again', async () => {
  const world = googleWorld();
  const api = driveApi({ media: { [ID1]: bytesOf(300) } });
  const library = new Library({ indexedDB: null, storage: null });
  const drive = makeDrive(world, api, { library });
  await drive.preload();
  world.log.onRequest = () => world.log.tokenCfg.callback(tokenResp());
  let p = drive.pick();
  await sleep(1);
  const doc = { id: ID1, name: 'DJ - Track.mp3', mimeType: 'audio/mpeg', sizeBytes: 300, lastEditedUtc: 1700000000000 };
  world.log.respond({ action: 'picked', docs: [doc] });
  const first = await p;
  const [entry] = await library.add(first, { source: 'gdrive' });
  assert.equal(entry.driveFileId, ID1);
  assert.equal(entry.source, 'gdrive');
  const before = api.calls.length;
  p = drive.pick();
  await sleep(1);
  world.log.respond({ action: 'picked', docs: [doc] });
  const again = await p;
  assert.equal(api.calls.length, before, 'no download');
  assert.equal(again[0].size, 300);
  const [same] = await library.add(again);
  assert.equal(same.id, entry.id);
  assert.equal(library.list().filter((e) => !e.demo).length, 1);
});

// ---- public links ---------------------------------------------------------------------------------------------------

test('importLink: a public file with the API key only (no sign-in), with its resource key', async () => {
  const world = googleWorld();
  const api = driveApi({
    media: { [ID1]: bytesOf(256) },
    meta: { [ID1]: { id: ID1, name: 'Shared Song.mp3', mimeType: 'audio/mpeg', size: '256', modifiedTime: '2024-05-01T10:00:00.000Z' } },
  });
  const drive = makeDrive(world, api);
  const log = track(drive);
  assert.equal(drive.linkReady, true);
  const files = await drive.importLink(`https://drive.google.com/file/d/${ID1}/view?usp=sharing&resourcekey=0-RK`);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'Shared Song.mp3');
  assert.equal(files[0].size, 256);
  assert.equal(files[0].lastModified, Date.parse('2024-05-01T10:00:00.000Z'));
  assert.equal(files[0].driveFileId, ID1);
  assert.deepEqual(world.log.scripts, [], 'no Google scripts, no popup');
  const [metaCall, mediaCall] = api.calls;
  assert(metaCall.url.startsWith(`https://www.googleapis.com/drive/v3/files/${ID1}?fields=`));
  assert(metaCall.url.includes('&supportsAllDrives=true&key=AIzaTESTKEY'));
  assert.equal(metaCall.init.headers['X-Goog-Drive-Resource-Keys'], `${ID1}/0-RK`);
  assert.equal(metaCall.init.referrerPolicy, 'strict-origin');
  assert(mediaCall.url.includes('alt=media') && mediaCall.url.includes('key=AIzaTESTKEY'));
  assert.equal(mediaCall.init.headers.Authorization, undefined);
  assert.equal(mediaCall.init.headers['X-Goog-Drive-Resource-Keys'], `${ID1}/0-RK`);
  assert.equal(mediaCall.init.referrerPolicy, 'strict-origin');
  assert.equal(log.progress[log.progress.length - 1].done, 1);
  assert.deepEqual(log.errors, []);
});

test('importLink: a public folder, listed page by page; only songs; the 60-song limit', async () => {
  const world = googleWorld();
  const media = {};
  const list = [];
  for (let i = 0; i < LIBRARY_CAP + 4; i++) {
    const id = `1song_${String(i).padStart(4, '0')}_xxxxxxxxxx`;
    media[id] = bytesOf(20 + i);
    list.push({ id, name: `${String(i).padStart(2, '0')} Song.mp3`, mimeType: 'audio/mpeg', size: String(20 + i) });
  }
  list.splice(3, 0, { id: '1notsong_0000_xxxxxxxx', name: 'notes.txt', mimeType: 'text/plain' });
  const api = driveApi({
    media,
    meta: { [FOLDER]: { id: FOLDER, name: 'Party', mimeType: 'application/vnd.google-apps.folder' } },
    pages: [{ files: list.slice(0, 30), nextPageToken: 'p1' }, { files: list.slice(30, 50), nextPageToken: 'p2' }, { files: list.slice(50) }],
  });
  const drive = makeDrive(world, api);
  const log = track(drive);
  const files = await drive.importLink(`https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`);
  assert.equal(files.length, LIBRARY_CAP);
  assert.equal(files[0].name, '00 Song.mp3');
  const lists = api.calls.filter((x) => /\/files\?q=/.test(x.url));
  assert.equal(lists.length, 3, 'three pages');
  const q = decodeURIComponent(/q=([^&]+)/.exec(lists[0].url)[1]);
  assert.equal(q, `'${FOLDER}' in parents and mimeType contains 'audio/' and trashed = false`);
  assert(lists[0].url.includes('pageSize=1000'));
  assert(lists[0].url.includes('key=AIzaTESTKEY'));
  assert(!lists[0].url.includes('pageToken'));
  assert(lists[1].url.includes('pageToken=p1') && lists[2].url.includes('pageToken=p2'));
  assert.equal(log.errors.length, 1);
  assert.match(log.errors[0], new RegExp(`That folder has ${LIBRARY_CAP + 4} songs\\. TwinSpin imported the first ${LIBRARY_CAP}`));
  assert(log.progress.every((x) => x.total === LIBRARY_CAP));
});

test('importLink errors in plain words: not shared, not found, API key, quota, empty folder, not a song, offline', async () => {
  const world = googleWorld();
  const link = `https://drive.google.com/file/d/${ID1}/view`;
  const folderLink = `https://drive.google.com/drive/folders/${FOLDER}`;
  const run = (opts) => makeDrive(world, driveApi(opts));
  await assert.rejects(run({}).importLink(link), (err) => err.code === 'not-found' && err.message === MSG.notFoundLink);
  await assert.rejects(run({ fail: { [`meta:${ID1}`]: () => driveError(403, 'forbidden', 'The caller does not have permission') } }).importLink(link),
    (err) => err.code === 'forbidden' && err.message === MSG.notShared);
  await assert.rejects(run({ fail: { [`meta:${ID1}`]: () => Response.json({ error: { code: 403, message: 'Requests from referer https://x are blocked.', status: 'PERMISSION_DENIED', details: [{ reason: 'API_KEY_HTTP_REFERRER_BLOCKED' }] } }, { status: 403 }) } }).importLink(link),
    (err) => err.code === 'setup' && err.message === MSG.keyProblem);
  await assert.rejects(run({ fail: { [`meta:${ID1}`]: () => driveError(400, 'keyInvalid', 'API key not valid. Please pass a valid API key.') } }).importLink(link),
    (err) => err.code === 'setup');
  const meta = { [ID1]: { id: ID1, name: 'Song.mp3', mimeType: 'audio/mpeg' } };
  await assert.rejects(run({ meta, fail: { [ID1]: () => driveError(403, 'downloadQuotaExceeded', 'The download quota for this file has been exceeded.') } }).importLink(link),
    (err) => err.code === 'quota' && err.message === MSG.quota);
  await assert.rejects(run({ meta, fail: { [ID1]: () => new Response('slow down', { status: 429 }) } }).importLink(link), (err) => err.code === 'quota');
  await assert.rejects(run({ meta, fail: { [ID1]: () => new Response('oops', { status: 503 }) } }).importLink(link), (err) => err.code === 'server' && err.message === MSG.server);
  await assert.rejects(run({ meta: { [FOLDER]: { id: FOLDER, mimeType: 'application/vnd.google-apps.folder' } }, pages: [{ files: [] }] }).importLink(folderLink),
    (err) => err.code === 'empty-folder' && err.message === MSG.emptyFolder);
  await assert.rejects(run({ meta: { [ID1]: { id: ID1, name: 'Doc', mimeType: 'application/vnd.google-apps.document' } } }).importLink(link),
    (err) => err.code === 'not-audio' && err.message === MSG.notAudio);
  await assert.rejects(run({ fail: { network: true } }).importLink(link), (err) => err.code === 'network' && err.message === MSG.network);
  // a file link that is really a folder, and a shortcut to a song
  const shortcutApi = driveApi({
    media: { [ID2]: bytesOf(50) },
    meta: {
      [ID1]: { id: ID1, name: 'Shortcut', mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: ID2, targetMimeType: 'audio/mpeg' } },
      [ID2]: { id: ID2, name: 'Target.mp3', mimeType: 'audio/mpeg', size: '50' },
    },
  });
  const viaShortcut = await makeDrive(world, shortcutApi).importLink(`https://drive.google.com/open?id=${ID1}`);
  assert.deepEqual(viaShortcut.map((f) => f.name), ['Target.mp3']);
  // cancelled through the signal while listing
  const slow = driveApi({ meta: { [FOLDER]: { id: FOLDER, mimeType: 'application/vnd.google-apps.folder' } } });
  const slowFetch = slow.fetch;
  const d = makeDrive(world, { fetch: async (...args) => {
    await sleep(50);
    return slowFetch(...args);
  } });
  const ctl = makeAbort();
  const p = d.importLink(folderLink, { signal: ctl.signal });
  await sleep(10);
  ctl.abort();
  assert.deepEqual(await p, []);
  assert.equal(d.busy, false);
});

test('importLink onInfo: what the link is (folder or song, name, songs found before the limit), before any download', async () => {
  const world = googleWorld();
  const infos = [];
  const media = {};
  const list = [];
  for (let i = 0; i < LIBRARY_CAP + 4; i++) {
    const id = `1song_${String(i).padStart(4, '0')}_xxxxxxxxxx`;
    media[id] = bytesOf(20);
    list.push({ id, name: `${String(i).padStart(2, '0')} Song.mp3`, mimeType: 'audio/mpeg', size: '20' });
  }
  list.push({ id: '1notsong_0000_xxxxxxxx', name: 'notes.txt', mimeType: 'text/plain' });
  const api = driveApi({
    media: { ...media, [ID1]: bytesOf(64), [ID2]: bytesOf(32) },
    meta: {
      [FOLDER]: { id: FOLDER, name: '  Party  ', mimeType: 'application/vnd.google-apps.folder', resourceKey: '0-FK' },
      [ID1]: { id: ID1, name: 'Artist - Shared Song.flac', mimeType: 'audio/flac', size: '64' },
    },
    pages: [{ files: list }],
  });
  const onInfo = (info) => infos.push({ info, downloads: api.calls.filter((x) => x.url.includes('alt=media')).length });
  // a folder: the songs found before the 60-song limit, the folder's name, its resource key
  const files = await makeDrive(world, api).importLink(`https://drive.google.com/drive/folders/${FOLDER}?resourcekey=0-FK`, { onInfo });
  assert.equal(files.length, LIBRARY_CAP);
  assert.equal(infos.length, 1, 'once');
  assert.deepEqual(infos[0].info, { id: FOLDER, kind: 'folder', name: 'Party', songCount: LIBRARY_CAP + 4, resourceKey: '0-FK' });
  assert.equal(infos[0].downloads, 0, 'before the downloads');
  // a song: its file name without the extension, one song, the link's resource key
  infos.length = 0;
  const one = await makeDrive(world, api).importLink(`https://drive.google.com/file/d/${ID1}/view?resourcekey=0-RK`, { onInfo });
  assert.equal(one.length, 1);
  assert.deepEqual(infos.map((x) => x.info), [{ id: ID1, kind: 'file', name: 'Artist - Shared Song', songCount: 1, resourceKey: '0-RK' }]);
  assert.equal(infos[0].downloads, LIBRARY_CAP, 'the song itself was not downloaded yet');
  // a shortcut: the target; a file link that is really a folder: kind folder; a name without an extension stays
  const sc = driveApi({
    media: { [ID2]: bytesOf(50) },
    meta: {
      [ID1]: { id: ID1, name: 'Shortcut', mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: ID2 } },
      [ID2]: { id: ID2, name: 'Target', mimeType: 'audio/mpeg', size: '50' },
      [FOLDER]: { id: FOLDER, name: 'Mixes', mimeType: 'application/vnd.google-apps.folder' },
    },
    pages: [{ files: [{ id: ID2, name: 'Target', mimeType: 'audio/mpeg', size: '50' }] }],
  });
  infos.length = 0;
  await makeDrive(world, sc).importLink(`https://drive.google.com/open?id=${ID1}`, { onInfo });
  await makeDrive(world, sc).importLink(`https://drive.google.com/file/d/${FOLDER}/view`, { onInfo });
  assert.deepEqual(infos.map((x) => x.info), [
    { id: ID2, kind: 'file', name: 'Target', songCount: 1, resourceKey: '' },
    { id: FOLDER, kind: 'folder', name: 'Mixes', songCount: 1, resourceKey: '' },
  ]);
  // a link that does not lead to songs is never reported (so it is never saved)
  infos.length = 0;
  const link = `https://drive.google.com/file/d/${ID1}/view`;
  const folderLink = `https://drive.google.com/drive/folders/${FOLDER}`;
  const run = (opts) => makeDrive(world, driveApi(opts));
  await assert.rejects(run({}).importLink(link, { onInfo }), (err) => err.code === 'not-found');
  await assert.rejects(run({ fail: { [`meta:${ID1}`]: () => driveError(403, 'forbidden', 'no') } }).importLink(link, { onInfo }),
    (err) => err.code === 'forbidden');
  await assert.rejects(run({ meta: { [FOLDER]: { id: FOLDER, mimeType: 'application/vnd.google-apps.folder' } }, pages: [{ files: [] }] })
    .importLink(folderLink, { onInfo }), (err) => err.code === 'empty-folder');
  await assert.rejects(run({ meta: { [ID1]: { id: ID1, name: 'Doc', mimeType: 'application/vnd.google-apps.document' } } })
    .importLink(link, { onInfo }), (err) => err.code === 'not-audio');
  await assert.rejects(run({ fail: { network: true } }).importLink(link, { onInfo }), (err) => err.code === 'network');
  await assert.rejects(run({}).importLink('https://example.com/x', { onInfo }), (err) => err.code === 'bad-link');
  const ctl = makeAbort();
  const slowApi = driveApi({ meta: { [FOLDER]: { id: FOLDER, mimeType: 'application/vnd.google-apps.folder' } },
    pages: [{ files: [{ id: ID2, name: 'x.mp3', mimeType: 'audio/mpeg' }] }] });
  const slow = makeDrive(world, { fetch: async (...args) => {
    await sleep(50);
    return slowApi.fetch(...args);
  } });
  const p = slow.importLink(folderLink, { signal: ctl.signal, onInfo });
  await sleep(70);
  ctl.abort();
  assert.deepEqual(await p, []);
  assert.deepEqual(infos, [], 'not reported for a failed or cancelled link');
  // a song link whose download fails later is a working link: reported, then the import says why
  const meta = { [ID1]: { id: ID1, name: 'Song.mp3', mimeType: 'audio/mpeg' } };
  await assert.rejects(run({ meta, fail: { [ID1]: () => new Response('slow down', { status: 429 }) } }).importLink(link, { onInfo }),
    (err) => err.code === 'quota');
  assert.deepEqual(infos.map((x) => x.info.name), ['Song']);
  // a failing onInfo does not stop the import
  const songs = await makeDrive(world, api).importLink(`https://drive.google.com/file/d/${ID1}/view`, { onInfo: () => {
    throw new Error('listener broke');
  } });
  assert.equal(songs.length, 1);
});
