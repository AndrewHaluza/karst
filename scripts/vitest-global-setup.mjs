// Vitest globalSetup: build the webview message-sender bundles before any test
// file loads, so unit/render tests that hydrate the dashboard or settings
// webview can read `src/ui/<view>/webviewSend.webview.js` from
// RUNTIME_ASSETS_ROOT (the src root in the unbundled test world).
import { buildWebviewSenders } from './build-webview-send.mjs';

export default async function setup() {
  await buildWebviewSenders();
}
