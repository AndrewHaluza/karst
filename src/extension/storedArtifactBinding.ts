import * as vscode from 'vscode';

import type { Store } from '../store/db.js';
import type { Notify } from './ops/notify.js';
import {
  makeStoredArtifactActionsForTicket,
  type StoredArtifactActions,
  type StoredArtifactUi,
} from './ops/storedArtifactOps.js';

export type { StoredArtifactActions };

export interface StoredArtifactBindingDeps {
  registry: Store;
  notify: Notify;
  artifactsRoot: string;
  fallbackProjectId: () => number | undefined;
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
  dispose: () => void;
} {
  const docs = new Map<string, string>();
  const changed = new vscode.EventEmitter<vscode.Uri>();
  const provider = vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
    onDidChange: changed.event,
    provideTextDocumentContent: (uri) => docs.get(uri.toString()) ?? '',
  });
  let seq = 0;
  const ui: StoredArtifactUi = {
    async showReadOnly(title, text, language) {
      // The seq keeps two opens of the same title as two documents; the
      // sanitized title is only a tab label, never a path.
      const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${title.replace(/[^\w.@ -]/g, '_')}`, query: String(++seq) });
      docs.set(uri.toString(), text);
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
    dispose: () => disposable.dispose(),
  };
}
