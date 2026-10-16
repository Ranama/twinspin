// Tests for src/sources/md5.js: the RFC 1321 test suite, the Subsonic API docs example, UTF-8 input and the
// padding edge cases (55 / 56 / 64 bytes, many blocks). Reference values for the non-RFC inputs come from .NET's
// System.Security.Cryptography.MD5 over the UTF-8 bytes.
import { md5, utf8Bytes } from '../src/sources/md5.js';

test('RFC 1321 appendix A.5 test suite', () => {
  assert.equal(md5(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5('a'), '0cc175b9c0f1b6a831c399e269772661');
  assert.equal(md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(md5('message digest'), 'f96b697d7cb7938d525a2f31aaf161d0');
  assert.equal(md5('abcdefghijklmnopqrstuvwxyz'), 'c3fcd3d76192e4007dfb496cca67e13b');
  assert.equal(md5('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'), 'd174ab98d277d9f5a5611c2c9f419d9f');
  assert.equal(md5('12345678901234567890123456789012345678901234567890123456789012345678901234567890'),
    '57edf4a22be3c955ac49da2e2107b67a');
});

test('Subsonic token example: md5("sesame" + "c19b2d")', () => {
  assert.equal(md5('sesame' + 'c19b2d'), '26719a1196d2a940705a59634eb18eab');
});

test('padding edge cases and multi-block input', () => {
  assert.equal(md5('x'.repeat(55)), '04364420e25c512fd958a70738aa8f72');
  assert.equal(md5('x'.repeat(56)), '668a72d5ba17f08e62dabcafad6db14b');
  assert.equal(md5('x'.repeat(64)), 'c1bb4f81d892b2d57947682aeb252456');
  assert.equal(md5('a'.repeat(1000)), 'cabe45dcc9ae5b66ba86600cca6b8ba8');
});

test('UTF-8: accented letters, the euro sign and an emoji (surrogate pair)', () => {
  assert.equal(md5('Grüße'), '49c5f675b49037b6044b803ac9d1a6d7');
  assert.equal(md5('€100'), '0b08281258a7091277ef9eae576adaba');
  assert.equal(md5('DJ 🎧 mix'), 'c060507244a35054fe44ffed783f05c3');
  assert.deepEqual(utf8Bytes('ü'), [0xc3, 0xbc]);
  assert.deepEqual(utf8Bytes('€'), [0xe2, 0x82, 0xac]);
  assert.deepEqual(utf8Bytes('🎧'), [0xf0, 0x9f, 0x8e, 0xa7]);
  assert.deepEqual(utf8Bytes('\ud800'), [0xef, 0xbf, 0xbd], 'a lone surrogate becomes U+FFFD');
  assert.equal(md5(null), md5(''));
});
