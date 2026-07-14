import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { WelcomePanel, WelcomePanelHost } from './panel.js';
import { injectPalette } from '../../model/palette.js';

/**
 * Activation-layer adapter: real webview panels wrapped in the host-agnostic
 * `WelcomePanelHost` interface. The one place `vscode` webview APIs bind to the
 * welcome manager; everything below it is tested with fakes. The HTML resolves
 * relative to the compiled module (copy-assets mirrors it into dist/).
 */

const HERE = dirname(fileURLToPath(import.meta.url));

export function makeWelcomePanelHost(context: vscode.ExtensionContext): WelcomePanelHost {
  const html = injectPalette(readFileSync(join(HERE, 'webview.html'), 'utf8'));
  return {
    createPanel(title: string): WelcomePanel {
      const panel = vscode.window.createWebviewPanel(
        'karst.welcome',
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
