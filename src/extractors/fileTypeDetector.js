import path from 'node:path';

// Formats supported end-to-end. Detection is extension-based (the primary
// signal for uploaded files) with a magic-byte fallback for images, since
// extensions can be wrong or missing.
export const SUPPORTED_CATEGORIES = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'],
  pdf: ['.pdf'],
  docx: ['.docx', '.doc'],
  pptx: ['.pptx', '.ppt'],
};

const EXT_TO_CATEGORY = Object.entries(SUPPORTED_CATEGORIES).reduce((map, [category, exts]) => {
  for (const ext of exts) map[ext] = category;
  return map;
}, {});

// Legacy binary formats (.doc/.ppt, pre-2007) use a different container
// format than the ZIP-based .docx/.pptx and are not parseable by the
// extractors below. Detected separately so callers can surface a clear
// "convert to .docx/.pptx" error instead of a confusing parse failure.
const LEGACY_OFFICE_EXTENSIONS = new Set(['.doc', '.ppt']);

const MAGIC_BYTES = [
  { category: 'image', bytes: [0x89, 0x50, 0x4e, 0x47], name: 'PNG' }, // \x89PNG
  { category: 'image', bytes: [0xff, 0xd8, 0xff], name: 'JPEG' },
  { category: 'image', bytes: [0x47, 0x49, 0x46, 0x38], name: 'GIF' },
  { category: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46], name: 'PDF' }, // %PDF
];

export function detectCategory(filePath, buffer) {
  const ext = path.extname(filePath).toLowerCase();
  if (LEGACY_OFFICE_EXTENSIONS.has(ext)) {
    return { category: null, extension: ext, legacyOffice: true };
  }
  if (EXT_TO_CATEGORY[ext]) {
    return { category: EXT_TO_CATEGORY[ext], extension: ext, legacyOffice: false };
  }

  if (buffer) {
    for (const magic of MAGIC_BYTES) {
      if (matchesMagic(buffer, magic.bytes)) {
        return { category: magic.category, extension: ext, legacyOffice: false, sniffedAs: magic.name };
      }
    }
  }

  return { category: null, extension: ext, legacyOffice: false };
}

function matchesMagic(buffer, signature) {
  if (buffer.length < signature.length) return false;
  return signature.every((byte, i) => buffer[i] === byte);
}

export function isSupportedExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return Boolean(EXT_TO_CATEGORY[ext]) || LEGACY_OFFICE_EXTENSIONS.has(ext);
}
