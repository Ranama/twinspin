// Song title/artist reader for the songs list and the deck chips. Pure: no DOM, no Web Audio.
//   readTags(arrayBuffer, 'Artist - Title.mp3')          -> { title, artist, fileName }
//   readTags(head, file.name, last128Bytes)               // the tail lets it find an ID3v1 tag too
// Understands ID3v2.2 / 2.3 / 2.4 (ISO-8859-1, UTF-16 with or without BOM, UTF-16BE, UTF-8; syncsafe sizes,
// unsynchronisation, extended headers, the common "UTF-8 written as Latin-1" mistake), ID3v1, MP4/M4A 'ilst'
// atoms, FLAC and Ogg (Vorbis, Opus, FLAC-in-Ogg) Vorbis comments, WAV LIST/INFO and 'id3 ' chunks and AIFF
// NAME/AUTH/'ID3 ' chunks. Whatever is missing comes from the file name: "Artist - Title.mp3" is split on
// " - ", a leading track number is dropped, underscores become spaces. Never throws.

const MAX_TEXT = 200;
const MAX_ITEMS = 2000;

/**
 * Read title and artist from the first bytes of an audio file (the whole file works too; scanning is bounded).
 * @param {ArrayBuffer|ArrayBufferView|null} buffer
 * @param {string} fileName
 * @param {ArrayBuffer|ArrayBufferView|null} [tail] the last 128 bytes of the file (ID3v1), optional
 * @returns {{ title: string, artist: string, fileName: string }}
 */
export function readTags(buffer, fileName = '', tail = null) {
  const name = typeof fileName === 'string' ? fileName : '';
  const fromName = parseFileName(name);
  let found = null;
  try {
    const bytes = toBytes(buffer);
    if (bytes && bytes.length >= 4) found = sniff(bytes);
  } catch {
    found = null;
  }
  if (!found || (!found.title && !found.artist)) {
    try {
      const t = toBytes(tail);
      const v1 = t ? readId3v1(t) : null;
      if (v1) found = v1;
    } catch {
      /* ignore */
    }
  }
  const tagTitle = clean(found && found.title);
  const tagArtist = clean(found && (found.artist || found.albumArtist));
  if (!tagTitle && !tagArtist) return { title: fromName.title, artist: fromName.artist, fileName: name };
  return { title: tagTitle || fromName.title, artist: tagArtist, fileName: name };
}

/**
 * Title/artist guess from a file name: "03 - Artist - Song_Name (Remix).mp3" -> { artist: 'Artist',
 * title: 'Song Name (Remix)' }.
 * @param {string} fileName
 * @returns {{ title: string, artist: string }}
 */
