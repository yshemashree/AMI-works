import path from 'node:path/posix';
import { XMLParser } from 'fast-xml-parser';
import { openPackage, readProperties, readRels, readChart, readMedia, slimPackage } from '../office.js';
import { ImageRegistry, normalizeWhitespace } from '../document.js';
import { convertWithMarkItDown } from './markdown.js';
import { toVisuals } from './docx.js';
import { ExtractionError } from '../../utils/errors.js';

const xmlParser = new XMLParser({ ignoreAttributes: true, textNodeName: '_text' });
const SLIDE_PART = /^ppt\/slides\/slide(\d+)\.xml$/;

/**
 * PPTX -> per-slide text and speaker notes, which pictures and charts sit
 * on which slide, native chart data, and markdown via MarkItDown when
 * it's available (keeps tables on slides as real tables).
 */
export async function readPptx(source, doc, ctx) {
  let pkg;
  try {
    pkg = await openPackage(source, ctx);
  } catch (cause) {
    throw new ExtractionError(source.name, cause);
  }
  const { zip, strategy } = pkg;
  doc.engine.strategy = strategy;
  doc.engine.reader = 'pptx-xml';

  try {
    doc.metadata = await readProperties(zip);

    const slideParts = zip.entries
      .map((e) => e.name)
      .filter((name) => SLIDE_PART.test(name))
      .sort((a, b) => slideNumber(a) - slideNumber(b));

    const slideOfPart = new Map();
    const picturesOnSlide = new Map();
    for (const part of slideParts) {
      const number = slideNumber(part);
      const rels = await readRels(zip, part);
      const pictures = [];
      let chartCount = 0;
      let notes = null;

      for (const rel of rels.values()) {
        if (rel.type === 'image') {
          pictures.push(rel.target);
          if (!slideOfPart.has(rel.target)) slideOfPart.set(rel.target, number);
        } else if (rel.type === 'chart') {
          const chart = await readChart(zip, rel.target);
          if (chart) {
            doc.charts.push({ id: `chart-${doc.charts.length + 1}`, slide: number, ...chart });
            chartCount++;
          }
        } else if (rel.type === 'notesSlide') {
          notes = textOf(await zip.readText(rel.target)) || null;
        }
      }

      picturesOnSlide.set(number, pictures);
      const text = textOf(await zip.readText(part));
      doc.sections.push({
        kind: 'slide',
        number,
        text,
        notes,
        imageCount: pictures.length,
        chartCount,
        // Settled once the pictures are registered below. Native charts
        // are read as data above, so they never need a model.
        needsVision: false,
        visionReason: 'text and native charts only',
      });
    }
    doc.stats.slides = slideParts.length;

    doc.text = doc.sections
      .map((s) => [s.text, s.notes && `Notes: ${s.notes}`].filter(Boolean).join('\n'))
      .filter(Boolean)
      .join('\n\n');

    const markdown = await convertWithMarkItDown(ctx, source.name, () => pkg.buffer ?? slimPackage(zip), doc);
    if (markdown) doc.markdown = markdown;

    const media = await readMedia(zip, 'ppt/media/', new ImageRegistry(doc), {
      sectionOf: (part) => slideOfPart.get(part) ?? null,
      keepBytes: ctx.withVisuals,
      maxBytes: ctx.maxInMemoryBytes,
    });
    settleSlideVerdicts(doc.sections, picturesOnSlide, media);
    return toVisuals(media, source.name);
  } finally {
    zip.close();
  }
}

// A slide needs a vision call only if it has a picture that is worth
// one and wasn't already covered on an earlier slide (a logo repeated on
// every slide is analysed once).
function settleSlideVerdicts(sections, picturesOnSlide, media) {
  const recordOfPart = new Map(media.map((m) => [m.part, m.record]));
  for (const section of sections) {
    const records = (picturesOnSlide.get(section.number) || []).map((p) => recordOfPart.get(p)).filter(Boolean);
    if (!records.length) continue;
    const fresh = records.filter((r) => r.needsVision && r.section === section.number);
    section.needsVision = fresh.length > 0;
    section.visionReason = fresh.length
      ? `${fresh.length} picture(s) to analyse`
      : records.some((r) => r.needsVision)
        ? 'pictures already covered on an earlier slide'
        : 'only icon-sized or unreadable pictures';
  }
}

function slideNumber(part) {
  return Number(path.basename(part).match(/(\d+)/)[1]);
}

function textOf(xml) {
  if (!xml) return '';
  const runs = [];
  collectRuns(xmlParser.parse(xml), runs);
  return normalizeWhitespace(runs.join(' '));
}

// Text lives in a:t runs at any depth (shapes, tables, groups). Walking
// the whole tree for them is simpler and sturdier than modelling the
// schema.
function collectRuns(node, out) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectRuns(item, out);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'a:t') {
      for (const v of [].concat(value)) {
        const text = typeof v === 'object' ? v?._text : v;
        if (text != null && String(text).length) out.push(String(text));
      }
    } else {
      collectRuns(value, out);
    }
  }
}
