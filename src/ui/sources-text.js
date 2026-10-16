// Song sources in plain words (pure, tested in tests/ui-sources.test.js): where a library song comes from (its
// small cloud / server badge), import and download progress lines, the "Other ways" hints for each platform,
// the music-server address hint, and readers that turn Subsonic / OpenSubsonic answers (whole JSON responses,
// the inner 'subsonic-response' object, or the part a client already unwrapped) into plain lists for the music
// server browser. docs/SOURCES.md sections 3-4.
//   remoteKind(entry) === 'server';  progressLine({ done: 2, total: 8, bytes, totalBytes })
//   listAlbums(await client.getAlbumList2('newest', 40, 0))   // [{ id, name, artist, coverArt, ... }]

import { fmtBytes } from './format.js';
import { fmtTime } from '../core/util.js';

/** The setup guides on GitHub (the app links to them) and the privacy page next to the app. */
export const GUIDES = Object.freeze({
  drive: 'https://github.com/Ranama/twinspin/blob/main/docs/GOOGLE_DRIVE.md',
  nas: 'https://github.com/Ranama/twinspin/blob/main/docs/SYNOLOGY.md',
  privacy: 'privacy.html',
});

// ---- where a song comes from ------------------------------------------------------------------------------------

/** 'gdrive' | 'server' | null for a library entry (or a set-list item's library entry). */
export function remoteKind(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const kind = entry.remote && typeof entry.remote === 'object' ? entry.remote.kind : null;
  if (entry.source === 'gdrive' || kind === 'gdrive') return 'gdrive';
  if (entry.source === 'subsonic' || kind === 'subsonic') return 'server';
  return null;
}

/** True for a music-server song that is not saved on this device (it downloads when it is loaded). */
export function needsDownload(entry) {
  return remoteKind(entry) === 'server' && entry.stored !== true;
}

/**
 * The small badge in front of a song title, or null for a song from this device.
 * @returns {{kind:'gdrive'|'server', icon:string, label:string, offline:boolean}|null}
 */
export function sourceBadge(entry) {
  const kind = remoteKind(entry);
  if (!kind) return null;
  if (kind === 'gdrive') return { kind, icon: 'cloud', label: 'From Google Drive', offline: true };
  const offline = entry.stored === true;
  return {
    kind, icon: 'server', offline,
    label: offline ? 'From your music server, saved on this device' : 'On your music server (downloads when you play it)',
  };
}

// ---- progress ---------------------------------------------------------------------------------------------------

/**
 * Normalise a progress report: { done, total, bytes, totalBytes, name } from a source 'progress' event, or the
 * (loaded, total) / ({ loaded | bytes, total | totalBytes }) arguments of an onProgress callback.
 */
export function progressOf(a, b) {
  const pick = (...vs) => {
    for (const v of vs) if (Number.isFinite(v) && v >= 0) return v;
    return 0;
  };
  if (a && typeof a === 'object') {
    // a source 'progress' event counts files in `total` (and bytes in totalBytes); a fetch-style report
    // ({ loaded, total }) counts bytes in `total`
    const files = a.done != null || a.totalBytes != null;
    return {
      done: pick(a.done),
      total: files ? pick(a.total) : 0,
      bytes: pick(a.bytes, a.loaded, a.got),
      totalBytes: files ? pick(a.totalBytes) : pick(a.total),
      name: typeof a.name === 'string' ? a.name : '',
    };
  }
  return { done: 0, total: 0, bytes: pick(a), totalBytes: pick(b), name: '' };
}

/** 0..1 for a progress bar, or null when the size is unknown (an indeterminate bar). */
export function progressFraction(p) {
  if (!p) return null;
  if (p.totalBytes > 0) return Math.min(1, Math.max(0, p.bytes / p.totalBytes));
  if (p.total > 0) return Math.min(1, Math.max(0, p.done / p.total));
  return null;
}

/** '3 of 8 · 12 of 40 MB' / '1.2 MB' / '' (the import bar's second line). */
export function progressLine(p) {
  if (!p) return '';
  const parts = [];
  if (p.total > 1) parts.push(`${Math.min(p.done, p.total)} of ${p.total}`);
  if (p.totalBytes > 0) parts.push(`${mb(p.bytes, p.totalBytes)} of ${fmtBytes(p.totalBytes)}`);
  else if (p.bytes > 0) parts.push(fmtBytes(p.bytes));
  return parts.join(' · ');
}

