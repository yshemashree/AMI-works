import { BaseModelClient } from '../../src/models/baseModelClient.js';

/**
 * Deterministic stand-in for ClaudeClient/QwenClient used by tests so the
 * analysis/comparison pipeline can be exercised without real API keys or
 * network access. Accepts either a fixed response object/JSON string, or
 * a function of the call index for tests that need varying responses.
 */
export class MockModelClient extends BaseModelClient {
  constructor({ provider = 'mock', responses } = {}) {
    super();
    this.provider = provider;
    this.responses = responses;
    this.callCount = 0;
    this.calls = [];
  }

  async analyze(input) {
    this.calls.push(input);
    const index = this.callCount++;
    const responseSource = Array.isArray(this.responses) ? this.responses[index] : this.responses;
    const payload = typeof responseSource === 'function' ? responseSource(index, input) : responseSource;
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);

    return {
      provider: this.provider,
      model: `${this.provider}-mock`,
      text,
      latencyMs: 1,
      usage: { inputTokens: 10, outputTokens: 10 },
      raw: { mock: true },
    };
  }
}

export function sampleAnalysisJson(overrides = {}) {
  return {
    summary: 'A mock summary.',
    extracted_text: 'mock extracted text with some words',
    visual_elements: [{ type: 'chart', description: 'a bar chart', data_extracted: 'A=1, B=2' }],
    tables: [],
    key_entities: ['Acme Corp'],
    confidence: 'high',
    notes: '',
    ...overrides,
  };
}
