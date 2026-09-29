import 'dotenv/config';
import path from 'node:path';

// Central place for reading environment configuration so no other module
// touches process.env directly - keeps API keys out of logs/errors and
// makes it obvious which settings exist.
function toInt(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

const MB = 1024 * 1024;

export const config = {
  // Model providers. Only the analysis commands need these - reading a
  // file into JSON never calls a model, so an empty key is fine there.
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-5',
  },
  qwen: {
    apiKey: process.env.DASHSCOPE_API_KEY || '',
    model: process.env.QWEN_MODEL || 'qwen-vl-max',
    baseUrl: process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1',
  },
  drive: {
    keyPath: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || '',
    folderId: process.env.DRIVE_FOLDER_ID || '',
    oauth: {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
      tokenPath: process.env.GOOGLE_OAUTH_TOKEN_PATH || '.drive-oauth-token.json',
    },
  },
  reader: {
    // Below this size a file is fetched in one request straight into a
    // preallocated Buffer. Above it, ZIP-based files and PDFs are read
    // with byte-range requests so only the parts we parse get fetched.
    rangeThresholdBytes: toInt(process.env.RANGE_THRESHOLD_MB, 32) * MB,
    // Hard ceiling for anything that has to sit fully in memory (images,
    // spreadsheets, text files, small PDFs).
    maxInMemoryBytes: toInt(process.env.MAX_IN_MEMORY_MB, 200) * MB,
    // Total bytes all in-flight files may hold at once when a folder is
    // processed in parallel. Keeps RAM flat no matter how big the folder is.
    memoryBudgetBytes: toInt(process.env.MEMORY_BUDGET_MB, 512) * MB,
    concurrency: toInt(process.env.READ_CONCURRENCY, 3),
    pythonBin: process.env.AMI_PYTHON_BIN || 'python3',
    markitdown: (process.env.MARKITDOWN || 'auto').toLowerCase(), // auto | off
  },
  cache: {
    // Extracted JSON keyed by the file's content hash. Empty = memory only.
    dir: process.env.CACHE_DIR ? path.resolve(process.env.CACHE_DIR) : '',
    maxEntries: toInt(process.env.CACHE_MAX_ENTRIES, 500),
  },
  server: {
    host: process.env.GUI_HOST || '127.0.0.1',
    port: toInt(process.env.GUI_PORT, 4300),
    accessKey: process.env.GUI_ACCESS_KEY || '',
    maxUploadBytes: toInt(process.env.MAX_UPLOAD_MB, 1024) * MB,
  },
  maxImageDimension: toInt(process.env.MAX_IMAGE_DIMENSION, 2000),
};

export function hasClaudeCredentials() {
  return Boolean(config.anthropic.apiKey);
}

export function hasQwenCredentials() {
  return Boolean(config.qwen.apiKey);
}
