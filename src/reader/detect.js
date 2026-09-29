import path from 'node:path';

// Extension first (it's what uploads and Drive give us), magic bytes as
// the fallback when the extension is missing or wrong.
//
// "markitdown" means the format is only readable through the MarkItDown
// worker (src/markitdown). Everything else has a pure-JS reader and
// MarkItDown is only an upgrade (headings and tables kept as markdown).
export const FORMATS = {
  image: { extensions: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'] },
  pdf: { extensions: ['.pdf'] },
  docx: { extensions: ['.docx'] },
  pptx: { extensions: ['.pptx'] },
  xlsx: { extensions: ['.xlsx'] },
  xls: { extensions: ['.xls'], markitdownOnly: true },
  zip: { extensions: ['.zip'] },
  text: { extensions: ['.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.html', '.htm'] },
};

const EXT_TO_TYPE = Object.entries(FORMATS).reduce((map, [type, { extensions }]) => {
  for (const ext of extensions) map[ext] = type;
  return map;
}, {});

// Pre-2007 binary Office files are a different container altogether.
// Detected on purpose so the caller can say "re-save as .docx/.pptx"
// instead of failing with a confusing parse error.
const LEGACY_OFFICE_EXTENSIONS = new Set(['.doc', '.ppt']);

const MAGIC_BYTES = [
  { type: 'image', bytes: [0x89, 0x50, 0x4e, 0x47], name: 'PNG' },
  { type: 'image', bytes: [0xff, 0xd8, 0xff], name: 'JPEG' },
  { type: 'image', bytes: [0x47, 0x49, 0x46, 0x38], name: 'GIF' },
  { type: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46], name: 'PDF' },
  { type: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04], name: 'ZIP' },
];

// Mime types Drive and browsers report, for files that arrive without a
// usable extension.
const MIME_TO_TYPE = {
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'text',
  'text/csv': 'text',
  'text/html': 'text',
  'application/json': 'text',
};

/**
 * @returns {{ type: string|null, extension: string, legacyOffice: boolean, sniffedAs?: string }}
 */
export function detectType(name, { head, mimeType } = {}) {
  const extension = path.extname(name || '').toLowerCase();
  if (LEGACY_OFFICE_EXTENSIONS.has(extension)) {
    return { type: null, extension, legacyOffice: true };
  }
  if (EXT_TO_TYPE[extension]) {
    return { type: EXT_TO_TYPE[extension], extension, legacyOffice: false };
  }

  const baseMime = (mimeType || '').split(';')[0].trim().toLowerCase();
  if (MIME_TO_TYPE[baseMime]) {
    return { type: MIME_TO_TYPE[baseMime], extension, legacyOffice: false };
  }
  if (baseMime.startsWith('image/')) {
    return { type: 'image', extension, legacyOffice: false };
  }

  if (head) {
    for (const magic of MAGIC_BYTES) {
      if (matchesMagic(head, magic.bytes)) {
        return { type: magic.type, extension, legacyOffice: false, sniffedAs: magic.name };
      }
    }
  }

  return { type: null, extension, legacyOffice: false };
}

function matchesMagic(buffer, signature) {
  if (buffer.length < signature.length) return false;
  return signature.every((byte, i) => buffer[i] === byte);
}

/** True for any extension the reader knows about, including legacy Office. */
export function isSupportedName(name) {
  const ext = path.extname(name || '').toLowerCase();
  return Boolean(EXT_TO_TYPE[ext]) || LEGACY_OFFICE_EXTENSIONS.has(ext);
}

export function needsMarkItDown(type) {
  return Boolean(FORMATS[type]?.markitdownOnly);
}
