// Tests for src/sources/subsonic.js with a stubbed fetch (no network): auth parameters (token + salt, never the
// password; OpenSubsonic apiKey alone), the REST calls and their parameters, paging, the error envelope and its
// plain-words messages, downloads with progress and the stream.view fallback, address rules (https, home
// network addresses, mixed content), and MusicServerSource: connect / remember / restore / disconnect, the
// failure diagnosis, the library resolver and toEntries.
import { md5 } from '../src/sources/md5.js';
import {
  API_VERSION, MSG, MusicServerSource, SERVER_STORE_KEY, SubsonicClient, authParams, isLocalHost, normalizeServerUrl,
  randomSalt, serverIdFor, subsonicError,
} from '../src/sources/subsonic.js';
import { Library } from '../src/library/library.js';
import { makeAbort } from '../src/sources/net.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = 'https://music.example.synology.me';

function parseQ(url) {
  const out = {};
  const q = String(url).split('?')[1] || '';
  for (const part of q.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

const ok = (body = {}) => Response.json({ 'subsonic-response': { status: 'ok', version: API_VERSION, ...body } });
const failed = (code, message = '') => Response.json({ 'subsonic-response': { status: 'failed', version: API_VERSION, error: { code, message } } });

/** A fake server: routes by REST method name; records every call. */
function fakeServer(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init, q: parseQ(url) });
    const m = /\/rest\/(\w+)\.view\?/.exec(url);
    const h = m && routes[m[1]];
    if (!h) return new Response('<html>Not found</html>', { status: 404, headers: { 'content-type': 'text/html' } });
    return h(parseQ(url), init, url);
  };
  return { fetch, calls };
}

/** A response with a ReadableStream-like body. */
function streamResponse(chunks, { status = 200, headers = {} } = {}) {
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
        cancel: async () => {},
      }),
    },
    json: async () => {
      throw new SyntaxError('Unexpected token');
    },
  };
}

function fakeLibrary() {
  const resolvers = new Map();
  return {
    resolvers,
    setResolver(kind, fn) {
      if (fn) resolvers.set(kind, fn);
      else resolvers.delete(kind);
    },
  };
}

// ---- auth -------------------------------------------------------------------------------------------------------

test('authParams: token + salt from the password (never p=), apiKey alone, v / c / f', () => {
  const a = authParams({ username: 'dj', password: 'sesame', salt: 'c19b2d' });
  assert.deepEqual(a, { u: 'dj', t: '26719a1196d2a940705a59634eb18eab', s: 'c19b2d', v: '1.16.1', c: 'TwinSpin', f: 'json' });
  assert.equal('p' in a, false);
  const b = authParams({ username: 'dj', password: 'sesame' });
  assert.match(b.s, /^[0-9a-f]{12}$/);
  assert.equal(b.t, md5(`sesame${b.s}`));
  assert.notEqual(authParams({ username: 'dj', password: 'x' }).s, authParams({ username: 'dj', password: 'x' }).s);
  assert.deepEqual(authParams({ username: 'dj', token: 'tok', salt: 'salt' }), { u: 'dj', t: 'tok', s: 'salt', v: '1.16.1', c: 'TwinSpin', f: 'json' });
  const k = authParams({ username: 'dj', password: 'pw', apiKey: 'nds_key' });
  assert.deepEqual(k, { apiKey: 'nds_key', v: '1.16.1', c: 'TwinSpin', f: 'json' }, 'apiKey is never mixed with u/t/s');
  assert.equal(authParams({ username: 'a', token: 't', salt: 's', clientName: 'X' }).c, 'X');
  assert.match(randomSalt(), /^[0-9a-f]{12}$/);
  assert.equal(randomSalt(6).length, 6);
});

