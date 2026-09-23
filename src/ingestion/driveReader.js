import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { createDriveClient, callDrive } from './driveAuth.js';
import { isSupportedExtension } from '../extractors/index.js';
import { AmiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const PAGE_SIZE = 100;

/**
 * Downloads every supported file from a Drive folder into the work dir and
 * returns the local paths. Those paths go straight into resolveInputs /
 * extractFile, so nothing downstream knows the files came from Drive.
 *
 * Pass `drive` to inject a client (tests do this).
 */
export async function fetchDriveFolder({ folderId = config.drive.folderId, drive } = {}) {
  const target = typeof folderId === 'string' ? folderId.trim() : '';
  if (!target) {
    throw new AmiError('No Drive folder id. Pass --folder <id> or set DRIVE_FOLDER_ID.', {
      code: 'MISSING_DRIVE_FOLDER',
    });
  }

  const client = drive || (await createDriveClient('read'));
  const entries = await listFolder(client, target);
  const supported = entries.filter(isSupportedDriveFile);

  if (supported.length === 0) {
    throw new AmiError(`No supported files in Drive folder ${target}`, { code: 'NO_INPUT_FILES' });
  }

  const downloadDir = path.join(config.workDir, 'drive', randomUUID());
  mkdirSync(downloadDir, { recursive: true });

  const files = [];
  for (const entry of supported) {
    files.push(await downloadFile(client, entry, downloadDir));
  }

  logger.info(`Downloaded ${files.length} file(s) from Drive folder ${target}`);
  return { downloadDir, files };
}

async function listFolder(client, folderId) {
  const entries = [];
  let pageToken;

  do {
    const response = await callDrive(() =>
      client.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType)',
        pageSize: PAGE_SIZE,
        pageToken,
        // Both of these are needed or a shared drive folder lists empty.
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
    );
    entries.push(...(response.data.files || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return entries;
}

function isSupportedDriveFile(entry) {
  if (entry.mimeType === 'application/vnd.google-apps.folder') return false;

  // Docs/Sheets/Slides have no stored file to fetch, only an export
  // conversion. Not doing that here.
  if (entry.mimeType?.startsWith('application/vnd.google-apps')) {
    logger.warn(`Skipping Google-native file: ${entry.name}`);
    return false;
  }
  if (!isSupportedExtension(entry.name)) {
    logger.warn(`Skipping unsupported file: ${entry.name}`);
    return false;
  }
  return true;
}

async function downloadFile(client, entry, destDir) {
  const destPath = uniquePath(destDir, entry.name);
  const response = await callDrive(() =>
    client.files.get(
      { fileId: entry.id, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' },
    ),
  );

  await pipeline(response.data, createWriteStream(destPath));
  return destPath;
}

// Drive allows two files with the same name in one folder, and a name can
// contain a slash, so basename it and suffix on collision.
function uniquePath(destDir, name) {
  const safeName = path.basename(name);
  const ext = path.extname(safeName);
  const stem = path.basename(safeName, ext);

  let candidate = path.join(destDir, safeName);
  let counter = 1;
  while (existsSync(candidate)) {
    candidate = path.join(destDir, `${stem}-${counter}${ext}`);
    counter++;
  }
  return candidate;
}
