import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { callDrive } from './auth.js';
import { assertFolderId } from './folder.js';
import { createOAuthDriveClient } from './oauth.js';
import { AmiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const RETURN_FIELDS = 'id, name, mimeType, size, md5Checksum, modifiedTime, webViewLink';

/**
 * Streams bytes into a new Drive file. The body is piped straight through
 * to Google, so an upload from the GUI never lands on the server's disk
 * and never sits whole in memory.
 *
 * Authenticates as the signed-in user, not the service account: service
 * accounts have no storage quota, so Drive refuses files they'd own.
 *
 * @returns {Promise<{id, name, mimeType, size, md5Checksum, webViewLink}>}
 */
export async function uploadStream({ body, name, mimeType, folderId = config.drive.folderId, drive }) {
  const target = assertFolderId(folderId);
  const safeName = path.basename(String(name || '').replace(/\\/g, '/')).trim();
  if (!safeName) throw new AmiError('Upload has no file name', { code: 'MISSING_INPUT' });

  const client = drive || (await createOAuthDriveClient({ interactive: process.stdin.isTTY }));
  try {
    const response = await callDrive(() =>
      client.files.create({
        requestBody: { name: safeName, parents: [target] },
        media: { mimeType: mimeType || undefined, body },
        fields: RETURN_FIELDS,
        supportsAllDrives: true,
      }),
    );
    logger.info(`Uploaded ${safeName} to Drive folder ${target} (${response.data.id})`);
    return response.data;
  } catch (error) {
    // The request may never have read the stream. Drop it, and swallow a
    // late error from it: with nobody listening it would become an
    // uncaughtException.
    body.on?.('error', () => {});
    body.destroy?.();
    throw error;
  }
}

/** Uploads one local file (the CLI path). */
export async function uploadFile(localPath, { folderId = config.drive.folderId, drive } = {}) {
  await assertUploadable(localPath);
  const target = assertFolderId(folderId);
  const client = drive || (await createOAuthDriveClient({ interactive: process.stdin.isTTY }));
  return uploadStream({ body: createReadStream(localPath), name: path.basename(localPath), folderId: target, drive: client });
}

async function assertUploadable(localPath) {
  if (!localPath || typeof localPath !== 'string') {
    throw new AmiError('No file given to upload', { code: 'MISSING_INPUT' });
  }
  let info;
  try {
    info = await stat(localPath);
  } catch {
    throw new AmiError(`File not found: ${localPath}`, { code: 'FILE_NOT_FOUND' });
  }
  if (info.isDirectory()) {
    throw new AmiError(`Expected a file, got a directory: ${localPath}`, { code: 'INVALID_INPUT' });
  }
}