test('client: every method calls /rest/<method>.view with auth and its parameters; lone objects become arrays', async () => {
  const srv = fakeServer({
    ping: () => ok({ type: 'navidrome', serverVersion: '0.64.2', openSubsonic: true }),
    getArtists: () => ok({ artists: { index: { name: 'A', artist: { id: 'ar1', name: 'Abba' } } } }),
    getArtist: (q) => ok({ artist: { id: q.id, name: 'Abba', album: { id: 'al1', name: 'Gold' } } }),
    getAlbumList2: () => ok({ albumList2: { album: [{ id: 'al1' }, { id: 'al2' }] } }),
    getAlbum: (q) => ok({ album: { id: q.id, name: 'Gold', song: { id: 'so1', title: 'SOS' } } }),
    search3: () => ok({ searchResult3: { artist: { id: 'ar1' }, song: [{ id: 'so1' }] } }),
    getPlaylists: () => ok({ playlists: { playlist: { id: 'pl1', name: 'Party' } } }),
    getPlaylist: (q) => ok({ playlist: { id: q.id, entry: { id: 'so1' } } }),
    getRandomSongs: () => ok({ randomSongs: { song: { id: 'so9' } } }),
  });
  const c = new SubsonicClient({ url: `${BASE}/`, username: 'dj', password: 'pw', fetch: srv.fetch });
  assert.equal(c.url, BASE);
  const ping = await c.ping();
  assert.equal(ping.status, 'ok');
  assert.equal(ping.type, 'navidrome');
  const call0 = srv.calls[0];
  assert(call0.url.startsWith(`${BASE}/rest/ping.view?`));
  assert.equal(call0.q.u, 'dj');
  assert.equal(call0.q.t, md5(`pw${call0.q.s}`));
  assert.equal(call0.q.v, '1.16.1');
  assert.equal(call0.q.c, 'TwinSpin');
  assert.equal(call0.q.f, 'json');
  assert.equal('p' in call0.q, false);
  assert.equal(call0.init.method, 'GET');
  assert.equal(call0.init.credentials, 'omit');
  assert.equal(call0.init.headers, undefined, 'no custom headers: no CORS preflight');

  const artists = await c.getArtists();
  assert(Array.isArray(artists.artists.index) && Array.isArray(artists.artists.index[0].artist));
  const artist = await c.getArtist('ar1');
  assert.equal(srv.calls[2].q.id, 'ar1');
  assert(Array.isArray(artist.artist.album));
  await c.getAlbumList2('newest', 2000, 40);
  assert.deepEqual([srv.calls[3].q.type, srv.calls[3].q.size, srv.calls[3].q.offset], ['newest', '500', '40']);
  await c.getAlbumList2();
  assert.deepEqual([srv.calls[4].q.type, srv.calls[4].q.size, srv.calls[4].q.offset], ['alphabeticalByName', '50', '0']);
  const album = await c.getAlbum('al1');
  assert(Array.isArray(album.album.song) && album.album.song[0].title === 'SOS');
  const found = await c.search3('abba', { songCount: 20, songOffset: 40, albumOffset: 5 });
  const sq = srv.calls[6].q;
  assert.deepEqual([sq.query, sq.songCount, sq.songOffset, sq.albumOffset, sq.artistCount], ['abba', '20', '40', '5', '20']);
  assert(Array.isArray(found.searchResult3.artist) && Array.isArray(found.searchResult3.album) === false);
  const pls = await c.getPlaylists();
  assert(Array.isArray(pls.playlists.playlist));
  const pl = await c.getPlaylist('pl1');
  assert(Array.isArray(pl.playlist.entry));
  const rnd = await c.getRandomSongs(25);
  assert.equal(srv.calls[9].q.size, '25');
  assert(Array.isArray(rnd.randomSongs.song));

  const cover = parseQ(c.coverArtUrl('al1', 300));
  assert.deepEqual([cover.id, cover.size], ['al1', '300']);
  assert(c.coverArtUrl('al1').includes('/rest/getCoverArt.view?'));
  assert.equal(c.coverArtUrl(''), '');
  assert(c.downloadUrl('so1').startsWith(`${BASE}/rest/download.view?`));
  assert.equal(parseQ(c.downloadUrl('so1')).id, 'so1');
  assert.equal(parseQ(c.streamUrl('so1', { format: 'raw' })).format, 'raw');
  // apiKey clients send only the key
  const k = new SubsonicClient({ url: BASE, apiKey: 'nds_abc', fetch: srv.fetch });
  await k.ping();
  const kq = srv.calls[srv.calls.length - 1].q;
  assert.equal(kq.apiKey, 'nds_abc');
  assert.equal('u' in kq || 't' in kq || 's' in kq, false);
});

