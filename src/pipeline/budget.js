/**
 * Caps how many bytes all in-flight files may hold at once.
 *
 * A plain concurrency limit ("3 files at a time") is fine until those
 * three are 400MB each. Here each file reserves roughly what it will
 * hold in RAM before it starts, and waits if that would go over the
 * budget. Small files keep flowing in parallel; one huge file runs
 * alone. A file bigger than the whole budget still runs, just alone.
 */
export class MemoryBudget {
  constructor(limitBytes) {
    this.limit = limitBytes;
    this.used = 0;
    this.waiting = [];
  }

  async acquire(bytes) {
    const amount = Math.min(Math.max(0, bytes || 0), this.limit);
    if (this.used + amount > this.limit || this.waiting.length) {
      await new Promise((resolve) => this.waiting.push({ amount, resolve }));
    } else {
      this.used += amount;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= amount;
      this.drain();
    };
  }

  // First come, first served, so a big file waiting at the front isn't
  // starved by a stream of small ones slipping past it.
  drain() {
    while (this.waiting.length && this.used + this.waiting[0].amount <= this.limit) {
      const next = this.waiting.shift();
      this.used += next.amount;
      next.resolve();
    }
  }
}

/** Runs fn over items, at most `limit` at a time, keeping result order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
