import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangesPanel, ChangesPanelHost } from './panel.js';
import { hydrateWebview } from '../../model/webviewChains.js';
import { injectCsp, newNonce } from '../../model/csp.js';
import type { BrandIconPaths } from '../brandIcon.js';
import { brandIconUri } from '../panelIcon.js';
import { RUNTIME_ASSETS_ROOT } from '../../runtimeAssetsRoot.js';
import { DisposableBag } from './hostResources.js';

/**
 * Activation-layer adapter: real webview panels wrapped in the host-agnostic
 * `ChangesPanelHost` interface. This is the one place `vscode` webview APIs
 * bind to `TicketChangesManager`; everything below it is tested with fakes.
 *
 * Named `host.ts` for the webview panel specifically, to match the other
 * screens' activation adapter — distinct from this folder's `treeHost.ts`
 * (the SCM tree view's `vscode.TreeDataProvider` adapter) and
 * `hostResources.ts` (the panel-lifetime-scoped disposable bag and virtual
 * document registry), which are adapters for different vscode subsystems and
 * keep their own names.
 */
export function makeChangesPanelHost(
  context: vscode.ExtensionContext,
  brandIcon?: BrandIconPaths,
): ChangesPanelHost {
  const html = hydrateWebview('diffs', readFileSync(join(RUNTIME_ASSETS_ROOT, 'ui', 'diffs', 'webview.html'), 'utf8'));
  return {
    createPanel(title, _ticketId): ChangesPanel {
      const panel = vscode.window.createWebviewPanel(
        'karst.changes',
        title,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      // The panel itself, not only its listeners: without this the webview
      // outlives extension unload with no owner. VS Code tolerates a second
      // dispose of an already-closed panel.
      context.subscriptions.push(panel);
      panel.iconPath = brandIconUri(brandIcon);
      panel.webview.html = injectCsp(html, newNonce());
      const listeners = new DisposableBag();
      return {
        reveal: () => panel.reveal(),
        // Read per call, not captured: the user can drag the panel to another
        // group, and the diff belongs beside wherever it is NOW.
        viewColumn: () => panel.viewColumn,
        postMessage: (message) => void panel.webview.postMessage(message),
        onDidReceiveMessage: (handler) => {
          listeners.add(panel.webview.onDidReceiveMessage(handler));
        },
        onDidChangeViewState: (handler) =>
          panel.onDidChangeViewState(
            (e) => handler(e.webviewPanel.active),
            undefined,
            context.subscriptions,
          ),
        onDidDispose: (handler) => {
          listeners.add(panel.onDidDispose(() => {
            try {
              handler();
            } finally {
              listeners.dispose();
            }
          }));
        },
      };
    },
  };
}
