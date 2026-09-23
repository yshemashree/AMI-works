import { openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { detectCategory, isSupportedExtension } from './fileTypeDetector.js';
import { extractImage } from './imageExtractor.js';
import { extractPdf } from './pdfExtractor.js';
import { extractDocx } from './docxExtractor.js';
import { extractPptx } from './pptxExtractor.js';
import { AmiError, UnsupportedFileTypeError } from '../utils/errors.js';

/**
 * Runs the right extractor for a single file and normalizes the result
 * into a common shape: { filePath, category, text, images[] }.
 * `images` always carries base64 PNG/JPEG data ready for a vision model;
 * `text` is empty for image-only inputs.
 */
export async function extractFile(filePath) {
  // Only pay for the magic-byte sniff when the extension itself is
  // ambiguous (missing/unrecognized) - avoids an extra read for the
  // common case where the extension already tells us the category.
  const head = isSupportedExtension(filePath) ? null : safeReadHead(filePath);
  const { category, legacyOffice } = detectCategory(filePath, head);

  if (legacyOffice) {
    throw new AmiError(
      `Legacy binary Office format is not supported: ${filePath}. Convert to .docx/.pptx first.`,
      { code: 'LEGACY_OFFICE_FORMAT' },
    );
  }
  if (!category) {
    throw new UnsupportedFileTypeError(filePath, path.extname(filePath));
  }

  switch (category) {
    case 'image': {
      const images = await extractImage(filePath);
      return { filePath, category, text: '', images };
    }
    case 'pdf': {
      const result = await extractPdf(filePath);
      return {
        filePath,
        category,
        text: result.pages.map((p) => `[Page ${p.pageNumber}] ${p.text}`).join('\n\n'),
        images: result.pages.map((p) => ({
          sourceFile: filePath,
          label: p.label,
          base64: p.base64,
          mimeType: p.mimeType,
          pageNumber: p.pageNumber,
        })),
        pageCount: result.pageCount,
      };
    }
    case 'docx': {
      const result = await extractDocx(filePath);
      return { filePath, category, text: result.text, images: result.images };
    }
    case 'pptx': {
      const result = await extractPptx(filePath);
      return {
        filePath,
        category,
        text: result.slides.map((s) => `[Slide ${s.slideNumber}] ${s.text}`).join('\n\n'),
        images: result.images,
        slideCount: result.slideCount,
      };
    }
    default:
      throw new UnsupportedFileTypeError(filePath, category);
  }
}

function safeReadHead(filePath) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const buffer = Buffer.alloc(16);
    const bytesRead = readSync(fd, buffer, 0, 16, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export { detectCategory, isSupportedExtension } from './fileTypeDetector.js';
