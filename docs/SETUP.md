# Setup

## Requirements

- Node.js >= 18.17 (developed and tested on Node 22)
- npm
- A Claude API key from [console.anthropic.com](https://console.anthropic.com/) - required for `--provider claude` and for `ami compare`
- A DashScope (Qwen) API key from [dashscope.console.aliyun.com](https://dashscope.console.aliyun.com/) - required for `--provider qwen` and for `ami compare`

No system packages (no poppler, no cairo/pango, no build toolchain) are required. PDF page rasterization uses `pdfjs-dist` + `@napi-rs/canvas`, which ships prebuilt native binaries for common platforms - `npm install` does not compile anything.

## Install

```bash
npm install
```

## Configure credentials

```bash
cp .env.example .env
```

Then edit `.env` and fill in:

```
ANTHROPIC_API_KEY=sk-ant-...
DASHSCOPE_API_KEY=sk-...
```

`.env` is gitignored. Never commit real keys - `.env.example` exists specifically so the required variable names are documented without exposing values.

Environment variables read by the app (see `src/config.js`):

| Variable | Required for | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | `--provider claude`, `compare` | none |
| `CLAUDE_MODEL` | - | `claude-sonnet-5` |
| `DASHSCOPE_API_KEY` | `--provider qwen`, `compare` | none |
| `QWEN_MODEL` | - | `qwen-vl-max` |
| `DASHSCOPE_BASE_URL` | - | `https://dashscope.aliyuncs.com/api/v1` |
| `MAX_IMAGE_DIMENSION` | - | `2000` (px, longest side) |
| `WORK_DIR` | - | `.tmp` (extracted ZIPs / rendered pages) |

## Run the test suite

```bash
npm test
```

This generates small deterministic fixtures (`test/fixtures/generate-fixtures.mjs`, run automatically via the `pretest` script) and runs 45 unit tests with Node's built-in test runner - no API keys or network access required, because model calls are mocked in these tests (see `test/helpers/mockModelClient.js`). See [TESTING.md](./TESTING.md) for what is and isn't covered by this.

## Analyze files

```bash
# Single file, single provider
node bin/ami.js analyze ./samples/report.pdf --provider claude

# A ZIP - extracted and every supported file inside it processed
node bin/ami.js analyze ./samples/uploads.zip --provider qwen --out output/qwen-run

# A whole directory (recurses into subfolders and any ZIPs found)
node bin/ami.js analyze ./samples --provider claude
```

Output: one JSON file per input file in the output directory (default `output/`), named `<original-filename>.<provider>.json`.

## Run the Qwen vs Claude comparison

```bash
node bin/ami.js compare ./samples --out reports
```

Requires both `ANTHROPIC_API_KEY` and `DASHSCOPE_API_KEY` to be set - the comparison is only meaningful when both models actually ran. Output: `reports/comparison-report.json` (full data) and `reports/comparison-report.md` (human-readable summary + recommendation).

### With ground truth (for a real accuracy score)

Automated metrics alone (JSON-parse success, latency, visual-element counts, cross-model agreement) measure reliability and consistency, not correctness - there's no way to know a model is *right* without knowing the right answer. To get an actual accuracy score, supply expected keywords/facts per file:

```json
// ground-truth.json
{
  "report.pdf": { "expectedKeywords": ["Q3 revenue", "$4.2M", "12% growth", "Acme Corp"] },
  "deck.pptx": { "expectedKeywords": ["roadmap", "Q1 2027", "3 phases"] }
}
```

```bash
node bin/ami.js compare ./samples --ground-truth ./ground-truth.json --out reports
```

The report will then include a real `averageKeywordRecall` per provider and the recommendation section will name an accuracy winner instead of stating that no ground truth was supplied.
