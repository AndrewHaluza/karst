/**
 * esbuild entry for the settings React app → `src/ui/settings/app.webview.js`
 * (built by `scripts/build-webview-send.mjs`, NDL-126 §1).
 *
 * Until phase 4 this bundle is NOT injected into `webview.html`; it is built,
 * bundled and tested so the switch-over merge is a single revert unit.
 *
 * React 19's `createRoot().render()` takes no completion callback, so the
 * `data-karst-ready` flag that `renderWebviewReady` waits on (NDL-126 §4) is set
 * from an effect in `App`, after the first commit.
 */
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const container = document.getElementById('root');

if (!container) {
  throw new Error('settings app: #root element is missing from the document');
}

createRoot(container).render(<App />);
