// Models sometimes wrap the requested JSON in ```json fences or add a
// leading/trailing sentence despite instructions not to. Parse
// defensively and always return a usable object rather than throwing,
// since a malformed response from one model shouldn't crash a batch run.
export function parseModelJson(rawText) {
  const candidate = extractJsonCandidate(rawText);
  if (candidate) {
    try {
      return { ok: true, data: JSON.parse(candidate), rawText };
    } catch {
      // fall through to the unparsed fallback below
    }
  }
  return {
    ok: false,
    data: emptyShape(rawText),
    rawText,
  };
}

function extractJsonCandidate(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start, end + 1);
  }
  return null;
}

function emptyShape(rawText) {
  return {
    summary: '',
    extracted_text: '',
    visual_elements: [],
    tables: [],
    key_entities: [],
    confidence: 'low',
    notes: `Response could not be parsed as JSON. Raw text preserved separately.`,
    _unparsed: rawText,
  };
}
