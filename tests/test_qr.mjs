import assert from 'node:assert/strict';
import { qrEncode, qrPngBytes, qrPngDataUri } from '../shared/qr.mjs';

const EC_IND = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
const EC_PER_BLOCK = {
  1: [7, 10, 13, 17], 2: [10, 16, 22, 28], 3: [15, 26, 18, 22], 4: [20, 18, 26, 16], 5: [26, 24, 18, 22],
  6: [18, 16, 24, 28], 7: [20, 18, 18, 26], 8: [24, 22, 22, 26], 9: [30, 22, 20, 24], 10: [18, 26, 24, 28]
};
const BLOCKS = {
  1: [[1, 19, 0, 0], [1, 16, 0, 0], [1, 13, 0, 0], [1, 9, 0, 0]],
  2: [[1, 34, 0, 0], [1, 28, 0, 0], [1, 22, 0, 0], [1, 16, 0, 0]],
  3: [[1, 55, 0, 0], [1, 44, 0, 0], [2, 17, 0, 0], [2, 13, 0, 0]],
  4: [[1, 80, 0, 0], [2, 32, 0, 0], [2, 24, 0, 0], [4, 9, 0, 0]],
  5: [[1, 108, 0, 0], [2, 43, 0, 0], [2, 15, 2, 16], [2, 11, 2, 12]],
  6: [[2, 68, 0, 0], [4, 27, 0, 0], [4, 19, 0, 0], [4, 15, 0, 0]],
  7: [[2, 78, 0, 0], [4, 31, 0, 0], [2, 14, 4, 15], [4, 13, 1, 14]],
  8: [[2, 97, 0, 0], [2, 38, 2, 39], [4, 18, 2, 19], [4, 14, 2, 15]],
  9: [[2, 116, 0, 0], [3, 36, 2, 37], [4, 16, 4, 17], [4, 12, 4, 13]],
  10: [[2, 68, 2, 69], [4, 43, 1, 44], [6, 19, 2, 20], [6, 15, 2, 16]]
};

function deinterleaveData(codewords, version, level) {
  const idx = ['L', 'M', 'Q', 'H'].indexOf(level);
  const [n1, d1, n2, d2] = BLOCKS[version][idx];
  const lengths = [...Array(n1).fill(d1), ...Array(n2).fill(d2)];
  const blocks = lengths.map(() => []);
  const maxData = Math.max(d1, d2);
  let cursor = 0;
  for (let k = 0; k < maxData; k++) {
    for (let b = 0; b < lengths.length; b++) {
      if (k < lengths[b]) blocks[b].push(codewords[cursor++]);
    }
  }
  return blocks.flat();
}

function bitsFromCodewords(codewords) {
  const bits = [];
  for (const cw of codewords) for (let m = 7; m >= 0; m--) bits.push((cw >> m) & 1);
  return bits;
}

function crc32(bytes) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  let crc = 0xFFFFFFFF;
  for (const b of bytes) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunks(png) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out = [];
  let off = 8;
  while (off < png.length) {
    const len = view.getUint32(off, false);
    const type = String.fromCharCode(...png.slice(off + 4, off + 8));
    const data = png.slice(off + 8, off + 8 + len);
    const crc = view.getUint32(off + 8 + len, false);
    out.push({ type, len, data, crc, crcOk: crc === crc32(new Uint8Array([...png.slice(off + 4, off + 8), ...data])) });
    off += 12 + len;
  }
  return out;
}

function maskBit(mask, i, j) {
  switch (mask) {
    case 0: return (i + j) % 2 === 0;
    case 1: return i % 2 === 0;
    case 2: return j % 3 === 0;
    case 3: return (i + j) % 3 === 0;
    case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5: return (i * j) % 2 + (i * j) % 3 === 0;
    case 6: return ((i * j) % 2 + (i * j) % 3) % 2 === 0;
    default: return ((i + j) % 2 + (i * j) % 3) % 2 === 0;
  }
}

function functionMap(size, version) {
  const fn = Array.from({ length: size }, () => Array(size).fill(false));
  const mark = (r, c) => { if (r >= 0 && r < size && c >= 0 && c < size) fn[r][c] = true; };
  for (const [r0, c0] of [[0, 0], [0, size - 8], [size - 8, 0]]) {
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) mark(r0 + r, c0 + c);
  }
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  for (const r of ALIGN[version] || []) {
    for (const c of ALIGN[version] || []) {
      if ((r < 9 && c < 9) || (r < 9 && c > size - 9) || (r > size - 9 && c < 9)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
    }
  }
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }
  if (version >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { mark(i, size - 11 + j); mark(size - 11 + j, i); }
  return fn;
}

