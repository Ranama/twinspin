/*
 * Suno Playlist Downloader 2 (version 2.0.0, 2026-10-16)                   TwinSpin extras/suno-playlist-downloader.js
 * Saves the songs you made in a suno.com playlist to your computer, with a panel you can pause, minimise and close.
 *
 * HOW TO RUN: on a computer, open suno.com in Chrome, Edge or Firefox, sign in and open one of your playlists (its
 * address contains /playlist/). Open the console (Ctrl+Shift+J in Chrome or Edge, Ctrl+Shift+K in Firefox; on a Mac
 * Cmd+Option+J or Cmd+Option+K; the first time you may have to type  allow pasting), paste this script, press Enter.
 * A panel appears. Nothing is downloaded before you click Start.
 *
 * WHAT IT DOES: it reads the playlist the way suno.com does and saves every finished song made by the signed-in
 * account: MP3 (default) and, if ticked, WAV, MP4 video, cover image, lyrics (.txt) and metadata (.json), named like
 * "07 - Title [1a2b3c4d].mp3". Chrome and Edge can save into a folder you pick (a subfolder named after the playlist,
 * no "allow multiple downloads" prompt); otherwise the files go to Downloads. Pause, Resume, Stop, Retry failed,
 * minimise to a progress pill. Close it or reload the page at any time: pasted again, it skips what it saved.
 * MP3 comes from the song's own file address while Suno still hands one out. Since late August 2026 Suno blocks most
 * of those; then (if you allow it) the script uses Suno's own Download, which counts once per song toward your plan's
 * downloads, whatever the formats. WAV always comes through Suno's own Download.
 *
 * HOUSE RULES (never change these)
 *  - Only songs made by the signed-in account are downloaded. Songs by others ("not yours") and songs whose status is
 *    not "complete" ("not finished") are listed and skipped.
 *  - It talks only to Suno: its API (studio-api.prod.suno.com, studio-api-prod.suno.com), its media hosts (*.suno.ai,
 *    *.suno.com) and the signed links Suno hands out (suno-data-uploads.s3.amazonaws.com). Every address is checked
 *    against that list before it is fetched, and again where a redirect ended; anything else is refused with a message.
 *  - The sign-in token comes from the page: window.Clerk.session.getToken(), else the __session cookie, else the
 *    sign-in header of the page's own requests to Suno's API (read-only, removed on close; with none yet, the panel
 *    waits and reads the playlist once the page talks to Suno). It stays in memory and goes only to Suno's API.
 *    localStorage holds no token, cookie or song data, only "suno-dl.done.<playlist id>" (which songs were saved),
 *    "suno-dl.pos" (panel position) and "suno-dl.settings".
 *  - It never opens tabs: a file is saved, or the song is marked failed with a reason. It never buys anything: when
 *    Suno says there are no downloads left, or a file cannot be saved into the folder, the run pauses and says so. One
 *    file at a time, a short pause between files, and it backs off when Suno says "too many requests".
 *  - The panel is built with createElement/textContent only (no innerHTML: song titles are untrusted text).
 *  - Pasting the script again closes the old panel and stops its run.
 * Not made by Suno. Suno's terms do not allow bots, scraping or downloading in ways Suno did not make for that: use it
 * at your own risk. Tests: tests/suno-downloader.test.js (with globalThis.__SUNO_PLAYLIST_TEST__ === true the script
 * touches no page and only exposes its helpers and run engine on globalThis.__SUNO_PLAYLIST__).
 */
