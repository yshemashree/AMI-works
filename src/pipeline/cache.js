import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { SCHEMA } from '../reader/document.js';
import { logger } from '../utils/logger.js';

/**
 * Extracted JSON, keyed by what the file *is* rather than where it is.
 *
 * Drive hands us an MD5 of every file's content in the folder listing,
 * so "have we read these exact bytes before?" is answered before a
 * single byte is downloaded. Re-running a folder where nothing changed
 * costs one list call. Renamed or copied files hit the cache too, since
 * the content hash is the same.
 *
 * Memory LRU always; a directory of small JSON files as well when
 * CACHE_DIR is set, so results survive a restart. Only the JSON is
 * stored - never the source files.
 */
export class ResultCache {
  constructor({ dir = '', maxEntries = 500 } = {}) {
    this.dir = dir;
    this.maxEntries = maxEntries;
    this.memory = new Map();
    this.stats = { hits: 0, misses: 0 };
  }

  /**
   * @param {{md5?: string, id?: string, modifiedTime?: string}} identity
   * @param {string} variant  anything that changes the output (e.g. markdown on/off)
   * @returns {string|null}   null when the file can't be identified reliably
   */
  static keyFor(identity, variant = '') {
    const content = identity.md5
      ? `md5:${identity.md5}`
      : identity.id && identity.modifiedTime
        ? `drive:${identity.id}@${identity.modifiedTime}`
        : null;
    return content ? `${SCHEMA}|${variant}|${content}` : null;
  }

  /** Cheap presence check (no parse), for marking files as already read. */
  async has(key) {
    if (!key) return false;
    if (this.memory.has(key)) return true;
    if (!this.dir) return false;
    return access(this.fileFor(key)).then(
      () => true,
      () => false,
    );
  }

  async get(key) {
    if (!key) return null;
    if (this.memory.has(key)) {
      const value = this.memory.get(key);
      this.memory.delete(key);
      this.memory.set(key, value);
      this.stats.hits++;
      return structuredClone(value);
    }
    if (this.dir) {
      try {
        const value = JSON.parse(await readFile(this.fileFor(key), 'utf8'));
        this.remember(key, value);
        this.stats.hits++;
        return structuredClone(value);
      } catch {
        // missing or unreadable - treat as a miss
      }
    }
    this.stats.misses++;
    return null;
  }

  async set(key, document) {
    if (!key) return;
    this.remember(key, document);
    if (!this.dir) return;
    try {
      await mkdir(this.dir, { recursive: true });
      const target = this.fileFor(key);
      const tmp = `${target}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(document));
      await rename(tmp, target);
    } catch (error) {
      logger.warn(`Could not write cache entry: ${error.message}`);
    }
  }

  remember(key, value) {
    this.memory.set(key, value);
    while (this.memory.size > this.maxEntries) {
      this.memory.delete(this.memory.keys().next().value);
    }
  }

  fileFor(key) {
    return path.join(this.dir, `${createHash('sha1').update(key).digest('hex')}.json`);
  }
}