test('paging through albums: size / offset until a short page', async () => {
  const all = Array.from({ length: 120 }, (_, i) => ({ id: `al${i}`, name: `Album ${i}` }));
  const srv = fakeServer({
    getAlbumList2: (q) => ok({ albumList2: { album: all.slice(Number(q.offset), Number(q.offset) + Number(q.size)) } }),
  });
  const c = new SubsonicClient({ url: BASE, username: 'u', token: 't', salt: 's', fetch: srv.fetch });
  const got = [];
  for (let page = 0; page < 10; page++) {
    const body = await c.getAlbumList2('alphabeticalByName', 50, got.length);
    got.push(...body.albumList2.album);
    if (body.albumList2.album.length < 50) break;
  }
  assert.equal(got.length, 120);
  assert.deepEqual(srv.calls.map((x) => x.q.offset), ['0', '50', '100']);
  assert.equal(got[119].id, 'al119');
});

test('errors in plain words: the Subsonic codes, HTTP failures, not a music server, offline, a timeout', async () => {
  const cases = [
    [10, 'bad-request', /missing a detail/],
    [20, 'version', /newer Subsonic version/],
    [30, 'version', /too old/],
    [40, 'auth', /^Wrong user name or password\.$/],
    [41, 'auth', /LDAP/],
    [50, 'forbidden', /isn't allowed/],
    [70, 'not-found', /isn't on your music server/],
  ];
  for (const [n, code, re] of cases) {
    const srv = fakeServer({ ping: () => failed(n, 'raw server text') });
    const c = new SubsonicClient({ url: BASE, username: 'u', password: 'p', fetch: srv.fetch });
    await assert.rejects(c.ping(), (err) => err.code === code && re.test(err.message) && err.subsonicCode === n);
  }
  const e0 = subsonicError({ code: 0, message: 'Database locked' });
  assert.equal(e0.code, 'server');
  assert.match(e0.message, /Database locked/);
  assert.match(subsonicError({ code: 99 }).message, /reported a problem/);
  // the failed envelope also counts on a 4xx/5xx answer
  const s401 = fakeServer({ ping: () => Response.json({ 'subsonic-response': { status: 'failed', error: { code: 40 } } }, { status: 401 }) });
  await assert.rejects(new SubsonicClient({ url: BASE, username: 'u', password: 'p', fetch: s401.fetch }).ping(), (err) => err.code === 'auth');
  const html = fakeServer({ ping: () => new Response('<html>DSM login</html>', { headers: { 'content-type': 'text/html' } }) });
  await assert.rejects(new SubsonicClient({ url: BASE, fetch: html.fetch }).ping(), (err) => err.code === 'not-subsonic' && err.message === MSG.notSubsonic);
  const none = fakeServer({});
  await assert.rejects(new SubsonicClient({ url: BASE, fetch: none.fetch }).ping(), (err) => err.code === 'not-subsonic');
  const bad = fakeServer({ ping: () => new Response('Bad gateway', { status: 502 }) });
  await assert.rejects(new SubsonicClient({ url: BASE, fetch: bad.fetch }).ping(), (err) => err.code === 'server-down' && /isn't running/.test(err.message));
  const s500 = fakeServer({ ping: () => new Response('oops', { status: 500 }) });
  await assert.rejects(new SubsonicClient({ url: BASE, fetch: s500.fetch }).ping(), (err) => err.code === 'server' && /error 500/.test(err.message));
  const offline = async () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(new SubsonicClient({ url: BASE, fetch: offline }).ping(), (err) => err.code === 'network' && /Can't reach your music server/.test(err.message));
  const hang = () => new Promise(() => {});
  await assert.rejects(new SubsonicClient({ url: BASE, fetch: hang, timeoutMs: 5000 }).ping(), (err) => err.code === 'timeout');
  const ctl = makeAbort();
  const p = new SubsonicClient({ url: BASE, fetch: hang }).getArtists({ signal: ctl.signal });
  ctl.abort();
  await assert.rejects(p, (err) => err.name === 'AbortError');
});

test('download: progress from the stream, unknown size, stream.view?format=raw when downloads are not allowed', async () => {
  const chunks = [new Uint8Array(4000), new Uint8Array(4000), new Uint8Array(2000)];
  let srv = fakeServer({
    download: () => streamResponse(chunks, { headers: { 'content-type': 'audio/flac', 'content-length': '10000' } }),
  });
  let c = new SubsonicClient({ url: BASE, username: 'u', password: 'p', fetch: srv.fetch });
  const seen = [];
  const blob = await c.download('so1', { onProgress: (b, t) => seen.push([b, t]) });
  assert.equal(blob.size, 10000);
  assert.equal(blob.type, 'audio/flac');
  assert.deepEqual(seen, [[0, 10000], [4000, 10000], [8000, 10000], [10000, 10000]]);
  assert.equal(srv.calls[0].q.id, 'so1');

  // no Content-Length (hidden by CORS): indeterminate unless the caller knows the size
  srv = fakeServer({ download: () => streamResponse(chunks, { headers: { 'content-type': 'audio/mpeg' } }) });
  c = new SubsonicClient({ url: BASE, username: 'u', password: 'p', fetch: srv.fetch });
  const seen2 = [];
  await c.download('so1', { onProgress: (b, t) => seen2.push(t) });
  assert.deepEqual(seen2, [0, 0, 0, 0]);
  const seen3 = [];
  await c.download('so1', { totalHint: 10000, onProgress: (b, t) => seen3.push(t) });
  assert.deepEqual(seen3, [10000, 10000, 10000, 10000]);

  // downloads not allowed for this user (code 50): stream.view?format=raw
  srv = fakeServer({
    download: () => failed(50, 'not authorized'),
    stream: (q) => (q.format === 'raw' ? streamResponse([new Uint8Array(7)], { headers: { 'content-type': 'audio/mpeg' } }) : failed(10)),
  });
  c = new SubsonicClient({ url: BASE, username: 'u', password: 'p', fetch: srv.fetch });
  const b2 = await c.download('so2');
  assert.equal(b2.size, 7);
  assert.deepEqual(srv.calls.map((x) => x.url.split('?')[0].split('/').pop()), ['download.view', 'stream.view']);
  // an HTTP 404 on download.view falls back too
  srv = fakeServer({ stream: () => streamResponse([new Uint8Array(3)], { headers: { 'content-type': 'audio/mpeg' } }) });
  c = new SubsonicClient({ url: BASE, username: 'u', password: 'p', fetch: srv.fetch });
  assert.equal((await c.download('so3')).size, 3);
  // wrong password: no fallback, the readable error comes back
  srv = fakeServer({ download: () => failed(40), stream: () => streamResponse([new Uint8Array(3)]) });
  c = new SubsonicClient({ url: BASE, username: 'u', password: 'p', fetch: srv.fetch });
  await assert.rejects(c.download('so4'), (err) => err.code === 'auth');
  assert.equal(srv.calls.length, 1);
  // transcoding on request
  srv = fakeServer({ stream: (q) => streamResponse([new Uint8Array(q.format === 'mp3' && q.maxBitRate === '320' ? 5 : 1)], { headers: { 'content-type': 'audio/mpeg' } }) });
  c = new SubsonicClient({ url: BASE, username: 'u', password: 'p', fetch: srv.fetch });
  assert.equal((await c.download('so5', { format: 'mp3', maxBitRate: 320 })).size, 5);
  // a text answer is not a song
  srv = fakeServer({
    download: () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
    stream: () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
  });
  c = new SubsonicClient({ url: BASE, username: 'u', password: 'p', fetch: srv.fetch });
  await assert.rejects(c.download('so6'), (err) => err.code === 'not-audio');
  // a stalled download gives up
  srv = fakeServer({
    download: () => ({
      ok: true, status: 200, headers: new Headers({ 'content-type': 'audio/mpeg' }),
      body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) },
    }),
  });
  c = new SubsonicClient({ url: BASE, username: 'u', password: 'p', fetch: srv.fetch });
  await assert.rejects(c.download('so7'), (err) => err.code === 'stalled');
});

test('addresses: https added, paths cleaned, home-network http allowed with a warning, mixed content refused', () => {
  const n = (s, o) => normalizeServerUrl(s, o);
  assert.equal(n('music.name.synology.me').url, 'https://music.name.synology.me');
  assert.equal(n(' https://music.name.synology.me/ ').url, 'https://music.name.synology.me');
  assert.equal(n('HTTPS://Music.Name.Synology.ME:443/').url, 'https://music.name.synology.me');
  assert.equal(n('https://music.name.synology.me/rest/ping.view?u=x&p=y').url, 'https://music.name.synology.me');
  assert.equal(n('https://music.name.synology.me/app/#/album/123').url, 'https://music.name.synology.me');
  assert.equal(n('https://nas.example.com:8443/navidrome/').url, 'https://nas.example.com:8443/navidrome');
  assert.equal(n('https://nas.example.com/navidrome/app/').url, 'https://nas.example.com/navidrome');
  assert.equal(n('https://nas.example.com/index.html').url, 'https://nas.example.com');
  const lan = n('192.168.1.20:4533');
  assert.equal(lan.url, 'http://192.168.1.20:4533');
  assert.equal(lan.local, true);
  assert.equal(lan.secure, false);
  assert.equal(lan.warning, MSG.localWarning);
  assert.equal(n('http://localhost:4533', { pageProtocol: 'http:' }).warning, '', 'the dev server on http: no warning');
  assert.equal(n('http://music.example.com', { pageProtocol: 'http:' }).url, 'http://music.example.com');
  assert.throws(() => n('http://music.example.com'), (err) => err.code === 'mixed-content' && err.message === MSG.mixedContent);
  assert.equal(n('http://nas.local:4533').local, true);
  assert.equal(n('http://[::1]:4533').url, 'http://[::1]:4533');
  for (const bad of ['', '   ', 'ftp://nas', 'https://user:pw@nas.example.com', 'https://', 'https://exa mple.com',
    'https://bad_host!', 'https://nas.example.com:99999']) {
    assert.throws(() => n(bad), (err) => err.code === 'bad-url' && typeof err.message === 'string', bad);
  }
  for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.1.1',
    '100.64.0.1', 'nas.local', '::1', '[fd12::1]', 'fe80::1']) {
    assert.equal(isLocalHost(h), true, h);
  }
  for (const h of ['8.8.8.8', '172.32.0.1', '100.128.0.1', 'music.name.synology.me', 'example.com', '']) {
    assert.equal(isLocalHost(h), false, h);
  }
  assert.match(serverIdFor('https://a.example'), /^srv-[0-9a-f]{12}$/);
  assert.equal(serverIdFor('https://A.example'), serverIdFor('https://a.example'));
});

