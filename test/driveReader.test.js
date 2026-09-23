import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fetchDriveFolder } from '../src/ingestion/driveReader.js';
import { AmiError } from '../src/utils/errors.js';
import { MockDriveClient, fakeDriveApiError } from './helpers/mockDriveClient.js';

const dirsToClean = [];

after(() => {
  for (const dir of dirsToClean) rmSync(dir, { recursive: true, force: true });
});

function driveWith(pages, contents) {
  return new MockDriveClient({ pages, contents });
}

describe('fetchDriveFolder', () => {
  test('downloads supported files and returns their local paths', async () => {
    const drive = driveWith(
      [
        [
          { id: 'a', name: 'report.pdf', mimeType: 'application/pdf' },
          { id: 'b', name: 'photo.png', mimeType: 'image/png' },
        ],
      ],
      { a: 'pdf bytes', b: 'png bytes' },
    );

    const { downloadDir, files } = await fetchDriveFolder({ folderId: 'folder-1', drive });
    dirsToClean.push(downloadDir);

    assert.equal(files.length, 2);
    assert.ok(files.some((f) => f.endsWith('report.pdf')));
    assert.ok(files.some((f) => f.endsWith('photo.png')));
    assert.equal(readFileSync(files[0], 'utf8'), 'pdf bytes');
  });

  test('skips unsupported files, Google-native docs and subfolders', async () => {
    const drive = driveWith([
      [
        { id: 'a', name: 'photo.png', mimeType: 'image/png' },
        { id: 'b', name: 'notes.txt', mimeType: 'text/plain' },
        { id: 'c', name: 'Plan', mimeType: 'application/vnd.google-apps.document' },
        { id: 'd', name: 'Subfolder', mimeType: 'application/vnd.google-apps.folder' },
      ],
    ]);

    const { downloadDir, files } = await fetchDriveFolder({ folderId: 'folder-1', drive });
    dirsToClean.push(downloadDir);

    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('photo.png'));
    assert.equal(drive.calls.get.length, 1);
  });

  test('follows pagination until there is no next page token', async () => {
    const drive = driveWith([
      [{ id: 'a', name: 'one.png', mimeType: 'image/png' }],
      [{ id: 'b', name: 'two.png', mimeType: 'image/png' }],
    ]);

    const { downloadDir, files } = await fetchDriveFolder({ folderId: 'folder-1', drive });
    dirsToClean.push(downloadDir);

    assert.equal(drive.calls.list.length, 2);
    assert.equal(files.length, 2);
  });

  test('does not overwrite when two files share a name', async () => {
    const drive = driveWith(
      [
        [
          { id: 'a', name: 'dup.png', mimeType: 'image/png' },
          { id: 'b', name: 'dup.png', mimeType: 'image/png' },
        ],
      ],
      { a: 'first', b: 'second' },
    );

    const { downloadDir, files } = await fetchDriveFolder({ folderId: 'folder-1', drive });
    dirsToClean.push(downloadDir);

    assert.equal(new Set(files).size, 2);
    assert.equal(readFileSync(files[0], 'utf8'), 'first');
    assert.equal(readFileSync(files[1], 'utf8'), 'second');
  });

  test('strips directory parts out of a Drive file name', async () => {
    const drive = driveWith([[{ id: 'a', name: '../../escape.png', mimeType: 'image/png' }]]);

    const { downloadDir, files } = await fetchDriveFolder({ folderId: 'folder-1', drive });
    dirsToClean.push(downloadDir);

    assert.equal(path.dirname(files[0]), downloadDir);
    assert.ok(files[0].endsWith('escape.png'));
  });

  test('asks Drive only for the given folder, skipping trashed files', async () => {
    const drive = driveWith([[{ id: 'a', name: 'one.png', mimeType: 'image/png' }]]);

    const { downloadDir } = await fetchDriveFolder({ folderId: 'folder-1', drive });
    dirsToClean.push(downloadDir);

    assert.match(drive.calls.list[0].q, /'folder-1' in parents/);
    assert.match(drive.calls.list[0].q, /trashed = false/);
  });

  test('throws when the folder has nothing supported in it', async () => {
    const drive = driveWith([[{ id: 'a', name: 'notes.txt', mimeType: 'text/plain' }]]);
    await assert.rejects(() => fetchDriveFolder({ folderId: 'folder-1', drive }), AmiError);
  });

  test('throws when no folder id is given', async () => {
    const drive = driveWith([[]]);
    await assert.rejects(
      () => fetchDriveFolder({ folderId: '  ', drive }),
      (error) => error.code === 'MISSING_DRIVE_FOLDER',
    );
    assert.equal(drive.calls.list.length, 0);
  });

  test('wraps API failures without carrying the googleapis error through', async () => {
    const drive = new MockDriveClient({ failWith: fakeDriveApiError() });

    await assert.rejects(
      () => fetchDriveFolder({ folderId: 'folder-1', drive }),
      (error) => {
        assert.ok(error instanceof AmiError);
        assert.equal(error.code, 'DRIVE_REQUEST_FAILED');
        assert.equal(error.status, 429);
        assert.equal(error.cause, undefined);
        assert.ok(!error.message.includes('PRIVATE KEY MATERIAL'));
        return true;
      },
    );
  });
});
