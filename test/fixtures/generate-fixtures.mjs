// Generates small, deterministic test fixtures (image/pdf/docx/pptx/zip)
// on demand rather than committing binary files to the repo. Run once
// before the test suite (the "pretest" npm script); safe to re-run.
//
// Every write goes through writeAtomic, and a second call is a no-op if
// the fixtures are already there. Both matter: the runner executes test
// files in parallel child processes and four of them call this in their
// before() hook, so a plain writeFileSync would truncate a fixture while
// another process was part-way through reading it. That showed up as
// adm-zip throwing "No END header found" on sample-bundle.zip.
import { mkdirSync, writeFileSync, renameSync, existsSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import JSZip from 'jszip';
import AdmZip from 'adm-zip';

const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url));

export function fixturePaths() {
  return {
    imagePath: path.join(FIXTURES_DIR, 'sample-image.png'),
    pdfPath: path.join(FIXTURES_DIR, 'sample.pdf'),
    docxPath: path.join(FIXTURES_DIR, 'sample.docx'),
    pptxPath: path.join(FIXTURES_DIR, 'sample.pptx'),
    zipPath: path.join(FIXTURES_DIR, 'sample-bundle.zip'),
  };
}

// Pass force when you want a rebuild after editing this file. The pretest
// run does; the before() hooks don't, they only fill in a cold checkout.
export async function generateFixtures({ force = false } = {}) {
  const paths = fixturePaths();
  mkdirSync(FIXTURES_DIR, { recursive: true });

  if (!force && allPresent(paths)) return paths;

  writeAtomic(paths.imagePath, makePng('TEST IMAGE', '#2563eb'));
  writeAtomic(paths.pdfPath, makeTwoPagePdf());
  writeAtomic(paths.docxPath, await makeDocx());
  writeAtomic(paths.pptxPath, await makePptx());
  // Reads the four files above back off disk, so it has to run last.
  writeAtomic(paths.zipPath, makeZipBundle(paths));

  return paths;
}

function allPresent(paths) {
  return Object.values(paths).every(isPresent);
}

function isPresent(filePath) {
  return existsSync(filePath) && statSync(filePath).size > 0;
}

// Write to a temp name in the same directory, then rename onto the target.
// Rename is atomic, so a reader gets either the whole old file or the
// whole new one, never a half-written one.
function writeAtomic(targetPath, contents) {
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpPath, contents);
    renameSync(tmpPath, targetPath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    // Windows refuses a rename onto a file another process has open, and
    // on a cold checkout several test processes generate at once. Any
    // complete fixture works, so if someone else landed one first, take
    // theirs. Nothing there means the failure was real.
    if (!isPresent(targetPath)) throw error;
  }
}

function makePng(label, color) {
  const canvas = createCanvas(200, 100);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 200, 100);
  ctx.fillStyle = '#ffffff';
  ctx.font = '16px sans-serif';
  ctx.fillText(label, 10, 55);
  return canvas.toBuffer('image/png');
}

function makeTwoPagePdf() {
  // Hand-built minimal two-page PDF (no external PDF library needed for
  // something this small/fixed). pdf.js reconstructs the object table by
  // scanning when there's no xref section, so one is deliberately omitted
  // here - the same approach that works for the single-page fixture.
  const streamContent = (text) => `BT /F1 20 Tf 20 100 Td (${text}) Tj ET`;
  const stream1 = streamContent('Page One Content');
  const stream2 = streamContent('Page Two Content');

  return Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /MediaBox [0 0 300 200] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length ${stream1.length} >>
stream
${stream1}
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
6 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /MediaBox [0 0 300 200] /Contents 7 0 R >>
endobj
7 0 obj
<< /Length ${stream2.length} >>
stream
${stream2}
endstream
endobj
trailer
<< /Size 8 /Root 1 0 R >>
%%EOF
`);
}

async function makeDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>This is a test DOCX document for the AMI extraction pipeline.</w:t></w:r></w:p>
    <w:p><w:r><w:t>It contains one embedded image alongside this text.</w:t></w:r></w:p>
  </w:body>
</w:document>`);
  zip.file('word/media/image1.png', makePng('DOCX IMG', '#16a34a'));
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function makePptx() {
  const zip = new JSZip();
  const slideXml = (text) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`;
  zip.file('ppt/slides/slide1.xml', slideXml('Slide one: quarterly results overview'));
  zip.file('ppt/slides/slide2.xml', slideXml('Slide two: architecture diagram'));
  zip.file('ppt/media/image1.png', makePng('SLIDE IMG', '#dc2626'));
  return zip.generateAsync({ type: 'nodebuffer' });
}

function makeZipBundle({ imagePath, pdfPath, docxPath, pptxPath }) {
  const zip = new AdmZip();
  zip.addLocalFile(imagePath, '', 'photo.png');
  zip.addLocalFile(pdfPath, '', 'report.pdf');
  zip.addLocalFile(docxPath, 'nested', 'memo.docx');
  zip.addLocalFile(pptxPath, 'nested', 'deck.pptx');
  zip.addFile('readme.txt', Buffer.from('This file type is unsupported and should be skipped.'));
  return zip.toBuffer();
}

// String-building the file: URL here silently never matched on Windows
// (or for an absolute posix path), so pretest was a no-op and the tests
// were left to generate their own fixtures. pathToFileURL gets it right.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = await generateFixtures({ force: true });
  console.log('Generated fixtures:', paths);
}
