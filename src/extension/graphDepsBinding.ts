import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { Manifest } from '../manifest/types.js';
import { preflightWarning, preflightWorkspaceDeps } from '../approaches/graph/workspace/depsPreflight.js';
import { editWorkspaceDepsOp } from './ops/editWorkspaceDeps.js';
import { toast } from './toastSeam.js';

/** The preflight warning of each graph run: set at the planner launch, read by the Inside header. A reload clears it. */
export function createGraphDepsPreflight(deps: {
  manifest: () => Manifest | undefined;
  domainsOf: (graphRunId: number) => readonly { repoName: string; worktreePath: string }[];
  gitCommonDirOf: (worktree: string) => string | null;
}): { preflight: (graphRunId: number) => Promise<string | undefined>; warningOf: (graphRunId: number) => string | undefined } {
  const warnings = new Map<number, string>();
  return {
    warningOf: (graphRunId) => warnings.get(graphRunId),
    preflight: async (graphRunId) => {
      const assessments = await preflightWorkspaceDeps({
        manifest: deps.manifest(),
        repos: deps.domainsOf(graphRunId).map((d) => ({
          repoName: d.repoName,
          worktree: d.worktreePath,
          gitCommonDir: deps.gitCommonDirOf(d.worktreePath),
        })),
      });
      const warning = preflightWarning(assessments);
      if (warning === undefined) warnings.delete(graphRunId);
      else warnings.set(graphRunId, warning);
      return warning;
    },
  };
}

/** Thin vscode binding of the block action: open karst.yml at the repository, insert the key as an editor edit. */
export function openWorkspaceDepsEditor(manifestPath: () => string, reason: string): void {
  void editWorkspaceDepsOp(
    {
      readManifest: () => {
        try {
          const path = manifestPath();
          return { path, text: readFileSync(path, 'utf8') };
        } catch {
          return undefined;
        }
      },
      open: async (path, plan) => {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
        if (plan.insert) {
          const edit = new vscode.WorkspaceEdit();
          edit.insert(doc.uri, new vscode.Position(plan.insert.beforeLine, 0), `${plan.insert.text}\n`);
          await vscode.workspace.applyEdit(edit);
        }
        const editor = await vscode.window.showTextDocument(doc);
        const pos = new vscode.Position(plan.revealLine, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      },
      notify: { info: (m) => void toast.info(m), warn: (m) => void toast.warn(m), error: async (m) => void (await toast.error(m)) },
    },
    reason,
  );
}