// ---- MusicServerSource ----------------------------------------------------------------------------------------------

const PING = () => ok({ type: 'navidrome', serverVersion: '0.64.2', openSubsonic: true });

test('connect: pings, keeps { url, username, token, salt } (never the password), registers the resolver', async () => {
  const srv = fakeServer({ ping: PING });
  const local = new Storage();
  const session = new Storage();
  const library = fakeLibrary();
  const ms = new MusicServerSource({ library, fetch: srv.fetch, local, session, location: { protocol: 'https:' } });
  const states = [];
  ms.on('state', () => states.push(ms.status));
  assert.equal(ms.connected, false);
  assert.equal(ms.status, 'disconnected');
  await ms.connect({ url: 'music.example.synology.me/', username: ' dj ', password: 'Secret-Pass-1', remember: false });
  assert.equal(ms.connected, true);
  assert.equal(ms.status, 'connected');
  assert.deepEqual(states, ['connecting', 'connected']);
  assert.equal(ms.server.url, BASE);
  assert.equal(ms.server.name, 'music.example.synology.me');
  assert.equal(ms.server.type, 'navidrome');
  assert.equal(ms.server.version, '1.16.1');
  assert.equal(ms.server.serverVersion, '0.64.2');
  assert.equal(ms.server.openSubsonic, true);
  assert.equal(ms.server.id, serverIdFor(BASE));
  assert.equal(ms.remembered, false);
  assert.equal(ms.client.url, BASE);
  const raw = session.getItem(SERVER_STORE_KEY);
  assert(raw, 'kept in sessionStorage');
  assert.equal(local.getItem(SERVER_STORE_KEY), null);
  assert.equal(raw.includes('Secret-Pass-1'), false, 'never the password');
  const rec = JSON.parse(raw);
  assert.equal(rec.url, BASE);
  assert.equal(rec.username, 'dj');
  assert.equal(rec.token, md5(`Secret-Pass-1${rec.salt}`));
  assert.equal('password' in rec, false);
  assert.equal(typeof library.resolvers.get('subsonic'), 'function');
  assert.equal(srv.calls[0].q.u, 'dj');
  // remember: localStorage, and the session copy goes
  await ms.connect({ url: BASE, username: 'dj', password: 'Secret-Pass-1', remember: true });
  assert(local.getItem(SERVER_STORE_KEY));
  assert.equal(session.getItem(SERVER_STORE_KEY), null);
  assert.equal(ms.remembered, true);
  assert.equal(local.getItem(SERVER_STORE_KEY).includes('Secret-Pass-1'), false);
  // an OpenSubsonic API key instead of a password
  await ms.connect({ url: BASE, apiKey: 'nds_k1', remember: false });
  assert.deepEqual(JSON.parse(session.getItem(SERVER_STORE_KEY)).apiKey, 'nds_k1');
  assert.equal(srv.calls[srv.calls.length - 1].q.apiKey, 'nds_k1');
});

