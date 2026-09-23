import { readFileSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { ExtractionError } from '../utils/errors.js';

const IMAGE_EXT_TO_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  emf: null,
  wmf: null,
};

const xmlParser = new XMLParser({ ignoreAttributes: true, textNodeName: '_text' });

/**
 * Extracts a .pptx into per-slide text plus every embedded image
 * (ppt/media/*), same rationale as the DOCX extractor: charts, diagrams,
 * and screenshots on a slide live outside the text runs and must be sent
 * to the vision model separately from the extracted text.
 */
export async function extractPptx(filePath) {
  let zip;
  try {
    zip = await JSZip.loadAsync(readFileSync(filePath));
  } catch (cause) {
    throw new ExtractionError(filePath, cause);
  }

  const slides = await extractSlideText(filePath, zip);
  const images = await extractEmbeddedImages(filePath, zip);

  return { sourceFile: filePath, slideCount: slides.length, slides, images };
}

async function extractSlideText(filePath, zip) {
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const slides = [];
  for (const name of slideFiles) {
    try {
      const xml = await zip.files[name].async('text');
      slides.push({ slideNumber: slideNumber(name), text: extractTextFromSlideXml(xml) });
    } catch (cause) {
      throw new ExtractionError(filePath, cause);
    }
  }
  return slides;
}

function slideNumber(entryName) {
  return Number.parseInt(entryName.match(/slide(\d+)\.xml$/)[1], 10);
}

function extractTextFromSlideXml(xml) {
  const parsed = xmlParser.parse(xml);
  const texts = [];
  collectTextRuns(parsed, texts);
  return texts.join(' ').replace(/\s+/g, ' ').trim();
}

// Slide XML nests text under a:t elements at arbitrary depth (shapes,
// tables, grouped shapes). Walking the whole parsed tree for any key
// named "a:t" is simpler and more robust than modeling the full schema.
function collectTextRuns(node, out) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectTextRuns(item, out);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'a:t') {
      const text = typeof value === 'object' ? value._text : value;
      if (text != null && String(text).length > 0) out.push(String(text));
    } else {
      collectTextRuns(value, out);
    }
  }
}

async function extractEmbeddedImages(filePath, zip) {
  const mediaEntries = Object.values(zip.files).filter(
    (f) => !f.dir && f.name.startsWith('ppt/media/'),
  );

  const images = [];
  for (const entry of mediaEntries) {
    const ext = path.extname(entry.name).slice(1).toLowerCase();
    const mimeType = IMAGE_EXT_TO_MIME[ext];
    if (!mimeType) continue;

    const data = await entry.async('nodebuffer');
    images.push({
      sourceFile: filePath,
      label: `${path.basename(filePath)} - ${path.basename(entry.name)}`,
      base64: data.toString('base64'),
      mimeType,
    });
  }
  return images;
}
