# Testing

## What `npm test` covers

114 tests, Node's built-in runner, no API keys and no network. Fixtures
are generated on the fly (`test/fixtures/generate-fixtures.mjs`): PDFs, a
DOCX, a plain PPTX, a "rich" PPTX (notes, a repeated logo, an icon, a
native chart, properties), an XLSX, a PNG and a ZIP bundle with nested
folders, junk and an unsupported file.

| File | Covers |
|---|---|
| `reader.test.js` | the JSON shape for every format; **buffer vs range reads give the same result**; PDF triage and rendering only flagged pages; DOCX/PPTX/XLSX details (notes, native chart numbers, properties, sheets); picture dedupe and icon skipping; a large deck read by range fetches **under a quarter** of its bytes; CSV/HTML/BOM handling; in-memory ZIPs (junk, unsupported, "../" names, broken children, nesting limit, corrupt archive); the block cache |
| `detect.test.js` | extension, mime and magic-byte detection |
| `drive.test.js` | folder listing (pagination, kinds, Google-native exports, query-injection guard); Drive source (exact bytes, Range header, size limit before download, export); error wrapping never leaks the auth client |
| `driveUploader.test.js` | CLI uploads: naming, folder handling, errors |
| `pipeline.test.js` | reading a Drive folder in memory, per-file errors, **second run downloads nothing**, cache hit on a renamed copy; one-pass upload (bytes intact, checksum verified, JSON with no re-download); large-upload read-back; ResultCache (disk, copies, LRU); MemoryBudget never exceeds its limit |
| `markitdown.test.js` | the Python worker: bytes over stdin, many files through one process, a corrupt file failing on its own, fallback when Python/markitdown is missing (the worker tests skip if markitdown isn't installed) |
| `server.test.js` | the GUI server: UI and scripts served, path traversal refused, status, streaming upload → Drive → JSON, read-only extract, per-file errors, upload size limit, folder listing, NDJSON folder reads, 400s on bad ids, OAuth `state` (forged and replayed callbacks refused), access key |
| `analyzeDocument.test.js`, `metrics.test.js`, `reportGenerator.test.js`, `responseParser.test.js`, `modelsAndConfig.test.js` | the analysis and comparison stage with a mock model client (unchanged behaviour) |
| `extractors.test.js`, `localInputs.test.js` | the analysis-stage adapter and CLI input resolution |

Drive is mocked (`test/helpers/mockDriveClient.js`, which supports Range
requests and exports), and so are the models. The suite proves the
pipeline logic. It can't prove a model reads a chart correctly.

## What was checked by hand

- The GUI in Chromium (desktop, dark mode, 390 px mobile): uploading,
  browsing a folder, reading a single file, reading a whole folder,
  opening files inside a ZIP. No console errors and no horizontal scroll
  on mobile.
- A real python-pptx deck with a native chart, a repeated picture and
  notes, through both strategies, with and without MarkItDown.
- The AMI-Markdown-Feature test files (docx, pptx, xlsx, csv, html,
  json, xml, txt, empty, corrupt pdf, exe) through the reader with the
  worker.
- The numbers in [OPTIMIZATION.md](./OPTIMIZATION.md).

## Needs real credentials

- Live Drive: `ami drive-read`, the GUI's upload and folder panels
  against a real folder.
- Live models: `ami analyze`, `ami compare` (see [RESULTS.md](./RESULTS.md)).
