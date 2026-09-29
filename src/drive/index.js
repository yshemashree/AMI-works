// Drive component: talking to Google Drive and nothing else.
//
// Lists folders, hands out Sources (src/reader/sources.js) that read a
// Drive file into memory or by byte range, and streams uploads in. It
// has no idea what a PDF or a slide is - that's the reader's job.
import { config } from '../config.js';
import { hasSavedToken, hasOAuthClientConfig } from './oauth.js';

export { createDriveClient, createReadClient, callDrive } from './auth.js';
export {
  createOAuthDriveClient,
  buildAuthUrl,
  completeLogin,
  hasSavedToken,
  hasOAuthClientConfig,
  signOut,
  tokenPath,
} from './oauth.js';
export { listFolder, toEntry, isReadable, assertFolderId, GOOGLE_EXPORTS } from './folder.js';
export { driveSource, collect } from './source.js';
export { uploadStream, uploadFile } from './upload.js';

/** What the GUI needs to know to show the right buttons. */
export function authStatus() {
  const serviceAccount = Boolean(config.drive.keyPath);
  const signedIn = hasSavedToken();
  return {
    serviceAccount,
    oauthConfigured: hasOAuthClientConfig(),
    signedIn,
    canRead: serviceAccount || signedIn,
    canUpload: signedIn,
  };
}
