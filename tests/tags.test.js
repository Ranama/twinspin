// Tests for src/audio/tags.js with hand-built byte arrays (no real files needed).
import { readTags, parseFileName } from '../src/audio/tags.js';

// ---- byte builders ----
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const u8 = (arr) => new Uint8Array(arr);
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const syncsafe = (n) => [(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127];
function utf8Bytes(s) {
  const out = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return out;
}
function utf16le(s, bom = true) {
  const out = bom ? [0xff, 0xfe] : [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out.push(c & 255, c >> 8);
  }
  return out;
}
function utf16be(s, bom = false) {
  const out = bom ? [0xfe, 0xff] : [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out.push(c >> 8, c & 255);
  }
  return out;
}
function frame23(id, data) {
  return [...ascii(id), ...be32(data.length), 0, 0, ...data];
}
function frame24(id, data, flags2 = 0) {
  return [...ascii(id), ...syncsafe(data.length), 0, flags2, ...data];
}
function frame22(id, data) {
  return [...ascii(id), (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255, ...data];
}
function id3(major, frames, { flags = 0, padding = 32 } = {}) {
  const body = [...frames.flat(), ...new Array(padding).fill(0)];
  return [...ascii('ID3'), major, 0, flags, ...syncsafe(body.length), ...body];
}
const mp3Audio = [0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0];

// ---- tests ----

test('ID3v2.3 with UTF-16 (BOM) title and Latin-1 artist', () => {
  const tag = id3(3, [frame23('TIT2', [1, ...utf16le('Café Señorita'), 0, 0]), frame23('TPE1', [0, ...ascii('Björk'.replace('ö', '\xf6'))])]);
  const r = readTags(u8([...tag, ...mp3Audio]).buffer, 'x.mp3');
  assert.equal(r.title, 'Café Señorita');
  assert.equal(r.artist, 'Björk');
  assert.equal(r.fileName, 'x.mp3');
});

test('ID3v2.3 UTF-16 without BOM defaults to little endian; big-endian BOM honoured', () => {
  const tag = id3(3, [frame23('TIT2', [1, ...utf16le('Night', false)]), frame23('TPE1', [1, 0xfe, 0xff, ...utf16be('Moon')])]);
  const r = readTags(u8(tag), 'a.mp3');
  assert.equal(r.title, 'Night');
  assert.equal(r.artist, 'Moon');
});

test('ID3v2.4 with UTF-8, UTF-16BE and syncsafe sizes > 127', () => {
  const longTitle = 'Ä'.repeat(70) + ' end'; // 144 UTF-8 bytes -> syncsafe size needs two bytes
  const tag = id3(4, [frame24('TIT2', [3, ...utf8Bytes(longTitle), 0]), frame24('TPE1', [2, ...utf16be('Dj 東京')])]);
  const r = readTags(u8(tag), 'b.mp3');
  assert.equal(r.title, longTitle);
  assert.equal(r.artist, 'Dj 東京');
});

test('ID3v2.4 multiple values: first one wins; emoji survives', () => {
  const tag = id3(4, [frame24('TIT2', [3, ...utf8Bytes('Tune 🎧'), 0, ...utf8Bytes('Other')]), frame24('TPE1', [3, ...utf8Bytes('A'), 0, ...utf8Bytes('B')])]);
  const r = readTags(u8(tag), 'c.mp3');
  assert.equal(r.title, 'Tune 🎧');
  assert.equal(r.artist, 'A');
});

test('ID3v2.4 with plain (non-syncsafe) frame sizes written by old iTunes', () => {
  const t = [3, ...utf8Bytes('x'.repeat(200))]; // 201 bytes: plain size has 0xC9 in the low byte
  const bad = [...ascii('TIT2'), ...be32(t.length), 0, 0, ...t];
  const tag = id3(4, [bad, frame24('TPE1', [3, ...utf8Bytes('Artist')])]);
  const r = readTags(u8(tag), 'd.mp3');
  assert.equal(r.title, 'x'.repeat(200));
  assert.equal(r.artist, 'Artist');
});

test('ID3v2.2 TT2/TP1 frames', () => {
  const tag = id3(2, [frame22('TT2', [0, ...ascii('Old School')]), frame22('TP1', [0, ...ascii('Grandmaster')])]);
  const r = readTags(u8(tag), 'e.mp3');
  assert.equal(r.title, 'Old School');
  assert.equal(r.artist, 'Grandmaster');
});

test('ID3v2.3 whole-tag unsynchronisation and extended header', () => {
  // Title contains 0xFF (ÿ) which an unsynchronised tag stores as FF 00.
  const titleData = [0, ...ascii('Hey'), 0xff, ...ascii('ou')];
  const unsyncTitle = [0, ...ascii('Hey'), 0xff, 0x00, ...ascii('ou')];
  const ext = [...be32(6), 0, 0, 0, 0, 0, 0];
  const frames = [...ext, ...ascii('TIT2'), ...be32(titleData.length), 0, 0, ...unsyncTitle, ...frame23('TPE1', [0, ...ascii('Band')])];
  const body = [...frames, 0, 0, 0, 0];
  const tag = [...ascii('ID3'), 3, 0, 0x80 | 0x40, ...syncsafe(body.length), ...body];
  const r = readTags(u8(tag), 'f.mp3');
  assert.equal(r.title, 'Heyÿou');
  assert.equal(r.artist, 'Band');
});

test('encoding 0 holding UTF-8 bytes is read as UTF-8', () => {
  const tag = id3(3, [frame23('TIT2', [0, ...utf8Bytes('Déjà vu')]), frame23('TPE1', [0, ...utf8Bytes('Zoë')])]);
  const r = readTags(u8(tag), 'g.mp3');
  assert.equal(r.title, 'Déjà vu');
  assert.equal(r.artist, 'Zoë');
});

test('album artist is used when there is no artist', () => {
  const tag = id3(3, [frame23('TIT2', [0, ...ascii('Song')]), frame23('TPE2', [0, ...ascii('Various')])]);
  const r = readTags(u8(tag), 'h.mp3');
  assert.equal(r.artist, 'Various');
});

test('ID3v1 from the tail when there is no ID3v2', () => {
  const t = new Array(128).fill(0);
  ascii('TAG').forEach((c, i) => (t[i] = c));
  ascii('Tail Title').forEach((c, i) => (t[3 + i] = c));
  ascii('Tail Artist').forEach((c, i) => (t[33 + i] = c));
  const r = readTags(u8(mp3Audio), 'Some File.mp3', u8(t));
  assert.equal(r.title, 'Tail Title');
  assert.equal(r.artist, 'Tail Artist');
});

function box(type, payload) {
  return [...be32(8 + payload.length), ...Array.from(type, (c) => c.charCodeAt(0) & 0xff), ...payload];
}
function ilstItem(type, text) {
  return box(type, box('data', [0, 0, 0, 1, 0, 0, 0, 0, ...utf8Bytes(text)]));
}

test('MP4 ilst ©nam/©ART (moov before and after mdat)', () => {
  const ilst = box('ilst', [...ilstItem('©nam', 'Ocean Drive'), ...ilstItem('©ART', 'Duke Dumont')]);
  const hdlr = box('hdlr', new Array(25).fill(0));
  const meta = box('meta', [0, 0, 0, 0, ...hdlr, ...ilst]);
  const moov = box('moov', [...box('mvhd', new Array(20).fill(0)), ...box('udta', meta)]);
  const ftyp = box('ftyp', [...ascii('M4A '), 0, 0, 0, 0, ...ascii('M4A isom')]);
  const mdat = box('mdat', new Array(64).fill(7));
  const front = readTags(u8([...ftyp, ...moov, ...mdat]), 'x.m4a');
  assert.equal(front.title, 'Ocean Drive');
  assert.equal(front.artist, 'Duke Dumont');
  const back = readTags(u8([...ftyp, ...mdat, ...moov]), 'x.m4a');
  assert.equal(back.title, 'Ocean Drive');
  // Head-only buffer that ends inside mdat: falls back to the file name.
  const cut = u8([...ftyp, ...mdat, ...moov]).subarray(0, ftyp.length + 40);
  const r = readTags(cut, 'Artist X - Song Y.m4a');
  assert.equal(r.title, 'Song Y');
  assert.equal(r.artist, 'Artist X');
});

function vorbisComment(fields) {
  const vendor = utf8Bytes('test vendor');
  const out = [...le32(vendor.length), ...vendor, ...le32(fields.length)];
  for (const f of fields) {
    const b = utf8Bytes(f);
    out.push(...le32(b.length), ...b);
  }
  return out;
}

test('FLAC Vorbis comment (also behind a leading ID3v2 tag)', () => {
  const streaminfo = [0x00, 0, 0, 34, ...new Array(34).fill(0)];
  const vc = vorbisComment(['title=Größe', 'ARTIST=Kraftwerk', 'ALBUM=X']);
  const vcBlock = [0x84, (vc.length >> 16) & 255, (vc.length >> 8) & 255, vc.length & 255, ...vc];
  const flac = [...ascii('fLaC'), ...streaminfo, ...vcBlock];
  let r = readTags(u8(flac), 'x.flac');
  assert.equal(r.title, 'Größe');
  assert.equal(r.artist, 'Kraftwerk');
  const emptyId3 = id3(3, [], { padding: 16 });
  r = readTags(u8([...emptyId3, ...flac]), 'x.flac');
  assert.equal(r.title, 'Größe');
});

function oggPage(packets, { continued = false } = {}) {
  const lacing = [];
  const data = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
    data.push(...p);
  }
  return [...ascii('OggS'), 0, continued ? 1 : 0, ...new Array(20).fill(0), lacing.length, ...lacing, ...data];
}

test('Ogg Vorbis comment spanning lacing values; Opus tags', () => {
  const idv = [1, ...ascii('vorbis'), ...new Array(23).fill(0)];
  const comments = [3, ...ascii('vorbis'), ...vorbisComment(['TITLE=' + 'Long '.repeat(80).trim(), 'ARTIST=Ogg Band']), 1];
  const ogg = [...oggPage([idv]), ...oggPage([comments])];
  let r = readTags(u8(ogg), 'x.ogg');
  assert.equal(r.title, 'Long '.repeat(80).trim().slice(0, 199).trimEnd() + '…');
  assert.equal(r.artist, 'Ogg Band');
  const opus = [...oggPage([[...ascii('OpusHead'), 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]]), ...oggPage([[...ascii('OpusTags'), ...vorbisComment(['title=Opus Song', 'artist=Opus Artist'])]])];
  r = readTags(u8(opus), 'x.opus');
  assert.equal(r.title, 'Opus Song');
  assert.equal(r.artist, 'Opus Artist');
});

test('WAV LIST/INFO after the data chunk, and an id3 chunk', () => {
  const info = [...ascii('INFO'), ...ascii('INAM'), ...le32(6), ...ascii('Wavey'), 0, ...ascii('IART'), ...le32(5), ...ascii('Bob'), 0, 0, 0];
  const list = [...ascii('LIST'), ...le32(info.length), ...info];
  const fmt = [...ascii('fmt '), ...le32(16), ...new Array(16).fill(0)];
  const data = [...ascii('data'), ...le32(7), 1, 2, 3, 4, 5, 6, 7, 0];
  const riffBody = [...ascii('WAVE'), ...fmt, ...data, ...list];
  const wav = [...ascii('RIFF'), ...le32(riffBody.length), ...riffBody];
  let r = readTags(u8(wav), 'x.wav');
  assert.equal(r.title, 'Wavey');
  assert.equal(r.artist, 'Bob');
  const tag = id3(3, [frame23('TIT2', [0, ...ascii('Id3 In Wav')])], { padding: 0 });
  const id3chunk = [...ascii('id3 '), ...le32(tag.length), ...tag, ...(tag.length & 1 ? [0] : [])];
  const body2 = [...ascii('WAVE'), ...fmt, ...id3chunk, ...data];
  r = readTags(u8([...ascii('RIFF'), ...le32(body2.length), ...body2]), 'Name - Fallback.wav');
  assert.equal(r.title, 'Id3 In Wav');
  assert.equal(r.artist, '');
});

test('AIFF NAME/AUTH chunks', () => {
  const name = [...ascii('NAME'), ...be32(5), ...ascii('Aiffy'), 0];
  const auth = [...ascii('AUTH'), ...be32(4), ...ascii('Mac!')];
  const body = [...ascii('AIFF'), ...name, ...auth];
  const r = readTags(u8([...ascii('FORM'), ...be32(body.length), ...body]), 'x.aiff');
  assert.equal(r.title, 'Aiffy');
  assert.equal(r.artist, 'Mac!');
});

test('file-name fallback', () => {
  assert.deepEqual(parseFileName('Daft Punk - One More Time.mp3'), { artist: 'Daft Punk', title: 'One More Time' });
  assert.deepEqual(parseFileName('03 - Daft Punk - Digital Love.flac'), { artist: 'Daft Punk', title: 'Digital Love' });
  assert.deepEqual(parseFileName('03 - Digital Love.flac'), { artist: '', title: 'Digital Love' });
  assert.deepEqual(parseFileName('my_cool_track.wav'), { artist: '', title: 'my cool track' });
  assert.deepEqual(parseFileName('07 Song Name.m4a'), { artist: '', title: 'Song Name' });
  assert.deepEqual(parseFileName('99 Problems.mp3'), { artist: '', title: '99 Problems' });
  assert.deepEqual(parseFileName('A - B - C.mp3'), { artist: 'A', title: 'B - C' });
  assert.deepEqual(parseFileName('Artist – Title.mp3'), { artist: 'Artist', title: 'Title' });
  assert.deepEqual(parseFileName('Folder/Sub\\Track-Name.mp3'), { artist: '', title: 'Track-Name' });
  assert.deepEqual(parseFileName(''), { artist: '', title: 'Untitled' });
  const r = readTags(u8(mp3Audio), 'Röyksopp - Eple.mp3');
  assert.equal(r.title, 'Eple');
  assert.equal(r.artist, 'Röyksopp');
});

test('garbage, empty and truncated input never throws', () => {
  assert.equal(readTags(null, 'Only Name.mp3').title, 'Only Name');
  assert.equal(readTags(new ArrayBuffer(0), 'x.mp3').title, 'x');
  const truncated = id3(3, [frame23('TIT2', [0, ...ascii('Cut Off Title')])]).slice(0, 18);
  assert.doesNotThrow(() => readTags(u8(truncated), 'y.mp3'));
  const bogus = u8([...ascii('ID3'), 9, 0, 0, 0x7f, 0x7f, 0x7f, 0x7f, 1, 2, 3]);
  assert.equal(readTags(bogus, 'z.mp3').title, 'z');
  const ftypOnly = u8(box('ftyp', ascii('M4A ')));
  assert.equal(readTags(ftypOnly, 'w.m4a').title, 'w');
  const rnd = new Uint8Array(4096);
  let s = 7;
  for (let i = 0; i < rnd.length; i++) rnd[i] = (s = (s * 1103515245 + 12345) & 0x7fffffff) & 255;
  rnd.set(ascii('OggS'), 0);
  assert.doesNotThrow(() => readTags(rnd, 'r.ogg'));
});

test('a truncated text frame at the end of a head-only buffer still yields its start', () => {
  const tag = id3(3, [frame23('TPE1', [0, ...ascii('Artist')]), frame23('TIT2', [0, ...ascii('A Rather Long Title')])]);
  const cut = u8(tag).subarray(0, tag.length - 32 - 6); // drop padding and the end of the title
  const r = readTags(cut, 'q.mp3');
  assert.equal(r.artist, 'Artist');
  assert.equal(r.title, 'A Rather Long');
});
