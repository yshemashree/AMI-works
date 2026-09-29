import { imageInfo, mimeFromName } from '../imageInfo.js';
import { ImageRegistry } from '../document.js';
import { ExtractionError } from '../../utils/errors.js';

/**
 * A standalone image. The JSON gets its dimensions and format from the
 * header alone; pixels are only decoded (and downscaled when oversized)
 * if the analysis stage asked for visuals.
 */
export async function readImage(source, doc, ctx) {
  const bytes = await source.readAll({ maxBytes: ctx.maxInMemoryBytes });
  const info = imageInfo(bytes);
  doc.engine.reader = 'image-header';
  doc.engine.strategy = 'buffer';

  const record = new ImageRegistry(doc).add({
    name: source.name,
    bytes,
    info,
    mimeType: mimeFromName(source.name) || source.mimeType,
    section: 1,
  });
  doc.sections.push({
    kind: 'image',
    number: 1,
    text: '',
    needsVision: record.needsVision,
    visionReason: record.visionReason,
  });

  if (!ctx.withVisuals || !record.needsVision) return [];
  return [await prepareForModel(bytes, record, source.name, ctx.maxImageDimension)];
}

async function prepareForModel(bytes, record, name, maxDimension) {
  const longest = Math.max(record.width || 0, record.height || 0);
  if (record.width && longest <= maxDimension) {
    return visual(record, name, bytes.toString('base64'), record.mimeType, record.width, record.height);
  }

  // Oversized (or dimensions unknown): decode and redraw within the cap.
  // Vision models downscale anyway; sending fewer pixels just costs less.
  try {
    const { loadImage, createCanvas } = await import('@napi-rs/canvas');
    const image = await loadImage(bytes);
    const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
    const width = Math.round(image.width * scale);
    const height = Math.round(image.height * scale);
    if (scale === 1) {
      return visual(record, name, bytes.toString('base64'), record.mimeType || 'image/png', width, height);
    }
    const canvas = createCanvas(width, height);
    canvas.getContext('2d').drawImage(image, 0, 0, width, height);
    return visual(record, name, canvas.toBuffer('image/png').toString('base64'), 'image/png', width, height);
  } catch (cause) {
    throw new ExtractionError(name, cause);
  }
}

function visual(record, name, base64, mimeType, width, height) {
  return { id: record.id, kind: 'image', label: name, section: 1, base64, mimeType, width, height };
}
