import * as vscode from 'vscode';

import type { Manifest } from '../manifest/types.js';
import type { StoredArtifactsView } from '../ui/dashboard/storedArtifacts.js';
import type { Store } from '../store/db.js';
import type { Notify } from './ops/notify.js';
import {
  makeStoredArtifactActionsForTicket,
  makeStoredArtifactsLoader,
  type StoredArtifactActions,
  type StoredArtifactUi,
} from './ops/storedArtifactOps.js';

export type { StoredArtifactActions };

export interface StoredArtifactBindingDeps {
  registry: Store;
  notify: Notify;
  artifactsRoot: string;
  fallbackProjectId: () => number | undefined;
  manifest: () => Manifest | undefined;
}

/**
 * The `vscode` half of the dashboard Artifacts actions (logic in
 * ops/storedArtifactOps.ts). Snapshots and diffs open through a
 * content-provider scheme, which VS Code treats as read-only — the stored
 * evidence cannot be edited by mistake.
 */

const SCHEME = 'karst-artifact';

/** Register the read-only scheme; `forTicket` binds one dashboard's actions to it. */
export function createStoredArtifactBinding(deps: StoredArtifactBindingDeps): {
  forTicket: (ticketId: number, refresh: () => void) => StoredArtifactActions;
  /** The dashboard loader: stored files + active outputs globs. */
  load: (ticketId: number) => Promise<StoredArtifactsView>;
  /** Open text in the same read-only scheme (the sandbox sync diff reuses it). */
  showReadOnly: StoredArtifactUi['showReadOnly'];
  dispose: () => void;
} {
  const docs = new Map<string, string>();
  const changed = new vscode.EventEmitter<vscode.Uri>();
  const provider = vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
    onDidChange: changed.event,
    provideTextDocumentContent: (uri) => docs.get(uri.toString()) ?? '',
  });
  let seq = 0;
  /** Serve `text` under a fresh read-only uri. The seq keeps two opens of the same title as two documents; the sanitized title is only a tab label, never a path. */
  const serve = (title: string, text: string): vscode.Uri => {
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${title.replace(/[^\w.@ -]/g, '_')}`, query: String(++seq) });
    docs.set(uri.toString(), text);
    return uri;
  };
  const ui: StoredArtifactUi = {
    async showPreview(title, text) {
      await vscode.commands.executeCommand('markdown.showPreview', serve(title, text));
    },
    async showDiff(title, left, right) {
      await vscode.commands.executeCommand('vscode.diff', serve(left.title, left.text), serve(right.title, right.text), title);
    },
    async showReadOnly(title, text, language) {
      const uri = serve(title, text);
      const doc = await vscode.workspace.openTextDocument(uri);
      if (language) await vscode.languages.setTextDocumentLanguage(doc, language);
      await vscode.window.showTextDocument(doc, { preview: true });
    },
    async openFile(path) {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(path)), { preview: true });
    },
    async reveal(path) {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path));
    },
    async confirm(message) {
      return (await vscode.window.showWarningMessage(message, { modal: true }, 'Purge artifacts')) === 'Purge artifacts';
    },
  };
  const disposable = vscode.Disposable.from(provider, changed, { dispose: () => docs.clear() });
  return {
    forTicket: (ticketId, refresh) =>
      makeStoredArtifactActionsForTicket({
        registry: deps.registry,
        artifactsRoot: deps.artifactsRoot,
        fallbackProjectId: deps.fallbackProjectId(),
        notify: deps.notify,
        ticketId,
        ui,
        refresh,
      }),
    load: makeStoredArtifactsLoader(deps),
    showReadOnly: ui.showReadOnly,
    dispose: () => disposable.dispose(),
  };
}
