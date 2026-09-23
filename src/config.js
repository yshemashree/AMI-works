import 'dotenv/config';
import path from 'node:path';

// Central place for reading environment configuration so no other module
// touches process.env directly - keeps API keys out of logs/errors and
// makes it obvious which settings exist.
function toInt(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
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
  maxImageDimension: toInt(process.env.MAX_IMAGE_DIMENSION, 2000),
  workDir: path.resolve(process.env.WORK_DIR || '.tmp'),
};

export function hasClaudeCredentials() {
  return Boolean(config.anthropic.apiKey);
}

export function hasQwenCredentials() {
  return Boolean(config.qwen.apiKey);
}
