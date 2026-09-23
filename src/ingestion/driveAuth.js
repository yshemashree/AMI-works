import { existsSync } from 'node:fs';
import { config } from '../config.js';
import { AmiError, MissingCredentialsError } from '../utils/errors.js';

// Reader gets read-only. Uploader needs full drive, not drive.file: with
// drive.file the app can only touch files it created, so creating into a
// folder that was shared with the service account comes back as a 404 on
// the parent id.
const SCOPES = {
  read: ['https://www.googleapis.com/auth/drive.readonly'],
  write: ['https://www.googleapis.com/auth/drive'],
};

/**
 * Builds a Drive v3 client from the service account key file. Each caller
 * gets its own client so read and write scopes stay separate.
 */
export async function createDriveClient(mode) {
  const keyPath = config.drive.keyPath;
  if (!keyPath) {
    throw new MissingCredentialsError('Google Drive', 'GOOGLE_SERVICE_ACCOUNT_KEY_PATH');
  }
  if (!existsSync(keyPath)) {
    throw new AmiError(`Service account key file not found at ${keyPath}`, {
      code: 'DRIVE_KEY_NOT_FOUND',
    });
  }

  const { google } = await import('googleapis');

  try {
    const auth = new google.auth.GoogleAuth({ keyFile: keyPath, scopes: SCOPES[mode] });
    return google.drive({ version: 'v3', auth });
  } catch {
    // Deliberately dropping the original message. A malformed key file
    // fails as a JSON parse error, and V8 quotes the offending snippet of
    // the file in that message, which would put key material in the log.
    throw new AmiError(`Could not load the service account key at ${keyPath}`, {
      code: 'DRIVE_AUTH_FAILED',
    });
  }
}

/**
 * Runs one Drive API call and turns any failure into an AmiError.
 */
export async function callDrive(fn) {
  try {
    return await fn();
  } catch (cause) {
    throw toDriveError(cause);
  }
}

function toDriveError(cause) {
  const message = cause?.errors?.[0]?.message || cause?.message || 'unknown error';
  // No `cause` here on purpose. The googleapis error keeps a reference to
  // the auth client, and the auth client holds the parsed key.
  const error = new AmiError(`Drive request failed: ${message}`, { code: 'DRIVE_REQUEST_FAILED' });
  error.status = cause?.status ?? cause?.code;
  return error;
}
