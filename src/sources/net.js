// Small network helpers shared by the song sources (gdrive.js, subsonic.js): friendly errors with a code,
// cancellation that works with or without AbortController, reading a response body with download progress
// (ReadableStream when the browser exposes it), building File / Blob objects (with a stand-in where the engine
// has none, e.g. the JsCheck test runner) and loading a classic <script> with a timeout.
//   const err = sourceError('network', "Can't reach Google Drive.");   // err.code === 'network'
//   const ctl = makeAbort();  fetch(url, { signal: ctl.signal });  ctl.abort();
//   const { parts, bytes } = await readParts(res, { onProgress: (got, total) => ..., totalHint: 1234 });
//   const file = makeFile(parts, 'song.mp3', { type: 'audio/mpeg', lastModified: 0 });
//   await loadScript('https://accounts.google.com/gsi/client', { timeoutMs: 20000 });

/** How long a download may receive nothing before it counts as stalled (ms). */
export const STALL_MS = 45000;

/**
 * An Error whose message is plain words for the user, with a machine-readable `code`.
 * @param {string} code
 * @param {string} message
 * @param {*} [cause]
 * @returns {Error & { code: string }}
 */
export function sourceError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause !== undefined) err.cause = cause;
  return err;
}

/** The error a cancelled operation rejects with (name 'AbortError', code 'aborted'). */
export function abortError() {
  const err = new Error('Cancelled.');
  err.name = 'AbortError';
  err.code = 'aborted';
  return err;
}

/** True for a cancellation (our own or fetch's AbortError). */
export function isAbort(err) {
  return !!err && (err.name === 'AbortError' || err.code === 'aborted');
}

/**
 * An abort controller: the browser's AbortController when there is one, else a small stand-in with the same
 * shape (signal.aborted, signal.addEventListener('abort', fn), abort()).
 * @returns {{ signal: object, abort: () => void, readonly aborted: boolean }}
 */
export function makeAbort() {
  if (typeof globalThis.AbortController === 'function') {
    try {
      const ctl = new globalThis.AbortController();
      return { signal: ctl.signal, abort: () => ctl.abort(), get aborted() { return ctl.signal.aborted; } };
    } catch {
      /* fall through to the stand-in */
    }
  }
  const listeners = new Set();
  const signal = {
    aborted: false,
    onabort: null,
    addEventListener(type, fn) {
      if (type === 'abort' && typeof fn === 'function') listeners.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.delete(fn);
    },
  };
  return {
    signal,
    abort() {
      if (signal.aborted) return;
      signal.aborted = true;
      const fns = [...listeners];
      listeners.clear();
      if (typeof signal.onabort === 'function') fns.unshift(signal.onabort);
      for (const fn of fns) {
        try {
          fn({ type: 'abort' });
        } catch {
          /* ignore */
        }
      }
    },
    get aborted() {
      return signal.aborted;
    },
  };
}

/**
 * Call `fn` once when `signal` aborts (at once when it already has). Returns an unsubscribe function.
 * @param {object|null|undefined} signal
 * @param {() => void} fn
 */
export function onAbort(signal, fn) {
  if (!signal) return () => {};
  if (signal.aborted) {
    fn();
    return () => {};
  }
  let fired = false;
  const handler = () => {
    if (fired) return;
    fired = true;
    fn();
  };
  try {
    signal.addEventListener('abort', handler);
  } catch {
    return () => {};
  }
  return () => {
    try {
      signal.removeEventListener('abort', handler);
    } catch {
      /* ignore */
    }
  };
}