function readFormatBits(modules) {
  const size = modules.length;
  const vertical = [];
  for (let i = 0; i < 15; i++) {
    if (i < 6) vertical.push(modules[i][8]);
    else if (i < 8) vertical.push(modules[i + 1][8]);
    else vertical.push(modules[size - 15 + i][8]);
  }
  const horizontal = [];
  for (let i = 0; i < 15; i++) {
    if (i < 8) horizontal.push(modules[8][size - i - 1]);
    else if (i < 9) horizontal.push(modules[8][15 - i]);
    else horizontal.push(modules[8][14 - i]);
  }
  const toInt = bits => bits.reduce((acc, bit, i) => acc | (bit << i), 0);
  return { vertical: toInt(vertical), horizontal: toInt(horizontal) };
}

function readCodewords(modules, version) {
  const size = modules.length;
  const fn = functionMap(size, version);
  const fmt = readFormatBits(modules);
  const raw = fmt.vertical ^ 0x5412;
  const mask = (raw >>> 10) & 0b111;
  const bits = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let r = 0; r < size; r++) {
      const row = upward ? size - 1 - r : r;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (cc < 0 || fn[row][cc]) continue;
        bits.push(modules[row][cc] ^ (maskBit(mask, row, cc) ? 1 : 0));
      }
    }
    upward = !upward;
  }
  const codewords = [];
  for (let k = 0; k + 8 <= bits.length; k += 8) {
    let byte = 0;
    for (let m = 0; m < 8; m++) byte = (byte << 1) | bits[k + m];
    codewords.push(byte);
  }
  return { codewords, mask, bits };
}

assert.equal(qrEncode('HELLO WORLD').size, 17 + 4 * qrEncode('HELLO WORLD').version, 'size === 17 + 4*version');
console.log('PASS size/version');

{
  const { version, modules } = qrEncode('A');
  const size = 4 * version + 17;
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const ring = (y === 0 || y === 6 || x === 0 || x === 6);
        const core = (y >= 2 && y <= 4 && x >= 2 && x <= 4);
        assert.equal(modules[r0 + y][c0 + x], ring || core ? 1 : 0, `finder ${r0},${c0} @${y},${x}`);
      }
    }
  }
  for (let i = 0; i < 8; i++) {
    assert.equal(modules[7][i], 0, `separator TL col ${i}`);
    assert.equal(modules[i][7], 0, `separator TL row ${i}`);
    assert.equal(modules[7][size - 1 - i], 0, `separator TR ${i}`);
    assert.equal(modules[size - 1 - i][7], 0, `separator BL ${i}`);
  }
  console.log('PASS finder + separator patterns');
}

{
  const { version, modules } = qrEncode('TIMING');
  const size = 4 * version + 17;
  for (let i = 8; i <= size - 9; i++) {
    const expected = i % 2 === 0 ? 1 : 0;
    assert.equal(modules[6][i], expected, `timing row6 col ${i}`);
    assert.equal(modules[i][6], expected, `timing col6 row ${i}`);
  }
  console.log('PASS timing patterns (row 6 / col 6)');
}

{
  for (const text of ['X', 'HELLO', 'LONGER TEXT HERE 123']) {
    const { version, modules } = qrEncode(text);
    assert.equal(modules[4 * version + 9][8], 1, 'dark module at (4v+9, 8)');
  }
  console.log('PASS dark module');
}

{
  const a = qrEncode('DETERMINISM CHECK');
  const b = qrEncode('DETERMINISM CHECK');
  assert.deepEqual(a.modules, b.modules, 'same input -> identical modules');
  console.log('PASS determinism');
}

assert.ok(qrEncode('THIS IS A SIGNIFICANTLY LONGER STRING TO FORCE VERSION INCREASE').version > qrEncode('SHORT').version, 'longer text -> larger version');
console.log('PASS version growth');

assert.throws(() => qrEncode('X'.repeat(5000)), /QR data too long/, 'oversized input rejected');
console.log('PASS too-long rejection');

{
  for (const level of ['L', 'M', 'Q', 'H']) {
    const { modules } = qrEncode('FORMAT TEST', { errorCorrectionLevel: level });
    const { vertical, horizontal } = readFormatBits(modules);
    assert.equal(vertical, horizontal, `${level}: both format copies agree`);
    const raw = vertical ^ 0x5412;
    const data = raw >>> 10;
    assert.equal((data >>> 3) & 0b111, EC_IND[level], `${level}: EC indicator round-trips`);
    const recomputed = (() => {
      let d = data << 10;
      for (let i = 4; i >= 0; i--) if (d & (1 << (i + 10))) d ^= 0x537 << i;
      return ((data << 10) | d) ^ 0x5412;
    })();
    assert.equal(vertical, recomputed, `${level}: format info is a valid BCH(15,5) codeword`);
    assert.ok((raw & 0b111) <= 7, `${level}: mask in range`);
  }
  console.log('PASS format info (both copies, BCH valid, EC round-trip)');
}

