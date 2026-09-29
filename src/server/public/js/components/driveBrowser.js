import { h, clear, formatBytes } from '../dom.js';
import { api } from '../api.js';

const KIND_LABEL = { export: 'Google file', unsupported: 'Not supported', folder: 'Folder' };

/**
 * Lists a Drive folder, lets you step into subfolders, and reads one
 * file or the whole folder into JSON. Files whose content was read
 * before (same MD5) show as "Ready" and open instantly from the cache.
 */
export function mountDriveBrowser(root, store) {
  let trail = []; // [{ id, name }]
  let files = [];
  let loading = false;
  let error = null;
  let folderProgress = null;
  const busy = new Set();

  const body = h('div', { class: 'stack' });
  const refreshBtn = h('button', { class: 'btn small', onclick: () => load(), text: 'Refresh' });
  const readAllBtn = h('button', { class: 'btn small primary', onclick: readAll, text: 'Read whole folder' });
  clear(
    root,
    h('div', { class: 'card-head' }, h('h2', { id: 'drive-title', text: 'Drive folder' }), h('div', { class: 'row' }, refreshBtn, readAllBtn)),
    body,
  );

  const current = () => trail[trail.length - 1]?.id;

  async function load() {
    const id = current();
    if (!id) return render();
    loading = true;
    error = null;
    render();
    try {
      files = (await api.listFolder(id)).files;
    } catch (e) {
      error = e.message;
      files = [];
    } finally {
      loading = false;
      render();
    }
  }

  async function readOne(entry) {
    busy.add(entry.id);
    render();
    try {
      const { document } = await api.readFile(entry.id);
      entry.cached = true;
      store.set({ document, documentTitle: entry.driveName });
    } catch (e) {
      entry.error = e.message;
    } finally {
      busy.delete(entry.id);
      render();
    }
  }

  async function readAll() {
    const id = current();
    if (!id) return;
    folderProgress = { done: 0, total: files.filter(readable).length, failed: 0 };
    render();
    const documents = [];
    try {
      await api.readFolder(id, (event) => {
        if (event.type === 'file') {
          folderProgress = { ...folderProgress, done: event.done, total: event.total, failed: folderProgress.failed + (event.error ? 1 : 0) };
          const entry = files.find((f) => f.id === event.entry.id);
          if (entry) {
            entry.cached = !event.error;
            entry.error = event.error?.message;
          }
          if (event.document) documents.push(event.document);
          render();
        } else if (event.type === 'error') {
          error = event.error.message;
        }
      });
      // The folder as one JSON: every file's document under `files`.
      store.set({
        document: { schema: 'ami.folder/v1', folderId: id, readAt: new Date().toISOString(), files: documents },
        documentTitle: `${trail[trail.length - 1].name} (${documents.length} files)`,
      });
    } catch (e) {
      error = e.message;
    } finally {
      folderProgress = null;
      render();
    }
  }

  function render() {
    const status = store.get().status;
    readAllBtn.disabled = !current() || loading || Boolean(folderProgress) || !files.some(readable);
    refreshBtn.disabled = !current() || loading;

    const blocks = [];
    if (status && !status.drive.canRead) {
      blocks.push(h('div', { class: 'notice', text: 'Connect Google Drive (top right) or configure a service account to browse folders.' }));
    }
    if (!current()) {
      blocks.push(h('div', { class: 'empty', text: 'Enter a Drive folder id in the Upload panel to browse it here.' }));
      return clear(body, blocks);
    }

    blocks.push(
      h(
        'nav',
        { class: 'crumbs', 'aria-label': 'Folder path' },
        trail.flatMap((crumb, i) => [
          i > 0 ? h('span', { class: 'muted', text: '/' }) : null,
          i < trail.length - 1
            ? h('button', { class: 'folder-link', onclick: () => ((trail = trail.slice(0, i + 1)), load()), text: crumb.name })
            : h('strong', { text: crumb.name }),
        ]),
      ),
    );
    if (folderProgress) {
      const pct = folderProgress.total ? Math.round((folderProgress.done / folderProgress.total) * 100) : 0;
      blocks.push(
        h('div', {}, h('div', { class: 'muted', text: `Reading ${folderProgress.done} of ${folderProgress.total}${folderProgress.failed ? ` · ${folderProgress.failed} failed` : ''}` }),
          h('div', { class: 'bar' }, h('span', { style: { width: `${pct}%` } }))),
      );
    }
    if (error) blocks.push(h('div', { class: 'notice bad', text: error }));

    if (loading) blocks.push(h('div', { class: 'empty', text: 'Loading…' }));
    else if (!files.length && !error) blocks.push(h('div', { class: 'empty', text: 'This folder is empty.' }));
    else if (files.length) blocks.push(table());
    clear(body, blocks);
  }

  function table() {
    return h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, h('th', { text: 'Name' }), h('th', { class: 'col-size', text: 'Size' }), h('th', { text: 'Status' }), h('th', {}))),
        h('tbody', {}, files.map(row)),
      ),
    );
  }

  function row(entry) {
    const name =
      entry.kind === 'folder'
        ? h('button', { class: 'folder-link', onclick: () => openFolder(entry), text: `${entry.driveName}/` })
        : h('span', { title: entry.driveName, text: entry.driveName });

    let tag;
    if (entry.error) tag = h('span', { class: 'tag bad', title: entry.error, text: 'Failed' });
    else if (entry.cached) tag = h('span', { class: 'tag ok', text: 'Ready' });
    else if (KIND_LABEL[entry.kind]) tag = h('span', { class: entry.kind === 'export' ? 'tag accent' : 'tag', text: KIND_LABEL[entry.kind] });
    else tag = h('span', { class: 'tag', text: 'Not read yet' });

    const action = readable(entry)
      ? h('button', { class: 'btn small', disabled: busy.has(entry.id), onclick: () => readOne(entry), text: busy.has(entry.id) ? 'Reading…' : entry.cached ? 'Open' : 'Read' })
      : null;

    return h('tr', {}, h('td', { class: 'name' }, name), h('td', { class: 'num col-size', text: formatBytes(entry.size) }), h('td', {}, tag), h('td', { class: 'num' }, action));
  }

  function openFolder(entry) {
    trail = [...trail, { id: entry.id, name: entry.driveName }];
    load();
  }

  let lastRoot = null;
  let lastRefresh = null;
  store.subscribe(({ folderId, driveRefresh, status }) => {
    if (folderId !== lastRoot && status?.drive.canRead) {
      lastRoot = folderId;
      trail = folderId ? [{ id: folderId, name: folderId.length > 14 ? `${folderId.slice(0, 12)}…` : folderId }] : [];
      debounceLoad();
    } else if (driveRefresh !== lastRefresh) {
      lastRefresh = driveRefresh;
      if (driveRefresh) load();
    } else {
      render();
    }
  });

  let timer;
  function debounceLoad() {
    clearTimeout(timer);
    timer = setTimeout(load, 400);
  }
  render();
}

function readable(entry) {
  return entry.kind === 'file' || entry.kind === 'export';
}
