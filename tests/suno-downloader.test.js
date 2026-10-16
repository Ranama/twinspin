// Tests for extras/suno-playlist-downloader.js, the Suno playlist helper that Add music > Songs from Suno offers (a
// console script for suno.com, not a module of the app). It is loaded in test mode (tests/helpers/suno-test-flag.js
// first), so it touches no page and exposes its pure helpers and its run engine on globalThis.__SUNO_PLAYLIST__.
// Covered: the host allow-list (real hosts, lookalikes, http:), file names (number prefix, unsafe characters,
// uniqueness, extensions), billing parsing variants, ETA, backoff incl. Retry-After, the resume record, and engine
// runs on a fake Suno (stubbed io): only your finished songs are saved; Pause mid-file then Resume finishes without
// a second unlock; Stop ends early; a 403 on the direct MP3 switches to Suno's own Download and later songs skip the
// direct try; the channel turned off fails with the reason; a 402 on the unlock pauses the run (no downloads left);
// 429 / 503 are retried; a 401 gets one fresh token; Retry failed re-runs only failed songs; songs saved before are
// skipped (resume record and existing files); WAV, lyrics and metadata; Stop wins over a late "no downloads left" or
// sign-in answer; a folder or disk error pauses the run (same file name on Resume); an unreadable playlist page says
// the list is incomplete; nothing is sent after destroy; the house rules in the source.
import './helpers/suno-test-flag.js';
import '../extras/suno-playlist-downloader.js';

const S = globalThis.__SUNO_PLAYLIST__;
const SCRIPT = new URL('../extras/suno-playlist-downloader.js', import.meta.url);
const ME = 'user-me';
const PL = '0f0e0d0c-1111-4222-8333-444455556666';
const S3 = 'https://suno-data-uploads.s3.amazonaws.com';

/** A clip id like 11111111-0000-4000-8000-000000000001 (its first 8 characters end up in the file name). */
const cid = (n) => `${String(n).repeat(8).slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** One of your finished songs; audio_url is Suno's "forbidden" placeholder unless extra says otherwise. */
const clip = (n, extra = {}) => ({
  id: cid(n), title: `Song ${n}`, user_id: ME, status: 'complete', audio_url: 'https://studio-api.prod.suno.com/api/forbidden',
  image_url: `https://cdn2.suno.ai/image_${cid(n)}.jpeg`, ...extra,
});
const direct = (n) => `https://cdn1.suno.ai/${cid(n)}.mp3`;
const settings = (extra = {}) => ({ formats: ['mp3'], numbered: true, saveTo: 'downloads', skipSaved: true, useChannel: true, ...extra });
const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
const okFile = (type = 'audio/mpeg', head = [0x49, 0x44, 0x33, 4, 0]) => ({ status: 200, blob: { size: 3000 }, type, size: 3000, head });

