// Downloads of remote songs for the library: one download per song however many callers wait for it, a
// download is aborted only when every caller has aborted, progress is reported in steps (>= 256 KB or 1 %),
// and the last few songs stay in memory for the session (an LRU of `cacheSize` blobs).
//   const f = new RemoteFetcher({ cacheSize: 3, emit: (ev) => lib.emit('download', ev), keep: (id) => has(id) });
//   const blob = f.cached(id) || await f.fetch(id, entry, resolver, { signal, onProgress });
//   f.state(id)   // { bytes, totalBytes } while downloading, else null
//   f.forget(id); f.clear();
// 'download' events: { id, phase: 'start' | 'progress' | 'done' | 'error' | 'cancel', bytes, totalBytes,
// message? } (totalBytes 0 = unknown size).

import { abortError, isAbort, makeAbort, sourceError } from './net.js';
import { songName } from './remote-ref.js';

const PROGRESS_STEP = 256 * 1024;

export class RemoteFetcher {
  /**
   * @param {{ cacheSize?: number, emit?: (event: object) => void, keep?: (id: string) => boolean }} [opts]
   *   keep(id): whether a finished download should be cached (false when the song left the library meanwhile)
   */
  constructor({ cacheSize = 3, emit = () => {}, keep = () => true } = {}) {
    this._size = Math.max(0, cacheSize | 0);
    this._emit = emit;
    this._keep = keep;
    /** @type {Map<string, Blob>} */
    this._cache = new Map();
    /** @type {Map<string, object>} */
    this._jobs = new Map();
  }

  /** The cached blob of a song (it becomes the most recently used), or null. */
  cached(id) {
    const b = this._cache.get(id);
    if (!b) return null;
    this._cache.delete(id);
    this._cache.set(id, b);
    return b;
  }

  /** Ids of the cached songs, least recently used first. */
  get cachedIds() {
    return [...this._cache.keys()];
  }

  /** Ids of the songs being downloaded. */
  get ids() {
    return [...this._jobs.keys()];
  }

  /** { bytes, totalBytes } of a download under way, or null. */
  state(id) {
    const j = this._jobs.get(id);
    return j ? { bytes: j.bytes, totalBytes: j.totalBytes } : null;
  }

  /**
   * Download a song (or join its download under way).
   * @param {string} id
   * @param {object} entry a copy of the library entry (passed to the resolver)
   * @param {(entry: object, opts: { signal: object, onProgress: Function }) => Promise<Blob>} resolver
   * @param {{ signal?: AbortSignal, onProgress?: (bytes: number, totalBytes: number) => void }} [opts]
   * @returns {Promise<Blob>}
   */
  fetch(id, entry, resolver, { signal, onProgress } = {}) {
    if (signal && signal.aborted) return Promise.reject(abortError());
    // a download every earlier caller gave up on may still be winding down (its fetch has not noticed the abort
    // yet): a new caller starts a fresh one instead of joining it and getting its AbortError
    let job = this._jobs.get(id);
    if (!job || job.ctl.signal.aborted) job = this._start(id, entry, resolver);
    job.waiters++;
    if (typeof onProgress === 'function') job.listeners.add(onProgress);
    return new Promise((resolve, reject) => {
      let settled = false;
      let unlisten = () => {};
      const leave = () => {
        settled = true;
        job.waiters--;
        job.listeners.delete(onProgress);
        unlisten();
      };
      if (signal && typeof signal.addEventListener === 'function') {
        const abort = () => {
          if (settled) return;
          leave();
          reject(abortError());
          if (job.waiters <= 0 && !job.finished) job.ctl.abort();
        };
        signal.addEventListener('abort', abort);
        unlisten = () => {
          try {
            signal.removeEventListener('abort', abort);
          } catch {
            /* ignore */
          }
        };
      }
      job.promise.then(
        (blob) => {
          if (settled) return;
          leave();
          resolve(blob);
        },
        (err) => {
          if (settled) return;
          leave();
          reject(err);
        },
      );
    });
  }

  _start(id, entry, resolver) {
    const job = {
      ctl: makeAbort(), waiters: 0, listeners: new Set(), bytes: 0, totalBytes: 0, lastEmit: -Infinity,
      finished: false, promise: null,
    };
    const progress = (bytes, total) => {
      const b = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
      const t = Number.isFinite(total) && total > 0 ? total : 0;
      job.bytes = b;
      job.totalBytes = t;
      if (b - job.lastEmit < Math.max(PROGRESS_STEP, t / 100) && !(t > 0 && b >= t)) return;
      job.lastEmit = b;
      for (const fn of [...job.listeners]) {
        try {
          fn(b, t);
        } catch {
          /* ignore */
        }
      }
      this._send({ id, phase: 'progress', bytes: b, totalBytes: t });
    };
    this._jobs.set(id, job);
    this._send({ id, phase: 'start', bytes: 0, totalBytes: entry && entry.size > 0 ? entry.size : 0 });
    job.promise = Promise.resolve()
      .then(() => resolver(entry, { signal: job.ctl.signal, onProgress: progress }))
      .then((blob) => {
        if (job.ctl.signal.aborted) throw abortError();
        if (!blob || !(blob.size > 0 || (!Number.isFinite(blob.size) && typeof blob.arrayBuffer === 'function'))) {
          throw sourceError('empty', `The server sent an empty file for ${songName(entry)}.`);
        }
        job.finished = true;
        if (this._keep(id)) this._put(id, blob);
        const size = Number.isFinite(blob.size) ? blob.size : job.bytes;
        this._send({ id, phase: 'done', bytes: size, totalBytes: size });
        return blob;
      })
      .catch((err) => {
        job.finished = true;
        if (job.ctl.signal.aborted || isAbort(err)) {
          this._send({ id, phase: 'cancel', bytes: job.bytes, totalBytes: job.totalBytes });
          throw abortError();
        }
        const msg = err && err.message ? err.message : `${songName(entry)} couldn't be downloaded.`;
        this._send({ id, phase: 'error', bytes: job.bytes, totalBytes: job.totalBytes, message: msg });
        throw err instanceof Error ? err : sourceError('download', msg);
      })
      .finally(() => {
        if (this._jobs.get(id) === job) this._jobs.delete(id);
      });
    job.promise.catch(() => {}); // every waiter handles it
    return job;
  }

  _send(ev) {
    try {
      this._emit(ev);
    } catch {
      /* ignore */
    }
  }

  _put(id, blob) {
    if (!this._size) return;
    this._cache.delete(id);
    this._cache.set(id, blob);
    while (this._cache.size > this._size) this._cache.delete(this._cache.keys().next().value);
  }

  /** Drop a song's cached blob and abort its download. */
  forget(id) {
    this._cache.delete(id);
    const job = this._jobs.get(id);
    if (job && !job.finished) job.ctl.abort();
  }

  /** Drop every cached blob and abort every download. */
  clear() {
    this._cache.clear();
    for (const job of this._jobs.values()) if (!job.finished) job.ctl.abort();
  }
}
