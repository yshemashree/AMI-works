// Typed errors so callers (CLI, tests, comparison engine) can branch on
// failure kind instead of parsing message strings.

export class AmiError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code || 'AMI_ERROR';
    if (cause) this.cause = cause;
  }
}

export class UnsupportedFileTypeError extends AmiError {
  constructor(filePath, extension) {
    super(`Unsupported file type "${extension}" for ${filePath}`, {
      code: 'UNSUPPORTED_FILE_TYPE',
    });
    this.filePath = filePath;
    this.extension = extension;
  }
}

export class ExtractionError extends AmiError {
  constructor(filePath, cause) {
    super(`Failed to extract content from ${filePath}: ${cause?.message || cause}`, {
      code: 'EXTRACTION_FAILED',
      cause,
    });
    this.filePath = filePath;
  }
}

export class ModelRequestError extends AmiError {
  constructor(provider, cause, { status } = {}) {
    super(`${provider} request failed: ${cause?.message || cause}`, {
      code: 'MODEL_REQUEST_FAILED',
      cause,
    });
    this.provider = provider;
    this.status = status;
  }
}

export class MissingCredentialsError extends AmiError {
  constructor(provider, envVar) {
    super(`Missing credentials for ${provider}: set ${envVar} in your .env file`, {
      code: 'MISSING_CREDENTIALS',
    });
    this.provider = provider;
    this.envVar = envVar;
  }
}
