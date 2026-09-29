import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { createPipeline, ResultCache, MemoryBudget, mapLimit } from '../src/pipeline/index.js';
import { MockDriveClient, driveFile } from './helpers/mockDriveClient.js';
import { generateFixtures } from './fixtures/generate-fixtures.mjs';

let fixtures;
let pdf;
let docx;

before(async () => {
  fixtures = await generateFixtures();
  pdf = readFileSync(fixtures.pdfPath);
  docx = readFileSync(fixtures.docxPath);
});

function folderDrive() {
  return new MockDriveClient({
    pages: [
      [
        driveFile('p', 'report.pdf', pdf, 'application/pdf'),
        driveFile('d', 'memo.docx', docx),
        driveFile('x', 'broken.pdf', 'not a pdf', 'application/pdf'),
        { id: 's', name: 'Sub', mimeType: 'application/vnd.google-apps.folder' },
      ],
    ],
    contents: { p: pdf, d: docx, x: 'not a pdf' },
  });
}

function pipelineWith(drive, extra = {}) {
  return createPipeline({ getReadClient: async () => drive, getWriteClient: async () => drive, cache: new ResultCache(), ...extra });
}

describe('readDriveFolder', () => {
  test('reads each file in memory; one bad file does not stop the rest', async () => {
    const drive = folderDrive();
    const progress = [];
    const result = await pipelineWith(drive).readDriveFolder('folder-1', { onProgress: (p) => progress.push(p.done) });

    const byName = Object.fromEntries(result.files.map((f) => [f.entry.name, f]));
    assert.match(byName['report.pdf'].document.text, /Page One Content/);
    assert.equal(byName['report.pdf'].document.source.driveFileId, 'p');
    assert.match(byName['memo.docx'].document.text, /test DOCX document/);
    assert.equal(byName['broken.pdf'].error.code, 'EXTRACTION_FAILED');
    assert.deepEqual(result.skipped, [{ name: 'Sub', kind: 'folder' }]);
    assert.deepEqual(progress.sort(), [1, 2, 3]);
  });

  test('a second run over unchanged files downloads nothing', async () => {
    const drive = folderDrive();
    const pipeline = pipelineWith(drive);
    await pipeline.readDriveFolder('folder-1');
    const downloadsAfterFirst = drive.calls.get.length;

    const second = await pipeline.readDriveFolder('folder-1');
    assert.equal(drive.calls.get.length, downloadsAfterFirst + 1, 'only the file that failed is retried');
    assert.equal(second.files.filter((f) => f.cached).length, 2);
  });

  test('the cache is keyed by content: a renamed copy is a hit', async () => {
    const drive = folderDrive();
    const pipeline = pipelineWith(drive);
    await pipeline.readDriveFolder('folder-1');
    const before = drive.calls.get.length;

    const copy = { ...driveFile('p2', 'report (copy).pdf', pdf, 'application/pdf') };
    const { cached } = await pipeline.readDriveEntry({ ...copy, kind: 'file', md5: copy.md5Checksum, size: pdf.length, name: copy.name }, drive);
    assert.equal(cached, true);
    assert.equal(drive.calls.get.length, before);
  });

  test('listDrive marks files already read', async () => {
    const drive = folderDrive();
    const pipeline = pipelineWith(drive);
    await pipeline.readDriveFile('p');
    const listed = await pipeline.listDrive('folder-1');
    assert.equal(listed.find((e) => e.id === 'p').cached, true);
    assert.equal(listed.find((e) => e.id === 'd').cached, false);
  });
});

describe('uploadAndRead', () => {
  test('one pass: bytes reach Drive intact, checksum verified, JSON ready with no download', async () => {
    const drive = new MockDriveClient({});
    const pipeline = pipelineWith(drive);
    const body = Readable.from([docx.subarray(0, 500), docx.subarray(500)]);

    const result = await pipeline.uploadAndRead({ body, name: 'memo.docx', folderId: 'folder-1' });
    assert.deepEqual(drive.uploadedBytes, docx);
    assert.equal(result.checksumMatches, true);
    assert.match(result.document.text, /test DOCX document/);
    assert.equal(result.document.source.driveFileId, 'created-file-id');
    assert.equal(drive.calls.get.length, 0, 'nothing read back from Drive');
  });

  test('files over the inline limit are not buffered; they are read back by range', async () => {
    const drive = new MockDriveClient({});
    const pipeline = pipelineWith(drive);
    // Drive "stores" what we upload, so the read-back sees the same bytes.
    drive.contents['created-file-id'] = pdf;
    drive.pages = [[driveFile('created-file-id', 'report.pdf', pdf, 'application/pdf')]];

    const result = await pipeline.uploadAndRead({ body: Readable.from([pdf]), name: 'report.pdf', folderId: 'folder-1', inlineLimit: 100 });
    assert.equal(result.checksumMatches, true);
    assert.match(result.document.text, /Page One Content/);
    assert.ok(drive.calls.get.length > 0);
  });

  test('an upload failure surfaces as an error', async () => {
    const drive = new MockDriveClient({ failWith: Object.assign(new Error('quota'), { status: 403 }) });
    await assert.rejects(
      () => pipelineWith(drive).uploadAndRead({ body: Readable.from([docx]), name: 'memo.docx', folderId: 'folder-1' }),
      (e) => e.code === 'DRIVE_REQUEST_FAILED',
    );
  });
});

describe('readUpload', () => {
  test('reads without Drive and hits the cache on the same bytes', async () => {
    const pipeline = pipelineWith(null);
    const first = await pipeline.readUpload({ body: Readable.from([pdf]), name: 'a.pdf' });
    const second = await pipeline.readUpload({ body: Readable.from([pdf]), name: 'renamed.pdf' });
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(second.document.source.name, 'renamed.pdf');
    assert.equal(first.document.source.md5, createHash('md5').update(pdf).digest('hex'));
  });
});

describe('ResultCache', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ami-cache-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('persists JSON to disk and returns copies, not shared objects', async () => {
    const key = ResultCache.keyFor({ md5: 'abc' }, 'plain');
    await new ResultCache({ dir }).set(key, { text: 'hello' });
    assert.equal(readdirSync(dir).length, 1);

    const fresh = new ResultCache({ dir });
    const got = await fresh.get(key);
    assert.deepEqual(got, { text: 'hello' });
    got.text = 'mutated';
    assert.deepEqual(await fresh.get(key), { text: 'hello' });
  });

  test('no key without a content hash or a Drive id + modified time', () => {
    assert.equal(ResultCache.keyFor({}), null);
    assert.match(ResultCache.keyFor({ id: 'x', modifiedTime: 't' }), /drive:x@t/);
  });

  test('evicts the least recently used entry', async () => {
    const cache = new ResultCache({ maxEntries: 2 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.get('a');
    await cache.set('c', 3);
    assert.deepEqual([...cache.memory.keys()], ['a', 'c']);
  });
});

describe('MemoryBudget', () => {
  test('never lets reservations exceed the limit, and serves in order', async () => {
    const budget = new MemoryBudget(100);
    let peak = 0;
    const order = [];
    await mapLimit([60, 60, 30, 10, 250], 5, async (size, i) => {
      const release = await budget.acquire(size);
      peak = Math.max(peak, budget.used);
      order.push(i);
      await new Promise((r) => setTimeout(r, 5));
      release();
    });
    assert.ok(peak <= 100, `peak ${peak}`);
    assert.deepEqual(order, [0, 1, 2, 3, 4]);
    assert.equal(budget.used, 0);
  });
});
