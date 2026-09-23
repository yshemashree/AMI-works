# Supported Formats

| Format | Extensions | Text | Visual content sent to model |
|---|---|---|---|
| Images | `.png` `.jpg` `.jpeg` `.webp` `.gif` `.bmp` | - | the image itself (downscaled if oversized) |
| PDF | `.pdf` | per-page, via pdf.js's text layer | **every page**, rendered to a PNG at ~2x scale (see below) |
| Word | `.docx` | full document text (via `mammoth`) | every embedded picture (`word/media/*`) |
| PowerPoint | `.pptx` | per-slide text, in slide order | every embedded picture (`ppt/media/*`) |
| ZIP | `.zip` | n/a (container) | expanded; every supported file inside is processed the same as if uploaded directly, recursively through subfolders |

## Why PDFs get a full page render, but DOCX/PPTX only get their embedded pictures

A PDF page is fundamentally a fixed visual layout - a chart drawn with vector graphics, a scanned image, a table laid out with lines, none of that exists as extractable "text" or as a separate embedded image file. Rendering the whole page to an image and sending that to the vision model is the only way to reliably capture that content regardless of how the PDF was produced (see `src/extractors/pdfExtractor.js`).

DOCX and PPTX are different: they're ZIP containers with the text and each inserted picture stored as *separate* parts (`word/document.xml` / `word/media/*`, `ppt/slides/slideN.xml` / `ppt/media/*`). There's no single "page" concept to rasterize the way pdf.js can, so this project extracts the text and every embedded picture directly from those parts instead of implementing a full DOCX/PPTX layout-and-render engine.

**Consequence:** a chart or diagram *inserted as an image* (e.g. pasted as PNG/JPEG, or "Paste as Picture") is captured and analyzed. A chart built as a *native, editable Office chart object* is not captured as an image - it's stored as chart XML/data, not a picture, and this pipeline does not currently parse that. See [LIMITATIONS.md](./LIMITATIONS.md).

## Unsupported

- **Legacy binary Office formats** - `.doc`, `.ppt` (pre-2007, OLE Compound File format, not a ZIP container). Detected explicitly and rejected with a clear `LEGACY_OFFICE_FORMAT` error telling the caller to convert to `.docx`/`.pptx` first, rather than failing with a confusing parse error.
- Anything else (`.xlsx`, `.csv`, `.txt`, `.mp4`, ...) is skipped during ZIP/directory expansion and rejected with `UNSUPPORTED_FILE_TYPE` if passed directly.

## File-type detection

Detection is extension-based first (`src/extractors/fileTypeDetector.js`), since that's the primary, reliable signal for an uploaded file. If the extension is missing or unrecognized, it falls back to sniffing the first 16 bytes for known magic numbers (PNG/JPEG/GIF/PDF signatures) so a mislabeled or extension-less upload inside a ZIP still gets processed correctly.
