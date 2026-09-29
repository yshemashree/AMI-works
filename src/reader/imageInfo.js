// Image dimensions straight from the file header - no decode, no canvas.
// Enough for the JSON output and for skipping icon-sized images before
// they ever reach a vision model.

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  // Vector/legacy formats a vision model can't take directly.
  emf: null,
  wmf: null,
  svg: null,
  tif: null,
  tiff: null,
};

export function mimeFromName(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] ?? null;
}

/** @returns {{ width: number, height: number, mimeType: string } | null} */
export function imageInfo(buffer) {
  if (!buffer || buffer.length < 24) return null;

  // PNG: IHDR is always the first chunk.
  if (buffer.readUInt32BE(0) === 0x89504e47) {
    return { mimeType: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  // GIF87a / GIF89a
  if (buffer.toString('latin1', 0, 3) === 'GIF') {
    return { mimeType: 'image/gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  // BMP
  if (buffer.toString('latin1', 0, 2) === 'BM' && buffer.length >= 26) {
    return {
      mimeType: 'image/bmp',
      width: Math.abs(buffer.readInt32LE(18)),
      height: Math.abs(buffer.readInt32LE(22)),
    };
  }
  // WEBP
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    return webpInfo(buffer);
  }
  // JPEG: walk segments until a start-of-frame marker.
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return jpegInfo(buffer);
  }
  return null;
}

function jpegInfo(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buffer[offset + 1];
    // SOF0-SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        mimeType: 'image/jpeg',
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    offset += 2 + buffer.readUInt16BE(offset + 2);
  }
  return { mimeType: 'image/jpeg', width: null, height: null };
}

function webpInfo(buffer) {
  const chunk = buffer.toString('latin1', 12, 16);
  if (chunk === 'VP8X' && buffer.length >= 30) {
    return {
      mimeType: 'image/webp',
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (chunk === 'VP8 ' && buffer.length >= 30) {
    return {
      mimeType: 'image/webp',
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L' && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return { mimeType: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return { mimeType: 'image/webp', width: null, height: null };
}
