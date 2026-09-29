import path from 'node:path';
import { createRequire } from 'node:module';
import { normalizeWhitespace } from '../document.js';
import { ExtractionError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

const require = createRequire(import.meta.url);

// pdf.js is heavy to load, so it's only imported the first time a PDF
// actually shows up.
let pdfjsPromise;
function loadPdfjs() {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

// pdf.js reads its bundled fonts/cmaps with fs.readFile(baseUrl + name)
// in Node, so these must be plain paths with a trailing separator, not
// file:// URLs.
const PDFJS_ROOT = path.dirname(require.resolve('pdfjs-dist/package.json'));
const STANDARD_FONT_DATA_URL = path.join(PDFJS_ROOT, 'standard_fonts') + path.sep;
const CMAP_URL = path.join(PDFJS_ROOT, 'cmaps') + path.sep;

const RENDER_SCALE = 2; // ~192 DPI, enough for chart labels and small print
const MAX_PAGES = 500;
const RANGE_CHUNK = 256 * 1024;

// Page triage: a page only goes to a vision model if the text layer
// can't tell the whole story. Thresholds are deliberately generous - a
// false "needs vision" costs one call, a false "text only" loses a chart.
const SCANNED_TEXT_CHARS = 40;
const GRAPHICS_PATH_OPS = 25;

/**
 * Reads a PDF into per-page text plus a verdict on whether each page has
 * visual content worth a vision call. Pages are only rendered to images
 * when the caller asks for visuals, and then only the pages that need it.
 *
 * Big files are opened through byte ranges, so pdf.js pulls the page
 * content streams it parses and skips the rest (typically scanned
 * images) instead of downloading the whole file first.
 */
export async function readPdf(source, doc, ctx) {
  const pdfjs = await loadPdfjs();
  const useRange = Boolean(source.readRange) && source.size != null && source.size > ctx.rangeThresholdBytes;
  doc.engine.reader = 'pdf.js';
  doc.engine.strategy = useRange ? 'range' : 'buffer';

  let pdf;
  try {
    const common = {
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      disableFontFace: true,
      isEvalSupported: false, // untrusted input - keep pdf.js's eval paths off
      verbosity: 0,
    };
    if (useRange) {
      // A failed range read would otherwise leave pdf.js waiting forever,
      // so tear the task down and let the pending calls reject.
      let task = null;
      const transport = rangeTransport(pdfjs, source, () => task?.destroy());
      task = pdfjs.getDocument({
        ...common,
        range: transport,
        length: source.size,
        rangeChunkSize: RANGE_CHUNK,
        disableAutoFetch: true,
        disableStream: true,
      });
      pdf = await task.promise;
    } else {
      const buffer = await source.readAll({ maxBytes: ctx.maxInMemoryBytes });
      // pdf.js takes ownership of (and detaches) the array it's given.
      pdf = await pdfjs.getDocument({ ...common, data: new Uint8Array(buffer) }).promise;
    }
  } catch (cause) {
    throw new ExtractionError(source.name, cause);
  }

  const visuals = [];
  try {
    doc.metadata = await readMetadata(pdf);
    const pageCount = Math.min(pdf.numPages, MAX_PAGES);
    doc.stats.pages = pdf.numPages;
    if (pdf.numPages > MAX_PAGES) {
      doc.warnings.push(`Only the first ${MAX_PAGES} of ${pdf.numPages} pages were read.`);
    }

    // Operator lists make pdf.js decode images, which in range mode would
    // pull exactly the bytes we're trying not to download. There, triage
    // falls back to text density alone.
    const inspectGraphics = !useRange;

    for (let number = 1; number <= pageCount; number++) {
      let page;
      try {
        page = await pdf.getPage(number);
        const text = await pageText(page);
        const graphics = inspectGraphics ? await pageGraphics(page, pdfjs.OPS) : null;
        const verdict = triagePage(text, graphics);
        doc.sections.push({
          kind: 'page',
          number,
          text,
          imageCount: graphics?.images ?? null,
          ...verdict,
        });

        if (ctx.withVisuals && shouldRender(verdict, ctx.visionPages)) {
          visuals.push(await renderPage(page, source.name, number));
        }
      } catch (cause) {
        doc.warnings.push(`Page ${number} could not be read: ${cause.message}`);
        logger.warn(`Failed on page ${number} of ${source.name}: ${cause.message}`);
      } finally {
        page?.cleanup();
      }
    }
  } finally {
    await pdf.destroy();
  }

  if (doc.sections.length === 0) {
    throw new ExtractionError(source.name, new Error('No pages could be read'));
  }
  doc.text = doc.sections.map((s) => s.text).filter(Boolean).join('\n\n');
  return visuals;
}

function rangeTransport(pdfjs, source, onFailure) {
  const transport = new pdfjs.PDFDataRangeTransport(source.size, null);
  transport.requestDataRange = (begin, end) => {
    source.readRange(begin, end).then(
      (chunk) => transport.onDataRange(begin, new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length)),
      (error) => {
        logger.warn(`Range read ${begin}-${end} of ${source.name} failed: ${error.message}`);
        onFailure();
      },
    );
  };
  return transport;
}

async function readMetadata(pdf) {
  const { info } = await pdf.getMetadata().catch(() => ({ info: {} }));
  const meta = {
    title: info?.Title,
    author: info?.Author,
    subject: info?.Subject,
    creator: info?.Creator,
    producer: info?.Producer,
    created: pdfDate(info?.CreationDate),
    modified: pdfDate(info?.ModDate),
    pdfVersion: info?.PDFFormatVersion,
  };
  return Object.fromEntries(Object.entries(meta).filter(([, v]) => v));
}

// D:20260917103000+05'30' -> 2026-09-17T10:30:00+05:30
function pdfDate(value) {
  const m = String(value || '').match(/^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz]|[+-]\d{2}'?\d{2}'?)?/);
  if (!m) return value || null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', tz = 'Z'] = m;
  const zone = /^[Zz]$/.test(tz) ? 'Z' : tz.replace(/'/g, '').replace(/(\d{2})(\d{2})$/, '$1:$2');
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${zone}`;
}

async function pageText(page) {
  const content = await page.getTextContent();
  return normalizeWhitespace(content.items.map((item) => item.str).join(' '));
}

async function pageGraphics(page, OPS) {
  const { fnArray } = await page.getOperatorList();
  let images = 0;
  let paths = 0;
  for (const fn of fnArray) {
    if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      images++;
    } else if (fn === OPS.constructPath) {
      paths++;
    }
  }
  return { images, paths };
}

export function triagePage(text, graphics) {
  if (text.length < SCANNED_TEXT_CHARS) {
    return { needsVision: true, visionReason: text.length ? 'very little text - likely scanned' : 'no text layer - scanned or image-only' };
  }
  if (graphics?.images) return { needsVision: true, visionReason: `${graphics.images} image(s) on page` };
  if (graphics && graphics.paths >= GRAPHICS_PATH_OPS) {
    return { needsVision: true, visionReason: 'vector graphics - likely a chart or diagram' };
  }
  return { needsVision: false, visionReason: graphics ? 'text only' : 'text layer present (graphics not inspected)' };
}

function shouldRender(verdict, visionPages = 'auto') {
  if (visionPages === 'all') return true;
  if (visionPages === 'none') return false;
  return verdict.needsVision;
}

async function renderPage(page, fileName, number) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  const canvas = createCanvas(viewport.width, viewport.height);
  const context = canvas.getContext('2d');

  // pdf.js leaves the page transparent, which some viewers show as black.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, viewport.width, viewport.height);
  await page.render({ canvasContext: context, viewport }).promise;

  return {
    id: `page-${number}`,
    kind: 'page',
    label: `${fileName} - page ${number}`,
    pageNumber: number,
    base64: canvas.toBuffer('image/png').toString('base64'),
    mimeType: 'image/png',
    width: viewport.width,
    height: viewport.height,
  };
}
