import { createHash } from 'node:crypto';

export const SCHEMA = 'ami.document/v1';

// Anything smaller than this on its shorter side is an icon, bullet or
// spacer. Worth listing in the JSON, not worth paying a vision call for.
const MIN_VISION_SIDE_PX = 48;

/**
 * Starts the JSON record every reader fills in. One shape for every
 * format, so whatever consumes it (the GUI, a DB, the analysis stage)
 * never branches on file type.
 */
export function newDocument(source, type) {
  return {
    schema: SCHEMA,
    source: {
      name: source.name,
      type,
      mimeType: source.mimeType || null,
      sizeBytes: source.size ?? null,
      origin: source.origin,
      ...pickDefined(source.meta),
    },
    metadata: {},
    stats: {},
    text: '',
    markdown: null,
    sections: [],
    images: [],
    charts: [],
    children: [],
    warnings: [],
    engine: { reader: null, markdown: null, strategy: null },
    timings: {},
  };
}

export function finalizeDocument(doc, startedAt) {
  const text = doc.text || '';
  const unique = doc.images.filter((img) => !img.duplicateOf);
  doc.stats = {
    ...doc.stats,
    characters: text.length,
    words: text ? text.split(/\s+/).filter(Boolean).length : 0,
    sections: doc.sections.length,
    images: doc.images.length,
    uniqueImages: unique.length,
    charts: doc.charts.length,
    sectionsNeedingVision: doc.sections.filter((s) => s.needsVision).length,
    imagesNeedingVision: unique.filter((img) => img.needsVision).length,
  };
  if (doc.children.length) doc.stats.files = doc.children.length;
  doc.timings.totalMs = Math.round(performance.now() - startedAt);
  return doc;
}

/**
 * Keeps the image list for one document: gives each image a stable id,
 * spots repeats (the same logo on every slide) and decides which ones are
 * worth a vision call. Repeats are found by CRC32 + size straight from
 * the ZIP directory when we have it, so we don't even need the bytes.
 */
export class ImageRegistry {
  constructor(doc) {
    this.doc = doc;
    this.seen = new Map();
  }

  add({ name, size, crc32, bytes, info, mimeType, section = null }) {
    const fingerprint =
      crc32 != null ? `crc:${crc32.toString(16)}:${size}` : bytes ? `sha1:${sha1(bytes)}` : null;
    const record = {
      id: `img-${this.doc.images.length + 1}`,
      name,
      mimeType: info?.mimeType || mimeType || null,
      width: info?.width ?? null,
      height: info?.height ?? null,
      bytes: size ?? bytes?.length ?? null,
      section,
      duplicateOf: fingerprint ? this.seen.get(fingerprint) ?? null : null,
      needsVision: false,
      visionReason: null,
    };

    if (fingerprint && !record.duplicateOf) this.seen.set(fingerprint, record.id);
    Object.assign(record, visionVerdict(record));
    this.doc.images.push(record);
    return record;
  }
}

function visionVerdict(img) {
  if (img.duplicateOf) return { needsVision: false, visionReason: `same image as ${img.duplicateOf}` };
  if (!img.mimeType) return { needsVision: false, visionReason: 'format a vision model cannot read' };
  if (img.width != null && img.height != null && Math.min(img.width, img.height) < MIN_VISION_SIDE_PX) {
    return { needsVision: false, visionReason: 'icon-sized' };
  }
  return { needsVision: true, visionReason: 'embedded picture' };
}

/** Rough markdown -> plain text, good enough for search and word counts. */
export function markdownToText(markdown) {
  return String(markdown || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>]+/g, '')
    .replace(/\s*\|\s*/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function sha1(buffer) {
  return createHash('sha1').update(buffer).digest('hex');
}

function pickDefined(obj = {}) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}
