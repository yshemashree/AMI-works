// Everything the UI says to the server goes through here.

async function json(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw toError(body, res.status);
  return body;
}

function toError(body, status) {
  const error = new Error(body?.error?.message || `Request failed (${status})`);
  error.code = body?.error?.code;
  return error;
}

export const api = {
  status: () => json('/api/status'),
  listFolder: (folderId) => json(`/api/drive/files?folderId=${encodeURIComponent(folderId)}`),
  readFile: (id) => json(`/api/drive/file?id=${encodeURIComponent(id)}`),
  signOut: () => json('/auth/signout', { method: 'POST' }),

  /**
   * Uploads one file with real byte progress (fetch can't report upload
   * progress, XHR can). `mode` is 'drive' (upload + read) or 'extract'.
   */
  upload(file, { mode, folderId, onProgress }) {
    const url = mode === 'drive' ? `/api/upload?folderId=${encodeURIComponent(folderId)}` : '/api/extract';
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.responseType = 'json';
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.upload.onload = () => onProgress?.(1);
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.onload = () => {
        const body = xhr.response || {};
        if (xhr.status >= 400) return reject(toError(body, xhr.status));
        const result = body.results?.[0];
        if (!result) return reject(new Error('Server returned no result'));
        if (result.error) return reject(toError(result, xhr.status));
        resolve(result);
      };
      const form = new FormData();
      form.append('file', file, file.name);
      xhr.send(form);
    });
  },

  /** Reads a whole folder; calls onEvent for every line the server streams back. */
  async readFolder(folderId, onEvent) {
    const res = await fetch(`/api/drive/read-folder?folderId=${encodeURIComponent(folderId)}`, { method: 'POST' });
    if (!res.ok) throw toError(await res.json().catch(() => ({})), res.status);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) onEvent(JSON.parse(line));
      }
    }
  },
};