async function until(fn, ms = 10 * 60 * 1000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

/**
 * A fake Suno behind the engine's io. fs.clips is the playlist; fs.quota makes the unlock answer 402; fs.directStatus
 * is what cdn1.suno.ai answers; fs.apiHook / fs.fetchHook may answer a call first (return a value) or watch it.
 */
function fakeSuno(clips, opts = {}) {
  const fs = {
    clips, quota: false, directStatus: 403, used: 3, calls: [], fresh: [], fetched: [], saved: [], authorized: [], polls: {},
    store: new Map(), apiHook: null, fetchHook: null, exists: null,
  };
  const io = {
    async api(path, o) {
      const method = o.method || 'GET';
      fs.calls.push(`${method} ${path}`);
      if (o.fresh) fs.fresh.push(path);
      const hooked = fs.apiHook && fs.apiHook(method, path, o);
      if (hooked) return hooked;
      let m;
      if (path === '/api/feed/v3') return { status: 200, data: { clips: [{ id: 'x', user_id: ME }] } };
      if ((m = /^\/api\/playlist\/([^/]+)\/\?page=(\d+)$/.exec(path))) {
        if (m[1] !== PL) return { status: 404, data: { detail: 'Not found' } };
        const page = Number(m[2]);
        return { status: 200, data: { name: 'Road Trip', num_total_results: fs.clips.length, playlist_clips: fs.clips.slice((page - 1) * 3, page * 3).map((c) => ({ clip: c })) } };
      }
      if (path === '/api/billing/info/') {
        return { status: 200, data: { download_usage: { current_period_downloads_limit: 20, current_period_downloads_used: fs.used, additional_download_remaining: 0 } } };
      }
      if (path === '/api/download/authorize') {
        fs.authorized.push(o.body.item_id);
        if (fs.quota) return { status: 402, data: { detail: 'No downloads left' } };
        fs.used++;
        return { status: 200, data: {} };
      }
      if ((m = /^\/api\/download\/clip\/([^?]+)\?format=mp3$/.exec(path))) {
        fs.polls[m[1]] = (fs.polls[m[1]] || 0) + 1;
        if (fs.polls[m[1]] === 1) return { status: 200, data: { status: 'processing' } };
        return { status: 200, data: { status: 'ready', download_url: `${S3}/${m[1]}.mp3?X-Amz-Signature=abc` } };
      }
      if ((m = /^\/api\/gen\/([^/]+)\/convert_wav\/$/.exec(path))) return { status: 200, data: {} };
      if ((m = /^\/api\/gen\/([^/]+)\/wav_file\/$/.exec(path))) {
        fs.polls[`wav ${m[1]}`] = (fs.polls[`wav ${m[1]}`] || 0) + 1;
        return fs.polls[`wav ${m[1]}`] === 1 ? { status: 404, data: null } : { status: 200, data: { wav_file_url: `${S3}/studio/uploads/${m[1]}.wav?sig=1` } };
      }
      return { status: 404, data: null };
    },
    fetchFile(url, o) {
      fs.fetched.push(url);
      const hooked = fs.fetchHook && fs.fetchHook(url, o);
      if (hooked) return hooked;
      o.onProgress(1500, 3000);
      if (new URL(url).hostname === 'cdn1.suno.ai') return Promise.resolve(fs.directStatus === 200 ? okFile() : { status: fs.directStatus });
      if (/\.wav\?/.test(url)) return Promise.resolve(okFile('audio/wav', [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]));
      if (/\.jpeg$/.test(url)) return Promise.resolve(okFile('image/jpeg', [0xff, 0xd8, 0xff]));
      return Promise.resolve(okFile());
    },
    async save(name, data) {
      fs.saved.push(name);
      if (data.text != null) fs.lastText = data.text;
      return { name };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    storage: {
      get: (k) => (fs.store.has(k) ? JSON.parse(fs.store.get(k)) : null),
      set: (k, v) => fs.store.set(k, JSON.stringify(v)),
      remove: (k) => fs.store.delete(k),
    },
  };
  if (opts.exists) io.exists = async (name) => opts.exists(name);
  const engine = S.createEngine(io);
  return { fs, io, engine };
}
const statuses = (engine) => engine.state.songs.map((s) => s.status + (s.note ? `: ${s.note}` : ''));

// ------------------------------------------------------------------------------------------------- test mode

test('test mode: the script touches no page and exposes its helpers and engine', () => {
  assert.equal(typeof S, 'object');
  assert.match(S.VERSION, /^2\.\d+\.\d+$/);
  assert.equal(typeof S.createEngine, 'function');
  assert.equal(globalThis.__sunoPlaylistDl, undefined, 'no panel in test mode');
  assert.deepEqual(S.FORMATS.map((f) => f.id), ['mp3', 'wav', 'mp4', 'cover', 'lyrics', 'json']);
  assert.deepEqual(S.API_BASES, ['https://studio-api.prod.suno.com', 'https://studio-api-prod.suno.com']);
});

// ------------------------------------------------------------------------------------------------- helpers

test('host allow-list: Suno, its media hosts and its download bucket; never lookalikes or http:', () => {
  for (const url of [
    'https://suno.com/playlist/x', 'https://SUNO.com/', 'https://studio-api.prod.suno.com/api/feed/', 'https://studio-api-prod.suno.com/api/x',
    'https://cdn1.suno.ai/abc.mp3', 'https://cdn2.suno.ai/image_abc.jpeg', 'https://suno.ai/x',
    `${S3}/studio/uploads/abc.wav?X-Amz-Signature=1&Expires=2`, 'https://suno-data-uploads.s3.us-west-2.amazonaws.com/abc.mp3',
    'https://suno-data-uploads.s3-us-west-2.amazonaws.com/abc.mp3', 'https://s3.amazonaws.com/suno-data-uploads/abc.mp3',
  ]) assert.equal(S.isAllowedUrl(url), true, url);
  for (const url of [
    'http://suno.com/x', 'http://cdn1.suno.ai/a.mp3', 'https://suno.com.evil.example/x', 'https://evilsuno.com/', 'https://suno.co/',
    'https://suno.com@evil.example/', 'https://evil.example/suno.com', 'https://evil.example/?u=https://suno.com',
    'https://suno-data-uploads.s3.amazonaws.com.evil.example/x', 'https://other-bucket.s3.amazonaws.com/x',
    'https://s3.amazonaws.com/other-bucket/suno-data-uploads/x', 'https://suno-data-uploads-x.s3.amazonaws.com/x',
    'https://d2lwuy8qc234o3.cloudfront.net/1/clip/abc.m4a', 'https://suno.com:8443/', 'https://user:pw@suno.com/',
    'javascript:alert(1)', 'data:audio/mpeg;base64,AAAA', '', null, undefined, 'suno.com',
  ]) assert.equal(S.isAllowedUrl(url), false, String(url));
  // S3: the bucket in every form S3 serves it, never another bucket dressed up as S3's own host part (a bucket named
  // "s3-x" is reachable as s3-x.s3.amazonaws.com and could hold a key "suno-data-uploads/...")
  for (const url of [
    'https://s3.us-west-2.amazonaws.com/suno-data-uploads/abc.mp3', 'https://s3-us-west-2.amazonaws.com/suno-data-uploads/abc.mp3',
    'https://s3.us-gov-west-1.amazonaws.com/suno-data-uploads/abc.mp3', 'https://s3.dualstack.eu-central-1.amazonaws.com/suno-data-uploads/a.mp3',
    'https://suno-data-uploads.s3.dualstack.us-west-2.amazonaws.com/abc.mp3', 'https://suno-data-uploads.s3-accelerate.amazonaws.com/abc.mp3',
    'https://suno-data-uploads.s3.ap-southeast-1.amazonaws.com/abc.mp3', 'https://suno-data-uploads.s3.amazonaws.com:443/abc.mp3',
  ]) assert.equal(S.isAllowedUrl(url), true, url);
  for (const url of [
    'https://s3-evil.s3.amazonaws.com/suno-data-uploads/x', 'https://s3-x.s3.us-west-2.amazonaws.com/suno-data-uploads/x',
    'https://s3.evil.amazonaws.com/suno-data-uploads/x', 'https://suno-data-uploads.s3.evil.s3.amazonaws.com/x',
    'https://suno-data-uploads.s3-evil.s3.amazonaws.com/x', 'https://s3.amazonaws.com/suno-data-uploadsx/x', 'https://s3.amazonaws.com/x/suno-data-uploads/y',
    'https://s3.amazonaws.com/suno-data-uploads/../other-bucket/x', 'http://suno-data-uploads.s3.amazonaws.com/x',
    'https://suno-data-uploads.s3.amazonaws.com:8443/x', 'https://cdn1.suno.ai.evil.example/x', 'https://xsuno.ai/x',
  ]) assert.equal(S.isAllowedUrl(url), false, url);
  // the sign-in token only ever goes to Suno's API
  assert.equal(S.isApiUrl('https://studio-api.prod.suno.com/api/billing/info/'), true);
  assert.equal(S.isApiUrl('https://studio-api-prod.suno.com/api/x'), true);
  assert.equal(S.isApiUrl('https://cdn1.suno.ai/api/x'), false);
  assert.equal(S.isApiUrl('https://suno.com/song/x'), false);
  assert.equal(S.isApiUrl('http://studio-api.prod.suno.com/api/x'), false);
  assert.equal(S.isApiUrl(`${S3}/api/x`), false);
});

test('the direct MP3 address: only a real file on a Suno host, never /api/forbidden', () => {
  assert.equal(S.directAudioUrl(clip(1)), null, '/api/forbidden');
  assert.equal(S.directAudioUrl(clip(1, { audio_url: direct(1) })), direct(1));
  assert.equal(S.directAudioUrl(clip(1, { audio_url: 'https://evil.example/a.mp3' })), null);
  assert.equal(S.directAudioUrl(clip(1, { audio_url: 'https://studio-api.prod.suno.com/api/clip/x' })), null);
  assert.equal(S.directAudioUrl(clip(1, { audio_url: null })), null);
  assert.equal(S.directAudioUrl(null), null);
});

test('file names: number prefix, unsafe characters, uniqueness, extensions', () => {
  assert.equal(S.numberPrefix(7, 40), '07 - ');
  assert.equal(S.numberPrefix(3, 5), '03 - ');
  assert.equal(S.numberPrefix(12, 12), '12 - ');
  assert.equal(S.numberPrefix(7, 120), '007 - ');
  assert.equal(S.numberPrefix(1000, 1000), '1000 - ');
  const c = { id: '1a2b3c4d-0000-4000-8000-000000000001', title: 'Neon Rain' };
  assert.equal(S.baseName(c, 7, 40, true), '07 - Neon Rain [1a2b3c4d]');
  assert.equal(S.baseName(c, 7, 40, false), 'Neon Rain [1a2b3c4d]');
  assert.equal(S.safeName('AC/DC: "Live"?*'), 'AC_DC_ _Live_');
  assert.equal(S.safeName('a<b>c|d\\e'), 'a_b_c_d_e');
  assert.equal(S.safeName('tab\there\nnew\u0000line'), 'tab here new_line');
  assert.equal(S.safeName('..hidden'), 'hidden');
  assert.equal(S.safeName('ends with dots. . '), 'ends with dots');
  assert.equal(S.safeName('CON'), '_CON');
  assert.equal(S.safeName('com1'), '_com1');
  assert.equal(S.safeName(''), 'untitled');
  assert.equal(S.safeName(null), 'untitled');
  assert.equal(S.safeName('???'), '_');
  assert.equal(S.safeName('x'.repeat(300)).length, 100);
  assert.equal(S.safeName('Ünïcødé 🎵 ok'), 'Ünïcødé 🎵 ok');
  assert.equal(S.safeName(`${'x'.repeat(99)}🎵🎵`), `${'x'.repeat(99)}🎵`, 'cut by characters: never half an emoji (a lone surrogate)');
  assert(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(S.safeName('🎵'.repeat(120))), 'no lone high surrogate');
  const taken = new Set();
  assert.equal(S.uniqueName('A.mp3', taken), 'A.mp3');
  assert.equal(S.uniqueName('A.mp3', taken), 'A (2).mp3');
  assert.equal(S.uniqueName('a.MP3', taken), 'a (3).MP3', 'case-insensitive, like Windows');
  assert.equal(S.uniqueName('B.mp3', taken), 'B.mp3');
  assert.equal(S.uniqueName('noext', taken), 'noext');
  assert.equal(S.uniqueName('noext', taken), 'noext (2)');
  // extensions: a clear content type, else the first bytes, else the format's own
  const ID3 = [0x49, 0x44, 0x33, 4], RIFF = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45];
  const FTYP = [0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70], JPEG = [0xff, 0xd8, 0xff, 0xe0], PNG = [0x89, 0x50, 0x4e, 0x47];
  assert.equal(S.fileExt('mp3', 'audio/mpeg', []), 'mp3');
  assert.equal(S.fileExt('mp3', 'audio/mpeg; charset=binary', []), 'mp3');
  assert.equal(S.fileExt('mp3', 'application/octet-stream', ID3), 'mp3');
  assert.equal(S.fileExt('mp3', '', [0xff, 0xfb, 0x90]), 'mp3');
  assert.equal(S.fileExt('mp3', 'binary/octet-stream', RIFF), 'wav');
  assert.equal(S.fileExt('wav', 'application/octet-stream', RIFF), 'wav');
  assert.equal(S.fileExt('wav', 'audio/x-wav', []), 'wav');
  assert.equal(S.fileExt('mp4', '', FTYP), 'mp4');
  assert.equal(S.fileExt('mp3', '', FTYP), 'm4a');
  assert.equal(S.fileExt('mp3', '', []), 'mp3');
  assert.equal(S.fileExt('wav', undefined, undefined), 'wav');
  assert.equal(S.fileExt('cover', 'image/png', []), 'png');
  assert.equal(S.fileExt('cover', '', JPEG), 'jpeg');
  assert.equal(S.fileExt('cover', '', PNG), 'png');
  assert.equal(S.fileExt('cover', '', []), 'jpeg');
  assert.equal(S.fileExt('lyrics', 'audio/mpeg', ID3), 'txt');
  assert.equal(S.fileExt('json'), 'json');
  assert.equal(S.sniff(JPEG), 'jpeg', 'a JPEG is not an MP3 frame');
});

test('billing info: downloads left from the field names Suno has used (defensively)', () => {
  const du = (o) => ({ download_usage: o });
  assert.deepEqual(S.parseBilling(du({ current_period_downloads_limit: 20, current_period_downloads_used: 3, additional_download_remaining: 2 })),
    { left: 19, limit: 20, used: 3, extra: 2 });
  assert.equal(S.parseBilling(du({ current_period_downloads_limit: 60, current_period_downloads_used: 0 })).left, 60);
  assert.equal(S.parseBilling(du({ current_period_downloads_limit: '20', current_period_downloads_used: '25' })).left, 0, 'strings, never below 0');
  assert.equal(S.parseBilling({ downloadUsage: { currentPeriodDownloadsLimit: 7, currentPeriodDownloadsUsed: 5 } }).left, 2, 'camelCase');
  assert.equal(S.parseBilling({ data: du({ current_period_downloads_limit: 20, current_period_downloads_used: 19 }) }).left, 1, 'under data');
  assert.equal(S.parseBilling(du({ additional_download_remaining: 3 })).left, 3, 'only bought extras');
  assert.equal(S.parseBilling(du({ additional_downloads_remaining: 0 })).left, 0);
  assert.equal(S.parseBilling(du({ remaining: 12 })).left, 12, 'plain names inside download_usage');
  assert.equal(S.parseBilling({ downloads_remaining: 4, total_credits_left: 2500 }).left, 4, 'a top-level downloads_remaining');
  assert.equal(S.parseBilling({ current_period_downloads_limit: 20, current_period_downloads_used: 18 }).left, 2, 'top level');
  assert.equal(S.parseBilling({ limit: 20, used: 3, total_credits_left: 50 }), null, 'plain names outside download_usage are not downloads');
  assert.equal(S.parseBilling({ total_credits_left: 2500, plan: { name: 'Pro' } }), null);
  assert.equal(S.parseBilling(du({ current_period_downloads_limit: null, current_period_downloads_used: 'x' })), null);
  assert.equal(S.parseBilling(null), null);
  assert.equal(S.parseBilling('nonsense'), null);
});

test('time left and sizes', () => {
  assert.equal(S.estimateMs(60000, 2, 4), 120000, '30 s a song, 4 to go');
  assert.equal(S.estimateMs(60000, 0, 4), null, 'nothing finished yet');
  assert.equal(S.estimateMs(60000, 2, 0), null);
  assert.equal(S.fmtEta(6 * 60000), 'about 6 min left');
  assert.equal(S.fmtEta(30000), 'less than a minute left');
  assert.equal(S.fmtEta(50000), 'about 1 min left');
  assert.equal(S.fmtEta(125 * 60000), 'about 2 h 5 min left');
  assert.equal(S.fmtEta(120 * 60000), 'about 2 h left');
  assert.equal(S.fmtEta(null), '');
  assert.equal(S.fmtSize(3.5 * 1048576), '3.5 MB');
  assert.equal(S.fmtSize(850 * 1024), '850 KB');
  assert.equal(S.fmtSize(120), '120 B');
});

test('backoff: 2, 5, 15, 30 s, or Retry-After (seconds or a date, 1 s to 5 min); what is retried', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  assert.deepEqual([0, 1, 2, 3, 9].map((a) => S.backoffMs(a, null, now)), [2000, 5000, 15000, 30000, 30000]);
  assert.deepEqual(S.BACKOFF_MS, [2000, 5000, 15000, 30000]);
  assert.equal(S.backoffMs(0, '7', now), 7000);
  assert.equal(S.backoffMs(3, '1.5', now), 1500);
  assert.equal(S.backoffMs(0, '0', now), 1000, 'at least 1 s');
  assert.equal(S.backoffMs(0, '999', now), 300000, 'at most 5 min');
  assert.equal(S.backoffMs(0, 'Fri, 16 Oct 2026 12:00:10 GMT', now), 10000, 'an HTTP date');
  assert.equal(S.backoffMs(1, 'soon', now), 5000, 'garbage: the schedule');
  assert.equal(S.parseRetryAfter('', now), null);
  assert.equal(S.parseRetryAfter('Fri, 16 Oct 2026 11:59:00 GMT', now), 0, 'a date in the past');
  for (const s of [0, 408, 429, 500, 502, 503, 504]) assert.equal(S.isRetryable(s), true, String(s));
  for (const s of [200, 400, 401, 402, 403, 404, 410]) assert.equal(S.isRetryable(s), false, String(s));
});

