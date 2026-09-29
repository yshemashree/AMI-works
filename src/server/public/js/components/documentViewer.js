import { h, clear, formatBytes } from '../dom.js';

const TABS = ['Summary', 'Text', 'Markdown', 'JSON'];

/** Shows the JSON the reader produced: a readable summary plus the raw JSON to download. */
export function mountDocumentViewer(root, store) {
  let tab = 'Summary';
  const stackBack = []; // for stepping into a file inside a ZIP and back out
  let navigatingInside = false;

  function render({ document: doc, documentTitle }) {
    if (!doc) {
      clear(
        root,
        h('div', { class: 'card-head' }, h('h2', { id: 'viewer-title', text: 'Result' })),
        h('div', { class: 'empty', text: 'Upload a file or read one from Drive - its JSON shows up here.' }),
      );
      return;
    }

    // A tab this document doesn't have (no markdown for a folder, say)
    // falls back to the summary instead of showing an empty panel.
    if (tab === 'Markdown' && !doc.markdown) tab = 'Summary';

    const json = JSON.stringify(doc, null, 2);
    const tabs = h(
      'div',
      { class: 'tabs', role: 'tablist' },
      TABS.map((name) =>
        h('button', {
          role: 'tab',
          'aria-selected': String(tab === name),
          disabled: name === 'Markdown' && !doc.markdown,
          onclick: () => {
            tab = name;
            render(store.get());
          },
          text: name,
        }),
      ),
    );

    const actions = h(
      'div',
      { class: 'row' },
      stackBack.length ? h('button', { class: 'btn small', onclick: back, text: '← Back' }) : null,
      h('button', { class: 'btn small', onclick: () => copy(json), text: 'Copy JSON' }),
      h('button', { class: 'btn small primary', onclick: () => download(json, documentTitle), text: 'Download .json' }),
    );

    let content;
    if (tab === 'JSON') content = h('pre', { class: 'code', text: json });
    else if (tab === 'Text') content = h('pre', { class: 'code', text: doc.text || textOfFolder(doc) || '(no text)' });
    else if (tab === 'Markdown') content = h('pre', { class: 'code', text: doc.markdown || '' });
    else content = doc.schema === 'ami.folder/v1' ? folderSummary(doc) : summary(doc);

    clear(
      root,
      h('div', { class: 'card-head' }, h('div', {}, h('h2', { id: 'viewer-title', text: documentTitle || doc.source?.name || 'Result' }), h('p', { class: 'muted mono', text: `${doc.schema} · ${formatBytes(json.length)} of JSON` })), actions),
      tabs,
      content,
    );
  }

  function summary(doc) {
    const s = doc.stats || {};
    const stat = (value, label, showZero = false) =>
      value || (showZero && value === 0) ? h('div', { class: 'stat' }, h('b', { text: Number(value).toLocaleString() }), h('span', { text: label })) : null;
    // PDF pages are rendered for vision; everything else sends pictures.
    const visionCalls = doc.source?.type === 'pdf' ? s.sectionsNeedingVision : s.imagesNeedingVision;
    const blocks = [];

    blocks.push(
      h('div', { class: 'stats' },
        stat(s.pages, 'pages'), stat(s.slides, 'slides'), stat(s.sheets, 'sheets'), stat(s.files, 'files'),
        stat(s.words, 'words'), stat(s.images, 'images'), stat(s.charts, 'native charts'),
        stat(visionCalls, 'would need a vision call', !doc.children?.length),
        stat(doc.timings?.totalMs, 'ms to read')),
    );

    const meta = { type: doc.source?.type, size: formatBytes(doc.source?.sizeBytes), reader: doc.engine?.reader, markdown: doc.engine?.markdown, strategy: doc.engine?.strategy, ...doc.metadata };
    blocks.push(h('div', {}, h('h3', { text: 'Details' }), h('dl', { class: 'meta' }, Object.entries(meta).filter(([, v]) => v).flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: String(v) })]))));

    if (doc.error) blocks.push(h('div', { class: 'notice bad', text: `${doc.error.code}: ${doc.error.message}` }));
    if (doc.warnings?.length) blocks.push(h('div', { class: 'notice' }, doc.warnings.join(' · ')));

    if (doc.children?.length) {
      blocks.push(h('div', {}, h('h3', { text: 'Files in this archive' }), h('div', { class: 'sections' }, doc.children.map((child) =>
        h('div', { class: 'section-item' }, h('div', { class: 'top' },
          h('strong', { text: child.source.path || child.source.name }),
          h('div', { class: 'row' },
            child.error ? h('span', { class: 'tag bad', text: child.error.code }) : h('span', { class: 'tag', text: child.source.type }),
            h('button', { class: 'btn small', onclick: () => open(child), text: 'Open' }))))))));
      if (doc.skipped?.length) blocks.push(h('p', { class: 'muted', text: `Skipped: ${doc.skipped.map((x) => `${x.name} (${x.reason})`).join(', ')}` }));
    }

    if (doc.charts?.length) {
      blocks.push(h('div', {}, h('h3', { text: 'Native charts (read as data, no vision needed)' }), ...doc.charts.map(chartTable)));
    }

    if (doc.sections?.length && !doc.children?.length) {
      blocks.push(h('div', {}, h('h3', { text: 'Sections' }), h('div', { class: 'sections' }, doc.sections.slice(0, 200).map((sec) =>
        h('div', { class: 'section-item' },
          h('div', { class: 'top' },
            h('strong', { text: `${cap(sec.kind)} ${sec.number}${sec.title ? ` · ${sec.title}` : ''}` }),
            h('span', { class: sec.needsVision ? 'tag warn' : 'tag ok', title: sec.visionReason || '', text: sec.needsVision ? 'Visual content' : 'Text covers it' })),
          sec.text ? h('p', { text: sec.text.slice(0, 400) }) : null)))));
    }

    if (doc.images?.length) {
      const rows = doc.images.map((img) =>
        h('tr', {},
          h('td', { class: 'mono', text: img.id }),
          h('td', { class: 'name', text: img.name }),
          h('td', { class: 'num', text: img.width ? `${img.width}×${img.height}` : formatBytes(img.bytes) }),
          h('td', { text: img.section != null ? `#${img.section}` : '—' }),
          h('td', {}, h('span', { class: img.needsVision ? 'tag warn' : 'tag', text: img.needsVision ? 'yes' : img.visionReason }))));
      const head = h('thead', {}, h('tr', {}, ['Id', 'Name', 'Size', 'Where', 'Vision'].map((t) => h('th', { text: t }))));
      blocks.push(h('div', {}, h('h3', { text: 'Images' }), h('div', { class: 'table-wrap' }, h('table', {}, head, h('tbody', {}, rows)))));
    }
    return h('div', { class: 'stack' }, blocks);
  }

  function folderSummary(doc) {
    return h('div', { class: 'stack' },
      h('p', { class: 'muted', text: `${doc.files.length} file(s) read from folder ${doc.folderId}.` }),
      h('div', { class: 'sections' }, doc.files.map((file) =>
        h('div', { class: 'section-item' }, h('div', { class: 'top' },
          h('strong', { text: file.source.name }),
          h('div', { class: 'row' }, h('span', { class: 'tag', text: file.source.type }), h('button', { class: 'btn small', onclick: () => open(file), text: 'Open' })))))));
  }

  function chartTable(chart) {
    const categories = chart.series[0]?.categories || [];
    return h('div', { class: 'table-wrap', style: { marginTop: '6px' } }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: chart.title || chart.type }), chart.series.map((s) => h('th', { text: s.name || '' })))),
      h('tbody', {}, categories.map((cat, i) => h('tr', {}, h('td', { text: cat }), chart.series.map((s) => h('td', { class: 'num', text: String(s.values[i] ?? '') })))))));
  }

  function open(child) {
    const { document: doc, documentTitle } = store.get();
    stackBack.push({ document: doc, documentTitle });
    tab = 'Summary';
    navigatingInside = true;
    store.set({ document: child, documentTitle: child.source.path || child.source.name });
  }

  function back() {
    const previous = stackBack.pop();
    if (!previous) return;
    navigatingInside = true;
    store.set(previous);
  }

  let lastDoc = null;
  store.subscribe((state) => {
    if (state.document === lastDoc) return;
    // A new document from elsewhere (upload, Drive) starts a fresh trail.
    if (!navigatingInside) stackBack.length = 0;
    navigatingInside = false;
    lastDoc = state.document;
    render(state);
  });
  render(store.get());
}

function textOfFolder(doc) {
  return doc.files?.map((f) => `## ${f.source.name}\n\n${f.text}`).join('\n\n');
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // clipboard blocked (http, permissions) - download still works
  }
}

function download(json, title) {
  const name = `${(title || 'document').replace(/[^\w.-]+/g, '_')}.json`;
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
