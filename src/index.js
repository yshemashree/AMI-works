import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveInputs } from './ingestion/pathResolver.js';
import { fetchDriveFolder } from './ingestion/driveReader.js';
import { uploadFile } from './ingestion/driveUploader.js';
import { createOAuthDriveClient, hasSavedToken, tokenPath } from './ingestion/driveOAuth.js';
import { extractFile } from './extractors/index.js';
import { analyzeDocument } from './analysis/analyzeDocument.js';
import { createModelClient } from './models/index.js';
import { runComparison } from './comparison/runComparison.js';
import { writeReport } from './comparison/reportGenerator.js';
import { logger } from './utils/logger.js';
import { AmiError } from './utils/errors.js';

/**
 * Analyzes one or more inputs (files, directories, or ZIPs) with a single
 * model provider and writes one JSON report per input file.
 */
export async function runAnalyze({ inputs, provider, outDir }) {
  const files = resolveInputs(inputs);
  const client = createModelClient(provider);
  mkdirSync(outDir, { recursive: true });

  const results = [];
  for (const filePath of files) {
    logger.info(`Analyzing (${provider}): ${path.basename(filePath)}`);
    const extracted = await extractFile(filePath);
    const doc = await analyzeDocument(client, extracted);

    const outPath = path.join(outDir, `${path.basename(filePath)}.${provider}.json`);
    writeFileSync(outPath, JSON.stringify(doc, null, 2));
    results.push({ filePath, outPath, visualCount: doc.visualAnalyses.length });
  }

  return results;
}

/**
 * Runs the same inputs through both Claude and Qwen and writes a
 * comparison report (JSON + Markdown) to outDir.
 */
export async function runCompare({ inputs, outDir, groundTruthPath }) {
  const files = resolveInputs(inputs);
  const groundTruth = groundTruthPath ? JSON.parse(readFileSync(groundTruthPath, 'utf8')) : {};

  const comparison = await runComparison(files, { groundTruth });
  return writeReport(comparison, outDir);
}

/**
 * Pulls a Drive folder into the work dir, then runs the normal analyze
 * path over the downloaded files.
 */
export async function runDriveAnalyze({ folderId, provider, outDir }) {
  const { files } = await fetchDriveFolder({ folderId });
  return runAnalyze({ inputs: files, provider, outDir });
}

export async function runDriveUpload({ filePath, folderId }) {
  return uploadFile(filePath, { folderId });
}

/**
 * Walks through the browser login once and caches the token so later
 * uploads run without it.
 */
export async function runDriveLogin() {
  if (hasSavedToken()) {
    logger.info(`Already logged in, token at ${tokenPath()}. Delete it to log in as someone else.`);
    return;
  }
  await createOAuthDriveClient();
  logger.info('Drive login done.');
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);

  try {
    switch (command) {
      case 'analyze': {
        const results = await runAnalyze({
          inputs: args._,
          provider: args.provider || 'claude',
          outDir: args.out || 'output',
        });
        logger.info(`Wrote ${results.length} report(s) to ${args.out || 'output'}`);
        break;
      }
      case 'compare': {
        const { jsonPath, mdPath } = await runCompare({
          inputs: args._,
          outDir: args.out || 'reports',
          groundTruthPath: args['ground-truth'],
        });
        logger.info(`Comparison written to:\n  ${jsonPath}\n  ${mdPath}`);
        break;
      }
      case 'drive-analyze': {
        const results = await runDriveAnalyze({
          folderId: args.folder,
          provider: args.provider || 'claude',
          outDir: args.out || 'output',
        });
        logger.info(`Wrote ${results.length} report(s) to ${args.out || 'output'}`);
        break;
      }
      case 'drive-login': {
        await runDriveLogin();
        break;
      }
      case 'drive-upload': {
        const file = await runDriveUpload({ filePath: args._[0], folderId: args.folder });
        logger.info(`Uploaded ${file.name} (id ${file.id})`);
        if (file.webViewLink) logger.info(file.webViewLink);
        break;
      }
      default:
        printUsage();
        process.exitCode = command ? 1 : 0;
    }
  } catch (error) {
    if (error instanceof AmiError) {
      logger.error(`${error.code}: ${error.message}`);
    } else {
      logger.error('Unexpected error:', error);
    }
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function printUsage() {
  console.log(`
AMI Image Understanding CLI

Usage:
  ami analyze <file|dir|zip...> [--provider claude|qwen] [--out output]
  ami compare <file|dir|zip...> [--ground-truth truth.json] [--out reports]
  ami drive-analyze [--folder <id>] [--provider claude|qwen] [--out output]
  ami drive-upload <file> [--folder <id>]
  ami drive-login

Examples:
  ami analyze ./samples/report.pdf --provider claude
  ami analyze ./samples/uploads.zip --provider qwen --out output/qwen-run
  ami compare ./samples --ground-truth ./samples/ground-truth.json
  ami drive-analyze --folder 1AbCdEf --provider claude
  ami drive-upload ./reports/comparison.md --folder 1AbCdEf
  ami drive-login
`);
}

/**
 * Runs a command and makes sure nothing exits quietly. main() handles its
 * own errors, this catches anything thrown outside that try.
 */
export function run(argv) {
  return main(argv).catch((error) => {
    logger.error('Unexpected error:', error);
    process.exitCode = 1;
  });
}

// bin/ami.js is the real entry point, but `node src/index.js <cmd>` used
// to just load this file and exit 0 without running anything. Make a
// direct run behave the same as the bin script.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
