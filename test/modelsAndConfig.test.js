import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createModelClient } from '../src/models/index.js';
import { MissingCredentialsError, AmiError } from '../src/utils/errors.js';

// These intentionally run WITHOUT real API keys set - they verify the
// credential-guard fails fast and clearly rather than making a doomed
// network call. Live end-to-end calls are covered separately by
// `npm run compare` once .env has real keys (see docs/TESTING.md).
describe('createModelClient credential guards', () => {
  test('throws MissingCredentialsError for Claude when ANTHROPIC_API_KEY is unset', () => {
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      assert.throws(() => createModelClient('claude'), MissingCredentialsError);
    } finally {
      if (original) process.env.ANTHROPIC_API_KEY = original;
    }
  });

  test('throws MissingCredentialsError for Qwen when DASHSCOPE_API_KEY is unset', () => {
    const original = process.env.DASHSCOPE_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    try {
      assert.throws(() => createModelClient('qwen'), MissingCredentialsError);
    } finally {
      if (original) process.env.DASHSCOPE_API_KEY = original;
    }
  });

  test('throws a clear error for an unknown provider', () => {
    assert.throws(() => createModelClient('gpt5'), AmiError);
  });
});
