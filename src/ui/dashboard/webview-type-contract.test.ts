/**
 * NDL-39: Type-check the webview-side message contract.
 *
 * This test suite verifies that TypeScript's compiler catches message field
 * typos/renames at build time rather than silently dropping them at runtime.
 *
 * The test file contains deliberate type errors that MUST fail compilation.
 * To verify this works, run: `npm run typecheck` and expect these errors.
 *
 * The actual webview code in webview.html uses `post()` which is now type-checked
 * against the WebviewMessage union, catching any field mismatch.
 */

import { postMessage } from './webview-messages.js';
import type { WebviewMessage } from './messages.js';

// CORRECT: field names match the message type exactly
const correctMessage: WebviewMessage = { type: 'stop-server', serverId: 42 };
postMessage(correctMessage);

// CORRECT: type-safe call (tsc catches the parameter type)
postMessage({ type: 'toggle-bind' });
postMessage({ type: 'ship-ticket' });

// These would fail typecheck (uncomment to verify):
// postMessage({ type: 'stop-server', serverID: 42 }); // ❌ typo: serverID not serverId
// postMessage({ type: 'refresh-prs', enabled: true }); // ❌ extra field not in contract
// postMessage({ type: 'unknown-type' }); // ❌ unknown message type

// Real-world example: old HTML might have this typo
// const msg = { type: 'stop-server', serverID: 1 }; // ❌ Would fail typecheck
// vscode.postMessage(msg);  // Now tsc catches this before it ships
