import { h, clear } from '../dom.js';
import { api } from '../api.js';

/** Header pills: Drive connection and whether MarkItDown is running. */
export function mountStatusBar(root, store) {
  function render({ status, statusError, authError }) {
    if (statusError) {
      clear(root, h('span', { class: 'pill bad', text: `Server unreachable: ${statusError}` }));
      return;
    }
    if (!status) {
      clear(root, h('span', { class: 'pill', text: 'Checking…' }));
      return;
    }

    const { drive, markitdown } = status;
    const pills = [];

    if (authError && !drive.signedIn) {
      pills.push(
        h('span', { class: 'pill bad', title: authError, text: `Sign-in failed: ${authError}` }),
        h('button', { class: 'btn link small', onclick: () => store.set({ authError: null }), text: 'Dismiss' }),
      );
    }

    if (drive.signedIn) {
      pills.push(h('span', { class: 'pill ok', text: 'Drive connected' }));
      pills.push(h('button', { class: 'btn link small', onclick: signOut, text: 'Sign out' }));
    } else if (drive.serviceAccount) {
      pills.push(h('span', { class: 'pill warn', text: 'Drive read-only (service account)' }));
    } else {
      pills.push(h('span', { class: 'pill bad', text: 'Drive not connected' }));
    }
    if (!drive.signedIn) {
      pills.push(
        drive.oauthConfigured
          ? h('a', { class: 'btn small primary', href: '/auth/google', text: 'Connect Google Drive' })
          : h('span', { class: 'muted', text: 'Set GOOGLE_OAUTH_CLIENT_ID/SECRET to enable uploads' }),
      );
    }

    pills.push(
      markitdown.available
        ? h('span', { class: 'pill ok', title: 'Richer markdown for Office, CSV and HTML files', text: markitdown.label })
        : h('span', { class: 'pill', title: 'Install with: pip install -r src/markitdown/requirements.txt', text: 'Built-in readers' }),
    );
    clear(root, pills);
  }

  async function signOut() {
    await api.signOut();
    store.set({ status: await api.status() });
  }

  store.subscribe(render);
  render(store.get());
}
