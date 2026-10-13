// Song file -> decoded AudioBuffer + title/artist, with plain-language errors.
//   <input type="file" accept={ACCEPT}>
//   const { buffer, meta, warning } = await decodeFile(file, engine, file.name);
//   // meta = { title, artist, fileName }; warning = null or a sentence to show (very long song on a phone)
// The bytes are read once; the tag reader gets COPIES of the first 512 KB and the last 128 bytes, because
// decodeAudioData detaches (empties) the buffer it is given. Decoding goes through engine.decode(), which runs
// one decode at a time (decoding is memory hungry on phones). Errors are Error objects whose message can be
// shown to the user as is ("This browser can't play OGG files. Try an MP3 or WAV."); err.cause keeps the
// technical reason.

import { readTags } from './tags.js';
import { env } from '../core/env.js';

/** File picker filter (extensions first: iOS and some Android pickers ignore MIME types). */
export const ACCEPT = '.mp3,.m4a,.aac,.mp4,.wav,.wave,.aif,.aiff,.flac,.ogg,.oga,.opus,.webm,.caf,audio/*';

const TAG_BYTES = 512 * 1024;
const TAIL_BYTES = 128;
const LONG_TRACK_SEC = 15 * 60;

const AUDIO_EXT = Object.freeze({
  mp3: 'MP3', m4a: 'M4A', aac: 'AAC', mp4: 'MP4', m4b: 'M4A', wav: 'WAV', wave: 'WAV', aif: 'AIFF', aiff: 'AIFF',
  aifc: 'AIFF', flac: 'FLAC', ogg: 'OGG', oga: 'OGG', opus: 'Opus', webm: 'WebM', weba: 'WebM', caf: 'CAF',
  alac: 'ALAC', wma: 'WMA', amr: 'AMR', '3gp': '3GP', mka: 'MKA',
});

/** Extensions TwinSpin offers in the picker (the library only stores files that look like these). */
const PICKER_EXT = new Set(['mp3', 'm4a', 'aac', 'mp4', 'm4b', 'wav', 'wave', 'aif', 'aiff', 'aifc', 'flac', 'ogg',
  'oga', 'opus', 'webm', 'weba', 'caf', 'mka', '3gp', 'amr', 'wma', 'alac']);

/** Lower-case extension of a file name ('' when none). */
export function fileExt(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * Does a picked or dropped file look like audio (by MIME type or extension)? Used to keep documents and
 * pictures out of the song library.
 * @param {{ name?: string, type?: string }} file
 */
export function looksLikeAudio(file) {
  if (!file) return false;
  const type = String(file.type || '').toLowerCase();
  if (type.startsWith('audio/')) return true;
  if (type === 'video/mp4' || type === 'video/webm' || type === 'video/ogg' || type === 'application/ogg') return true;
  return PICKER_EXT.has(fileExt(file.name));
}

/**
 * Identify a file from its first bytes. Returns { kind, label }: kind 'audio' (label like 'MP3'), 'protected'
 * (iTunes M4P), 'notaudio' (label like 'PDF') or 'unknown'.
 * @param {Uint8Array} b
 */
export function sniffFormat(b) {
  const n = b ? b.length : 0;
  const ascii = (o, s) => {
    if (o + s.length > n) return false;
    for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
    return true;
  };
  if (n < 4) return { kind: 'unknown', label: '' };
  if (ascii(0, 'ID3')) return { kind: 'audio', label: 'MP3' };
  if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return { kind: 'audio', label: 'WAV' };
  if (ascii(0, 'RIFF') && (ascii(8, 'WEBP') || ascii(8, 'AVI '))) return { kind: 'notaudio', label: ascii(8, 'WEBP') ? 'WebP' : 'AVI' };
  if (ascii(0, 'fLaC')) return { kind: 'audio', label: 'FLAC' };
  if (ascii(0, 'OggS')) {
    for (let i = 28; i < Math.min(n - 8, 128); i++) if (ascii(i, 'OpusHead')) return { kind: 'audio', label: 'Opus' };
    return { kind: 'audio', label: 'OGG' };
  }
  if (ascii(0, 'FORM') && (ascii(8, 'AIFF') || ascii(8, 'AIFC'))) return { kind: 'audio', label: 'AIFF' };
  if (ascii(0, 'caff')) return { kind: 'audio', label: 'CAF' };
  if (ascii(4, 'ftyp')) {
    if (ascii(8, 'M4P ')) return { kind: 'protected', label: 'M4P' };
    if (ascii(8, 'M4A ') || ascii(8, 'M4B ')) return { kind: 'audio', label: 'M4A' };
    if (ascii(8, 'qt  ')) return { kind: 'audio', label: 'MOV' };
    return { kind: 'audio', label: 'MP4' };
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: 'audio', label: 'WebM' };
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return { kind: 'audio', label: 'AAC' }; // ADTS
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return { kind: 'audio', label: 'MP3' }; // MPEG frame sync
  if (ascii(0, '#!AMR')) return { kind: 'audio', label: 'AMR' };
  if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) return { kind: 'audio', label: 'WMA' };
  if (ascii(0, 'MThd')) return { kind: 'notaudio', label: 'MIDI' };
  if (ascii(0, '%PDF')) return { kind: 'notaudio', label: 'PDF' };
  if (b[0] === 0x89 && ascii(1, 'PNG')) return { kind: 'notaudio', label: 'PNG' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'notaudio', label: 'JPEG' };
  if (ascii(0, 'GIF8')) return { kind: 'notaudio', label: 'GIF' };
  if (ascii(0, 'PK\x03\x04')) return { kind: 'notaudio', label: 'ZIP' };
  if (ascii(0, 'bplist') || ascii(0, '{\\rtf')) return { kind: 'notaudio', label: '' };
  let i = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  while (i < n && i < 64 && (b[i] === 0x20 || b[i] === 0x0a || b[i] === 0x0d || b[i] === 0x09)) i++;
  if (b[i] === 0x3c /* < */ || b[i] === 0x7b /* { */) return { kind: 'notaudio', label: '' };
  return { kind: 'unknown', label: '' };
}

