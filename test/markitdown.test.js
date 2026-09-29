import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MarkItDownClient } from '../src/markitdown/index.js';
import { readDocument, bufferSource } from '../src/reader/index.js';
import { generateFixtures } from './fixtures/generate-fixtures.mjs';

// These run against the real Python worker when markitdown is installed
// (pip install -r src/markitdown/requirements.txt) and skip otherwise.
const client = new MarkItDownClient({ timeoutMs: 30_000 });
const available = await client.isAvailable();
const skip = available ? false : 'markitdown is not installed for python3';

after(() => client.close());

describe('MarkItDownClient', () => {
  test('a missing interpreter means "not available", and the reader falls back', async () => {
    const broken = new MarkItDownClient({ pythonBin: 'definitely-not-python-xyz' });
    assert.equal(await broken.isAvailable(), false);
    const result = await broken.convert({ name: 'a.csv', bytes: Buffer.from('a,b\n1,2') });
    assert.equal(result.success, false);

    const { document } = await readDocument(bufferSource('a.csv', Buffer.from('a,b\n1,2\n')), { converter: broken });
    assert.equal(document.engine.reader, 'text');
    assert.match(document.markdown, /\| a \| b \|/);
  });

  test('converts bytes sent over stdin - no temp file', { skip }, async () => {
    const result = await client.convert({ name: 'people.csv', bytes: Buffer.from('name,age\nAsha,31\n') });
    assert.equal(result.success, true);
    assert.match(result.markdown, /\| name \| age \|/);
  });

  test('one process serves many files, in order, even when queued together', { skip }, async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => client.convert({ name: `f${i}.csv`, bytes: Buffer.from(`col\nvalue${i}\n`) })),
    );
    results.forEach((r, i) => assert.match(r.markdown, new RegExp(`value${i}`)));
  });

  test('a bad file fails on its own and the worker keeps going', { skip }, async () => {
    const bad = await client.convert({ name: 'broken.docx', bytes: Buffer.from('not a zip') });
    assert.equal(bad.success, false);
    const good = await client.convert({ name: 'ok.csv', bytes: Buffer.from('a\n1\n') });
    assert.equal(good.success, true);
  });

  test('the reader uses it for richer DOCX/XLSX markdown', { skip }, async () => {
    const fixtures = await generateFixtures();
    const { document } = await readDocument(bufferSource('memo.docx', readFileSync(fixtures.docxPath)), { converter: client });
    assert.equal(document.engine.reader, 'markitdown');
    assert.match(document.engine.markdown, /^markitdown /);
    assert.match(document.text, /test DOCX document/);
  });
});
