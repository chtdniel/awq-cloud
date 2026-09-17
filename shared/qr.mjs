/**
 * QR Code Encoder — Pure JavaScript, ZERO dependencies
 * ISO/IEC 18004 implementation (byte mode / 8-bit)
 * Supports versions 1-10, error correction levels L/M/Q/H
 */

// ============================================================================
// GF(256) arithmetic with primitive polynomial 0x11D
// ============================================================================
const EXP = new Uint8Array(256);
const LOG = new Uint8Array(256);
const GAL_MUL = Array.from({length: 256}, () => new Uint8Array(256));

(function initGF() {
  let x = 1;
  const PRIM = 0x11D;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= PRIM;
  }
  EXP[255] = EXP[0];
  
  // Build 2D multiply table
  for (let a = 0; a < 256; a++) {
    for (let b = 0; b < 256; b++) {
      GAL_MUL[a][b] = (a && b) ? EXP[(LOG[a] + LOG[b]) % 255] : 0;
    }
  }
})();

// ============================================================================
// QR Code tables (verbatim from spec)
// ============================================================================

// Total codewords per version 1..10
const TOTAL_CW = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

// Data codewords per version, by level [L, M, Q, H]
const DATA_CW = [
  null,
  [19, 16, 13, 9],      // V1
  [34, 28, 22, 16],     // V2
  [55, 44, 34, 26],     // V3
  [80, 64, 48, 36],     // V4
  [108, 86, 62, 46],    // V5
  [136, 108, 76, 60],   // V6
  [156, 124, 88, 66],   // V7
  [194, 154, 110, 86],  // V8
  [232, 182, 132, 100], // V9
  [274, 216, 154, 122], // V10
];

// EC codewords PER BLOCK, by version, level [L, M, Q, H]
const EC_PER_BLOCK = [
  null,
  [7, 10, 13, 17],      // V1
  [10, 16, 22, 28],     // V2
  [15, 26, 18, 22],     // V3
  [20, 18, 26, 16],     // V4
  [26, 24, 18, 22],     // V5
  [18, 16, 24, 28],     // V6
  [20, 18, 18, 26],     // V7
  [24, 22, 22, 26],     // V8
  [30, 22, 20, 24],     // V9
  [18, 26, 24, 28],     // V10
];

// Block structure [numBlocksG1, dataCWperBlockG1, numBlocksG2, dataCWperBlockG2]
const BLOCK_STRUCT = {
  1: { L: [1,19,0,0], M: [1,16,0,0], Q: [1,13,0,0], H: [1,9,0,0] },
  2: { L: [1,34,0,0], M: [1,28,0,0], Q: [1,22,0,0], H: [1,16,0,0] },
  3: { L: [1,55,0,0], M: [1,44,0,0], Q: [2,17,0,0], H: [2,13,0,0] },
  4: { L: [1,80,0,0], M: [2,32,0,0], Q: [2,24,0,0], H: [4,9,0,0] },
  5: { L: [1,108,0,0], M: [2,43,0,0], Q: [2,15,2,16], H: [2,11,2,12] },
  6: { L: [2,68,0,0], M: [4,27,0,0], Q: [4,19,0,0], H: [4,15,0,0] },
  7: { L: [2,78,0,0], M: [4,31,0,0], Q: [2,14,4,15], H: [4,13,1,14] },
  8: { L: [2,97,0,0], M: [2,38,2,39], Q: [4,18,2,19], H: [4,14,2,15] },
  9: { L: [2,116,0,0], M: [3,36,2,37], Q: [4,16,4,17], H: [4,12,4,13] },
  10: { L: [2,68,2,69], M: [4,43,1,44], Q: [6,19,2,20], H: [6,15,2,16] },
};

// Alignment pattern centre coordinates per version
const ALIGN_POS = [
  null,
  [],           // V1
  [6, 18],      // V2
  [6, 22],      // V3
  [6, 26],      // V4
  [6, 30],      // V5
  [6, 34],      // V6
  [6, 22, 38],  // V7
  [6, 24, 42],  // V8
  [6, 26, 46],  // V9
  [6, 28, 50],  // V10
];

// EC level indicators (2 bits)
const EC_INDICATOR = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

// ============================================================================
// Reed-Solomon error correction
// ============================================================================

function rsGenPoly(n) {
  // Generator polynomial = ∏_{i=0}^{n-1} (x - α^i)
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const newPoly = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      newPoly[j] ^= poly[j];
      newPoly[j + 1] ^= GAL_MUL[poly[j]][EXP[i]];
    }
    poly = newPoly;
  }
  return poly.slice(1); // Remove leading 1
}