/** Read a Blob/File into an ArrayBuffer (Blob.arrayBuffer, FileReader on old Safari). */
export function readBlob(blob) {
  if (blob && typeof blob.arrayBuffer === 'function') return Promise.resolve().then(() => blob.arrayBuffer());
  if (typeof FileReader === 'function') {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error || new Error('read failed'));
      fr.readAsArrayBuffer(blob);
    });
  }
  return Promise.reject(new Error('This browser cannot read files.'));
}

function friendly(message, cause) {
  const err = new Error(message);
  if (cause !== undefined) err.cause = cause;
  return err;
}

const MSG_READ = "This file couldn't be read. If it is stored in the cloud (iCloud, Google Drive), download it to " +
  'this device first, then try again.';
const MSG_EMPTY = 'This file is empty. Pick another song.';
const MSG_GENERIC = "This file can't be played in this browser. Try an MP3 or WAV.";
const MSG_PROTECTED = "This song is copy-protected (from a store or streaming app) and can't be played here.";
const MSG_MEMORY = 'This song is too big to load on this device. Try a shorter song or close other apps.';

/**
 * Read, tag and decode a song file.
 * @param {Blob} fileOrBlob File or Blob (library songs are Blobs)
 * @param {{ decode(ab: ArrayBuffer): Promise<AudioBuffer>, ctx?: object }} engine AudioEngine (or a stub)
 * @param {string} [nameHint] file name for messages and tag fallback (defaults to file.name)
 * @param {{ mobile?: boolean }} [opts] mobile: warn about very long songs (default env.mobile)
 * @returns {Promise<{ buffer: AudioBuffer, meta: { title: string, artist: string, fileName: string }, warning: string|null }>}
 */
export async function decodeFile(fileOrBlob, engine, nameHint, { mobile = env.mobile } = {}) {
  if (!fileOrBlob) throw friendly('No file was picked.');
  const name = String(nameHint || fileOrBlob.name || '');
  const ext = fileExt(name);
  if (ext === 'm4p') throw friendly(MSG_PROTECTED);

  let ab;
  try {
    ab = await readBlob(fileOrBlob);
  } catch (err) {
    throw friendly(MSG_READ, err);
  }
  if (!ab || !(ab.byteLength > 0)) throw friendly(MSG_EMPTY);

  // Copies for the tag reader: decodeAudioData detaches `ab`.
  const len = ab.byteLength;
  const head = ab.slice(0, Math.min(len, TAG_BYTES));
  const tail = len > TAIL_BYTES ? ab.slice(len - TAIL_BYTES) : null;
  const fmt = sniffFormat(new Uint8Array(head, 0, Math.min(head.byteLength, 256)));
  if (fmt.kind === 'protected') throw friendly(MSG_PROTECTED);
  if (fmt.kind === 'notaudio') {
    throw friendly(`That is ${fmt.label ? `a ${fmt.label} file, not a song` : 'not an audio file'}. Pick an MP3, M4A or WAV song.`);
  }
  let meta;
  try {
    meta = readTags(head, name, tail);
  } catch {
    meta = { title: '', artist: '', fileName: name };
  }
  if (!meta.title && !meta.artist) meta.title = name.replace(/\.[a-z0-9]{1,5}$/i, '') || 'Untitled';

  let buffer;
  try {
    buffer = await engine.decode(ab);
  } catch (err) {
    throw decodeError(err, fmt, ext, engine);
  }
  if (!buffer || !(buffer.length > 0) || !(buffer.sampleRate > 0)) throw friendly('This file has no audio in it.');

  const seconds = buffer.duration > 0 ? buffer.duration : buffer.length / buffer.sampleRate;
  let warning = null;
  if (mobile && seconds > LONG_TRACK_SEC) {
    warning = `This song is ${Math.round(seconds / 60)} minutes long. Very long songs can make a phone run out of ` +
      'memory; if the app reloads, use shorter songs.';
  }
  return { buffer, meta, warning };
}

function decodeError(err, fmt, ext, engine) {
  const raw = String((err && err.message) || err || '');
  if (engine && !engine.ctx && /start/i.test(raw)) return friendly(raw, err); // "Audio is not started yet..."
  if (/no audio in it/i.test(raw)) return friendly('This file has no audio in it.', err);
  if ((err && err.name === 'RangeError') || /memory|allocat|too large/i.test(raw)) return friendly(MSG_MEMORY, err);
  const label = fmt.kind === 'audio' && fmt.label ? fmt.label : AUDIO_EXT[ext] || '';
  if (label && label !== 'MP3' && label !== 'WAV') {
    return friendly(`This browser can't play ${label} files. Try an MP3 or WAV.`, err);
  }
  if (label) return friendly(`This ${label} file seems to be damaged or incomplete. Try another copy of the song.`, err);
  return friendly(MSG_GENERIC, err);
}
