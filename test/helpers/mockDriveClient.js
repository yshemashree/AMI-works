import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

/**
 * Stand-in for the googleapis Drive v3 client, in the same spirit as
 * MockModelClient: records every call and replays canned responses so the
 * Drive component can be exercised without credentials or network access.
 * Implements only what src/drive actually calls: files.list / get /
 * export / create, including Range requests on get.
 *
 * `pages` is a list of file-listing pages; the page token is just the
 * next index as a string. `contents` maps file id -> string | Buffer.
 */
export class MockDriveClient {
  constructor({ pages = [], contents = {}, uploadResult, failWith, chunkSize = 64 * 1024 } = {}) {
    this.pages = pages;
    this.contents = contents;
    this.uploadResult = uploadResult;
    this.failWith = failWith;
    this.chunkSize = chunkSize;
    this.calls = { list: [], get: [], export: [], create: [] };
    this.uploadedBytes = null;

    this.files = {
      list: (params) => this.listFiles(params),
      get: (params, options) => this.getFile(params, options),
      export: (params, options) => this.exportFile(params, options),
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

  async getFile(params, options = {}) {
    this.calls.get.push({ ...params, headers: options.headers });
    this.maybeFail();

    if (params.alt !== 'media') {
      const meta = this.pages.flat().find((f) => f.id === params.fileId);
      return { data: meta };
    }

    let body = this.bytesOf(params.fileId);
    let status = 200;
    const range = /bytes=(\d+)-(\d+)/.exec(options.headers?.Range || '');
    if (range) {
      body = body.subarray(Number(range[1]), Number(range[2]) + 1);
      status = 206;
    }
    return { status, data: this.asStream(body) };
  }

  async exportFile(params) {
    this.calls.export.push(params);
    this.maybeFail();
    return { status: 200, data: this.asStream(this.bytesOf(params.fileId)) };
  }

  async createFile(params) {
    this.calls.create.push(params);
    this.maybeFail();

    // Drain the upload stream, like the real client does while sending.
    if (params.media?.body) {
      this.uploadedBytes = await readAll(params.media.body);
    }
    const bytes = this.uploadedBytes || Buffer.alloc(0);
    return {
      data: this.uploadResult || {
        id: 'created-file-id',
        name: params.requestBody.name,
        mimeType: params.media?.mimeType || 'application/octet-stream',
        size: String(bytes.length),
        md5Checksum: createHash('md5').update(bytes).digest('hex'),
        webViewLink: 'https://drive.example/created-file-id',
      },
    };
  }

  bytesOf(id) {
    const value = this.contents[id] ?? `contents of ${id}`;
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
  }

  asStream(buffer) {
    const chunks = [];
    for (let i = 0; i < buffer.length; i += this.chunkSize) chunks.push(buffer.subarray(i, i + this.chunkSize));
    return Readable.from(chunks.length ? chunks : [Buffer.alloc(0)]);
  }

  maybeFail() {
    if (this.failWith) throw this.failWith;
  }
}

/** Builds a listing entry for a buffer, with the size/md5 Drive would report. */
export function driveFile(id, name, bytes, mimeType = 'application/octet-stream') {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return {
    id,
    name,
    mimeType,
    size: String(buffer.length),
    md5Checksum: createHash('md5').update(buffer).digest('hex'),
    modifiedTime: '2026-09-20T10:00:00.000Z',
  };
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
