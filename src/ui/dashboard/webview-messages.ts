/**
 * Dashboard webview-side message posting with full type checking against
 * src/ui/dashboard/messages.ts. TypeScript compilation ensures all postMessage
 * calls match the WebviewMessage type contract—typos/renamed fields are caught
 * at build time, never silently dropped at runtime.
 */

import type { WebviewMessage, HostMessage } from './messages.js';

declare const acquireVsCodeApi: () => { postMessage(msg: unknown): void };

const vscode = acquireVsCodeApi();

/**
 * Post a message to the host with full type checking.
 * TypeScript compiler validates each call's message shape against WebviewMessage.
 */
export function postMessage<T extends WebviewMessage>(msg: T): void {
  vscode.postMessage(msg);
}

/**
 * Message listener registration with type checking.
 * HostMessage is the closed union of all valid host → webview messages.
 */
export function onMessage(handler: (msg: HostMessage) => void): void {
  window.addEventListener('message', (e) => {
    handler(e.data as HostMessage);
  });
}

// Re-export types so webview code can import them and get autocomplete
export type { WebviewMessage, HostMessage } from './messages.js';
