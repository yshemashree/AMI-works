import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { extractFile, bufferSource } from '../src/reader/index.js';
import { generateFixtures } from './fixtures/generate-fixtures.mjs';

let fixtures;

before(async () => {
  fixtures = await generateFixtures();
});

describe('imageExtractor (via extractFile)', () => {
  test('extracts a standalone image as one base64 image, no text', async () => {
    const result = await extractFile(fixtures.imagePath);
    assert.equal(result.category, 'image');
    assert.equal(result.text, '');
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].mimeType, 'image/png');
    assert.ok(result.images[0].base64.length > 0);
  });
});

describe('pdfExtractor (via extractFile)', () => {
  test('extracts per-page text and renders each page as an image', async () => {
    const result = await extractFile(fixtures.pdfPath);
    assert.equal(result.category, 'pdf');
    assert.equal(result.pageCount, 2);
    assert.equal(result.images.length, 2);
    assert.match(result.text, /Page One Content/);
    assert.match(result.text, /Page Two Content/);
    assert.equal(result.images[0].pageNumber, 1);
    assert.equal(result.images[1].pageNumber, 2);
    for (const image of result.images) {
      assert.equal(image.mimeType, 'image/png');
      assert.ok(image.base64.length > 1000, 'rendered page should be a non-trivial PNG');
    }
  });
});

describe('docxExtractor (via extractFile)', () => {
  test('extracts document text and embedded images', async () => {
    const result = await extractFile(fixtures.docxPath);
    assert.equal(result.category, 'docx');
    assert.match(result.text, /test DOCX document/);
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].mimeType, 'image/png');
  });
});

describe('pptxExtractor (via extractFile)', () => {
  test('extracts per-slide text in order and embedded images', async () => {
    const result = await extractFile(fixtures.pptxPath);
    assert.equal(result.category, 'pptx');
    assert.equal(result.slideCount, 2);
    assert.match(result.text, /\[Slide 1\].*quarterly results/s);
    assert.match(result.text, /\[Slide 2\].*architecture diagram/s);
    assert.equal(result.images.length, 1);
  });
});

describe('extractFile error handling', () => {
  test('rejects unsupported file types with a clear error', async () => {
    await assert.rejects(() => extractFile(bufferSource('does-not-matter.xyz', Buffer.from('?'))), /Unsupported file type/i);
  });

  test('rejects a missing file with FILE_NOT_FOUND', async () => {
    await assert.rejects(() => extractFile('test/fixtures/nope.pdf'), (e) => e.code === 'FILE_NOT_FOUND');
  });
});
