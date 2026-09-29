import path from 'node:path';
import { fileSource } from '../reader/index.js';
import { resolveInputs } from '../pipeline/localInputs.js';
import { forEachExtracted } from '../pipeline/analyze.js';
import { analyzeDocument } from '../analysis/analyzeDocument.js';
import { createModelClient } from '../models/index.js';
import * as metrics from './metrics.js';
import { logger } from '../utils/logger.js';

const PROVIDERS = ['claude', 'qwen'];

/**
 * Runs the same set of files through both Claude and Qwen using identical
 * prompts and extracted inputs, then computes comparison metrics.
 *
 * @param {string[]} inputPaths - files and/or a single zip to expand
 * @param {Object} [options]
 * @param {Object} [options.groundTruth] - { "<fileName>": { expectedKeywords: string[] } }
 */
export async function runComparison(inputPaths, { groundTruth = {}, visionPages = 'auto', clients: injected } = {}) {
  const files = resolveInputs(inputPaths);
  const clients = injected || Object.fromEntries(PROVIDERS.map((p) => [p, createModelClient(p)]));

  const perFile = [];
  for (const inputPath of files) {
    // Both providers get the exact same extracted visuals, so skipping
    // text-only pages keeps the comparison fair while halving the bill.
    await forEachExtracted(await fileSource(inputPath), { visionPages }, async (extracted) => {
      const { filePath } = extracted;
      logger.info(`Comparing: ${filePath}`);
      const [claudeDoc, qwenDoc] = await Promise.all([
        analyzeDocument(clients.claude, extracted),
        analyzeDocument(clients.qwen, extracted),
      ]);

      const fileGroundTruth = groundTruth[path.basename(filePath)];
      perFile.push(buildFileComparison(filePath, extracted, { claude: claudeDoc, qwen: qwenDoc }, fileGroundTruth));
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    files: perFile,
    aggregate: buildAggregate(perFile),
  };
}

function buildFileComparison(filePath, extracted, docsByProvider, fileGroundTruth) {
  const perVisual = extracted.images.map((image, index) => {
    const claudeAnalysis = docsByProvider.claude.visualAnalyses[index];
    const qwenAnalysis = docsByProvider.qwen.visualAnalyses[index];
    const agreement = metrics.textAgreement(
      claudeAnalysis?.result?.extracted_text,
      qwenAnalysis?.result?.extracted_text,
    );

    const keywords = fileGroundTruth?.expectedKeywords;
    return {
      label: image.label,
      textAgreement: agreement,
      claude: { ...summarizeAnalysis(claudeAnalysis), keywordRecall: keywords ? metrics.keywordRecall(claudeAnalysis, keywords) : null },
      qwen: { ...summarizeAnalysis(qwenAnalysis), keywordRecall: keywords ? metrics.keywordRecall(qwenAnalysis, keywords) : null },
    };
  });

  return {
    filePath,
    category: extracted.category,
    visualCount: extracted.images.length,
    perVisual,
    providerSummary: {
      claude: summarizeProviderForFile(docsByProvider.claude.visualAnalyses),
      qwen: summarizeProviderForFile(docsByProvider.qwen.visualAnalyses),
    },
  };
}

function summarizeAnalysis(analysis) {
  if (!analysis) return null;
  return {
    parsed: analysis.parsed,
    confidence: analysis.result?.confidence,
    latencyMs: analysis.latencyMs,
    visualElementsFound: analysis.result?.visual_elements?.length || 0,
    tablesFound: analysis.result?.tables?.length || 0,
    summary: analysis.result?.summary,
  };
}

function summarizeProviderForFile(analyses) {
  return {
    jsonParseSuccessRate: metrics.jsonParseSuccessRate(analyses),
    averageLatencyMs: metrics.averageLatencyMs(analyses),
    ...metrics.visualElementStats(analyses),
    tokenUsage: metrics.totalTokenUsage(analyses),
    failures: metrics.failureCases(analyses),
  };
}

function buildAggregate(perFile) {
  const allAnalyses = { claude: [], qwen: [] };
  const agreements = [];
  const keywordRecalls = { claude: [], qwen: [] };

  for (const file of perFile) {
    for (const visual of file.perVisual) {
      agreements.push(visual.textAgreement);
      for (const provider of PROVIDERS) {
        if (visual[provider]) allAnalyses[provider].push(visual[provider]);
        const kr = visual[provider]?.keywordRecall;
        if (kr) keywordRecalls[provider].push(kr.recall);
      }
    }
  }

  const providerAggregate = Object.fromEntries(
    PROVIDERS.map((provider) => [
      provider,
      {
        jsonParseSuccessRate: safeAverage(allAnalyses[provider].map((a) => (a.parsed ? 1 : 0))),
        averageLatencyMs: safeAverage(allAnalyses[provider].map((a) => a.latencyMs)),
        averageVisualElementsFound: safeAverage(allAnalyses[provider].map((a) => a.visualElementsFound)),
        averageTablesFound: safeAverage(allAnalyses[provider].map((a) => a.tablesFound)),
        averageKeywordRecall: keywordRecalls[provider].length ? safeAverage(keywordRecalls[provider]) : null,
        lowConfidenceCount: allAnalyses[provider].filter((a) => a.confidence === 'low').length,
      },
    ]),
  );

  return {
    filesCompared: perFile.length,
    visualsCompared: agreements.length,
    averageTextAgreement: safeAverage(agreements),
    providers: providerAggregate,
  };
}

function safeAverage(nums) {
  const clean = nums.filter((n) => typeof n === 'number' && Number.isFinite(n));
  if (clean.length === 0) return null;
  return Math.round((clean.reduce((a, b) => a + b, 0) / clean.length) * 1000) / 1000;
}
