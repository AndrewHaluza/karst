import * as vscode from 'vscode';
import type { Store } from '../../store/db.js';
import { probeEnabled, PROBE_COMMAND } from './gate.js';
import { ProbeRecorder } from './recorder.js';
import type { ProbeHost } from './runner.js';
import { runProbeScript, type ProbeRunArgs } from './session.js';
import { readTickets } from './storeEvidence.js';
import { readLaunches } from './launchEvidence.js';

// Thin vscode binding (not loadable under vitest). Logic lives in the sibling
// vscode-free modules. Every entry point is a no-op unless KARST_UAT_PROBE=1.

const VIEW_PREFIX = 'view:';
let nextId = 0;

function wrapWebview(rec: ProbeRecorder, id: string, webview: vscode.Webview): void {
  const post = webview.postMessage.bind(webview);
  webview.postMessage = (message: unknown) => {
    rec.webviewPosted(id, message);
    return post(message);
  };
}

type Level = 'info' | 'warning' | 'error';
function patchNotifications(rec: ProbeRecorder): void {
  const win = vscode.window as unknown as Record<string, (...a: unknown[]) => unknown>;
  const levels: Array<[string, Level]> = [
    ['showInformationMessage', 'info'], ['showWarningMessage', 'warning'], ['showErrorMessage', 'error'],
  ];
  for (const [name, level] of levels) {
    const orig = win[name]!.bind(win);
    win[name] = (message, ...rest) => {
      rec.notification(level, String(message));
      return orig(message, ...rest);
    };
  }
}

function patchWebviews(rec: ProbeRecorder): void {
  const win = vscode.window as unknown as Record<string, (...a: unknown[]) => unknown>;
  const createPanel = win['createWebviewPanel']!.bind(win);
  win['createWebviewPanel'] = (viewType, title, ...rest) => {
    const panel = createPanel(viewType, title, ...rest) as vscode.WebviewPanel;
    const id = `panel:${nextId++}`;
    rec.webviewOpened(id, String(viewType), String(title));
    wrapWebview(rec, id, panel.webview);
    panel.onDidDispose(() => rec.webviewClosed(id));
    return panel;
  };
  const register = win['registerWebviewViewProvider']!.bind(win);
  win['registerWebviewViewProvider'] = (viewId, provider, ...rest) => {
    const p = provider as vscode.WebviewViewProvider;
    const wrapped: vscode.WebviewViewProvider = {
      resolveWebviewView: (view, ctx, token) => {
        const id = `${VIEW_PREFIX}${String(viewId)}`;
        rec.webviewOpened(id, String(viewId), view.title ?? String(viewId));
        wrapWebview(rec, id, view.webview);
        return p.resolveWebviewView(view, ctx, token);
      },
    };
    return register(viewId, wrapped, ...rest);
  };
}

function patchOutputChannel(rec: ProbeRecorder): void {
  const win = vscode.window as unknown as Record<string, (...a: unknown[]) => unknown>;
  const create = win['createOutputChannel']!.bind(win);
  win['createOutputChannel'] = (...args) => {
    const ch = create(...args) as vscode.OutputChannel;
    const line = ch.appendLine.bind(ch);
    ch.appendLine = (text: string) => { rec.logLine(text); line(text); };
    return ch;
  };
}

/** Call first in activate(): starts recording what the host shows. Returns undefined without the flag. */
export function installProbeRecorder(env: Record<string, string | undefined> = process.env): ProbeRecorder | undefined {
  if (!probeEnabled(env)) return undefined;
  const rec = new ProbeRecorder();
  patchNotifications(rec);
  patchWebviews(rec);
  patchOutputChannel(rec);
  return rec;
}

/** Registers the one probe command. The recorder doubles as the gate: absent means nothing registers. */
export function registerProbeCommand(
  context: vscode.ExtensionContext,
  rec: ProbeRecorder | undefined,
  store: Store,
): void {
  if (!rec) return;
  const host: ProbeHost = {
    execute: async (command, args) => { await vscode.commands.executeCommand(command, ...args); },
    snapshot: (scope) => {
      const view = rec.view();
      const sidebar = view.webviews.find((w) => w.id.startsWith(VIEW_PREFIX));
      // A wait that is not about tickets must not read the store on every poll.
      return {
        tickets: scope?.tickets === false ? [] : readTickets(store),
        sidebar: { lastMessage: sidebar?.lastMessage ?? null },
        launches: scope?.launches === false ? [] : readLaunches(),
        ...view,
      };
    },
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(PROBE_COMMAND, (args: ProbeRunArgs) => runProbeScript(args, host)),
  );
}
