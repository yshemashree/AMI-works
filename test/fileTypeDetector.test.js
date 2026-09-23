import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectCategory, isSupportedExtension } from '../src/extractors/fileTypeDetector.js';

describe('fileTypeDetector', () => {
  test('detects category by extension', () => {
    assert.equal(detectCategory('a.png').category, 'image');
    assert.equal(detectCategory('a.PDF').category, 'pdf');
    assert.equal(detectCategory('a.docx').category, 'docx');
    assert.equal(detectCategory('a.pptx').category, 'pptx');
  });

  test('flags legacy .doc/.ppt as unsupported-but-known', () => {
    const doc = detectCategory('old.doc');
    assert.equal(doc.category, null);
    assert.equal(doc.legacyOffice, true);
  });

  test('falls back to magic bytes when extension is unknown', () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
    const result = detectCategory('upload.bin', pngBytes);
    assert.equal(result.category, 'image');
    assert.equal(result.sniffedAs, 'PNG');
  });

  test('returns null category for genuinely unsupported files', () => {
    const result = detectCategory('notes.txt', Buffer.from('hello world'));
    assert.equal(result.category, null);
  });

  test('isSupportedExtension matches known extensions only', () => {
    assert.equal(isSupportedExtension('x.jpg'), true);
    assert.equal(isSupportedExtension('x.pdf'), true);
    assert.equal(isSupportedExtension('x.doc'), true); // known-but-unsupported still counts as "known"
    assert.equal(isSupportedExtension('x.exe'), false);
  });
});
