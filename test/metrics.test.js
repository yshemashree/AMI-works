import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as metrics from '../src/comparison/metrics.js';

describe('metrics.jsonParseSuccessRate', () => {
  test('computes the fraction of parsed responses', () => {
    const analyses = [{ parsed: true }, { parsed: true }, { parsed: false }, { parsed: true }];
    assert.equal(metrics.jsonParseSuccessRate(analyses), 0.75);
  });

  test('returns null for an empty set', () => {
    assert.equal(metrics.jsonParseSuccessRate([]), null);
  });
});

describe('metrics.textAgreement', () => {
  test('returns 1 for identical text', () => {
    assert.equal(metrics.textAgreement('the quick brown fox', 'the quick brown fox'), 1);
  });

  test('returns 0 for completely disjoint text', () => {
    assert.equal(metrics.textAgreement('apple banana cherry', 'dog elephant frog'), 0);
  });

  test('returns a partial score for overlapping text', () => {
    const score = metrics.textAgreement('revenue grew twenty percent', 'revenue increased twenty percent');
    assert.ok(score > 0 && score < 1);
  });

  test('treats two empty strings as fully agreeing', () => {
    assert.equal(metrics.textAgreement('', ''), 1);
  });
});

describe('metrics.keywordRecall', () => {
  test('returns null when no ground truth is supplied', () => {
    assert.equal(metrics.keywordRecall({ result: {} }, []), null);
  });

  test('computes recall and lists found/missing keywords', () => {
    const analysis = { result: { summary: 'Total revenue was $5M in Q3.', extracted_text: 'Acme Corp quarterly report' } };
    const result = metrics.keywordRecall(analysis, ['Acme Corp', '$5M', 'Q3', 'unicorn status']);
    assert.equal(result.recall, 0.75);
    assert.deepEqual(result.found.sort(), ['$5M', 'Acme Corp', 'Q3'].sort());
    assert.deepEqual(result.missing, ['unicorn status']);
  });
});

describe('metrics.failureCases', () => {
  test('flags unparsed, low-confidence, and errored analyses', () => {
    const analyses = [
      { label: 'a', parsed: true, result: { confidence: 'high' } },
      { label: 'b', parsed: false, result: {} },
      { label: 'c', parsed: true, result: { confidence: 'low' } },
      { label: 'd', parsed: true, result: { confidence: 'high' }, error: 'timeout' },
    ];
    const failures = metrics.failureCases(analyses);
    assert.equal(failures.length, 3);
    assert.deepEqual(failures.map((f) => f.label).sort(), ['b', 'c', 'd']);
  });
});

describe('metrics.visualElementStats', () => {
  test('averages visual element and table counts', () => {
    const analyses = [
      { result: { visual_elements: [1, 2], tables: [1] } },
      { result: { visual_elements: [1], tables: [] } },
    ];
    const stats = metrics.visualElementStats(analyses);
    assert.equal(stats.avgVisualElementsFound, 1.5);
    assert.equal(stats.avgTablesFound, 0.5);
  });
});
