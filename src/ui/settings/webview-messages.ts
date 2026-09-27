/**
 * Settings webview-side message posting with full type checking against
 * src/ui/settings/messages.ts. TypeScript compilation ensures all postMessage
 * calls match the SettingsWebviewMessage type contract.
 */

import type { SettingsWebviewMessage, SettingsHostMessage } from './messages.js';

declare const acquireVsCodeApi: () => { postMessage(msg: unknown): void };

const vscode = acquireVsCodeApi();

/**
 * Post a message to the host with full type checking.
 */
export function postMessage<T extends SettingsWebviewMessage>(msg: T): void {
  vscode.postMessage(msg);
}

/**
 * Message listener registration with type checking.
 */
export function onMessage(handler: (msg: SettingsHostMessage) => void): void {
  window.addEventListener('message', (e) => {
    handler(e.data as SettingsHostMessage);
  });
}

export type { SettingsWebviewMessage, SettingsHostMessage } from './messages.js';
