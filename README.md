# AMI File Reading & Image Understanding

Reads the files AMI receives (PDF, Word, PowerPoint, Excel, images, CSV/HTML/text and ZIPs of any of those) from **Google Drive, a browser upload or a local path** into one structured JSON format. There's a small web GUI for uploads, and an optional image-understanding stage (Qwen-VL vs Claude) on top.

Updates as of 23/09/2026.

## What changed in this round

- **Reading doesn't need a model or an API key.** `ami read`, `ami drive-read` and the GUI are fully local. Models are only used by `analyze`/`compare`, and only for the pages and pictures that need them.
- **Everything becomes JSON** (`ami.document/v1`): text, markdown, per-page/slide/sheet sections, properties, native chart data, the picture list, and a per-section "does this need a vision model?" verdict.
- **Nothing goes to disk.** Drive files, uploads and ZIP contents are read in memory or by byte range, never saved to the server. A 300 MB deck (mostly video) takes 0.4 MB of transfer and 72 MB of RAM.
- **MarkItDown (the earlier Microsoft-tool integration) is part of the reader.** It runs as one long-lived Python worker fed over stdin, ~5x faster per file than a process per file. It's optional; there's a pure-JS path for every format.
- **Upload GUI** instead of the CLI: drag and drop, progress bars, Drive folder browser, JSON viewer and download.
- **Component-based layout**: `drive/`, `reader/`, `markitdown/`, `pipeline/`, `server/`, `analysis/`, each with its own public API.

Why these choices, with measurements: **[docs/OPTIMIZATION.md](./docs/OPTIMIZATION.md)**.

## Quick start

```bash
npm install
cp .env.example .env
pip install -r src/markitdown/requirements.txt   # optional, richer markdown

npm test                                          # 114 tests, no keys or network needed

node bin/ami.js read ./samples/report.pdf ./samples/bundle.zip   # -> output/*.json
npm run gui                                        # http://127.0.0.1:4300
```

For Drive, set `GOOGLE_OAUTH_CLIENT_ID/SECRET` and `DRIVE_FOLDER_ID`, then click **Connect Google Drive** in the GUI (or run `ami drive-login`). Full steps are in [docs/SETUP.md](./docs/SETUP.md).

## Components

```
src/
  reader/       bytes -> JSON, per format (no Drive, no network, no disk)
  drive/        Google Drive: list, read (whole or by range), export, upload
  markitdown/   MarkItDown as a long-lived Python worker (optional)
  pipeline/     wires them: content-hash cache, memory budget, upload-and-read in one pass
  server/       the GUI (HTTP + browser UI components)
  analysis/  models/  comparison/   optional vision-model stage + Qwen vs Claude report
```

## Docs

| Doc | Covers |
|---|---|
| [OPTIMIZATION.md](./docs/OPTIMIZATION.md) | the reading approach: no disk, range reads, caching, vision triage, and the numbers behind them |
| [ARCHITECTURE.md](./docs/ARCHITECTURE.md) | components, the `Source` interface, the JSON schema, security |
| [SETUP.md](./docs/SETUP.md) | install, Drive sign-in, GUI, settings |
| [API.md](./docs/API.md) | CLI, HTTP endpoints, library functions |
| [PROCESSING_FLOW.md](./docs/PROCESSING_FLOW.md) | step by step from bytes to JSON (and to model calls) |
| [SUPPORTED_FORMATS.md](./docs/SUPPORTED_FORMATS.md) | what each format produces |
| [TESTING.md](./docs/TESTING.md) | what the tests cover and what was checked by hand |
| [RESULTS.md](./docs/RESULTS.md) | Qwen vs Claude comparison status |
| [LIMITATIONS.md](./docs/LIMITATIONS.md) | known gaps and tradeoffs |

## Status

- Reader, Drive component, MarkItDown worker, pipeline, GUI and analysis stage are implemented and covered by `npm test` (114/114).
- Not yet run against a live Drive folder or live model APIs. See [LIMITATIONS.md](./docs/LIMITATIONS.md) and [RESULTS.md](./docs/RESULTS.md).
