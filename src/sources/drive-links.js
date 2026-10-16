// Saved Google Drive links: every public Drive link imported on this device, so it can be imported again with
// one tap (Add music > Paste a Google Drive link > Saved links) without looking the link up again. Kept in
// localStorage under 'twinspin.driveLinks.v1' and nowhere else; when storage is blocked (private mode, a full
// disk) the list lives in memory for this visit. A 'storage' event from another tab reloads the list, and every
// change first reads what is stored, so two open tabs agree and never write over each other's links.
// UI-agnostic and testable: storage, the clock and the event target can be injected.
//   const links = new SavedDriveLinks();
//   links.save({ id, kind: 'folder', name: 'Road Trip', songCount: 9, resourceKey: '' });   // after an import
//   links.list();  links.get(id);  links.rename(id, 'Car songs');  links.remove(id);  links.clear();
//   links.on('change', (why) => render());   // why: 'save' | 'rename' | 'remove' | 'clear' | 'storage'
// Entries: { id, kind: 'folder'|'file', url, resourceKey, name, renamed, songCount, addedAt, lastImportedAt }.
// `url` is always rebuilt from the id (https://drive.google.com/drive/folders/<id> or /file/d/<id>/view, plus
// ?resourcekey= when the link has one), never taken from storage as is.

import { Emitter } from '../core/emitter.js';

export const DRIVE_LINKS_KEY = 'twinspin.driveLinks.v1';
/** At most this many links are kept; the least recently used go first. */
export const MAX_SAVED_LINKS = 100;
const NAME_MAX = 120;
const ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const RK_RE = /^[A-Za-z0-9_-]{1,100}$/;

function safeLocal() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function cleanName(v) {
  // one line of plain text (no control characters), at most NAME_MAX characters
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '';
}

function stamp(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The canonical share link of a Drive file or folder ('' for an id that is not a Drive id).
 * @param {'folder'|'file'} kind
 * @param {string} id
 * @param {string} [resourceKey]
 */
export function driveLinkUrl(kind, id, resourceKey = '') {
  if (!ID_RE.test(String(id || ''))) return '';
  const rk = RK_RE.test(String(resourceKey || '')) ? `?resourcekey=${resourceKey}` : '';
  return kind === 'folder' ? `https://drive.google.com/drive/folders/${id}${rk}`
    : `https://drive.google.com/file/d/${id}/view${rk}`;
}

/** A stored or saved entry as a clean frozen object, or null when it is not usable. */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '');
  const kind = raw.kind === 'folder' || raw.kind === 'file' ? raw.kind : null;
  if (!ID_RE.test(id) || !kind) return null;
  const resourceKey = RK_RE.test(String(raw.resourceKey || '')) ? String(raw.resourceKey) : '';
  const count = Number(raw.songCount);
  const addedAt = stamp(raw.addedAt);
  const lastImportedAt = stamp(raw.lastImportedAt) || addedAt;
  const name = cleanName(raw.name);
  return Object.freeze({
    id,
    kind,
    url: driveLinkUrl(kind, id, resourceKey),
    resourceKey,
    name,
    renamed: raw.renamed === true && !!name,
    songCount: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
    addedAt: addedAt || lastImportedAt,
    lastImportedAt,
  });
}

/** Newest used first (then newest added). */
const byUse = (a, b) => b.lastImportedAt - a.lastImportedAt || b.addedAt - a.addedAt;

export class SavedDriveLinks extends Emitter {
  /**
   * @param {{ storage?: Storage|null, now?: () => number, events?: EventTarget|null, max?: number }} [deps]
   *   `storage` default localStorage (null = memory only); `events` where 'storage' events arrive (default the
   *   window; null = none); `max` the cap (default MAX_SAVED_LINKS)
   */
  constructor({ storage, now, events, max = MAX_SAVED_LINKS } = {}) {
    super();
    this._store = storage === undefined ? safeLocal() : storage;
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._max = Math.max(1, Math.floor(Number(max) || MAX_SAVED_LINKS));
    this._links = new Map();   // id -> entry
    this._last = 0;            // last stamp handed out (strictly increasing within this tab)
    this._persistent = !!this._store;
    this._load();
    this._events = null;
    this._onStorage = (e) => this._storageEvent(e);
    const target = events === undefined ? globalThis : events;
    if (target && typeof target.addEventListener === 'function') {
      try {
        target.addEventListener('storage', this._onStorage);
        this._events = target;
      } catch {
        /* no cross-tab updates; this tab still works */
      }
    }
  }

  /** False when the links cannot be stored (they last for this visit only). */
  get persistent() {
    return this._persistent;
  }

  /** How many links are saved. */
  get size() {
    return this._links.size;
  }

  /** Every saved link, newest used first. */
  list() {
    return [...this._links.values()].sort(byUse);
  }

