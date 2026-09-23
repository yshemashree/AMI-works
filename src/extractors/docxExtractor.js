import { readFileSync } from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { ExtractionError } from '../utils/errors.js';

const IMAGE_EXT_TO_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  emf: null, // vector/legacy formats vision models can't consume directly - skipped
  wmf: null,
};

/**
 * Extracts a .docx into full text plus every embedded image
 * (word/media/*). A .docx is a ZIP container, so embedded pictures,
 * charts-as-images, and screenshots pasted into the document all live as
 * separate media entries independent of the text layer - both need to be
 * pulled out and sent to the model.
 */
export async function extractDocx(filePath) {
  let buffer;
  try {
    buffer = readFileSync(filePath);
  } catch (cause) {
    throw new ExtractionError(filePath, cause);
  }

  const [text, images] = await Promise.all([
    extractText(filePath, buffer),
    extractEmbeddedImages(filePath, buffer),
  ]);

  return { sourceFile: filePath, text, images };
}

async function extractText(filePath, buffer) {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value.trim();
  } catch (cause) {
    throw new ExtractionError(filePath, cause);
  }
}

async function extractEmbeddedImages(filePath, buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const mediaEntries = Object.values(zip.files).filter(
      (f) => !f.dir && f.name.startsWith('word/media/'),
    );

    const images = [];
    for (const entry of mediaEntries) {
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      const mimeType = IMAGE_EXT_TO_MIME[ext];
      if (!mimeType) continue; // unsupported/vector format for direct model input

      const data = await entry.async('nodebuffer');
      images.push({
        sourceFile: filePath,
        label: `${path.basename(filePath)} - ${path.basename(entry.name)}`,
        base64: data.toString('base64'),
        mimeType,
      });
    }
    return images;
  } catch (cause) {
    throw new ExtractionError(filePath, cause);
  }
}