/** The numeric part of `bytes` in the unit fmtBytes picks for `total` ('12' of '40 MB'). */
function mb(bytes, total) {
  const unit = fmtBytes(total).split(' ')[1];
  const div = unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : 1024;
  const v = Math.max(0, bytes) / div;
  if (unit === 'KB') return String(Math.round(v));
  return v < 10 ? v.toFixed(1) : String(Math.round(v));
}

/** Percent text for a deck chip / player line: 'Downloading 45%', or 'Downloading…' before the first bytes. */
export function downloadText(p) {
  const f = progressFraction(p);
  return f == null || !(p.bytes > 0) ? 'Downloading…' : `Downloading ${Math.round(f * 100)}%`;
}

// ---- errors -------------------------------------------------------------------------------------------------------

/** True for a cancelled download / import (AbortController). */
export function isAbort(err) {
  return !!err && (err.name === 'AbortError' || err.code === 20 || err === 'abort');
}

/**
 * The words to show for a failure: the source's own plain message, or `fallback` for raw browser errors
 * ("Failed to fetch", "Load failed", "NetworkError ...", a TypeError) and empty messages.
 */
export function errText(err, fallback) {
  const msg = err && typeof err === 'object' ? err.message : typeof err === 'string' ? err : '';
  const m = String(msg || '').trim();
  if (!m) return fallback;
  if (err && err.name === 'TypeError') return fallback;
  if (/^(failed to fetch|load failed|networkerror|network error|the operation was aborted|aborted)/i.test(m)) return fallback;
  if (/^[A-Za-z]*Error:/.test(m) || /\bis not a function\b|\bundefined\b|\bnull\b/.test(m)) return fallback;
  return m;
}

// ---- the music server address -----------------------------------------------------------------------------------

const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1\]?|[^.]+\.local|[^.]+)$/i;

/** The host of an address the user typed ('' when it is not an address yet). */
export function hostOf(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]+)/i.exec(t);
  return m ? m[1].toLowerCase() : '';
}

/**
 * A short warning under the address field, or '' when the address looks fine.
 * @param {string} text  what the user typed
 * @param {{pageHttps?:boolean}} [o]  true when TwinSpin itself runs on https (the published app)
 */
export function serverUrlHint(text, { pageHttps = true } = {}) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return '';  // TwinSpin adds https:// itself
  if (!/^https?:\/\//i.test(t)) return 'The address starts with https:// (for example https://music.yourname.synology.me).';
  if (/^https:/i.test(t) || !pageHttps) return '';
  const host = hostOf(t);
  if (PRIVATE_HOST.test(host)) {
    return 'An http:// address at home only works in Chrome on a computer or Android (it asks to allow local ' +
      'network access). On iPhone, and away from home, use your https://….synology.me address.';
  }
  return 'Browsers block http:// servers from TwinSpin. Use the https:// address of your server.';
}

// ---- "Other ways" (the phone's own file picker reaches Drive and the NAS too) -------------------------------------

/**
 * Hint cards for the Add music sheet, the current platform first.
 * @param {{ios?:boolean, android?:boolean}} env
 * @returns {{id:string, title:string, items:string[]}[]}
 */
export function otherWays(env = {}) {
  const iphone = {
    id: 'iphone',
    title: 'iPhone and iPad (Files app)',
    items: [
      'Google Drive: install the Google Drive app and sign in. Then Add music > This device > Browse > Drive ' +
        '(Google Drive in the Files app).',
      'Synology Drive: install the Synology Drive app (iOS 18 or later) and sign in with your QuickConnect ID. ' +
        'Your NAS folders then show as “Synology Drive” in Browse, at home and away.',
      'At home: open the Files app > ⋯ > Connect to Server > smb://<your NAS address>, sign in, then pick from ' +
        'Browse > Shared in TwinSpin.',
    ],
  };
  const android = {
    id: 'android',
    title: 'Android (system file picker)',
    items: [
      'Google Drive: Add music > This device, open the menu (☰) of the file picker and choose Drive.',
      'NAS at home: install CIFS Documents Provider, add your NAS (SMB) once, then pick your NAS in the same menu.',
      'Synology Drive app (Android 10 or later): sync your music folder to the phone, then pick it from the phone’s storage.',
    ],
  };
  const computer = {
    id: 'computer',
    title: 'Computer',
    items: [
      'Google Drive for desktop shows your Drive as a folder or drive letter: Add music > This device picks from it.',
      'Windows: File Explorer > This PC > Map network drive > \\\\<your NAS>\\music. Mac: Finder > Go > Connect to ' +
        'Server > smb://<your NAS>/music.',
    ],
  };
  if (env.ios) return [iphone, android, computer];
  if (env.android) return [android, iphone, computer];
  return [computer, iphone, android];
}

