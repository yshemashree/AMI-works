import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { fileSource } from './reader/index.js';
import { getMarkItDown, closeMarkItDown } from './markitdown/index.js';
import {
  createReadClient,
  createOAuthDriveClient,
  listFolder,
  isReadable,
  driveSource,
  uploadFile,
  hasSavedToken,
  tokenPath,
  authStatus,
  buildAuthUrl,
  completeLogin,
  signOut,
} from './drive/index.js';
import { createPipeline, resolveInputs } from './pipeline/index.js';
import { forEachExtracted } from './pipeline/analyze.js';
import { analyzeDocument } from './analysis/analyzeDocument.js';
import { createModelClient } from './models/index.js';
import { runComparison } from './comparison/runComparison.js';
import { writeReport } from './comparison/reportGenerator.js';
import { startServer } from './server/index.js';
import { logger } from './utils/logger.js';
import { AmiError } from './utils/errors.js';

function defaultPipeline({ markitdown = true } = {}) {
  return createPipeline({
    converter: markitdown ? getMarkItDown() : null,
    getReadClient: createReadClient,
    getWriteClient: () => createOAuthDriveClient({ interactive: false }),
  });
}

/**
 * Reads files, directories or ZIPs into JSON - one .json per input.
 * No model, no API key.
 */
export async function runRead({ inputs, outDir, markitdown = true }) {
  const pipeline = defaultPipeline({ markitdown });
  mkdirSync(outDir, { recursive: true });

  const written = [];
  for (const { filePath, document, error } of await pipeline.readLocal(inputs)) {
    if (error) {
      logger.warn(`${filePath}: ${error.code}: ${error.message}`);
      continue;
    }
    const outPath = path.join(outDir, `${safeName(path.basename(filePath))}.json`);
    writeFileSync(outPath, JSON.stringify(document, null, 2));
    logger.info(`${path.basename(filePath)} -> ${outPath} (${describe(document)})`);
    written.push({ filePath, outPath });
  }
  return written;
}

/** Reads a whole Drive folder into JSON in memory, one .json per file. */
export async function runDriveRead({ folderId, outDir, markitdown = true }) {
  const pipeline = defaultPipeline({ markitdown });
  mkdirSync(outDir, { recursive: true });

  const result = await pipeline.readDriveFolder(folderId || config.drive.folderId, {
    onProgress: ({ done, total, entry, result: r }) =>
      logger.info(`[${done}/${total}] ${entry.driveName}${r.cached ? ' (cached)' : ''}${r.error ? ` FAILED: ${r.error.message}` : ''}`),
  });

  for (const { entry, document } of result.files) {
    if (!document) continue;
    writeFileSync(path.join(outDir, `${safeName(entry.driveName)}.json`), JSON.stringify(document, null, 2));
  }
  for (const skipped of result.skipped) logger.info(`Skipped ${skipped.name} (${skipped.kind})`);
  return result;
}

/**
 * Analyzes local inputs with a vision model and writes one JSON report
 * per document. Only pages/pictures the reader flagged as visual are sent
 * unless allPages is set.
 */
export async function runAnalyze({ inputs, provider, outDir, allPages = false }) {
  const files = resolveInputs(inputs);
  const client = createModelClient(provider);
  mkdirSync(outDir, { recursive: true });

  const results = [];
  for (const filePath of files) {
    await forEachExtracted(await fileSource(filePath), { visionPages: allPages ? 'all' : 'auto', converter: getMarkItDown() }, async (extracted) => {
      results.push(await analyzeAndWrite(client, extracted, provider, outDir));
    });
  }
  return results;
}

/** Same as runAnalyze, straight from a Drive folder - nothing downloaded to disk. */
export async function runDriveAnalyze({ folderId, provider, outDir, allPages = false }) {
  const client = createModelClient(provider);
  const drive = await createReadClient();
  const entries = (await listFolder(drive, folderId || config.drive.folderId)).filter(isReadable);
  if (entries.length === 0) throw new AmiError('No supported files in that Drive folder', { code: 'NO_INPUT_FILES' });
  mkdirSync(outDir, { recursive: true });

  const results = [];
  for (const entry of entries) {
    await forEachExtracted(driveSource(drive, entry), { visionPages: allPages ? 'all' : 'auto', converter: getMarkItDown() }, async (extracted) => {
      results.push(await analyzeAndWrite(client, extracted, provider, outDir));
    });
  }
  return results;
}

