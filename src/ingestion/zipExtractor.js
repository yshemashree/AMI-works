import AdmZip from 'adm-zip';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { AmiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024; // 500MB safety cap against zip bombs
const MAX_ENTRY_COUNT = 5000;

/**
 * Extracts a ZIP archive into an isolated directory under the configured
 * work dir and returns the list of extracted file paths.
 *
 * Guards against zip-slip (entries that escape the target directory via
 * "../") and zip-bomb style archives (entry count / uncompressed size caps)
 * since the ZIP comes from an untrusted upload.
 */
export function extractZip(zipPath) {
  if (!existsSync(zipPath)) {
    throw new AmiError(`ZIP file not found: ${zipPath}`, { code: 'FILE_NOT_FOUND' });
  }

  let zip;
  try {
    zip = new AdmZip(zipPath);
  } catch (cause) {
    throw new AmiError(`Could not open ZIP (corrupt or not a zip): ${zipPath}`, {
      code: 'INVALID_ZIP',
      cause,
    });
  }

  const entries = zip.getEntries();
  if (entries.length === 0) {
    throw new AmiError(`ZIP is empty: ${zipPath}`, { code: 'EMPTY_ZIP' });
  }
  if (entries.length > MAX_ENTRY_COUNT) {
    throw new AmiError(
      `ZIP has ${entries.length} entries, exceeding the safety limit of ${MAX_ENTRY_COUNT}`,
      { code: 'ZIP_TOO_LARGE' },
    );
  }

  const totalUncompressed = entries.reduce((sum, e) => sum + e.header.size, 0);
  if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
    throw new AmiError(
      `ZIP would expand to ${totalUncompressed} bytes, exceeding the ${MAX_UNCOMPRESSED_BYTES} byte safety limit`,
      { code: 'ZIP_TOO_LARGE' },
    );
  }

  const extractDir = path.join(config.workDir, 'extracted', randomUUID());
  mkdirSync(extractDir, { recursive: true });

  const extractedFiles = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const normalizedName = entry.entryName.replace(/\\/g, '/');
    const destPath = path.resolve(extractDir, normalizedName);

    // zip-slip guard: reject any entry that resolves outside extractDir.
    if (!destPath.startsWith(extractDir + path.sep) && destPath !== extractDir) {
      logger.warn(`Skipping ZIP entry with unsafe path: ${entry.entryName}`);
      continue;
    }

    // Skip macOS/Windows metadata and hidden junk that isn't real content.
    const base = path.basename(normalizedName);
    if (normalizedName.startsWith('__MACOSX/') || base.startsWith('.')) continue;

    mkdirSync(path.dirname(destPath), { recursive: true });
    try {
      zip.extractEntryTo(entry, path.dirname(destPath), false, true, false, base);
      extractedFiles.push(destPath);
    } catch (cause) {
      logger.warn(`Failed to extract entry "${entry.entryName}": ${cause.message}`);
    }
  }

  if (extractedFiles.length === 0) {
    cleanupExtractedDir(extractDir);
    throw new AmiError('ZIP contained no extractable files', { code: 'EMPTY_ZIP' });
  }

  logger.info(`Extracted ${extractedFiles.length} file(s) from ${path.basename(zipPath)}`);
  return { extractDir, files: extractedFiles };
}

export function cleanupExtractedDir(dir) {
  if (dir && existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
