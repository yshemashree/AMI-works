import { BaseModelClient } from './baseModelClient.js';
import { config, hasQwenCredentials } from '../config.js';
import { MissingCredentialsError, ModelRequestError } from '../utils/errors.js';
import { withRetry } from '../utils/retry.js';

/**
 * Client for Alibaba DashScope's Qwen-VL multimodal generation API.
 * https://help.aliyun.com/zh/dashscope/developer-reference/vl-plus-quick-start
 */
export class QwenClient extends BaseModelClient {
  constructor() {
    super();
    if (!hasQwenCredentials()) {
      throw new MissingCredentialsError('Qwen', 'DASHSCOPE_API_KEY');
    }
    this.apiKey = config.qwen.apiKey;
    this.model = config.qwen.model;
    this.endpoint = `${config.qwen.baseUrl}/services/aigc/multimodal-generation/generation`;
  }

  /** @param {import('./baseModelClient.js').ModelInput} input */
  async analyze({ prompt, images = [] }) {
    const content = [
      ...images.map((img) => ({ image: `data:${img.mimeType};base64,${img.base64}` })),
      { text: prompt },
    ];

    const body = {
      model: this.model,
      input: { messages: [{ role: 'user', content }] },
      parameters: { result_format: 'message' },
    };

    const start = Date.now();
    try {
      const response = await withRetry(() => this.request(body));
      const latencyMs = Date.now() - start;
      const message = response?.output?.choices?.[0]?.message;
      const text = extractText(message?.content);

      return {
        provider: 'qwen',
        model: this.model,
        text,
        latencyMs,
        usage: {
          inputTokens: response?.usage?.input_tokens ?? null,
          outputTokens: response?.usage?.output_tokens ?? null,
        },
        raw: response,
      };
    } catch (cause) {
      throw new ModelRequestError('Qwen', cause, { status: cause?.status });
    }
  }

  async request(body) {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const error = new Error(json?.message || `DashScope request failed with status ${res.status}`);
      error.status = res.status;
      error.code = json?.code;
      throw error;
    }
    return json;
  }
}

// DashScope's "message" result format returns content as an array of
// typed parts (mirroring Claude's block shape); join the text parts.
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}
