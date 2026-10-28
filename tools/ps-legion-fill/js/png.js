// Minimal PNG encoder: stored (uncompressed) deflate blocks, so no zlib needed.
// Fine for LAN uploads to ComfyUI; files are ~ width*height*channels bytes.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1, b = 0;
  const MOD = 65521;
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(i + 5552, bytes.length);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= MOD; b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function writeU32(buf, off, v) {
  buf[off] = (v >>> 24) & 0xff; buf[off + 1] = (v >>> 16) & 0xff;
  buf[off + 2] = (v >>> 8) & 0xff; buf[off + 3] = v & 0xff;
}

/**
 * Encode 8-bit pixels as PNG.
 * @param {Uint8Array} pixels  interleaved, row-major
 * @param {number} width
 * @param {number} height
 * @param {number} channels    1 (gray), 3 (RGB) or 4 (RGBA)
 * @returns {Uint8Array}
 */
function encodePNG(pixels, width, height, channels) {
  const colorType = { 1: 0, 3: 2, 4: 6 }[channels];
  if (colorType === undefined) throw new Error("PNG: unsupported channel count " + channels);
  const stride = width * channels;
  if (pixels.length < stride * height) throw new Error("PNG: pixel buffer too small");

  // Raw scanlines with filter byte 0.
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  // zlib stream of stored blocks.
  const BLOCK = 65535;
  const nBlocks = Math.max(1, Math.ceil(raw.length / BLOCK));
  const zlib = new Uint8Array(2 + raw.length + nBlocks * 5 + 4);
  zlib[0] = 0x78; zlib[1] = 0x01;
  let p = 2;
  for (let i = 0; i < nBlocks; i++) {
    const start = i * BLOCK;
    const len = Math.min(BLOCK, raw.length - start);
    zlib[p++] = i === nBlocks - 1 ? 1 : 0;
    zlib[p++] = len & 0xff; zlib[p++] = len >>> 8;
    zlib[p++] = ~len & 0xff; zlib[p++] = (~len >>> 8) & 0xff;
    zlib.set(raw.subarray(start, start + len), p);
    p += len;
  }
  writeU32(zlib, p, adler32(raw));

  const chunks = [];
  const chunk = (type, data) => {
    const c = new Uint8Array(12 + data.length);
    writeU32(c, 0, data.length);
    for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
    c.set(data, 8);
    writeU32(c, 8 + data.length, crc32(c, 4, 8 + data.length));
    chunks.push(c);
  };

  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width); writeU32(ihdr, 4, height);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  chunks.push(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  chunk("IHDR", ihdr);
  chunk("IDAT", zlib);
  chunk("IEND", new Uint8Array(0));

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

module.exports = { encodePNG };