test('resume record, clips, playlist pages and settings', () => {
  let rec = S.resumeLoad(null);
  assert.deepEqual(rec, { v: 1, files: {} });
  rec = S.resumeAdd(rec, 'a', 'mp3');
  rec = S.resumeAdd(rec, 'a', 'mp3');
  rec = S.resumeAdd(rec, 'a', 'wav');
  rec = S.resumeAdd(rec, 'b', 'cover');
  assert.deepEqual(rec, { v: 1, files: { a: ['mp3', 'wav'], b: ['cover'] } });
  assert.equal(S.resumeHas(rec, 'a', 'wav'), true);
  assert.equal(S.resumeHas(rec, 'b', 'mp3'), false);
  assert.equal(S.resumeHas(null, 'a', 'mp3'), false);
  assert.deepEqual(S.resumeLoad({ v: 1, files: { a: ['mp3', 'exe', 7], b: 'mp3' } }), { v: 1, files: { a: ['mp3'] } }, 'junk dropped');
  assert.deepEqual(S.resumeLoad({ v: 2, files: { a: ['mp3'] } }), { v: 1, files: {} }, 'another version: start over');
  assert.equal(S.KEY.done(PL), `suno-dl.done.${PL}`);
  assert.equal(S.KEY.pos, 'suno-dl.pos');
  assert.equal(S.KEY.settings, 'suno-dl.settings');
  // clips: yours and finished, by others, not finished
  assert.equal(S.classifyClip(clip(1), ME), 'mine');
  assert.equal(S.classifyClip(clip(1, { status: 'COMPLETE' }), ME), 'mine');
  assert.equal(S.classifyClip(clip(1, { status: undefined }), ME), 'mine', 'no status field: Suno did not say it is unfinished');
  assert.equal(S.classifyClip(clip(1, { user_id: 'someone' }), ME), 'others');
  assert.equal(S.classifyClip(clip(1), null), 'others', 'unknown account: nothing counts as yours');
  assert.equal(S.classifyClip(clip(1, { status: 'streaming' }), ME), 'unfinished');
  assert.equal(S.classifyClip(clip(1, { status: 'error' }), ME), 'unfinished');
  assert.equal(S.classifyClip({ title: 'no id' }, ME), 'bad');
  const page = S.playlistPage({ name: ' Mix ', num_total_results: '2', playlist_clips: [{ clip: clip(1) }, clip(2), { clip: null }, { nope: 1 }] });
  assert.deepEqual([page.name, page.total, page.clips.map((c) => c.title)], ['Mix', 2, ['Song 1', 'Song 2']]);
  assert.deepEqual(S.playlistPage(null), { name: null, total: null, clips: [] });
  assert.equal(S.userIdFrom({ clips: [{ id: 'x' }, { id: 'y', user_id: 'u1' }] }), 'u1');
  assert.equal(S.userIdFrom([{ user_id: 'u2' }]), 'u2');
  assert.equal(S.userIdFrom({ detail: 'x' }), null);
  assert.equal(S.preparedUrl({ status: 'processing', download_url: 'https://x' }), null);
  assert.equal(S.preparedUrl({ status: 'ready', download_url: `${S3}/a.mp3` }), `${S3}/a.mp3`);
  assert.equal(S.preparedUrl({ data: { wav_file_url: `${S3}/a.wav` } }), `${S3}/a.wav`);
  assert.equal(S.lyricsOf({ metadata: { prompt: '[Verse]\nla la' } }), '[Verse]\nla la');
  assert.equal(S.lyricsOf({ metadata: { prompt: '  ' }, lyrics: 'x' }), 'x');
  assert.equal(S.lyricsOf({}), '');
  assert.equal(S.playlistIdFrom(`/playlist/${PL}`), PL);
  assert.equal(S.playlistIdFrom(`/playlist/${PL}?x=1`), PL);
  assert.equal(S.playlistIdFrom('/song/abc'), null);
  assert.deepEqual(S.normSettings(null, true), { formats: ['mp3'], numbered: true, saveTo: 'folder', skipSaved: true, useChannel: true });
  assert.deepEqual(S.normSettings(null, false).saveTo, 'downloads', 'no folder picker: Downloads');
  assert.deepEqual(S.normSettings({ formats: ['json', 'mp3', 'evil'], numbered: false, saveTo: 'downloads', skipSaved: false, useChannel: false }, true),
    { formats: ['mp3', 'json'], numbered: false, saveTo: 'downloads', skipSaved: false, useChannel: false });
});

