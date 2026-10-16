// Remote song references and library entries for songs that live elsewhere (docs/SOURCES.md section 2).
// Pure helpers shared by the library and the sources:
//   sanitizeRemote({ kind: 'subsonic', serverId: 'srv-1', songId: 42 })  -> frozen { kind, serverId, songId: '42' }
//   remoteKey({ kind: 'gdrive', fileId: 'abc' })                         -> 'gdrive|abc'   (the dedupe key)
//   remoteEntry(details, remote, id, addedAt)    a library entry (stored: false) for a music-server song
//   refreshRemote(entry, details)                 copy the server's newer details onto a listed entry

/** Library entry sources. */
export const SOURCES = Object.freeze(['file', 'gdrive', 'subsonic']);
const SOURCE_SET = new Set(SOURCES);
/** Remote kinds that can be fetched again whenever needed (their offline copy can be dropped). */
export const ON_DEMAND_KINDS = Object.freeze(['subsonic']);

function isIdLike(v) {
  return (typeof v === 'string' && v.length > 0 && v.length <= 512) || Number.isFinite(v);
}

/** True for 'file' | 'gdrive' | 'subsonic'. */
export function isSource(s) {
  return SOURCE_SET.has(s);
}

/**
 * A clean, frozen remote reference, or null when it is not one: { kind: 'gdrive', fileId, resourceKey? },
 * { kind: 'subsonic', serverId, songId } or { kind, id } for other kinds.
 */
export function sanitizeRemote(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.kind === 'gdrive') {
    if (!isIdLike(r.fileId)) return null;
    const out = { kind: 'gdrive', fileId: String(r.fileId) };
    if (typeof r.resourceKey === 'string' && r.resourceKey) out.resourceKey = r.resourceKey.slice(0, 256);
    return Object.freeze(out);
  }
  if (r.kind === 'subsonic') {
    if (!isIdLike(r.serverId) || !isIdLike(r.songId)) return null;
    return Object.freeze({ kind: 'subsonic', serverId: String(r.serverId), songId: String(r.songId) });
  }
  if (typeof r.kind === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(r.kind) && isIdLike(r.id)) {
    return Object.freeze({ kind: r.kind, id: String(r.id) });
  }
  return null;
}

/** The dedupe key of a remote reference ('gdrive|<fileId>', 'subsonic|<serverId>|<songId>'), or null. */
export function remoteKey(remote) {
  const r = sanitizeRemote(remote);
  if (!r) return null;
  if (r.kind === 'gdrive') return `gdrive|${r.fileId}`;
  if (r.kind === 'subsonic') return `subsonic|${r.serverId}|${r.songId}`;
  return `${r.kind}|${r.id}`;
}

function str(v, max = 200) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/**
 * A library entry for a song that is listed without a stored file.
 * @param {object} x { title, artist, album?, duration?, bpm?, coverArt?, fileName?, size?, type? }
 * @param {object} remote a sanitized reference
 * @param {string} id
 * @param {number} at addedAt / lastUsedAt
 */
export function remoteEntry(x, remote, id, at) {
  const title = str(x.title);
  const artist = str(x.artist);
  const e = {
    id,
    title,
    artist,
    fileName: str(x.fileName, 260) || [artist, title].filter(Boolean).join(' - ') || 'song',
    size: Number.isFinite(x.size) && x.size > 0 ? x.size : 0,
    type: str(x.type, 100),
    lastModified: 0,
    addedAt: at,
    lastUsedAt: at,
    source: isSource(remote.kind) ? remote.kind : 'file',
    remote,
    stored: false,
  };
  if (x.album) e.album = str(x.album);
  if (x.coverArt) e.coverArt = str(String(x.coverArt), 512);
  if (Number.isFinite(x.duration) && x.duration > 0) e.duration = x.duration;
  if (Number.isFinite(x.bpm) && x.bpm > 0) e.bpm = x.bpm;
  return e;
}

/**
 * Copy the server's details onto a listed remote entry (title / artist / album / cover; size and type while no
 * copy is stored; duration and BPM only when the entry has none yet, since the app's analysis is better).
 * @returns {boolean} true when something changed
 */
export function refreshRemote(e, x) {
  let changed = false;
  const set = (k, v) => {
    if (v !== undefined && e[k] !== v) {
      e[k] = v;
      changed = true;
    }
  };
  if (str(x.title)) set('title', str(x.title));
  if (str(x.artist)) set('artist', str(x.artist));
  if (str(x.album)) set('album', str(x.album));
  if (x.coverArt) set('coverArt', str(String(x.coverArt), 512));
  if (!e.stored && Number.isFinite(x.size) && x.size > 0) set('size', x.size);
  if (!e.stored && str(x.type, 100)) set('type', str(x.type, 100));
  if (!(e.duration > 0) && Number.isFinite(x.duration) && x.duration > 0) set('duration', x.duration);
  if (!(e.bpm > 0) && Number.isFinite(x.bpm) && x.bpm > 0) set('bpm', x.bpm);
  return changed;
}

/** “Title” of an entry for messages ('this song' without one). */
export function songName(e) {
  const t = e && (e.title || e.fileName);
  return t ? `“${t}”` : 'this song';
}

/** The message for a remote song whose source is not connected. */
export function unavailableMessage(e) {
  if (e && e.remote && e.remote.kind === 'subsonic') {
    return `Connect to your music server to play ${songName(e)} (Songs > Add music > Music server).`;
  }
  if (e && e.remote && e.remote.kind === 'gdrive') {
    return `${songName(e)} is no longer stored on this device. Add it again from Google Drive.`;
  }
  return `${songName(e)} is not available right now.`;
}

/**
 * The remote reference of file `i` of a library.add(files, opts) call: `opts.remote` as an array (one per file)
 * or a function (file, i), then the File's own `remote` / `driveFileId`, then `opts.remote` as one object (only
 * when a single file is added: it would give several files the same id). A bare { fileId } means Google Drive.
 * @returns {object|null} a sanitized reference
 */
export function remoteForFile(f, i, opts, count) {
  const o = opts || {};
  let r = null;
  if (Array.isArray(o.remote)) r = o.remote[i];
  else if (typeof o.remote === 'function') {
    try {
      r = o.remote(f, i);
    } catch {
      r = null;
    }
  }
  if (!r && f && f.remote) r = f.remote;
  if (!r && f && f.driveFileId) r = { kind: 'gdrive', fileId: f.driveFileId };
  if (!r && o.remote && typeof o.remote === 'object' && !Array.isArray(o.remote) && count === 1) r = o.remote;
  if (r && typeof r === 'object' && !r.kind && r.fileId) r = { kind: 'gdrive', ...r };
  return sanitizeRemote(r);
}
