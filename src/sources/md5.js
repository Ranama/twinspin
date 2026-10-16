// MD5 (RFC 1321) of a string's UTF-8 bytes, as 32 lowercase hex digits. Pure and dependency-free.
// Only used for Subsonic token auth (t = md5(password + salt)), which the Subsonic API defines with MD5;
// it is not used for anything security-critical inside TwinSpin.
//   md5('')        -> 'd41d8cd98f00b204e9800998ecf8427e'
//   md5('sesame' + 'c19b2d') -> '26719a1196d2a940705a59634eb18eab'   (the Subsonic API docs example)

/** Per-round left-rotate amounts. */
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** K[i] = floor(abs(sin(i + 1)) * 2^32), computed once. */
const K = (() => {
  const k = new Array(64);
  for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  return k;
})();

/** UTF-8 bytes of a string (lone surrogates become U+FFFD, like TextEncoder). */
export function utf8Bytes(str) {
  const s = String(str == null ? '' : str);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      } else {
        c = 0xfffd;
      }
    } else if (c >= 0xd800 && c <= 0xdfff) {
      c = 0xfffd;
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/**
 * MD5 digest of the UTF-8 encoding of `str`.
 * @param {string} str
 * @returns {string} 32 lowercase hex digits
 */
export function md5(str) {
  const bytes = utf8Bytes(str);
  const bitLen = bytes.length * 8;
  // padding: 0x80, zeros up to 56 mod 64, then the 64-bit little-endian bit length
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const lo = bitLen >>> 0;
  const hi = Math.floor(bitLen / 4294967296) >>> 0;
  for (let i = 0; i < 4; i++) bytes.push((lo >>> (8 * i)) & 255);
  for (let i = 0; i < 4; i++) bytes.push((hi >>> (8 * i)) & 255);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const m = new Array(16);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let j = 0; j < 16; j++) {
      const p = off + j * 4;
      m[j] = (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0;
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (a + f + K[i] + m[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << S[i]) | (sum >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  return [a0, b0, c0, d0].map(wordHex).join('');
}

/** A 32-bit word as 8 hex digits, least significant byte first (MD5's output order). */
function wordHex(w) {
  let s = '';
  for (let i = 0; i < 4; i++) {
    const byte = (w >>> (8 * i)) & 255;
    s += (byte < 16 ? '0' : '') + byte.toString(16);
  }
  return s;
}
