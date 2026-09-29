// Pipeline: where the components meet.
//
//   Drive (src/drive)  ->  Reader (src/reader)  ->  JSON
//                          + MarkItDown (src/markitdown), optional
//
// Each component only knows its own job; this module decides which
// file goes where, remembers what's already been read (ResultCache)
// and keeps parallel work inside a memory budget (MemoryBudget).
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { config } from '../config.js';
import { readDocument, bufferSource, fileSource } from '../reader/index.js';
import { listFolder, isReadable, toEntry, driveSource, uploadStream, callDrive, collect } from '../drive/index.js';
import { ResultCache } from './cache.js';
import { MemoryBudget, mapLimit } from './budget.js';
import { resolveInputs } from './localInputs.js';
import { logger } from '../utils/logger.js';

export function createPipeline({
  converter = null,
  cache = new ResultCache(config.cache),
  budget = new MemoryBudget(config.reader.memoryBudgetBytes),
  concurrency = config.reader.concurrency,
  getReadClient,
  getWriteClient,
  readOptions = {},
} = {}) {
  const read = (source) => readDocument(source, { converter, ...readOptions });

  async function variant() {
    return converter && (await converter.isAvailable()) ? 'md' : 'plain';
  }

  /** Folder listing with a `cached` flag per file, so the GUI can show what's already done. */
  async function listDrive(folderId) {
    const drive = await getReadClient();
    const entries = await listFolder(drive, folderId);
    const v = await variant();
    return Promise.all(entries.map(async (entry) => ({ ...entry, cached: await cache.has(ResultCache.keyFor(entry, v)) })));
  }

  async function readDriveEntry(entry, drive) {
    const key = ResultCache.keyFor(entry, await variant());
    const hit = await cache.get(key);
    // Same bytes, but maybe a different file (a copy, a rename): the
    // content comes from the cache, the identity from this entry.
    if (hit) {
      hit.source = { ...hit.source, name: entry.name, origin: 'drive', driveFileId: entry.id, modifiedTime: entry.modifiedTime };
      return { document: hit, cached: true };
    }

    const release = await budget.acquire(estimateMemory(entry));
    try {
      const { document } = await read(driveSource(drive, entry));
      await cache.set(key, document);
      return { document, cached: false };
    } finally {
      release();
    }
  }

  async function readDriveFile(fileId) {
    const drive = await getReadClient();
    const { data } = await callDrive(() =>
      drive.files.get({
        fileId,
        fields: 'id, name, mimeType, size, md5Checksum, modifiedTime, version',
        supportsAllDrives: true,
      }),
    );
    return { entry: toEntry(data), ...(await readDriveEntry(toEntry(data), drive)) };
  }

  /**
   * Reads every readable file in a folder. One bad file doesn't stop the
   * rest; it comes back with `error` set.
   */
  async function readDriveFolder(folderId, { onProgress } = {}) {
    const drive = await getReadClient();
    const entries = await listFolder(drive, folderId);
    const readable = entries.filter(isReadable);
    const skipped = entries.filter((e) => !isReadable(e)).map((e) => ({ name: e.driveName, kind: e.kind }));

    let done = 0;
    const files = await mapLimit(readable, concurrency, async (entry) => {
      let result;
      try {
        result = { entry, ...(await readDriveEntry(entry, drive)) };
      } catch (error) {
        logger.warn(`Could not read ${entry.driveName}: ${error.message}`);
        result = { entry, document: null, error: { code: error.code || 'READ_FAILED', message: error.message } };
      }
      onProgress?.({ done: ++done, total: readable.length, entry, result });
      return result;
    });

    return { folderId, files, skipped, cache: { ...cache.stats } };
  }

  /**
   * GUI upload: one pass over the bytes does three things at once -
   * streams them to Drive, hashes them (MD5, the same checksum Drive
   * computes, so we can verify the upload), and keeps them in memory if
   * the file is small enough to read straight away. The JSON is ready
   * the moment Drive confirms, with no second download.
   *
   * Files over the inline limit aren't buffered; they're read back from
   * Drive afterwards with range requests.
   */
  async function uploadAndRead({ body, name, mimeType, folderId, inlineLimit = config.reader.rangeThresholdBytes }) {
    const tap = new HashingTap(inlineLimit);
    body.on('error', (error) => tap.destroy(error));
    body.pipe(tap);

    const drive = await getWriteClient();
    const uploading = uploadStream({ body: tap, name, mimeType, folderId, drive });
    const reading = tap.complete.then(async ({ md5, buffer }) => {
      if (!buffer) return null;
      const source = bufferSource(name, buffer, { mimeType, origin: 'upload', meta: { md5 } });
      const { document } = await read(source);
      return document;
    });
    // Don't let an early read failure go unhandled while the upload runs.
    reading.catch(() => {});

    const file = await uploading;
    const { md5 } = await tap.complete;
    const checksumMatches = file.md5Checksum ? file.md5Checksum === md5 : null;
    if (checksumMatches === false) {
      logger.warn(`Checksum mismatch for ${file.name}: sent ${md5}, Drive has ${file.md5Checksum}`);
    }

    let document = await reading;
    let cached = false;
    const entry = toEntry(file);
    if (document) {
      document.source.driveFileId = file.id;
      await cache.set(ResultCache.keyFor({ md5 }, await variant()), document);
    } else {
      ({ document, cached } = await readDriveEntry(entry, drive));
    }
    return { file, entry, document, checksumMatches, cached };
  }

  /** Read an uploaded file without keeping it anywhere (the GUI's "just extract"). */
  async function readUpload({ body, name, mimeType, maxBytes = config.reader.maxInMemoryBytes }) {
    const buffer = await collect(body, { maxBytes, name });
    const md5 = createHash('md5').update(buffer).digest('hex');
    const key = ResultCache.keyFor({ md5 }, await variant());
    const hit = await cache.get(key);
    if (hit) return { document: { ...hit, source: { ...hit.source, name } }, cached: true };

    const { document } = await read(bufferSource(name, buffer, { mimeType, origin: 'upload', meta: { md5 } }));
    await cache.set(key, document);
    return { document, cached: false };
  }

  async function readLocal(inputs) {
    const files = resolveInputs(inputs);
    const results = [];
    for (const filePath of files) {
      try {
        const { document } = await read(await fileSource(filePath));
        results.push({ filePath, document });
      } catch (error) {
        results.push({ filePath, document: null, error: { code: error.code || 'READ_FAILED', message: error.message } });
      }
    }
    return results;
  }

  return { listDrive, readDriveFile, readDriveEntry, readDriveFolder, uploadAndRead, readUpload, readLocal, cache, converter };
}

