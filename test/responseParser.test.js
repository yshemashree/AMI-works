import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelJson } from '../src/analysis/responseParser.js';

describe('parseModelJson', () => {
  test('parses a clean JSON response', () => {
    const { ok, data } = parseModelJson('{"summary": "hello", "confidence": "high"}');
    assert.equal(ok, true);
    assert.equal(data.summary, 'hello');
  });

  test('parses JSON wrapped in a markdown code fence', () => {
    const raw = 'Sure, here you go:\n```json\n{"summary": "fenced"}\n```';
    const { ok, data } = parseModelJson(raw);
    assert.equal(ok, true);
    assert.equal(data.summary, 'fenced');
  });

  test('parses JSON with leading/trailing prose by locating braces', () => {
    const raw = 'Here is the analysis: {"summary": "in prose"} Hope that helps!';
    const { ok, data } = parseModelJson(raw);
    assert.equal(ok, true);
    assert.equal(data.summary, 'in prose');
  });

  test('falls back to a safe empty shape on unparseable text', () => {
    const { ok, data } = parseModelJson('I cannot help with that.');
    assert.equal(ok, false);
    assert.equal(data.confidence, 'low');
    assert.equal(data._unparsed, 'I cannot help with that.');
  });
});
