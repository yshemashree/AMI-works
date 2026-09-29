import { openPackage, readProperties, readRels, readChart, readMedia, slimPackage } from '../office.js';
import { ImageRegistry, markdownToText } from '../document.js';
import { convertWithMarkItDown } from './markdown.js';
import { ExtractionError } from '../../utils/errors.js';

/**
 * DOCX -> text (+ markdown with headings and tables when MarkItDown is
 * available), properties, native charts and embedded pictures.
 */
export async function readDocx(source, doc, ctx) {
  let pkg;
  try {
    pkg = await openPackage(source, ctx);
  } catch (cause) {
    throw new ExtractionError(source.name, cause);
  }
  const { zip, strategy } = pkg;
  doc.engine.strategy = strategy;

  try {
    doc.metadata = await readProperties(zip);

    const markdown = await convertWithMarkItDown(ctx, source.name, () => pkg.buffer ?? slimPackage(zip), doc);
    if (markdown) {
      doc.markdown = markdown;
      doc.text = markdownToText(markdown);
      doc.engine.reader = 'markitdown';
    } else {
      doc.text = await rawText(pkg.buffer ?? (await slimPackage(zip)), source.name);
      doc.engine.reader = 'mammoth';
    }
    doc.sections.push({ kind: 'body', number: 1, text: doc.text, needsVision: false, visionReason: 'text document' });

    const rels = await readRels(zip, 'word/document.xml');
    for (const rel of rels.values()) {
      if (rel.type !== 'chart') continue;
      const chart = await readChart(zip, rel.target);
      if (chart) doc.charts.push({ id: `chart-${doc.charts.length + 1}`, ...chart });
    }

    const media = await readMedia(zip, 'word/media/', new ImageRegistry(doc), {
      keepBytes: ctx.withVisuals,
      maxBytes: ctx.maxInMemoryBytes,
    });
    return toVisuals(media, source.name);
  } finally {
    zip.close();
  }
}

async function rawText(buffer, name) {
  try {
    const { default: mammoth } = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value.trim();
  } catch (cause) {
    throw new ExtractionError(name, cause);
  }
}

export function toVisuals(media, fileName) {
  return media
    .filter(({ record, bytes }) => record.needsVision && bytes)
    .map(({ record, bytes }) => ({
      id: record.id,
      kind: 'image',
      label: `${fileName} - ${record.name}`,
      section: record.section,
      base64: bytes.toString('base64'),
      mimeType: record.mimeType,
    }));
}
