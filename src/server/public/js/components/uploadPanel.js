import { h, clear, formatBytes } from '../dom.js';
import { api } from '../api.js';

const PARALLEL_UPLOADS = 2;

/**
 * Drop zone + upload queue. Two modes:
 *  - drive:   stream to Drive and read into JSON in the same pass
 *  - extract: read into JSON only; nothing is stored anywhere
 */
export function mountUploadPanel(root, store) {
  const queue = [];
  let active = 0;
  let mode = 'extract';
  let userPicked = false;

  const folderInput = h('input', {
    type: 'text',
    placeholder: 'Drive folder id',
    'aria-label': 'Drive folder id',
    oninput: (e) => store.set({ folderId: e.target.value.trim() }),
  });
  const modeButtons = {
    drive: h('button', { type: 'button', onclick: () => pick('drive'), text: 'Upload to Drive + read' }),
    extract: h('button', { type: 'button', onclick: () => pick('extract'), text: 'Read only' }),
  };
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => addFiles(e.target.files) });
  const hint = h('span', { class: 'muted' });
  const dropzone = h(
    'div',
    {
      class: 'dropzone',
      role: 'button',
      tabindex: '0',
      onclick: () => fileInput.click(),
      onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && fileInput.click(),
      ondragover: (e) => {
        e.preventDefault();
        dropzone.classList.add('over');
      },
      ondragleave: () => dropzone.classList.remove('over'),
      ondrop: (e) => {
        e.preventDefault();
        dropzone.classList.remove('over');
        addFiles(e.dataTransfer.files);
      },
    },
    h('strong', { text: 'Drop files here or click to browse' }),
    hint,
  );
  const list = h('ul', { class: 'queue' });

  clear(
    root,
    h('div', { class: 'card-head' }, h('h2', { id: 'upload-title', text: 'Upload' }), h('div', { class: 'segmented' }, modeButtons.drive, modeButtons.extract)),
    h('label', { class: 'field' }, 'Target Drive folder', folderInput),
    dropzone,
    fileInput,
    list,
  );

  function pick(next) {
    userPicked = true;
    setMode(next);
  }

  function setMode(next) {
    mode = next;
    for (const [key, btn] of Object.entries(modeButtons)) btn.setAttribute('aria-pressed', String(key === mode));
    folderInput.disabled = mode !== 'drive';
    hint.textContent =
      mode === 'drive'
        ? 'PDF, Word, PowerPoint, Excel, images, CSV, HTML, ZIP… Streamed to Drive, read on the way through.'
        : 'Read into JSON only. The file is not stored anywhere.';
  }

  function addFiles(files) {
    for (const file of files) {
      const item = { file, mode, state: 'queued', progress: 0 };
      item.el = renderItem(item);
      list.prepend(item.el);
      queue.push(item);
    }
    fileInput.value = '';
    pump();
  }

  function pump() {
    while (active < PARALLEL_UPLOADS && queue.length) {
      const item = queue.shift();
      active++;
      run(item).finally(() => {
        active--;
        pump();
      });
    }
  }

  async function run(item) {
    const folderId = store.get().folderId;
    if (item.mode === 'drive' && !folderId) return update(item, { state: 'failed', message: 'Set a Drive folder id first' });

    update(item, { state: 'sending' });
    try {
      const result = await api.upload(item.file, {
        mode: item.mode,
        folderId,
        onProgress: (p) => update(item, p >= 1 ? { state: 'reading', progress: 1 } : { progress: p }),
      });
      const verified = result.checksumMatches === true ? ' · checksum verified' : '';
      update(item, { state: 'done', result, message: summary(result.document) + verified });
      store.set({ document: result.document, documentTitle: item.file.name });
      if (item.mode === 'drive') store.set({ driveRefresh: Date.now() });
    } catch (error) {
      update(item, { state: 'failed', message: error.message });
    }
  }

  function update(item, patch) {
    Object.assign(item, patch);
    const fresh = renderItem(item);
    item.el.replaceWith(fresh);
    item.el = fresh;
  }

  function renderItem(item) {
    const barClass = { done: 'bar done', failed: 'bar failed', reading: 'bar busy' }[item.state] || 'bar';
    const label = {
      queued: 'Waiting',
      sending: `${item.mode === 'drive' ? 'Uploading' : 'Sending'} ${Math.round(item.progress * 100)}%`,
      reading: item.mode === 'drive' ? 'Saving to Drive and reading…' : 'Reading…',
      done: 'Done',
      failed: 'Failed',
    }[item.state];
    const tagClass = { done: 'tag ok', failed: 'tag bad' }[item.state] || 'tag accent';

    return h(
      'li',
      {},
      h(
        'div',
        { class: 'top' },
        h('span', { class: 'name', title: item.file.name, text: item.file.name }),
        h('span', { class: tagClass, text: label }),
      ),
      h('div', { class: barClass }, h('span', { style: { width: `${Math.round(item.progress * 100)}%` } })),
      h(
        'div',
        { class: 'top' },
        h('span', { class: 'muted', text: [formatBytes(item.file.size), item.message].filter(Boolean).join(' · ') }),
        item.result?.document &&
          h('button', {
            class: 'btn small',
            onclick: () => store.set({ document: item.result.document, documentTitle: item.file.name }),
            text: 'View JSON',
          }),
      ),
    );
  }

  store.subscribe(({ status, folderId }) => {
    if (document.activeElement !== folderInput && folderInput.value !== (folderId || '')) folderInput.value = folderId || '';
    if (!status) return;
    const canUpload = status.drive.canUpload;
    modeButtons.drive.disabled = !canUpload;
    // Default to Drive once we know it's connected, unless the user chose.
    if (!userPicked && canUpload && mode !== 'drive') setMode('drive');
    if (!canUpload && mode === 'drive') setMode('extract');
  });
  setMode('extract');
}

function summary(doc) {
  if (!doc) return '';
  const s = doc.stats || {};
  const parts = [];
  if (s.pages) parts.push(`${s.pages} pages`);
  if (s.slides) parts.push(`${s.slides} slides`);
  if (s.sheets) parts.push(`${s.sheets} sheets`);
  if (s.files) parts.push(`${s.files} files`);
  if (s.words) parts.push(`${s.words.toLocaleString()} words`);
  if (s.images) parts.push(`${s.images} images`);
  return parts.join(', ');
}
