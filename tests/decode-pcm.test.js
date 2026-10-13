// Tests for src/audio/pcm.js (Int16 conversion, decimated mono, time slicing) and src/audio/decode.js (tags,
// format sniffing, friendly errors, long-song warning) with a stub engine. Also runs the real loading path for
// a demo track: synth -> preparePcm -> detectBeats must find its BPM.
import { preparePcm } from '../src/audio/pcm.js';
import { decodeFile, sniffFormat, looksLikeAudio, fileExt, ACCEPT } from '../src/audio/decode.js';
import { synthDemo } from '../src/audio/demo-synth.js';
import { detectBeats } from '../src/analysis/bpm.js';

function buf(channels, sampleRate) {
  return {
    sampleRate,
    length: channels[0].length,
    numberOfChannels: channels.length,
    duration: channels[0].length / sampleRate,
    getChannelData: (c) => channels[c],
  };
}

// ---- pcm ----------------------------------------------------------------------------------------------------------

test('Int16 conversion rounds and clamps to [-1, 1) without wrapping', async () => {
  const L = Float32Array.from([0, 0.5, -0.5, 1, -1, 1.5, -2, NaN, 1 / 65536, -1 / 65536, 0.25, 3 / 65536]);
  const R = new Float32Array(L.length);
  const r = await preparePcm(buf([L, R], 8000));
  const c = r.channels[0];
  assert(c instanceof Int16Array);
  assert.deepEqual(Array.from(c), [0, 16384, -16384, 32767, -32768, 32767, -32768, 0, 1, -1, 8192, 2]);
  assert.equal(r.channels.length, 2);
  assert.equal(r.sampleRate, 8000);
});

test('mono = mean of D frames of (L + R) / 2, D = round(sr / targetRate)', async () => {
  const n = 4 * 1000 + 3; // a partial block at the end is dropped
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = (i % 4) * 0.1;
    R[i] = 0.2;
  }
  const r = await preparePcm(buf([L, R], 44100));
  assert.equal(r.monoRate, 44100 / 4);
  assert.equal(r.mono.length, 1000);
  // mean over i%4 = 0..3 of (0.1*k + 0.2) / 2 = (0.15 + 0.2) / 2
  for (const j of [0, 1, 500, 999]) assert.closeTo(r.mono[j], 0.175, 1e-6);
  const r2 = await preparePcm(buf([L, R], 48000));
  assert.equal(r2.monoRate, 12000);
  const r3 = await preparePcm(buf([L, R], 8000));
  assert.equal(r3.monoRate, 8000, 'D = 1 below the target rate');
  assert.equal(r3.mono.length, n);
  const r4 = await preparePcm(buf([L, R], 44100), { targetRate: 22050 });
  assert.equal(r4.monoRate, 22050);
});

test('mono source, mono: false, and bad input', async () => {
  const M = Float32Array.from([0.5, 0.5, -0.5, -0.5]);
  const r = await preparePcm(buf([M], 22050));
  assert.equal(r.channels.length, 1);
  assert.equal(r.monoRate, 11025);
  assert.deepEqual(Array.from(r.mono), [0.5, -0.5]);
  const r2 = await preparePcm(buf([M, M], 22050), { mono: false });
  assert.equal(r2.mono.length, 0);
  assert.equal(r2.channels.length, 2);
  await assert.rejects(preparePcm(null), /no audio/);
  await assert.rejects(preparePcm(buf([new Float32Array(0)], 44100)), /no audio/);
  const detached = { sampleRate: 44100, length: 10, numberOfChannels: 1, getChannelData: () => new Float32Array(0) };
  await assert.rejects(preparePcm(detached), /no longer available/);
});

test('time-sliced: yielding between slices gives the same result', async () => {
  const n = 120000;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = Math.sin(i * 0.01) * 0.8;
    R[i] = Math.cos(i * 0.013) * 0.6;
  }
  const t0 = performance.now();
  let ticks = 0;
  const iv = setInterval(() => ticks++, 1);
  const sliced = await preparePcm(buf([L, R], 44100), { sliceMs: 0 });
  clearInterval(iv);
  assert(ticks > 0 && performance.now() > t0, 'other tasks ran in between');
  const whole = await preparePcm(buf([L, R], 44100), { sliceMs: 1e9 });
  assert.equal(sliced.mono.length, whole.mono.length);
  for (let i = 0; i < n; i += 997) {
    assert.equal(sliced.channels[0][i], whole.channels[0][i]);
    assert.equal(sliced.channels[1][i], whole.channels[1][i]);
  }
  for (let j = 0; j < whole.mono.length; j += 331) assert.equal(sliced.mono[j], whole.mono[j]);
});

