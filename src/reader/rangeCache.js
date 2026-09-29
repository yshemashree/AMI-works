/**
 * Wraps a Source's readRange with block-aligned reads and a small LRU.
 *
 * Parsers that seek (ZIP central directory, then each entry's local
 * header, then its data) tend to ask for many tiny, neighbouring ranges.
 * Over the network each of those is a round trip, so we round every read
 * out to whole blocks, fetch runs of missing blocks in one request, and
 * keep the last few blocks around. Small XML parts that sit next to each
 * other in the archive usually come back in a single request.
 *
 * Big reads (an embedded image we actually want) skip the cache and go
 * straight through, so one large read can't flush everything else.
 */
export function withBlockCache(source, { blockSize = 256 * 1024, maxBlocks = 32, directThreshold } = {}) {
  const direct = directThreshold ?? blockSize * 4;
  const blocks = new Map(); // index -> Promise<Buffer>, insertion order doubles as LRU order
  const stats = { requests: 0, bytesFetched: 0 };

  async function fetchRange(start, end) {
    stats.requests++;
    const data = await source.readRange(start, end);
    stats.bytesFetched += data.length;
    return data;
  }

  function touch(index) {
    const value = blocks.get(index);
    blocks.delete(index);
    blocks.set(index, value);
    return value;
  }

  function evict() {
    while (blocks.size > maxBlocks) {
      blocks.delete(blocks.keys().next().value);
    }
  }

  function loadRun(first, last) {
    const start = first * blockSize;
    const end = Math.min((last + 1) * blockSize, source.size);
    const run = fetchRange(start, end);
    for (let i = first; i <= last; i++) {
      const offset = (i - first) * blockSize;
      const block = run.then((data) => data.subarray(offset, offset + blockSize));
      // A failed fetch must not stay cached as a rejected promise.
      block.catch(() => blocks.delete(i));
      blocks.set(i, block);
    }
  }

  async function read(start, end) {
    end = Math.min(end, source.size);
    if (end <= start) return Buffer.alloc(0);
    if (end - start >= direct) return fetchRange(start, end);

    const first = Math.floor(start / blockSize);
    const last = Math.floor((end - 1) / blockSize);

    let runStart = null;
    for (let i = first; i <= last + 1; i++) {
      const missing = i <= last && !blocks.has(i);
      if (missing && runStart === null) runStart = i;
      if (!missing && runStart !== null) {
        loadRun(runStart, i - 1);
        runStart = null;
      }
    }

    // Grab every block promise before the first await, so a concurrent
    // read can't evict one of ours between scheduling and collecting.
    const pending = [];
    for (let i = first; i <= last; i++) pending.push(touch(i));
    evict();
    const parts = await Promise.all(pending);

    const joined = parts.length === 1 ? parts[0] : Buffer.concat(parts);
    const offset = start - first * blockSize;
    return joined.subarray(offset, offset + (end - start));
  }

  return { size: source.size, read, stats };
}
