import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Writes a comparison result (from runComparison) to disk as JSON (full
 * data, for programmatic reuse) and Markdown (human-readable summary with
 * an auto-derived recommendation).
 */
export function writeReport(comparison, outDir) {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'comparison-report.json');
  const mdPath = path.join(outDir, 'comparison-report.md');

  writeFileSync(jsonPath, JSON.stringify(comparison, null, 2));
  writeFileSync(mdPath, renderMarkdown(comparison));

  return { jsonPath, mdPath };
}

export function renderMarkdown(comparison) {
  const { aggregate, files, generatedAt } = comparison;
  const c = aggregate.providers.claude;
  const q = aggregate.providers.qwen;

  const lines = [];
  lines.push('# Qwen vs Claude - Image Understanding Comparison Report');
  lines.push('');
  lines.push(`Generated: ${generatedAt}`);
  lines.push(`Files compared: ${aggregate.filesCompared} | Visual units compared: ${aggregate.visualsCompared}`);
  lines.push('');
  lines.push('## Aggregate Metrics');
  lines.push('');
  lines.push('| Metric | Claude | Qwen |');
  lines.push('|---|---|---|');
  lines.push(`| JSON parse success rate (reliability) | ${fmt(c.jsonParseSuccessRate)} | ${fmt(q.jsonParseSuccessRate)} |`);
  lines.push(`| Low-confidence responses | ${c.lowConfidenceCount} | ${q.lowConfidenceCount} |`);
  lines.push(`| Avg visual elements found / image | ${fmt(c.averageVisualElementsFound)} | ${fmt(q.averageVisualElementsFound)} |`);
  lines.push(`| Avg tables found / image | ${fmt(c.averageTablesFound)} | ${fmt(q.averageTablesFound)} |`);
  lines.push(`| Avg keyword recall (accuracy, needs ground truth) | ${fmt(c.averageKeywordRecall)} | ${fmt(q.averageKeywordRecall)} |`);
  lines.push(`| Avg latency (ms) | ${fmt(c.averageLatencyMs)} | ${fmt(q.averageLatencyMs)} |`);
  lines.push('');
  lines.push(`Average text-agreement between the two models on the same image: **${fmt(aggregate.averageTextAgreement)}** (word-overlap of extracted text; a consistency signal, not a correctness signal).`);
  lines.push('');
  lines.push('## Recommendation');
  lines.push('');
  lines.push(deriveRecommendation(c, q, aggregate));
  lines.push('');
  lines.push('## Per-File Results');
  for (const file of files) {
    lines.push('');
    lines.push(`### ${path.basename(file.filePath)} (${file.category}, ${file.visualCount} visual unit(s))`);
    lines.push('');
    lines.push('| Provider | Parse success | Avg latency (ms) | Visual elements found | Tables found | Failures |');
    lines.push('|---|---|---|---|---|---|');
    for (const provider of ['claude', 'qwen']) {
      const s = file.providerSummary[provider];
      lines.push(`| ${provider} | ${fmt(s.jsonParseSuccessRate)} | ${fmt(s.averageLatencyMs)} | ${fmt(s.avgVisualElementsFound)} | ${fmt(s.avgTablesFound)} | ${s.failures.length} |`);
    }
  }

  return lines.join('\n') + '\n';
}

function deriveRecommendation(claude, qwen, aggregate) {
  const notes = [];

  if (claude.averageKeywordRecall != null || qwen.averageKeywordRecall != null) {
    const winner = (claude.averageKeywordRecall ?? 0) >= (qwen.averageKeywordRecall ?? 0) ? 'Claude' : 'Qwen';
    notes.push(
      `**Accuracy (ground-truth keyword recall):** ${winner} recalled more expected facts in this run ` +
        `(Claude ${fmt(claude.averageKeywordRecall)}, Qwen ${fmt(qwen.averageKeywordRecall)}).`,
    );
  } else {
    notes.push(
      '**Accuracy:** No ground-truth keywords were supplied for this run, so no accuracy claim can be made from it. ' +
        'Pass `--ground-truth <file.json>` to `npm run compare` with expected keywords/facts per file to get a scored accuracy comparison.',
    );
  }

  const reliabilityWinner = claude.jsonParseSuccessRate === qwen.jsonParseSuccessRate
    ? 'tied'
    : claude.jsonParseSuccessRate > qwen.jsonParseSuccessRate ? 'Claude' : 'Qwen';
  notes.push(
    `**Reliability (structured-output compliance):** ${reliabilityWinner === 'tied' ? 'Both models were tied' : `${reliabilityWinner} was more reliable`} ` +
      `at returning parseable, well-formed JSON in this run (Claude ${fmt(claude.jsonParseSuccessRate)}, Qwen ${fmt(qwen.jsonParseSuccessRate)}).`,
  );

  notes.push(
    `**Visual understanding depth:** Claude reported an average of ${fmt(claude.averageVisualElementsFound)} visual elements and ${fmt(claude.averageTablesFound)} tables per image; ` +
      `Qwen reported ${fmt(qwen.averageVisualElementsFound)} and ${fmt(qwen.averageTablesFound)}. Higher counts are not automatically "better" without a human checking for over- or under-detection - cross-check against the per-file failure notes below.`,
  );

  notes.push(
    `**Consistency between models:** average text agreement across all compared visuals was ${fmt(aggregate.averageTextAgreement)}. ` +
      'Low-agreement cases are worth a manual review since it means the models disagree on what a specific image/chart/table contains.',
  );

  notes.push(
    'This recommendation is generated directly from the metrics of the run above - it is not a canned verdict. ' +
      'Re-run `npm run compare` against a larger, representative sample of your real files (with ground truth where possible) before treating the result as final.',
  );

  return notes.join('\n\n');
}

function fmt(value) {
  if (value === null || value === undefined) return 'n/a';
  return String(value);
}
