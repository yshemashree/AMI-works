// Reader component: bytes in, JSON out.
//
// Knows about file formats and nothing else - no Drive, no HTTP, no
// model APIs, no temp files. Callers hand it a Source (see sources.js),
// optionally a MarkItDown converter, and get back one JSON document.
import { config } from '../config.js';
import { detectType, needsMarkItDown } from './detect.js';
import { newDocument, finalizeDocument } from './document.js';
import { readPdf } from './formats/pdf.js';
import { readDocx } from './formats/docx.js';
import { readPptx } from './formats/pptx.js';
import { readSpreadsheet } from './formats/xlsx.js';
import { readImage } from './formats/image.js';
import { readText } from './formats/text.js';
import { readArchive } from './formats/archive.js';
import { AmiError, UnsupportedFileTypeError } from '../utils/errors.js';

const READERS = {
  pdf: readPdf,
  docx: readDocx,
  pptx: readPptx,
  xlsx: readSpreadsheet,
  xls: readSpreadsheet,
  image: readImage,
  text: readText,
  zip: readArchive,
};

/**
 * @param {import('./sources.js').Source} source
 * @param {Object} [options]
 * @param {Object}  [options.converter]    MarkItDown client (src/markitdown); omit to stay pure JS
 * @param {boolean} [options.withVisuals]  also return base64 images for the analysis stage
 * @param {'auto'|'all'|'none'} [options.visionPages]  which PDF pages to render when withVisuals
 * @param {(doc, visuals) => Promise<void>} [options.onChild]  called per file inside a ZIP
 * @returns {Promise<{ document: Object, visuals: Object[] }>}
 */
export async function readDocument(source, options = {}) {
  const ctx = {
    rangeThresholdBytes: options.rangeThresholdBytes ?? config.reader.rangeThresholdBytes,
    maxInMemoryBytes: options.maxInMemoryBytes ?? config.reader.maxInMemoryBytes,
    maxImageDimension: options.maxImageDimension ?? config.maxImageDimension,
    converter: options.converter ?? null,
    withVisuals: Boolean(options.withVisuals),
    visionPages: options.visionPages || 'auto',
    onChild: options.onChild,
    depth: 0,
    readChild: readOne,
  };
  return readOne(source, ctx);
}

async function readOne(source, ctx) {
  const startedAt = performance.now();
  const detected = await detect(source);
  const doc = newDocument(source, detected.type);

  try {
    if (detected.legacyOffice) {
      throw new AmiError(`${source.name}: legacy binary Office format (${detected.extension}). Re-save it as .docx/.pptx.`, {
        code: 'LEGACY_OFFICE_FORMAT',
      });
    }
    const reader = READERS[detected.type];
    if (!reader) throw new UnsupportedFileTypeError(source.name, detected.extension || 'unknown');
    if (needsMarkItDown(detected.type) && !ctx.converter) {
      throw new AmiError(`${source.name}: ${detected.extension} files need the MarkItDown worker.`, {
        code: 'NEEDS_MARKITDOWN',
      });
    }

    const visuals = await reader(source, doc, ctx);
    return { document: finalizeDocument(doc, startedAt), visuals };
  } catch (error) {
    // Inside an archive one bad file shouldn't sink the rest; it's
    // recorded on its own child document instead. At the top level the
    // caller decides.
    if (ctx.depth === 0) throw error;
    doc.error = { code: error.code || 'READ_FAILED', message: error.message };
    return { document: finalizeDocument(doc, startedAt), visuals: [] };
  }
}

async function detect(source) {
  const byName = detectType(source.name, { mimeType: source.mimeType });
  if (byName.type || byName.legacyOffice || !source.readRange) return byName;
  // No usable extension or mime type: sniff the first bytes.
  const head = await source.readRange(0, 16);
  return { ...detectType(source.name, { head }), extension: byName.extension };
}

export { bufferSource, fileSource, formatBytes } from './sources.js';
export { detectType, isSupportedName, FORMATS } from './detect.js';
export { SCHEMA } from './document.js';
export { extractFile } from './legacy.js';
