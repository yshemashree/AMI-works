# Limitations

## Open items

1. **No live Qwen vs Claude numbers yet.** The comparison runs and is
   tested against mocks, but it hasn't been run with real keys and
   ground truth. See [RESULTS.md](./RESULTS.md).
2. **No live Drive run in CI.** Drive is mocked in tests (including
   Range requests and exports). The first real-folder run should be
   watched, especially reads through shared drives.
3. **PDF triage is a heuristic.** A page is sent to vision if it has
   little text, any images, or 25+ vector paths. A chart drawn with
   fewer paths, or a table drawn only with text, can be marked "text
   only". `--all-pages` is the escape hatch. In range mode (PDFs over
   `RANGE_THRESHOLD_MB`) images aren't inspected, so triage uses text
   density alone.
4. **DOCX has no page renders.** Only text and embedded pictures, because
   DOCX has no fixed pagination without a layout engine.
5. **SmartArt, shapes and text boxes drawn with Office shapes** aren't
   pictures and aren't charts, so they only contribute their text.
   Native charts are read as data. Pasted pictures go to vision.
6. **Legacy `.doc`/`.ppt` are rejected**, not converted. `.xls` works
   only with the MarkItDown worker.
7. **pdf.js holds a full-length buffer in range mode.** It's virtual
   memory. On Linux, pages are only committed for chunks actually
   fetched, which is why the 300 MB test stays around 72 MB resident.
   On other platforms the allocation may be committed up front.
8. **The memory budget is an estimate** (file size × 2 for in-memory
   reads, a fixed working set for range reads). It keeps a busy folder
   read predictable. It isn't a hard OS-level cap.
9. **Google exports are capped at 10 MB by Google**, so very large
   Google Docs/Slides fail with a Drive error rather than being read.
10. **Uploads pass through the server.** That's what lets one pass
    verify the checksum and produce the JSON, but for very large files
    a direct browser→Drive resumable upload would use less server
    bandwidth (see [OPTIMIZATION.md](./OPTIMIZATION.md#what-we-didnt-do-yet-and-why)).

## Design tradeoffs

- **One model call per visual**, not per document. More calls, but each
  response is independently parseable and comparable. Triage and
  deduplication keep the count down.
- **Text agreement between models is a consistency signal, not
  accuracy.** Only ground-truth keyword recall measures accuracy.
- **Safety caps** (500 PDF pages, 5000 ZIP entries, 200 MB per ZIP
  entry, 1 GB inflated per archive, 3 levels of nesting) are there to
  stop one bad input stalling a batch. They weren't tuned against
  production volumes.
