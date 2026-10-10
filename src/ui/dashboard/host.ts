import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DashboardPanel, PanelHost } from './panel.js';
import { hydrateWebview } from '../../model/webviewChains.js';
import { injectCsp, newNonce } from '../../model/csp.js';
import { injectXtermCss, readXtermAssets, xtermMessage, type XtermAssets } from '../../model/xtermAssets.js';
import type { Logger } from '../../logging/logger.js';
import type { BrandIconPaths } from '../brandIcon.js';
import { brandIconUri } from '../panelIcon.js';
import { RUNTIME_ASSETS_ROOT } from '../../runtimeAssetsRoot.js';
import { baselineReviewRoot } from './baselineRows.js';

/**
 * Activation-layer adapter: real webview panels wrapped in the host-agnostic
 * `PanelHost` interface. This is the one place `vscode` webview APIs bind to
 * `DashboardManager`; everything below it is tested with fakes.
 */

/**
 * The injected dashboard webview asset, built once per call: design system,
 * status palette, provider identity, agent-core identity, and the xterm
 * stylesheet are all substituted host-side (CSP forbids a shared
 * stylesheet/script). The agent identity injection is applied outermost, in
 * the same order the settings and ticket form hosts use it.
 *
 * The xterm BUNDLE is returned beside the document, not inlined: each panel
 * answers the webview's `xterm-request` with it on first console open (see
 * xtermAssets.ts — the document crosses the network on every open over
 * Remote-SSH). A missing vendor asset (a packaging regression) yields a null
 * bundle — the console view reports "unavailable" instead of the dashboard
 * failing to open at all.
 */
export function dashboardWebviewAssets(warn: (message: string) => void): {
  html: string;
  xterm: XtermAssets | null;
} {
  let html = hydrateWebview('dashboard', readFileSync(join(RUNTIME_ASSETS_ROOT, 'ui', 'dashboard', 'webview.html'), 'utf8'));
  let xterm: XtermAssets | null = null;
  try {
    xterm = readXtermAssets(join(RUNTIME_ASSETS_ROOT, 'vendor', 'xterm'));
    html = injectXtermCss(html, xterm.css);
  } catch (e) {
    warn(`xterm vendor assets unavailable — console view disabled (${(e as Error).message})`);
  }
  return { html, xterm };
}

/** Real webview panels, wrapped in the `DashboardPanel` interface. */
export function makeDashboardPanelHost(
  context: vscode.ExtensionContext,
  brandIcon?: BrandIconPaths,
  warn: (message: string) => void = () => {},
  debug?: Pick<Logger, 'debug' | 'isDebugEnabled'>,
): PanelHost {
  const { html, xterm } = dashboardWebviewAssets(warn);
  // Payload sizes, measured only in debug mode: over Remote-SSH every byte of
  // the document and of each message crosses the network, so these lines name
  // what a slow panel is actually shipping. Serializing to measure is skipped
  // entirely while debug is off.
  const traceSize = (what: string, payload: () => string): void => {
    if (debug?.isDebugEnabled()) debug.debug(`[dashboard] ${what} ${payload().length} chars`);
  };
  return {
    createPanel(title, _ticketId, preserveFocus): DashboardPanel {
      const panel = vscode.window.createWebviewPanel(
        'karst.dashboard',
        title,
        // A bound open rides on the user clicking the TERMINAL: the panel must
        // appear beside it without taking the caret out of the shell.
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: preserveFocus === true },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          // The only local content this panel needs is the UAT report's baseline
          // images, which the host COPIES into one fixed directory
          // (@arch:BASELINE-REVIEW) — so no worktree path is ever a root.
          localResourceRoots: [vscode.Uri.file(baselineReviewRoot(context.globalStorageUri.fsPath))],
        },
      );
      // The brand mark until the first state push repaints it with the ticket's
      // status glyph — a dashboard tab is never unmarked, not even for a frame.
      panel.iconPath = brandIconUri(brandIcon);
      // Nonce per panel, not per host (the html above is built once and reused).
      panel.webview.html = injectCsp(html, newNonce(), panel.webview.cspSource);
      traceSize('html', () => panel.webview.html);
      panel.webview.onDidReceiveMessage(
        (message: { type?: unknown } | null) => {
          if (message?.type !== 'xterm-request') return;
          const answer = xtermMessage(xterm);
          traceSize('post xterm', () => answer.js ?? '');
          void panel.webview.postMessage(answer);
        },
        undefined,
        context.subscriptions,
      );
      return {
        reveal: (keepFocus) => panel.reveal(undefined, keepFocus),
        asWebviewUri: (absPath) => panel.webview.asWebviewUri(vscode.Uri.file(absPath)).toString(),
        postMessage: (message) => {
          traceSize(`post ${messageLabel(message)}`, () => JSON.stringify(message) ?? '');
          void panel.webview.postMessage(message);
        },
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

/** `type` (plus `live` for a clock repaint) of an outgoing message, for the size trace. */
function messageLabel(message: unknown): string {
  const m = message as { type?: unknown; live?: unknown } | null;
  return `${String(m?.type ?? '?')}${m?.live === true ? ' live' : ''}`;
}
