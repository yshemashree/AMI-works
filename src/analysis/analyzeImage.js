import { buildImagePrompt, buildDocumentPrompt } from './promptTemplates.js';
import { parseModelJson } from './responseParser.js';

/**
 * Sends one image to a model client and returns a normalized analysis
 * record. Used both for standalone images and for each page/slide/
 * embedded image pulled out of a document.
 */
export async function analyzeImage(client, image, { context, fileName, pageLabel, surroundingText } = {}) {
  // pageLabel is only set for a rendered document page (see
  // analyzeDocument.js) - that's the signal to use the page-aware prompt
  // instead of the generic standalone-image prompt.
  const prompt = pageLabel
    ? buildDocumentPrompt({ fileName, pageLabel, surroundingText })
    : buildImagePrompt({ context });

  const response = await client.analyze({
    prompt,
    images: [{ base64: image.base64, mimeType: image.mimeType }],
  });

  const parsed = parseModelJson(response.text);

  return {
    label: image.label,
    provider: response.provider,
    model: response.model,
    latencyMs: response.latencyMs,
    usage: response.usage,
    parsed: parsed.ok,
    result: parsed.data,
    rawText: response.text,
  };
}
