import { statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { isSupportedExtension } from '../extractors/index.js';
import { extractZip } from './zipExtractor.js';
import { AmiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Resolves a CLI input path - a single file, a directory, or a ZIP - into
 * a flat list of supported file paths ready for extraction. This is the
 * one place that understands "what counts as input" so the CLI commands
 * stay thin.
 */
export function resolveInputs(inputPaths) {
  const resolved = [];
  for (const inputPath of inputPaths) {
    const stat = statSyncOrThrow(inputPath);

    if (stat.isDirectory()) {
      resolved.push(...walkDirectory(inputPath));
    } else if (inputPath.toLowerCase().endsWith('.zip')) {
      const { files } = extractZip(inputPath);
      resolved.push(...files.filter(isSupportedExtension));
    } else if (isSupportedExtension(inputPath)) {
      resolved.push(inputPath);
    } else {
      logger.warn(`Skipping unsupported file: ${inputPath}`);
    }
  }

  if (resolved.length === 0) {
    throw new AmiError('No supported files found in the given input(s)', { code: 'NO_INPUT_FILES' });
  }
  return resolved;
}

function statSyncOrThrow(inputPath) {
  try {
    return statSync(inputPath);
  } catch (cause) {
    throw new AmiError(`Input path not found: ${inputPath}`, { code: 'FILE_NOT_FOUND', cause });
  }
}

function walkDirectory(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDirectory(fullPath));
    } else if (entry.name.toLowerCase().endsWith('.zip')) {
      const { files: extracted } = extractZip(fullPath);
      files.push(...extracted.filter(isSupportedExtension));
    } else if (isSupportedExtension(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}