export function parseFileName(fileName) {
  let base = String(fileName || '').replace(/^.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  if (dot > 0 && base.length - dot <= 6) base = base.slice(0, dot);
  base = base.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = base.split(/\s+[-–—]\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1 && /^\d{1,3}\.?$/.test(parts[0])) parts.shift();
  if (parts.length >= 2) return { artist: clean(parts[0]), title: clean(parts.slice(1).join(' - ')) };
  let title = parts.length ? parts[0] : base;
  // "01 Title" / "1. Title": a track number with a leading zero or a dot.
  const m = /^(?:0\d{1,2}|\d{1,3}\.)\s+(.+)$/.exec(title);
  if (m) title = m[1];
  return { artist: '', title: clean(title) || 'Untitled' };
}

// ---------------------------------------------------------------------------------------------------------
// Format detection

function sniff(b) {
  if (isAscii(b, 0, 'ID3')) {
    const id3 = readId3v2(b, 0);
    if (id3 && (id3.title || id3.artist || id3.albumArtist)) return id3;
    // FLAC (and some other formats) may carry a leading ID3v2 tag: look behind it.
    const after = id3v2Length(b, 0);
    if (after > 0 && after + 4 <= b.length && isAscii(b, after, 'fLaC')) return readFlac(b, after + 4);
    return id3;
  }
  if (isAscii(b, 0, 'fLaC')) return readFlac(b, 4);
  if (isAscii(b, 0, 'OggS')) return readOgg(b);
  if (b.length >= 12 && isAscii(b, 4, 'ftyp')) return readMp4(b);
  if (b.length >= 12 && isAscii(b, 0, 'RIFF') && isAscii(b, 8, 'WAVE')) return readRiff(b);
  if (b.length >= 12 && isAscii(b, 0, 'FORM') && (isAscii(b, 8, 'AIFF') || isAscii(b, 8, 'AIFC'))) return readAiff(b);
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// ID3v2

function id3v2Length(b, off) {
  if (b.length < off + 10) return 0;
  const size = syncsafe(b, off + 6);
  return off + 10 + size + (b[off + 5] & 0x10 ? 10 : 0);
}

function readId3v2(b, off) {
  if (b.length < off + 10) return null;
  const major = b[off + 3];
  const flags = b[off + 5];
  if (major < 2 || major > 4) return null;
  if (major === 2 && flags & 0x40) return null; // compressed v2.2 tag: no defined scheme
  const size = syncsafe(b, off + 6);
  let body = b.subarray(off + 10, Math.min(b.length, off + 10 + size));
  if (flags & 0x80 && major < 4) body = unsync(body);
  let p = 0;
  if (flags & 0x40) {
    if (major === 3) p = 4 + be32(body, 0);
    else if (major === 4) p = syncsafe(body, 0);
  }
  const out = { title: '', artist: '', albumArtist: '' };
  const idLen = major === 2 ? 3 : 4;
  const hdr = major === 2 ? 6 : 10;
  let guard = 0;
  while (p + hdr <= body.length && guard++ < MAX_ITEMS) {
    const id = ascii(body, p, idLen);
    if (!/^[A-Z0-9]+$/.test(id) || id.length !== idLen) break; // padding or garbage
    let fsize;
    if (major === 2) fsize = (body[p + 3] << 16) | (body[p + 4] << 8) | body[p + 5];
    else if (major === 3) fsize = be32(body, p + 4);
    else fsize = v24FrameSize(body, p);
    if (fsize <= 0 || p + hdr + fsize > body.length) {
      // A truncated last frame (head-only buffer) can still hold a usable text start.
      if (fsize > 0 && p + hdr < body.length) fsize = body.length - p - hdr;
      else break;
    }
    const fmt = major === 2 ? 0 : body[p + 9];
    let frame = body.subarray(p + hdr, p + hdr + fsize);
    let skip = false;
    if (major === 3) {
      if (fmt & 0xc0) skip = true; // compressed or encrypted
      else if (fmt & 0x20) frame = frame.subarray(1); // grouping identity
    } else if (major === 4) {
      if (fmt & 0x0c) skip = true; // compressed or encrypted
      else {
        if (fmt & 0x40) frame = frame.subarray(1);
        if (fmt & 0x01) frame = frame.subarray(4);
        if (fmt & 0x02 || flags & 0x80) frame = unsync(frame);
      }
    }
    if (!skip) {
      if (id === 'TIT2' || id === 'TT2') out.title = out.title || decodeId3Text(frame);
      else if (id === 'TPE1' || id === 'TP1') out.artist = out.artist || decodeId3Text(frame);
      else if (id === 'TPE2' || id === 'TP2') out.albumArtist = out.albumArtist || decodeId3Text(frame);
    }
    p += hdr + fsize;
    if (out.title && out.artist) break;
  }
  return out;
}

/** v2.4 frame sizes are syncsafe, but some writers (old iTunes) stored plain 32-bit sizes. */
function v24FrameSize(body, p) {
  const plain = be32(body, p + 4);
  if (body[p + 4] & 0x80 || body[p + 5] & 0x80 || body[p + 6] & 0x80 || body[p + 7] & 0x80) return plain;
  const safe = syncsafe(body, p + 4);
  if (safe === plain) return safe;
  if (frameBoundary(body, p + 10 + safe)) return safe;
  if (frameBoundary(body, p + 10 + plain)) return plain;
  return safe;
}

function frameBoundary(b, pos) {
  if (pos === b.length) return true;
  if (pos > b.length) return false;
  if (b[pos] === 0) return true;
  return pos + 4 <= b.length && /^[A-Z0-9]{4}$/.test(ascii(b, pos, 4));
}

function decodeId3Text(frame) {
  if (!frame || frame.length < 2) return '';
  const enc = frame[0];
  const d = frame.subarray(1);
  let s;
  if (enc === 1) s = utf16(d, null);
  else if (enc === 2) s = utf16(d, false);
  else if (enc === 3) s = utf8(d);
  else s = looksLikeUtf8(d) ? utf8(d) : latin1(d);
  const nul = s.indexOf('\u0000');
  return nul >= 0 ? s.slice(0, nul) : s;
}

function readId3v1(t) {
  if (t.length < 128) return null;
  const o = t.length - 128;
  if (!isAscii(t, o, 'TAG')) return null;
  const field = (start, len) => {
    const d = t.subarray(o + start, o + start + len);
    let end = d.indexOf(0);
    if (end < 0) end = d.length;
    const sub = d.subarray(0, end);
    return looksLikeUtf8(sub) ? utf8(sub) : latin1(sub);
  };
  const title = field(3, 30);
  const artist = field(33, 30);
  return title.trim() || artist.trim() ? { title, artist } : null;
}

// ---------------------------------------------------------------------------------------------------------
// MP4 / M4A

function findBox(b, start, end, type) {
  let p = start;
  let guard = 0;
  while (p + 8 <= end && guard++ < MAX_ITEMS) {
    let size = be32(b, p);
    const t = ascii(b, p + 4, 4);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) return null;
      size = be32(b, p + 8) * 4294967296 + be32(b, p + 12);
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header) return null;
    if (t === type) return { start: p + header, end: Math.min(end, p + size) };
    p += size;
  }
  return null;
}

