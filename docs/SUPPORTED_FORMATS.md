# Supported Formats

| Format | Extensions | What goes into the JSON | Sent to a vision model (analyze/compare only) |
|---|---|---|---|
| PDF | `.pdf` | per-page text, document info, per-page visual verdict | only pages flagged as visual (scans, images, charts/diagrams); `--all-pages` for every page |
| Word | `.docx` | text; markdown with headings/lists/tables (MarkItDown); properties; native charts as data; picture list | unique pictures that aren't icon-sized |
| PowerPoint | `.pptx` | per-slide text and speaker notes; markdown; properties; native charts as data; which picture is on which slide | unique pictures that aren't icon-sized |
| Excel | `.xlsx` | one markdown table per sheet (built-in, no Python needed); native charts | - |
| Excel (legacy) | `.xls` | markdown via MarkItDown only | - |
| Images | `.png` `.jpg` `.jpeg` `.webp` `.gif` `.bmp` | format and dimensions (from the header, no decode) | the image, downscaled to `MAX_IMAGE_DIMENSION` if larger |
| Text | `.txt` `.md` `.csv` `.tsv` `.json` `.xml` `.html` `.htm` | text; CSV/TSV as a table; HTML stripped (or converted by MarkItDown) | - |
| ZIP | `.zip` | one child document per supported file (nested folders and ZIPs up to 3 deep); `skipped` list for the rest | per child, as above |
| Google Docs / Sheets / Slides / Drawings (Drive) | - | exported to .docx / .xlsx / .pptx / .png, then as above | as above |

## Native charts

A chart made with PowerPoint/Word/Excel's own "Insert Chart" is stored as
XML with the numbers in it, not as a picture. We read that XML directly,
so the JSON has the exact series names, categories and values, with no
vision call needed. A chart pasted *as a picture* is a picture, and goes
through the vision path like any other image.

## Why PDFs get page renders but DOCX/PPTX get their pictures

A PDF page is a fixed layout. A vector chart or a scanned page has no
separate "image file" to extract, so when a page needs vision we render
it. DOCX/PPTX store each picture as its own part (`word/media/*`,
`ppt/media/*`), so we send those directly. DOCX has no fixed pagination
to render without a full layout engine, so there's no page render for it
(see [LIMITATIONS.md](./LIMITATIONS.md)).

## Unsupported

- **Legacy binary Office**: `.doc`, `.ppt`. Rejected with
  `LEGACY_OFFICE_FORMAT` and a "re-save as .docx/.pptx" message rather
  than a confusing parse error.
- Anything else (`.exe`, `.mp4`, ...) → `UNSUPPORTED_FILE_TYPE`. Inside a
  ZIP it's listed under `skipped`.

## Type detection

Extension first, then the mime type Drive or the browser reports, then
the first 16 bytes (PNG/JPEG/GIF/PDF/ZIP signatures). That covers a
mislabelled or extension-less upload (`src/reader/detect.js`).
