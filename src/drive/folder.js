import path from 'node:path';
import { callDrive } from './auth.js';
import { isSupportedName } from '../reader/detect.js';
import { AmiError } from '../utils/errors.js';

const PAGE_SIZE = 200;
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// Google Docs/Sheets/Slides have no stored bytes, only an export. We
// export them to the matching Office format and read that, rather than
// skipping them like before.
export const GOOGLE_EXPORTS = {
  'application/vnd.google-apps.document': {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: '.docx',
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: '.pptx',
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: '.xlsx',
  },
  'application/vnd.google-apps.drawing': { mimeType: 'image/png', extension: '.png' },
};

// The id ends up inside a Drive query string, so anything that isn't an
// id is refused rather than escaped.
const FOLDER_ID = /^[A-Za-z0-9_-]{1,200}$/;

export function assertFolderId(folderId) {
  const id = typeof folderId === 'string' ? folderId.trim() : '';
  if (!id) {
    throw new AmiError('No Drive folder id. Pass --folder <id> or set DRIVE_FOLDER_ID.', {
      code: 'MISSING_DRIVE_FOLDER',
    });
  }
  if (!FOLDER_ID.test(id)) {
    throw new AmiError(`"${id}" doesn't look like a Drive folder id`, { code: 'INVALID_DRIVE_FOLDER' });
  }
  return id;
}

/**
 * Lists a folder in as few requests as possible, asking only for the
 * fields we use. size and md5Checksum come back for free here and are
 * what lets the pipeline pick a read strategy and skip unchanged files
 * without downloading anything.
 *
 * @returns {Promise<DriveEntry[]>} every child, each tagged with how it can be read
 */
export async function listFolder(client, folderId) {
  const id = assertFolderId(folderId);
  const entries = [];
  let pageToken;

  do {
    const response = await callDrive(() =>
      client.files.list({
        q: `'${id}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size, md5Checksum, modifiedTime, version)',
        pageSize: PAGE_SIZE,
        pageToken,
        orderBy: 'folder,name',
        // Both needed, or a shared-drive folder lists as empty.
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
    );
    for (const file of response.data.files || []) entries.push(toEntry(file));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return entries;
}

/**
 * @typedef {Object} DriveEntry
 * @property {string} id
 * @property {string} name          name the reader sees (exports get an Office extension)
 * @property {string} driveName     name as shown in Drive
 * @property {string} mimeType
 * @property {number|null} size
 * @property {string|null} md5
 * @property {string|null} modifiedTime
 * @property {'file'|'export'|'folder'|'unsupported'} kind
 * @property {Object} [export]      target format for Google-native files
 */
export function toEntry(file) {
  const base = {
    id: file.id,
    name: file.name,
    driveName: file.name,
    mimeType: file.mimeType,
    size: file.size != null ? Number(file.size) : null,
    md5: file.md5Checksum || null,
    modifiedTime: file.modifiedTime || null,
    version: file.version || null,
  };

  if (file.mimeType === FOLDER_MIME) return { ...base, kind: 'folder' };

  const exportAs = GOOGLE_EXPORTS[file.mimeType];
  if (exportAs) {
    const name = path.extname(file.name).toLowerCase() === exportAs.extension ? file.name : file.name + exportAs.extension;
    return { ...base, name, kind: 'export', export: exportAs };
  }
  if (file.mimeType?.startsWith('application/vnd.google-apps')) return { ...base, kind: 'unsupported' };

  return { ...base, kind: isSupportedName(file.name) ? 'file' : 'unsupported' };
}

export function isReadable(entry) {
  return entry.kind === 'file' || entry.kind === 'export';
}
