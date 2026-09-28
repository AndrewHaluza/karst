import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hydrateWebview, type WebviewName } from '../../model/webviewChains.js';
import { injectCsp, newNonce } from '../../model/csp.js';
import type { BrandIconPaths } from '../brandIcon.js';
import { brandIconUri } from '../panelIcon.js';
import { RUNTIME_ASSETS_ROOT } from '../../runtimeAssetsRoot.js';

/**
 * Shared activation-layer adapter for the panel shape several single-instance
 * webviews need: one always-Active-column panel with the brand icon and a
 * fresh CSP nonce per panel, and no per-panel state beyond `reveal` /
 * `postMessage` / `onDidReceiveMessage` / `onDidDispose`. Used by the usage,
 * resources and server-logs hosts — none of which carry a ticket-scoped view
 * column or activation reporting, unlike the dashboard and changes panels.
 */
export function makeSimplePanelHost<P>(
  context: vscode.ExtensionContext, view: string, viewType: string, brandIcon?: BrandIconPaths,
): { createPanel(title: string): P } {
  const html = hydrateWebview(view as WebviewName, readFileSync(join(RUNTIME_ASSETS_ROOT, 'ui', view, 'webview.html'), 'utf8'));
  return {
    createPanel(title) {
      const panel = vscode.window.createWebviewPanel(
        viewType,
        title,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      context.subscriptions.push(panel);
      panel.iconPath = brandIconUri(brandIcon);
      panel.webview.html = injectCsp(html, newNonce());
      return {
        reveal: (keepFocus: boolean | undefined) => panel.reveal(undefined, keepFocus),
        postMessage: (message: unknown) => void panel.webview.postMessage(message),
        onDidReceiveMessage: (handler: (message: unknown) => void) =>
          panel.webview.onDidReceiveMessage(handler, undefined, context.subscriptions),
        onDidDispose: (handler: () => void) => panel.onDidDispose(handler, undefined, context.subscriptions),
      } as P;
    },
  };
}
