import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { WelcomePanel, WelcomePanelHost } from './panel.js';
import { injectPalette } from '../../model/palette.js';
import { injectDesignSystem } from '../../model/designSystem.js';
import { injectCsp, newNonce } from '../../model/csp.js';
import type { BrandIconPaths } from '../brandIcon.js';
import { brandIconUri } from '../panelIcon.js';

/**
 * Activation-layer adapter: real webview panels wrapped in the host-agnostic
 * `WelcomePanelHost` interface. The one place `vscode` webview APIs bind to the
 * welcome manager; everything below it is tested with fakes. The HTML resolves
 * relative to the compiled module (copy-assets mirrors it into dist/).
 */

const HERE = dirname(fileURLToPath(import.meta.url));

export function makeWelcomePanelHost(
  context: vscode.ExtensionContext,
  brandIcon?: BrandIconPaths,
): WelcomePanelHost {
  const html = injectPalette(injectDesignSystem(readFileSync(join(HERE, 'webview.html'), 'utf8')));
  return {
    createPanel(title: string): WelcomePanel {
      const panel = vscode.window.createWebviewPanel(
        'karst.welcome',
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
