import path from 'node:path';
import { analyzeImage } from './analyzeImage.js';

/**
 * Runs every visual unit of an extracted document (PDF page renders,
 * standalone images, or a DOCX/PPTX's embedded pictures) through a model
 * client and returns one report combining the text layer with per-visual
 * findings.
 *
 * Concurrency is capped to avoid tripping provider rate limits when a
 * document/ZIP contains many pages or images.
 */
export async function analyzeDocument(client, extracted, { concurrency = 3 } = {}) {
  const fileName = path.basename(extracted.filePath);
  // PDF images are full-page renders (the page's text layer is directly
  // relevant context); DOCX/PPTX images are individually embedded
  // pictures with no single corresponding page of text, so they're
  // analyzed standalone instead.
  const isFullPageRender = extracted.category === 'pdf';

  const tasks = extracted.images.map((image) => async () =>
    analyzeImage(client, image, isFullPageRender
      ? { fileName, pageLabel: `page ${image.pageNumber}`, surroundingText: image.pageText ?? extracted.text }
      : { fileName, context: `Image embedded in ${fileName}` }));

  const visualAnalyses = await runWithConcurrency(tasks, concurrency);

  return {
    filePath: extracted.filePath,
    category: extracted.category,
    extractedText: extracted.text,
    pageCount: extracted.pageCount ?? extracted.slideCount ?? null,
    visualAnalyses,
    // The full reader output (text, tables, native charts, metadata),
    // so a report carries what was read for free alongside what the
    // model said about the pictures.
    document: extracted.document,
  };
}

async function runWithConcurrency(taskFns, limit) {
  const results = new Array(taskFns.length);
  let cursor = 0;

  async function worker() {
    while (cursor < taskFns.length) {
      const current = cursor++;
      results[current] = await taskFns[current]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, taskFns.length) }, worker);
  await Promise.all(workers);
  return results;
}
