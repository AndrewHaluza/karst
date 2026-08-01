import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { OnboardingPanel, OnboardingPanelHost } from './panel.js';
import { injectPalette } from '../../model/palette.js';
import { injectDesignSystem } from '../../model/designSystem.js';
import { injectProviderIdentity } from '../../model/providerIdentity.js';
import { injectCsp, newNonce } from '../../model/csp.js';
import { attachmentsRoot } from '../../attachments/paths.js';

/**
 * Activation-layer adapter: real webview panels wrapped in the host-agnostic
 * `OnboardingPanelHost` interface. This is the one place `vscode` webview APIs
 * bind to the onboarding manager; everything below it is tested with fakes.
 *
 * The HTML is located relative to the compiled module so it resolves the same
 * whether run from `dist/` (copy-assets mirrors it) or via ts-node in tests.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

export function makeOnboardingPanelHost(context: vscode.ExtensionContext): OnboardingPanelHost {
  const html = injectProviderIdentity(
    injectPalette(injectDesignSystem(readFileSync(join(HERE, 'webview.html'), 'utf8'))),
  );
  return {
    createPanel(title: string): OnboardingPanel {
      const panel = vscode.window.createWebviewPanel(
        'karst.onboarding',
        title,
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          // The HTML is inlined, so attachment media is the only local content
          // this panel needs. Keep the grant narrower than VS Code's defaults.
          localResourceRoots: [
            vscode.Uri.file(attachmentsRoot(context.globalStorageUri.fsPath)),
          ],
        },
      );
      // Nonce per panel, not per host (the html above is built once and reused).
      panel.webview.html = injectCsp(html, newNonce(), panel.webview.cspSource);
      return {
        reveal: () => panel.reveal(),
        postMessage: (message) => void panel.webview.postMessage(message),
        onDidReceiveMessage: (handler) =>
          panel.webview.onDidReceiveMessage(handler, undefined, context.subscriptions),
        onDidDispose: (handler) => panel.onDidDispose(handler, undefined, context.subscriptions),
        dispose: () => panel.dispose(),
        setIcon: (p: string) => {
          panel.iconPath = vscode.Uri.file(p);
        },
        toWebviewUri: (p: string) => panel.webview.asWebviewUri(vscode.Uri.file(p)).toString(),
      };
    },
  };
}