test('connect failures: wrong password, CORS, unreachable, mixed content, bad input; the old connection stays', async () => {
  const library = fakeLibrary();
  const local = new Storage();
  const session = new Storage();
  let mode = 'auth';
  const fetch = async (url, init = {}) => {
    if (mode === 'auth') return failed(40, 'Wrong username or password');
    if (mode === 'cors') {
      if (init.mode === 'no-cors') return { ok: false, status: 0, type: 'opaque', headers: new Headers() };
      throw new TypeError('Failed to fetch');
    }
    throw new TypeError('Failed to fetch'); // unreachable: the probe fails too
  };
  const ms = new MusicServerSource({ library, fetch, local, session, location: { protocol: 'https:' } });
  const errors = [];
  ms.on('error', (m) => errors.push(m));
  await assert.rejects(ms.connect({ url: BASE, username: 'dj', password: 'nope' }), (err) => err.code === 'auth' && err.message === 'Wrong user name or password.');
  assert.equal(ms.connected, false);
  assert.equal(ms.status, 'disconnected');
  assert.equal(session.getItem(SERVER_STORE_KEY), null);
  assert.equal(library.resolvers.size, 0);
  mode = 'cors';
  await assert.rejects(ms.connect({ url: BASE, username: 'dj', password: 'pw' }), (err) => err.code === 'cors' && err.message === MSG.cors);
  mode = 'down';
  await assert.rejects(ms.connect({ url: BASE, username: 'dj', password: 'pw' }), (err) => err.code === 'unreachable' && /synology\.me address/.test(err.message));
  await assert.rejects(ms.connect({ url: 'http://192.168.1.5:4533', username: 'dj', password: 'pw' }), (err) => err.code === 'mixed-content' && err.message === MSG.mixedLocal);
  await assert.rejects(ms.connect({ url: 'http://music.example.com', username: 'dj', password: 'pw' }), (err) => err.code === 'mixed-content');
  await assert.rejects(ms.connect({ url: '', username: 'dj', password: 'pw' }), (err) => err.code === 'bad-url');
  await assert.rejects(ms.connect({ url: BASE, username: '', password: 'pw' }), (err) => err.code === 'bad-input' && /user name/.test(err.message));
  await assert.rejects(ms.connect({ url: BASE, username: 'dj', password: '' }), (err) => err.code === 'bad-input' && /password/.test(err.message));
  assert.deepEqual(errors, [], 'connect() rejects; it does not also emit');
  // with a working connection, a failed attempt keeps it
  mode = 'ok';
  const good = new MusicServerSource({ library, fetch: fakeServer({ ping: PING }).fetch, local, session });
  await good.connect({ url: BASE, username: 'dj', password: 'pw' });
  good._fetch = async () => failed(40);
  good._client._fetch = good._fetch;
  await assert.rejects(good.connect({ url: 'https://other.example.com', username: 'dj', password: 'bad' }), (err) => err.code === 'auth');
  assert.equal(good.connected, true);
  assert.equal(good.status, 'connected');
  assert.equal(good.server.url, BASE);
});