// ---- Subsonic / OpenSubsonic answers ------------------------------------------------------------------------------

/** The inner object of an answer: { status, artists: ... } (also accepts an unwrapped part). */
export function subsonicBody(res) {
  if (!res || typeof res !== 'object') return {};
  const inner = res['subsonic-response'];
  return inner && typeof inner === 'object' ? inner : res;
}

const arr = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []);
const str = (v) => (v == null ? '' : String(v));
const num = (v) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : 0);

function artist(a) {
  return a && a.id != null
    ? { id: str(a.id), name: str(a.name) || 'Unknown artist', albumCount: num(a.albumCount), coverArt: str(a.coverArt || '') }
    : null;
}

function album(a) {
  return a && a.id != null
    ? {
      id: str(a.id), name: str(a.name || a.title || a.album) || 'Unknown album', artist: str(a.artist || a.displayArtist),
      artistId: str(a.artistId || ''), coverArt: str(a.coverArt || ''), songCount: num(a.songCount),
      duration: num(a.duration), year: num(a.year),
    }
    : null;
}

/** A song as the browser shows it; `raw` is what the server sent (MusicServerSource.toEntries takes it). */
function song(s) {
  if (!s || s.id == null || s.isDir === true) return null;
  return {
    id: str(s.id), title: str(s.title || s.name) || 'Untitled', artist: str(s.artist || s.displayArtist),
    album: str(s.album), albumId: str(s.albumId || ''), coverArt: str(s.coverArt || ''), duration: num(s.duration),
    bpm: num(s.bpm), track: num(s.track), size: num(s.size), suffix: str(s.suffix), raw: s,
  };
}

const clean = (list, fn) => list.map(fn).filter(Boolean);

/** Artists from getArtists (index letters flattened), getArtist, search3 or a plain array. */
export function listArtists(res) {
  if (Array.isArray(res)) return clean(res, artist);
  const b = subsonicBody(res);
  if (b.artists) {
    const a = b.artists;
    if (Array.isArray(a)) return clean(a, artist);
    const idx = arr(a.index);
    if (idx.length) return clean(idx.flatMap((i) => arr(i && i.artist)), artist);
    return clean(arr(a.artist), artist);
  }
  if (b.index) return clean(arr(b.index).flatMap((i) => arr(i && i.artist)), artist);
  if (b.searchResult3) return clean(arr(b.searchResult3.artist), artist);
  if (b.artist && Array.isArray(b.artist)) return clean(b.artist, artist);
  return [];
}

/** Albums from getAlbumList2, getArtist (its albums), search3 or a plain array. */
export function listAlbums(res) {
  if (Array.isArray(res)) return clean(res, album);
  const b = subsonicBody(res);
  if (b.albumList2) return clean(arr(b.albumList2.album), album);
  if (b.albumList) return clean(arr(b.albumList.album), album);
  if (b.artist && !Array.isArray(b.artist) && b.artist.album) return clean(arr(b.artist.album), album);
  if (b.searchResult3) return clean(arr(b.searchResult3.album), album);
  if (Array.isArray(b.album)) return clean(b.album, album);
  return [];
}

/** Songs from getAlbum, getPlaylist, search3, getRandomSongs or a plain array (folders are skipped). */
export function listSongs(res) {
  if (Array.isArray(res)) return clean(res, song);
  const b = subsonicBody(res);
  if (b.album && !Array.isArray(b.album) && b.album.song) return clean(arr(b.album.song), song);
  if (b.playlist && !Array.isArray(b.playlist)) return clean(arr(b.playlist.entry), song);
  if (b.searchResult3) return clean(arr(b.searchResult3.song), song);
  if (b.randomSongs) return clean(arr(b.randomSongs.song), song);
  if (Array.isArray(b.song)) return clean(b.song, song);
  if (Array.isArray(b.entry)) return clean(b.entry, song);
  return [];
}

