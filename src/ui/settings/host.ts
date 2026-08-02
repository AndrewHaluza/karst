import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { SettingsPanel, SettingsPanelHost } from './panel.js';
import { injectPalette } from '../../model/palette.js';
import { injectDesignSystem } from '../../model/designSystem.js';
import { injectProviderIdentity } from '../../model/providerIdentity.js';
import { injectCsp, newNonce } from '../../model/csp.js';
import type { BrandIconPaths } from '../brandIcon.js';
import { brandIconUri } from '../panelIcon.js';

/**
 * Activation-layer adapter: real webview panels wrapped in the host-agnostic
 * `SettingsPanelHost` interface. This is the one place `vscode` webview APIs
 * bind to the settings manager; everything below it is tested with fakes.
 *
 * The HTML is located relative to the compiled module so it resolves the same
 * whether run from `dist/` (copy-assets mirrors it) or via ts-node in tests.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

export function makeSettingsPanelHost(
  context: vscode.ExtensionContext,
  brandIcon?: BrandIconPaths,
): SettingsPanelHost {
  const html = injectProviderIdentity(
    injectPalette(injectDesignSystem(readFileSync(join(HERE, 'webview.html'), 'utf8'))),
  );
  return {
    createPanel(title: string): SettingsPanel {
      const panel = vscode.window.createWebviewPanel(
        'karst.settings',
        title,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
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
    },
  };
}
