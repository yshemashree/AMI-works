# How files are read now (and why)

This covers the reading side of AMI: getting files out of Google Drive (or
a browser upload) and into structured JSON. It started from a good idea
- don't download Drive files to the server's disk, process them in memory
and stream them where possible. That idea is right, and it's in here. But
streaming alone doesn't get us all the way, and the rest of this page
explains what we did on top of it.

## TL;DR

| | Before | Now |
|---|---|---|
| Reading a file needs a model API key | yes (the CLI always built a model client) | **no** - reading is local; models are only for image understanding |
| Where Drive files go | downloaded into `.tmp/` on disk | **never touch disk** - memory or byte ranges |
| A ZIP upload | extracted to `.tmp/extracted/<uuid>/` | opened **in memory**, one file at a time |
| A 300 MB deck (mostly embedded video) | 300 MB downloaded, ~970 MB RAM peak | **0.4 MB fetched, 72 MB RAM, ~40 ms** |
| Reading the same folder twice | everything downloaded again | **nothing downloaded** (content-hash cache) |
| MarkItDown (Word/Excel/PowerPoint → markdown) | new Python process per file, file on disk | **one long-lived worker, bytes over stdin**: ~200 ms vs ~1000 ms per file |
| Google Docs/Sheets/Slides in Drive | skipped | exported to .docx/.xlsx/.pptx and read |
| Native (editable) Office charts | lost | read as **exact numbers** from the chart XML |
| PDF pages sent to the vision model | every page | only pages that actually have visuals |
| Same logo on 30 slides | 30 vision calls | **1** |

The numbers are measured on this repo, not estimated (see "How we measured" at the bottom).

## 1. Why the API key question came up

Reading a PDF, DOCX or PPTX never needed a model: pdf.js, mammoth and a
ZIP reader do all of it locally. The CLI just built a model client before
it did anything else, so every command asked for `ANTHROPIC_API_KEY`
even when all you wanted was the text.

Now reading and understanding are separate components:

- `ami read`, `ami drive-read` and the GUI **only read**. No key, and the
  model SDK isn't even loaded (`src/models/claudeClient.js` imports it
  lazily).
- `ami analyze` / `compare` add the vision step on top, and only for the
  parts of a file that need it (section 6).

## 2. Streams are the right instinct, but the formats get in the way

"Stream the file from Drive into the parser in small chunks" works for
formats you can read front to back: TXT, CSV, JSON. It doesn't work for
the ones we mostly get:

- **ZIP, DOCX, PPTX, XLSX** are all ZIP files. A ZIP's table of contents
  sits at the **end** of the file. A parser reading front to back has to
  hold everything until it gets there.
- **PDF** keeps its cross-reference table at the end too, and pages point
  back and forth into the file.

So a plain forward stream into these parsers ends up buffering the whole
file anyway. You avoid the disk, but not the RAM or the download time.

## 3. What we do instead: fetch only the bytes we need

Drive supports HTTP `Range` requests on file downloads, so we can treat a
Drive file like a random-access file without downloading it:

1. read the last few KB (the ZIP's table of contents),
2. work out which parts we need (slide XML, document XML, chart XML,
   properties) and which we don't (videos, audio, huge pictures),
3. fetch only those byte ranges.

For a 300 MB deck that's mostly video, that's **0.38 MB in 2 requests**.
The video bytes never leave Google.

Code:

- `src/drive/source.js` - `readRange(start, end)` is one GET with a
  `Range` header.
- `src/reader/rangeCache.js` - rounds reads up to 256 KB blocks, merges
  neighbouring reads into one request, and keeps a small LRU. Small XML
  parts that sit next to each other in the archive come back in one
  round trip instead of dozens.
- `src/reader/zip.js` - opens a ZIP from either a buffer or ranges, and
  inflates one entry at a time into a buffer sized exactly from the
  table of contents.
- PDFs use pdf.js's own range support (`PDFDataRangeTransport` in
  `src/reader/formats/pdf.js`), so pdf.js asks for the chunks it needs
  for text and mostly skips embedded scan images.

MarkItDown needs a whole file, so for a big Office file we hand it a
**slimmed copy**: same package, same structure, with the media files
emptied out (`slimPackage` in `src/reader/office.js`).

## 4. Pick the cheapest strategy per file

Range reads aren't always the fastest option. For a 2 MB file, one
download beats several small requests. So each file gets a strategy:

