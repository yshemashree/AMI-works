# Testing

## What's automated (`npm test`)

45 unit tests, run with Node's built-in test runner (`node --test`), no API keys or network access required. Fixtures are generated on the fly (`test/fixtures/generate-fixtures.mjs`, run automatically via the `pretest` npm script) rather than committed as binary files - a 2-page PDF, a DOCX with one embedded image, a PPTX with two slides and one embedded image, a PNG, and a ZIP bundling all of them plus one deliberately unsupported `.txt` file.

| File | Covers |
|---|---|
| `fileTypeDetector.test.js` | extension detection, magic-byte fallback, legacy-Office flagging |
| `zipExtractor.test.js` | correct extraction, **zip-slip rejection**, empty-zip rejection, corrupt-zip rejection, missing-file handling |
| `extractors.test.js` | image/PDF/DOCX/PPTX extraction produce the expected text and images against the generated fixtures |
| `pathResolver.test.js` | file / directory / ZIP input resolution, including nested ZIPs inside a directory |
| `responseParser.test.js` | clean JSON, fenced JSON, JSON-with-prose, and unparseable-text fallback |
| `metrics.test.js` | parse-success rate, text agreement, keyword recall, failure detection, visual-element stats |
| `analyzeDocument.test.js` | correct prompt selection (page-render vs. standalone image), ordering, concurrency, using a mock model client |
| `reportGenerator.test.js` | Markdown/JSON report generation, and specifically that it does **not** claim an accuracy winner when no ground truth was supplied |
| `modelsAndConfig.test.js` | missing-credential errors fail fast, before any network call |

Model calls are mocked (`test/helpers/mockModelClient.js`) so the suite tests the pipeline's logic - extraction correctness, prompt selection, retry/error handling, metric math - independent of any live model's actual output quality. That's a deliberate boundary: **this suite proves the pipeline works; it does not and cannot prove Claude or Qwen answer correctly.**

Run it:
```bash
npm test
```

## What requires real API keys (manual / not part of `npm test`)

- **`ami analyze <file> --provider claude|qwen`** - a real, single-provider run against real files. Verified manually during development (see below); requires `ANTHROPIC_API_KEY` or `DASHSCOPE_API_KEY`.
- **`ami compare <files> [--ground-truth ...]`** - the actual Qwen vs. Claude comparison. Requires both keys. This is the step that produces [RESULTS.md](./RESULTS.md)'s data - see that file for why no live comparison numbers are included in this delivery.

## What was verified manually during development

Since this environment has no Claude/Qwen API keys configured, the following was verified by hand rather than by the automated suite, to make sure the pipeline is actually sound end-to-end, not just unit-clean:

- Extracted a real 2-page PDF and confirmed the rendered page PNGs are visually correct (readable text, correct layout) by inspecting the output image directly - this caught and fixed a real bug (`standardFontDataUrl` was being passed as a `file://` URL, which pdf.js's Node code path doesn't accept - it reads the path directly via `fs.readFile`; text rendered as invisible glyphs until this was fixed).
- Ran `ami analyze` against a ZIP bundling an image, a PDF, a DOCX (nested in a subfolder), and a PPTX (nested), and confirmed it correctly skipped the bundled `.txt` file and processed the other four.
- Confirmed `MissingCredentialsError` fires before any network call when `ANTHROPIC_API_KEY`/`DASHSCOPE_API_KEY` are unset, so a misconfigured `.env` fails immediately and clearly instead of hanging or producing a confusing SDK error.

## Adding your own test files

Drop real files into a local folder (e.g. `samples/`) and run:

```bash
node bin/ami.js analyze ./samples --provider claude
node bin/ami.js compare ./samples --ground-truth ./samples/ground-truth.json
```
