import { ClaudeClient } from './claudeClient.js';
import { QwenClient } from './qwenClient.js';
import { AmiError } from '../utils/errors.js';

const PROVIDERS = {
  claude: ClaudeClient,
  qwen: QwenClient,
};

export function createModelClient(provider) {
  const Client = PROVIDERS[provider];
  if (!Client) {
    throw new AmiError(`Unknown model provider "${provider}". Expected one of: ${Object.keys(PROVIDERS).join(', ')}`, {
      code: 'UNKNOWN_PROVIDER',
    });
  }
  return new Client();
}

export { ClaudeClient, QwenClient };
