import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import { readDocument, fileSource, bufferSource, SCHEMA } from '../src/reader/index.js';
import { withBlockCache } from '../src/reader/rangeCache.js';
import { imageInfo } from '../src/reader/imageInfo.js';
import { parseDelimited } from '../src/reader/formats/text.js';
import { generateFixtures, buildPdf } from './fixtures/generate-fixtures.mjs';

let fixtures;
const LONG = 'This page is a long paragraph of body text that easily clears the scanned-page threshold.';

before(async () => {
  fixtures = await generateFixtures();
});

// Same file, both strategies: everything in one buffer vs. byte ranges.
async function readBoth(filePath, options = {}) {
  const buffered = await readDocument(await fileSource(filePath), { rangeThresholdBytes: Infinity, ...options });
  const ranged = await readDocument(await fileSource(filePath), { rangeThresholdBytes: 0, ...options });
  return { buffered, ranged };
}

function comparable(doc) {
  const { timings, engine, ...rest } = doc;
  return { ...rest, engine: { ...engine, strategy: null } };
}

describe('readDocument - JSON shape', () => {
  test('every document carries the same top-level fields', async () => {
    for (const file of [fixtures.pdfPath, fixtures.docxPath, fixtures.pptxPath, fixtures.imagePath, fixtures.xlsxPath]) {
      const { document } = await readDocument(await fileSource(file));
      assert.equal(document.schema, SCHEMA);
      for (const key of ['source', 'metadata', 'stats', 'text', 'sections', 'images', 'charts', 'children', 'warnings', 'engine']) {
        assert.ok(key in document, `${file} is missing ${key}`);
      }
      assert.doesNotThrow(() => JSON.parse(JSON.stringify(document)));
    }
  });

  test('never embeds image bytes in the JSON', async () => {
    const { document } = await readDocument(await fileSource(fixtures.richPptxPath));
    assert.ok(!JSON.stringify(document).includes('base64'));
  });
});

describe('PDF', () => {
  test('reads per-page text, and range mode gives the same result', async () => {
    const { buffered, ranged } = await readBoth(fixtures.pdfPath);
    assert.equal(buffered.document.stats.pages, 2);
    assert.deepEqual(buffered.document.sections.map((s) => s.text), ['Page One Content', 'Page Two Content']);
    assert.equal(buffered.document.engine.strategy, 'buffer');
    assert.equal(ranged.document.engine.strategy, 'range');
    assert.deepEqual(ranged.document.sections.map((s) => s.text), buffered.document.sections.map((s) => s.text));
  });

  test('triage: text-only pages skip vision, graphics and scans are flagged', async () => {
    const pdf = buildPdf([LONG, LONG, 'x'], { drawBoxes: [1] });
    const { document } = await readDocument(bufferSource('triage.pdf', pdf));
    const verdicts = document.sections.map((s) => s.needsVision);
    assert.deepEqual(verdicts, [false, true, true]);
    assert.match(document.sections[1].visionReason, /vector graphics/);
    assert.match(document.sections[2].visionReason, /scanned/);
  });

  test('renders only the flagged pages when visuals are requested', async () => {
    const pdf = buildPdf([LONG, LONG, 'x'], { drawBoxes: [1] });
    const auto = await readDocument(bufferSource('triage.pdf', pdf), { withVisuals: true });
    assert.deepEqual(auto.visuals.map((v) => v.pageNumber), [2, 3]);

    const all = await readDocument(bufferSource('triage.pdf', pdf), { withVisuals: true, visionPages: 'all' });
    assert.equal(all.visuals.length, 3);
  });

  test('a corrupt PDF is rejected, not silently half-read', async () => {
    await assert.rejects(() => readDocument(bufferSource('bad.pdf', Buffer.from('%PDF-1.4 garbage'))), /EXTRACTION|Invalid|extract/i);
  });
});

describe('DOCX', () => {
  test('text plus embedded image metadata, identical in both strategies', async () => {
    const { buffered, ranged } = await readBoth(fixtures.docxPath);
    const doc = buffered.document;
    assert.match(doc.text, /test DOCX document/);
    assert.equal(doc.images.length, 1);
    assert.deepEqual([doc.images[0].width, doc.images[0].height], [200, 100]);
    assert.deepEqual(comparable(ranged.document), comparable(doc));
  });
});