for (const [id, bpm, sr] of [[1, 128, 22050], [0, 124, 44100]]) {
  test(`loading path: demo ${id} synth at ${sr} Hz -> preparePcm -> detectBeats finds ${bpm} BPM`, async () => {
    const { channels, sampleRate } = synthDemo(id, sr, 40);
    const pcm = await preparePcm(buf(channels, sampleRate));
    assert.equal(pcm.monoRate, 11025);
    const beats = detectBeats(pcm.mono, pcm.monoRate);
    assert(beats.bpm !== null, 'a tempo was found');
    assert.closeTo(beats.bpm, bpm, 0.05);
    const P = 60 / bpm;
    const off = Math.min(beats.firstBeat % P, P - (beats.firstBeat % P));
    assert(off < 0.015, `grid ${off * 1000} ms off the kicks`);
  });
}

// ---- decode -------------------------------------------------------------------------------------------------------

/** ID3v2.3 tag with TIT2/TPE1 (ISO-8859-1) followed by `rest` bytes. */
function id3Bytes(title, artist, rest = 600) {
  const frames = [];
  for (const [id, text] of [['TIT2', title], ['TPE1', artist]]) {
    const body = [0, ...Array.from(text, (ch) => ch.charCodeAt(0))];
    frames.push(...Array.from(id, (ch) => ch.charCodeAt(0)), 0, 0, 0, body.length, 0, 0, ...body);
  }
  const size = frames.length;
  const head = [0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127];
  const out = new Uint8Array(head.length + size + rest);
  out.set(head, 0);
  out.set(frames, head.length);
  for (let i = head.length + size; i < out.length; i += 4) {
    out[i] = 0xff;
    out[i + 1] = 0xfb;
  }
  return out;
}

function fileOf(name, bytes) {
  return { name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(0) };
}

function engineStub(result = { length: 44100 * 180, sampleRate: 44100, duration: 180 }, fail = null) {
  const calls = [];
  return {
    ctx: {},
    calls,
    decode: async (ab) => {
      calls.push(ab.byteLength);
      if (fail) throw fail;
      return result;
    },
  };
}

test('decodeFile: tags from a copy of the head, the whole file to the decoder', async () => {
  const bytes = id3Bytes('Night Shift', 'Some Artist');
  const eng = engineStub();
  const r = await decodeFile(fileOf('track01.mp3', bytes), eng, 'track01.mp3', { mobile: true });
  assert.deepEqual(eng.calls, [bytes.length]);
  assert.equal(r.meta.title, 'Night Shift');
  assert.equal(r.meta.artist, 'Some Artist');
  assert.equal(r.meta.fileName, 'track01.mp3');
  assert.equal(r.warning, null);
  assert.equal(r.buffer.sampleRate, 44100);
  // untagged: the file name
  const raw = new Uint8Array(400).fill(0);
  raw[0] = 0xff;
  raw[1] = 0xfb;
  const r2 = await decodeFile(fileOf('DJ X - Late Night.mp3', raw), engineStub(), undefined);
  assert.equal(r2.meta.title, 'Late Night');
  assert.equal(r2.meta.artist, 'DJ X');
});

test('decodeFile: very long songs warn on phones only', async () => {
  const long = engineStub({ length: 44100 * 20 * 60, sampleRate: 44100, duration: 20 * 60 });
  const f = fileOf('mix.mp3', id3Bytes('Mix', 'Me'));
  const r = await decodeFile(f, long, 'mix.mp3', { mobile: true });
  assert.match(r.warning, /20 minutes long/);
  const r2 = await decodeFile(f, long, 'mix.mp3', { mobile: false });
  assert.equal(r2.warning, null);
});

