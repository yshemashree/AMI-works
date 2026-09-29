# Architecture

## Components

The code is split into components that each do one job and talk to each
other through small, explicit interfaces. Each has an `index.js` that is
its public surface. Nothing reaches into another component's files.

```
              ┌──────────────┐        ┌──────────────┐
  browser ───▶│  server/     │───────▶│  pipeline/   │◀─── CLI (src/index.js)
              │  GUI + HTTP  │        │  wiring,     │
              └──────────────┘        │  cache,      │
                                      │  mem budget  │
                                      └──┬────┬───┬──┘
                        Source (bytes)   │    │   │  converter (optional)
                   ┌─────────────────────┘    │   └──────────────┐
                   ▼                          ▼                  ▼
            ┌─────────────┐           ┌─────────────┐     ┌──────────────┐
            │  drive/     │           │  reader/    │────▶│ markitdown/  │
            │  list, read,│           │  bytes→JSON │     │ Python worker│
            │  range,     │           │  per format │     └──────────────┘
            │  upload     │           └──────┬──────┘
            └─────────────┘                  │ visuals (only when asked)
                                             ▼
                                  ┌───────────────────────┐
                                  │ analysis/ models/     │  optional: vision
                                  │ comparison/           │  model calls
                                  └───────────────────────┘
```

| Component | Knows about | Doesn't know about |
|---|---|---|
| `src/reader/` | file formats: PDF, DOCX, PPTX, XLSX, images, text, ZIP | Drive, HTTP, models, disk |
| `src/drive/` | Google Drive: auth, listing, byte ranges, exports, uploads | file formats |
| `src/markitdown/` | running Microsoft MarkItDown in a long-lived Python worker | where bytes come from |
| `src/pipeline/` | wiring the above; caching by content hash; the memory budget | HTTP, HTML |
| `src/server/` | HTTP routes and the browser UI | Drive and formats (it only calls the pipeline) |
| `src/analysis/`, `src/models/`, `src/comparison/` | vision-model calls and the Qwen vs Claude comparison | Drive, ZIPs, formats |

### The one interface that ties it together: `Source`

```js
{
  name, size, mimeType, origin, meta,
  readAll({ maxBytes }) -> Promise<Buffer>
  readRange(start, end) -> Promise<Buffer>   // optional
}
```

`src/reader/sources.js` has `bufferSource` (uploads) and `fileSource`
(local files). `src/drive/source.js` has `driveSource`. The reader only
ever sees a Source, so a new storage backend (S3, WhatsApp media URLs,
...) means writing one more Source, with no changes to the reader.

## Module map

```
src/
  config.js                  every env setting, read once
  index.js                   CLI: read, drive-read, gui, analyze, compare, drive-*
  reader/
    index.js                 readDocument(source, options) -> { document, visuals }
    sources.js               bufferSource, fileSource
    detect.js                extension / mime / magic-byte type detection
    document.js              the JSON shape, image registry (dedupe + vision verdicts)
    zip.js                   ZIP from a buffer or byte ranges; limits
    rangeCache.js            block-aligned range reads with an LRU
    office.js                shared OOXML bits: properties, rels, charts, media, slim package
    imageInfo.js             image dimensions from headers
    legacy.js                adapter to the shape the analysis stage expects
    formats/  pdf.js docx.js pptx.js xlsx.js image.js text.js archive.js markdown.js
  drive/
    index.js                 public API + authStatus()
    auth.js                  service account client, callDrive() error wrapping
    oauth.js                 user sign-in (CLI and browser flows)
    folder.js                listing, id validation, Google-native exports
    source.js                driveSource (buffer / range / export), collect()
    upload.js                streaming uploads
  markitdown/
    index.js  client.js  worker.py  requirements.txt
  pipeline/
    index.js                 createPipeline(): listDrive, readDriveFile/Folder, uploadAndRead, readUpload, readLocal
    cache.js                 ResultCache (MD5-keyed JSON, memory + optional dir)
    budget.js                MemoryBudget, mapLimit
    analyze.js               forEachExtracted(): reader -> analysis stage, ZIP children one by one
    localInputs.js           CLI paths -> file list
  server/
    index.js                 routes, streaming multipart, OAuth, access key, static files
    public/                  index.html, styles.css, js/{main,api,dom}.js, js/components/*
  analysis/  models/  comparison/  utils/
```

