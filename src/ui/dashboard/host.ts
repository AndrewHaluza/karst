import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DashboardPanel, PanelHost } from './panel.js';
import { hydrateWebview } from '../../model/webviewChains.js';
import { injectCsp, newNonce } from '../../model/csp.js';
import { injectXterm, readXtermAssets } from '../../model/xtermAssets.js';
import type { BrandIconPaths } from '../brandIcon.js';
import { brandIconUri } from '../panelIcon.js';
import { RUNTIME_ASSETS_ROOT } from '../../runtimeAssetsRoot.js';

/**
 * Activation-layer adapter: real webview panels wrapped in the host-agnostic
 * `PanelHost` interface. This is the one place `vscode` webview APIs bind to
 * `DashboardManager`; everything below it is tested with fakes.
 */

/**
 * The injected dashboard webview asset, built once per call: design system,
 * status palette, provider identity, agent-core identity, and the vendored
 * xterm bundles are all substituted host-side (CSP forbids a shared
 * stylesheet/script). Shared by the production dashboard panels and the
 * development-only Inside preview, so the preview renders the exact asset
 * production does (Finding 1). The agent identity injection is applied
 * outermost, in the same order the settings and ticket form hosts use it.
 *
 * xterm is injected HERE, before `injectCsp` runs at panel creation: the
 * vendored JS lands inside the document's own `<script>` block, so the nonce
 * pass tags it along with the dashboard script. A missing vendor asset (a
 * packaging regression) degrades to the marker comments the webview already
 * guards — the console view reports "unavailable" instead of the dashboard
 * failing to open at all.
 */
export function dashboardWebviewHtml(warn: (message: string) => void): string {
  let html = hydrateWebview('dashboard', readFileSync(join(RUNTIME_ASSETS_ROOT, 'ui', 'dashboard', 'webview.html'), 'utf8'));
  try {
    html = injectXterm(html, readXtermAssets(join(RUNTIME_ASSETS_ROOT, 'vendor', 'xterm')));
  } catch (e) {
    warn(`xterm vendor assets unavailable — console view disabled (${(e as Error).message})`);
  }
  return html;
}

/** Real webview panels, wrapped in the `DashboardPanel` interface. */
export function makeDashboardPanelHost(
  context: vscode.ExtensionContext,
  brandIcon?: BrandIconPaths,
  warn: (message: string) => void = () => {},
): PanelHost {
  const html = dashboardWebviewHtml(warn);
  return {
    createPanel(title, _ticketId, preserveFocus): DashboardPanel {
      const panel = vscode.window.createWebviewPanel(
        'karst.dashboard',
        title,
        // A bound open rides on the user clicking the TERMINAL: the panel must
        // appear beside it without taking the caret out of the shell.
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: preserveFocus === true },
        { enableScripts: true, retainContextWhenHidden: true },
      );
      // The brand mark until the first state push repaints it with the ticket's
      // status glyph — a dashboard tab is never unmarked, not even for a frame.
      panel.iconPath = brandIconUri(brandIcon);
      // Nonce per panel, not per host (the html above is built once and reused).
      panel.webview.html = injectCsp(html, newNonce());
      return {
        reveal: (keepFocus) => panel.reveal(undefined, keepFocus),
        postMessage: (message) => void panel.webview.postMessage(message),
        onDidReceiveMessage: (handler) =>
          panel.webview.onDidReceiveMessage(handler, undefined, context.subscriptions),
        // `active` — not `visible`: a preserve-focus reveal makes the panel
        // visible without the user being on it, and binding off that would fire
        // on karst's own reveal rather than on a real click.
        onDidChangeViewState: (handler) =>
          panel.onDidChangeViewState(
            (e) => handler(e.webviewPanel.active),
            undefined,
            context.subscriptions,
          ),
        onDidDispose: (handler) => panel.onDidDispose(handler, undefined, context.subscriptions),
        // `visible` — the counterpart of `active` above: the live repaint asks
        // "can anyone see this?", and a dashboard watched beside a terminal the
        // user types in is visible and inactive.
        isVisible: () => panel.visible,
        setIcon: (p: string) => {
          panel.iconPath = vscode.Uri.file(p);
        },
      };
    },
  };
}
