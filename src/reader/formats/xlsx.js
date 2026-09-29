import { openPackage, readProperties, readRels, readChart, decodeXml } from '../office.js';
import { markdownToText } from '../document.js';
import { convertWithMarkItDown } from './markdown.js';
import { AmiError, ExtractionError } from '../../utils/errors.js';

const MAX_ROWS_PER_SHEET = 5000;

/**
 * XLSX -> one section per sheet (as a markdown table), native charts,
 * and MarkItDown's markdown when available. The built-in path reads the
 * sheet XML directly, so spreadsheets work even without Python.
 *
 * Legacy .xls is a binary format with no built-in reader; it only works
 * through MarkItDown.
 */
export async function readSpreadsheet(source, doc, ctx) {
  if (doc.source.type === 'xls') return readLegacyXls(source, doc, ctx);

  let pkg;
  try {
    pkg = await openPackage(source, ctx);
  } catch (cause) {
    throw new ExtractionError(source.name, cause);
  }
  const { zip, strategy } = pkg;
  doc.engine.strategy = strategy;
  doc.engine.reader = 'xlsx-xml';

  try {
    doc.metadata = await readProperties(zip);
    const shared = sharedStrings(await zip.readText('xl/sharedStrings.xml'));
    const workbookRels = await readRels(zip, 'xl/workbook.xml');
    const workbook = (await zip.readText('xl/workbook.xml')) || '';

    let number = 0;
    for (const [tag] of workbook.matchAll(/<sheet\b[^>]*\/?>/g)) {
      number++;
      const name = decodeXml(tag.match(/\bname="([^"]*)"/)?.[1] ?? `Sheet${number}`);
      const relId = tag.match(/\br:id="([^"]*)"/)?.[1];
      const part = workbookRels.get(relId)?.target;
      const xml = part ? await zip.readText(part) : null;
      const { rows, truncated } = sheetRows(xml, shared);
      if (truncated) doc.warnings.push(`Sheet "${name}" cut at ${MAX_ROWS_PER_SHEET} rows.`);

      doc.sections.push({
        kind: 'sheet',
        number,
        title: name,
        rows: rows.length,
        columns: Math.max(0, ...rows.map((r) => r.length)),
        text: toMarkdownTable(rows),
        needsVision: false,
        visionReason: 'tabular data',
      });

      if (part) {
        for (const rel of (await readRels(zip, part)).values()) {
          if (rel.type !== 'drawing') continue;
          for (const drawingRel of (await readRels(zip, rel.target)).values()) {
            if (drawingRel.type !== 'chart') continue;
            const chart = await readChart(zip, drawingRel.target);
            if (chart) doc.charts.push({ id: `chart-${doc.charts.length + 1}`, sheet: name, ...chart });
          }
        }
      }
    }
    doc.stats.sheets = number;

    const markdown = await convertWithMarkItDown(ctx, source.name, () => pkg.buffer ?? source.readAll({ maxBytes: ctx.maxInMemoryBytes }), doc);
    doc.markdown = markdown || doc.sections.map((s) => `## ${s.title}\n\n${s.text}`).join('\n\n');
    doc.text = markdownToText(doc.markdown);
    return [];
  } finally {
    zip.close();
  }
}

async function readLegacyXls(source, doc, ctx) {
  const markdown = await convertWithMarkItDown(ctx, source.name, () => source.readAll({ maxBytes: ctx.maxInMemoryBytes }), doc);
  if (!markdown) {
    throw new AmiError(
      `${source.name}: legacy .xls needs the MarkItDown worker (pip install -r src/markitdown/requirements.txt), or re-save it as .xlsx.`,
      { code: 'NEEDS_MARKITDOWN' },
    );
  }
  doc.engine.reader = 'markitdown';
  doc.markdown = markdown;
  doc.text = markdownToText(markdown);
  doc.sections.push({ kind: 'body', number: 1, text: doc.text, needsVision: false, visionReason: 'tabular data' });
  return [];
}

function sharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, si]) =>
    decodeXml([...si.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]).join('')),
  );
}

function sheetRows(xml, shared) {
  const rows = [];
  if (!xml) return { rows, truncated: false };

  let truncated = false;
  for (const [, rowXml] of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= MAX_ROWS_PER_SHEET) {
      truncated = true;
      break;
    }
    const row = [];
    for (const [, attrs, body = ''] of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
      const type = attrs.match(/\bt="([^"]*)"/)?.[1];
      const raw = body.match(/<v>([^<]*)<\/v>/)?.[1];
      let value;
      if (type === 's') value = shared[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = decodeXml((body.match(/<t[^>]*>([^<]*)<\/t>/) || [])[1] ?? '');
      else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
      else value = raw != null ? decodeXml(raw) : '';
      row[ref ? columnIndex(ref) : row.length] = value;
    }
    rows.push(Array.from(row, (v) => v ?? ''));
  }
  return { rows, truncated };
}

function columnIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function toMarkdownTable(rows) {
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => cell(r[i])).join(' | ')} |`;
  return [line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}
