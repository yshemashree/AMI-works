import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.py');

/**
 * Node side of the MarkItDown worker (worker.py).
 *
 * One Python process is started on first use and reused for every file
 * after that; requests are queued and sent one at a time. If Python or
 * the markitdown package isn't installed, isAvailable() is false and the
 * reader quietly uses its built-in parsers instead.
 *
 * convert() never throws. A timeout, crash or bad reply comes back as
 * { success: false, error } and the next call starts a fresh worker.
 */
export class MarkItDownClient {
  constructor({ pythonBin = 'python3', timeoutMs = 60_000, idleMs = 5 * 60_000, maxChars = 200_000 } = {}) {
    this.pythonBin = pythonBin;
    this.timeoutMs = timeoutMs;
    this.idleMs = idleMs;
    this.maxChars = maxChars;
    this.label = 'markitdown';
    this.proc = null;
    this.ready = null; // Promise<boolean> for the current process
    this.queue = Promise.resolve();
    this.nextId = 1;
    this.idleTimer = null;
    this.unavailableReason = null;
  }

  async isAvailable() {
    if (this.unavailableReason) return false;
    return this.start();
  }

  /** @returns {Promise<{success: boolean, markdown?: string, error?: string}>} */
  convert({ name, bytes }) {
    const job = this.queue.then(() => this.send(name, bytes));
    // Keep the chain alive whatever this job does.
    this.queue = job.catch(() => {});
    return job;
  }

  close() {
    clearTimeout(this.idleTimer);
    if (this.proc) {
      this.proc.stdin.end();
      this.proc = null;
      this.ready = null;
    }
  }

  start() {
    if (this.ready) return this.ready;

    this.ready = new Promise((resolve) => {
      let proc;
      try {
        proc = spawn(this.pythonBin, ['-u', WORKER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        this.markUnavailable(error.message);
        resolve(false);
        return;
      }
      this.proc = proc;
      this.buffer = '';
      this.pending = null;

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => this.onData(chunk, resolve));
      proc.stderr.on('data', (chunk) => logger.debug(`[markitdown] ${String(chunk).trim()}`));
      // Writes to a dead worker surface here; the exit handler deals with it.
      proc.stdin.on('error', () => {});
      proc.on('error', (error) => {
        this.markUnavailable(`could not start ${this.pythonBin}: ${error.message}`);
        resolve(false);
      });
      proc.on('exit', (code) => {
        if (this.proc === proc) {
          this.proc = null;
          this.ready = null;
        }
        this.failPending(`worker exited (code ${code})`);
        resolve(false);
      });
    });
    return this.ready;
  }

  onData(chunk, resolveReady) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        logger.warn(`[markitdown] ignoring a non-JSON line from the worker`);
        continue;
      }

      if ('ready' in message) {
        if (message.ready) {
          this.label = `markitdown ${message.version}`;
          resolveReady(true);
        } else {
          this.markUnavailable(message.error);
          resolveReady(false);
        }
      } else if (this.pending) {
        const { resolve, timer } = this.pending;
        this.pending = null;
        clearTimeout(timer);
        resolve(message);
      }
    }
  }

  async send(name, bytes) {
    if (!(await this.start())) {
      return failure(name, this.unavailableReason || 'MarkItDown worker is not running');
    }
    clearTimeout(this.idleTimer);

    const id = this.nextId++;
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        // A hung conversion blocks everything queued behind it, so the
        // worker is killed and restarted on the next call.
        this.pending = null;
        this.proc?.kill();
        resolve(failure(name, `conversion timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending = { resolve, timer };

      const header = JSON.stringify({ id, name, size: bytes.length, max_chars: this.maxChars });
      this.proc.stdin.write(header + '\n');
      this.proc.stdin.write(bytes);
    });

    this.idleTimer = setTimeout(() => this.close(), this.idleMs);
    this.idleTimer.unref();
    return result;
  }

  failPending(reason) {
    if (!this.pending) return;
    const { resolve, timer } = this.pending;
    this.pending = null;
    clearTimeout(timer);
    resolve(failure('', reason));
  }

  markUnavailable(reason) {
    if (!this.unavailableReason) {
      this.unavailableReason = reason || 'unknown error';
      logger.info(`MarkItDown not available (${this.unavailableReason}); using the built-in readers.`);
    }
  }
}

function failure(name, error) {
  return { success: false, filename: name, markdown: null, error, warnings: [] };
}
