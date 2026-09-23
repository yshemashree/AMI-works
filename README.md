# AMI Image Understanding

Node.js pipeline for extracting and analyzing visual content (images, and the visuals embedded in PDF/DOCX/PPTX documents, including from direct ZIP uploads) with vision-capable LLMs, plus a harness for comparing Qwen-VL against Claude on identical inputs.

Updates as of 17/09/2026.

## What this does

- Accepts a single image, a PDF, a DOCX, a PPTX, a ZIP bundling any mix of those, or a whole directory.
- For a ZIP, extracts and processes every supported file inside it (including nested folders).
- For documents, analyzes not just body text but the visual content - charts, diagrams, tables, screenshots, photos - by rendering PDF pages to images and pulling out every embedded picture in DOCX/PPTX.
- Runs the same files through both Claude and Qwen-VL under identical prompts/conditions and produces a metrics-based comparison report (reliability, consistency, visual-understanding proxies, and accuracy when ground truth is supplied).

See [docs/](./docs) for the full technical documentation:

| Doc | Covers |
|---|---|
| [ARCHITECTURE.md](./docs/ARCHITECTURE.md) | module map, data flow, design rationale |
| [SETUP.md](./docs/SETUP.md) | install, configure API keys, run |
| [API.md](./docs/API.md) | CLI flags and programmatic (JS) API |
| [PROCESSING_FLOW.md](./docs/PROCESSING_FLOW.md) | step-by-step: input → extraction → analysis → report |
| [SUPPORTED_FORMATS.md](./docs/SUPPORTED_FORMATS.md) | what's supported, what isn't, and why |
| [TESTING.md](./docs/TESTING.md) | what `npm test` covers and what still needs real API keys |
| [RESULTS.md](./docs/RESULTS.md) | Qwen vs. Claude comparison status - **read this first** for the current state of the comparison |
| [LIMITATIONS.md](./docs/LIMITATIONS.md) | known gaps and deliberate tradeoffs |

## Quick start

```bash
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY / DASHSCOPE_API_KEY
npm test                # 45 unit tests, no API keys needed

node bin/ami.js analyze ./samples/report.pdf --provider claude
node bin/ami.js compare ./samples --ground-truth ./samples/ground-truth.json
```

## Current status

- Ingestion (ZIP, image, PDF, DOCX, PPTX), extraction, model clients (Claude + Qwen), the analysis pipeline, and the comparison engine are implemented and unit-tested (45/45 passing).
- **The live Qwen vs. Claude comparison has not been run yet** - this environment has no API keys and no curated ground-truth test set. See [docs/RESULTS.md](./docs/RESULTS.md) for exactly what's needed to produce real numbers and what the report will (and won't) claim once it's run.
