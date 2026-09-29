import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInputs } from '../src/pipeline/localInputs.js';
import { AmiError } from '../src/utils/errors.js';
import { generateFixtures } from './fixtures/generate-fixtures.mjs';

let fixtures;

before(async () => {
  fixtures = await generateFixtures();
});

describe('resolveInputs', () => {
  test('resolves a single supported file', () => {
    assert.deepEqual(resolveInputs([fixtures.imagePath]), [fixtures.imagePath]);
  });

  test('passes a zip through whole - the reader opens it in memory', () => {
    assert.deepEqual(resolveInputs([fixtures.zipPath]), [fixtures.zipPath]);
  });

  test('walks a directory recursively', () => {
    const files = resolveInputs(['test/fixtures']);
    assert.ok(files.some((f) => f.endsWith('sample-image.png')));
    assert.ok(files.some((f) => f.endsWith('sample.pdf')));
    assert.ok(files.some((f) => f.endsWith('sample-bundle.zip')));
    assert.ok(!files.some((f) => f.endsWith('.mjs')));
  });

  test('throws when nothing resolvable is found', () => {
    assert.throws(() => resolveInputs(['test/fixtures/nope-does-not-exist.pdf']), AmiError);
  });
});
