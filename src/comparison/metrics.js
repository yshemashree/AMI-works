// Metrics computed from model output alone (no ground truth needed):
// these measure reliability/consistency, not correctness. True "accuracy"
// requires human-curated expected answers - see keywordRecall(), which
// activates only when a test case supplies `groundTruth.expectedKeywords`.
// This split is intentional: it's honest about what can be measured
// automatically versus what needs labeled data (see docs/RESULTS.md).

export function jsonParseSuccessRate(analyses) {
  if (analyses.length === 0) return null;
  const parsed = analyses.filter((a) => a.parsed).length;
  return round(parsed / analyses.length);
}

export function averageLatencyMs(analyses) {
  if (analyses.length === 0) return null;
  const total = analyses.reduce((sum, a) => sum + (a.latencyMs || 0), 0);
  return Math.round(total / analyses.length);
}

export function totalTokenUsage(analyses) {
  return analyses.reduce(
    (acc, a) => ({
      inputTokens: acc.inputTokens + (a.usage?.inputTokens || 0),
      outputTokens: acc.outputTokens + (a.usage?.outputTokens || 0),
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
}

export function visualElementStats(analyses) {
  const counts = analyses.map((a) => a.result?.visual_elements?.length || 0);
  const tableCounts = analyses.map((a) => a.result?.tables?.length || 0);
  return {
    avgVisualElementsFound: average(counts),
    avgTablesFound: average(tableCounts),
  };
}

export function failureCases(analyses) {
  return analyses
    .filter((a) => !a.parsed || a.result?.confidence === 'low' || a.error)
    .map((a) => ({
      label: a.label,
      provider: a.provider,
      reason: a.error ? `request error: ${a.error}` : !a.parsed ? 'response was not valid JSON' : 'model reported low confidence',
      notes: a.result?.notes || null,
    }));
}

/**
 * Word-overlap (Jaccard) similarity between two models' extracted_text
 * for the SAME image. High overlap = the two models largely agree on
 * what the visual contains; low overlap flags a case worth a human look.
 * This is a consistency signal, not an accuracy signal - agreement
 * doesn't prove correctness, and disagreement doesn't prove either model
 * is wrong.
 */
export function textAgreement(textA, textB) {
  const setA = wordSet(textA);
  const setB = wordSet(textB);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = [...setA].filter((w) => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return round(intersection / union);
}

/**
 * Recall of human-supplied expected keywords/facts against a model's
 * extracted_text + summary. This is the one metric here that measures
 * actual accuracy - it requires a test case to define `groundTruth.expectedKeywords`.
 */
export function keywordRecall(analysis, expectedKeywords = []) {
  if (expectedKeywords.length === 0) return null;
  const haystack = `${analysis.result?.summary || ''} ${analysis.result?.extracted_text || ''}`.toLowerCase();
  const found = expectedKeywords.filter((kw) => haystack.includes(String(kw).toLowerCase()));
  return { recall: round(found.length / expectedKeywords.length), found, missing: expectedKeywords.filter((k) => !found.includes(k)) };
}

function wordSet(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function average(nums) {
  return nums.length ? round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0;
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
