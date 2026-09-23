# API Reference

This project is a CLI + library, not an HTTP service. "API" here means the CLI commands and the public JS functions each module exports.

## CLI

```
ami analyze <file|dir|zip...> [--provider claude|qwen] [--out output]
ami compare <file|dir|zip...> [--ground-truth truth.json] [--out reports]
```

| Flag | Applies to | Default | Notes |
|---|---|---|---|
| `--provider` | `analyze` | `claude` | `claude` or `qwen` |
| `--out` | both | `output` (`analyze`) / `reports` (`compare`) | output directory, created if missing |
| `--ground-truth` | `compare` | none | path to a JSON file of `{ "<fileName>": { "expectedKeywords": [...] } }` |

Exit code is `1` on any handled or unhandled error, `0` on success. Errors are logged with a machine-readable `code` (e.g. `MISSING_CREDENTIALS`, `UNSUPPORTED_FILE_TYPE`, `INVALID_ZIP`) - see `src/utils/errors.js` for the full list.

## Programmatic use (`src/index.js`)

```js
import { runAnalyze, runCompare } from './src/index.js';

const results = await runAnalyze({
  inputs: ['./samples/report.pdf', './samples/uploads.zip'],
  provider: 'claude',
  outDir: 'output',
});
// -> [{ filePath, outPath, visualCount }, ...]

const { jsonPath, mdPath } = await runCompare({
  inputs: ['./samples'],
  outDir: 'reports',
  groundTruthPath: './ground-truth.json', // optional
});
```

## Extraction (`src/extractors/index.js`)

```js
import { extractFile } from './src/extractors/index.js';

const result = await extractFile('./report.pdf');
// {
//   filePath, category: 'pdf',
//   text: '[Page 1] ...\n\n[Page 2] ...',
//   images: [{ base64, mimeType: 'image/png', label, pageNumber }, ...],
//   pageCount: 12,
// }
```

`category` is one of `'image' | 'pdf' | 'docx' | 'pptx'`. `images[]` is always present (empty for a text-only edge case) and always base64-encoded, ready to hand to a model client.

## Model clients (`src/models/index.js`)

```js
import { createModelClient } from './src/models/index.js';

const client = createModelClient('claude'); // or 'qwen'
const response = await client.analyze({
  prompt: 'Describe this image.',
  images: [{ base64: '...', mimeType: 'image/png' }],
});
// { provider, model, text, latencyMs, usage: { inputTokens, outputTokens }, raw }
```

Throws `MissingCredentialsError` immediately if the relevant API key isn't set - no network call is attempted. Throws `ModelRequestError` (wrapping the underlying SDK/HTTP error) if the request fails after retries.

## Analysis (`src/analysis/`)

```js
import { analyzeImage } from './src/analysis/analyzeImage.js';
import { analyzeDocument } from './src/analysis/analyzeDocument.js';

const imageResult = await analyzeImage(client, { base64, mimeType, label }, { context: 'a product screenshot' });
const docResult = await analyzeDocument(client, extractedDoc, { concurrency: 3 });
```

`analyzeImage()` result: `{ label, provider, model, latencyMs, usage, parsed, result, rawText }`, where `result` is the parsed fixed-JSON-shape object described in [ARCHITECTURE.md](./ARCHITECTURE.md#why-a-fixed-json-output-shape).

## Comparison (`src/comparison/`)

```js
import { runComparison } from './src/comparison/runComparison.js';
import { writeReport } from './src/comparison/reportGenerator.js';

const comparison = await runComparison(['./samples/report.pdf'], {
  groundTruth: { 'report.pdf': { expectedKeywords: ['Q3', 'revenue'] } },
});
const { jsonPath, mdPath } = writeReport(comparison, 'reports');
```

## Errors (`src/utils/errors.js`)

All thrown errors extend `AmiError` (`{ name, message, code, cause? }`). Notable subclasses: `UnsupportedFileTypeError`, `ExtractionError`, `ModelRequestError`, `MissingCredentialsError`.