async function analyzeAndWrite(client, extracted, provider, outDir) {
  logger.info(`Analyzing (${provider}): ${extracted.filePath} - ${extracted.images.length} visual(s)`);
  const doc = await analyzeDocument(client, extracted);
  const outPath = path.join(outDir, `${safeName(extracted.filePath)}.${provider}.json`);
  writeFileSync(outPath, JSON.stringify(doc, null, 2));
  return { filePath: extracted.filePath, outPath, visualCount: doc.visualAnalyses.length };
}

export async function runCompare({ inputs, outDir, groundTruthPath, allPages = false }) {
  const groundTruth = groundTruthPath ? JSON.parse(readFileSync(groundTruthPath, 'utf8')) : {};
  const comparison = await runComparison(inputs, { groundTruth, visionPages: allPages ? 'all' : 'auto' });
  return writeReport(comparison, outDir);
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

export async function runGui({ port, host } = {}) {
  const pipeline = defaultPipeline();
  const auth = { status: authStatus, buildAuthUrl, completeLogin, signOut };
  return startServer({ port, host, pipeline, auth });
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  const markitdown = !args['no-markitdown'];
  const allPages = Boolean(args['all-pages']);

  try {
    switch (command) {
      case 'read': {
        const written = await runRead({ inputs: args._, outDir: args.out || 'output', markitdown });
        logger.info(`Wrote ${written.length} JSON file(s) to ${args.out || 'output'}`);
        break;
      }
      case 'drive-read': {
        const result = await runDriveRead({ folderId: args.folder, outDir: args.out || 'output', markitdown });
        const ok = result.files.filter((f) => f.document).length;
        logger.info(`Read ${ok}/${result.files.length} file(s) (${result.cache.hits} from cache) into ${args.out || 'output'}`);
        break;
      }
      case 'gui': {
        await runGui({ port: args.port ? Number(args.port) : undefined, host: args.host });
        return; // keep running
      }
      case 'analyze': {
        const results = await runAnalyze({ inputs: args._, provider: args.provider || 'claude', outDir: args.out || 'output', allPages });
        logger.info(`Wrote ${results.length} report(s) to ${args.out || 'output'}`);
        break;
      }
      case 'compare': {
        const { jsonPath, mdPath } = await runCompare({
          inputs: args._,
          outDir: args.out || 'reports',
          groundTruthPath: args['ground-truth'],
          allPages,
        });
        logger.info(`Comparison written to:\n  ${jsonPath}\n  ${mdPath}`);
        break;
      }
      case 'drive-analyze': {
        const results = await runDriveAnalyze({ folderId: args.folder, provider: args.provider || 'claude', outDir: args.out || 'output', allPages });
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
  closeMarkItDown();
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

function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|]+/g, '__');
}

function describe(doc) {
  const s = doc.stats;
  return [
    doc.source.type,
    s.pages && `${s.pages} pages`,
    s.slides && `${s.slides} slides`,
    s.sheets && `${s.sheets} sheets`,
    s.files && `${s.files} files`,
    `${s.words} words`,
    s.images && `${s.images} images`,
    s.charts && `${s.charts} charts`,
  ]
    .filter(Boolean)
    .join(', ');
}

function printUsage() {
  console.log(`
AMI - file reading and image understanding

Reading (no model, no API key):
  ami read <file|dir|zip...> [--out output] [--no-markitdown]
  ami drive-read [--folder <id>] [--out output] [--no-markitdown]
  ami gui [--port 4300] [--host 127.0.0.1]

Drive:
  ami drive-login
  ami drive-upload <file> [--folder <id>]

Analysis (needs ANTHROPIC_API_KEY and/or DASHSCOPE_API_KEY):
  ami analyze <file|dir|zip...> [--provider claude|qwen] [--out output] [--all-pages]
  ami drive-analyze [--folder <id>] [--provider claude|qwen] [--out output] [--all-pages]
  ami compare <file|dir|zip...> [--ground-truth truth.json] [--out reports] [--all-pages]

Examples:
  ami read ./samples/report.pdf ./samples/uploads.zip
  ami drive-read --folder 1AbCdEf --out output/drive
  ami gui
  ami analyze ./samples/report.pdf --provider qwen
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

// bin/ami.js is the real entry point; make `node src/index.js <cmd>`
// behave the same instead of loading and exiting silently.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
