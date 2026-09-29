import path from 'node:path/posix';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { openZip } from './zip.js';
import { bufferSource } from './sources.js';
import { imageInfo, mimeFromName } from './imageInfo.js';

// Shared plumbing for the ZIP-based Office formats (DOCX, PPTX, XLSX).
// They're all "a ZIP of XML parts plus a media folder", so opening,
// metadata, relationships, native charts and embedded pictures work the
// same way for each of them.

const chartParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ['c:ser', 'c:pt', 'a:p', 'a:r'].includes(name),
});

const MEDIA_DIRS = ['/media/', '/embeddings/'];

/**
 * Opens an Office package. Small files: one read into memory, and the
 * original bytes are kept for MarkItDown. Large files: range reads, and
 * MarkItDown gets a slimmed copy (see slimPackage).
 */
export async function openPackage(source, ctx) {
  const useRange = Boolean(source.readRange) && source.size != null && source.size > ctx.rangeThresholdBytes;
  if (useRange) {
    const zip = await openZip(source, { useRange: true });
    return { zip, buffer: null, strategy: 'range' };
  }
  const buffer = await source.readAll({ maxBytes: ctx.maxInMemoryBytes });
  const zip = await openZip(bufferSource(source.name, buffer));
  return { zip, buffer, strategy: 'buffer' };
}

export function isMediaPart(name) {
  return MEDIA_DIRS.some((dir) => name.includes(dir));
}

/** docProps/core.xml + app.xml -> title, author, dates, app, counts. */
export async function readProperties(zip) {
  const [core, app] = await Promise.all([zip.readText('docProps/core.xml'), zip.readText('docProps/app.xml')]);
  const tag = (xml, name) => {
    const match = xml?.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`));
    return match ? decodeXml(match[1]).trim() || null : null;
  };
  const props = {
    title: tag(core, 'dc:title'),
    subject: tag(core, 'dc:subject'),
    author: tag(core, 'dc:creator'),
    lastModifiedBy: tag(core, 'cp:lastModifiedBy'),
    created: tag(core, 'dcterms:created'),
    modified: tag(core, 'dcterms:modified'),
    application: tag(app, 'Application'),
  };
  return Object.fromEntries(Object.entries(props).filter(([, v]) => v));
}

/** Relationship id -> { target part name, type } for one part. */
export async function readRels(zip, partName) {
  const relsName = path.join(path.dirname(partName), '_rels', `${path.basename(partName)}.rels`);
  const xml = await zip.readText(relsName);
  const rels = new Map();
  if (!xml) return rels;

  for (const [tag] of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const attr = (name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
    if (attr('TargetMode') === 'External') continue;
    const target = attr('Target');
    if (!target) continue;
    const resolved = target.startsWith('/')
      ? target.slice(1)
      : path.normalize(path.join(path.dirname(partName), target));
    rels.set(attr('Id'), { target: resolved, type: attr('Type')?.split('/').pop() });
  }
  return rels;
}

/**
 * Native (editable) charts are XML with the numbers inside, not pictures.
 * Reading them directly gives exact data with no vision call at all.
 */
export async function readChart(zip, partName) {
  const xml = await zip.readText(partName);
  if (!xml) return null;

  const root = chartParser.parse(xml)['c:chartSpace']?.['c:chart'];
  if (!root) return null;

  const plot = root['c:plotArea'] || {};
  const series = [];
  const kinds = [];
  for (const [key, group] of Object.entries(plot)) {
    if (!/^c:\w+Chart$/.test(key)) continue;
    kinds.push(key.slice(2).replace(/Chart$/, ''));
    for (const groupNode of [].concat(group)) {
      for (const ser of groupNode?.['c:ser'] || []) {
        series.push({
          name: collectPoints(ser['c:tx']).join(' ') || null,
          categories: collectPoints(ser['c:cat'] || ser['c:xVal']),
          values: collectPoints(ser['c:val'] || ser['c:yVal']).map(toNumber),
        });
      }
    }
  }

  return {
    part: partName,
    type: kinds.join('+') || 'unknown',
    title: collectText(root['c:title']) || null,
    series,
  };
}

/**
 * Registers every picture under `mediaPrefix`. Bytes are only inflated
 * when we need them: for dimensions (small images) or for the analysis
 * stage (`keepBytes`). Returns { record, bytes } per image.
 */
export async function readMedia(zip, mediaPrefix, registry, { sectionOf = () => null, keepBytes = false, maxBytes }) {
  const out = [];
  const entries = zip.entries.filter((e) => !e.isDirectory && e.name.startsWith(mediaPrefix));

  for (const entry of entries) {
    const mimeType = mimeFromName(entry.name);
    // Dimensions only need the header, but inflating is all-or-nothing,
    // so a huge picture isn't worth it (in range mode it would also mean
    // downloading it) unless the analysis stage needs the pixels anyway.
    const wantBytes = mimeType && (keepBytes || entry.size <= 5 * 1024 * 1024);
    let bytes = null;
    if (wantBytes && !zip.refusal(entry, maxBytes)) {
      bytes = await zip.read(entry, { maxBytes });
    }

    const record = registry.add({
      name: path.basename(entry.name),
      size: entry.size,
      crc32: entry.crc32,
      info: bytes ? imageInfo(bytes) : null,
      mimeType,
      section: sectionOf(entry.name),
    });
    out.push({ record, bytes: keepBytes ? bytes : null, part: entry.name });
  }
  return out;
}

/**
 * Rebuilds the package with every media file emptied out. Parsers that
 * insist on a full file (MarkItDown, mammoth) still get a valid package
 * with all relationships intact, but we never downloaded the pictures
 * or videos. Stored uncompressed, since it only lives for one call.
 */
export async function slimPackage(zip) {
  const out = new JSZip();
  for (const entry of zip.entries) {
    if (entry.isDirectory) continue;
    const data = isMediaPart(entry.name) ? Buffer.alloc(0) : await zip.read(entry);
    out.file(entry.name, data);
  }
  return out.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

export function decodeXml(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

// Finds the first c:pt list anywhere under a node (strCache, numCache,
// multi-level caches all nest differently) and returns the values in
// index order.
function collectPoints(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node['c:pt'])) {
    return [...node['c:pt']]
      .sort((a, b) => Number(a['@_idx'] ?? 0) - Number(b['@_idx'] ?? 0))
      .map((pt) => String(pt['c:v'] ?? ''));
  }
  for (const value of Object.values(node)) {
    const found = collectPoints(value);
    if (found.length) return found;
  }
  return [];
}

function collectText(node) {
  const parts = [];
  (function walk(n) {
    if (n == null) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n !== 'object') return;
    for (const [key, value] of Object.entries(n)) {
      if (key === 'a:t') parts.push(typeof value === 'object' ? value['#text'] ?? '' : String(value));
      else walk(value);
    }
  })(node);
  return parts.join('').trim();
}

function toNumber(value) {
  const n = Number(value);
  return value !== '' && Number.isFinite(n) ? n : value;
}
