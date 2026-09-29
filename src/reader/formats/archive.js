import { openZip, isJunkEntry } from '../zip.js';
import { isSupportedName } from '../detect.js';
import { AmiError } from '../../utils/errors.js';

const MAX_DEPTH = 3; // a zip inside a zip inside a zip, and no further

/**
 * A ZIP upload. Each supported entry is inflated on its own, read into a
 * child document, and released before the next one - so memory tracks
 * the largest single file in the archive, not the archive's total size.
 * Nothing is written to disk, which also rules out zip-slip entirely.
 *
 * `ctx.onChild(document, visuals)` lets a caller (the analysis stage)
 * consume each file as soon as it's read instead of holding them all.
 */
export async function readArchive(source, doc, ctx) {
  const depth = ctx.depth ?? 0;
  if (depth >= MAX_DEPTH) {
    throw new AmiError(`${source.name}: archives nested more than ${MAX_DEPTH} deep are not opened`, {
      code: 'ZIP_TOO_DEEP',
    });
  }

  const useRange = Boolean(source.readRange) && source.size != null && source.size > ctx.rangeThresholdBytes;
  const zip = await openZip(source, { useRange, maxBytes: ctx.maxInMemoryBytes });
  doc.engine.reader = 'zip';
  doc.engine.strategy = useRange ? 'range' : 'buffer';
  doc.skipped = [];

  const visuals = [];
  const basePath = source.meta?.path || source.name;

  try {
    for (const entry of zip.entries) {
      if (entry.isDirectory || isJunkEntry(entry.name)) continue;
      if (!isSupportedName(entry.name)) {
        doc.skipped.push({ name: entry.name, reason: 'unsupported file type' });
        continue;
      }
      const refusal = zip.refusal(entry, ctx.maxInMemoryBytes);
      if (refusal) {
        doc.skipped.push({ name: entry.name, reason: refusal });
        continue;
      }

      const child = entrySource(zip, entry, `${basePath}/${entry.name}`);
      const { document, visuals: childVisuals } = await ctx.readChild(child, { ...ctx, depth: depth + 1 });
      doc.children.push(document);

      if (ctx.onChild) await ctx.onChild(document, childVisuals);
      else visuals.push(...childVisuals.map((v) => ({ ...v, file: document.source.path })));
    }
  } finally {
    zip.close();
  }

  doc.text = doc.children
    .filter((c) => c.text)
    .map((c) => `## ${c.source.path}\n\n${c.text}`)
    .join('\n\n');
  doc.sections = doc.children.map((c, i) => ({
    kind: 'file',
    number: i + 1,
    title: c.source.path,
    text: '',
    needsVision: Boolean(c.stats?.sectionsNeedingVision || c.stats?.imagesNeedingVision),
    visionReason: c.error ? 'could not be read' : 'see child document',
  }));
  if (doc.children.length === 0) doc.warnings.push('Archive had no supported files in it.');
  return visuals;
}

function entrySource(zip, entry, fullPath) {
  return {
    name: entry.name.split('/').pop(),
    size: entry.size,
    origin: 'archive',
    meta: { path: fullPath },
    readAll: ({ maxBytes } = {}) => zip.read(entry, { maxBytes }),
    // Deflated data can't be seeked into, so no readRange: children of
    // an archive are always read whole, one at a time.
  };
}