/** Playlists from getPlaylists or a plain array. */
export function listPlaylists(res) {
  const one = (p) => (p && p.id != null
    ? { id: str(p.id), name: str(p.name) || 'Playlist', songCount: num(p.songCount), duration: num(p.duration),
      coverArt: str(p.coverArt || ''), owner: str(p.owner || '') }
    : null);
  if (Array.isArray(res)) return clean(res, one);
  const b = subsonicBody(res);
  if (b.playlists) return clean(arr(Array.isArray(b.playlists) ? b.playlists : b.playlists.playlist), one);
  return [];
}

/** One album with its songs (getAlbum), or one playlist with its songs (getPlaylist). */
export function albumOf(res) {
  const b = subsonicBody(res);
  const a = album(b.album && !Array.isArray(b.album) ? b.album : b.id != null ? b : null);
  return a ? { ...a, songs: listSongs(res) } : null;
}

export function playlistOf(res) {
  const b = subsonicBody(res);
  const p = b.playlist && !Array.isArray(b.playlist) ? b.playlist : b.id != null ? b : null;
  if (!p) return null;
  const [head] = listPlaylists([p]);
  return head ? { ...head, songs: listSongs(Array.isArray(p.entry) ? p.entry : res) } : null;
}

/** One artist with its albums (getArtist). */
export function artistOf(res) {
  const b = subsonicBody(res);
  const a = artist(b.artist && !Array.isArray(b.artist) ? b.artist : b.id != null ? b : null);
  return a ? { ...a, albums: listAlbums(b.artist && !Array.isArray(b.artist) ? b.artist.album || [] : b.album || []) } : null;
}

/** search3 results. */
export function searchOf(res) {
  const b = subsonicBody(res);
  const r = b.searchResult3 || b;
  return {
    artists: clean(arr(r.artist), artist),
    albums: clean(arr(r.album), album),
    songs: clean(arr(r.song), song),
  };
}

// ---- lines under titles -------------------------------------------------------------------------------------------

/** 'Artist · 124 BPM · 3:45' for a server song (the album line skips the artist: `withArtist` false). */
export function songLine(s, { withArtist = true } = {}) {
  if (!s) return '';
  const parts = [];
  if (withArtist && s.artist) parts.push(s.artist);
  if (s.bpm > 0) parts.push(`${Math.round(s.bpm)} BPM`);
  if (s.duration > 0) parts.push(fmtTime(s.duration));
  return parts.join(' · ');
}

/** 'Artist · 2025 · 12 songs' (parts left out when unknown). */
export function albumLine(a, { withArtist = true } = {}) {
  if (!a) return '';
  const parts = [];
  if (withArtist && a.artist) parts.push(a.artist);
  if (a.year > 0) parts.push(String(a.year));
  if (a.songCount > 0) parts.push(countWord(a.songCount, 'song'));
  return parts.join(' · ');
}

/** '12 songs · 48:10' for a playlist. */
export function playlistLine(p) {
  if (!p) return '';
  const parts = [];
  if (p.songCount > 0) parts.push(countWord(p.songCount, 'song'));
  if (p.duration > 0) parts.push(fmtTime(p.duration));
  return parts.join(' · ');
}

/** '1 song' / '3 songs'. */
export function countWord(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The first `shown` items and how many are left (lists render a page at a time). */
export function pageOf(list, shown) {
  const items = Array.isArray(list) ? list : [];
  const n = Math.max(0, Math.min(items.length, Math.floor(shown) || 0));
  return { items: items.slice(0, n), left: items.length - n };
}

/** A label for the connected server: its name, else its host ('music.example.com'). */
export function serverLabel(server) {
  if (!server) return '';
  const name = str(server.name).trim();
  if (name) return name;
  return hostOf(server.url) || 'Music server';
}

/**
 * 'Navidrome 0.64.2' from the server's own version (OpenSubsonic `serverVersion`, without a build note such as
 * '(5f3a1c2)'); 'Navidrome' when it has none; 'Subsonic API 1.16.1' for a server that names no product (`version`
 * is the API version, not the server's); '' when the server did not say.
 */
export function serverKind(server) {
  if (!server) return '';
  const t = str(server.type).trim();
  const type = t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
  const product = str(server.serverVersion).trim().split(/\s+/)[0] || '';
  if (type) return [type, product].filter(Boolean).join(' ');
  const api = str(server.version).trim();
  return api ? `Subsonic API ${api}` : '';
}
