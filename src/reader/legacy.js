import { readDocument } from './index.js';
import { fileSource } from './sources.js';

/**
 * The shape the analysis/comparison stage was built on:
 * { filePath, category, text, images[], pageCount?, slideCount? }.
 * Kept as a thin adapter over readDocument so that stage didn't need
 * rewriting; the full JSON document rides along as `document`.
 *
 * visionPages defaults to 'all' here to match the old behaviour (every
 * PDF page rendered). The CLI passes 'auto' to skip text-only pages.
 */
export async function extractFile(input, { visionPages = 'all', converter } = {}) {
  const source = typeof input === 'string' ? await fileSource(input) : input;
  const { document, visuals } = await readDocument(source, { withVisuals: true, visionPages, converter });
  return toExtracted(document, visuals);
}

export function toExtracted(document, visuals) {
  const filePath = document.source.path || document.source.name;
  const pageText = new Map(document.sections.map((s) => [s.number, s.text]));
  const prefix = { pdf: 'Page', pptx: 'Slide' }[document.source.type];

  return {
    filePath,
    category: document.source.type,
    text: prefix
      ? document.sections.map((s) => `[${prefix} ${s.number}] ${s.text}`).join('\n\n')
      : document.text,
    images: visuals.map((v) => ({
      sourceFile: v.file || filePath,
      label: v.label,
      base64: v.base64,
      mimeType: v.mimeType,
      pageNumber: v.pageNumber,
      pageText: v.pageNumber ? pageText.get(v.pageNumber) : undefined,
    })),
    pageCount: document.stats.pages,
    slideCount: document.stats.slides,
    document,
  };
}
