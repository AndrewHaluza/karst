import { readFileSync } from 'node:fs';
import type * as VscodeApi from 'vscode';
import { editWorkspaceDepsOp } from './ops/editWorkspaceDeps.js';
import type { EditWorkspaceDepsDeps } from './ops/editWorkspaceDeps.js';

export { createGraphDepsPreflight } from './ops/graphDepsPreflight.js';

/** What the block action needs from the host: the vscode API, the manifest path and the toasts. */
export interface WorkspaceDepsEditorHost {
  vscode: typeof VscodeApi;
  manifestPath: () => string;
  notify: EditWorkspaceDepsDeps['notify'];
  readFile?: (path: string) => string;
}

/** Binding of the block action: open karst.yml at the repository, insert the key as an editor edit. The vscode API is injected so a fake can drive it. */
export function openWorkspaceDepsEditor(host: WorkspaceDepsEditorHost, reason: string): Promise<void> {
  const { vscode } = host;
  const readFile = host.readFile ?? ((path: string): string => readFileSync(path, 'utf8'));
  return editWorkspaceDepsOp(
    {
      readManifest: () => {
        try {
          const path = host.manifestPath();
          return { path, text: readFile(path) };
        } catch {
          return undefined;
        }
      },
      open: async (path, plan) => {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
        // The plan comes from the saved file: an unsaved buffer may differ, so only a clean buffer gets the edit.
        if (plan.insert && !doc.isDirty) {
          const edit = new vscode.WorkspaceEdit();
          edit.insert(doc.uri, new vscode.Position(plan.insert.beforeLine, 0), `${plan.insert.text}\n`);
          await vscode.workspace.applyEdit(edit);
        }
        const editor = await vscode.window.showTextDocument(doc);
        const pos = new vscode.Position(plan.revealLine, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      },
      notify: host.notify,
    },
    reason,
  );
}
