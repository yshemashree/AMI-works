import { Readable } from 'node:stream';

/**
 * Stand-in for the googleapis Drive v3 client, in the same spirit as
 * MockModelClient: records every call and replays canned responses so the
 * ingestion modules can be exercised without credentials or network
 * access. Implements only the three methods driveReader/driveUploader
 * actually call.
 *
 * `pages` is a list of file-listing pages; the page token is just the
 * next index as a string.
 */
export class MockDriveClient {
  constructor({ pages = [], contents = {}, uploadResult, failWith } = {}) {
    this.pages = pages;
    this.contents = contents;
    this.uploadResult = uploadResult || {
      id: 'created-file-id',
      name: 'uploaded',
      webViewLink: 'https://drive.example/created-file-id',
    };
    this.failWith = failWith;
    this.calls = { list: [], get: [], create: [] };
    this.uploadedBytes = null;

    this.files = {
      list: (params) => this.listFiles(params),
      get: (params, options) => this.getFile(params, options),
      create: (params) => this.createFile(params),
    };
  }

  async listFiles(params) {
    this.calls.list.push(params);
    this.maybeFail();

    const index = params.pageToken ? Number(params.pageToken) : 0;
    const files = this.pages[index] || [];
    const nextPageToken = index + 1 < this.pages.length ? String(index + 1) : undefined;
    return { data: { files, nextPageToken } };
  }

  async getFile(params, options) {
    this.calls.get.push(params);
    this.maybeFail();

    const body = this.contents[params.fileId] ?? `contents of ${params.fileId}`;
    const data = options?.responseType === 'stream' ? Readable.from([Buffer.from(body)]) : body;
    return { data };
  }

  async createFile(params) {
    this.calls.create.push(params);
    this.maybeFail();

    // Drain the upload stream so tests can assert on what was sent.
    if (params.media?.body) {
      this.uploadedBytes = await readAll(params.media.body);
    }
    return { data: this.uploadResult };
  }

  maybeFail() {
    if (this.failWith) throw this.failWith;
  }
}

/**
 * Shape of the error googleapis throws: an HTTP-ish error that also holds
 * a reference to the auth client. Used to check we never re-expose it.
 */
export function fakeDriveApiError({ message = 'Rate limit exceeded', status = 429 } = {}) {
  const error = new Error(message);
  error.status = status;
  error.errors = [{ message }];
  error.config = { auth: { key: 'PRIVATE KEY MATERIAL' } };
  return error;
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