test('a saved connection comes back without the network; disconnect forgets it; verify() pings', async () => {
  const local = new Storage();
  const session = new Storage();
  session.setItem(SERVER_STORE_KEY, JSON.stringify({ url: BASE, username: 'dj', token: 'tok', salt: 'salt', server: { type: 'navidrome', version: '1.16.1' } }));
  let answer = PING;
  const srv = fakeServer({ ping: () => answer() });
  const library = fakeLibrary();
  const ms = new MusicServerSource({ library, fetch: srv.fetch, local, session, location: { protocol: 'https:' } });
  assert.equal(ms.connected, true);
  assert.equal(ms.status, 'connected');
  assert.equal(ms.remembered, false);
  assert.equal(ms.server.type, 'navidrome');
  assert.equal(srv.calls.length, 0, 'no network at start-up');
  assert.equal(typeof library.resolvers.get('subsonic'), 'function');
  assert.equal(await ms.verify(), true);
  assert.equal(srv.calls[0].q.t, 'tok');
  assert.equal(srv.calls[0].q.s, 'salt');
  assert.equal(ms.server.serverVersion, '0.64.2');
  const errors = [];
  ms.on('error', (m) => errors.push(m));
  answer = () => failed(40);
  assert.equal(await ms.verify(), false);
  assert.equal(ms.status, 'auth-failed');
  assert.deepEqual(errors, ['Wrong user name or password.']);
  answer = () => {
    throw new TypeError('Failed to fetch');
  };
  assert.equal(await ms.verify(), false);
  assert.equal(ms.status, 'unreachable');
  const states = [];
  ms.on('state', () => states.push(ms.status));
  ms.disconnect();
  assert.equal(ms.connected, false);
  assert.equal(ms.server, null);
  assert.equal(ms.client, null);
  assert.deepEqual(states, ['disconnected']);
  assert.equal(session.getItem(SERVER_STORE_KEY), null);
  assert.equal(library.resolvers.size, 0);
  assert.equal(await ms.verify(), false);
  // remembered (localStorage) wins; broken records are ignored
  local.setItem(SERVER_STORE_KEY, JSON.stringify({ url: BASE, apiKey: 'nds_x' }));
  assert.equal(new MusicServerSource({ library, fetch: srv.fetch, local, session }).remembered, true);
  local.setItem(SERVER_STORE_KEY, '{broken');
  assert.equal(new MusicServerSource({ library, fetch: srv.fetch, local, session }).connected, false);
  local.setItem(SERVER_STORE_KEY, JSON.stringify({ url: BASE, username: 'dj' }));
  assert.equal(new MusicServerSource({ library, fetch: srv.fetch, local, session }).connected, false, 'no token: not restored');
  local.setItem(SERVER_STORE_KEY, JSON.stringify({ url: 'http://public.example.com', apiKey: 'k' }));
  assert.equal(new MusicServerSource({ library, fetch: srv.fetch, local, session, location: { protocol: 'https:' } }).connected, false);
});

