// Shared retry helper for model API calls. Vision API calls are the most
// failure-prone step in the pipeline (rate limits, transient 5xx), and
// the spec prioritizes reliability - a single dropped request shouldn't
// take down a whole ZIP batch.
export async function withRetry(fn, { retries = 3, baseDelayMs = 1000, isRetryable = defaultIsRetryable } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === retries || !isRetryable(error)) throw error;
      const delay = baseDelayMs * 2 ** attempt;
      await sleep(delay);
    }
  }
  throw lastError;
}

function defaultIsRetryable(error) {
  const status = error?.status ?? error?.statusCode;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  // Network-level failures (no HTTP status) are worth one retry too.
  if (!status && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(error?.code)) return true;
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