| File | Strategy |
|---|---|
| under 32 MB (`RANGE_THRESHOLD_MB`) | one GET, streamed into a Buffer **preallocated to the exact size** Drive reported. No chunk list, no `Buffer.concat`, so peak memory is the file size, not double it |
| ZIP / DOCX / PPTX / XLSX / PDF above the threshold | byte ranges (section 3) |
| images, text | buffer (they have to be decoded whole), with a hard cap (`MAX_IN_MEMORY_MB`) checked **before** the download starts |
| Google Docs/Sheets/Slides | exported to Office format (no range support on exports) |

Drive's folder listing already includes each file's size, so the choice
costs nothing.

## 5. Don't read the same bytes twice

Drive's folder listing also includes an **MD5 of every file's content**.
Results are cached by that hash (`src/pipeline/cache.js`):

- Re-reading a folder where nothing changed costs **one list call**.
  Nothing is downloaded.
- A renamed or copied file is a cache hit, because the content is the same.
- Only the extracted JSON is cached (a few KB), in memory and optionally
  in `CACHE_DIR`. Source files are never stored.

Uploads through the GUI work the same way. As the bytes stream through to
Drive we hash them (MD5, the same algorithm Drive uses), which gets us two
things at no extra cost:

- **Upload verification**: we compare our hash with the `md5Checksum`
  Drive returns ("checksum verified" in the UI).
- **Instant JSON**: small files are read straight from memory as they
  arrive, so the JSON is ready the moment Drive confirms. No second
  download. The result is cached under the same key a later Drive read
  would use.

## 6. Spend model money only where it matters

Most of the cost in AMI is vision calls, not bandwidth. The reader now
marks every page, slide and picture with `needsVision` and a plain
reason, and the analysis stage only sends what's flagged:

- **PDF pages**: a page with a good text layer and no images or heavy
  vector graphics is covered by the text. Scanned pages, pages with
  images, and pages drawing charts get flagged. Pages that aren't
  flagged aren't even rendered.
- **Repeated pictures**: the same logo on every slide is detected from
  the ZIP's CRC32 + size (free, no bytes read) and analysed once.
- **Icons** under 48 px aren't worth a call.
- **Native Office charts** are read as data straight from the chart XML
  (series names, categories, values). They're more accurate than a model
  reading a picture of the chart, and they cost nothing.

`--all-pages` turns the PDF filter off when you want the old behaviour.

## 7. Keep RAM flat under parallel load

A concurrency limit alone ("3 files at a time") breaks the moment three
400 MB files show up together. `MemoryBudget` (`src/pipeline/budget.js`)
has each file reserve roughly what it will hold, and wait if that would
push past `MEMORY_BUDGET_MB`. Small files keep flowing in parallel; a huge
one runs on its own. It's first-come-first-served, so a big file can't be
starved by a stream of small ones.

## 8. MarkItDown as a worker, not a subprocess per file

Hemashree's AMI-Markdown-Feature integration was right to use Microsoft's
MarkItDown. It keeps headings, lists and tables that `mammoth` flattens.
The cost was a fresh Python process per file plus a file path on disk.
`src/markitdown/worker.py` is started once and reused. Bytes go over
stdin with a small length-prefixed protocol:

- ~**5x faster** per file (204 ms vs 1005 ms on the same DOCX),
- no temp file,
- if Python or markitdown isn't installed, everything still works with
  the built-in JS readers, and the status bar says which one is running.

We also fixed a quirk along the way: MarkItDown falls back to "plain
text" on a corrupt DOCX and reports success with garbage in it. The
worker now checks for a ZIP header first.

## What we didn't do (yet), and why

- **Browser → Drive direct upload (resumable sessions).** The server
  could hand the browser a resumable-upload URL so bytes never pass
  through our server at all. It's cheaper again for very large uploads,
  but we'd lose the single pass that verifies the checksum and produces
  the JSON on the way in. Worth doing if uploads regularly go over ~1 GB.
- **Truly streaming CSV/TXT parsing.** These are small in practice.
  They're buffered with a size cap.

## How we measured

- *300 MB deck*: a real PPTX (made with python-pptx: 3 slides, a native
  chart, a picture) padded with 3 × 100 MB of random bytes as
  `ppt/media/*.mp4`, read through a counting Source. Buffer mode: 300.13
  MB read, 346 ms, 969 MB peak RSS. Range mode: 0.38 MB in 2 requests, 42
  ms, 72 MB peak RSS. Same slides, text and chart data in both.
- *MarkItDown*: 10 conversions of the same DOCX from the
  AMI-Markdown-Feature test set via its `cli.py` (spawn per file) vs the
  worker. 1005 ms vs 204 ms average.
- The range-vs-buffer equivalence and the "fetches a fraction of the
  file" behaviour are covered by `test/reader.test.js`, so they stay
  true.
