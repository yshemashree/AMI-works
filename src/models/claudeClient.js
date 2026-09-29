import { BaseModelClient } from './baseModelClient.js';
import { config, hasClaudeCredentials } from '../config.js';
import { MissingCredentialsError, ModelRequestError } from '../utils/errors.js';
import { withRetry } from '../utils/retry.js';

const MAX_OUTPUT_TOKENS = 4096;

// The SDK is only loaded when an analysis actually runs. Reading files
// into JSON never needs it, so it shouldn't cost startup time there.
let sdkPromise;
function loadSdk() {
  sdkPromise ??= import('@anthropic-ai/sdk').then((m) => m.default);
  return sdkPromise;
}

export class ClaudeClient extends BaseModelClient {
  constructor() {
    super();
    if (!hasClaudeCredentials()) {
      throw new MissingCredentialsError('Claude', 'ANTHROPIC_API_KEY');
    }
    this.client = null;
    this.model = config.anthropic.model;
  }

  async sdk() {
    if (!this.client) {
      const Anthropic = await loadSdk();
      this.client = new Anthropic({ apiKey: config.anthropic.apiKey });
    }
    return this.client;
  }

  /** @param {import('./baseModelClient.js').ModelInput} input */
  async analyze({ prompt, images = [] }) {
    const content = [
      ...images.map((img) => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mimeType, data: img.base64 },
      })),
      { type: 'text', text: prompt },
    ];

    const start = Date.now();
    try {
      const client = await this.sdk();
      const response = await withRetry(() =>
        client.messages.create({
          model: this.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          messages: [{ role: 'user', content }],
        }),
      );
      const latencyMs = Date.now() - start;
      const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      return {
        provider: 'claude',
        model: response.model,
        text,
        latencyMs,
        usage: {
          inputTokens: response.usage?.input_tokens ?? null,
          outputTokens: response.usage?.output_tokens ?? null,
        },
        raw: response,
      };
    } catch (cause) {
      throw new ModelRequestError('Claude', cause, { status: cause?.status });
    }
  }
}
