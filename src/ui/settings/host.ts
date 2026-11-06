import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SettingsPanel, SettingsPanelHost } from './panel.js';
import { hydrateWebview } from '../../model/webviewChains.js';
import { injectCsp, newNonce } from '../../model/csp.js';
import type { BrandIconPaths } from '../brandIcon.js';
import { brandIconUri } from '../panelIcon.js';
import type { RestoredPanel } from '../shared/restoredPanel.js';
import { RUNTIME_ASSETS_ROOT } from '../../runtimeAssetsRoot.js';

/**
 * Activation-layer adapter: real webview panels wrapped in the host-agnostic
 * `SettingsPanelHost` interface. This is the one place `vscode` webview APIs
 * bind to the settings manager; everything below it is tested with fakes.
 *
 * The HTML is read from `RUNTIME_ASSETS_ROOT` — the one anchor that names the
 * src tree unbundled and the compiled output inside `dist/extension.js`, where
 * a module's own `import.meta.url` collapses to the bundle's location.
 */

export function makeSettingsPanelHost(
  context: vscode.ExtensionContext,
  brandIcon?: BrandIconPaths,
): SettingsPanelHost & { restore(raw: vscode.WebviewPanel): RestoredPanel<SettingsPanel> } {
  const html = hydrateWebview('settings', readFileSync(join(RUNTIME_ASSETS_ROOT, 'ui', 'settings', 'webview.html'), 'utf8'));
  /** Configure a raw panel (new or restored) and wrap it. */
  const wrap = (panel: vscode.WebviewPanel): SettingsPanel => {
      // A restored panel arrives with default options.
      panel.webview.options = { enableScripts: true };
      // Settings carries no ticket, so the mark is the status-free brand one.
      panel.iconPath = brandIconUri(brandIcon);
      // Nonce per panel, not per host (the html above is built once and reused).
      panel.webview.html = injectCsp(html, newNonce());
      return {
        reveal: () => panel.reveal(),
        postMessage: (message) => void panel.webview.postMessage(message),
        onDidReceiveMessage: (handler) =>
          panel.webview.onDidReceiveMessage(handler, undefined, context.subscriptions),
        onDidDispose: (handler) => panel.onDidDispose(handler, undefined, context.subscriptions),
      };
  };
  return {
    createPanel: (title: string) =>
      wrap(
        vscode.window.createWebviewPanel('karst.settings', title, vscode.ViewColumn.Active, {
          enableScripts: true,
          retainContextWhenHidden: true,
        }),
      ),
    restore: (raw) => ({ wrap: () => wrap(raw), dispose: () => raw.dispose() }),
  };
}
