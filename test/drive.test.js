import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { listFolder, driveSource, collect, toEntry, isReadable, assertFolderId } from '../src/drive/index.js';
import { AmiError } from '../src/utils/errors.js';
import { MockDriveClient, driveFile, fakeDriveApiError } from './helpers/mockDriveClient.js';

describe('listFolder', () => {
  test('follows pagination and tags each entry with how it can be read', async () => {
    const drive = new MockDriveClient({
      pages: [
        [
          driveFile('a', 'report.pdf', 'pdf bytes', 'application/pdf'),
          { id: 'b', name: 'Plan', mimeType: 'application/vnd.google-apps.document' },
        ],
        [
          { id: 'c', name: 'Sub', mimeType: 'application/vnd.google-apps.folder' },
          { id: 'd', name: 'tool.exe', mimeType: 'application/octet-stream' },
          { id: 'e', name: 'Form', mimeType: 'application/vnd.google-apps.form' },
        ],
      ],
    });

    const entries = await listFolder(drive, 'folder-1');
    assert.equal(drive.calls.list.length, 2);
    assert.deepEqual(entries.map((e) => [e.name, e.kind]), [
      ['report.pdf', 'file'],
      ['Plan.docx', 'export'],
      ['Sub', 'folder'],
      ['tool.exe', 'unsupported'],
      ['Form', 'unsupported'],
    ]);
    assert.deepEqual(entries.filter(isReadable).map((e) => e.id), ['a', 'b']);
    assert.equal(entries[0].size, 9);
    assert.match(entries[0].md5, /^[0-9a-f]{32}$/);
  });

  test('asks only for this folder, skipping trashed files, with the fields we use', async () => {
    const drive = new MockDriveClient({ pages: [[]] });
    await listFolder(drive, 'folder-1');
    const [params] = drive.calls.list;
    assert.match(params.q, /'folder-1' in parents/);
    assert.match(params.q, /trashed = false/);
    assert.match(params.fields, /md5Checksum/);
    assert.equal(params.supportsAllDrives, true);
  });

  test('refuses folder ids that could change the query', async () => {
    const drive = new MockDriveClient({ pages: [[]] });
    await assert.rejects(() => listFolder(drive, "x' or name contains '"), (e) => e.code === 'INVALID_DRIVE_FOLDER');
    await assert.rejects(() => listFolder(drive, '  '), (e) => e.code === 'MISSING_DRIVE_FOLDER');
    assert.equal(drive.calls.list.length, 0);
    assert.equal(assertFolderId('  1AbC_d-9  '), '1AbC_d-9');
  });

  test('wraps API failures without carrying the googleapis error through', async () => {
    const drive = new MockDriveClient({ failWith: fakeDriveApiError() });
    await assert.rejects(
      () => listFolder(drive, 'folder-1'),
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

describe('driveSource', () => {
  const bytes = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 256));
  const entry = () => toEntry(driveFile('f1', 'data.pdf', bytes, 'application/pdf'));

  test('readAll returns the exact bytes, streamed into memory', async () => {
    const drive = new MockDriveClient({ contents: { f1: bytes }, chunkSize: 7000 });
    const data = await driveSource(drive, entry()).readAll();
    assert.deepEqual(data, bytes);
    assert.equal(drive.calls.get[0].alt, 'media');
  });

  test('readRange sends a Range header and returns just that slice', async () => {
    const drive = new MockDriveClient({ contents: { f1: bytes } });
    const slice = await driveSource(drive, entry()).readRange(1000, 1500);
    assert.deepEqual(slice, bytes.subarray(1000, 1500));
    assert.equal(drive.calls.get[0].headers.Range, 'bytes=1000-1499');
  });

  test('refuses up front when a file is over the in-memory limit', async () => {
    const drive = new MockDriveClient({ contents: { f1: bytes } });
    await assert.rejects(() => driveSource(drive, entry()).readAll({ maxBytes: 1000 }), (e) => e.code === 'FILE_TOO_LARGE');
    assert.equal(drive.calls.get.length, 0, 'no download started');
  });

  test('Google-native files are exported to Office format, without ranges', async () => {
    const drive = new MockDriveClient({ contents: { g1: 'docx bytes' } });
    const source = driveSource(drive, toEntry({ id: 'g1', name: 'Plan', mimeType: 'application/vnd.google-apps.document' }));
    assert.equal(source.name, 'Plan.docx');
    assert.equal(source.readRange, undefined);
    assert.equal((await source.readAll()).toString(), 'docx bytes');
    assert.match(drive.calls.export[0].mimeType, /wordprocessingml/);
  });
});

describe('collect', () => {
  test('handles a stream longer than announced', async () => {
    const out = await collect(Readable.from([Buffer.from('abc'), Buffer.from('defg')]), { expected: 4 });
    assert.equal(out.toString(), 'abcdefg');
  });

  test('stops as soon as the byte limit is crossed', async () => {
    let pulled = 0;
    async function* endless() {
      for (;;) {
        pulled++;
        yield Buffer.alloc(1000);
      }
    }
    await assert.rejects(() => collect(Readable.from(endless()), { maxBytes: 5000 }), (e) => e.code === 'FILE_TOO_LARGE');
    assert.ok(pulled <= 7);
  });
});
