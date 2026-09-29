import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { config } from '../config.js';
import { AmiError, MissingCredentialsError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

// Full drive rather than drive.file, same reason as the service account
// in driveAuth.js: drive.file only covers files this app created, so
// writing into a folder the user made already comes back as a 404.
const SCOPES = ['https://www.googleapis.com/auth/drive'];

/**
 * Drive client authorized as the signed-in user. Uploads need this
 * because a service account has no storage quota and so cannot own the
 * file it creates. Reads still use the service account in driveAuth.js.
 *
 * Uses the saved token when there is one. Pass interactive: false to fail
 * instead of starting a browser login, which is what a non-tty run wants.
 */
export async function createOAuthDriveClient({ interactive = true } = {}) {
  const { google } = await import('googleapis');
  const saved = readToken();

  if (saved) {
    const auth = newOAuthClient(google, loopbackUri());
    auth.setCredentials(saved);
    // Access tokens are refreshed in the background; keep the file in
    // step so a restart doesn't begin with an expired one.
    auth.on('tokens', (fresh) => writeToken({ ...saved, ...fresh }));
    return google.drive({ version: 'v3', auth });
  }
  if (!interactive) {
    throw new AmiError('No saved Drive token. Run "ami drive-login" first.', {
      code: 'DRIVE_OAUTH_REQUIRED',
    });
  }

  const auth = await runConsentFlow(google);
  return google.drive({ version: 'v3', auth });
}

/**
 * Browser sign-in for the GUI: the server redirects the user here, Google
 * sends them back to `redirectUri` with a code, and completeLogin() swaps
 * the code for a token. `state` guards the callback against CSRF.
 */
export async function buildAuthUrl(redirectUri, state) {
  const { google } = await import('googleapis');
  return newOAuthClient(google, redirectUri).generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
  });
}

export async function completeLogin(code, redirectUri) {
  const { google } = await import('googleapis');
  const auth = newOAuthClient(google, redirectUri);
  const { tokens } = await auth.getToken({ code, redirect_uri: redirectUri });
  writeToken(tokens);
}

export function hasOAuthClientConfig() {
  return Boolean(config.drive.oauth.clientId && config.drive.oauth.clientSecret);
}

export function signOut() {
  rmSync(tokenPath(), { force: true });
}

export function tokenPath() {
  return path.resolve(config.drive.oauth.tokenPath);
}

export function hasSavedToken() {
  return existsSync(tokenPath());
}

function loopbackUri(port) {
  return port ? `http://127.0.0.1:${port}` : 'http://127.0.0.1';
}

function newOAuthClient(google, redirectUri) {
  const { clientId, clientSecret } = config.drive.oauth;
  if (!clientId) {
    throw new MissingCredentialsError('Google Drive OAuth', 'GOOGLE_OAUTH_CLIENT_ID');
  }
  if (!clientSecret) {
    throw new MissingCredentialsError('Google Drive OAuth', 'GOOGLE_OAUTH_CLIENT_SECRET');
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

async function runConsentFlow(google) {
  const server = await startLoopbackServer();
  const redirectUri = loopbackUri(server.port);
  const auth = newOAuthClient(google, redirectUri);
  const url = auth.generateAuthUrl({
    access_type: 'offline',
    // Without this Google skips the refresh token on a repeat approval,
    // and then the saved file is only good until the access token expires.
    prompt: 'consent',
    scope: SCOPES,
  });

  printInstructions(url);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    // Whichever arrives first: the browser redirect hitting the local
    // server, or a code pasted by hand if the redirect can't get through.
    const code = await Promise.race([server.code, askForCode(rl)]);
    const { tokens } = await auth.getToken({ code, redirect_uri: redirectUri });
    auth.setCredentials(tokens);
    writeToken(tokens);
    logger.info(`Saved Drive token to ${tokenPath()}`);
    return auth;
  } finally {
    rl.close();
    server.close();
  }
}

function printInstructions(url) {
  console.log(`
Open this URL in a browser and sign in to the Google account that owns
the target Drive folder:

${url}

After you approve, the browser comes back to this machine and the login
finishes on its own. If that doesn't happen, copy the "code" value out of
the browser address bar and paste it below.
`);
}

async function askForCode(rl) {
  const answer = await rl.question('Code (or the full redirect URL): ');
  return extractCode(answer.trim());
}

// Accept a bare code or the whole redirect URL, since which one is easier
// to grab depends on how the browser handled the callback.
function extractCode(input) {
  if (!input.startsWith('http')) return input;
  const code = new URL(input).searchParams.get('code');
  if (!code) throw new AmiError('That URL has no code parameter', { code: 'DRIVE_OAUTH_FAILED' });
  return code;
}

async function startLoopbackServer() {
  let resolveCode;
  const code = new Promise((resolve) => {
    resolveCode = resolve;
  });

  const server = createServer((req, res) => handleCallback(req, res, resolveCode));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return { port: server.address().port, code, close: () => server.close() };
}

function handleCallback(req, res, resolveCode) {
  const params = new URL(req.url, 'http://127.0.0.1').searchParams;
  const code = params.get('code');
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(code ? 'Drive login done. You can close this tab.' : 'No code in this request.');
  if (code) resolveCode(code);
}

function readToken() {
  const file = tokenPath();
  if (!existsSync(file)) return null;

  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // Not passing the parse error through: it quotes the offending part
    // of the file, which here is token material.
    throw new AmiError(`Could not read the Drive token at ${file}. Delete it and log in again.`, {
      code: 'DRIVE_TOKEN_UNREADABLE',
    });
  }
}

function writeToken(tokens) {
  writeFileSync(tokenPath(), JSON.stringify(tokens, null, 2), { mode: 0o600 });
}
