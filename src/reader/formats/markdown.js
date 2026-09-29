import { formatBytes } from '../sources.js';

/**
 * Runs a file through the MarkItDown converter if one was handed to the
 * reader and it's up. Returns markdown, or null so the caller falls back
 * to its pure-JS path. Never throws: a converter problem becomes a
 * warning in the JSON, not a failed read.
 *
 * `getBytes` is lazy on purpose - for large Office files it builds a
 * slimmed package, which we don't want to pay for when the converter is
 * off anyway.
 */
export async function convertWithMarkItDown(ctx, name, getBytes, doc) {
  const converter = ctx.converter;
  if (!converter || !(await converter.isAvailable())) return null;

  let bytes;
  let result;
  try {
    bytes = await getBytes();
    result = await converter.convert({ name, bytes });
  } catch (error) {
    result = { success: false, error: error.message };
  }
  if (result.success) {
    doc.engine.markdown = converter.label;
    if (result.truncated) doc.warnings.push(`Markdown truncated (${formatBytes(bytes?.length)} input).`);
    for (const warning of result.warnings || []) doc.warnings.push(`markitdown: ${warning}`);
    return result.markdown;
  }
  doc.warnings.push(`MarkItDown could not convert this file (${result.error}); used the built-in reader instead.`);
  return null;
}
