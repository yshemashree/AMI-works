# API Reference

## CLI

```
# Reading - no model, no API key
ami read <file|dir|zip...> [--out output] [--no-markitdown]
ami drive-read [--folder <id>] [--out output] [--no-markitdown]
ami gui [--port 4300] [--host 127.0.0.1]

# Drive
ami drive-login
ami drive-upload <file> [--folder <id>]

# Image understanding - needs ANTHROPIC_API_KEY and/or DASHSCOPE_API_KEY
ami analyze <file|dir|zip...> [--provider claude|qwen] [--out output] [--all-pages]
ami drive-analyze [--folder <id>] [--provider claude|qwen] [--out output] [--all-pages]
ami compare <file|dir|zip...> [--ground-truth truth.json] [--out reports] [--all-pages]
```

| Flag | Default | Notes |
|---|---|---|
| `--out` | `output` (`reports` for compare) | created if missing |
| `--folder` | `DRIVE_FOLDER_ID` | Drive folder id |
| `--no-markitdown` | off | skip the Python worker, use the built-in readers only |
| `--all-pages` | off | send every PDF page to the model, not just the visual ones |
| `--provider` | `claude` | `claude` or `qwen` |
| `--ground-truth` | none | `{ "<fileName>": { "expectedKeywords": [...] } }` |

Exit code is 1 on any error. Errors print as `CODE: message`.

## GUI / HTTP (`ami gui`)

| Method & path | What it does |
|---|---|
| `GET /` | the UI |
| `GET /api/status` | Drive sign-in state, MarkItDown state, default folder, upload limit |
| `GET /api/drive/files?folderId=` | folder listing; each entry has `kind` (`file`/`export`/`folder`/`unsupported`) and `cached` |
| `GET /api/drive/file?id=` | read one Drive file → `{ entry, document, cached }` |
| `POST /api/drive/read-folder?folderId=` | read a whole folder; streams NDJSON: `{type:"file", done, total, entry, document, error?}` per file, then `{type:"done", skipped, cache}` |
| `POST /api/upload?folderId=` | multipart; streams each file to Drive and reads it → `{ results: [{ name, file, document, checksumMatches, cached } \| { name, error }] }` |
| `POST /api/extract` | multipart; read only, nothing stored → `{ results: [{ name, document, cached } \| { name, error }] }` |
| `GET /auth/google`, `GET /auth/google/callback`, `POST /auth/signout` | browser sign-in for Drive |

Errors: `{ error: { code, message } }` with 400 (bad input), 401 (not
signed in / access key), 413 (too large), 415 (unsupported type), 422
(file couldn't be read) or 502 (Drive failed).

## Library

### Reader

```js
import { readDocument, fileSource, bufferSource } from './src/reader/index.js';

const { document } = await readDocument(await fileSource('./deck.pptx'));
const { document: fromUpload } = await readDocument(bufferSource('memo.docx', buffer));

// With visuals for a model, and MarkItDown for richer markdown:
import { getMarkItDown } from './src/markitdown/index.js';
const { document, visuals } = await readDocument(source, {
  converter: getMarkItDown(),
  withVisuals: true,
  visionPages: 'auto',        // 'auto' | 'all' | 'none'
  onChild: async (doc, vis) => {},  // per file inside a ZIP
});
```

Options also accept `rangeThresholdBytes`, `maxInMemoryBytes`,
`maxImageDimension` (defaults from `config.js`).

### Drive

```js
import { createReadClient, listFolder, driveSource, uploadStream } from './src/drive/index.js';

const drive = await createReadClient();
const entries = await listFolder(drive, folderId);          // [{ id, name, kind, size, md5, ... }]
const { document } = await readDocument(driveSource(drive, entries[0]));
const file = await uploadStream({ body: readable, name: 'x.pdf', folderId });
```

### Pipeline (what the CLI and GUI use)

```js
import { createPipeline } from './src/pipeline/index.js';

const pipeline = createPipeline({ converter, getReadClient, getWriteClient });
await pipeline.readDriveFolder(folderId, { onProgress });
await pipeline.readDriveFile(fileId);
await pipeline.uploadAndRead({ body, name, mimeType, folderId });
await pipeline.readUpload({ body, name });
await pipeline.readLocal(['./samples']);
```

### Analysis (unchanged)

```js
import { extractFile } from './src/reader/index.js';            // old { filePath, category, text, images[] } shape
import { createModelClient } from './src/models/index.js';
import { analyzeDocument } from './src/analysis/analyzeDocument.js';

const extracted = await extractFile('./report.pdf', { visionPages: 'auto' });
const result = await analyzeDocument(createModelClient('qwen'), extracted);
// result.document carries the full reader JSON alongside visualAnalyses
```

`runComparison(inputs, { groundTruth, visionPages })` and
`writeReport(comparison, outDir)` in `src/comparison/` work as before.

## Errors (`src/utils/errors.js`)

All errors extend `AmiError` (`{ message, code }`). Common codes:
`UNSUPPORTED_FILE_TYPE`, `LEGACY_OFFICE_FORMAT`, `NEEDS_MARKITDOWN`,
`EXTRACTION_FAILED`, `INVALID_ZIP`, `ZIP_TOO_LARGE`, `ZIP_TOO_DEEP`,
`FILE_TOO_LARGE`, `FILE_NOT_FOUND`, `MISSING_DRIVE_FOLDER`,
`INVALID_DRIVE_FOLDER`, `DRIVE_REQUEST_FAILED`, `MISSING_CREDENTIALS`,
`DRIVE_OAUTH_REQUIRED`, `MODEL_REQUEST_FAILED`.
