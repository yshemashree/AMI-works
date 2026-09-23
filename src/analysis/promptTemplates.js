// Prompts ask for a fixed JSON shape so responses from different models
// (and different pages/images of the same document) can be diffed and
// scored consistently by the comparison engine. Models occasionally wrap
// JSON in prose despite instructions - responseParser.js handles that.

const JSON_SHAPE = `{
  "summary": string,                // one paragraph describing the overall content
  "extracted_text": string,         // all readable text, verbatim, including text inside images/screenshots
  "visual_elements": [              // every chart, diagram, table, photo, screenshot, logo, icon present
    {
      "type": string,               // "chart" | "diagram" | "table" | "photo" | "screenshot" | "other"
      "description": string,        // what it shows
      "data_extracted": string      // key values/labels/numbers read from it, or "" if none
    }
  ],
  "tables": [                       // structured re-transcription of any tabular data, [] if none
    { "title": string, "headers": [string], "rows": [[string]] }
  ],
  "key_entities": [string],         // names, dates, numbers, products, orgs worth flagging
  "confidence": "high" | "medium" | "low",
  "notes": string                   // anything ambiguous, unreadable, or worth a human double-checking
}`;

export function buildImagePrompt({ context } = {}) {
  return `You are analyzing an image as part of a document/image understanding pipeline.
Examine it carefully, including any text, charts, diagrams, tables, screenshots, photos, icons, or handwriting.
${context ? `Context: ${context}\n` : ''}
Respond with ONLY a single JSON object matching exactly this shape (no markdown fences, no commentary before or after):
${JSON_SHAPE}`;
}

export function buildDocumentPrompt({ fileName, pageLabel, surroundingText }) {
  return `You are analyzing one page/slide of a document ("${fileName}"${pageLabel ? `, ${pageLabel}` : ''}) as part of a document understanding pipeline.
The image is a rendering of this page/slide. Analyze BOTH the text and every visual element: charts, diagrams, tables, screenshots, photos, and icons. Do not only summarize text - describe and extract data from visuals too.
${surroundingText ? `Text layer extracted separately from this page (may be incomplete or out of order, use only as a hint): """${surroundingText.slice(0, 4000)}"""\n` : ''}
Respond with ONLY a single JSON object matching exactly this shape (no markdown fences, no commentary before or after):
${JSON_SHAPE}`;
}
