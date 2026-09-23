import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadImage, createCanvas } from '@napi-rs/canvas';
import { config } from '../config.js';
import { ExtractionError } from '../utils/errors.js';

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/**
 * Loads a standalone image file and prepares it for model input:
 * downscales oversized images (keeps API payloads and cost sane without
 * sacrificing the detail vision models actually use) and always returns
 * base64 PNG so callers don't juggle per-format mime types downstream.
 */
export async function extractImage(filePath) {
  try {
    const raw = readFileSync(filePath);
    const image = await loadImage(raw);
    const { width, height } = fitWithinLimit(image.width, image.height, config.maxImageDimension);

    let base64;
    let mimeType;
    if (width === image.width && height === image.height) {
      base64 = raw.toString('base64');
      mimeType = MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'image/png';
    } else {
      const canvas = createCanvas(width, height);
      canvas.getContext('2d').drawImage(image, 0, 0, width, height);
      base64 = canvas.toBuffer('image/png').toString('base64');
      mimeType = 'image/png';
    }

    return [
      {
        sourceFile: filePath,
        label: path.basename(filePath),
        base64,
        mimeType,
        width,
        height,
        originalWidth: image.width,
        originalHeight: image.height,
      },
    ];
  } catch (cause) {
    throw new ExtractionError(filePath, cause);
  }
}

function fitWithinLimit(width, height, maxDimension) {
  const longest = Math.max(width, height);
  if (longest <= maxDimension) return { width, height };
  const scale = maxDimension / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}