/** Content-Length of a response as a number (0 when missing, hidden by CORS or not a number). */
export function contentLength(res) {
  try {
    const v = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null;
    const n = Number(v);
    return v != null && v !== '' && Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Content-Type of a response without parameters, lower case ('' when missing). */
export function contentType(res) {
  try {
    const v = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') : '';
    return String(v || '').split(';')[0].trim().toLowerCase();
  } catch {
    return '';
  }
}

function readWithStall(reader, stallMs) {
  if (!(stallMs > 0)) return reader.read();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        Promise.resolve(reader.cancel()).catch(() => {});
      } catch {
        /* ignore */
      }
      reject(sourceError('stalled', 'The download stopped. Check your internet connection and try again.'));
    }, stallMs);
    reader.read().then(
      (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Read a whole response body. Reports progress per chunk when the body is a ReadableStream; `total` is the
 * Content-Length when the server exposes it, else `totalHint`, else 0 (= unknown, show an indeterminate bar).
 * @param {Response} res
 * @param {{ onProgress?: (bytes: number, total: number) => void, totalHint?: number, stallMs?: number,
 *   cancelled?: () => boolean }} [opts]
 * @returns {Promise<{ parts: Array<Uint8Array|ArrayBuffer|Blob>, bytes: number, total: number }>}
 */
export async function readParts(res, { onProgress, totalHint = 0, stallMs = STALL_MS, cancelled } = {}) {
  const len = contentLength(res);
  const total = len > 0 ? len : totalHint > 0 ? totalHint : 0;
  const report = (got, tot) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress(got, tot);
    } catch {
      /* a broken progress listener must not stop the download */
    }
  };
  const body = res ? res.body : null;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const parts = [];
    let got = 0;
    report(0, total);
    for (;;) {
      if (cancelled && cancelled()) {
        try {
          Promise.resolve(reader.cancel()).catch(() => {});
        } catch {
          /* ignore */
        }
        throw abortError();
      }
      const { done, value } = await readWithStall(reader, stallMs);
      if (done) break;
      const n = value ? value.byteLength || value.length || 0 : 0;
      if (!n) continue;
      parts.push(value);
      got += n;
      report(got, total > 0 ? Math.max(total, got) : 0);
    }
    if (cancelled && cancelled()) throw abortError();
    return { parts, bytes: got, total: total > 0 ? Math.max(total, got) : got };
  }
  // no stream (older engines): one step
  report(0, total);
  let whole;
  if (res && typeof res.blob === 'function') whole = await res.blob();
  else whole = await res.arrayBuffer();
  if (cancelled && cancelled()) throw abortError();
  const size = whole ? (Number.isFinite(whole.size) ? whole.size : whole.byteLength || 0) : 0;
  report(size, size);
  return { parts: whole ? [whole] : [], bytes: size, total: size };
}

function partBytes(p) {
  if (!p) return new Uint8Array(0);
  if (p instanceof Uint8Array) return p;
  if (p instanceof ArrayBuffer) return new Uint8Array(p);
  if (ArrayBuffer.isView(p)) return new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
  if (p._bytes instanceof Uint8Array) return p._bytes;
  return new Uint8Array(0);
}

/** Blob stand-in for engines without Blob (never in a browser): size, type, arrayBuffer(), slice(). */
function bytesBlob(bytes, type) {
  const blob = {
    _bytes: bytes,
    size: bytes.byteLength,
    type: type || '',
    arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
    slice: (a = 0, b = bytes.byteLength, t = '') => bytesBlob(bytes.slice(a, b), t),
    text: () => Promise.resolve(typeof TextDecoder === 'function' ? new TextDecoder().decode(bytes) : ''),
  };
  return blob;
}

function concat(parts) {
  const arrays = parts.map(partBytes);
  const n = arrays.reduce((s, a) => s + a.byteLength, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.byteLength;
  }
  return out;
}

/**
 * A Blob of the parts (the browser's Blob; a stand-in where there is none).
 * @param {Array<Uint8Array|ArrayBuffer|Blob>} parts
 * @param {string} [type]
 */
export function makeBlob(parts, type = '') {
  if (typeof globalThis.Blob === 'function') {
    try {
      return new globalThis.Blob(parts, { type });
    } catch {
      /* fall through */
    }
  }
  return bytesBlob(concat(parts), type);
}

