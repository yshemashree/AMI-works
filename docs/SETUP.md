# Setup

## Requirements

- Node.js ≥ 18.17 (developed on Node 22) and npm
- Optional: Python 3.9+ for the MarkItDown worker (richer markdown from Office files, and `.xls` support)
- Optional, for Drive: a Google Cloud OAuth client (Desktop app) and/or a service account
- Optional, for image understanding only: `ANTHROPIC_API_KEY` and/or `DASHSCOPE_API_KEY`

No system packages are needed. PDF rendering uses `pdfjs-dist` + `@napi-rs/canvas`, which ship prebuilt binaries.

## Install

```bash
npm install
cp .env.example .env
pip install -r src/markitdown/requirements.txt   # optional
```

Without the pip step everything still works with the built-in readers.
The GUI's status bar shows which one is active.

## Read files - no keys needed

```bash
node bin/ami.js read ./samples/report.pdf ./samples/uploads.zip --out output
```

One `<file>.json` per input. See [ARCHITECTURE.md](./ARCHITECTURE.md#the-json-document-amidocumentv1) for the shape.

## Google Drive

1. In Google Cloud Console, enable the **Google Drive API**, then create
   an **OAuth client ID** of type **Desktop app**. Put its id and secret
   in `.env` (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`).
2. Set `DRIVE_FOLDER_ID` to the folder you work in (the id at the end of
   its Drive URL).
3. Sign in once, either with **Connect Google Drive** in the GUI or with
   `node bin/ami.js drive-login`. The token is saved to
   `.drive-oauth-token.json` (gitignored) and refreshed automatically.

The signed-in account is used for both uploads and reads. A service
account (`GOOGLE_SERVICE_ACCOUNT_KEY_PATH`) is optional. If it's set,
it's used for reads, which suits a server with no signed-in user. It
can't upload, because service accounts have no Drive storage of their own.

```bash
node bin/ami.js drive-read --folder <id> --out output/drive
```

## The GUI

```bash
npm run gui          # http://127.0.0.1:4300
```

- **Upload to Drive + read**: drag files in. They're streamed to the
  folder and read into JSON in the same pass, with the checksum verified
  against Drive.
- **Read only**: get the JSON without storing the file anywhere.
- **Drive folder** panel: browse, open subfolders, read one file or the
  whole folder. Files already read show as *Ready* and open instantly.

The GUI listens on 127.0.0.1 only. To expose it on a network, set
`GUI_HOST=0.0.0.0` **and** `GUI_ACCESS_KEY`, then open
`http://<host>:4300/?key=<GUI_ACCESS_KEY>` once. The server refuses to
start on a non-local address without a key. For Google sign-in on a
non-local host, the OAuth client needs that host's
`/auth/google/callback` as an authorised redirect (a "Web application"
client). Desktop-app clients only accept localhost.

## Settings

All in `.env` (see `.env.example`, read in `src/config.js`):

| Variable | Default | What it does |
|---|---|---|
| `DRIVE_FOLDER_ID` | - | default folder for CLI and GUI |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | - | user sign-in (uploads + reads) |
| `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` | - | optional read-only service account |
| `RANGE_THRESHOLD_MB` | 32 | above this, ZIP/Office/PDF files are read by byte range |
| `MAX_IN_MEMORY_MB` | 200 | cap for anything read whole |
| `MEMORY_BUDGET_MB` | 512 | total RAM parallel reads may hold |
| `READ_CONCURRENCY` | 3 | files read in parallel from a folder |
| `MARKITDOWN` | auto | `auto` or `off` |
| `AMI_PYTHON_BIN` | python3 | interpreter for the worker (e.g. a venv) |
| `CACHE_DIR` | - | persist extracted JSON by content hash; empty = memory only |
| `GUI_HOST` / `GUI_PORT` | 127.0.0.1 / 4300 | |
| `GUI_ACCESS_KEY` | - | required for non-local hosts |
| `MAX_UPLOAD_MB` | 1024 | per-file upload cap, enforced while streaming |
| `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `DASHSCOPE_API_KEY`, `QWEN_MODEL`, `DASHSCOPE_BASE_URL` | - | image understanding only |
| `MAX_IMAGE_DIMENSION` | 2000 | images are scaled to this before going to a model |

## Image understanding and the comparison

```bash
node bin/ami.js analyze ./samples --provider qwen
node bin/ami.js compare ./samples --ground-truth ./ground-truth.json --out reports
```

By default only PDF pages and pictures the reader flagged as visual are
sent to a model. Add `--all-pages` to send every PDF page. See
[RESULTS.md](./RESULTS.md) for the comparison's status and ground-truth
format.

## Tests

```bash
npm test
```
