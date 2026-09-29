import { callDrive } from './auth.js';
import { assertWithinLimit } from '../reader/sources.js';
import { AmiError } from '../utils/errors.js';

/**
 * Turns a Drive file into a reader Source. Nothing is written to disk:
 *
 *  - readAll()   one GET, streamed straight into a Buffer preallocated to
 *                the size Drive reported (no chunk list, no concat copy,
 *                so peak memory is the file size, not twice it)
 *  - readRange() one GET with a Range header - the reader uses this for
 *                big ZIP-based files and PDFs so only the parts it parses
 *                are fetched
 *  - stream()    the raw response stream, for callers that pipe
 *
 * Google-native files are exported instead; exports can't be ranged.
 */
export function driveSource(client, entry) {
  const isExport = entry.kind === 'export';
  const meta = {
    driveFileId: entry.id,
    md5: entry.md5,
    modifiedTime: entry.modifiedTime,
    exportedFrom: isExport ? entry.mimeType : undefined,
  };

  const request = (headers) =>
    callDrive(() =>
      isExport
        ? client.files.export({ fileId: entry.id, mimeType: entry.export.mimeType }, { responseType: 'stream' })
        : client.files.get(
            { fileId: entry.id, alt: 'media', supportsAllDrives: true },
            { responseType: 'stream', ...(headers ? { headers } : {}) },
          ),
    );

  const source = {
    name: entry.name,
    size: isExport ? null : entry.size,
    mimeType: isExport ? entry.export.mimeType : entry.mimeType,
    origin: 'drive',
    meta,
    async readAll({ maxBytes } = {}) {
      assertWithinLimit(entry.name, source.size, maxBytes);
      const response = await request();
      return collect(response.data, { expected: source.size, maxBytes, name: entry.name });
    },
    async stream() {
      return (await request()).data;
    },
  };

  if (!isExport) {
    source.readRange = async (start, end) => {
      const response = await request({ Range: `bytes=${start}-${end - 1}` });
      const data = await collect(response.data, { expected: end - start, name: entry.name });
      // A server that ignores Range sends the whole file with a 200. The
      // bytes are still right once sliced; it's just slower.
      return response.status === 200 && data.length > end - start ? data.subarray(start, end) : data;
    };
  }
  return source;
}

/**
 * Reads a stream into one Buffer. With a known size the buffer is
 * allocated once up front; if the stream turns out longer (or the size
 * was unknown) it falls back to collecting chunks.
 */
export async function collect(stream, { expected, maxBytes, name = 'file' } = {}) {
  let out = expected != null ? Buffer.allocUnsafe(expected) : null;
  let offset = 0;
  const overflow = [];

  try {
    for await (const piece of stream) {
      const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
      if (maxBytes && offset + chunk.length > maxBytes) {
        throw new AmiError(`${name} is larger than the ${maxBytes} byte limit`, { code: 'FILE_TOO_LARGE' });
      }
      if (out && offset + chunk.length <= out.length) {
        chunk.copy(out, offset);
      } else {
        // More bytes than expected (the file changed since it was
        // listed, or a server ignored Range): switch to collecting chunks.
        if (out) {
          overflow.push(out.subarray(0, offset));
          out = null;
        }
        overflow.push(chunk);
      }
      offset += chunk.length;
    }
  } catch (error) {
    stream.destroy?.();
    throw error;
  }

  if (out) return out.subarray(0, offset);
  return Buffer.concat(overflow, offset);
}