/**
 * A File of the parts with a name, type and modification date (a named Blob, or a stand-in, where the
 * browser has no File constructor).
 * @param {Array<Uint8Array|ArrayBuffer|Blob>} parts
 * @param {string} name
 * @param {{ type?: string, lastModified?: number }} [opts]
 */
export function makeFile(parts, name, { type = '', lastModified = 0 } = {}) {
  const lm = Number.isFinite(lastModified) && lastModified > 0 ? Math.round(lastModified) : 0;
  if (typeof globalThis.File === 'function') {
    try {
      return new globalThis.File(parts, name, { type, lastModified: lm });
    } catch {
      /* old Safari / Edge: fall through */
    }
  }
  const blob = makeBlob(parts, type);
  try {
    Object.defineProperty(blob, 'name', { value: String(name || ''), configurable: true, enumerable: true });
    Object.defineProperty(blob, 'lastModified', { value: lm, configurable: true, enumerable: true });
  } catch {
    /* frozen: the library still has the size and type */
  }
  return blob;
}

/** File extension of a name, lower case without the dot ('' when none). */
export function extOf(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

const MIME_BY_EXT = Object.freeze({
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', wave: 'audio/wav',
  flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm',
  aif: 'audio/aiff', aiff: 'audio/aiff', caf: 'audio/x-caf',
});

/** A likely audio MIME type for a file name ('' when unknown). */
export function mimeForName(name) {
  return MIME_BY_EXT[extOf(name)] || '';
}

/** A file name safe on every system (no slashes, control characters or reserved characters). */
export function safeFileName(name, fallback = 'song') {
  const s = String(name || '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (s || fallback).slice(0, 180);
}

// ---------------------------------------------------------------------------------------------------------
// <script> loading

const scripts = new Map(); // src -> Promise<void>

/**
 * Load a classic script once (later calls share the promise; a failed load can be retried).
 * Rejects with code 'load-failed' (blocked, offline) or 'load-timeout'.
 * @param {string} src
 * @param {{ document?: Document, timeoutMs?: number }} [opts]
 * @returns {Promise<void>}
 */
export function loadScript(src, { document: doc = globalThis.document, timeoutMs = 20000 } = {}) {
  const known = scripts.get(src);
  if (known) return known;
  const p = new Promise((resolve, reject) => {
    if (!doc || typeof doc.createElement !== 'function') {
      reject(sourceError('load-failed', 'This browser cannot load the script.'));
      return;
    }
    let done = false;
    let el = null;
    let timer = null;
    const finish = (err) => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      if (el) {
        el.onload = null;
        el.onerror = null;
      }
      if (err) {
        try {
          if (el && el.parentNode) el.parentNode.removeChild(el);
        } catch {
          /* ignore */
        }
        reject(err);
      } else {
        resolve();
      }
    };
    try {
      el = doc.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = () => finish(null);
      el.onerror = () => finish(sourceError('load-failed', `Could not load ${src}`));
      timer = setTimeout(() => finish(sourceError('load-timeout', `Loading ${src} took too long`)), timeoutMs);
      (doc.head || doc.body || doc.documentElement).appendChild(el);
    } catch (err) {
      finish(sourceError('load-failed', `Could not load ${src}`, err));
    }
  });
  scripts.set(src, p);
  p.catch(() => {
    if (scripts.get(src) === p) scripts.delete(src);
  });
  return p;
}

/**
 * Run `jobs` (functions returning promises) with at most `limit` at a time. Resolves with one
 * { ok, value | error } per job, in order; never rejects.
 * @param {Array<() => Promise<*>>} jobs
 * @param {number} limit
 */
export async function runPool(jobs, limit) {
  const results = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await jobs[i]() };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  };
  const n = Math.max(1, Math.min(limit | 0 || 1, jobs.length));
  const workers = [];
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
