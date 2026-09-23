# Architecture

## Goals that shaped the design

1. **One extraction pipeline, any model.** The extractors (`src/extractors/`) know nothing about Claude or Qwen. They turn a file into plain data: text plus a list of `{ base64, mimeType }` images. The model clients (`src/models/`) know nothing about ZIPs, PDFs, or PPTX. This split means adding a third model later, or a fifth file format, touches one module, not the whole pipeline.
2. **Visual content is never optional.** The spec requires analyzing charts/diagrams/tables/screenshots inside documents, not just body text. Text extraction alone cannot do that (a bar chart has no text layer). So every document type produces at least one image per document, even PDFs and DOCX/PPTX files that "just" contain text - see [PROCESSING_FLOW.md](./PROCESSING_FLOW.md) for how each format is turned into images.
3. **Reliability over token efficiency.** Per the project priority, the code retries transient model-API failures (429/5xx) instead of failing a whole batch on one blip, validates ZIP input against zip-slip and zip-bomb style abuse, and never throws away a malformed model response - it's recorded as a parse failure instead of crashing the run.

## Module map

```
src/
  config.js              # Reads .env once; nothing else touches process.env directly
  ingestion/
    zipExtractor.js       # ZIP -> files on disk, with zip-slip/zip-bomb guards
    pathResolver.js        # CLI input (file | dir | zip) -> flat list of supported files
  extractors/
    fileTypeDetector.js    # extension + magic-byte sniffing -> category
    imageExtractor.js      # image file -> [{ base64, mimeType, width, height }]
    pdfExtractor.js        # PDF -> per-page text + per-page rendered PNG
    docxExtractor.js       # DOCX -> full text + embedded images
    pptxExtractor.js       # PPTX -> per-slide text + embedded images
    index.js               # dispatches by category, normalizes output shape
  models/
    baseModelClient.js     # shared response shape (JSDoc contract)
    claudeClient.js         # @anthropic-ai/sdk wrapper
    qwenClient.js            # DashScope (Qwen-VL) HTTP wrapper
    index.js                  # createModelClient(provider)
  analysis/
    promptTemplates.js       # fixed-JSON-shape prompts for images vs. document pages
    responseParser.js         # defensive JSON extraction from model text
    analyzeImage.js            # one image -> one model call -> parsed result
    analyzeDocument.js          # runs analyzeImage over every visual in a document, bounded concurrency
  comparison/
    metrics.js                 # parse rate, latency, text agreement, keyword recall, failures
    runComparison.js            # same inputs through both providers, same prompts
    reportGenerator.js           # JSON + Markdown report, with a metrics-derived recommendation
  index.js                       # CLI command implementations (analyze, compare)
  utils/
    errors.js, logger.js, retry.js
bin/ami.js                        # CLI entry point (#!/usr/bin/env node)
```

## Data flow (high level)

```
input (file / dir / ZIP)
        │
        ▼
pathResolver / zipExtractor      → flat list of supported file paths
        │
        ▼
extractors/index.js (per file)   → { category, text, images[] }
        │
        ▼
analyzeDocument (per file)       → runs analyzeImage over every image, N-way concurrent
        │
        ▼
analyzeImage (per image)         → prompt + image → model client → parsed JSON result
        │
        ├── single-provider run  → CLI writes one JSON report per file (`ami analyze`)
        └── two-provider run     → runComparison + reportGenerator (`ami compare`)
```

## Why a fixed JSON output shape

Every prompt (`promptTemplates.js`) asks the model for the same JSON object: `summary`, `extracted_text`, `visual_elements[]`, `tables[]`, `key_entities[]`, `confidence`, `notes`. This is what makes the comparison engine possible - without a common shape, "compare Qwen vs Claude" would mean diffing two different unstructured essays by eye. `responseParser.js` extracts that JSON defensively (handles code fences, leading/trailing prose) and falls back to a safe empty shape - with the raw text preserved - if a model ignores the instruction, so one bad response never crashes a batch.

## Concurrency and rate limits

`analyzeDocument.js` processes a document's images with a small worker pool (default concurrency 3, configurable) instead of `Promise.all` over everything - a 40-page PDF shouldn't fire 40 simultaneous requests at a provider's rate limit. `utils/retry.js` adds exponential backoff on top for the requests that do get rate-limited or hit a transient 5xx.

## Security considerations

- **Zip-slip**: every ZIP entry's resolved path is checked against the extraction directory before writing; entries that would escape it are skipped and logged (`ingestion/zipExtractor.js`).
- **Zip-bomb**: entry count and total uncompressed size are capped before extraction begins.
- **Untrusted PDFs**: `isEvalSupported: false` is passed to pdf.js so a malicious PDF cannot use pdf.js's optional JS-evaluation code paths.
- **No secrets in code**: API keys are read from `.env` (gitignored) via `src/config.js`; `.env.example` documents the required variables with empty values.
