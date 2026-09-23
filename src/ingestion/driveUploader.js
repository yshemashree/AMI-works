import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { callDrive } from './driveAuth.js';
import { createOAuthDriveClient } from './driveOAuth.js';
import { AmiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Uploads one local file into a Drive folder and returns the created
 * file's id, name and link.
 *
 * Authenticates as the signed-in user, not as the service account:
 * "Service Accounts do not have storage quota", so a file a service
 * account creates has nobody to bill the bytes to and Drive rejects it.
 * driveReader stays on the service account, reads are fine that way.
 *
 * Pass `drive` to inject a client (tests do this).
 */
export async function uploadFile(localPath, { folderId = config.drive.folderId, drive } = {}) {
  assertUploadable(localPath);

  const target = typeof folderId === 'string' ? folderId.trim() : '';
  if (!target) {
    throw new AmiError('No Drive folder id. Pass --folder <id> or set DRIVE_FOLDER_ID.', {
      code: 'MISSING_DRIVE_FOLDER',
    });
  }

  const client = drive || (await createOAuthDriveClient({ interactive: process.stdin.isTTY }));
  const name = path.basename(localPath);
  const body = createReadStream(localPath);

  let response;
  try {
    response = await callDrive(() =>
      client.files.create({
        requestBody: { name, parents: [target] },
        media: { body },
        fields: 'id, name, webViewLink',
        supportsAllDrives: true,
      }),
    );
  } catch (error) {
    // Request never read the stream. Drop it, and swallow the open error
    // that lands afterwards: the open is already queued by this point, and
    // with nothing listening it comes back as an uncaughtException.
    body.on('error', () => {});
    body.destroy();
    throw error;
  }

  const file = response.data;
  logger.info(`Uploaded ${name} to Drive folder ${target} (${file.id})`);
  return file;
}

function assertUploadable(localPath) {
  if (!localPath || typeof localPath !== 'string') {
    throw new AmiError('No file given to upload', { code: 'MISSING_INPUT' });
  }
  if (!existsSync(localPath)) {
    throw new AmiError(`File not found: ${localPath}`, { code: 'FILE_NOT_FOUND' });
  }
  if (statSync(localPath).isDirectory()) {
    throw new AmiError(`Expected a file, got a directory: ${localPath}`, { code: 'INVALID_INPUT' });
  }
}