(function () {
  'use strict';

  const VERSION = '2.0.0';
  const TEST = typeof globalThis === 'object' && globalThis.__SUNO_PLAYLIST_TEST__ === true;
  const TAG = '[suno-dl]';

  // ============================================================================================ 1. pure helpers
  const FORMATS = [
    { id: 'mp3', label: 'MP3 audio', ext: 'mp3' }, { id: 'wav', label: 'WAV (Pro/Premier)', ext: 'wav' },
    { id: 'mp4', label: 'MP4 video', ext: 'mp4' }, { id: 'cover', label: 'Cover image', ext: 'jpeg' },
    { id: 'lyrics', label: 'Lyrics (.txt)', ext: 'txt' }, { id: 'json', label: 'Metadata (.json)', ext: 'json' },
  ];
  const FORMAT_IDS = FORMATS.map((f) => f.id);
  const KEY = { pos: 'suno-dl.pos', settings: 'suno-dl.settings', done: (id) => 'suno-dl.done.' + id };
  const API_BASES = ['https://studio-api.prod.suno.com', 'https://studio-api-prod.suno.com'];
  const BACKOFF_MS = [2000, 5000, 15000, 30000]; // network errors, 5xx and 429: up to 4 retries
  const MAX_RETRY_AFTER_MS = 300000, RATE_LIMITED_WAIT_MS = 10000, POLL_MS = 2500, PREPARE_TIMEOUT_MS = 240000;

  const lower = (s) => String(s == null ? '' : s).toLowerCase();
  const isObj = (v) => !!v && typeof v === 'object';
  const parseUrl = (url) => { try { return new URL(String(url)); } catch (e) { return null; } };
  const hostOf = (url) => { const u = parseUrl(url); return u ? u.hostname : 'a bad address'; };

  // Hosts the script may fetch from (https only). Suno's player stream host (on cloudfront.net) is left out on purpose:
  // that stream is protected and never needed. S3's own part of a host is spelled out (s3, accelerate, dualstack, a
  // region like us-west-2), so another bucket (say one named "s3-x": s3-x.s3.amazonaws.com) never passes as Suno's.
  const S3 = 's3(?:-accelerate)?(?:\\.dualstack)?(?:[.-][a-z]{2}(?:-gov)?-[a-z]+-\\d+)?\\.amazonaws\\.com';
  const ALLOWED_HOSTS = [/^(?:[a-z0-9-]+\.)*suno\.com$/, /^(?:[a-z0-9-]+\.)*suno\.ai$/, new RegExp('^suno-data-uploads\\.' + S3 + '$')];
  const S3_PATH_STYLE = new RegExp('^' + S3 + '$');
  /** May the script fetch this address? https, no login or port in it, a Suno host or Suno's download bucket. */
  function isAllowedUrl(url) {
    const u = parseUrl(url);
    if (!u || u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    const host = lower(u.hostname);
    if (ALLOWED_HOSTS.some((re) => re.test(host))) return true;
    // the same bucket addressed path-style: https://s3.<region>.amazonaws.com/suno-data-uploads/...
    return S3_PATH_STYLE.test(host) && u.pathname.indexOf('/suno-data-uploads/') === 0;
  }
  /** Only Suno's own API (https *.suno.com/api/...) ever gets the sign-in token. */
  const isApiUrl = (url) => isAllowedUrl(url) && /(^|\.)suno\.com$/.test(lower(parseUrl(url).hostname)) && parseUrl(url).pathname.indexOf('/api/') === 0;
  /** The song's own MP3 address, when Suno still hands out a real file (not /api/forbidden, not an API path). */
  function directAudioUrl(clip) {
    const url = isObj(clip) && typeof clip.audio_url === 'string' ? clip.audio_url : '';
    return url && isAllowedUrl(url) && !/\/api\/|forbidden/i.test(parseUrl(url).pathname) ? url : null;
  }

  // ---- file names
  /** A title that is safe as a file name on Windows, macOS and Linux. */
  function safeName(s, max) {
    let t = String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_').trim();
    t = Array.from(t.replace(/^[.\s]+/, '')).slice(0, max || 100).join('').replace(/[.\s]+$/, ''); // (never half an emoji)
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(t)) t = '_' + t;
    return t || 'untitled';
  }
  /** "07 - " for song 7 of 40: at least two digits, more when the playlist is longer. */
  const numberPrefix = (pos, total) => String(pos).padStart(Math.max(2, String(total || pos).length), '0') + ' - ';
  /** "07 - Title [1a2b3c4d]" (no extension). */
  const baseName = (clip, pos, total, numbered) => (numbered ? numberPrefix(pos, total) : '') + safeName(clip.title) + ' [' + String(clip.id).slice(0, 8) + ']';
  /** The name, or "name (2).ext", "name (3).ext"... when this run already used it (case-insensitive, like Windows). */
  function uniqueName(name, taken) {
    const dot = name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    let out = name;
    for (let n = 2; taken.has(lower(out)); n++) out = stem + ' (' + n + ')' + ext;
    taken.add(lower(out));
    return out;
  }
  /** The kind of file from its first bytes: 'wav', 'webp', 'mp3', 'mp4', 'jpeg', 'png' or ''. */
  function sniff(head) {
    const b = head || [];
    const s = (i, n) => { let r = ''; for (let k = i; k < i + n && k < b.length; k++) r += String.fromCharCode(b[k]); return r; };
    if (s(0, 4) === 'RIFF') return s(8, 4) === 'WAVE' ? 'wav' : s(8, 4) === 'WEBP' ? 'webp' : '';
    if (s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
    if (s(4, 4) === 'ftyp') return 'mp4';
    if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
    return s(1, 3) === 'PNG' ? 'png' : '';
  }
  const TYPE_EXT = {
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav',
    'video/mp4': 'mp4', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp',
  };
  /** The extension of a file: from a clear content type, else from its first bytes, else the format's own. */
  function fileExt(format, contentType, head) {
    const f = FORMATS.find((x) => x.id === format);
    if (!f) return 'bin';
    if (format === 'lyrics' || format === 'json') return f.ext;
    const byType = TYPE_EXT[lower(contentType).split(';')[0].trim()];
    if (byType) return byType;
    const kind = sniff(head);
    return kind === 'mp4' && format !== 'mp4' ? 'm4a' : kind || f.ext;
  }
  /** The extensions a format may have on disk (for "saved before" in a folder). */
  const extsOf = (format) => (format === 'cover' ? ['jpeg', 'jpg', 'png', 'webp'] : [FORMATS.find((f) => f.id === format).ext]);

  // ---- time, size, retries
  const fmtSize = (n) => (!(n >= 0) ? '' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
  /** Time left from the work time so far and the songs that took work: null until one song is finished. */
  const estimateMs = (workMs, worked, left) => (worked > 0 && left > 0 ? (workMs / worked) * left : null);
  function fmtEta(ms) {
    if (ms == null || !(ms >= 0)) return '';
    if (ms < 45000) return 'less than a minute left';
    const min = Math.round(ms / 60000);
    return min < 60 ? 'about ' + min + ' min left' : 'about ' + Math.floor(min / 60) + ' h' + (min % 60 ? ' ' + (min % 60) + ' min' : '') + ' left';
  }
  /** A Retry-After header (seconds or an HTTP date) in ms, or null. */
  function parseRetryAfter(value, now) {
    const s = String(value == null ? '' : value).trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 1000);
    const t = Date.parse(s);
    return Number.isFinite(t) ? Math.max(0, t - now) : null;
  }
  /** The wait before retry attempt+1: Retry-After when Suno sends one (1 s to 5 min), else 2, 5, 15, 30 s. */
  function backoffMs(attempt, retryAfter, now) {
    const ra = parseRetryAfter(retryAfter, now);
    return ra != null ? Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, ra)) : BACKOFF_MS[Math.min(Math.max(0, attempt), BACKOFF_MS.length - 1)];
  }
  const isRetryable = (status) => status === 0 || status === 408 || status === 429 || (status >= 500 && status <= 599);

  // ---- Suno's answers (field names vary between sources: read them defensively)
  const toNum = (v) => { const n = typeof v === 'string' && v.trim() ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? n : null; };
  /** The first number among keys matching names (case, _ and - ignored). */
  function pick(obj, names) {
    if (!isObj(obj)) return null;
    for (const k of Object.keys(obj)) if (names.indexOf(lower(k).replace(/[_-]/g, '')) >= 0 && toNum(obj[k]) != null) return toNum(obj[k]);
    return null;
  }
  /** Downloads left this period from /api/billing/info/: {left, limit, used, extra}, or null when unknown. */
  function parseBilling(body) {
    for (const b of [body, isObj(body) ? body.data : null]) {
      if (!isObj(b)) continue;
      const du = [b.download_usage, b.downloadUsage].find(isObj), at = du || b; // plain names only count inside download_usage
      const limit = pick(at, ['currentperioddownloadslimit', 'downloadslimit'].concat(du ? ['limit'] : []));
      const used = pick(at, ['currentperioddownloadsused', 'downloadsused'].concat(du ? ['used'] : []));
      const extra = pick(at, ['additionaldownloadremaining', 'additionaldownloadsremaining']);
      const rest = pick(at, ['downloadsremaining', 'remainingdownloads', 'downloadsleft'].concat(du ? ['remaining', 'left'] : []));
      const left = limit != null && used != null ? Math.max(0, limit - used) + (extra || 0) : rest != null ? Math.max(0, rest) + (extra || 0) : extra;
      if (left != null) return { left, limit, used, extra };
    }
    return null;
  }
  /** 'mine' | 'others' | 'unfinished' | 'bad' (no id). Without a known user id nothing counts as yours. */
  function classifyClip(clip, myId) {
    if (!isObj(clip) || typeof clip.id !== 'string' || !clip.id) return 'bad';
    if (!myId || clip.user_id !== myId) return 'others';
    return clip.status != null && lower(clip.status) !== 'complete' ? 'unfinished' : 'mine';
  }
  /** One page of GET /api/playlist/<id>/?page=N: {name, total, clips}. */
  function playlistPage(data) {
    const d = isObj(data) ? data : {};
    const raw = [d.playlist_clips, d.clips, d.results].find(Array.isArray) || [];
    const clips = raw.map((pc) => (isObj(pc) && isObj(pc.clip) ? pc.clip : pc)).filter((c) => isObj(c) && typeof c.id === 'string' && c.id);
    return { name: typeof d.name === 'string' && d.name.trim() ? d.name.trim() : null, total: toNum(d.num_total_results), clips };
  }
  /** The signed-in user's id from a feed answer (a list of their own songs). */
  function userIdFrom(data) {
    const list = Array.isArray(data) ? data : (isObj(data) && [data.clips, data.results, data.data].find(Array.isArray)) || [];
    const c = list.find((x) => isObj(x) && typeof x.user_id === 'string' && x.user_id);
    return c ? c.user_id : null;
  }
  /** The prepared file link in a download answer: wav_file_url, or download_url once ready. */
  function preparedUrl(data) {
    for (const b of [data, isObj(data) ? data.data : null]) {
      if (!isObj(b)) continue;
      if (typeof b.wav_file_url === 'string' && b.wav_file_url) return b.wav_file_url;
      if (typeof b.download_url === 'string' && b.download_url && (!b.status || lower(b.status) === 'ready')) return b.download_url;
    }
    return null;
  }
  const lyricsOf = (clip) => [isObj(clip.metadata) ? clip.metadata.prompt : '', clip.lyrics, clip.display_lyrics].find((v) => typeof v === 'string' && v.trim()) || '';
  const playlistIdFrom = (path) => {
    const m = /\/playlist\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(String(path || ''));
    return m ? m[1] : null;
  };

  // ---- the resume record: { v: 1, files: { '<clip id>': ['mp3', ...] } }, and the settings
  function resumeLoad(raw) {
    const files = {};
    if (isObj(raw) && raw.v === 1 && isObj(raw.files)) {
      for (const id of Object.keys(raw.files)) if (Array.isArray(raw.files[id])) files[id] = raw.files[id].filter((f) => FORMAT_IDS.indexOf(f) >= 0);
    }
    return { v: 1, files };
  }
  function resumeAdd(rec, clipId, format) {
    const r = resumeLoad(rec), list = r.files[clipId] || (r.files[clipId] = []);
    if (list.indexOf(format) < 0) list.push(format);
    return r;
  }
  const resumeHas = (rec, clipId, format) => !!(isObj(rec) && isObj(rec.files) && Array.isArray(rec.files[clipId]) && rec.files[clipId].indexOf(format) >= 0);
  /** Settings from storage or the panel, cleaned. 'folder' only where the browser can pick one. */
  function normSettings(raw, canPick) {
    const s = isObj(raw) ? raw : {};
    return {
      formats: Array.isArray(s.formats) ? FORMAT_IDS.filter((f) => s.formats.indexOf(f) >= 0) : ['mp3'], numbered: s.numbered !== false,
      saveTo: canPick && s.saveTo !== 'downloads' ? 'folder' : 'downloads', skipSaved: s.skipSaved !== false, useChannel: s.useChannel !== false,
    };
  }

  // ============================================================================================ 2. the run engine
  // A small state machine: idle -> loading -> ready (or error) -> running <-> pausing -> paused, -> stopping -> done.
  // Every page access goes through io: { api(path, {method, body, fresh}) -> {status, data, retryAfter},
  // fetchFile(url, {signal, onProgress}) -> {status, blob, type, size, head}, save(name, {blob | text, type}) -> {name},
  // exists(name)? (folder mode), sleep(ms), now(), storage {get, set, remove}, log(msg, level)? }.
  class Stop extends Error { constructor() { super('stopped'); this.name = 'Stop'; } }
  const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
  /** kind: 'fail' (this file failed), 'na' (not there for this song), 'quota' / 'signin' (the run pauses). */
  const fileError = (kind, message, status) => Object.assign(new Error(message), { kind, status: status || 0 });
  function makeCancel() {
    const fns = [];
    const c = {
      aborted: false,
      onAbort(fn) { if (c.aborted) fn(); else fns.push(fn); },
      abort() { if (!c.aborted) { c.aborted = true; for (const fn of fns.splice(0)) { try { fn(); } catch (e) { /* ignore */ } } } },
    };
    return c;
  }
  const ok = (r) => r.status >= 200 && r.status < 300;
  function httpReason(r) {
    if (!r.status) return 'no answer from Suno';
    const d = isObj(r.data) ? r.data.detail || r.data.message || r.data.error : null;
    return 'HTTP ' + r.status + (d ? ': ' + String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 120) : '');
  }
  // The sign-in: a page request (suno.com talking to Suno) shows the panel a fresh one. Opening Library and coming Back
  // to the playlist makes such requests and keeps the panel open (suno.com does not reload the page for that).
  const CLICK = 'click something on suno.com in this tab (for example Library, then Back to this playlist)';
  const SIGNIN = 'Suno did not accept your sign-in (HTTP 401); it may have run out. Make sure you are signed in, ' + CLICK +
    ' so the page renews it, then press Resume.';
  const SIGNIN_LOAD = 'Suno did not accept your sign-in (HTTP 401). Make sure you are signed in, then ' + CLICK +
    ': the panel tries again when the page talks to Suno. Or press Reload.';
  const NO_SIGNIN = 'Waiting for your sign-in. Make sure you are signed in on suno.com, then ' + CLICK +
    ': the panel reads the playlist as soon as the page talks to Suno.';
  const PAUSED_QUOTA = 'The run is paused: check your plan on suno.com, then press Resume, or Stop.';
  // a save error that is about the folder or the disk, not one file: the run pauses (no more downloads spent on files
  // that cannot be saved)
  const SAVE_STOPPERS = ['NotAllowedError', 'NotFoundError', 'InvalidStateError', 'SecurityError', 'QuotaExceededError', 'NoModificationAllowedError'];

  function createEngine(io) {
    const st = {
      phase: 'idle', message: '', tone: '', pauseReason: '', waitingSignin: false, playlist: null, songs: [], billing: null, run: null,
      counts: { saved: 0, skipped: 0, failed: 0 }, log: [], logSeq: 0,
    };
    const listeners = new Set(), wakers = new Set(), unlocked = new Set(); // unlocked: songs are never unlocked twice
    let waiters = [], destroyed = false, cancel = null, workStart = 0, record = resumeLoad(null), directBlocked = false, wavRefused = false;
    const now = () => io.now();
    const busy = () => ['loading', 'running', 'pausing', 'paused', 'stopping'].indexOf(st.phase) >= 0;
    const emit = () => { if (!destroyed) for (const fn of listeners) { try { fn(st); } catch (e) { /* never breaks a run */ } } };
    const two = (n) => String(n).padStart(2, '0');
    function log(msg, level) {
      const d = new Date(now());
      st.log.push(two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds()) + '  ' + msg);
      if (st.log.length > 500) st.log.shift();
      st.logSeq++;
      if (io.log) io.log(msg, level || 'info');
      emit();
    }
    const setPhase = (phase, message, tone) => { st.phase = phase; st.message = message || ''; st.tone = tone || ''; emit(); };
    const setNote = (text) => { const cur = st.run && st.run.current; if (cur && cur.note !== text) { cur.note = text; emit(); } };

    // ---- waiting that Pause and Stop cut short; checkpoints between steps
    const wait = (ms) => new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; wakers.delete(finish); resolve(); } };
      wakers.add(finish);
      Promise.resolve(io.sleep(ms)).then(finish, finish);
    });
    const wakeAll = () => Array.from(wakers).forEach((f) => f());
    const release = () => { const w = waiters; waiters = []; w.forEach((r) => r()); };
    const startWork = () => { workStart = now(); };
    const stopWork = () => { if (workStart && st.run) st.run.workMs += now() - workStart; workStart = 0; };
    const guard = (c) => { if (c && c.aborted) throw abortError(); };
    /** Throws Stop after Stop; waits while paused. */
    async function checkpoint() {
      for (;;) {
        if (destroyed || st.phase === 'stopping') throw new Stop();
        if (st.phase !== 'pausing' && st.phase !== 'paused') return;
        if (st.phase === 'pausing') { setPhase('paused', 'Paused. Press Resume to go on.', 'info'); log('Paused.'); }
        await new Promise((r) => waiters.push(r));
      }
    }
    function pauseFor(reason, message) {
      if (destroyed || st.phase === 'stopping') throw new Stop(); // Stop was pressed while Suno was still answering
      stopWork();
      st.pauseReason = reason;
      setPhase('paused', message, 'warn');
      log(message, 'warn');
    }

    // ---- Suno's API with retries (c: the current file's cancel token, or null for run-level calls)
    async function api(method, path, body, c) {
      let fresh = false, refreshed = false;
      for (let attempt = 0; ; attempt++) {
        if (destroyed) throw new Stop(); // a closed panel sends nothing more
        let r = null;
        try { r = await io.api(path, { method, body, fresh }); } catch (e) { /* a network error: status 0 */ }
        if (!isObj(r)) r = { status: 0, data: null };
        guard(c);
        if (r.status === 401 && !refreshed) { refreshed = true; fresh = true; attempt--; continue; } // once, with a fresh token
        fresh = false;
        if (!isRetryable(r.status) || attempt >= BACKOFF_MS.length) return r;
        const ms = backoffMs(attempt, r.retryAfter, now());
        log((r.status === 429 ? 'Suno says "too many requests"' : 'Suno: ' + httpReason(r)) + ' (' + path.split('?')[0] + '). Trying again in ' +
          Math.round(ms / 1000) + ' s.', 'warn');
        await wait(ms);
        guard(c);
        if (!c) await checkpoint();
      }
    }
    async function refreshBilling() {
      try {
        const r = await api('GET', '/api/billing/info/', undefined, null);
        if (ok(r)) { st.billing = parseBilling(r.data); emit(); }
      } catch (e) { /* the panel says "unknown" */ }
    }

    // ---- one file from an address (direct: the song's own MP3 address; a network error there is not retried)
    async function getFile(url, c, format, direct) {
      if (!isAllowedUrl(url)) throw fileError('fail', 'refused to download from ' + hostOf(url) + ' (not a Suno address)');
      for (let attempt = 0; ; attempt++) {
        const cur = Object.assign(st.run.current, { bytes: 0, total: 0, note: '' });
        let r = null;
        try { r = await io.fetchFile(url, { signal: c, onProgress: (bytes, total) => { cur.bytes = bytes; cur.total = total || 0; emit(); } }); }
        catch (e) { if (c.aborted || (e && e.name === 'AbortError')) throw abortError(); if (e && e.kind) throw e; } // (else: no answer)
        guard(c);
        if (!isObj(r)) r = { status: 0 };
        if (ok(r) && r.blob) {
          const page = /^(text\/|application\/(json|xml))/.test(lower(r.type));
          if (page) throw fileError('fail', 'Suno sent a web page instead of the ' + format.toUpperCase() + ' file');
          return r;
        }
        const status = r.status || 0;
        if (!isRetryable(status) || (direct && !status) || attempt >= BACKOFF_MS.length) {
          throw fileError('fail', (status ? 'HTTP ' + status : 'no answer (network error)') + ' from ' + hostOf(url), status);
        }
        const ms = backoffMs(attempt, r.retryAfter, now());
        log('The download from ' + hostOf(url) + ' answered ' + (status || 'nothing') + ': trying again in ' + Math.round(ms / 1000) + ' s.', 'warn');
        await wait(ms);
        guard(c);
      }
    }
    // ---- Suno's own Download. The "Unlock" counts 1 of the plan's downloads, once per song whatever the format. Its
    // answer is recorded before anything else, so a Pause right after it never unlocks the same song twice.
    async function authorize(clip) {
      if (unlocked.has(clip.id)) return;
      const r = await api('POST', '/api/download/authorize', { item_id: clip.id, item_type: 'clip' }, null);
      if (ok(r) || r.status === 404 || r.status === 405) { // 404/405: no unlock step (any more); the download link decides
        unlocked.add(clip.id);
        if (!ok(r)) return;
        const before = clip.is_download_unlocked === true;
        if (!before && st.billing && st.billing.left > 0) st.billing.left--;
        log('Unlocked "' + clip.title + '" with Suno\'s own Download' +
          (before ? ' (unlocked before: not counted again).' : ' (counts 1 of your plan\'s downloads).'));
        return;
      }
      if (r.status === 401) throw fileError('signin', SIGNIN, 401);
      if (r.status === 402 || r.status === 403) {
        throw fileError('quota', 'Suno refused to unlock the download (' + httpReason(r) + '). This usually means your plan has no downloads ' +
          'left this period. ' + PAUSED_QUOTA, r.status);
      }
      throw fileError('fail', 'Suno\'s Download would not unlock this song (' + httpReason(r) + ')', r.status);
    }
    async function prepareMp3(clip, c) {
      await authorize(clip);
      guard(c);
      const end = now() + PREPARE_TIMEOUT_MS;
      for (let missing = 0; ;) {
        const r = await api('GET', '/api/download/clip/' + encodeURIComponent(clip.id) + '?format=mp3', undefined, c);
        if (r.status === 401) throw fileError('signin', SIGNIN, 401);
        if (r.status === 402 || r.status === 403) { // not unlocked after all: Resume unlocks it again
          unlocked.delete(clip.id);
          throw fileError('quota', 'Suno\'s Download refused this song (' + httpReason(r) + '): maybe there are no downloads left this period. ' +
            PAUSED_QUOTA, r.status);
        }
        const url = ok(r) ? preparedUrl(r.data) : null;
        if (url) return url;
        const status = isObj(r.data) ? lower(r.data.status) : '';
        if (r.status === 404 && ++missing >= 5) throw fileError('fail', 'Suno\'s Download has no MP3 for this song (HTTP 404)', 404);
        if (!ok(r) && r.status !== 404) throw fileError('fail', 'Suno\'s Download failed (' + httpReason(r) + ')', r.status);
        if (status === 'error' || status === 'failed') throw fileError('fail', 'Suno could not prepare the MP3');
        if (now() > end) throw fileError('fail', 'Suno had not prepared the MP3 after 4 minutes');
        setNote(status === 'rate_limited' ? 'Suno is busy: waiting 10 s' : 'Suno is preparing the file');
        await wait(status === 'rate_limited' ? RATE_LIMITED_WAIT_MS : POLL_MS);
        guard(c);
      }
    }
    async function prepareWav(clip, c) {
      if (wavRefused) throw fileError('na', 'no WAV (Suno makes WAV files on Pro and Premier only)');
      const path = '/api/gen/' + encodeURIComponent(clip.id);
      let r = await api('POST', path + '/convert_wav/', undefined, c);
      if ((r.status === 402 || r.status === 403) && !unlocked.has(clip.id)) { // locked: unlock it, then ask again
        await authorize(clip);
        guard(c);
        r = await api('POST', path + '/convert_wav/', undefined, c);
      }
      if (r.status === 401) throw fileError('signin', SIGNIN, 401);
      if (r.status === 402 || r.status === 403) {
        wavRefused = true;
        log('Suno would not make a WAV (' + httpReason(r) + '). WAV needs Pro or Premier: WAV is skipped for the other songs.', 'warn');
        throw fileError('na', 'no WAV (Suno refused: Pro or Premier only)');
      }
      if (!ok(r) && r.status !== 409) throw fileError('fail', 'Suno could not start the WAV (' + httpReason(r) + ')', r.status);
      for (const end = now() + PREPARE_TIMEOUT_MS; ;) {
        const q = await api('GET', path + '/wav_file/', undefined, c);
        if (q.status === 401) throw fileError('signin', SIGNIN, 401);
        const url = ok(q) ? preparedUrl(q.data) : null;
        if (url) return url;
        if (!ok(q) && q.status !== 404) throw fileError('fail', 'Suno could not prepare the WAV (' + httpReason(q) + ')', q.status);
        if (now() > end) throw fileError('fail', 'Suno had not made the WAV after 4 minutes');
        setNote('Suno is making the WAV');
        await wait(3000);
        guard(c);
      }
    }
    /** The file of one format: {text, type}, or a fetched {blob, type, size, head}. */
    async function produce(song, format, c) {
      const clip = song.clip, useChannel = st.run.settings.useChannel;
      if (format === 'lyrics') {
        const t = lyricsOf(clip);
        if (!t) throw fileError('na', 'no lyrics');
        return { text: song.title + '\n\n' + t + '\n', type: 'text/plain;charset=utf-8' };
      }
      if (format === 'json') return { text: JSON.stringify(clip, null, 2) + '\n', type: 'application/json' };
      if (format === 'cover' || format === 'mp4') {
        const url = (format === 'cover' ? [clip.image_large_url, clip.image_url] : [clip.video_url]).find((u) => typeof u === 'string' && u);
        if (!url) throw fileError('na', format === 'cover' ? 'no cover image' : 'no video');
        return getFile(url, c, format, false);
      }
      if (format === 'wav') {
        if (!useChannel) throw fileError('fail', 'WAV comes only through Suno\'s own Download; turn it on');
        return getFile(await prepareWav(clip, c), c, format, false);
      }
      const direct = directAudioUrl(clip);
      if (direct && !directBlocked) {
        try { return await getFile(direct, c, format, true); } catch (e) {
          if (e.kind !== 'fail') throw e;
          if (e.status && e.status !== 401 && e.status !== 403) log('The direct MP3 file failed (' + e.message + ').', 'warn');
          else {
            directBlocked = true; // for the rest of this run, songs go straight to Suno's own Download
            log('Suno blocked the direct MP3 file (' + e.message + '). ' +
              (useChannel ? 'Using Suno\'s own Download from now on.' : 'Turn on "Use Suno\'s own Download" to get the MP3s.'), 'warn');
          }
        }
      }
      if (!useChannel) throw fileError('fail', 'Suno blocked the direct file; turn on Suno\'s own Download');
      return getFile(await prepareMp3(clip, c), c, format, false);
    }
    function remember(id, format) {
      record = resumeAdd(record, id, format);
      try { io.storage.set(KEY.done(st.playlist.id), record); } catch (e) { /* kept for this visit */ }
    }
    /** One format of one song: 'saved' | 'text' (saved, no network) | 'before'. Throws 'fail' / 'na' errors and Stop. */
    async function doFile(song, format) {
      const run = st.run, base = baseName(song.clip, song.pos, st.songs.length, run.settings.numbered);
      if (run.settings.skipSaved && resumeHas(record, song.id, format)) return 'before';
      if (run.settings.skipSaved && io.exists) {
        for (const ext of extsOf(format)) if (await io.exists(base + '.' + ext)) { remember(song.id, format); return 'before'; }
      }
      for (;;) {
        if (run.gap) { run.gap = false; await wait(400 + Math.floor(Math.random() * 400)); } // gentle between files
        await checkpoint();
        const c = (cancel = makeCancel());
        run.current = { pos: song.pos, title: song.title, format, bytes: 0, total: 0, note: '' };
        emit();
        try {
          const got = await produce(song, format, c), text = got.text != null;
          const name = uniqueName(base + '.' + (text ? fileExt(format) : fileExt(format, got.type, got.head)), run.taken);
          let saved;
          try { saved = await io.save(name, text ? { text: got.text, type: got.type } : { blob: got.blob, type: got.type }); } catch (e) {
            run.taken.delete(lower(name)); // the next try uses the same name
            const why = String((e && e.message) || e).replace(/\.\s*$/, '');
            throw SAVE_STOPPERS.indexOf(e && e.name) >= 0 ? fileError('save', 'Could not save "' + name + '" (' + why + '). Check the folder ' +
              'and the free disk space, then press Resume, or Stop.') : fileError('fail', 'could not save the file (' + why + ')');
          }
          remember(song.id, format);
          log('Saved ' + ((saved && saved.name) || name) + (got.size ? ' (' + fmtSize(got.size) + ')' : '') + '.');
          run.gap = !text;
          return text ? 'text' : 'saved';
        } catch (e) {
          if (e instanceof Stop) throw e;
          if (e && e.name === 'AbortError') { if (c.aborted) continue; throw fileError('fail', 'the download was cut off'); } // Pause: again
          if (e && (e.kind === 'quota' || e.kind === 'signin' || e.kind === 'save')) { // pause; Resume tries this file again
            if (e.kind === 'quota') refreshBilling();
            pauseFor(e.kind, e.message);
            continue;
          }
          throw e && e.kind ? e : fileError('fail', 'could not save the file (' + ((e && e.message) || e) + ')');
        } finally {
          if (cancel === c) cancel = null;
        }
      }
    }
    /** Every ticked format of one song. Returns true when it took network work (for the time estimate). */
    async function doSong(song) {
      const run = st.run, out = { saved: 0, before: 0, na: [], failed: '' };
      let worked = false;
      Object.assign(song, { status: 'working', note: '' });
      emit();
      try {
        for (const format of run.settings.formats) {
          if (song.files[format] === 'saved' || song.files[format] === 'before') { out.before++; continue; } // Retry: already done
          try {
            const r = await doFile(song, format);
            song.files[format] = r === 'before' ? 'before' : 'saved';
            if (r === 'before') out.before++;
            else { out.saved++; worked = worked || r === 'saved'; }
          } catch (e) {
            if (e instanceof Stop) throw e;
            if (e.kind === 'na') { song.files[format] = 'na'; out.na.push(e.message); log('"' + song.title + '": ' + e.message + '.'); continue; }
            song.files[format] = 'failed';
            worked = true;
            out.failed = out.failed || (run.settings.formats.length > 1 ? format.toUpperCase() + ': ' : '') + e.message;
            log('"' + song.title + '" ' + format.toUpperCase() + ' failed: ' + e.message + '.', 'warn');
          }
        }
      } catch (e) {
        Object.assign(song, { status: 'waiting', note: 'stopped' });
        throw e;
      }
      if (out.failed) Object.assign(song, { status: 'failed', note: out.failed });
      else if (out.saved) Object.assign(song, { status: 'saved', note: out.na.join(', ') });
      else Object.assign(song, { status: 'skipped', note: out.before ? 'saved before' : out.na.join(', ') || 'nothing to save' });
      return worked;
    }
    function tally() {
      const n = (s) => st.songs.filter((x) => x.status === s).length;
      st.counts = { saved: n('saved'), skipped: n('skipped'), failed: n('failed') };
    }
    async function run(list, settings, fresh) {
      if (busy() || destroyed || !st.playlist || !list.length) return;
      st.run = { settings, todo: list.length, done: 0, index: 0, worked: 0, workMs: 0, current: null, stopped: false, taken: new Set(), gap: false };
      for (const s of list) Object.assign(s, { status: 'waiting', note: '' }, fresh ? { files: {} } : {});
      directBlocked = false;
      st.pauseReason = '';
      tally();
      setPhase('running');
      startWork();
      log('Started: ' + list.length + ' song' + (list.length === 1 ? '' : 's') + ', ' + settings.formats.map((f) => f.toUpperCase()).join(' + ') + '.');
      try {
        for (let i = 0; i < list.length; i++) {
          await checkpoint();
          st.run.index = i + 1;
          if (await doSong(list[i])) st.run.worked++;
          st.run.done++;
          tally();
          emit();
        }
      } catch (e) {
        st.run.stopped = true;
        if (!(e instanceof Stop)) log('The run stopped because of an error: ' + ((e && e.message) || e), 'error');
      } finally {
        stopWork();
        st.run.current = null;
        tally();
        if (!destroyed) {
          const k = st.counts;
          const text = (st.run.stopped ? 'Stopped. ' : '') + 'Saved ' + k.saved + ' song' + (k.saved === 1 ? '' : 's') + ', ' +
            k.failed + ' failed, ' + k.skipped + ' skipped.';
          setPhase('done', text, k.failed || st.run.stopped ? 'warn' : 'ok');
          log(text);
          refreshBilling();
        }
      }
    }

    // ---- loading the playlist: who you are (a song of yours in your feed), then every page of the playlist
    /** The error for a 401 while loading: no sign-in found on the page yet, or one Suno refused. */
    const signinError = (r) => fileError('signin', r.noSignin ? NO_SIGNIN : SIGNIN_LOAD, 401);
    async function findMe() {
      let refused = null;
      for (const [method, path, body] of [['POST', '/api/feed/v3', { limit: 5 }], ['GET', '/api/feed/v2?page=0'], ['GET', '/api/feed/?page=0']]) {
        const r = await api(method, path, body, null);
        if (r.status === 401) refused = r;
        const id = ok(r) ? userIdFrom(r.data) : null;
        if (id) return id;
      }
      throw refused ? signinError(refused) : new Error('Could not tell which account is signed in (Suno showed no song of yours). Make sure ' +
        'you are signed in and have at least one song in your library, then press Reload.');
    }
    async function readPlaylist(id) {
      let name = null, total = null, partial = '';
      const clips = [], seen = new Set();
      for (let page = 1; page <= 200; page++) {
        const r = await api('GET', '/api/playlist/' + encodeURIComponent(id) + '/?page=' + page, undefined, null);
        if (r.status === 401) throw signinError(r);
        if (!ok(r) && page > 1) { // a 404 after the last page is the end, unless Suno said there are more songs
          if (total != null ? clips.length < total : r.status !== 404) {
            partial = 'Could not read all of the playlist (' + httpReason(r) + ' on page ' + page + '): only the first ' + clips.length +
              ' songs are listed. Press Reload to try again.';
          }
          break;
        }
        if (!ok(r)) {
          throw new Error(r.status === 404 ? 'Suno did not find this playlist (HTTP 404). Check that you can open it, then press Reload.'
            : 'Could not read the playlist (' + httpReason(r) + '). Press Reload to try again.');
        }
        const p = playlistPage(r.data);
        if (page === 1) { name = p.name; total = p.total; }
        if (!p.clips.length || p.clips.every((c) => seen.has(c.id))) break; // the end (or paging that repeats itself)
        for (const c of p.clips) { seen.add(c.id); clips.push(c); }
        if (total != null && clips.length >= total) break;
      }
      return { name: name || 'Suno playlist', clips, partial };
    }
    async function load(playlistId) {
      if (busy() || destroyed) return false;
      Object.assign(st, { playlist: null, songs: [], run: null, waitingSignin: false });
      if (!playlistId) {
        setPhase('error', 'Open one of your playlists on suno.com first (its address contains /playlist/), then press Reload.', 'warn');
        return false;
      }
      setPhase('loading', 'Reading the playlist…', 'info');
      try {
        const me = await findMe(), pl = await readPlaylist(playlistId), first = new Map();
        record = resumeLoad(io.storage.get(KEY.done(playlistId)));
        st.songs = pl.clips.map((clip, i) => {
          let kind = classifyClip(clip, me);
          if (kind === 'mine' && first.has(clip.id)) kind = 'dup';
          else if (kind === 'mine') first.set(clip.id, i + 1);
          const by = clip.handle || clip.display_name;
          const note = { others: 'not yours' + (by ? ' (@' + by + ')' : ''), unfinished: 'not finished' + (clip.status ? ' (' + clip.status + ')' : ''),
            dup: 'listed twice (same as #' + first.get(clip.id) + ')' }[kind] || '';
          const title = typeof clip.title === 'string' && clip.title.trim() ? clip.title.trim() : 'Untitled';
          const status = kind === 'mine' ? 'waiting' : 'skipped';
          return { pos: i + 1, id: clip.id, title, clip: Object.assign({}, clip, { title }), kind, status, note, files: {} };
        });
        st.playlist = { id: playlistId, name: pl.name };
        st.run = null;
        tally();
        await refreshBilling();
        const mine = st.songs.filter((s) => s.kind === 'mine').length;
        log('Playlist "' + pl.name + '": ' + st.songs.length + ' songs, ' + mine + ' yours.');
        if (pl.partial) log(pl.partial, 'warn');
        const none = mine ? '' : 'None of the finished songs in this playlist were made by you, so there is nothing to download.';
        setPhase('ready', [pl.partial, none].filter(Boolean).join('\n'), pl.partial || none ? 'warn' : '');
        return true;
      } catch (e) {
        if (e instanceof Stop) return false;
        st.waitingSignin = !!(e && e.kind === 'signin'); // the page part loads again when the page shows a sign-in
        setPhase('error', (e && e.message) || String(e), st.waitingSignin ? 'warn' : 'error');
        log(st.message, 'error');
        return false;
      }
    }
    const interrupt = () => { stopWork(); if (cancel) cancel.abort(); wakeAll(); };

    return {
      state: st,
      busy,
      on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      load,
      start: (settings) => run(st.songs.filter((s) => s.kind === 'mine'), settings, true),
      retryFailed: (settings) => run(st.songs.filter((s) => s.status === 'failed'), settings, false),
      retrySong: (pos, settings) => run(st.songs.filter((s) => s.pos === pos && s.status === 'failed'), settings, false),
      /** At once: waits and polling end at the next checkpoint; the file in flight is aborted and starts again on Resume. */
      pause() { if (st.phase === 'running') { st.pauseReason = 'user'; setPhase('pausing', 'Pausing…', 'info'); interrupt(); } },
      resume() { if (st.phase === 'paused' || st.phase === 'pausing') { st.pauseReason = ''; setPhase('running'); startWork(); log('Resumed.'); release(); } },
      stop() { if (['running', 'pausing', 'paused'].indexOf(st.phase) >= 0) { setPhase('stopping', 'Stopping…', 'info'); interrupt(); release(); } },
      forgetSaved() {
        if (busy() || !st.playlist) return;
        record = resumeLoad(null);
        try { io.storage.remove(KEY.done(st.playlist.id)); } catch (e) { /* nothing stored */ }
        for (const s of st.songs) if (s.kind === 'mine' && s.status === 'skipped') Object.assign(s, { status: 'waiting', note: '' });
        tally();
        log('Forgot which songs were saved before: Start saves them again.');
      },
      /** How many of your songs have every one of these formats in the resume record. */
      savedBefore: (formats) => st.songs.filter((s) => s.kind === 'mine' && formats.length && formats.every((f) => resumeHas(record, s.id, f))).length,
      etaMs: () => (st.run ? estimateMs(st.run.workMs + (workStart ? now() - workStart : 0), st.run.worked, st.run.todo - st.run.done) : null),
      destroy() { if (!destroyed) { destroyed = true; interrupt(); release(); listeners.clear(); } },
    };
  }

  if (TEST) {
    globalThis.__SUNO_PLAYLIST__ = {
      VERSION, FORMATS, KEY, API_BASES, BACKOFF_MS, isAllowedUrl, isApiUrl, directAudioUrl, safeName, numberPrefix, baseName, uniqueName, sniff,
      fileExt, extsOf, fmtSize, estimateMs, fmtEta, parseRetryAfter, backoffMs, isRetryable, parseBilling, classifyClip, playlistPage, userIdFrom,
      preparedUrl, lyricsOf, playlistIdFrom, resumeLoad, resumeAdd, resumeHas, normSettings, createEngine,
    };
    return;
  }

  // ============================================================================================ 3. the page
  const W = window, D = document;
  if (!/(^|\.)suno\.com$/i.test(location.hostname)) { console.warn(TAG, 'Open one of your playlists on suno.com (signed in) and paste the script there.'); return; }
  try { if (W.__sunoPlaylistDl && typeof W.__sunoPlaylistDl.destroy === 'function') W.__sunoPlaylistDl.destroy(); } catch (e) { /* an old copy */ }
  for (const id of ['suno-dl-host', 'suno-dl-panel']) { const old = D.getElementById(id); if (old) old.remove(); } // (suno-dl-panel: version 1)
  const store = {
    get(k) { try { const s = W.localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch (e) { return null; } },
    set(k, v) { try { W.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked: it lasts this visit */ } },
    remove(k) { try { W.localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  // ---- 3.1 sign-in. window.Clerk is gone from suno.com since Sep 2026, so the page's own requests to Suno's API are
  // watched for their sign-in header too (read-only; the script's own requests use the original fetch, unwatched).
  const tap = (() => {
    const t = { on: true, token: null, deviceId: null, base: null, nativeFetch: W.fetch.bind(W), remove() {}, onToken: null };
    const note = (url, name, value) => {
      if (!t.on || !value || !isApiUrl(url)) return;
      const m = lower(name) === 'authorization' ? /^bearer\s+(\S+)$/i.exec(String(value)) : null;
      if (m) {
        t.token = m[1];
        const u = parseUrl(url);
        if (/^studio-api[.-]/i.test(u.hostname)) t.base = u.origin;
        if (t.onToken) t.onToken();
      }
      if (lower(name) === 'device-id') t.deviceId = String(value).slice(0, 100);
    };
    const origFetch = W.fetch;
    const wrapped = function (input, init) {
      try {
        const url = new URL(typeof input === 'string' ? input : (input && input.url) || String(input), location.href).href;
        if (t.on && isApiUrl(url)) {
          const hd = new Headers((init && init.headers) || (input && input.headers) || undefined);
          note(url, 'authorization', hd.get('authorization'));
          note(url, 'device-id', hd.get('device-id'));
        }
      } catch (e) { /* never break the page */ }
      return origFetch.apply(W, arguments);
    };
    W.fetch = wrapped;
    const XP = W.XMLHttpRequest && W.XMLHttpRequest.prototype, xOpen = XP && XP.open, xSet = XP && XP.setRequestHeader;
    const open = function (method, url) {
      try { this.__sunoDlUrl = new URL(String(url), location.href).href; } catch (e) { /* ignore */ }
      return xOpen.apply(this, arguments);
    };
    const setHeader = function (k, v) { try { note(this.__sunoDlUrl || '', k, v); } catch (e) { /* ignore */ } return xSet.apply(this, arguments); };
    if (XP) { XP.open = open; XP.setRequestHeader = setHeader; }
    t.remove = () => {
      t.on = false;
      t.token = null;
      if (W.fetch === wrapped) W.fetch = origFetch;
      if (XP && XP.open === open) XP.open = xOpen;
      if (XP && XP.setRequestHeader === setHeader) XP.setRequestHeader = xSet;
    };
    return t;
  })();
  let badToken = null, apiBase = null;
  async function getToken(fresh) {
    const list = [];
    try {
      const c = W.Clerk;
      if (c && c.session && typeof c.session.getToken === 'function') {
        const t = await c.session.getToken(fresh ? { skipCache: true } : undefined);
        if (typeof t === 'string' && t) list.push(t);
      }
    } catch (e) { /* no Clerk on the page */ }
    const m = /(?:^|;\s*)__session=([^;]+)/.exec(D.cookie || '');
    if (m) { try { list.push(decodeURIComponent(m[1])); } catch (e) { /* a broken cookie */ } }
    if (tap.token) list.push(tap.token);
    return list.find((t) => t !== badToken) || list[0] || null; // never first the token Suno refused last
  }
  async function apiCall(path, o) {
    const token = await getToken(!!o.fresh);
    if (!token) return { status: 401, data: { detail: 'no sign-in found on the page' }, noSignin: true };
    let lastError = null;
    for (const base of apiBase ? [apiBase] : tap.base ? [tap.base] : API_BASES) {
      const url = base + path;
      if (!isApiUrl(url)) throw new Error('refused a non-Suno address');
      const headers = { Authorization: 'Bearer ' + token, 'Browser-Token': JSON.stringify({ token: btoa(JSON.stringify({ timestamp: Date.now() })) }) };
      if (tap.deviceId) headers['Device-Id'] = tap.deviceId;
      if (o.body !== undefined) headers['Content-Type'] = 'application/json';
      let res;
      try { res = await tap.nativeFetch(url, { method: o.method || 'GET', headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }); }
      catch (e) { lastError = e; continue; } // try the other API host
      apiBase = base;
      if (res.status === 401) badToken = token;
      let data = null;
      try { const text = await res.text(); data = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
      return { status: res.status, data, retryAfter: res.headers.get('retry-after') };
    }
    throw lastError || new Error('network error');
  }

  // ---- 3.2 files: fetched with progress, saved into the folder or as a download
  async function fetchFile(url, o) {
    if (!isAllowedUrl(url)) throw fileError('fail', 'refused to download from ' + hostOf(url) + ' (not a Suno address)');
    const ac = new AbortController();
    o.signal.onAbort(() => ac.abort());
    const res = await tap.nativeFetch(url, { credentials: 'omit', signal: ac.signal });
    if (res.url && !isAllowedUrl(res.url)) { // a redirect left Suno's hosts: the address list holds for where the file comes from too
      ac.abort();
      throw fileError('fail', 'refused: the file came from ' + hostOf(res.url) + ' (not a Suno address)');
    }
    if (!res.ok) return { status: res.status, retryAfter: res.headers.get('retry-after') };
    const type = res.headers.get('content-type') || '', total = Number(res.headers.get('content-length')) || 0;
    let blob;
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader(), parts = [];
      for (let got = 0; ;) {
        const step = await reader.read();
        if (step.done) break;
        parts.push(step.value);
        got += step.value.byteLength;
        o.onProgress(got, total);
      }
      blob = new Blob(parts, { type });
    } else {
      blob = await res.blob();
      o.onProgress(blob.size, blob.size);
    }
    return { status: res.status, blob, type, size: blob.size, head: new Uint8Array(await blob.slice(0, 16).arrayBuffer()) };
  }
  const canPick = typeof W.showDirectoryPicker === 'function';
  const folder = { root: null, dir: null, inUse: false }; // inUse: the current run saves into folder.dir
  async function saveFile(name, data) {
    const blob = data.blob || new Blob([data.text], { type: data.type || 'application/octet-stream' });
    if (folder.inUse && folder.dir) {
      let fh;
      try { fh = await folder.dir.getFileHandle(name, { create: true }); } catch (e) { // the playlist's subfolder was removed: make it again
        if (!e || e.name !== 'NotFoundError' || !folder.root) throw e;
        folder.dir = await folder.root.getDirectoryHandle(folder.dir.name, { create: true });
        fh = await folder.dir.getFileHandle(name, { create: true });
      }
      const w = await fh.createWritable();
      try { await w.write(blob); await w.close(); } catch (e) { try { await w.abort(); } catch (e2) { /* ignore */ } throw e; }
      return { name: folder.dir.name + '/' + name };
    }
    const href = URL.createObjectURL(blob), a = D.createElement('a');
    a.href = href;
    a.download = name;
    a.style.display = 'none';
    (D.body || D.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60000); // (not cleared on Close: the browser may still be saving it)
    return { name };
  }
  async function fileExists(name) {
    if (!folder.inUse || !folder.dir) return false;
    try { return (await (await folder.dir.getFileHandle(name)).getFile()).size > 0; } catch (e) { return false; }
  }
  const timers = new Set(); // every timer of the panel and its run; Close clears them
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
  const engine = createEngine({
    api: apiCall, fetchFile, save: saveFile, exists: fileExists, storage: store, sleep: (ms) => new Promise((r) => later(r, ms)),
    now: () => Date.now(), log: (msg, level) => (level === 'warn' || level === 'error' ? console.warn : console.log)(TAG, msg),
  });

  // ---- 3.3 the panel (in a shadow root, so Suno's styles and the panel's never mix)
  const CSS = `
    :host { all: initial; } * { box-sizing: border-box; }
    .layer { position: fixed; inset: 0; pointer-events: none; font: 12.5px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #f4ecff; }
    .panel { position: absolute; width: 340px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); display: flex; flex-direction: column; pointer-events: auto;
      background: #1d1030; border: 2px solid #1b0a2a; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.45); overflow: hidden; }
    .head { display: flex; align-items: center; gap: 6px; padding: 7px 8px 7px 10px; background: linear-gradient(90deg,#6c2bd9,#d63384);
      cursor: move; user-select: none; touch-action: none; }
    .head b { flex: 1; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .head .v { opacity: .75; font-size: 11px; }
    .head button { background: rgba(0,0,0,.25); color: #fff; border: 0; border-radius: 6px; width: 26px; height: 24px; cursor: pointer; font: 700 14px/1 system-ui, sans-serif; }
    .body { overflow: auto; padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 8px; }
    .msg { border-radius: 8px; padding: 6px 8px; background: #2e1a4a; border: 1px solid #7a4fd0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .msg.warn { background: #4a3216; border-color: #ffb74d; } .msg.error { background: #4a1630; border-color: #ff5c8a; }
    .msg.ok { background: #173a2c; border-color: #39d98a; }
    .muted { color: #b9a6d6; } .t { font-weight: 700; color: #ffd166; overflow-wrap: anywhere; }
    .sec { border-top: 1px solid #3b2560; padding-top: 6px; display: flex; flex-direction: column; gap: 4px; }
    .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; } .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px; }
    label { cursor: pointer; display: flex; align-items: flex-start; gap: 5px; } label input { margin: 2px 0 0; accent-color: #39d98a; flex: none; }
    button.b { background: #3b2560; color: #f4ecff; border: 1px solid #6a4a9a; border-radius: 6px; padding: 5px 10px; cursor: pointer; font: inherit; }
    button.b:hover:not(:disabled) { background: #503380; } button.b:disabled { opacity: .45; cursor: default; } button.b.small { padding: 1px 7px; font-size: 11.5px; }
    button.b.main { background: #39d98a; color: #10261b; border-color: #1b0a2a; font-weight: 700; }
    button.b.stop { background: #ff5c8a; color: #2a0614; border-color: #1b0a2a; font-weight: 700; }
    button.link { background: none; border: 0; color: #8ecbff; padding: 0; cursor: pointer; font: inherit; text-decoration: underline; align-self: flex-start; }
    .bar { height: 10px; border-radius: 5px; background: #120a1f; overflow: hidden; } .bar.small { height: 5px; }
    .bar > i { display: block; height: 100%; width: 0; background: linear-gradient(90deg,#39d98a,#8ecbff); transition: width .3s; }
    .bar.ind > i { width: 30%; transition: none; animation: slide 1.2s linear infinite; }
    @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
    .counts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; text-align: center; } .counts div { background: #120a1f; border-radius: 6px; padding: 3px 2px; }
    .counts b { display: block; font-size: 15px; } .counts span { font-size: 10.5px; color: #b9a6d6; }
    .songs { position: relative; max-height: 28vh; overflow: auto; border: 1px solid #3b2560; border-radius: 6px; }
    .song { display: flex; gap: 6px; align-items: center; padding: 3px 6px; border-bottom: 1px solid #2a1844; }
    .song .n { color: #b9a6d6; min-width: 22px; text-align: right; font-variant-numeric: tabular-nums; }
    .song .ti { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .song .st { font-size: 11px; color: #b9a6d6; white-space: nowrap; max-width: 48%; overflow: hidden; text-overflow: ellipsis; }
    .song.working { background: #2e1a4a; } .song.saved .st { color: #39d98a; } .song.failed .st { color: #ff8fb0; } .song.skipped .ti { opacity: .6; }
    details.log summary { cursor: pointer; color: #ffd166; font-weight: 700; }
    pre.logtext { max-height: 22vh; overflow: auto; background: #120a1f; border-radius: 6px; padding: 4px 6px; margin: 4px 0 0; font: 11px/1.35 ui-monospace, Consolas, monospace;
      white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
    .pill { position: absolute; display: none; align-items: center; gap: 8px; padding: 6px 12px 6px 6px; pointer-events: auto; background: #1d1030; border: 2px solid #6c2bd9;
      border-radius: 999px; box-shadow: 0 6px 20px rgba(0,0,0,.45); cursor: pointer; user-select: none; touch-action: none; font-weight: 700; }
    .ring { width: 26px; height: 26px; border-radius: 50%; background: conic-gradient(#39d98a calc(var(--p, 0) * 1%), #3b2560 0); display: grid; place-items: center; }
    .ring::after { content: ''; width: 16px; height: 16px; border-radius: 50%; background: #1d1030; }
    .min .panel { display: none; } .min .pill { display: flex; } .hidden { display: none !important; }
  `;
  /** An element from props (class, text, style, on<event>, properties, attributes) and children; never HTML. */
  function h(tag, props, ...kids) {
    const node = D.createElement(tag);
    for (const k of Object.keys(props || {})) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style') node.style.cssText = v; // (a style attribute could be refused by the page's CSP)
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled') node[k] = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat()) if (c != null && c !== false) node.append(c);
    return node;
  }
  let alive = true, starting = false, armed = '', ourTitle = null, builtFor = null, shownLog = -1, lastPos = 0, note = null, queued = false;
  const pageTitle = D.title;
  let settings = normSettings(store.get(KEY.settings), canPick);
  if (!settings.formats.length) settings.formats = ['mp3'];

  const host = h('div', { id: 'suno-dl-host', style: 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;' });
  const root = host.attachShadow({ mode: 'open' });
  for (const t of ['keydown', 'keyup', 'keypress']) root.addEventListener(t, (e) => e.stopPropagation()); // never Suno's shortcuts
  try { const sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); root.adoptedStyleSheets = [sheet]; } catch (e) { root.append(h('style', { text: CSS })); }
  const el = {}, btn = {}, inp = {}, rows = new Map();
  const check = (key, text) => h('label', null, (inp[key] = h('input', { type: 'checkbox', checked: !!settings[key], onchange: onSettings })), h('span', { text }));
  const radio = (value, text) =>
    h('label', null, (inp[value] = h('input', { type: 'radio', name: 'suno-dl-save', checked: settings.saveTo === value, onchange: onSettings })), h('span', { text }));
  const fmtBoxes = FORMATS.map((f) => h('input', { type: 'checkbox', value: f.id, checked: settings.formats.indexOf(f.id) >= 0, onchange: onSettings }));
  btn.min = h('button', { text: '–', title: 'Minimise', 'aria-label': 'Minimise', onclick: () => minimise(true) });
  btn.close = h('button', { text: '×', title: 'Close', 'aria-label': 'Close', onclick: onClose });
  btn.reload = h('button', { class: 'b small', text: 'Reload', onclick: () => load() });
  btn.forget = h('button', { class: 'link', text: 'Forget saved progress', onclick: onForget });
  btn.start = h('button', { class: 'b main', text: 'Start', onclick: () => begin('start') });
  // Pause / Resume does what the button says (the label can lag the run by one 80 ms redraw); the second click of a
  // double click is ignored, so a double click never pauses and resumes at once.
  btn.pause = h('button', { class: 'b', text: 'Pause', onclick: (e) => {
    if (!(e && e.detail > 1)) { if (btn.pause.textContent === 'Resume') engine.resume(); else engine.pause(); }
  } });
  btn.stop = h('button', { class: 'b stop', text: 'Stop', onclick: () => engine.stop() });
  btn.retry = h('button', { class: 'b', text: 'Retry failed', onclick: () => begin('retry') });
  Object.assign(el, { msg: h('div', { class: 'msg hidden', role: 'status' }), name: h('div', { class: 't' }), counts: h('div', { class: 'muted' }),
    left: h('div', { class: 'muted' }) });
  el.setup = h('div', { class: 'sec' }, h('div', { class: 't', text: 'Formats' }),
    h('div', { class: 'grid' }, FORMATS.map((f, i) => h('label', null, fmtBoxes[i], h('span', { text: f.label })))),
    check('numbered', 'Number files in playlist order'), h('div', { class: 't', text: 'Save to' }),
    canPick ? radio('folder', 'A folder I pick (a subfolder named after the playlist)') : null,
    radio('downloads', 'Downloads folder' + (canPick ? ' (the browser may ask to allow multiple downloads)' : '')),
    check('skipSaved', 'Skip songs saved before'), btn.forget,
    check('useChannel', 'Use Suno\'s own Download when the direct file is blocked (counts toward your plan\'s downloads)'));
  Object.assign(el, { songNo: h('b', { style: 'flex:1' }), eta: h('span', { class: 'muted' }), big: h('div', { class: 'bar' }, h('i')),
    cur: h('div', { class: 'muted', style: 'overflow-wrap:anywhere' }), curBar: h('div', { class: 'bar small' }, h('i')),
    curBytes: h('div', { class: 'muted', style: 'font-size:11px' }) });
  const counter = (key, label) => h('div', null, (el[key] = h('b', { text: '0' })), h('span', { text: label }));
  el.prog = h('div', { class: 'sec hidden' }, h('div', { class: 'row' }, el.songNo, el.eta), el.big, el.cur, el.curBar, el.curBytes,
    h('div', { class: 'counts' }, counter('cSaved', 'Saved'), counter('cSkipped', 'Skipped'), counter('cFailed', 'Failed'), counter('cLeft', 'Downloads left')));
  Object.assign(el, { sum: h('div', { class: 'msg ok hidden' }), songs: h('div', { class: 'songs hidden' }), logText: h('pre', { class: 'logtext' }) });
  el.log = h('details', { class: 'log sec', ontoggle: () => render() }, h('summary', { text: 'Log' }),
    h('div', { class: 'row' }, h('button', { class: 'b small', text: 'Copy log', onclick: copyLog }),
      h('span', { class: 'muted', text: 'Also in the console as ' + TAG + '.' })), el.logText);
  const head = h('div', { class: 'head' }, h('b', { text: 'Suno playlist downloader' }), h('span', { class: 'v', text: 'v' + VERSION }), btn.min, btn.close);
  const panel = h('div', { class: 'panel', role: 'dialog', 'aria-label': 'Suno playlist downloader' }, head,
    h('div', { class: 'body' }, el.msg, h('div', { class: 'row' }, h('div', { style: 'flex:1;min-width:0' }, el.name, el.counts, el.left), btn.reload),
      el.setup, h('div', { class: 'row' }, btn.start, btn.pause, btn.stop, btn.retry), el.prog, el.sum, el.songs, el.log));
  Object.assign(el, { ring: h('div', { class: 'ring' }), pillText: h('span', { text: '…' }) });
  const pill = h('div', { class: 'pill', role: 'button', tabindex: '0', title: 'Suno playlist downloader: click to open' }, el.ring, el.pillText);
  pill.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); minimise(false); } });
  const layer = h('div', { class: 'layer' }, panel, pill);
  root.append(layer);
  D.documentElement.appendChild(host); // outside the page's own app root

  // ---- 3.4 position: drag by the header (the pill too), kept inside the window, remembered
  function place(target, x, y) {
    const r = target.getBoundingClientRect();
    target.style.left = Math.max(0, Math.min(W.innerWidth - (r.width || 120), x)) + 'px';
    target.style.top = Math.max(0, Math.min(W.innerHeight - (r.height || 40), y)) + 'px';
  }
  const posOf = (t) => ({ x: parseFloat(t.style.left) || 0, y: parseFloat(t.style.top) || 0 });
  const savePos = () => store.set(KEY.pos, { panel: posOf(panel), pill: pill.style.left ? posOf(pill) : null });
  function draggable(handle, target, onClick) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target && e.target.closest && e.target.closest('button'))) return;
      const sx = e.clientX, sy = e.clientY, o = posOf(target);
      let moved = false;
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* fine without */ }
      const move = (ev) => {
        moved = moved || Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 4;
        if (moved) place(target, o.x + ev.clientX - sx, o.y + ev.clientY - sy);
      };
      const up = (ev) => {
        for (const [t, f] of [['pointermove', move], ['pointerup', up], ['pointercancel', up]]) handle.removeEventListener(t, f);
        if (moved) savePos(); else if (onClick && ev.type === 'pointerup') onClick(); // a click, not a drag
      };
      for (const [t, f] of [['pointermove', move], ['pointerup', up], ['pointercancel', up]]) handle.addEventListener(t, f);
      e.preventDefault();
    });
  }
  draggable(head, panel, null);
  draggable(pill, pill, () => minimise(false));
  const keepOnScreen = () => { const t = layer.classList.contains('min') ? pill : panel, p = posOf(t); place(t, p.x, p.y); };
  W.addEventListener('resize', keepOnScreen);
  const firstPos = (store.get(KEY.pos) || {}).panel;
  place(panel, firstPos && typeof firstPos.x === 'number' ? firstPos.x : W.innerWidth - 356, firstPos && typeof firstPos.y === 'number' ? firstPos.y : 12);
  function minimise(on) {
    layer.classList.toggle('min', on);
    if (on) {
      const pp = (store.get(KEY.pos) || {}).pill, r = pill.getBoundingClientRect();
      if (pp && typeof pp.x === 'number') place(pill, pp.x, pp.y); else place(pill, W.innerWidth - (r.width || 110) - 16, W.innerHeight - (r.height || 40) - 16);
      try { pill.focus(); } catch (e) { /* ignore */ }
    } else keepOnScreen();
    render();
  }

  // ---- 3.5 actions
  function readSettings() {
    return normSettings({ formats: fmtBoxes.filter((b) => b.checked).map((b) => b.value), numbered: inp.numbered.checked,
      saveTo: inp.folder && inp.folder.checked ? 'folder' : 'downloads', skipSaved: inp.skipSaved.checked, useChannel: inp.useChannel.checked }, canPick);
  }
  function onSettings() { settings = readSettings(); store.set(KEY.settings, settings); render(); }
  /** A note of the panel itself: it shows until the phase changes (an ok / info note also goes after 6 s). */
  function say(text, tone) {
    const n = (note = text ? { text, tone: tone || 'warn', phase: engine.state.phase } : null);
    if (n && (n.tone === 'ok' || n.tone === 'info')) later(() => { if (note === n) { note = null; render(); } }, 6000);
    render();
  }
  function load() {
    if (!alive || starting) return Promise.resolve(false); // (not while the folder question is open)
    builtFor = null;
    return engine.load(playlistIdFrom(location.pathname));
  }
  // The panel waits for a sign-in (none on the page yet, or one Suno refused): when the page's own request shows one,
  // the playlist is read again by itself (only on a playlist page; once, until that load ends; never again with the
  // token Suno just refused, so a refused sign-in cannot start a load on every request of the page).
  let autoLoad = 0;
  tap.onToken = () => {
    if (!autoLoad && alive && engine.state.waitingSignin && !engine.busy() && tap.token !== badToken && playlistIdFrom(location.pathname)) {
      autoLoad = later(() => { autoLoad = 0; if (engine.state.waitingSignin && !engine.busy()) load(); }, 300);
    }
  };
  /** Start, Retry failed, or a row's Retry. The folder question comes right in the click, before any await. */
  function begin(kind, pos) {
    if (engine.busy() || starting || !engine.state.playlist) return;
    const s = readSettings();
    if (!s.formats.length) { say('Tick at least one format.'); return; }
    let ask = Promise.resolve(null);
    try {
      if (s.saveTo === 'folder' && folder.root && kind !== 'start') { // Retry: the same folder
        const r = folder.root;
        ask = r.requestPermission({ mode: 'readwrite' }).then((p) => {
          if (p !== 'granted') throw new Error('the browser did not allow writing there: click Start to pick it again');
          return r;
        });
      } else if (s.saveTo === 'folder') ask = W.showDirectoryPicker({ id: 'suno-playlist-downloader', mode: 'readwrite' });
    } catch (e) { ask = Promise.reject(e); }
    starting = true;
    render();
    ask.then(async (picked) => {
      if (!alive) return; // closed while the folder question was open
      folder.inUse = s.saveTo === 'folder';
      if (folder.inUse) { folder.root = picked; folder.dir = await picked.getDirectoryHandle(safeName(engine.state.playlist.name, 80), { create: true }); }
      starting = false;
      settings = s;
      if (kind === 'start') engine.start(s); else if (kind === 'retry') engine.retryFailed(s); else engine.retrySong(pos, s); // (runs never reject)
    }).catch((e) => {
      starting = false;
      if (e && e.name === 'AbortError') say('No folder picked, so nothing was started.', 'info');
      else say('Could not use that folder: ' + ((e && e.message) || e) + '.', 'error');
    });
  }
  /** Close (while running) and Forget ask for a second click instead of a dialog. */
  function armedTwice(name, text) {
    if (armed === name) { armed = ''; return true; }
    armed = name;
    say(text, 'warn');
    later(() => { if (armed === name) { armed = ''; say(''); } }, 5000);
    return false;
  }
  function onClose() { if (!engine.busy() || armedTwice('close', 'A download is running. Click × again to stop it and close the panel.')) destroy(); }
  // The question goes on the button itself: a note above would push the button away from under the second click.
  function onForget() {
    const label = (t) => { btn.forget.textContent = t; };
    if (armed === 'forget') { armed = ''; label('Forget saved progress'); engine.forgetSaved(); return; }
    armed = 'forget';
    label('Click again to forget saved progress');
    later(() => { if (armed === 'forget') { armed = ''; label('Forget saved progress'); } }, 5000);
  }
  function copyLog() {
    const blocked = () => say('Copying was blocked: open the log, select its text and copy it.');
    try { W.navigator.clipboard.writeText(engine.state.log.join('\n')).then(() => say('Log copied.', 'ok'), blocked); } catch (e) { blocked(); }
  }

  // ---- 3.6 drawing (at most every 80 ms)
  function buildRows(songs) {
    builtFor = songs;
    rows.clear();
    el.songs.textContent = '';
    for (const s of songs) {
      const r = { row: h('div', { class: 'song' }), st: h('span', { class: 'st' }),
        retry: h('button', { class: 'b small hidden', text: 'Retry', onclick: () => begin('song', s.pos) }) };
      r.row.append(h('span', { class: 'n', text: String(s.pos) }), h('span', { class: 'ti', text: s.title, title: s.title }), r.st, r.retry);
      rows.set(s.pos, r);
      el.songs.append(r.row);
    }
    el.songs.classList.toggle('hidden', !songs.length);
  }
  const rowText = (s, ph) => (s.status === 'skipped' || s.status === 'failed' ? s.status + ': ' + s.note
    : s.status === 'working' ? (ph === 'paused' ? 'paused' : 'working…') : s.note ? s.status + ' (' + s.note + ')' : s.status);
  function render() {
    if (queued || !alive) return;
    queued = true;
    later(() => { queued = false; if (alive) draw(); }, 80);
  }
  function draw() {
    const s = engine.state, ph = s.phase, run = s.run, busy = engine.busy() || starting, songs = s.songs;
    const count = (kind) => songs.filter((x) => x.kind === kind).length, mine = count('mine'), unfinished = count('unfinished');
    if (note && note.phase !== ph) note = null;
    const msg = note || (s.message && ph !== 'done' ? { text: s.message, tone: s.tone } : null);
    el.msg.classList.toggle('hidden', !msg);
    if (msg) { el.msg.textContent = msg.text; el.msg.className = 'msg ' + (msg.tone || ''); }
    el.name.textContent = s.playlist ? s.playlist.name : ph === 'loading' ? 'Reading the playlist…' : 'No playlist loaded';
    const before = s.playlist && settings.skipSaved && !busy && ph !== 'done' ? engine.savedBefore(settings.formats) : 0; // (not this run's own saves)
    el.counts.textContent = !s.playlist ? '' : !songs.length ? 'This playlist has no songs.' : songs.length + ' songs: ' + mine + ' yours, ' + count('others') +
      ' by others' + (unfinished ? ', ' + unfinished + ' not finished' : '') + (before ? ' (' + before + ' saved before)' : '');
    el.left.textContent = 'Suno downloads left this period: ' + (s.billing && s.billing.left != null ? s.billing.left : 'unknown');
    el.setup.classList.toggle('hidden', busy || !s.playlist);
    for (const b of fmtBoxes.concat(Object.values(inp))) b.disabled = busy;
    btn.reload.disabled = busy;
    btn.start.disabled = busy || !mine;
    btn.start.textContent = ph === 'done' ? 'Start again' : 'Start';
    btn.pause.textContent = ph === 'paused' ? 'Resume' : ph === 'pausing' ? 'Pausing…' : 'Pause';
    btn.pause.disabled = ph !== 'running' && ph !== 'paused';
    btn.stop.disabled = ['running', 'pausing', 'paused'].indexOf(ph) < 0;
    btn.retry.classList.toggle('hidden', !s.counts.failed || busy);
    btn.retry.textContent = 'Retry failed (' + s.counts.failed + ')';
    // progress: songs done of songs to do, the current file, the counters
    el.prog.classList.toggle('hidden', !run);
    const pct = run && run.todo ? Math.round((run.done / run.todo) * 100) : 0, cur = run && run.current;
    if (run) {
      el.big.firstChild.style.width = pct + '%';
      el.songNo.textContent = ph === 'done' ? (run.stopped ? 'Stopped at ' : 'Done: ') + run.done + ' of ' + run.todo
        : 'Song ' + Math.max(1, run.index) + ' of ' + run.todo;
      el.eta.textContent = ph === 'running' ? fmtEta(engine.etaMs()) : '';
      el.cur.textContent = cur ? cur.title + ' · ' + cur.format.toUpperCase() + (cur.note ? ' · ' + cur.note : '') : ph === 'paused' ? 'Paused' : '';
      el.curBar.classList.toggle('hidden', !cur);
      el.curBar.classList.toggle('ind', !!cur && !(cur.total > 0)); // no Content-Length: an indeterminate bar and the MB so far
      el.curBar.firstChild.style.width = cur && cur.total > 0 ? Math.min(100, Math.round((cur.bytes / cur.total) * 100)) + '%' : '';
      el.curBytes.textContent = cur && cur.bytes ? fmtSize(cur.bytes) + (cur.total ? ' of ' + fmtSize(cur.total) : ' so far') : '';
      [el.cSaved.textContent, el.cSkipped.textContent, el.cFailed.textContent] = [s.counts.saved, s.counts.skipped, s.counts.failed].map(String);
      el.cLeft.textContent = s.billing && s.billing.left != null ? String(s.billing.left) : '?';
    }
    // the end of a run: what happened, where the files are, what next
    el.sum.classList.toggle('hidden', ph !== 'done');
    if (ph === 'done') {
      el.sum.className = 'msg ' + (s.tone || 'ok');
      el.sum.textContent = '';
      el.sum.append(h('b', { text: s.message }),
        h('div', { text: folder.inUse && folder.dir ? 'Saved in the folder “' + folder.root.name + '/' + folder.dir.name + '”.'
          : 'The files are in your Downloads folder. If some are missing, allow downloads from suno.com (the icon in the address bar), ' +
            'untick “Skip songs saved before” and Start again.' }),
        h('div', { text: 'Add them to TwinSpin: Add music > This device, or upload the folder to Google Drive and paste the link.' }));
    }
    // the song list
    if (songs !== builtFor) buildRows(songs);
    for (const song of songs) {
      const r = rows.get(song.pos), text = rowText(song, ph);
      if (r.st.textContent !== text) { r.st.textContent = text; r.st.title = text; }
      r.row.className = 'song ' + song.status;
      r.retry.classList.toggle('hidden', song.status !== 'failed' || busy);
    }
    const curPos = cur ? cur.pos : 0;
    if (curPos && curPos !== lastPos && rows.get(curPos)) {
      const row = rows.get(curPos).row, box = el.songs;
      const out = row.offsetTop < box.scrollTop || row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight;
      if (out) box.scrollTop = row.offsetTop - box.clientHeight / 2; // keep the current song in view
    }
    lastPos = curPos;
    if (el.log.open && shownLog !== s.logSeq) {
      const stick = el.logText.scrollTop + el.logText.clientHeight >= el.logText.scrollHeight - 8;
      el.logText.textContent = s.log.join('\n');
      if (stick) el.logText.scrollTop = el.logText.scrollHeight;
      shownLog = s.logSeq;
    }
    // the pill and the tab title
    el.ring.style.setProperty('--p', String(ph === 'done' ? 100 : pct));
    const counted = run ? run.done + '/' + run.todo : '';
    el.pillText.textContent = ph === 'paused' ? 'Paused' : ph === 'done' ? 'Done' : run && busy ? counted
      : ph === 'loading' ? 'Loading…' : ph === 'error' ? (s.waitingSignin ? 'Waiting' : 'Error') : 'Ready';
    const title = ['running', 'pausing', 'stopping'].indexOf(ph) >= 0 ? counted + ' Suno downloader' : ph === 'paused' ? 'Paused · ' + counted + ' Suno downloader'
      : ph === 'done' && run ? 'Done · Suno downloader' : null;
    if (title) { if (D.title !== title) D.title = title; ourTitle = title; }
    else if (ourTitle) { if (D.title === ourTitle) D.title = pageTitle; ourTitle = null; } // back to Suno's own title
    if (!layer.classList.contains('min')) keepOnScreen();
  }
  function onBeforeUnload(e) { if (engine.busy()) { e.preventDefault(); e.returnValue = ''; } }
  W.addEventListener('beforeunload', onBeforeUnload);
  function destroy() {
    if (!alive) return;
    alive = false;
    engine.destroy(); // the run stops: its waits end, the file in flight is aborted, no more requests
    timers.forEach((id) => clearTimeout(id));
    timers.clear();
    tap.remove();
    W.removeEventListener('resize', keepOnScreen);
    W.removeEventListener('beforeunload', onBeforeUnload);
    host.remove();
    if (ourTitle && D.title === ourTitle) D.title = pageTitle;
    if (W.__sunoPlaylistDl === handle) delete W.__sunoPlaylistDl;
    console.log(TAG, 'Closed. Paste the script again to reopen it: it skips the songs it already saved.');
  }
  // window.__sunoPlaylistDl: close the panel from the console, or look at its state (no sign-in token in there).
  const handle = { version: VERSION, destroy, show: () => minimise(false), state: () => engine.state };
  W.__sunoPlaylistDl = handle;
  engine.on(render);
  console.log(TAG, 'Suno Playlist Downloader ' + VERSION + ': the panel is open on the page.');
  load().then(render);
  render();
})();
