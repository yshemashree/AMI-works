import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from '../src/server/index.js';
import { createPipeline, ResultCache } from '../src/pipeline/index.js';
import { MockDriveClient, driveFile } from './helpers/mockDriveClient.js';
import { generateFixtures } from './fixtures/generate-fixtures.mjs';

let server;
let base;
let drive;
let docx;
let pdf;

const auth = {
  status: () => ({ serviceAccount: false, oauthConfigured: true, signedIn: true, canRead: true, canUpload: true }),
  buildAuthUrl: async (redirect, state) => `https://accounts.example/auth?redirect_uri=${encodeURIComponent(redirect)}&state=${state}`,
  completeLogin: async () => {},
  signOut: async () => {},
};

async function start(options = {}) {
  const srv = createServer({ pipeline: options.pipeline, auth, defaultFolderId: 'folder-1', maxUploadBytes: 1024 * 1024, ...options });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { srv, url: `http://127.0.0.1:${srv.address().port}` };
}

before(async () => {
  const fixtures = await generateFixtures();
  docx = readFileSync(fixtures.docxPath);
  pdf = readFileSync(fixtures.pdfPath);
  drive = new MockDriveClient({
    pages: [[driveFile('p', 'report.pdf', pdf, 'application/pdf'), { id: 's', name: 'Sub', mimeType: 'application/vnd.google-apps.folder' }]],
    contents: { p: pdf },
  });
  const pipeline = createPipeline({ getReadClient: async () => drive, getWriteClient: async () => drive, cache: new ResultCache() });
  ({ srv: server, url: base } = await start({ pipeline }));
});

after(() => server.close());

function form(name, bytes, type = 'application/octet-stream') {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), name);
  return fd;
}

