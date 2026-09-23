/**
 * Shared response shape every model client normalizes to, so the
 * analysis and comparison layers never branch on which provider answered.
 *
 * @typedef {Object} ModelResponse
 * @property {string} provider      - "claude" | "qwen"
 * @property {string} model         - model id actually used
 * @property {string} text          - the model's raw text reply
 * @property {number} latencyMs     - wall-clock time for the request
 * @property {{inputTokens: number|null, outputTokens: number|null}} usage
 * @property {unknown} raw          - untouched provider response, kept for debugging
 */

/**
 * @typedef {Object} ModelInput
 * @property {string} prompt
 * @property {{base64: string, mimeType: string}[]} [images]
 */

export class BaseModelClient {
  /** @returns {Promise<ModelResponse>} */
  // eslint-disable-next-line no-unused-vars
  async analyze(input) {
    throw new Error('analyze() must be implemented by subclass');
  }
}
