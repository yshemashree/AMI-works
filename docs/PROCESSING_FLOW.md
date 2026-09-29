# Processing Flow

## 1. Where the bytes come from

Everything becomes a `Source` (see [ARCHITECTURE.md](./ARCHITECTURE.md)):

- **Local path** (CLI): `fileSource(path)`. Directories are walked; ZIPs
  are passed through whole and opened by the reader in memory.
- **Browser upload** (GUI): the multipart body is parsed as a stream
  (`busboy`). Nothing is buffered to disk.
  - *Upload to Drive + read*: the bytes are piped to Drive, hashed (MD5)
    and, if the file is under `RANGE_THRESHOLD_MB`, kept in memory, all
    in one pass. The JSON is produced from that copy.
  - *Read only*: collected into memory (capped) and read. Nothing is
    stored.
- **Drive file**: `driveSource(client, entry)`. The folder listing gives
  size and MD5 for free.

## 2. Cache check (Drive and uploads)

The key is the file's content MD5 (plus the schema version and whether
MarkItDown is on). On a hit the stored JSON comes back and **no bytes are
downloaded**. Google-native files (no MD5) key on id + modified time.

## 3. Read strategy

- Size ≤ `RANGE_THRESHOLD_MB` (default 32 MB): one GET into a Buffer
  preallocated to the exact size.
- Larger ZIP/DOCX/PPTX/XLSX/PDF: byte-range reads through a 256 KB
  block cache. Only the table of contents and the parts we parse are
  fetched.
- Images and text: always whole, capped at `MAX_IN_MEMORY_MB`, and
  refused before downloading if Drive already says they're bigger.

Folder reads run `READ_CONCURRENCY` files at a time inside a
`MEMORY_BUDGET_MB` budget.

## 4. Reading (per format)

- **PDF** (pdf.js): per page, the text layer, plus a verdict. A page is
  flagged `needsVision` if it has under 40 characters of text (scanned),
  any image operators, or 25+ vector path operations (charts, diagrams).
  In range mode, images aren't inspected (that would pull their bytes),
  so the verdict uses text density only.
- **DOCX**: MarkItDown markdown when the worker is up, otherwise mammoth
  raw text. Properties from `docProps`. Native charts from
  `word/charts/*`. Pictures from `word/media/*`.
- **PPTX**: per-slide text from the slide XML, notes from
  `notesSlides`, and which pictures and charts sit on which slide from
  the slide relationships. Markdown from MarkItDown when available.
- **XLSX**: every sheet read straight from its XML into a markdown table
  (shared strings, inline strings, booleans). MarkItDown markdown when
  available.
- **Images**: dimensions from the header.
- **Text**: UTF-8/UTF-16 BOM handling; CSV/TSV → table; HTML stripped
  (or converted by MarkItDown); JSON pretty-printed.
- **ZIP**: each supported entry is inflated on its own, read as a child
  document and released. Junk (`__MACOSX/`, dotfiles) is ignored;
  unsupported files are listed in `skipped`; a failing child gets an
  `error` and the rest carry on.

Pictures are deduplicated by CRC32 + size from the ZIP directory, and
icon-sized ones (under 48 px) are marked as not worth a vision call.

## 5. Output

`readDocument()` returns `{ document, visuals }`. `document` is the
`ami.document/v1` JSON. `visuals` is empty unless the caller asked for
them.

- `ami read` / `ami drive-read`: one `.json` per file.
- GUI: shown in the result panel (Summary / Text / Markdown / JSON) and
  downloadable. "Read whole folder" streams one result per file as each
  finishes.

## 6. Image understanding (optional: `analyze`, `drive-analyze`, `compare`)

With `withVisuals: true` the reader also returns base64 images, but only
for flagged PDF pages (rendered at ~192 DPI) and unique, non-icon
pictures. `analyzeDocument` sends each one to the model with a fixed JSON
prompt. For a PDF page, that page's own text goes along as a hint. ZIP
children are analysed one at a time as they're read, so a big archive
never has all its renders in memory together. `compare` sends the exact
same visuals to Claude and Qwen.

## Error handling

- Expected problems (unsupported type, legacy Office, corrupt file, file
  too large, missing credentials, bad folder id) are `AmiError`s with a
  `code`, shown in the CLI without a stack trace and returned by the
  GUI as `{ error: { code, message } }` with a matching HTTP status.
- A single PDF page failing is a warning; the rest of the document
  still reads.
- An unparseable model response is recorded as `parsed: false`, not
  thrown.
- MarkItDown failing (not installed, crashed, timed out, can't parse
  that file) falls back to the built-in reader and adds a warning.