describe('PPTX', () => {
  test('slides, notes, native chart data, properties', async () => {
    const { document } = await readDocument(await fileSource(fixtures.richPptxPath));
    assert.deepEqual(document.sections.map((s) => s.number), [1, 2, 10]); // numeric, not string, order
    assert.equal(document.sections[0].notes, 'Mention the Q3 jump');
    assert.equal(document.metadata.title, 'Board deck Q3');
    assert.equal(document.metadata.author, 'Finance & Ops');

    assert.equal(document.charts.length, 1);
    const [chart] = document.charts;
    assert.equal(chart.title, 'Revenue vs Cost');
    assert.equal(chart.slide, 10);
    assert.deepEqual(chart.series[0], { name: 'Revenue', categories: ['Q1', 'Q2', 'Q3'], values: [4.2, 5.1, 6.3] });
  });

  test('repeated and icon-sized pictures are not sent to a vision model', async () => {
    const { document, visuals } = await readDocument(await fileSource(fixtures.richPptxPath), { withVisuals: true });
    const byName = Object.fromEntries(document.images.map((img) => [img.name, img]));

    assert.equal(byName['image1.png'].needsVision, true);
    assert.equal(byName['image2.png'].duplicateOf, byName['image1.png'].id);
    assert.equal(byName['icon.png'].visionReason, 'icon-sized');
    assert.equal(visuals.length, 1, 'one unique, worthwhile picture');

    const [s1, s2, s10] = document.sections;
    assert.equal(s1.needsVision, true);
    assert.equal(s2.needsVision, false);
    assert.match(s2.visionReason, /earlier slide/);
    assert.equal(s10.needsVision, false);
  });

  test('range mode fetches only a fraction of a large deck', async () => {
    // Pad the deck with a big incompressible "video" the reader has no use for.
    const zip = new AdmZip(readFileSync(fixtures.richPptxPath));
    const video = randomBytes(4 * 1024 * 1024);
    zip.addFile('ppt/media/media1.mp4', video);
    const deck = zip.toBuffer();

    let fetched = 0;
    const source = bufferSource('big.pptx', deck);
    const counting = { ...source, readRange: async (s, e) => ((fetched += e - s), source.readRange(s, e)) };

    const { document } = await readDocument(counting, { rangeThresholdBytes: 0 });
    assert.equal(document.engine.strategy, 'range');
    assert.equal(document.stats.slides, 3);
    assert.ok(fetched < deck.length / 4, `fetched ${fetched} of ${deck.length} bytes`);
  });
});

describe('XLSX', () => {
  test('sheets become markdown tables without any Python', async () => {
    const { document } = await readDocument(await fileSource(fixtures.xlsxPath));
    assert.equal(document.stats.sheets, 2);
    const [budget, notes] = document.sections;
    assert.equal(budget.title, 'Budget');
    assert.equal(notes.title, 'Notes & misc');
    assert.match(budget.text, /\| Item \| Cost \| Approved \|/);
    assert.match(budget.text, /\| Cloud credits \| 5000 \| TRUE \|/);
    assert.match(budget.text, /\| Travel \|  \| FALSE \|/);
    assert.match(notes.text, /\|  \| only B \|/);
  });
});

describe('images', () => {
  test('dimensions from the header, no decode', async () => {
    const { document } = await readDocument(await fileSource(fixtures.imagePath));
    assert.equal(document.source.type, 'image');
    assert.deepEqual([document.images[0].width, document.images[0].height], [200, 100]);
  });

  test('imageInfo reads JPEG and GIF headers too', () => {
    const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc0001108007800a0030122000211010311', 'hex');
    assert.deepEqual(imageInfo(jpeg), { mimeType: 'image/jpeg', width: 160, height: 120 });
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x40, 0x01, 0xf0, 0x00]), Buffer.alloc(20)]);
    assert.deepEqual(imageInfo(gif), { mimeType: 'image/gif', width: 320, height: 240 });
  });
});

describe('text formats', () => {
  test('CSV becomes a table, quoted fields and all', async () => {
    const csv = 'name,note\n"Smith, J","said ""hi""\nthen left"\nLee,ok\n';
    const { document } = await readDocument(bufferSource('people.csv', Buffer.from(csv)));
    assert.match(document.markdown, /\| name \| note \|/);
    assert.match(document.markdown, /\| Smith, J \| said "hi" then left \|/);
    assert.deepEqual(parseDelimited('a\tb\n1\t2', '\t'), [['a', 'b'], ['1', '2']]);
  });

  test('HTML is stripped to readable text', async () => {
    const html = '<html><head><style>p{}</style><script>alert(1)</script></head><body><h1>Title</h1><p>One &amp; two</p></body></html>';
    const { document } = await readDocument(bufferSource('page.html', Buffer.from(html)));
    assert.equal(document.text, 'Title\n\nOne & two');
  });

  test('UTF-8 BOM is dropped', async () => {
    const { document } = await readDocument(bufferSource('bom.txt', Buffer.from('﻿hello', 'utf8')));
    assert.equal(document.text, 'hello');
  });
});

