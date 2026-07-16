import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { OnboardingPanel, OnboardingPanelHost } from './panel.js';
import { injectPalette } from '../../model/palette.js';
import { injectProviderIdentity } from '../../model/providerIdentity.js';

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
  const html = injectProviderIdentity(injectPalette(readFileSync(join(HERE, 'webview.html'), 'utf8')));
  return {
    createPanel(title: string): OnboardingPanel {
      const panel = vscode.window.createWebviewPanel(
        'karst.onboarding',
        title,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      panel.webview.html = html;
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
