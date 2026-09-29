// GUI component: a small HTTP server and a browser UI for uploading to
// Drive and reading files into JSON. It only talks to the pipeline; it
// doesn't know how Drive or any file format works.
import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import busboy from 'busboy';
import { config } from '../config.js';
import { AmiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const MAX_FILES_PER_REQUEST = 20;
const OAUTH_STATE_TTL_MS = 10 * 60_000;

/**
 * @param {Object} deps
 * @param {ReturnType<import('../pipeline/index.js').createPipeline>} deps.pipeline
 * @param {Object} deps.auth   { status(), buildAuthUrl(uri, state), completeLogin(code, uri), signOut() }
 */
export function createServer({
  pipeline,
  auth,
  defaultFolderId = config.drive.folderId,
  accessKey = config.server.accessKey,
  maxUploadBytes = config.server.maxUploadBytes,
  stateSecret = config.drive.oauth.clientSecret || randomBytes(32).toString('hex'),
} = {}) {
  // The OAuth `state` is signed rather than remembered, so it still checks
  // out after a server restart or when the browser loads the callback
  // twice. Only this server can make one (it needs the secret), which is
  // all the CSRF protection `state` is for; the code itself is one-use at
  // Google's end.
  const sign = (value) => createHmac('sha256', stateSecret).update(value).digest('base64url');
  const newState = () => {
    const body = `${Date.now().toString(36)}.${randomBytes(9).toString('base64url')}`;
    return `${body}.${sign(body)}`;
  };
  const stateProblem = (state) => {
    const [issued, nonce, mac] = String(state || '').split('.');
    if (!mac || !safeEqual(mac, sign(`${issued}.${nonce}`))) return 'that sign-in link did not come from this app';
    if (Date.now() - parseInt(issued, 36) > OAUTH_STATE_TTL_MS) return 'the sign-in link expired';
    return null;
  };

  const routes = {
    'GET /api/status': async () => ({
      drive: await auth.status(),
      markitdown: pipeline.converter
        ? { available: await pipeline.converter.isAvailable(), label: pipeline.converter.label }
        : { available: false, label: 'off' },
      defaults: { folderId: defaultFolderId },
      limits: { maxUploadBytes },
    }),

    'GET /api/drive/files': async ({ url }) => ({
      folderId: folderParam(url),
      files: await pipeline.listDrive(folderParam(url)),
    }),

    'GET /api/drive/file': async ({ url }) => {
      const id = url.searchParams.get('id') || '';
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new AmiError('Bad file id', { code: 'INVALID_INPUT' });
      return pipeline.readDriveFile(id);
    },

    // Streams one JSON line per file as it finishes, so the UI can tick
    // through a big folder instead of waiting for all of it.
    'POST /api/drive/read-folder': async ({ url, res }) => {
      const folderId = folderParam(url);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
      const write = (obj) => res.write(JSON.stringify(obj) + '\n');
      try {
        const result = await pipeline.readDriveFolder(folderId, {
          onProgress: ({ done, total, result: r }) =>
            write({ type: 'file', done, total, entry: r.entry, cached: r.cached, error: r.error, document: r.document }),
        });
        write({ type: 'done', skipped: result.skipped, cache: result.cache });
      } catch (error) {
        write({ type: 'error', error: publicError(error) });
      }
      res.end();
      return STREAMED;
    },

    'POST /api/upload': async ({ req, url }) => {
      const folderId = folderParam(url);
      return handleMultipart(req, maxUploadBytes, (body, info) =>
        pipeline.uploadAndRead({ body, name: info.filename, mimeType: info.mimeType, folderId }),
      );
    },

    'POST /api/extract': async ({ req }) =>
      handleMultipart(req, maxUploadBytes, (body, info) =>
        pipeline.readUpload({ body, name: info.filename, mimeType: info.mimeType }),
      ),

    'GET /auth/google': async ({ req, res }) => {
      res.writeHead(302, { Location: await auth.buildAuthUrl(redirectUri(req), newState()) });
      res.end();
      return STREAMED;
    },

    // Always ends on the app, never on a raw JSON error page: success goes
    // to /?signedIn=1, anything else to /?authError=<what happened>.
    'GET /auth/google/callback': async ({ req, res, url }) => {
      const back = (query) => {
        res.writeHead(302, { Location: `/?${query}` });
        res.end();
        return STREAMED;
      };
      const fail = (message) => {
        logger.warn(`Drive sign-in failed: ${message}`);
        return back(`authError=${encodeURIComponent(message)}`);
      };

      const problem = stateProblem(url.searchParams.get('state'));
      if (problem) return fail(`${problem}. Click "Connect Google Drive" to try again.`);
      if (url.searchParams.get('error')) return fail(`Google said: ${url.searchParams.get('error')}`);
      const code = url.searchParams.get('code');
      if (!code) return fail('Google did not send a sign-in code back.');

      try {
        await auth.completeLogin(code, redirectUri(req));
      } catch (error) {
        // A reloaded callback reuses a code Google already spent. If the
        // first load saved the login, that's fine - we're signed in.
        if ((await auth.status()).signedIn) return back('signedIn=1');
        return fail(`Google rejected the sign-in (${error?.response?.data?.error || error.message}).`);
      }
      return back('signedIn=1');
    },

    'POST /auth/signout': async () => {
      await auth.signOut();
      return { ok: true };
    },
  };

  function folderParam(url) {
    return (url.searchParams.get('folderId') || defaultFolderId || '').trim();
  }

  return createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (accessKey && !authorized(req, url, res, accessKey)) return;

      const route = routes[`${req.method} ${url.pathname}`];
      if (route) {
        const result = await route({ req, res, url });
        if (result !== STREAMED) sendJson(res, 200, result);
        return;
      }
      if (req.method === 'GET') return await serveStatic(url.pathname, res);
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'No such endpoint' } });
    } catch (error) {
      if (!(error instanceof AmiError)) logger.error('Request failed:', error);
      if (res.headersSent) return res.end();
      sendJson(res, statusFor(error), { error: publicError(error) });
    }
  });
}

