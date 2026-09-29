// MarkItDown component: Microsoft's MarkItDown, run as one long-lived
// Python worker and fed file bytes over stdin. Optional - the reader
// works without it and uses it, when present, for richer markdown
// (headings, lists, tables) from DOCX/PPTX/XLSX/CSV/HTML.
import { config } from '../config.js';
import { MarkItDownClient } from './client.js';

let shared = null;

/** The process-wide worker, or null when MARKITDOWN=off. */
export function getMarkItDown() {
  if (config.reader.markitdown === 'off') return null;
  shared ??= new MarkItDownClient({ pythonBin: config.reader.pythonBin });
  return shared;
}

export function closeMarkItDown() {
  shared?.close();
}

export { MarkItDownClient };
