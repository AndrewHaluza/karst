import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GettingStartedPanel, GettingStartedPanelHost } from './panel.js';
import { hydrateWebview } from '../../model/webviewChains.js';
import { injectCsp, newNonce } from '../../model/csp.js';
import type { BrandIconPaths } from '../brandIcon.js';
import { brandIconUri } from '../panelIcon.js';
import { RUNTIME_ASSETS_ROOT } from '../../runtimeAssetsRoot.js';

/**
 * Activation-layer adapter: real webview panels wrapped in the host-agnostic
 * `GettingStartedPanelHost` interface. The one place `vscode` webview APIs bind to the
 * Getting Started manager; everything below it is tested with fakes. The HTML resolves
 * relative to the compiled module (copy-assets mirrors it into dist/).
 */

export function makeGettingStartedPanelHost(
  context: vscode.ExtensionContext,
  brandIcon?: BrandIconPaths,
): GettingStartedPanelHost {
  const html = hydrateWebview('gettingStarted', readFileSync(join(RUNTIME_ASSETS_ROOT, 'ui', 'gettingStarted', 'webview.html'), 'utf8'));
  return {
    createPanel(title: string): GettingStartedPanel {
      const panel = vscode.window.createWebviewPanel(
        'karst.gettingStarted',
        title,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      // The first karst surface a user ever sees — it carries the mark too.
      panel.iconPath = brandIconUri(brandIcon);
      // CSP nonce per panel, not per host: the html above is built once and
      // reused, so injecting it there would share one nonce across every panel
      // for the life of the extension.
      panel.webview.html = injectCsp(html, newNonce());
      return {
        reveal: () => panel.reveal(),
        postMessage: (message) => void panel.webview.postMessage(message),
        onDidReceiveMessage: (handler) =>
          panel.webview.onDidReceiveMessage(handler, undefined, context.subscriptions),
        onDidDispose: (handler) => panel.onDidDispose(handler, undefined, context.subscriptions),
      };
    },
  };
}