function rsEncode(data, ecCount) {
  const gen = rsGenPoly(ecCount);
  const msg = Array.from(data);
  
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j + 1] ^= GAL_MUL[gen[j]][coef];
      }
    }
  }
  
  return new Uint8Array(msg.slice(data.length));
}

// ============================================================================
// BCH encoding for format and version info
// ============================================================================

function bchFormatInfo(data) {
  // BCH(15,5) with generator 0x537 (0b10100110111)
  let d = data << 10;
  const g = 0x537;
  for (let i = 4; i >= 0; i--) {
    if (d & (1 << (i + 10))) {
      d ^= g << i;
    }
  }
  return ((data << 10) | d) ^ 0x5412;
}

function bchVersionInfo(data) {
  // BCH(18,6) with generator 0x1F25 (0b1111100100101)
  let d = data << 12;
  const g = 0x1F25;
  for (let i = 5; i >= 0; i--) {
    if (d & (1 << (i + 12))) {
      d ^= g << i;
    }
  }
  return (data << 12) | d;
}

// ============================================================================
// Version selection
// ============================================================================

function selectVersion(byteLen, ecLevel) {
  const levelIdx = ['L', 'M', 'Q', 'H'].indexOf(ecLevel);
  
  for (let v = 1; v <= 10; v++) {
    const charCountBits = v < 10 ? 8 : 16;
    const dataBitsNeeded = 4 + charCountBits + 8 * byteLen;
    const dataCWNeeded = Math.ceil(dataBitsNeeded / 8);
    
    if (dataCWNeeded <= DATA_CW[v][levelIdx]) {
      return v;
    }
  }
  
  throw new Error('QR data too long');
}

// ============================================================================
// Data encoding (byte mode)
// ============================================================================

function encodeData(text, version, ecLevel) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const levelIdx = ['L', 'M', 'Q', 'H'].indexOf(ecLevel);
  const dataCWCount = DATA_CW[version][levelIdx];
  const charCountBits = version < 10 ? 8 : 16;
  
  // Build bit stream
  let bits = '0100'; // Mode indicator (byte mode)
  bits += bytes.length.toString(2).padStart(charCountBits, '0'); // Character count
  
  for (const b of bytes) {
    bits += b.toString(2).padStart(8, '0');
  }
  
  // Terminator (up to 4 bits)
  const terminatorLen = Math.min(4, dataCWCount * 8 - bits.length);
  bits += '0'.repeat(terminatorLen);
  
  // Pad to byte boundary
  while (bits.length % 8 !== 0) {
    bits += '0';
  }
  
  // Pad bytes (0xEC, 0x11 alternating)
  while (bits.length < dataCWCount * 8) {
    bits += '11101100'; // 0xEC
    if (bits.length < dataCWCount * 8) {
      bits += '00010001'; // 0x11
    }
  }
  
  // Convert to bytes
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(parseInt(bits.slice(i, i + 8), 2));
  }
  
  return new Uint8Array(codewords);
}

// ============================================================================
// Block splitting and interleaving
// ============================================================================

function splitIntoBlocks(data, version, ecLevel) {
  const level = ['L', 'M', 'Q', 'H'][['L', 'M', 'Q', 'H'].indexOf(ecLevel)];
  const [numG1, dataPerG1, numG2, dataPerG2] = BLOCK_STRUCT[version][level];
  const ecPerBlock = EC_PER_BLOCK[version][['L', 'M', 'Q', 'H'].indexOf(ecLevel)];
  
  const blocks = [];
  let offset = 0;
  
  // Group 1
  for (let i = 0; i < numG1; i++) {
    const blockData = data.slice(offset, offset + dataPerG1);
    const ecData = rsEncode(blockData, ecPerBlock);
    blocks.push({ data: blockData, ec: ecData });
    offset += dataPerG1;
  }
  
  // Group 2
  for (let i = 0; i < numG2; i++) {
    const blockData = data.slice(offset, offset + dataPerG2);
    const ecData = rsEncode(blockData, ecPerBlock);
    blocks.push({ data: blockData, ec: ecData });
    offset += dataPerG2;
  }
  
  return blocks;
}

function interleaveBlocks(blocks) {
  const result = [];
  
  // Interleave data codewords
  const maxDataLen = Math.max(...blocks.map(b => b.data.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of blocks) {
      if (i < block.data.length) {
        result.push(block.data[i]);
      }
    }
  }
  
  // Interleave EC codewords
  const maxEcLen = Math.max(...blocks.map(b => b.ec.length));
  for (let i = 0; i < maxEcLen; i++) {
    for (const block of blocks) {
      if (i < block.ec.length) {
        result.push(block.ec[i]);
      }
    }
  }
  
  return new Uint8Array(result);
}

