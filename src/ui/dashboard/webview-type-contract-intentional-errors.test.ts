/**
 * INTENTIONAL TYPE ERRORS - DO NOT REMOVE
 *
 * This file demonstrates what happens when you typo a field name in a message.
 * These errors are EXPECTED and prove that NDL-39's goal is achieved: tsc catches
 * silent-drop failures at build time.
 *
 * To see these errors, uncomment the lines below and run: `npm run typecheck`
 * Expected: type errors on the incorrect field names.
 *
 * This file is not executed, only type-checked. Real webview code in webview.html
 * uses the type-safe `postMessage()` function from webview-messages.ts.
 */

import { postMessage } from './webview-messages.js';

// ❌ ERROR: typo in field name (serverID instead of serverId)
// postMessage({ type: 'stop-server', serverID: 42 });

// ❌ ERROR: extra field that doesn't match message type
// postMessage({ type: 'refresh-prs', enabled: true });

// ❌ ERROR: unknown message type
// postMessage({ type: 'unknown-action' });

// ❌ ERROR: missing required field
// postMessage({ type: 'stop-server' });
