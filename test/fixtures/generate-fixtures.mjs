// Generates small, deterministic test fixtures (image/pdf/docx/pptx/xlsx/zip)
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
    richPptxPath: path.join(FIXTURES_DIR, 'rich.pptx'),
    xlsxPath: path.join(FIXTURES_DIR, 'sample.xlsx'),
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
  writeAtomic(paths.richPptxPath, await makeRichPptx());
  writeAtomic(paths.xlsxPath, await makeXlsx());
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

function makePng(label, color, width = 200, height = 100) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.font = '16px sans-serif';
  ctx.fillText(label, 10, 55);
  return canvas.toBuffer('image/png');
}

function makeTwoPagePdf() {
  return buildPdf(['Page One Content', 'Page Two Content']);
}

/**
 * Hand-built minimal PDF, one text line per page (no PDF library needed
 * for something this small). pdf.js rebuilds the object table by
 * scanning when there's no xref section, so one is deliberately omitted.
 * `drawBoxes` adds a run of vector rectangles to a page, which the
 * reader's triage should read as "chart or diagram".
 */
export function buildPdf(pageTexts, { drawBoxes = [] } = {}) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add(null);
  const pages = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = pageTexts.map((text, i) => {
    let content = `BT /F1 12 Tf 20 150 Td (${text}) Tj ET`;
    if (drawBoxes.includes(i)) {
      for (let n = 0; n < 40; n++) content += `\n${10 + n * 6} 20 4 ${10 + n} re f`;
    }
    const stream = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    return add(`<< /Type /Page /Parent ${pages} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> /MediaBox [0 0 600 200] /Contents ${stream} 0 R >>`);
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
  objects[pages - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  const body = objects.map((obj, i) => `${i + 1} 0 obj\n${obj}\nendobj`).join('\n');
  return Buffer.from(`%PDF-1.4\n${body}\ntrailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\n%%EOF\n`);
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

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function rels(list) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${list.map(([id, type, target]) => `  <Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('\n')}
</Relationships>`;
}

// A deck that exercises everything the PPTX reader does beyond text:
// speaker notes, a picture repeated on two slides (once by reference,
// once as a byte-identical copy), an icon too small to be worth a vision
// call, a native chart with real numbers, and document properties.
async function makeRichPptx() {
  const zip = new JSZip();
  const logo = makePng('LOGO', '#7c3aed');
  const slide = (text) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`;

  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
  <dc:title>Board deck Q3</dc:title><dc:creator>Finance &amp; Ops</dc:creator>
  <dcterms:created>2026-09-01T09:00:00Z</dcterms:created>
</cp:coreProperties>`);
  zip.file('ppt/slides/slide1.xml', slide('Revenue overview'));
  zip.file('ppt/slides/_rels/slide1.xml.rels', rels([['rId1', 'image', '../media/image1.png'], ['rId2', 'notesSlide', '../notesSlides/notesSlide1.xml']]));
  zip.file('ppt/slides/slide2.xml', slide('Team update'));
  zip.file('ppt/slides/_rels/slide2.xml.rels', rels([['rId1', 'image', '../media/image1.png'], ['rId2', 'image', '../media/image2.png']]));
  zip.file('ppt/slides/slide10.xml', slide('Quarterly chart'));
  zip.file('ppt/slides/_rels/slide10.xml.rels', rels([['rId1', 'chart', '../charts/chart1.xml'], ['rId2', 'image', '../media/icon.png']]));
  zip.file('ppt/notesSlides/notesSlide1.xml', slide('Mention the Q3 jump'));
  zip.file('ppt/charts/chart1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <c:chart>
    <c:title><c:tx><c:rich><a:p><a:r><a:t>Revenue vs Cost</a:t></a:r></a:p></c:rich></c:tx></c:title>
    <c:plotArea><c:barChart>
      <c:ser>
        <c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Revenue</c:v></c:pt></c:strCache></c:strRef></c:tx>
        <c:cat><c:strRef><c:strCache><c:pt idx="1"><c:v>Q2</c:v></c:pt><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="2"><c:v>Q3</c:v></c:pt></c:strCache></c:strRef></c:cat>
        <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>4.2</c:v></c:pt><c:pt idx="1"><c:v>5.1</c:v></c:pt><c:pt idx="2"><c:v>6.3</c:v></c:pt></c:numCache></c:numRef></c:val>
      </c:ser>
      <c:ser>
        <c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Cost</c:v></c:pt></c:strCache></c:strRef></c:tx>
        <c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt><c:pt idx="2"><c:v>Q3</c:v></c:pt></c:strCache></c:strRef></c:cat>
        <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>3</c:v></c:pt><c:pt idx="1"><c:v>3.2</c:v></c:pt><c:pt idx="2"><c:v>3.9</c:v></c:pt></c:numCache></c:numRef></c:val>
      </c:ser>
    </c:barChart></c:plotArea>
  </c:chart>
</c:chartSpace>`);
  zip.file('ppt/media/image1.png', logo);
  zip.file('ppt/media/image2.png', logo);
  zip.file('ppt/media/icon.png', makePng('', '#000000', 16, 16));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function makeXlsx() {
  const zip = new JSZip();
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}">
  <sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; misc" sheetId="2" r:id="rId2"/></sheets>
</workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', rels([['rId1', 'worksheet', 'worksheets/sheet1.xml'], ['rId2', 'worksheet', 'worksheets/sheet2.xml']]));
  zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Item</t></si><si><t>Cost</t></si><si><r><t>Cloud</t></r><r><t> credits</t></r></si></sst>`);
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Approved</t></is></c></row>
  <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>5000</v></c><c r="C2" t="b"><v>1</v></c></row>
  <row r="3"><c r="A3" t="inlineStr"><is><t>Travel</t></is></c><c r="C3" t="b"><v>0</v></c></row>
</sheetData></worksheet>`);
  zip.file('xl/worksheets/sheet2.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
  <row r="1"><c r="B1" t="inlineStr"><is><t>only B</t></is></c></row>
</sheetData></worksheet>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function makeZipBundle({ imagePath, pdfPath, docxPath, pptxPath }) {
  const zip = new AdmZip();
  zip.addLocalFile(imagePath, '', 'photo.png');
  zip.addLocalFile(pdfPath, '', 'report.pdf');
  zip.addLocalFile(docxPath, 'nested', 'memo.docx');
  zip.addLocalFile(pptxPath, 'nested', 'deck.pptx');
  zip.addFile('readme.txt', Buffer.from('Plain text notes travel with the bundle.'));
  zip.addFile('tool.exe', Buffer.from('MZ not really an executable'));
  zip.addFile('__MACOSX/._photo.png', Buffer.from('resource fork noise'));
  return zip.toBuffer();
}

// String-building the file: URL here silently never matched on Windows
// (or for an absolute posix path), so pretest was a no-op and the tests
// were left to generate their own fixtures. pathToFileURL gets it right.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = await generateFixtures({ force: true });
  console.log('Generated fixtures:', paths);
}