// ============================================================================
// Matrix construction
// ============================================================================

function createMatrix(version) {
  const size = 17 + 4 * version;
  const modules = Array.from({length: size}, () => Array(size).fill(null));
  const reserved = Array.from({length: size}, () => Array(size).fill(false));
  
  // Place finder patterns (7x7) at three corners
  placeFinder(modules, reserved, 0, 0); // Top-left
  placeFinder(modules, reserved, 0, size - 7); // Top-right
  placeFinder(modules, reserved, size - 7, 0); // Bottom-left
  
  // Separators (1 module wide around finders)
  for (let i = 0; i < 8; i++) {
    // Top-left
    if (i < size) {
      modules[7][i] = 0; reserved[7][i] = true;
      modules[i][7] = 0; reserved[i][7] = true;
    }
    // Top-right
    if (i < size) {
      modules[7][size - 8 + i] = 0; reserved[7][size - 8 + i] = true;
      modules[i][size - 8] = 0; reserved[i][size - 8] = true;
    }
    // Bottom-left
    if (i < size) {
      modules[size - 8][i] = 0; reserved[size - 8][i] = true;
      modules[size - 8 + i][7] = 0; reserved[size - 8 + i][7] = true;
    }
  }
  
  // Timing patterns (alternating on row 6 and column 6)
  for (let i = 8; i < size - 8; i++) {
    modules[6][i] = (i % 2 === 0) ? 1 : 0;
    reserved[6][i] = true;
    modules[i][6] = (i % 2 === 0) ? 1 : 0;
    reserved[i][6] = true;
  }
  
  // Alignment patterns
  const alignCoords = ALIGN_POS[version];
  for (const row of alignCoords) {
    for (const col of alignCoords) {
      // Skip if overlaps with finder patterns
      if ((row < 9 && col < 9) || (row < 9 && col > size - 9) || (row > size - 9 && col < 9)) {
        continue;
      }
      placeAlignment(modules, reserved, row, col);
    }
  }
  
  // Dark module (always at row 4*v+9, column 8)
  const darkRow = 4 * version + 9;
  modules[darkRow][8] = 1;
  reserved[darkRow][8] = true;
  
  // Reserve format info areas
  for (let i = 0; i < 9; i++) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 8 + i] = true;
    reserved[size - 8 + i][8] = true;
  }
  
  // Reserve version info areas (for v >= 7)
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        reserved[i][size - 11 + j] = true;
        reserved[size - 11 + j][i] = true;
      }
    }
  }
  
  return { modules, reserved, size };
}

function placeFinder(modules, reserved, row, col) {
  // 7x7 finder pattern
  const pattern = [
    [1,1,1,1,1,1,1],
    [1,0,0,0,0,0,1],
    [1,0,1,1,1,0,1],
    [1,0,1,1,1,0,1],
    [1,0,1,1,1,0,1],
    [1,0,0,0,0,0,1],
    [1,1,1,1,1,1,1],
  ];
  
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      modules[row + r][col + c] = pattern[r][c];
      reserved[row + r][col + c] = true;
    }
  }
}

function placeAlignment(modules, reserved, centerRow, centerCol) {
  // 5x5 alignment pattern
  const pattern = [
    [1,1,1,1,1],
    [1,0,0,0,1],
    [1,0,1,0,1],
    [1,0,0,0,1],
    [1,1,1,1,1],
  ];
  
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      modules[centerRow + r][centerCol + c] = pattern[r + 2][c + 2];
      reserved[centerRow + r][centerCol + c] = true;
    }
  }
}

// ============================================================================
// Data placement (zig-zag)
// ============================================================================

function placeData(modules, reserved, data) {
  const size = modules.length;
  let bitIdx = 0;
  let upward = true;
  
  for (let col = size - 1; col >= 0; col -= 2) {
    if (col === 6) col = 5; // Skip timing column
    
    const rows = upward ? Array.from({length: size}, (_, i) => size - 1 - i) : Array.from({length: size}, (_, i) => i);
    
    for (const row of rows) {
      for (let c = 0; c < 2; c++) {
        const curCol = col - c;
        if (curCol < 0 || reserved[row][curCol]) continue;
        
        if (bitIdx < data.length * 8) {
          const byteIdx = Math.floor(bitIdx / 8);
          const bitOffset = 7 - (bitIdx % 8);
          modules[row][curCol] = (data[byteIdx] >> bitOffset) & 1;
          bitIdx++;
        } else {
          modules[row][curCol] = 0;
        }
      }
    }
    
    upward = !upward;
  }
}