// Roughly what reading this file will hold in RAM: the whole file when
// it's read into a buffer (twice for PDFs, since pdf.js keeps its own
// copy), a bounded working set when it's read by range.
function estimateMemory(entry) {
  if (entry.size == null) return 16 * 1024 * 1024; // Google exports are capped at 10MB
  if (entry.size > config.reader.rangeThresholdBytes) return 32 * 1024 * 1024;
  return entry.size * 2;
}

/**
 * Pass-through stream that hashes everything and keeps a copy of it,
 * but gives up the copy (not the hash) once it passes `limit` bytes.
 * `complete` resolves when the last byte has gone through.
 */
class HashingTap extends Transform {
  constructor(limit) {
    super();
    this.limit = limit;
    this.hash = createHash('md5');
    this.chunks = [];
    this.size = 0;
    this.keep = true;
    this.complete = new Promise((resolve, reject) => {
      this.finish = resolve;
      this.on('error', reject);
    });
    this.complete.catch(() => {});
  }

  _transform(chunk, encoding, callback) {
    this.hash.update(chunk);
    this.size += chunk.length;
    if (this.keep) {
      if (this.size <= this.limit) {
        this.chunks.push(chunk);
      } else {
        this.keep = false;
        this.chunks = [];
      }
    }
    callback(null, chunk);
  }

  _flush(callback) {
    const buffer = this.keep ? Buffer.concat(this.chunks, this.size) : null;
    this.chunks = [];
    this.finish({ md5: this.hash.digest('hex'), size: this.size, buffer });
    callback();
  }
}

export { ResultCache, MemoryBudget, mapLimit, resolveInputs };
