import { createStore } from './dom.js';
import { api } from './api.js';
import { mountStatusBar } from './components/statusBar.js';
import { mountUploadPanel } from './components/uploadPanel.js';
import { mountDriveBrowser } from './components/driveBrowser.js';
import { mountDocumentViewer } from './components/documentViewer.js';

// Each panel is its own component; they only share this store.
const store = createStore({ status: null, folderId: '', document: null, documentTitle: '', driveRefresh: null });

mountStatusBar(document.getElementById('status'), store);
mountUploadPanel(document.getElementById('upload'), store);
mountDriveBrowser(document.getElementById('drive'), store);
mountDocumentViewer(document.getElementById('viewer'), store);

// Back from Google sign-in: pick up the outcome, then tidy the URL.
const params = new URLSearchParams(location.search);
if (params.has('authError')) store.set({ authError: params.get('authError') });
if (params.has('signedIn') || params.has('authError')) history.replaceState(null, '', '/');

try {
  const status = await api.status();
  const remembered = safeGet('ami.folderId');
  store.set({ status, folderId: remembered || status.defaults.folderId || '' });
} catch (error) {
  store.set({ statusError: error.message });
}

// Remember the last folder per browser - a convenience, not state.
store.subscribe(({ folderId }) => safeSet('ami.folderId', folderId || ''));

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode / blocked storage
  }
}
