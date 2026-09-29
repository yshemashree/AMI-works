import { statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { isSupportedName } from '../reader/detect.js';
import { AmiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Resolves CLI inputs - files, directories, ZIPs - into a flat list of
 * file paths. ZIPs are passed through as-is: the reader opens them in
 * memory, so nothing gets extracted to a temp folder any more.
 */
export function resolveInputs(inputPaths) {
  const resolved = [];
  for (const inputPath of inputPaths) {
    const stat = statOrThrow(inputPath);
    if (stat.isDirectory()) {
      resolved.push(...walkDirectory(inputPath));
    } else if (isSupportedName(inputPath)) {
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

function statOrThrow(inputPath) {
  try {
    return statSync(inputPath);
  } catch (cause) {
    throw new AmiError(`Input path not found: ${inputPath}`, { code: 'FILE_NOT_FOUND', cause });
  }
}

function walkDirectory(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkDirectory(fullPath));
    else if (isSupportedName(fullPath)) files.push(fullPath);
  }
  return files.sort();
}