  /** One saved link by its Drive id, or null. */
  get(id) {
    return this._links.get(String(id || '')) || null;
  }

  /**
   * Remember a link that was just imported (dedupe by id): a new one is added, a known one gets the new name
   * (unless the user renamed it), song count, kind, resource key and lastImportedAt. Returns the entry, or null
   * when it is not a usable Drive id.
   * @param {{ id: string, kind: 'folder'|'file', name?: string, songCount?: number, resourceKey?: string }} entry
   */
  save(entry) {
    this._sync();
    const t = this._stamp();
    const fresh = sanitize({ ...(entry || {}), addedAt: t, lastImportedAt: t, renamed: false });
    if (!fresh) return null;
    const old = this._links.get(fresh.id);
    const next = sanitize({
      ...fresh,
      name: old && old.renamed ? old.name : fresh.name || (old ? old.name : ''),
      renamed: !!(old && old.renamed),
      resourceKey: fresh.resourceKey || (old ? old.resourceKey : ''),
      songCount: fresh.songCount || (old ? old.songCount : 0),
      addedAt: old ? old.addedAt : t,
    });
    this._links.set(next.id, next);
    this._trim();
    this._persist();
    this.emit('change', 'save');
    return next;
  }

  /** Give a saved link the user's own name (kept when it is imported again). False for an empty name. */
  rename(id, name) {
    this._sync();
    const old = this.get(id);
    const clean = cleanName(name);
    if (!old || !clean) return false;
    if (clean === old.name && old.renamed) return true;
    this._links.set(old.id, sanitize({ ...old, name: clean, renamed: true }));
    this._persist();
    this.emit('change', 'rename');
    return true;
  }

  /** Forget one link. Returns whether it was saved. */
  remove(id) {
    this._sync();
    if (!this._links.delete(String(id || ''))) return false;
    this._persist();
    this.emit('change', 'remove');
    return true;
  }

  /** Forget every link. */
  clear() {
    const had = this._links.size > 0;
    this._links.clear();
    this._persist();
    if (had) this.emit('change', 'clear');
  }

  /** Stop listening to other tabs. */
  dispose() {
    if (this._events) {
      try {
        this._events.removeEventListener('storage', this._onStorage);
      } catch {
        /* ignore */
      }
      this._events = null;
    }
  }

  /**
   * Before a change: read what is stored, so links another tab saved meanwhile are kept even when its 'storage'
   * event never arrived (a frozen or cached background tab). Skipped while this tab's writes fail (the list then
   * has links that only live in memory).
   */
  _sync() {
    if (this._persistent) this._load();
  }

  _stamp() {
    let t = Number(this._now());
    if (!Number.isFinite(t) || t <= 0) t = Date.now();
    this._last = Math.max(t, this._last + 1);
    return this._last;
  }

  /**
   * Read the stored list; anything broken is skipped (a corrupt value gives an empty list, never an error).
   * Storage that cannot be read keeps the links this visit has (and `persistent` turns false). Returns whether
   * the list was read.
   */
  _load() {
    if (!this._store) return false;
    let raw = null;
    try {
      raw = this._store.getItem(DRIVE_LINKS_KEY);
    } catch {
      this._persistent = false;
      return false;
    }
    this._links.clear();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    const rows = data && typeof data === 'object' && Array.isArray(data.links) ? data.links : Array.isArray(data) ? data : [];
    for (const r of rows) {
      const e = sanitize(r);
      if (!e) continue;
      const have = this._links.get(e.id);
      if (!have || e.lastImportedAt > have.lastImportedAt) this._links.set(e.id, e);
      this._last = Math.max(this._last, e.lastImportedAt, e.addedAt);
    }
    this._trim();
    return true;
  }

  /** Over the cap: the least recently used leave. */
  _trim() {
    if (this._links.size <= this._max) return;
    for (const e of this.list().slice(this._max)) this._links.delete(e.id);
  }

  _persist() {
    if (!this._store) return;
    try {
      if (this._links.size) {
        const links = this.list().map((e) => ({ ...e }));
        this._store.setItem(DRIVE_LINKS_KEY, JSON.stringify({ v: 1, links }));
      } else {
        this._store.removeItem(DRIVE_LINKS_KEY);
      }
      this._persistent = true;
    } catch {
      this._persistent = false; // blocked or full: kept in memory for this visit
    }
  }

  /**
   * Another tab changed the list (or cleared the site's storage): read it again. A list kept in memory only
   * (storage blocked) is this tab's own, so such an event never empties it.
   */
  _storageEvent(e) {
    if (!e || !this._store || (e.key !== DRIVE_LINKS_KEY && e.key !== null)) return;
    if (e.storageArea && e.storageArea !== this._store) return;
    if (this._load()) this.emit('change', 'storage');
  }
}