test('decodeFile: plain errors for each failure', async () => {
  const eng = engineStub();
  await assert.rejects(decodeFile(fileOf('e.mp3', new Uint8Array(0)), eng, 'e.mp3'), /This file is empty/);
  const pdf = new Uint8Array(100);
  pdf.set([0x25, 0x50, 0x44, 0x46], 0);
  await assert.rejects(decodeFile(fileOf('doc.mp3', pdf), eng, 'doc.mp3'), /That is a PDF file, not a song/);
  await assert.rejects(decodeFile(fileOf('x.m4p', new Uint8Array(10)), eng, 'x.m4p'), /copy-protected/);
  const m4p = new Uint8Array(64);
  m4p.set([0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x50, 0x20], 0);
  await assert.rejects(decodeFile(fileOf('song.m4a', m4p), eng, 'song.m4a'), /copy-protected/);
  const ogg = new Uint8Array(100);
  ogg.set([0x4f, 0x67, 0x67, 0x53], 0);
  const bad = engineStub(undefined, new Error('EncodingError: Unable to decode audio data'));
  const e1 = await decodeFile(fileOf('a.ogg', ogg), bad, 'a.ogg').catch((e) => e);
  assert.equal(e1.message, "This browser can't play OGG files. Try an MP3 or WAV.");
  assert(e1.cause instanceof Error, 'technical cause kept');
  const e2 = await decodeFile(fileOf('a.mp3', id3Bytes('A', 'B')), bad, 'a.mp3').catch((e) => e);
  assert.match(e2.message, /MP3 file seems to be damaged/);
  const e3 = await decodeFile(fileOf('mystery.bin', new Uint8Array(50).fill(7)), bad, 'mystery.bin').catch((e) => e);
  assert.equal(e3.message, "This file can't be played in this browser. Try an MP3 or WAV.");
  const mem = engineStub(undefined, new RangeError('Array buffer allocation failed'));
  await assert.rejects(decodeFile(fileOf('a.wav', id3Bytes('A', 'B')), mem, 'a.wav'), /too big to load/);
  const off = { ctx: null, decode: async () => { throw new Error('Audio is not started yet. Tap start first.'); } };
  await assert.rejects(decodeFile(fileOf('a.mp3', id3Bytes('A', 'B')), off, 'a.mp3'), /Audio is not started yet/);
  const unreadable = { name: 'cloud.mp3', size: 10, arrayBuffer: async () => { throw new Error('NotReadableError'); } };
  await assert.rejects(decodeFile(unreadable, eng, 'cloud.mp3'), /couldn't be read/);
  await assert.rejects(decodeFile(null, eng), /No file/);
  const silent = engineStub({ length: 0, sampleRate: 44100 });
  await assert.rejects(decodeFile(fileOf('s.mp3', id3Bytes('A', 'B')), silent, 's.mp3'), /no audio in it/);
});

test('format sniffing, extensions and the picker filter', () => {
  const b = (...xs) => Uint8Array.from(xs);
  const s = (str, pad = 16) => {
    const a = new Uint8Array(Math.max(pad, str.length));
    for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i);
    return a;
  };
  assert.equal(sniffFormat(s('ID3')).label, 'MP3');
  assert.equal(sniffFormat(s('RIFF\0\0\0\0WAVE')).label, 'WAV');
  assert.equal(sniffFormat(s('fLaC')).label, 'FLAC');
  assert.equal(sniffFormat(s('OggS')).label, 'OGG');
  const opus = s('OggS', 64);
  opus.set(Array.from('OpusHead', (c) => c.charCodeAt(0)), 28);
  assert.equal(sniffFormat(opus).label, 'Opus');
  assert.equal(sniffFormat(s('FORM\0\0\0\0AIFF')).label, 'AIFF');
  assert.equal(sniffFormat(s('\0\0\0\x20ftypM4A ')).label, 'M4A');
  assert.equal(sniffFormat(s('\0\0\0\x20ftypM4P ')).kind, 'protected');
  assert.equal(sniffFormat(b(0x1a, 0x45, 0xdf, 0xa3)).label, 'WebM');
  assert.equal(sniffFormat(b(0xff, 0xf1, 0x50, 0x80)).label, 'AAC');
  assert.equal(sniffFormat(b(0xff, 0xfb, 0x90, 0x64)).label, 'MP3');
  assert.equal(sniffFormat(b(0xff, 0xd8, 0xff, 0xe0)).label, 'JPEG');
  assert.equal(sniffFormat(s('<!DOCTYPE html>')).kind, 'notaudio');
  assert.equal(sniffFormat(s('MThd')).label, 'MIDI');
  assert.equal(sniffFormat(b(1, 2)).kind, 'unknown');
  assert.equal(fileExt('A.Song.MP3'), 'mp3');
  assert.equal(fileExt('noext'), '');
  assert(looksLikeAudio({ name: 'x.flac', type: '' }));
  assert(looksLikeAudio({ name: 'voice', type: 'audio/x-m4a' }));
  assert(!looksLikeAudio({ name: 'notes.txt', type: 'text/plain' }));
  assert(!looksLikeAudio({ name: 'photo.jpg', type: 'image/jpeg' }));
  for (const ext of ['.mp3', '.m4a', '.wav', '.flac', '.ogg', '.opus', '.aiff', 'audio/*']) assert(ACCEPT.split(',').includes(ext));
});