// ============================================================================
// Masking
// ============================================================================

function applyMask(modules, reserved, maskNum) {
  const size = modules.length;
  const masked = modules.map(row => [...row]);
  
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (reserved[row][col]) continue;
      
      let invert = false;
      switch (maskNum) {
        case 0: invert = (row + col) % 2 === 0; break;
        case 1: invert = row % 2 === 0; break;
        case 2: invert = col % 3 === 0; break;
        case 3: invert = (row + col) % 3 === 0; break;
        case 4: invert = (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0; break;
        case 5: invert = (row * col) % 2 + (row * col) % 3 === 0; break;
        case 6: invert = ((row * col) % 2 + (row * col) % 3) % 2 === 0; break;
        case 7: invert = ((row + col) % 2 + (row * col) % 3) % 2 === 0; break;
      }
      
      if (invert) {
        masked[row][col] ^= 1;
      }
    }
  }
  
  return masked;
}

function calculatePenalty(modules) {
  const size = modules.length;
  let penalty = 0;
  
  // N1: Runs of 5+ same-color modules
  for (let row = 0; row < size; row++) {
    let runLen = 1;
    for (let col = 1; col < size; col++) {
      if (modules[row][col] === modules[row][col - 1]) {
        runLen++;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }
  
  for (let col = 0; col < size; col++) {
    let runLen = 1;
    for (let row = 1; row < size; row++) {
      if (modules[row][col] === modules[row - 1][col]) {
        runLen++;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }
  
  // N2: 2x2 blocks of same color
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const val = modules[row][col];
      if (val === modules[row][col + 1] && val === modules[row + 1][col] && val === modules[row + 1][col + 1]) {
        penalty += 3;
      }
    }
  }
  
  // N3: Specific patterns (10111010000 or 00001011101)
  const pattern1 = [1,0,1,1,1,0,1,0,0,0,0];
  const pattern2 = [0,0,0,0,1,0,1,1,1,0,1];
  
  for (let row = 0; row < size; row++) {
    for (let col = 0; col <= size - 11; col++) {
      let match1 = true, match2 = true;
      for (let i = 0; i < 11; i++) {
        if (modules[row][col + i] !== pattern1[i]) match1 = false;
        if (modules[row][col + i] !== pattern2[i]) match2 = false;
      }
      if (match1 || match2) penalty += 40;
    }
  }
  
  for (let col = 0; col < size; col++) {
    for (let row = 0; row <= size - 11; row++) {
      let match1 = true, match2 = true;
      for (let i = 0; i < 11; i++) {
        if (modules[row + i][col] !== pattern1[i]) match1 = false;
        if (modules[row + i][col] !== pattern2[i]) match2 = false;
      }
      if (match1 || match2) penalty += 40;
    }
  }
  
  // N4: Proportion of dark modules
  let darkCount = 0;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (modules[row][col] === 1) darkCount++;
    }
  }
  const totalModules = size * size;
  const darkPercent = (darkCount * 100) / totalModules;
  penalty += Math.floor(Math.abs(darkPercent - 50) / 5) * 10;
  
  return penalty;
}

// ============================================================================
// Format and version information
// ============================================================================

function placeFormatInfo(modules, ecLevel, maskNum) {
  const size = modules.length;
  const data = (EC_INDICATOR[ecLevel] << 3) | maskNum;
  const formatInfo = bchFormatInfo(data);

  for (let i = 0; i < 15; i++) {
    const bit = (formatInfo >> i) & 1;
    if (i < 6) modules[i][8] = bit;
    else if (i < 8) modules[i + 1][8] = bit;
    else modules[size - 15 + i][8] = bit;
  }
  for (let i = 0; i < 15; i++) {
    const bit = (formatInfo >> i) & 1;
    if (i < 8) modules[8][size - i - 1] = bit;
    else if (i < 9) modules[8][15 - i] = bit;
    else modules[8][14 - i] = bit;
  }
}

function placeVersionInfo(modules, version) {
  if (version < 7) return;
  
  const size = modules.length;
  const versionInfo = bchVersionInfo(version);
  
  // Place in two 3x6 blocks
  // Bottom-left: rows size-11 to size-9, cols 0-5
  for (let i = 0; i < 18; i++) {
    const row = size - 11 + (i % 3);
    const col = Math.floor(i / 3);
    modules[row][col] = (versionInfo >> i) & 1;
  }
  
  // Top-right: rows 0-5, cols size-11 to size-9
  for (let i = 0; i < 18; i++) {
    const row = Math.floor(i / 3);
    const col = size - 11 + (i % 3);
    modules[row][col] = (versionInfo >> i) & 1;
  }
}

