import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeImage } from '../src/analysis/analyzeImage.js';
import { analyzeDocument } from '../src/analysis/analyzeDocument.js';
import { extractFile } from '../src/extractors/index.js';
import { MockModelClient, sampleAnalysisJson } from './helpers/mockModelClient.js';
import { generateFixtures } from './fixtures/generate-fixtures.mjs';

let fixtures;

before(async () => {
  fixtures = await generateFixtures();
});

describe('analyzeImage', () => {
  test('sends the image to the client and parses a well-formed response', async () => {
    const client = new MockModelClient({ provider: 'mock', responses: sampleAnalysisJson() });
    const extracted = await extractFile(fixtures.imagePath);

    const analysis = await analyzeImage(client, extracted.images[0], { context: 'standalone image' });

    assert.equal(analysis.parsed, true);
    assert.equal(analysis.result.summary, 'A mock summary.');
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].images.length, 1);
    assert.match(client.calls[0].prompt, /JSON/);
  });

  test('records unparsed responses instead of throwing', async () => {
    const client = new MockModelClient({ provider: 'mock', responses: 'not json at all' });
    const extracted = await extractFile(fixtures.imagePath);

    const analysis = await analyzeImage(client, extracted.images[0]);
    assert.equal(analysis.parsed, false);
    assert.equal(analysis.result.confidence, 'low');
  });
});

describe('analyzeDocument', () => {
  test('analyzes every page of a multi-page PDF and preserves order', async () => {
    const extracted = await extractFile(fixtures.pdfPath);
    const client = new MockModelClient({
      provider: 'mock',
      responses: (index) => sampleAnalysisJson({ summary: `page ${index + 1} summary` }),
    });

    const doc = await analyzeDocument(client, extracted);

    assert.equal(doc.visualAnalyses.length, 2);
    assert.equal(doc.visualAnalyses[0].result.summary, 'page 1 summary');
    assert.equal(doc.visualAnalyses[1].result.summary, 'page 2 summary');
    // PDF pages should use the document prompt with page context, not the bare image prompt.
    assert.match(client.calls[0].prompt, /page 1/);
  });

  test('analyzes embedded images from a DOCX standalone (no page context)', async () => {
    const extracted = await extractFile(fixtures.docxPath);
    const client = new MockModelClient({ provider: 'mock', responses: sampleAnalysisJson() });

    const doc = await analyzeDocument(client, extracted);
    assert.equal(doc.visualAnalyses.length, 1);
    assert.match(client.calls[0].prompt, /embedded in/);
  });

  test('respects the concurrency cap without dropping any results', async () => {
    const extracted = await extractFile(fixtures.pdfPath);
    const client = new MockModelClient({ provider: 'mock', responses: sampleAnalysisJson() });
    const doc = await analyzeDocument(client, extracted, { concurrency: 1 });
    assert.equal(doc.visualAnalyses.length, 2);
    assert.ok(doc.visualAnalyses.every(Boolean));
  });
});
