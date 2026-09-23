import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import { extractZip, cleanupExtractedDir } from '../src/ingestion/zipExtractor.js';
import { generateFixtures } from './fixtures/generate-fixtures.mjs';

let fixtures;
let tmpDir;

before(async () => {
  fixtures = await generateFixtures();
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ami-zip-test-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('zipExtractor', () => {
  test('extracts all files including nested directories', () => {
    const { extractDir, files } = extractZip(fixtures.zipPath);
    assert.ok(files.length >= 5); // photo, report, memo (nested), deck (nested), readme
    assert.ok(files.some((f) => f.endsWith('photo.png')));
    assert.ok(files.some((f) => f.endsWith(path.join('nested', 'memo.docx'))));
    cleanupExtractedDir(extractDir);
  });

  test('rejects zip-slip path traversal entries', () => {
    const maliciousZipPath = path.join(tmpDir, 'evil.zip');
    const zip = new AdmZip();
    zip.addFile('../../../etc/evil.txt', Buffer.from('pwned'));
    zip.addFile('safe.txt', Buffer.from('fine'));
    zip.writeZip(maliciousZipPath);

    const { extractDir, files } = extractZip(maliciousZipPath);
    assert.ok(files.every((f) => f.startsWith(extractDir)));
    assert.ok(!existsSync(path.join(tmpDir, '..', '..', '..', 'etc', 'evil.txt')));
    cleanupExtractedDir(extractDir);
  });

  test('rejects an empty zip', () => {
    const emptyZipPath = path.join(tmpDir, 'empty.zip');
    new AdmZip().writeZip(emptyZipPath);
    assert.throws(() => extractZip(emptyZipPath), /empty/i);
  });

  test('rejects a non-existent file', () => {
    assert.throws(() => extractZip(path.join(tmpDir, 'nope.zip')), /not found/i);
  });

  test('rejects a corrupt/non-zip file', () => {
    const badPath = path.join(tmpDir, 'not-a-zip.zip');
    writeFileSync(badPath, 'this is not a zip file');
    assert.throws(() => extractZip(badPath), /could not open/i);
  });
});