function verifyReadback(text, level = 'M') {
  const { version, modules } = qrEncode(text, { errorCorrectionLevel: level });
  const { codewords, mask } = readCodewords(modules, version);
  assert.ok(mask >= 0 && mask <= 7, 'decoded mask in range');
  const bits = bitsFromCodewords(deinterleaveData(codewords, version, level));
  const mode = bits.slice(0, 4).reduce((a, b) => (a << 1) | b, 0);
  assert.equal(mode, 0b0100, `byte-mode indicator (level ${level})`);
  const countBits = version < 10 ? 8 : 16;
  let count = 0;
  for (let i = 0; i < countBits; i++) count = (count << 1) | bits[4 + i];
  const bytes = [...new TextEncoder().encode(text)];
  assert.equal(count, bytes.length, `char count (level ${level})`);
  const payload = [];
  for (let k = 4 + countBits; k < 4 + countBits + 8 * bytes.length; k += 8) {
    let byte = 0;
    for (let m = 0; m < 8; m++) byte = (byte << 1) | bits[k + m];
    payload.push(byte);
  }
  assert.deepEqual(payload, bytes, `payload bytes (level ${level})`);
  return { version, mask };
}

{
  const { version, mask } = verifyReadback('HELLO WORLD');
  console.log(`PASS data-path readback (version ${version}, mask ${mask}, payload verified)`);
}

{
  const { version, mask } = verifyReadback('REALISTIC PAYLOAD CHECK 1234567890 ABCDEFGHIJ');
  console.log(`PASS multi-block readback (version ${version}, mask ${mask}, de-interleaved payload verified)`);
}

{
  const { version } = verifyReadback('AWQ OCC | DXR: CHRIS DANIEL (LIC: FOOL-881234) | 2026-09-18 | REF: QZ646,QZ647');
  for (const level of ['L', 'M', 'Q', 'H']) verifyReadback('MULTILEVEL', level);
  console.log(`PASS readback across all EC levels (AWQ payload version ${version})`);
}

{
  const { size, modules } = qrEncode('PNG SIG');
  const png = await qrPngBytes(modules, { scale: 4, border: 4 });
  assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], 'PNG signature');
  const chunks = pngChunks(png);
  assert.deepEqual(chunks.map(c => c.type), ['IHDR', 'IDAT', 'IEND'], 'chunk order');
  for (const c of chunks) assert.ok(c.crcOk, `${c.type} CRC valid`);
  const expected = (size + 2 * 4) * 4;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  assert.equal(view.getUint32(16, false), expected, 'IHDR width');
  assert.equal(view.getUint32(20, false), expected, 'IHDR height');
  assert.equal(chunks[0].data[8], 8, 'bit depth 8');
  assert.equal(chunks[0].data[9], 0, 'color type 0 greyscale');

  const stream = new DecompressionStream('deflate');
  const writer = stream.writable.getWriter();
  writer.write(chunks[1].data);
  writer.close();
  const raw = new Uint8Array(await new Response(stream.readable).arrayBuffer());
  assert.equal(raw.length, expected * (expected + 1), 'IDAT decompressed length');

  const scale = 4, border = 4;
  const pixel = (mx, my) => {
    const x = (mx + border) * scale + 1;
    const y = (my + border) * scale + 1;
    return raw[y * (expected + 1) + 1 + x];
  };
  assert.equal(raw[0], 0, 'filter byte 0 on first row');
  assert.equal(pixel(0, 0), 0, 'finder corner is black');
  assert.equal(pixel(1, 1), 255, 'finder ring 2 is white');
  assert.equal(pixel(-1, -1), 255, 'quiet zone is white');
  const dm = 4 * qrEncode('PNG SIG').version + 9;
  assert.equal(pixel(8, dm), 0, 'dark module renders black');
  console.log('PASS PNG structure, CRC, dimensions, IDAT and pixel mapping');
}

{
  const uri = await qrPngDataUri('DATA URI');
  assert.ok(uri.startsWith('data:image/png;base64,'), 'data URI prefix');
  const bytes = Buffer.from(uri.split(',')[1], 'base64');
  assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4E, 0x47], 'embedded PNG bytes');
  console.log('PASS data URI');
}

{
  for (const level of ['L', 'M', 'Q', 'H']) {
    const r = qrEncode('MULTILEVEL', { errorCorrectionLevel: level });
    assert.equal(r.modules.length, r.size, `${level}: rows === size`);
    assert.equal(r.modules[0].length, r.size, `${level}: cols === size`);
  }
  console.log('PASS all EC levels');
}

console.log('QR encoder: structure, format info, data path and PNG output validated.');
