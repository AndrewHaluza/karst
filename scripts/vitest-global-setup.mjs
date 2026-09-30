// Vitest globalSetup: build the webview bundles (message senders + the
// settings React app) before any test file loads, so unit/render tests that
// hydrate the dashboard or settings webview can read them from
// RUNTIME_ASSETS_ROOT (the src root in the unbundled test world).
import { buildWebviewBundles } from './build-webview-send.mjs';

export default async function setup() {
  await buildWebviewBundles();
}