function readMp4(b) {
  const moov = findBox(b, 0, b.length, 'moov');
  if (!moov) return null;
  const udta = findBox(b, moov.start, moov.end, 'udta');
  let meta = udta ? findBox(b, udta.start, udta.end, 'meta') : null;
  if (!meta) meta = findBox(b, moov.start, moov.end, 'meta');
  if (!meta) return null;
  // 'meta' is a full box (4 bytes version/flags) in ISO files, a plain box in some QuickTime files.
  let ms = meta.start;
  if (ms + 8 <= meta.end && !/^[a-z]{4}$/.test(ascii(b, ms + 4, 4))) ms += 4;
  const ilst = findBox(b, ms, meta.end, 'ilst');
  if (!ilst) return null;
  const out = { title: '', artist: '', albumArtist: '' };
  let p = ilst.start;
  let guard = 0;
  while (p + 8 <= ilst.end && guard++ < MAX_ITEMS) {
    const size = be32(b, p);
    if (size < 8) break;
    const t = ascii(b, p + 4, 4);
    const end = Math.min(ilst.end, p + size);
    const key = t === '©nam' ? 'title' : t === '©ART' ? 'artist' : t === 'aART' ? 'albumArtist' : null;
    if (key && !out[key]) {
      const data = findBox(b, p + 8, end, 'data');
      if (data && data.start + 8 <= data.end) {
        const type = be32(b, data.start) & 0xffffff;
        const v = b.subarray(data.start + 8, data.end);
        out[key] = type === 2 ? utf16(v, false) : utf8(v);
      }
    }
    p += size;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// FLAC / Ogg Vorbis comments

function readFlac(b, off) {
  let p = off;
  let guard = 0;
  while (p + 4 <= b.length && guard++ < 128) {
    const h = b[p];
    const len = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    if ((h & 0x7f) === 4) return parseVorbisComment(b.subarray(p + 4, Math.min(b.length, p + 4 + len)));
    if (h & 0x80) break;
    p += 4 + len;
  }
  return null;
}

function parseVorbisComment(d) {
  if (d.length < 8) return null;
  const vendorLen = le32(d, 0);
  let p = 4 + vendorLen;
  if (p + 4 > d.length) return null;
  const count = Math.min(le32(d, p), MAX_ITEMS);
  p += 4;
  const out = { title: '', artist: '', albumArtist: '' };
  for (let i = 0; i < count && p + 4 <= d.length; i++) {
    const l = le32(d, p);
    p += 4;
    if (l > 4096) {
      p += l; // pictures and other big blobs
      continue;
    }
    const s = utf8(d.subarray(p, Math.min(d.length, p + l)));
    p += l;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const k = s.slice(0, eq).toUpperCase();
    const v = s.slice(eq + 1);
    if (k === 'TITLE' && !out.title) out.title = v;
    else if (k === 'ARTIST' && !out.artist) out.artist = v;
    else if ((k === 'ALBUMARTIST' || k === 'ALBUM ARTIST') && !out.albumArtist) out.albumArtist = v;
  }
  return out;
}

function readOgg(b) {
  const packets = [];
  let cur = [];
  let p = 0;
  let pages = 0;
  while (p + 27 <= b.length && pages < 256 && packets.length < 2) {
    if (!isAscii(b, p, 'OggS')) break;
    const nseg = b[p + 26];
    const segTable = p + 27;
    let dataPos = segTable + nseg;
    if (dataPos > b.length) break;
    for (let i = 0; i < nseg; i++) {
      const lace = b[segTable + i];
      cur.push(b.subarray(dataPos, Math.min(b.length, dataPos + lace)));
      dataPos += lace;
      if (lace < 255) {
        packets.push(concat(cur));
        cur = [];
        if (packets.length >= 2) break;
      }
    }
    p = dataPos;
    pages++;
  }
  if (packets.length < 2 && cur.length) packets.push(concat(cur)); // truncated comment packet
  if (packets.length < 2) return null;
  const id = packets[0];
  const c = packets[1];
  if (id.length >= 7 && id[0] === 1 && isAscii(id, 1, 'vorbis')) {
    if (c[0] === 3 && isAscii(c, 1, 'vorbis')) return parseVorbisComment(c.subarray(7));
  } else if (isAscii(id, 0, 'OpusHead')) {
    if (isAscii(c, 0, 'OpusTags')) return parseVorbisComment(c.subarray(8));
  } else if (id[0] === 0x7f && isAscii(id, 1, 'FLAC')) {
    if ((c[0] & 0x7f) === 4) return parseVorbisComment(c.subarray(4));
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// WAV / AIFF

function readRiff(b) {
  const out = { title: '', artist: '', albumArtist: '' };
  let p = 12;
  let guard = 0;
  while (p + 8 <= b.length && guard++ < MAX_ITEMS) {
    const id = ascii(b, p, 4);
    const size = le32(b, p + 4);
    const start = p + 8;
    const end = Math.min(b.length, start + size);
    if (id === 'LIST' && isAscii(b, start, 'INFO')) {
      let q = start + 4;
      while (q + 8 <= end) {
        const sid = ascii(b, q, 4);
        const sl = le32(b, q + 4);
        const v = cString(b.subarray(q + 8, Math.min(end, q + 8 + sl)));
        if (sid === 'INAM' && !out.title) out.title = v;
        else if (sid === 'IART' && !out.artist) out.artist = v;
        q += 8 + sl + (sl & 1);
      }
    } else if ((id === 'id3 ' || id === 'ID3 ') && isAscii(b, start, 'ID3')) {
      const t = readId3v2(b.subarray(start, end), 0);
      if (t) {
        out.title = out.title || t.title;
        out.artist = out.artist || t.artist;
        out.albumArtist = out.albumArtist || t.albumArtist;
      }
    }
    p = start + size + (size & 1);
  }
  return out;
}

function readAiff(b) {
  const out = { title: '', artist: '', albumArtist: '' };
  let p = 12;
  let guard = 0;
  while (p + 8 <= b.length && guard++ < MAX_ITEMS) {
    const id = ascii(b, p, 4);
    const size = be32(b, p + 4);
    const start = p + 8;
    const end = Math.min(b.length, start + size);
    if (id === 'NAME' && !out.title) out.title = cString(b.subarray(start, end));
    else if (id === 'AUTH' && !out.artist) out.artist = cString(b.subarray(start, end));
    else if (id === 'ID3 ' && isAscii(b, start, 'ID3')) {
      const t = readId3v2(b.subarray(start, end), 0);
      if (t) {
        out.title = out.title || t.title;
        out.artist = out.artist || t.artist;
      }
    }
    p = start + size + (size & 1);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Byte and text helpers

function toBytes(buf) {
  if (!buf) return null;
  if (buf instanceof Uint8Array) return buf;
  if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  return null;
}

const be32 = (b, p) => (p + 4 <= b.length ? ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0 : 0);
const le32 = (b, p) => (p + 4 <= b.length ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0 : 0);
const syncsafe = (b, p) => ((b[p] & 0x7f) << 21) | ((b[p + 1] & 0x7f) << 14) | ((b[p + 2] & 0x7f) << 7) | (b[p + 3] & 0x7f);

function ascii(b, p, n) {
  let s = '';
  for (let i = 0; i < n && p + i < b.length; i++) s += String.fromCharCode(b[p + i]);
  return s;
}

function isAscii(b, p, str) {
  if (p + str.length > b.length) return false;
  for (let i = 0; i < str.length; i++) if (b[p + i] !== str.charCodeAt(i)) return false;
  return true;
}

function concat(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Remove ID3 unsynchronisation: every 0xFF 0x00 becomes 0xFF. */
function unsync(d) {
  let hits = 0;
  for (let i = 0; i + 1 < d.length; i++) if (d[i] === 0xff && d[i + 1] === 0) hits++;
  if (!hits) return d;
  const out = new Uint8Array(d.length - hits);
  let o = 0;
  for (let i = 0; i < d.length; i++) {
    out[o++] = d[i];
    if (d[i] === 0xff && i + 1 < d.length && d[i + 1] === 0) i++;
  }
  return out;
}

function fromCodes(codes) {
  let s = '';
  for (let i = 0; i < codes.length; i += 4096) s += String.fromCharCode.apply(null, codes.slice(i, i + 4096));
  return s;
}

function latin1(d) {
  const codes = [];
  for (let i = 0; i < d.length && i < 4096; i++) codes.push(d[i]);
  return fromCodes(codes);
}

function cString(d) {
  let end = d.indexOf(0);
  if (end < 0) end = d.length;
  const sub = d.subarray(0, end);
  return looksLikeUtf8(sub) ? utf8(sub) : latin1(sub);
}

/** UTF-16 until the first NUL code unit. `little`: true/false, or null = read the BOM (default little endian). */
function utf16(d, little) {
  let p = 0;
  let le = little;
  if (d.length >= 2 && d[0] === 0xff && d[1] === 0xfe) {
    le = true;
    p = 2;
  } else if (d.length >= 2 && d[0] === 0xfe && d[1] === 0xff) {
    le = false;
    p = 2;
  } else if (le === null) {
    le = true;
  }
  const codes = [];
  for (; p + 1 < d.length && codes.length < 4096; p += 2) {
    const c = le ? d[p] | (d[p + 1] << 8) : (d[p] << 8) | d[p + 1];
    if (c === 0) break;
    codes.push(c);
  }
  return fromCodes(codes);
}

function utf8(d) {
  const codes = [];
  const n = Math.min(d.length, 8192);
  for (let i = 0; i < n; ) {
    const c = d[i];
    if (c < 0x80) {
      codes.push(c);
      i++;
      continue;
    }
    let need = 0;
    let cp = 0;
    if (c >= 0xc2 && c <= 0xdf) {
      need = 1;
      cp = c & 0x1f;
    } else if (c >= 0xe0 && c <= 0xef) {
      need = 2;
      cp = c & 0x0f;
    } else if (c >= 0xf0 && c <= 0xf4) {
      need = 3;
      cp = c & 0x07;
    } else {
      codes.push(0xfffd);
      i++;
      continue;
    }
    if (i + need >= n) {
      codes.push(0xfffd);
      break;
    }
    let ok = true;
    for (let k = 1; k <= need; k++) {
      const cc = d[i + k];
      if ((cc & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (cc & 0x3f);
    }
    if (!ok) {
      codes.push(0xfffd);
      i++;
      continue;
    }
    i += need + 1;
    if (cp >= 0x10000) {
      cp -= 0x10000;
      codes.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      codes.push(cp);
    }
  }
  return fromCodes(codes);
}

/** True when the bytes contain at least one multi-byte UTF-8 sequence and nothing invalid. */
function looksLikeUtf8(d) {
  let multi = false;
  for (let i = 0; i < d.length; ) {
    const c = d[i];
    if (c === 0) break;
    if (c < 0x80) {
      i++;
      continue;
    }
    let need;
    if (c >= 0xc2 && c <= 0xdf) need = 1;
    else if (c >= 0xe0 && c <= 0xef) need = 2;
    else if (c >= 0xf0 && c <= 0xf4) need = 3;
    else return false;
    if (i + need >= d.length) return false;
    for (let k = 1; k <= need; k++) if ((d[i + k] & 0xc0) !== 0x80) return false;
    multi = true;
    i += need + 1;
  }
  return multi;
}

function clean(s) {
  if (typeof s !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  let t = s.replace(/[\u0000-\u001f\u007f﻿]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT - 1).trimEnd() + '…';
  return t;
}
