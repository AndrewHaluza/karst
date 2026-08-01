import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { SidebarView, SidebarViewHost } from './panel.js';
import { injectPalette } from '../../model/palette.js';
import { injectDesignSystem } from '../../model/designSystem.js';
import { injectCsp, newNonce } from '../../model/csp.js';
import { BadgeCache } from './badgeCache.js';

/**
 * Activation-layer adapter: the real `vscode.WebviewViewProvider` for the sidebar
 * ticket list, wrapped in the host-agnostic `SidebarViewHost` interface. This is
 * the only place the webview-view vscode API binds to `SidebarViewManager`;
 * everything below it is tested with fakes.
 *
 * Unlike the panel webviews (`createWebviewPanel`), a WebviewView is docked in
 * the Activity Bar container and its lifecycle is driven by VS Code calling
 * `resolveWebviewView`. The HTML is read relative to the compiled module so it
 * resolves from `dist/` (copy-assets mirrors it) the same as in tests.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** The view id must match `contributes.views.karst[].id` in package.json. */
export const SIDEBAR_VIEW_ID = 'karst.tickets';

/**
 * Build the `SidebarViewHost` and the `vscode.WebviewViewProvider` to register.
 * Register the returned provider with
 * `vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, provider)`.
 */
export function makeSidebarViewHost(
  context: vscode.ExtensionContext,
): { host: SidebarViewHost; provider: vscode.WebviewViewProvider; badge: BadgeCache } {
  const html = injectPalette(injectDesignSystem(readFileSync(join(HERE, 'webview.html'), 'utf8')));
  let onResolve: ((view: SidebarView) => void) | undefined;
  // The badge outlives any single resolve: VS Code re-resolves the view when it
  // is hidden and shown again, and in a cold window it may never resolve at all.
  const badge = new BadgeCache();

  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView) {
      webviewView.webview.options = { enableScripts: true };
      // Fresh nonce per resolve — the sidebar view is re-resolved when it is
      // hidden and shown again, and each resolve is a new page load.
      webviewView.webview.html = injectCsp(html, newNonce());
      badge.attach({
        setBadge: (value) => {
          webviewView.badge = value;
        },
      });
      // The view is re-resolved on next show; detach now so a `set`/`clear` in
      // between doesn't write to this dead view (and so it isn't retained).
      webviewView.onDidDispose(() => badge.detach());
      const view: SidebarView = {
        postMessage: (message) => void webviewView.webview.postMessage(message),
        onDidReceiveMessage: (handler) =>
          webviewView.webview.onDidReceiveMessage(handler, undefined, context.subscriptions),
      };
      onResolve?.(view);
    },
  };

  const host: SidebarViewHost = {
    onResolve: (handler) => {
      onResolve = handler;
    },
  };

  return { host, provider, badge };
}