// ============================================================================
// Main encoding function
// ============================================================================

export function qrEncode(text, options = {}) {
  const { errorCorrectionLevel = 'M' } = options;
  const ecLevel = errorCorrectionLevel.toUpperCase();
  
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  
  const version = selectVersion(bytes.length, ecLevel);
  const data = encodeData(text, version, ecLevel);
  const blocks = splitIntoBlocks(data, version, ecLevel);
  const interleaved = interleaveBlocks(blocks);
  
  const { modules, reserved, size } = createMatrix(version);
  placeData(modules, reserved, interleaved);
  
  // Find best mask
  let bestMask = 0;
  let bestPenalty = Infinity;
  
  for (let mask = 0; mask < 8; mask++) {
    const masked = applyMask(modules, reserved, mask);
    const penalty = calculatePenalty(masked);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
  }
  
  const finalModules = applyMask(modules, reserved, bestMask);
  placeFormatInfo(finalModules, ecLevel, bestMask);
  placeVersionInfo(finalModules, version);
  
  return {
    version,
    size,
    modules: finalModules
  };
}

// ============================================================================
// PNG encoding
// ============================================================================

const CRC_TABLE = new Uint32Array(256);
(function initCRCTable() {
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    CRC_TABLE[i] = c;
  }
})();

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makePNGChunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const len = data.length;
  const chunk = new Uint8Array(4 + 4 + len + 4);
  
  const view = new DataView(chunk.buffer);
  view.setUint32(0, len, false); // Big-endian length
  
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  
  const crcData = new Uint8Array(4 + len);
  crcData.set(typeBytes, 0);
  crcData.set(data, 4);
  const crcValue = crc32(crcData);
  view.setUint32(8 + len, crcValue, false);
  
  return chunk;
}

export async function qrPngBytes(modules, options = {}) {
  const { scale = 8, border = 4 } = options;
  const size = modules.length;
  const imgSize = (size + 2 * border) * scale;
  
  // Create raw pixel data (grayscale, 8-bit)
  const rawData = new Uint8Array(imgSize * (imgSize + 1)); // +1 for filter byte per row
  
  for (let y = 0; y < imgSize; y++) {
    const rowOffset = y * (imgSize + 1);
    rawData[rowOffset] = 0; // Filter type: None
    
    for (let x = 0; x < imgSize; x++) {
      const moduleX = Math.floor(x / scale) - border;
      const moduleY = Math.floor(y / scale) - border;
      
      let pixelValue = 255; // White
      if (moduleX >= 0 && moduleX < size && moduleY >= 0 && moduleY < size) {
        pixelValue = modules[moduleY][moduleX] === 1 ? 0 : 255;
      }
      
      rawData[rowOffset + 1 + x] = pixelValue;
    }
  }
  
  // Compress with deflate
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(rawData);
  writer.close();
  
  const compressed = await new Response(cs.readable).arrayBuffer();
  const compressedBytes = new Uint8Array(compressed);
  
  // Build PNG
  const signature = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  
  // IHDR chunk
  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, imgSize, false); // Width
  ihdrView.setUint32(4, imgSize, false); // Height
  ihdrData[8] = 8; // Bit depth
  ihdrData[9] = 0; // Color type: grayscale
  ihdrData[10] = 0; // Compression method
  ihdrData[11] = 0; // Filter method
  ihdrData[12] = 0; // Interlace method
  const ihdrChunk = makePNGChunk('IHDR', ihdrData);
  
  // IDAT chunk
  const idatChunk = makePNGChunk('IDAT', compressedBytes);
  
  // IEND chunk
  const iendChunk = makePNGChunk('IEND', new Uint8Array(0));
  
  // Concatenate all
  const png = new Uint8Array(signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length);
  let offset = 0;
  png.set(signature, offset); offset += signature.length;
  png.set(ihdrChunk, offset); offset += ihdrChunk.length;
  png.set(idatChunk, offset); offset += idatChunk.length;
  png.set(iendChunk, offset);
  
  return png;
}

export async function qrPngDataUri(text, options = {}) {
  const { modules } = qrEncode(text, options);
  const png = await qrPngBytes(modules, options);
  
  // Convert to base64 (chunked to avoid call stack overflow)
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < png.length; i += chunkSize) {
    const chunk = png.subarray(i, Math.min(i + chunkSize, png.length));
    binary += String.fromCharCode.apply(null, chunk);
  }
  const base64 = btoa(binary);
  
  return `data:image/png;base64,${base64}`;
}