test('toEntries + the library resolver: songs play from the server, with progress; clear messages when they cannot', async () => {
  const albumBody = {
    album: {
      id: 'al1', name: 'Gold',
      song: [
        { id: 'so1', title: 'SOS', artist: 'Abba', album: 'Gold', duration: 201, bpm: 124, coverArt: 'al-1', suffix: 'flac',
          contentType: 'audio/flac', size: 10000, path: 'Abba/Gold/01 - SOS.flac' },
        { id: 'so2', title: 'Waterloo', artist: 'Abba', album: 'Gold', duration: 168, suffix: 'mp3', size: 2000 },
        { id: 'dir1', title: 'A folder', isDir: true },
        { id: 'vid', title: 'A video', isVideo: true },
      ],
    },
  };
  const chunks = [new Uint8Array(6000), new Uint8Array(4000)];
  let downloads = 0;
  let offline = false;
  const srv = fakeServer({
    ping: PING,
    getAlbum: () => ok(albumBody),
    download: () => {
      downloads++;
      if (offline) throw new TypeError('Failed to fetch');
      return streamResponse(chunks, { headers: { 'content-type': 'audio/flac', 'content-length': '10000' } });
    },
  });
  const library = new Library({ indexedDB: null, storage: null });
  const ms = new MusicServerSource({ library, fetch: srv.fetch, local: new Storage(), session: new Storage() });
  assert.deepEqual(ms.toEntries([{ id: 'x' }]), [], 'not connected: nothing');
  await ms.connect({ url: BASE, username: 'dj', password: 'pw' });
  const body = await ms.client.getAlbum('al1');
  // the UI passes raw songs, or its own objects with `raw`
  const entries = ms.toEntries([body.album.song[0], { raw: body.album.song[1] }, body.album.song[2], body.album.song[3]]);
  assert.equal(entries.length, 2);
  const e0 = entries[0];
  assert.deepEqual({ ...e0.remote }, { kind: 'subsonic', serverId: ms.server.id, songId: 'so1' });
  assert.equal(e0.title, 'SOS');
  assert.equal(e0.artist, 'Abba');
  assert.equal(e0.album, 'Gold');
  assert.equal(e0.duration, 201);
  assert.equal(e0.bpm, 124);
  assert.equal(e0.coverArt, 'al-1');
  assert.equal(e0.fileName, '01 - SOS.flac');
  assert.equal(e0.type, 'audio/flac');
  assert.equal(e0.size, 10000);
  assert.equal(entries[1].fileName, 'Abba - Waterloo.mp3');
  assert.equal(entries[1].type, 'audio/mpeg');
  assert.equal('bpm' in entries[1], false);

  const listed = await library.addRemote(entries);
  const seen = [];
  const blob = await library.getBlob(listed[0].id, { onProgress: (b, t) => seen.push([b, t]) });
  assert.equal(blob.size, 10000);
  assert.equal(blob.name, '01 - SOS.flac', 'a File named like the entry (decoders use the name)');
  assert.equal(blob.type, 'audio/flac');
  assert.deepEqual(seen, [[0, 10000], [10000, 10000]], 'the size at once, then steps of >= 256 KB or 1 %');
  const dl = srv.calls.find((x) => x.url.includes('/rest/download.view'));
  assert.equal(dl.q.id, 'so1');
  assert.equal(downloads, 1);
  // cover art URLs only for songs of this server
  assert(ms.coverArtUrl(listed[0], 120).includes('getCoverArt.view'));
  assert.equal(parseQ(ms.coverArtUrl(listed[0], 120)).id, 'al-1');
  assert.equal(ms.coverArtUrl({ ...listed[0], remote: { kind: 'subsonic', serverId: 'srv-other', songId: 'so1' } }), '');
  assert(ms.coverArtUrl('al-9').includes('id=al-9'));
  // offline: a clear message
  offline = true;
  await assert.rejects(library.getBlob(listed[1].id), (err) => err.code === 'unreachable' && /Can't reach your music server to get “Waterloo”/.test(err.message));
  // a song of another server
  const [other] = await library.addRemote([{ title: 'Elsewhere', remote: { kind: 'subsonic', serverId: 'srv-000000000000', songId: 'z' } }]);
  await assert.rejects(library.getBlob(other.id), (err) => err.code === 'other-server' && /another music server/.test(err.message));
  // disconnected: the library says how to fix it
  ms.disconnect();
  await assert.rejects(library.getBlob(listed[1].id), (err) => err.code === 'unavailable' && /Connect to your music server to play “Waterloo”/.test(err.message));
  assert.equal((await library.getBlob(listed[0].id)).size, 10000, 'a song still in the 3-song cache plays');
  await sleep(1);
});
