import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { AmiError } from '../utils/errors.js';

/**
 * A Source is the only thing the reader needs to know about where bytes
 * come from. Local files, browser uploads and Drive files all implement
 * it, so the reader never imports anything Drive- or HTTP-specific.
 *
 * @typedef {Object} Source
 * @property {string} name                 file name, used for type detection and labels
 * @property {number|null} size            bytes, when known up front
 * @property {string} [mimeType]
 * @property {string} origin               'local' | 'upload' | 'drive' | 'archive'
 * @property {Object} [meta]               ids worth carrying into the JSON (driveFileId, md5, path...)
 * @property {(opts?: {maxBytes?: number}) => Promise<Buffer>} readAll
 * @property {(start: number, end: number) => Promise<Buffer>} [readRange]  end is exclusive
 */

export function bufferSource(name, buffer, { mimeType, origin = 'upload', meta = {} } = {}) {
  return {
    name,
    size: buffer.length,
    mimeType,
    origin,
    meta,
    async readAll({ maxBytes } = {}) {
      assertWithinLimit(name, buffer.length, maxBytes);
      return buffer;
    },
    async readRange(start, end) {
      return buffer.subarray(start, end);
    },
  };
}

export async function fileSource(filePath, { origin = 'local', meta = {} } = {}) {
  let info;
  try {
    info = await stat(filePath);
  } catch (cause) {
    throw new AmiError(`File not found: ${filePath}`, { code: 'FILE_NOT_FOUND', cause });
  }
  if (info.isDirectory()) {
    throw new AmiError(`Expected a file, got a directory: ${filePath}`, { code: 'INVALID_INPUT' });
  }

  return {
    name: path.basename(filePath),
    size: info.size,
    origin,
    meta: { path: filePath, ...meta },
    async readAll({ maxBytes } = {}) {
      assertWithinLimit(filePath, info.size, maxBytes);
      return readFile(filePath);
    },
    async readRange(start, end) {
      const handle = await open(filePath, 'r');
      try {
        const length = Math.max(0, Math.min(end, info.size) - start);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
  };
}

export function assertWithinLimit(name, size, maxBytes) {
  if (maxBytes && size != null && size > maxBytes) {
    throw new AmiError(
      `${name} is ${formatBytes(size)}, over the ${formatBytes(maxBytes)} in-memory limit for this format`,
      { code: 'FILE_TOO_LARGE' },
    );
  }
}

export function formatBytes(bytes) {
  if (bytes == null) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
