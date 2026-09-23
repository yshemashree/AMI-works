# Processing Flow

## 1. Input resolution

`ami analyze`/`ami compare` accept a file, a directory, or a `.zip`. `src/ingestion/pathResolver.js` normalizes all three into a flat list of individual file paths:

- A file is checked against `isSupportedExtension()` and kept or skipped with a warning.
- A directory is walked recursively; any ZIPs found inside it are expanded in place.
- A ZIP is extracted via `src/ingestion/zipExtractor.js` into `<WORK_DIR>/extracted/<uuid>/`, after safety checks:
  - **zip-slip**: an entry whose resolved path would land outside the extraction directory (e.g. `../../etc/passwd`) is skipped and logged, never written.
  - **zip-bomb**: total entry count (max 5000) and total uncompressed size (max 500MB) are capped; an oversized archive is rejected before any extraction happens.
  - macOS `__MACOSX/` metadata and dotfiles are skipped as noise, not content.

## 2. Extraction (per file)

`src/extractors/index.js` sniffs the file's category (extension, or magic bytes if the extension is missing/unknown) and dispatches:

- **Image** → loaded, downscaled if its longest side exceeds `MAX_IMAGE_DIMENSION` (default 2000px - keeps payloads reasonable without discarding the detail a vision model actually uses), re-encoded to base64 PNG.
- **PDF** → for every page (capped at 200 pages as a safety limit): the text layer is pulled via pdf.js's `getTextContent()`, and the page is independently rendered to a PNG at 2x scale (~192 DPI) via `@napi-rs/canvas`. Both are kept - the render captures charts/diagrams/tables/scanned content the text layer can't.
- **DOCX** → full document text via `mammoth.extractRawText()`; every file under `word/media/` in the underlying ZIP is pulled out as an embedded image.
- **PPTX** → each `ppt/slides/slideN.xml` is parsed for `<a:t>` text runs (in slide order) via `fast-xml-parser`; every file under `ppt/media/` is pulled out as an embedded image.

The result is normalized to one shape regardless of format: `{ filePath, category, text, images: [{ base64, mimeType, label, ... }] }`.

## 3. Analysis (per image)

`src/analysis/analyzeDocument.js` takes that normalized result and calls `analyzeImage()` for every image, with bounded concurrency (default 3 at a time) so a large PDF doesn't fire dozens of simultaneous requests.

`analyzeImage()`:
1. Picks a prompt from `promptTemplates.js` - the document-page prompt (includes the page's extracted text as hint context) for a rendered PDF page, or the generic image prompt for a standalone image / embedded picture.
2. Sends the prompt + image to the model client (`ClaudeClient` or `QwenClient`), which both retry on 429/5xx via `utils/retry.js` before giving up.
3. Parses the model's response text as the fixed JSON shape (`responseParser.js`), tolerating markdown code fences and stray prose around the JSON. A response that still can't be parsed is recorded with `parsed: false` and `confidence: "low"` rather than throwing - one bad response doesn't kill the batch.

## 4a. Single-provider analysis (`ami analyze`)

One JSON report per input file is written to the output directory, containing the extracted text plus every image's parsed analysis (summary, visual elements, tables, entities, confidence).

## 4b. Comparison (`ami compare`)

`src/comparison/runComparison.js` runs steps 2-3 through **both** Claude and Qwen, using identical extracted inputs and identical prompts, then for every image:

- Computes **text agreement** between the two models' `extracted_text` (word-overlap/Jaccard) - a consistency signal.
- Computes **keyword recall** against ground truth if supplied - an accuracy signal.

`src/comparison/metrics.js` aggregates these plus JSON-parse success rate, latency, visual-element/table counts, and low-confidence counts per provider. `src/comparison/reportGenerator.js` writes the full data as JSON and a human-readable Markdown report with a recommendation section derived directly from that run's numbers (see [RESULTS.md](./RESULTS.md) for what that recommendation looks like and its limits).

## Error handling philosophy

Every stage distinguishes **expected, recoverable** failures from **unexpected** ones:

- Unsupported file type, legacy Office format, corrupt/empty ZIP, missing API key → typed `AmiError` subclasses (`src/utils/errors.js`) with a clear message and machine-readable `code`, caught at the CLI boundary and reported without a stack trace.
- A single PDF page failing to render → logged and that page is skipped; the rest of the document still processes (`pdfExtractor.js`).
- A single model call returning unparseable text → recorded as `parsed: false, confidence: "low"` with the raw text preserved, not thrown (`responseParser.js`); does not abort the rest of the batch.
- Anything else → surfaced with its stack trace, since it indicates a real bug rather than a handled edge case.