// ------------------------------------------------------------------------------------------------- engine runs

test('engine: loads the playlist, skips songs by others and unfinished ones, saves only your finished songs', async () => {
  const clips = [clip(1, { audio_url: direct(1) }), clip(2, { user_id: 'someone', handle: 'dj' }), clip(3, { status: 'streaming' }),
    clip(4, { audio_url: direct(4), title: 'Neon / Rain?' }), clip(1, { audio_url: direct(1) })];
  const { fs, engine } = fakeSuno(clips);
  fs.directStatus = 200;
  assert.equal(engine.state.phase, 'idle');
  assert.equal(await engine.load(PL), true);
  assert.equal(engine.state.phase, 'ready');
  assert.equal(engine.state.playlist.name, 'Road Trip');
  assert.equal(engine.state.songs.length, 5, 'both pages read');
  assert.deepEqual(engine.state.billing, { left: 17, limit: 20, used: 3, extra: 0 });
  assert.deepEqual(engine.state.songs.map((s) => s.kind), ['mine', 'others', 'unfinished', 'mine', 'dup']);
  await engine.start(settings());
  assert.equal(engine.state.phase, 'done');
  assert.deepEqual(fs.saved, ['01 - Song 1 [11111111].mp3', '04 - Neon _ Rain_ [44444444].mp3']);
  assert.deepEqual(fs.fetched, [direct(1), direct(4)], 'never another song');
  assert.deepEqual(fs.authorized, [], 'the direct files worked: no download counted');
  assert.deepEqual(statuses(engine), ['saved', 'skipped: not yours (@dj)', 'skipped: not finished (streaming)', 'saved', 'skipped: listed twice (same as #1)']);
  assert.deepEqual(engine.state.counts, { saved: 2, skipped: 3, failed: 0 });
  assert.equal(engine.state.message, 'Saved 2 songs, 0 failed, 3 skipped.');
  assert.equal(engine.state.tone, 'ok');
  assert.deepEqual(fs.store.get(S.KEY.done(PL)) && JSON.parse(fs.store.get(S.KEY.done(PL))), { v: 1, files: { [cid(1)]: ['mp3'], [cid(4)]: ['mp3'] } });
  assert(!fs.calls.some((c) => /authorize|download\/clip|convert_wav/.test(c)), 'no Suno Download calls');
});

