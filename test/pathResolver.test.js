import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInputs } from '../src/ingestion/pathResolver.js';
import { AmiError } from '../src/utils/errors.js';
import { generateFixtures } from './fixtures/generate-fixtures.mjs';

let fixtures;

before(async () => {
  fixtures = await generateFixtures();
});

describe('resolveInputs', () => {
  test('resolves a single supported file', () => {
    const files = resolveInputs([fixtures.imagePath]);
    assert.deepEqual(files, [fixtures.imagePath]);
  });

  test('expands a zip into its supported member files, skipping unsupported ones', () => {
    const files = resolveInputs([fixtures.zipPath]);
    assert.ok(files.some((f) => f.endsWith('photo.png')));
    assert.ok(files.some((f) => f.endsWith('memo.docx')));
    assert.ok(!files.some((f) => f.endsWith('readme.txt')));
  });

  test('walks a directory recursively, including zips found inside it', () => {
    const files = resolveInputs(['test/fixtures']);
    assert.ok(files.some((f) => f.endsWith('sample-image.png')));
    assert.ok(files.some((f) => f.endsWith('sample.pdf')));
  });

  test('throws when nothing resolvable is found', () => {
    assert.throws(() => resolveInputs(['test/fixtures/nope-does-not-exist.pdf']), AmiError);
  });
});
