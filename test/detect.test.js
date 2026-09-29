import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectType, isSupportedName } from '../src/reader/detect.js';

describe('detectType', () => {
  test('detects type by extension', () => {
    assert.equal(detectType('a.png').type, 'image');
    assert.equal(detectType('a.PDF').type, 'pdf');
    assert.equal(detectType('a.docx').type, 'docx');
    assert.equal(detectType('a.pptx').type, 'pptx');
    assert.equal(detectType('a.xlsx').type, 'xlsx');
    assert.equal(detectType('a.csv').type, 'text');
    assert.equal(detectType('bundle.zip').type, 'zip');
  });

  test('flags legacy .doc/.ppt as known but unsupported', () => {
    const doc = detectType('old.doc');
    assert.equal(doc.type, null);
    assert.equal(doc.legacyOffice, true);
  });

  test('uses the mime type when the name has no usable extension', () => {
    assert.equal(detectType('upload', { mimeType: 'application/pdf' }).type, 'pdf');
    assert.equal(detectType('scan', { mimeType: 'image/jpeg' }).type, 'image');
  });

  test('falls back to magic bytes last', () => {
    const png = detectType('upload.bin', { head: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) });
    assert.equal(png.type, 'image');
    assert.equal(png.sniffedAs, 'PNG');
    assert.equal(detectType('x', { head: Buffer.from('PK\x03\x04rest') }).type, 'zip');
  });

  test('returns null for genuinely unsupported files', () => {
    assert.equal(detectType('tool.exe', { head: Buffer.from('MZ') }).type, null);
  });

  test('isSupportedName matches known extensions only', () => {
    assert.equal(isSupportedName('x.jpg'), true);
    assert.equal(isSupportedName('x.txt'), true);
    assert.equal(isSupportedName('x.doc'), true); // known-but-unsupported still counts as "known"
    assert.equal(isSupportedName('x.exe'), false);
  });
});
