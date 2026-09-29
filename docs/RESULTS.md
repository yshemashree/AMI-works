# Qwen vs. Claude - Results

## Status: pipeline built and tested; live comparison not yet run

This is a status document, not a finished comparison report. Being direct about why:

**The comparison engine needs two real API keys to produce real data, and this build environment has neither.** `ANTHROPIC_API_KEY` (Claude) and `DASHSCOPE_API_KEY` (Qwen) were not available here, and no test files with known-correct answers were provided as part of this task. Producing "results" without them would mean fabricating numbers - so instead, here's exactly what's ready, what's blocking, and the one command needed to unblock it.

## What's ready to run right now

The full comparison pipeline is implemented and unit-tested against mocked model responses (`src/comparison/`, `test/metrics.test.js`, `test/reportGenerator.test.js` - part of the `npm test` suite, see [TESTING.md](./TESTING.md)):

- Runs **identical inputs and identical prompts** through Claude and Qwen (`runComparison.js`) - a same-conditions comparison, not an apples-to-oranges one.
- Computes, per file and in aggregate (`metrics.js`):
  - **Reliability**: JSON-parse success rate (did the model return usable structured output), low-confidence response count.
  - **Consistency**: word-overlap agreement between the two models' extracted text for the same image.
  - **Visual understanding (proxy)**: average visual elements / tables detected per image.
  - **Accuracy** (only when ground truth is supplied): keyword/fact recall against human-curated expected answers.
  - **Latency**: average response time per provider.
- Generates a Markdown report (`reportGenerator.js`) whose "Recommendation" section is derived from that run's actual numbers - see the template's logic below for exactly what it will say once real data exists.

## How to produce real results

```bash
cp .env.example .env
# edit .env: set ANTHROPIC_API_KEY and DASHSCOPE_API_KEY

# put representative files in ./samples (PDFs with charts/tables, DOCX/PPTX with
# embedded images, standalone screenshots, a ZIP bundling a mix of all of them)

node bin/ami.js compare ./samples --ground-truth ./samples/ground-truth.json --out reports   # add --all-pages to send every PDF page
```

This writes `reports/comparison-report.json` (full data) and `reports/comparison-report.md` (the human-readable report with the recommendation). `--ground-truth` is optional but strongly recommended - without it, the recommendation can only speak to reliability/consistency, not accuracy (the report says this explicitly rather than guessing).

## What the recommendation will and won't claim

Verified by `test/reportGenerator.test.js`:

- **Without ground truth**: the report states plainly that no accuracy claim can be made from that run, and tells the reader how to add ground truth - it does not guess a winner.
- **With ground truth**: the report names which model recalled more of the expected facts in that run, alongside the reliability/consistency numbers, and closes with an explicit reminder to re-run against a larger, representative sample before treating any single run as final.

## Recommended test set for a real run

To get a comparison that's actually representative of "our use case" rather than a handful of synthetic files:

- 3-5 PDFs that mix body text with charts, tables, and at least one scanned/image-only page.
- 2-3 DOCX/PPTX files with embedded screenshots or pasted charts.
- A handful of standalone screenshots/photos.
- At least one ZIP bundling a realistic mixed upload.
- Ground truth for each: 4-8 specific, checkable facts (a number, a label, a named entity) that a correct read of the file would surface.

## Once real numbers exist

This section should be replaced with the actual `reports/comparison-report.md` content (or a link/summary of it) plus the concrete recommendation it produced, backed by the run's JSON data in `reports/comparison-report.json`. Until then, treat "which model is better for our use case" as **open**, not defaulted to either provider.
