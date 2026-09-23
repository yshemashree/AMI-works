import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { renderMarkdown, writeReport } from '../src/comparison/reportGenerator.js';

function makeComparison({ withKeywordRecall = false } = {}) {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    files: [
      {
        filePath: '/tmp/report.pdf',
        category: 'pdf',
        visualCount: 1,
        perVisual: [],
        providerSummary: {
          claude: { jsonParseSuccessRate: 1, averageLatencyMs: 900, avgVisualElementsFound: 2, avgTablesFound: 1, failures: [] },
          qwen: { jsonParseSuccessRate: 0.8, averageLatencyMs: 500, avgVisualElementsFound: 1, avgTablesFound: 0, failures: [{ label: 'p1' }] },
        },
      },
    ],
    aggregate: {
      filesCompared: 1,
      visualsCompared: 1,
      averageTextAgreement: 0.62,
      providers: {
        claude: {
          jsonParseSuccessRate: 1,
          averageLatencyMs: 900,
          averageVisualElementsFound: 2,
          averageTablesFound: 1,
          averageKeywordRecall: withKeywordRecall ? 0.9 : null,
          lowConfidenceCount: 0,
        },
        qwen: {
          jsonParseSuccessRate: 0.8,
          averageLatencyMs: 500,
          averageVisualElementsFound: 1,
          averageTablesFound: 0,
          averageKeywordRecall: withKeywordRecall ? 0.7 : null,
          lowConfidenceCount: 1,
        },
      },
    },
  };
}

describe('reportGenerator.renderMarkdown', () => {
  test('flags missing ground truth instead of claiming an accuracy winner', () => {
    const md = renderMarkdown(makeComparison({ withKeywordRecall: false }));
    assert.match(md, /No ground-truth keywords were supplied/);
    assert.match(md, /Claude was more reliable|Qwen was more reliable/);
  });

  test('reports an accuracy winner once keyword recall data is present', () => {
    const md = renderMarkdown(makeComparison({ withKeywordRecall: true }));
    assert.match(md, /Accuracy \(ground-truth keyword recall\):\*\* Claude recalled more/);
  });

  test('includes per-file breakdown', () => {
    const md = renderMarkdown(makeComparison());
    assert.match(md, /report\.pdf/);
    assert.match(md, /Failures/);
  });
});

describe('reportGenerator.writeReport', () => {
  let tmpDir;
  after(() => rmSync(tmpDir, { recursive: true, force: true }));

  test('writes both a JSON and Markdown report to disk', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ami-report-test-'));
    const { jsonPath, mdPath } = writeReport(makeComparison(), tmpDir);

    assert.ok(existsSync(jsonPath));
    assert.ok(existsSync(mdPath));
    const parsed = JSON.parse(readFileSync(jsonPath, 'utf8'));
    assert.equal(parsed.aggregate.filesCompared, 1);
  });
});