describe('ZIP archives (in memory)', () => {
  test('reads every supported file, skips junk and unsupported ones', async () => {
    const { buffered, ranged } = await readBoth(fixtures.zipPath);
    const doc = buffered.document;
    const names = doc.children.map((c) => c.source.path.split('sample-bundle.zip/')[1]).sort();
    assert.deepEqual(names, ['nested/deck.pptx', 'nested/memo.docx', 'photo.png', 'readme.txt', 'report.pdf']);
    assert.deepEqual(doc.skipped, [{ name: 'tool.exe', reason: 'unsupported file type' }]);
    assert.equal(doc.stats.files, 5);
    assert.equal(ranged.document.engine.strategy, 'range');
    assert.deepEqual(ranged.document.children.map((c) => c.text), doc.children.map((c) => c.text));
  });

  test('entry names are labels only - a "../" entry is read, never written anywhere', async () => {
    const zip = new AdmZip();
    zip.addFile('../../etc/evil.txt', Buffer.from('still just text'));
    const { document } = await readDocument(bufferSource('evil.zip', zip.toBuffer()));
    assert.equal(document.children[0].text, 'still just text');
  });

  test('one broken file becomes an error on its child, the rest still read', async () => {
    const zip = new AdmZip();
    zip.addFile('good.txt', Buffer.from('fine'));
    zip.addFile('bad.pdf', Buffer.from('%PDF-1.4 not really'));
    const { document } = await readDocument(bufferSource('mixed.zip', zip.toBuffer()));
    const bad = document.children.find((c) => c.source.name === 'bad.pdf');
    assert.equal(bad.error.code, 'EXTRACTION_FAILED');
    assert.equal(document.children.find((c) => c.source.name === 'good.txt').text, 'fine');
  });

  test('nested archives open, but only so deep', async () => {
    let inner = new AdmZip();
    inner.addFile('deep.txt', Buffer.from('bottom'));
    for (let i = 0; i < 3; i++) {
      const outer = new AdmZip();
      outer.addFile(`level${i}.zip`, inner.toBuffer());
      inner = outer;
    }
    const { document } = await readDocument(bufferSource('russian-doll.zip', inner.toBuffer()));
    let node = document;
    while (node.children?.[0] && !node.children[0].error) node = node.children[0];
    assert.equal(node.children[0].error.code, 'ZIP_TOO_DEEP');
  });

  test('a corrupt archive is rejected clearly', async () => {
    await assert.rejects(() => readDocument(bufferSource('bad.zip', Buffer.from('not a zip'))), (e) => e.code === 'INVALID_ZIP');
  });

  test('onChild streams files out one at a time', async () => {
    const seen = [];
    await readDocument(await fileSource(fixtures.zipPath), { onChild: async (doc) => seen.push(doc.source.name) });
    assert.equal(seen.length, 5);
  });
});

describe('unsupported input', () => {
  test('legacy Office and unknown types fail with a clear code', async () => {
    await assert.rejects(() => readDocument(bufferSource('old.doc', Buffer.from('x'))), (e) => e.code === 'LEGACY_OFFICE_FORMAT');
    await assert.rejects(() => readDocument(bufferSource('tool.exe', Buffer.from('MZ'))), (e) => e.code === 'UNSUPPORTED_FILE_TYPE');
    await assert.rejects(() => readDocument(bufferSource('old.xls', Buffer.from('x'))), (e) => e.code === 'NEEDS_MARKITDOWN');
  });

  test('a file without an extension is sniffed from its first bytes', async () => {
    const { document } = await readDocument(bufferSource('upload', readFileSync(fixtures.pdfPath)));
    assert.equal(document.source.type, 'pdf');
  });
});

describe('withBlockCache', () => {
  test('returns exact bytes and merges neighbouring reads into few requests', async () => {
    const data = Buffer.from(Array.from({ length: 10_000 }, (_, i) => i % 251));
    let requests = 0;
    const source = { size: data.length, readRange: async (s, e) => (requests++, data.subarray(s, e)) };
    const cache = withBlockCache(source, { blockSize: 1024 });

    for (let start = 0; start < 9000; start += 300) {
      const got = await cache.read(start, start + 120);
      assert.deepEqual(got, data.subarray(start, start + 120));
    }
    assert.ok(requests <= 10, `${requests} requests`);
    assert.deepEqual(await cache.read(9990, 20_000), data.subarray(9990));
  });
});