describe('GUI server', () => {
  test('serves the UI and its component scripts', async () => {
    const html = await fetch(`${base}/`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    assert.match(await html.text(), /AMI File Intake/);

    const js = await fetch(`${base}/js/components/uploadPanel.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
  });

  test('does not serve files outside the public folder', async () => {
    for (const p of ['/../index.js', '/%2e%2e/index.js', '/../../package.json', '/js/../../index.js']) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 404, p);
    }
  });

  test('status reports Drive and converter state', async () => {
    const body = await (await fetch(`${base}/api/status`)).json();
    assert.equal(body.drive.canUpload, true);
    assert.equal(body.defaults.folderId, 'folder-1');
    assert.equal(body.markitdown.available, false);
  });

  test('upload streams to Drive and answers with the JSON', async () => {
    const res = await fetch(`${base}/api/upload?folderId=folder-9`, { method: 'POST', body: form('memo.docx', docx) });
    assert.equal(res.status, 200);
    const { results } = await res.json();
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'memo.docx');
    assert.equal(results[0].checksumMatches, true);
    assert.match(results[0].document.text, /test DOCX document/);
    assert.deepEqual(drive.uploadedBytes, docx);
    assert.deepEqual(drive.calls.create.at(-1).requestBody.parents, ['folder-9']);
  });

  test('extract reads without touching Drive', async () => {
    const creates = drive.calls.create.length;
    const res = await fetch(`${base}/api/extract`, { method: 'POST', body: form('report.pdf', pdf) });
    const { results } = await res.json();
    assert.equal(results[0].document.stats.pages, 2);
    assert.equal(drive.calls.create.length, creates);
  });

  test('an unsupported file comes back as a per-file error', async () => {
    const res = await fetch(`${base}/api/extract`, { method: 'POST', body: form('tool.exe', 'MZ') });
    const { results } = await res.json();
    assert.equal(results[0].error.code, 'UNSUPPORTED_FILE_TYPE');
  });

  test('over-limit uploads are refused and nothing half-written reaches Drive', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 1);
    const creates = drive.calls.create.length;
    const res = await fetch(`${base}/api/upload`, { method: 'POST', body: form('big.bin.pdf', big) });
    const { results } = await res.json();
    assert.equal(results[0].error.code, 'FILE_TOO_LARGE');
    // The mock drains the body; a real create would be aborted mid-stream.
    assert.ok(drive.calls.create.length <= creates + 1);
  });

  test('lists a folder and reads a file into JSON', async () => {
    const list = await (await fetch(`${base}/api/drive/files?folderId=folder-1`)).json();
    assert.deepEqual(list.files.map((f) => f.kind), ['file', 'folder']);

    const read = await (await fetch(`${base}/api/drive/file?id=p`)).json();
    assert.match(read.document.text, /Page One Content/);
  });

  test('reading a folder streams one line per file', async () => {
    const res = await fetch(`${base}/api/drive/read-folder?folderId=folder-1`, { method: 'POST' });
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].type, 'file');
    assert.equal(lines.at(-1).type, 'done');
    assert.deepEqual(lines.at(-1).skipped, [{ name: 'Sub', kind: 'folder' }]);
  });

  test('bad input gets a 400 with a readable error', async () => {
    const res = await fetch(`${base}/api/drive/files?folderId=${encodeURIComponent("x' or 1=1")}`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'INVALID_DRIVE_FOLDER');
  });

  test('Google sign-in: signed state survives a restart; forged or expired ones land back on the app with a message', async () => {
    const begin = await fetch(`${base}/auth/google`, { redirect: 'manual' });
    assert.equal(begin.status, 302);
    const location = new URL(begin.headers.get('location'));
    assert.match(location.searchParams.get('redirect_uri'), /\/auth\/google\/callback$/);
    const state = location.searchParams.get('state');

    const forged = await fetch(`${base}/auth/google/callback?code=abc&state=nope`, { redirect: 'manual' });
    assert.equal(forged.status, 302);
    assert.match(forged.headers.get('location'), /^\/\?authError=.*did%20not%20come%20from%20this%20app/);

    const ok = await fetch(`${base}/auth/google/callback?code=abc&state=${state}`, { redirect: 'manual' });
    assert.equal(ok.headers.get('location'), '/?signedIn=1');

    // A second server (as after Ctrl+C + restart) with the same OAuth secret accepts it too.
    const { srv, url } = await start({ pipeline: createPipeline({ getReadClient: async () => drive }), stateSecret: 'shared' });
    const other = await start({ pipeline: createPipeline({ getReadClient: async () => drive }), stateSecret: 'shared' });
    try {
      const fresh = new URL((await fetch(`${url}/auth/google`, { redirect: 'manual' })).headers.get('location')).searchParams.get('state');
      const afterRestart = await fetch(`${other.url}/auth/google/callback?code=abc&state=${fresh}`, { redirect: 'manual' });
      assert.equal(afterRestart.headers.get('location'), '/?signedIn=1');

      const [, nonce, ] = fresh.split('.');
      const stale = `${(Date.now() - 11 * 60_000).toString(36)}.${nonce}`;
      const { createHmac } = await import('node:crypto');
      const staleState = `${stale}.${createHmac('sha256', 'shared').update(stale).digest('base64url')}`;
      const expired = await fetch(`${other.url}/auth/google/callback?code=abc&state=${staleState}`, { redirect: 'manual' });
      assert.match(expired.headers.get('location'), /authError=.*expired/);
    } finally {
      srv.close();
      other.srv.close();
    }
  });

  test('Google sign-in: a rejected code reports why, unless the first load already signed us in', async () => {
    const failing = {
      ...auth,
      status: () => ({ ...auth.status(), signedIn: false }),
      completeLogin: async () => {
        throw Object.assign(new Error('bad'), { response: { data: { error: 'invalid_grant' } } });
      },
    };
    const { srv, url } = await start({ pipeline: createPipeline({ getReadClient: async () => drive }), auth: failing, stateSecret: 's' });
    try {
      const state = new URL((await fetch(`${url}/auth/google`, { redirect: 'manual' })).headers.get('location')).searchParams.get('state');
      const res = await fetch(`${url}/auth/google/callback?code=abc&state=${state}`, { redirect: 'manual' });
      assert.match(res.headers.get('location'), /authError=.*invalid_grant/);
    } finally {
      srv.close();
    }
  });
});

describe('GUI access key', () => {
  test('everything is locked until the key is presented', async () => {
    const pipeline = createPipeline({ getReadClient: async () => drive, getWriteClient: async () => drive });
    const { srv, url } = await start({ pipeline, accessKey: 's3cret' });
    try {
      assert.equal((await fetch(`${url}/api/status`)).status, 401);
      assert.equal((await fetch(`${url}/api/status`, { headers: { 'x-ami-key': 'wrong' } })).status, 401);
      assert.equal((await fetch(`${url}/api/status`, { headers: { 'x-ami-key': 's3cret' } })).status, 200);

      const login = await fetch(`${url}/?key=s3cret`, { redirect: 'manual' });
      const cookie = login.headers.get('set-cookie').split(';')[0];
      assert.match(login.headers.get('set-cookie'), /HttpOnly/);
      assert.equal((await fetch(`${url}/api/status`, { headers: { cookie } })).status, 200);
    } finally {
      srv.close();
    }
  });
});
