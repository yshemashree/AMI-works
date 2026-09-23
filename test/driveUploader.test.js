import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { uploadFile } from '../src/ingestion/driveUploader.js';
import { config } from '../src/config.js';
import { AmiError } from '../src/utils/errors.js';
import { MockDriveClient, fakeDriveApiError } from './helpers/mockDriveClient.js';

let tmpDir;
let localFile;

// The folder default comes from config, so pin it for the tests that care.
// Without this they'd pass or fail depending on the .env of whoever runs them.
async function withConfiguredFolder(folderId, fn) {
  const previous = config.drive.folderId;
  config.drive.folderId = folderId;
  try {
    return await fn();
  } finally {
    config.drive.folderId = previous;
  }
}

before(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ami-drive-upload-test-'));
  localFile = path.join(tmpDir, 'comparison.md');
  writeFileSync(localFile, '# comparison report');
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('uploadFile', () => {
  test('sends the file under its base name into the target folder', async () => {
    const drive = new MockDriveClient({});
    const file = await uploadFile(localFile, { folderId: 'folder-1', drive });

    const [params] = drive.calls.create;
    assert.equal(params.requestBody.name, 'comparison.md');
    assert.deepEqual(params.requestBody.parents, ['folder-1']);
    assert.equal(drive.uploadedBytes.toString('utf8'), '# comparison report');
    assert.equal(file.id, 'created-file-id');
  });

  test('trims the folder id before using it', async () => {
    const drive = new MockDriveClient({});
    await uploadFile(localFile, { folderId: '  folder-2  ', drive });

    assert.deepEqual(drive.calls.create[0].requestBody.parents, ['folder-2']);
  });

  test('throws when the local file is missing', async () => {
    const drive = new MockDriveClient({});
    await assert.rejects(
      () => uploadFile(path.join(tmpDir, 'nope.md'), { folderId: 'folder-1', drive }),
      (error) => error.code === 'FILE_NOT_FOUND',
    );
    assert.equal(drive.calls.create.length, 0);
  });

  test('throws when given a directory instead of a file', async () => {
    const drive = new MockDriveClient({});
    await assert.rejects(
      () => uploadFile(tmpDir, { folderId: 'folder-1', drive }),
      (error) => error.code === 'INVALID_INPUT',
    );
  });

  test('throws when nothing was passed to upload', async () => {
    const drive = new MockDriveClient({});
    await assert.rejects(
      () => uploadFile(undefined, { folderId: 'folder-1', drive }),
      (error) => error.code === 'MISSING_INPUT',
    );
  });

  test('falls back to DRIVE_FOLDER_ID when no folder is given', async () => {
    const drive = new MockDriveClient({});
    await withConfiguredFolder('env-folder', () => uploadFile(localFile, { drive }));

    assert.deepEqual(drive.calls.create[0].requestBody.parents, ['env-folder']);
  });

  test('throws when neither the option nor DRIVE_FOLDER_ID is set', async () => {
    const drive = new MockDriveClient({});
    await withConfiguredFolder('', async () => {
      await assert.rejects(
        () => uploadFile(localFile, { drive }),
        (error) => error.code === 'MISSING_DRIVE_FOLDER',
      );
    });
    assert.equal(drive.calls.create.length, 0);
  });

  test('wraps API failures without carrying the googleapis error through', async () => {
    const drive = new MockDriveClient({
      failWith: fakeDriveApiError({ message: 'File not found: folder-1', status: 404 }),
    });

    await assert.rejects(
      () => uploadFile(localFile, { folderId: 'folder-1', drive }),
      (error) => {
        assert.ok(error instanceof AmiError);
        assert.equal(error.code, 'DRIVE_REQUEST_FAILED');
        assert.equal(error.status, 404);
        assert.equal(error.cause, undefined);
        assert.ok(!error.message.includes('PRIVATE KEY MATERIAL'));
        return true;
      },
    );
  });
});