const STREAMED = Symbol('streamed');

/**
 * Parses a multipart upload without buffering it. Each file part is
 * handed to `handle` as a stream while it's still arriving; the
 * request's bytes flow straight on to wherever the handler sends them.
 */
function handleMultipart(req, maxBytes, handle) {
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: MAX_FILES_PER_REQUEST } });
    } catch (cause) {
      reject(new AmiError('Expected a multipart/form-data upload', { code: 'INVALID_INPUT', cause }));
      return;
    }

    const jobs = [];
    parser.on('file', (field, stream, info) => {
      const filename = path.basename(String(info.filename || '').replace(/\\/g, '/'));
      if (!filename) {
        stream.resume();
        return;
      }
      // Our own stream in front of busboy's, so we can fail the upload
      // cleanly on a size-limit hit while busboy drains the rest.
      const body = new PassThrough();
      stream.on('limit', () => {
        stream.unpipe(body);
        stream.resume();
        body.destroy(new AmiError(`${filename} is over the ${maxBytes} byte upload limit`, { code: 'FILE_TOO_LARGE' }));
      });
      stream.on('error', (error) => body.destroy(error));
      stream.pipe(body);

      jobs.push(
        handle(body, { filename, mimeType: info.mimeType })
          .then((result) => ({ name: filename, ...result }))
          .catch((error) => {
            // The handler may have failed before reading anything (no
            // Drive login, say). Drain the part so busboy can move on to
            // the next one instead of stalling the whole request.
            stream.unpipe(body);
            stream.resume();
            body.destroy();
            return { name: filename, error: publicError(error) };
          }),
      );
    });
    parser.on('error', (error) => reject(new AmiError(`Upload failed: ${error.message}`, { code: 'UPLOAD_FAILED' })));
    parser.on('close', async () => resolve({ results: await Promise.all(jobs) }));
    req.pipe(parser);
  });
}

async function serveStatic(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, relative);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !MIME[path.extname(file)]) {
    return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)],
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:",
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
  }
}

// Optional shared key for when the GUI is reachable beyond localhost.
// Open /?key=... once; it's kept in an HttpOnly cookie after that.
function authorized(req, url, res, accessKey) {
  const fromQuery = url.searchParams.get('key');
  if (fromQuery && safeEqual(fromQuery, accessKey)) {
    res.writeHead(302, {
      'Set-Cookie': `ami_key=${encodeURIComponent(accessKey)}; HttpOnly; SameSite=Strict; Path=/`,
      Location: url.pathname,
    });
    res.end();
    return false;
  }
  const cookie = /(?:^|;\s*)ami_key=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  const given = req.headers['x-ami-key'] || (cookie && decodeURIComponent(cookie));
  if (given && safeEqual(given, accessKey)) return true;
  sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Open the GUI with ?key=<GUI_ACCESS_KEY> first.' } });
  return false;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function redirectUri(req) {
  return `http://${req.headers.host}/auth/google/callback`;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function statusFor(error) {
  const code = error?.code;
  if (['INVALID_INPUT', 'INVALID_DRIVE_FOLDER', 'MISSING_DRIVE_FOLDER', 'MISSING_INPUT', 'OAUTH_STATE', 'OAUTH_DENIED'].includes(code)) return 400;
  if (['MISSING_CREDENTIALS', 'DRIVE_OAUTH_REQUIRED'].includes(code)) return 401;
  if (code === 'FILE_TOO_LARGE') return 413;
  if (['UNSUPPORTED_FILE_TYPE', 'LEGACY_OFFICE_FORMAT', 'NEEDS_MARKITDOWN'].includes(code)) return 415;
  if (code === 'DRIVE_REQUEST_FAILED') return error.status === 404 ? 404 : 502;
  return error instanceof AmiError ? 422 : 500;
}

function publicError(error) {
  return error instanceof AmiError
    ? { code: error.code, message: error.message }
    : { code: 'INTERNAL', message: 'Something went wrong on the server. Check its log.' };
}

/** Wires the real Drive auth + pipeline and starts listening. */
export async function startServer({ port = config.server.port, host = config.server.host, pipeline, auth } = {}) {
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  if (!loopback && !config.server.accessKey) {
    throw new AmiError(`Refusing to listen on ${host} without GUI_ACCESS_KEY set.`, { code: 'INSECURE_BIND' });
  }
  const server = createServer({ pipeline, auth });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const { port: actualPort } = server.address();
  logger.info(`AMI file intake running at http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}`);
  return server;
}
