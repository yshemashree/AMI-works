import { readDocument } from '../reader/index.js';
import { toExtracted } from '../reader/legacy.js';
import { logger } from '../utils/logger.js';

/**
 * Feeds every real document inside a source to `fn` in the shape the
 * analysis stage expects. A ZIP is unpacked in memory and each file in
 * it is handed over as soon as it's read, so a big archive never has
 * all its page renders in memory at once.
 *
 * visionPages 'auto' (the default) only renders PDF pages the reader
 * flagged as visual; text-only pages are covered by the text layer and
 * don't cost a model call.
 */
export async function forEachExtracted(source, { visionPages = 'auto', converter = null } = {}, fn) {
  const onChild = async (doc, visuals) => {
    if (doc.error) {
      logger.warn(`Skipping ${doc.source.path || doc.source.name}: ${doc.error.message}`);
      return;
    }
    if (doc.source.type !== 'zip') await fn(toExtracted(doc, visuals));
  };

  const { document, visuals } = await readDocument(source, { withVisuals: true, visionPages, converter, onChild });
  if (document.source.type !== 'zip') await fn(toExtracted(document, visuals));
}
