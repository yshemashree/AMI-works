import { PassThrough } from 'node:stream';
import yauzl from 'yauzl';
import { withBlockCache } from './rangeCache.js';
import { AmiError } from '../utils/errors.js';

// Archives are untrusted uploads. Nothing is ever written to disk, so
// zip-slip can't happen, but a zip bomb still costs CPU and RAM.
export const ZIP_LIMITS = {
  maxEntries: 5000,
  maxEntryBytes: 200 * 1024 * 1024,
  maxTotalInflatedBytes: 1024 * 1024 * 1024,
  // A 10MB+ entry that claims to compress better than 1000:1 is almost
  // certainly a bomb, not a real file.
  maxRatio: 1000,
};

/**
 * Opens a ZIP (or any ZIP-based Office file) from a Source.
 *
 * With `useRange` the archive is read through byte ranges: the central
 * directory first, then only the entries someone asks for. A 400MB deck
 * that is mostly embedded video costs a few MB of transfer that way.
 * Without it the whole file is read into one Buffer, which is faster for
 * small files (one request instead of several).
 *
 * @returns {Promise<ZipArchive>}
 */
export async function openZip(source, { useRange = false, maxBytes, limits = ZIP_LIMITS } = {}) {
  let zipfile;
  let cache = null;
  try {
    if (useRange && source.readRange && source.size != null) {
      cache = withBlockCache(source);
      zipfile = await fromReader(new CachedRangeReader(cache), source.size);
    } else {
      const buffer = await source.readAll({ maxBytes });
      zipfile = await fromBuffer(buffer);
    }
  } catch (cause) {
    if (cause instanceof AmiError) throw cause;
    throw new AmiError(`Could not open ${source.name} as a ZIP (corrupt or not a zip)`, {
      code: 'INVALID_ZIP',
      cause,
    });
  }

  if (zipfile.entryCount > limits.maxEntries) {
    zipfile.close();
    throw new AmiError(
      `${source.name} has ${zipfile.entryCount} entries, over the safety limit of ${limits.maxEntries}`,
      { code: 'ZIP_TOO_LARGE' },
    );
  }

  const entries = await listEntries(zipfile);
  return new ZipArchive(zipfile, entries, { limits, name: source.name, cache });
}

class ZipArchive {
  constructor(zipfile, entries, { limits, name, cache }) {
    this.zipfile = zipfile;
    this.entries = entries;
    this.limits = limits;
    this.name = name;
    this.cache = cache;
    this.inflated = 0;
    this.byName = new Map(entries.map((e) => [e.name, e]));
  }

  get(name) {
    return this.byName.get(name);
  }

  /** Why an entry would be refused, or null if it's fine to inflate. */
  refusal(entry, maxBytes = this.limits.maxEntryBytes) {
    if (entry.size > maxBytes) return `larger than ${maxBytes} bytes`;
    const ratio = entry.compressedSize ? entry.size / entry.compressedSize : 0;
    if (entry.size > 10 * 1024 * 1024 && ratio > this.limits.maxRatio) return 'suspicious compression ratio';
    if (this.inflated + entry.size > this.limits.maxTotalInflatedBytes) return 'archive inflate budget used up';
    return null;
  }

  /** Inflates one entry into a Buffer sized exactly from the central directory. */
  async read(entryOrName, { maxBytes } = {}) {
    const entry = typeof entryOrName === 'string' ? this.get(entryOrName) : entryOrName;
    if (!entry) return null;

    const refusal = this.refusal(entry, maxBytes);
    if (refusal) {
      throw new AmiError(`Refusing to read ${entry.name} from ${this.name}: ${refusal}`, {
        code: 'ZIP_ENTRY_REFUSED',
      });
    }
    this.inflated += entry.size;

    const stream = await new Promise((resolve, reject) => {
      this.zipfile.openReadStream(entry.raw, (err, s) => (err ? reject(err) : resolve(s)));
    });

    // yauzl checks the inflated length against the declared size, so the
    // preallocated buffer is exactly right and never has to grow.
    const out = Buffer.allocUnsafe(entry.size);
    let offset = 0;
    for await (const chunk of stream) {
      chunk.copy(out, offset);
      offset += chunk.length;
    }
    return out.subarray(0, offset);
  }

  async readText(name) {
    const buffer = await this.read(name);
    return buffer ? buffer.toString('utf8') : null;
  }

  close() {
    this.zipfile.close();
  }
}

// yauzl's reader interface is callback/stream based; this adapts it to
// the block cache, which is promise based.
class CachedRangeReader extends yauzl.RandomAccessReader {
  constructor(cache) {
    super();
    this.cache = cache;
  }

  _readStreamForRange(start, end) {
    const out = new PassThrough();
    this.cache.read(start, end).then(
      (data) => out.end(data),
      (error) => out.destroy(error),
    );
    return out;
  }
}

const YAUZL_OPTIONS = { lazyEntries: true, autoClose: false, decodeStrings: false };

function fromBuffer(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, YAUZL_OPTIONS, (err, zf) => (err ? reject(err) : resolve(zf)));
  });
}

function fromReader(reader, size) {
  return new Promise((resolve, reject) => {
    yauzl.fromRandomAccessReader(reader, size, YAUZL_OPTIONS, (err, zf) =>
      err ? reject(err) : resolve(zf),
    );
  });
}

function listEntries(zipfile) {
  return new Promise((resolve, reject) => {
    const entries = [];
    zipfile.on('entry', (raw) => {
      const name = decodeName(raw);
      entries.push({
        name,
        size: raw.uncompressedSize,
        compressedSize: raw.compressedSize,
        crc32: raw.crc32,
        isDirectory: name.endsWith('/'),
        raw,
      });
      zipfile.readEntry();
    });
    zipfile.on('end', () => resolve(entries));
    zipfile.on('error', reject);
    zipfile.readEntry();
  });
}

// We ask yauzl for raw name bytes so a single hostile entry name (a
// "../" path, say) doesn't abort the whole archive. The names are only
// ever used as labels, never as paths on disk.
function decodeName(raw) {
  const utf8Flag = (raw.generalPurposeBitFlag & 0x800) !== 0;
  return raw.fileName.toString(utf8Flag ? 'utf8' : 'latin1').replace(/\\/g, '/');
}

/** macOS resource forks, dotfiles and similar noise that isn't content. */
export function isJunkEntry(name) {
  const base = name.split('/').pop();
  return name.startsWith('__MACOSX/') || base.startsWith('.') || base === 'Thumbs.db';
}