test('engine: a 403 on the direct MP3 switches to Suno\'s own Download; later songs skip the direct try', async () => {
  const { fs, engine } = fakeSuno([1, 2, 3].map((n) => clip(n, { audio_url: direct(n) })));
  await engine.load(PL);
  await engine.start(settings());
  assert.deepEqual(fs.fetched, [direct(1), `${S3}/${cid(1)}.mp3?X-Amz-Signature=abc`, `${S3}/${cid(2)}.mp3?X-Amz-Signature=abc`,
    `${S3}/${cid(3)}.mp3?X-Amz-Signature=abc`]);
  assert.deepEqual(fs.authorized, [cid(1), cid(2), cid(3)], 'one unlock per song');
  assert.equal(fs.polls[cid(1)], 2, 'polled until ready');
  assert.deepEqual(statuses(engine), ['saved', 'saved', 'saved']);
  assert(engine.state.log.some((l) => /Suno blocked the direct MP3 file \(HTTP 403 from cdn1\.suno\.ai\)\. Using Suno's own Download/.test(l)));
  assert.equal(engine.state.billing.left, 14, 'billing read again after the run (3 more used)');
});

test('engine: with Suno\'s own Download turned off, a blocked song fails with the reason and nothing is unlocked', async () => {
  const { fs, engine } = fakeSuno([clip(1, { audio_url: direct(1) }), clip(2), clip(3, { audio_url: direct(3) })]);
  await engine.load(PL);
  await engine.start(settings({ useChannel: false }));
  const reason = 'failed: Suno blocked the direct file; turn on Suno\'s own Download';
  assert.deepEqual(statuses(engine), [reason, reason, reason]);
  assert.deepEqual(fs.fetched, [direct(1)], 'once blocked, no more direct tries');
  assert.deepEqual(fs.authorized, []);
  assert.deepEqual(fs.saved, []);
  assert.deepEqual(engine.state.counts, { saved: 0, skipped: 0, failed: 3 });
  assert.equal(engine.state.tone, 'warn');
});

test('engine: Pause stops at once (the file in flight is aborted), Resume restarts that file without a second unlock', async () => {
  const { fs, engine } = fakeSuno([clip(1), clip(2), clip(3)]);
  await engine.load(PL);
  let held = false;
  fs.fetchHook = (url, o) => {
    if (held || !url.includes(cid(2))) return null;
    held = true;
    return new Promise((resolve, reject) => {
      o.signal.onAbort(() => reject(abortErr()));
      setTimeout(() => engine.pause(), 5);
    });
  };
  const run = engine.start(settings());
  assert(await until(() => engine.state.phase === 'paused'), 'paused');
  assert.equal(engine.state.pauseReason, 'user');
  assert.equal(engine.state.message, 'Paused. Press Resume to go on.');
  assert.deepEqual(statuses(engine), ['saved', 'working', 'waiting']);
  const calls = fs.calls.length, fetched = fs.fetched.length;
  await new Promise((r) => setTimeout(r, 60000));
  assert.equal(fs.calls.length, calls, 'nothing is polled while paused');
  assert.equal(fs.fetched.length, fetched);
  // while a run is going (here: paused), Start, Retry failed, a row's Retry and Reload do nothing; Pause twice is Pause
  assert.equal(await engine.start(settings()), undefined);
  assert.equal(await engine.retryFailed(settings()), undefined);
  assert.equal(await engine.retrySong(2, settings()), undefined);
  assert.equal(await engine.load(PL), false);
  engine.pause();
  assert.equal(engine.state.phase, 'paused');
  assert.deepEqual(statuses(engine), ['saved', 'working', 'waiting']);
  assert.equal(fs.calls.length, calls);
  engine.resume();
  await run;
  assert.equal(engine.state.phase, 'done');
  assert.deepEqual(statuses(engine), ['saved', 'saved', 'saved']);
  assert.deepEqual(fs.authorized, [cid(1), cid(2), cid(3)], 'song 2 was unlocked once');
  assert.equal(fs.fetched.filter((u) => u.includes(cid(2))).length, 2, 'the aborted file was fetched again');
  assert.deepEqual(fs.saved, ['01 - Song 1 [11111111].mp3', '02 - Song 2 [22222222].mp3', '03 - Song 3 [33333333].mp3']);
});

test('engine: Pause while Suno prepares the file stops the polling; Resume does not unlock again', async () => {
  const { fs, engine } = fakeSuno([clip(1)]);
  await engine.load(PL);
  fs.apiHook = (method, path) => {
    if (/download\/clip/.test(path) && fs.polls[cid(1)] === undefined) { fs.polls[cid(1)] = 1; setTimeout(() => engine.pause(), 1); return { status: 200, data: { status: 'processing' } }; }
    return null;
  };
  const run = engine.start(settings());
  assert(await until(() => engine.state.phase === 'paused'));
  const polls = fs.polls[cid(1)];
  await new Promise((r) => setTimeout(r, 30000));
  assert.equal(fs.polls[cid(1)], polls, 'no polling while paused');
  engine.resume();
  await run;
  assert.deepEqual(statuses(engine), ['saved']);
  assert.deepEqual(fs.authorized, [cid(1)]);
});

test('engine: Stop ends the run early; the list keeps its states', async () => {
  const { fs, engine } = fakeSuno([clip(1), clip(2), clip(3), clip(4)]);
  await engine.load(PL);
  fs.fetchHook = (url, o) => {
    if (!url.includes(cid(2))) return null;
    return new Promise((resolve, reject) => {
      o.signal.onAbort(() => reject(abortErr()));
      setTimeout(() => engine.stop(), 5);
    });
  };
  await engine.start(settings());
  assert.equal(engine.state.phase, 'done');
  assert.equal(engine.state.run.stopped, true);
  assert.deepEqual(statuses(engine), ['saved', 'waiting: stopped', 'waiting', 'waiting']);
  assert.equal(engine.state.message, 'Stopped. Saved 1 song, 0 failed, 0 skipped.');
  assert.deepEqual(fs.saved, ['01 - Song 1 [11111111].mp3']);
  assert(!fs.authorized.includes(cid(3)), 'nothing after the stop');
  // Start again: song 1 was saved before
  fs.fetchHook = null;
  await engine.start(settings());
  assert.deepEqual(statuses(engine), ['skipped: saved before', 'saved', 'saved', 'saved']);
  assert.deepEqual(fs.authorized.filter((x) => x === cid(1)), [cid(1)], 'song 1 not unlocked again');
});

test('engine: a 402 on the unlock pauses the run (no downloads left) instead of failing every song; Resume goes on', async () => {
  const { fs, engine } = fakeSuno([clip(1), clip(2)]);
  await engine.load(PL);
  fs.quota = true;
  const run = engine.start(settings());
  assert(await until(() => engine.state.phase === 'paused'));
  assert.equal(engine.state.pauseReason, 'quota');
  assert.equal(engine.state.message, 'Suno refused to unlock the download (HTTP 402: No downloads left). This usually means your plan has no ' +
    'downloads left this period. The run is paused: check your plan on suno.com, then press Resume, or Stop.');
  assert.equal(engine.state.tone, 'warn');
  assert.deepEqual(statuses(engine), ['working', 'waiting']);
  assert.equal(engine.state.counts.failed, 0);
  await new Promise((r) => setTimeout(r, 60000));
  assert.deepEqual(fs.authorized, [cid(1)], 'no more unlock tries while paused');
  fs.quota = false; // the user bought more downloads
  engine.resume();
  await run;
  assert.deepEqual(statuses(engine), ['saved', 'saved']);
  assert.deepEqual(fs.authorized, [cid(1), cid(1), cid(2)]);
});

test('engine: 429 and 503 are retried with backoff (Retry-After honoured), then the run goes on', async () => {
  const { fs, engine } = fakeSuno([clip(1)]);
  await engine.load(PL);
  let limited = 0, broken = 0;
  fs.apiHook = (method, path) => (/download\/clip/.test(path) && limited++ < 2 ? { status: 429, data: null, retryAfter: '3' } : null);
  fs.fetchHook = (url) => (url.startsWith(S3) && broken++ < 1 ? Promise.resolve({ status: 503 }) : null);
  const t0 = Date.now();
  await engine.start(settings());
  assert.deepEqual(statuses(engine), ['saved']);
  assert.equal(fs.calls.filter((c) => /download\/clip/.test(c)).length, 4, '2 x 429, processing, ready');
  assert.equal(fs.fetched.length, 2, '503, then the file');
  assert(Date.now() - t0 >= 3000 + 3000 + 2000, 'waited 3 s + 3 s (Retry-After) and 2 s');
  assert(engine.state.log.some((l) => /Suno says "too many requests" \(\/api\/download\/clip\/[^)]+\)\. Trying again in 3 s\./.test(l)));
  // a server that keeps failing: 4 retries, then the song fails with the reason
  const b = fakeSuno([clip(1)]);
  await b.engine.load(PL);
  b.fs.fetchHook = () => Promise.resolve({ status: 500 });
  const t1 = Date.now();
  await b.engine.start(settings());
  assert.equal(b.fs.fetched.length, 5);
  assert(Date.now() - t1 >= 2000 + 5000 + 15000 + 30000);
  assert.deepEqual(statuses(b.engine), [`failed: HTTP 500 from suno-data-uploads.s3.amazonaws.com`]);
});

test('engine: a 401 gets one fresh sign-in token; a lasting 401 says how to sign in again', async () => {
  const { fs, engine } = fakeSuno([clip(1)]);
  let refused = 0;
  fs.apiHook = (method, path, o) => (/\/api\/playlist\//.test(path) && !o.fresh && refused++ < 1 ? { status: 401, data: null } : null);
  assert.equal(await engine.load(PL), true);
  assert.deepEqual(fs.fresh, [`/api/playlist/${PL}/?page=1`]);
  const b = fakeSuno([clip(1)]);
  b.fs.apiHook = () => ({ status: 401, data: { detail: 'Unauthorized' } });
  assert.equal(await b.engine.load(PL), false);
  assert.equal(b.engine.state.phase, 'error');
  assert.equal(b.engine.state.message, 'Suno did not accept your sign-in (HTTP 401). Make sure you are signed in, then click something on ' +
    'suno.com in this tab (for example Library, then Back to this playlist): the panel tries again when the page talks to Suno. Or press Reload.');
  assert.equal(b.engine.state.waitingSignin, true, 'the page part loads again when the page shows a sign-in');
  assert.equal(b.engine.state.tone, 'warn');
  // no sign-in found on the page at all (the page part answers 401 with noSignin): the panel waits for one
  b.fs.apiHook = () => ({ status: 401, data: { detail: 'no sign-in found on the page' }, noSignin: true });
  assert.equal(await b.engine.load(PL), false);
  assert.match(b.engine.state.message, /^Waiting for your sign-in\. Make sure you are signed in on suno\.com, then click something on suno\.com in this tab \(for example Library, then Back to this playlist\): the panel reads the playlist as soon as the page talks to Suno\.$/);
  assert.equal(b.engine.state.waitingSignin, true);
  b.fs.apiHook = null;
  assert.equal(await b.engine.load(PL), true);
  assert.equal(b.engine.state.waitingSignin, false, 'a good load ends the wait');
  // during a run: the unlock is refused twice -> paused with the sign-in message
  const c = fakeSuno([clip(1)]);
  await c.engine.load(PL);
  c.fs.apiHook = (method, path) => (/authorize/.test(path) ? { status: 401, data: null } : null);
  const run = c.engine.start(settings());
  assert(await until(() => c.engine.state.phase === 'paused'));
  assert.equal(c.engine.state.pauseReason, 'signin');
  c.engine.stop();
  await run;
  assert.deepEqual(statuses(c.engine), ['waiting: stopped']);
});

test('engine: Retry failed re-runs only the failed songs; a row\'s Retry only that song', async () => {
  const { fs, engine } = fakeSuno([clip(1), clip(2), clip(3)]);
  await engine.load(PL);
  let broken = true;
  fs.fetchHook = (url) => (broken && url.includes(cid(2)) ? Promise.resolve({ status: 404 }) : null);
  await engine.start(settings());
  assert.deepEqual(statuses(engine), ['saved', 'failed: HTTP 404 from suno-data-uploads.s3.amazonaws.com', 'saved']);
  assert.equal(engine.state.message, 'Saved 2 songs, 1 failed, 0 skipped.');
  broken = false;
  const before = fs.fetched.length, unlocks = fs.authorized.length;
  await engine.retryFailed(settings());
  assert.deepEqual(fs.fetched.slice(before), [`${S3}/${cid(2)}.mp3?X-Amz-Signature=abc`], 'only song 2');
  assert.equal(fs.authorized.length, unlocks, 'song 2 was unlocked before: not again');
  assert.deepEqual(statuses(engine), ['saved', 'saved', 'saved']);
  assert.equal(engine.state.run.todo, 1);
  assert.equal(engine.state.message, 'Saved 3 songs, 0 failed, 0 skipped.');
  await engine.retryFailed(settings());
  assert.equal(engine.state.run.todo, 1, 'nothing failed: no new run');
  // a row's Retry
  const b = fakeSuno([clip(1), clip(2)]);
  await b.engine.load(PL);
  b.fs.fetchHook = (url) => (url.startsWith(S3) ? Promise.resolve({ status: 404 }) : null);
  await b.engine.start(settings());
  b.fs.fetchHook = null;
  await b.engine.retrySong(2, settings());
  assert.deepEqual(statuses(b.engine).map((s) => s.split(':')[0]), ['failed', 'saved']);
});

test('engine: "Skip songs saved before" skips recorded songs and files already in the folder; Forget saved progress', async () => {
  const { fs, engine } = fakeSuno([clip(1), clip(2), clip(3)], { exists: (name) => name === '03 - Song 3 [33333333].mp3' });
  fs.store.set(S.KEY.done(PL), JSON.stringify({ v: 1, files: { [cid(1)]: ['mp3'] } }));
  await engine.load(PL);
  assert.equal(engine.savedBefore(['mp3']), 1);
  assert.equal(engine.savedBefore(['mp3', 'wav']), 0);
  await engine.start(settings());
  assert.deepEqual(statuses(engine), ['skipped: saved before', 'saved', 'skipped: saved before']);
  assert.deepEqual(fs.saved, ['02 - Song 2 [22222222].mp3']);
  assert.deepEqual(fs.authorized, [cid(2)], 'no download counted for songs saved before');
  assert.equal(engine.state.message, 'Saved 1 song, 0 failed, 2 skipped.');
  assert.deepEqual(JSON.parse(fs.store.get(S.KEY.done(PL))).files, { [cid(1)]: ['mp3'], [cid(3)]: ['mp3'], [cid(2)]: ['mp3'] });
  // turned off: everything again
  await engine.start(settings({ skipSaved: false }));
  assert.deepEqual(statuses(engine), ['saved', 'saved', 'saved']);
  // forget
  engine.forgetSaved();
  assert.equal(fs.store.has(S.KEY.done(PL)), false);
  assert.equal(engine.savedBefore(['mp3']), 0);
});

test('engine: WAV through convert_wav (unlock first when Suno answers 403), lyrics, metadata, cover, and what is missing', async () => {
  const songs = [clip(1, { metadata: { prompt: '[Verse]\nhello' } }), clip(2, { image_url: null })];
  const { fs, engine } = fakeSuno(songs);
  await engine.load(PL);
  const locked = new Set([cid(2)]);
  fs.apiHook = (method, path) => {
    const m = /^\/api\/gen\/([^/]+)\/convert_wav\/$/.exec(path);
    if (!m || !locked.has(m[1])) return null;
    if (!fs.authorized.includes(m[1])) return { status: 403, data: { detail: 'locked' } };
    locked.delete(m[1]);
    return null;
  };
  await engine.start(settings({ formats: ['wav', 'cover', 'lyrics', 'json'] }));
  assert.deepEqual(fs.saved, ['01 - Song 1 [11111111].wav', '01 - Song 1 [11111111].jpeg', '01 - Song 1 [11111111].txt',
    '01 - Song 1 [11111111].json', '02 - Song 2 [22222222].wav', '02 - Song 2 [22222222].json']);
  assert.deepEqual(fs.authorized, [cid(2)], 'song 2 answered 403: unlocked, then converted');
  assert.equal(fs.calls.filter((c) => c === `POST /api/gen/${cid(2)}/convert_wav/`).length, 2);
  assert.deepEqual(statuses(engine), ['saved', 'saved: no cover image, no lyrics']);
  assert.match(fs.lastText, /^\{\n {2}"id": "22222222-/, 'the metadata is the clip as JSON');
  // WAV refused for the plan: skipped (not failed) for every song after the first refusal
  const b = fakeSuno([clip(1), clip(2)]);
  await b.engine.load(PL);
  b.fs.apiHook = (method, path) => (/convert_wav/.test(path) ? { status: 403, data: { detail: 'Upgrade to Pro' } } : null);
  await b.engine.start(settings({ formats: ['mp3', 'wav'] }));
  assert.deepEqual(statuses(b.engine), ['saved: no WAV (Suno refused: Pro or Premier only)', 'saved: no WAV (Suno makes WAV files on Pro and Premier only)']);
  assert.equal(b.fs.calls.filter((c) => /convert_wav/.test(c)).length, 1, 'asked once');
  // WAV with Suno's own Download turned off
  const c = fakeSuno([clip(1)]);
  await c.engine.load(PL);
  await c.engine.start(settings({ formats: ['wav'], useChannel: false }));
  assert.deepEqual(statuses(c.engine), ['failed: WAV comes only through Suno\'s own Download; turn it on']);
  assert.deepEqual(c.fs.authorized, []);
});

test('engine: no playlist, a missing playlist, an unknown account, a refused address, a web page instead of a file', async () => {
  const a = fakeSuno([clip(1)]);
  assert.equal(await a.engine.load(null), false);
  assert.equal(a.engine.state.phase, 'error');
  assert.match(a.engine.state.message, /^Open one of your playlists on suno\.com first \(its address contains \/playlist\/\)/);
  assert.equal(await a.engine.load('99999999-9999-4999-8999-999999999999'), false);
  assert.match(a.engine.state.message, /did not find this playlist \(HTTP 404\)/);
  const b = fakeSuno([clip(1)]);
  b.fs.apiHook = (method, path) => (/feed/.test(path) ? { status: 200, data: { clips: [] } } : null);
  assert.equal(await b.engine.load(PL), false);
  assert.match(b.engine.state.message, /Could not tell which account is signed in/);
  const c = fakeSuno([clip(1, { image_url: 'https://evil.example/x.jpeg' }), clip(2)]);
  await c.engine.load(PL);
  c.fs.fetchHook = (url) => (url.startsWith(S3) && url.includes(cid(2)) ? Promise.resolve(okFile('text/html; charset=utf-8', [0x3c])) : null);
  await c.engine.start(settings({ formats: ['cover', 'mp3'] }));
  assert.deepEqual(statuses(c.engine), ['failed: COVER: refused to download from evil.example (not a Suno address)',
    'failed: MP3: Suno sent a web page instead of the MP3 file']);
  assert(!c.fs.fetched.some((u) => u.includes('evil.example')), 'never fetched');
});

test('engine: progress, time left and counters while running', async () => {
  const { fs, engine } = fakeSuno([clip(1), clip(2), clip(3), clip(4)]);
  await engine.load(PL);
  const seen = [];
  engine.on((st) => { if (st.run && st.run.current) seen.push([st.run.index, st.run.current.format, st.run.current.bytes, st.run.current.total]); });
  let eta = null;
  fs.fetchHook = (url) => { if (url.includes(cid(3)) && url.startsWith(S3)) eta = engine.etaMs(); return null; };
  await engine.start(settings());
  assert(seen.some(([i, f, b, t]) => i === 2 && f === 'mp3' && b === 1500 && t === 3000), 'bytes of the current file');
  assert(eta > 0, 'a time estimate once songs are finished');
  assert.deepEqual([engine.state.run.done, engine.state.run.todo, engine.state.run.worked], [4, 4, 4]);
  assert.equal(engine.etaMs(), null, 'nothing left');
  assert(engine.state.log.length > 5 && engine.state.logSeq >= engine.state.log.length);
});

test('engine: Stop pressed while Suno is still answering the unlock wins over its "no downloads left" or sign-in answer', async () => {
  for (const answer of [{ status: 402, data: { detail: 'No downloads left' } }, { status: 401, data: null }]) {
    const { fs, engine } = fakeSuno([clip(1), clip(2)]);
    await engine.load(PL);
    fs.apiHook = (method, path) => (path === '/api/download/authorize'
      ? new Promise((resolve) => { setTimeout(() => engine.stop(), 10); setTimeout(() => resolve(answer), 50); }) : null);
    const run = engine.start(settings());
    assert(await until(() => engine.state.phase === 'done' || engine.state.phase === 'paused', 5 * 60 * 1000));
    assert.equal(engine.state.phase, 'done', `HTTP ${answer.status}: stopped, not paused`);
    await run;
    assert.equal(engine.state.run.stopped, true);
    assert.equal(engine.state.pauseReason, '');
    assert.deepEqual(statuses(engine), ['waiting: stopped', 'waiting']);
    assert.equal(engine.state.message, 'Stopped. Saved 0 songs, 0 failed, 0 skipped.');
    assert(!fs.calls.some((c) => c.includes(cid(2))), 'nothing for song 2');
  }
});

test('engine: a save error about the folder or the disk pauses the run (no more downloads spent); Resume saves under the same name', async () => {
  for (const name of ['NotFoundError', 'NotAllowedError', 'QuotaExceededError']) {
    const { fs, io, engine } = fakeSuno([clip(1), clip(2)]);
    await engine.load(PL);
    const save = io.save;
    let fails = 1;
    io.save = async (file, data) => {
      if (fails-- > 0) throw Object.assign(new Error('A requested file or directory could not be found.'), { name });
      return save(file, data);
    };
    const run = engine.start(settings());
    assert(await until(() => engine.state.phase === 'paused'), name);
    assert.equal(engine.state.pauseReason, 'save');
    assert.equal(engine.state.tone, 'warn');
    assert.equal(engine.state.message, 'Could not save "01 - Song 1 [11111111].mp3" (A requested file or directory could not be found). ' +
      'Check the folder and the free disk space, then press Resume, or Stop.');
    await new Promise((r) => setTimeout(r, 60000));
    assert.deepEqual(fs.authorized, [cid(1)], 'song 2 is not unlocked while paused');
    engine.resume();
    await run;
    assert.deepEqual(fs.saved, ['01 - Song 1 [11111111].mp3', '02 - Song 2 [22222222].mp3'], 'the same name again, not "(2)"');
    assert.deepEqual(fs.authorized, [cid(1), cid(2)], 'song 1 was unlocked once');
    assert.deepEqual(statuses(engine), ['saved', 'saved']);
    assert.deepEqual(Object.keys(JSON.parse(fs.store.get(S.KEY.done(PL))).files), [cid(1), cid(2)], 'recorded only once saved');
  }
  // any other save error fails that file only, and the run goes on
  const b = fakeSuno([clip(1), clip(2)]);
  await b.engine.load(PL);
  const save = b.io.save;
  let once = 1;
  b.io.save = async (file, data) => { if (once-- > 0) throw new TypeError('Name is not allowed.'); return save(file, data); };
  await b.engine.start(settings());
  assert.deepEqual(statuses(b.engine), ['failed: could not save the file (Name is not allowed)', 'saved']);
  assert.deepEqual(Object.keys(JSON.parse(b.fs.store.get(S.KEY.done(PL))).files), [cid(2)], 'the failed file is not in the resume record');
});

test('engine: a playlist page that cannot be read says the list is incomplete; a 404 after the last page is just the end', async () => {
  const a = fakeSuno([1, 2, 3, 4, 5].map((n) => clip(n)));
  a.fs.apiHook = (method, path) => (/\/api\/playlist\/[^?]+\?page=2$/.test(path) ? { status: 500, data: null } : null);
  assert.equal(await a.engine.load(PL), true);
  assert.equal(a.engine.state.songs.length, 3);
  assert.equal(a.engine.state.phase, 'ready');
  assert.equal(a.engine.state.tone, 'warn');
  assert.equal(a.engine.state.message, 'Could not read all of the playlist (HTTP 500 on page 2): only the first 3 songs are listed. Press Reload to try again.');
  assert(a.engine.state.log.some((l) => /Could not read all of the playlist/.test(l)));
  const b = fakeSuno([1, 2, 3].map((n) => clip(n)));
  b.fs.apiHook = (method, path) => {
    const m = /^\/api\/playlist\/[^?]+\?page=(\d+)$/.exec(path);
    if (!m) return null;
    return m[1] === '1' ? { status: 200, data: { name: 'Mix', playlist_clips: b.fs.clips.map((c) => ({ clip: c })) } } : { status: 404, data: null };
  };
  assert.equal(await b.engine.load(PL), true);
  assert.deepEqual([b.engine.state.songs.length, b.engine.state.message, b.engine.state.tone], [3, '', ''], 'no total from Suno: a 404 is the end');
});

test('engine: after destroy nothing more is sent to Suno', async () => {
  const { fs, engine } = fakeSuno([1, 2, 3, 4, 5, 6, 7].map((n) => clip(n)));
  fs.apiHook = (method, path) => { if (/\?page=1$/.test(path) && path.startsWith('/api/playlist/')) engine.destroy(); return null; };
  assert.equal(await engine.load(PL), false);
  await new Promise((r) => setTimeout(r, 60000));
  assert.deepEqual(fs.calls.filter((c) => !/feed/.test(c)), [`GET /api/playlist/${PL}/?page=1`], 'no page 2, no billing');
  // during a run, waiting out a 429: destroy ends the wait and nothing follows
  const b = fakeSuno([clip(1), clip(2)]);
  await b.engine.load(PL);
  b.fs.apiHook = (method, path) => (/download\/clip/.test(path) ? { status: 429, data: null, retryAfter: '120' } : null);
  const run = b.engine.start(settings());
  assert(await until(() => b.fs.calls.some((c) => /download\/clip/.test(c))));
  const calls = b.fs.calls.length;
  b.engine.destroy();
  await run;
  await new Promise((r) => setTimeout(r, 10 * 60000));
  assert.equal(b.fs.calls.length, calls);
  assert.deepEqual(b.fs.saved, []);
});

// ------------------------------------------------------------------------------------------------- house rules

test('house rules hold in the source: no innerHTML, no new tabs, only the known storage keys, classic script', async () => {
  const src = await (await fetch(SCRIPT)).text();
  assert.match(src, /^\/\*\n \* Suno Playlist Downloader 2 /);
  for (const bad of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /window\.open\(|\bW\.open\(/, /_blank/,
    /\beval\(/, /new Function\(/, /^\s*(import|export)\s/m, /^await\s/m]) assert(!bad.test(src), `the script must not use ${bad}`);
  const keys = [...src.matchAll(/'(suno-dl\.[a-z.]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(keys)].sort(), ['suno-dl.done.', 'suno-dl.pos', 'suno-dl.settings']);
  assert.equal((src.match(/localStorage\.setItem/g) || []).length, 1, 'one place writes storage (store.set)');
  assert.match(src, /window\.__sunoPlaylistDl\?\.destroy\(\)|W\.__sunoPlaylistDl\.destroy\(\)/, 'a new paste closes the old panel');
  assert.match(src, /credentials: 'omit'/, 'files are fetched without cookies');
  assert(src.split('\n').length < 1300, 'a small script (the VineTrip autopilot it is modelled on has about 2500 lines)');
});
