import path from 'node:path';
import { markdownToText } from '../document.js';
import { convertWithMarkItDown } from './markdown.js';
import { toMarkdownTable } from './xlsx.js';

/**
 * Plain-text family: TXT, MD, CSV/TSV, JSON, XML, HTML. MarkItDown turns
 * CSV and HTML into proper markdown; without it we still do a decent job
 * in JS (CSV -> table, HTML -> stripped text, JSON -> pretty printed).
 */
export async function readText(source, doc, ctx) {
  const bytes = await source.readAll({ maxBytes: ctx.maxInMemoryBytes });
  doc.engine.strategy = 'buffer';

  const ext = path.extname(source.name).toLowerCase();
  const plainMarkdown = ext === '.txt' || ext === '.md';
  const markdown = plainMarkdown ? null : await convertWithMarkItDown(ctx, source.name, () => bytes, doc);

  if (markdown) {
    doc.engine.reader = 'markitdown';
    doc.markdown = markdown;
    doc.text = markdownToText(markdown);
  } else {
    doc.engine.reader = 'text';
    const raw = decode(bytes);
    const { text, markdown: md } = fallback(ext, raw, doc);
    doc.text = text;
    doc.markdown = md;
  }

  doc.sections.push({ kind: 'body', number: 1, text: doc.text, needsVision: false, visionReason: 'text file' });
  return [];
}

function decode(bytes) {
  // Strip a UTF-8 BOM, and read UTF-16 when a BOM says so (Excel's
  // "Unicode text" export does this).
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8');
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  return bytes.toString('utf8');
}

function fallback(ext, raw, doc) {
  switch (ext) {
    case '.csv':
    case '.tsv': {
      const table = toMarkdownTable(parseDelimited(raw, ext === '.tsv' ? '\t' : ','));
      return { text: markdownToText(table), markdown: table };
    }
    case '.json':
      try {
        const pretty = JSON.stringify(JSON.parse(raw), null, 2);
        return { text: pretty, markdown: '```json\n' + pretty + '\n```' };
      } catch {
        doc.warnings.push('File has a .json extension but is not valid JSON.');
        return { text: raw, markdown: null };
      }
    case '.html':
    case '.htm':
    case '.xml': {
      const text = raw
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|h\d|table|ul|ol|section|article)>/gi, '\n\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return { text, markdown: null };
    }
    case '.md':
      return { text: markdownToText(raw), markdown: raw };
    default:
      return { text: raw.trim(), markdown: null };
  }
}

// Small RFC 4180 parser: quoted fields, doubled quotes, newlines inside quotes.
export function parseDelimited(input, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
