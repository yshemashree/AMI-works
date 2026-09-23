import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createCanvas } from '@napi-rs/canvas';
import { config } from '../config.js';
import { ExtractionError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const require = createRequire(import.meta.url);
const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

// pdfjs needs its bundled standard fonts/cmaps to lay out text correctly
// (without these, non-embedded-font glyphs mis-render). Resolve them from
// the installed package rather than hardcoding a path. In its Node code
// path, pdfjs reads these with fs.readFile(baseUrl + filename) directly -
// a plain filesystem path, NOT a file:// URL (that string would be
// treated as a literal, nonexistent path).
const PDFJS_ROOT = path.dirname(require.resolve('pdfjs-dist/package.json'));
const STANDARD_FONT_DATA_URL = path.join(PDFJS_ROOT, 'standard_fonts') + path.sep;
const CMAP_URL = path.join(PDFJS_ROOT, 'cmaps') + path.sep;

const RENDER_SCALE = 2; // ~192 DPI equivalent for a 96-DPI page; enough detail for charts/small text.
const MAX_PAGES = 200; // safety cap so a huge deck/report doesn't stall a run

/**
 * Extracts a PDF into per-page text AND a rendered PNG of each page.
 *
 * Text-only extraction misses charts, diagrams, tables rendered as
 * graphics, screenshots, and scanned/image-only pages - all of which the
 * spec requires analyzing. Rendering every page to an image and feeding
 * that to the vision model is the only reliable way to cover that
 * content regardless of how the PDF was produced.
 */
export async function extractPdf(filePath) {
  let doc;
  try {
    const data = new Uint8Array(readFileSync(filePath));
    const loadingTask = pdfjsLib.getDocument({
      data,
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      disableFontFace: true,
      isEvalSupported: false, // untrusted upload - keep pdf.js's optional JS-eval'd code paths off
    });
    doc = await loadingTask.promise;
  } catch (cause) {
    throw new ExtractionError(filePath, cause);
  }

  const pageCount = Math.min(doc.numPages, MAX_PAGES);
  if (doc.numPages > MAX_PAGES) {
    logger.warn(`${path.basename(filePath)} has ${doc.numPages} pages; only processing first ${MAX_PAGES}`);
  }

  const pages = [];
  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    try {
      const page = await doc.getPage(pageNum);
      const [text, image] = await Promise.all([
        extractPageText(page),
        renderPageToImage(page, filePath, pageNum),
      ]);
      pages.push({ pageNumber: pageNum, text, ...image });
    } catch (cause) {
      logger.warn(`Failed to process page ${pageNum} of ${path.basename(filePath)}: ${cause.message}`);
    } finally {
      // pdf.js keeps per-page resources cached until explicitly cleaned up.
      doc.getPage(pageNum).then((p) => p.cleanup()).catch(() => {});
    }
  }

  await doc.destroy();

  if (pages.length === 0) {
    throw new ExtractionError(filePath, new Error('No pages could be processed'));
  }

  return {
    sourceFile: filePath,
    pageCount: doc.numPages,
    pages,
  };
}

async function extractPageText(page) {
  const content = await page.getTextContent();
  return content.items.map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim();
}

async function renderPageToImage(page, filePath, pageNum) {
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext('2d');

  // White background - PDF pages are transparent by default in pdf.js's
  // canvas output, which would otherwise render as black in some viewers.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  await page.render({ canvasContext: ctx, viewport }).promise;

  return {
    label: `${path.basename(filePath)} - page ${pageNum}`,
    base64: canvas.toBuffer('image/png').toString('base64'),
    mimeType: 'image/png',
    width: viewport.width,
    height: viewport.height,
  };
}

export function ensureWorkDir() {
  mkdirSync(config.workDir, { recursive: true });
}