## The JSON document (`ami.document/v1`)

Every format produces the same shape, so whatever consumes it (the GUI,
a database, the analysis stage) never branches on file type:

```jsonc
{
  "schema": "ami.document/v1",
  "source":   { "name", "type", "mimeType", "sizeBytes", "origin", "driveFileId?", "md5?", "path?" },
  "metadata": { "title?", "author?", "created?", "modified?", "application?", ... },
  "stats":    { "pages?", "slides?", "sheets?", "files?", "words", "characters", "images", "uniqueImages",
                "charts", "sectionsNeedingVision", "imagesNeedingVision" },
  "text":     "plain text of the whole document",
  "markdown": "markdown with headings/tables (MarkItDown or built-in) or null",
  "sections": [ { "kind": "page|slide|sheet|body|image|file", "number", "title?", "text", "notes?",
                  "needsVision", "visionReason" } ],
  "images":   [ { "id", "name", "mimeType", "width", "height", "bytes", "section", "duplicateOf",
                  "needsVision", "visionReason" } ],
  "charts":   [ { "id", "type", "title", "slide?|sheet?", "series": [ { "name", "categories", "values" } ] } ],
  "children": [ /* one document per file, for ZIPs */ ],
  "skipped?": [ { "name", "reason" } ],
  "warnings": [ "..." ],
  "error?":   { "code", "message" },          // only on a child that couldn't be read
  "engine":   { "reader", "markdown", "strategy": "buffer|range" },
  "timings":  { "totalMs" }
}
```

Image bytes are never put in the JSON. When the analysis stage asks for
visuals (`withVisuals: true`), they come back separately, and only for
the pages/pictures flagged `needsVision`.

## Design decisions

- **No disk.** Drive files, uploads and ZIP contents are handled in
  memory or through byte ranges. The only things written are the output
  JSON and, if `CACHE_DIR` is set, cached JSON. See
  [OPTIMIZATION.md](./OPTIMIZATION.md) for the reasoning and the numbers.
- **Reading never needs a model.** The model SDKs load lazily and only
  the analysis commands create a client.
- **MarkItDown is an upgrade, not a dependency.** Every format has a
  pure-JS path. When the Python worker is available it improves the
  markdown (DOCX/PPTX/XLSX/CSV/HTML). `.xls` is the one format that
  needs it.
- **One bad file never sinks a batch.** Inside a ZIP or a Drive folder,
  a file that fails gets an `error` entry and the rest carry on.
- **Fixed JSON for model output too.** The analysis prompts still ask
  every model for the same JSON shape (`promptTemplates.js`), which is
  what makes the Qwen vs Claude comparison possible.

## Security

- ZIPs are never extracted to disk, so zip-slip can't happen. Entry
  names are only labels. Entry count, per-entry size, total inflated
  bytes and compression ratio are all capped (`src/reader/zip.js`), and
  archives nest at most 3 deep.
- Drive folder and file ids are validated against `[A-Za-z0-9_-]` before
  they go into a Drive query, so a crafted id can't change the query.
- `callDrive()` strips the googleapis error (which references the auth
  client and key) before anything is logged or returned.
- pdf.js runs with `isEvalSupported: false`.
- GUI: binds to 127.0.0.1 by default and refuses to bind elsewhere
  without `GUI_ACCESS_KEY`. OAuth callbacks need a one-time `state`.
  Static files are served from a fixed folder only. The UI builds all
  DOM through `textContent`, never `innerHTML`, under a strict CSP.
  Uploads have a size cap enforced while streaming.
