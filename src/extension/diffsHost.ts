import * as vscode from 'vscode';
import type { Store } from '../store/db.js';
import { listTickets } from '../store/tickets.js';
import type { DiffTarget, WorktreeSpec } from '../ui/diffs/git.js';
import type { TicketChangesSnapshot } from '../ui/diffs/snapshot.js';
import { diffsTicketChoices, diffsTicketScope } from '../ui/diffs/ticketChoices.js';
import { DiffTreeController } from '../ui/diffs/treeController.js';
import { DIFFS_VIEW_ID, DiffTreeProvider, makeDiffTreeHost } from '../ui/diffs/treeHost.js';

export interface DiffsHostDeps {
  context: vscode.ExtensionContext;
  load: (ticketId: number, signal?: AbortSignal) => Promise<{
    snapshot: TicketChangesSnapshot;
    worktrees: readonly WorktreeSpec[];
  }>;
  openDiff: (target: DiffTarget, viewColumn: number | undefined) => Promise<void>;
  logError: (message: string, error: unknown) => void;
  labelFor: (ticketId: number) => string;
  discard: (repoPath: string, path: string, status: string) => Promise<{ ok: boolean; error?: string }>;
  unstage: (repoPath: string, path: string) => Promise<{ ok: boolean; error?: string }>;
  debug: (message: string) => void;
  /** The open store — the ticket selector reads `listTickets` from it (Task 6). */
  store: Store;
  /** The scoped project id, or undefined. Bound to `currentProject()?.id`. */
  projectId: () => number | undefined;
}

export async function pickDiffsTicket(
  store: Store,
  projectId: number | undefined,
  currentTicketId: number | null,
): Promise<number | undefined> {
  const scope = diffsTicketScope(projectId);
  if (scope === null) {
    void vscode.window.showInformationMessage(
      'Karst: open a project to choose which ticket’s changes to show.',
    );
    return undefined;
  }

  const rows = listTickets(store, scope);
  const choices = diffsTicketChoices(rows, currentTicketId);
  if (choices.length === 0) {
    void vscode.window.showInformationMessage('No active tickets to show changes for.');
    return undefined;
  }

  const items: vscode.QuickPickItem[] = choices.map((c) => ({
    label: c.label,
    description: c.description,
    picked: c.current,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Karst: changes for ticket',
    placeHolder: 'Select a ticket',
    matchOnDescription: true,
  });
  if (picked === undefined) return undefined;

  return choices[items.indexOf(picked)]?.ticketId;
}

export function wireDiffsTree(deps: DiffsHostDeps): DiffTreeController {
  let controller: DiffTreeController;
  const roots = () => controller.roots();
  const provider = new DiffTreeProvider(roots);
  const view = vscode.window.createTreeView(DIFFS_VIEW_ID, { treeDataProvider: provider });
  const host = makeDiffTreeHost(provider, () => view, roots);

  controller = new DiffTreeController({
    host,
    load: deps.load,
    openDiff: deps.openDiff,
    logError: deps.logError,
    labelFor: deps.labelFor,
    debug: deps.debug,
    openFile: (absolutePath) => {
      void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(absolutePath));
    },
    discard: deps.discard,
    unstage: deps.unstage,
    confirmDiscard: async (path) => {
      const choice = await vscode.window.showWarningMessage(
        `Discard changes in ${path}? This cannot be undone.`,
        { modal: true },
        'Discard Changes',
      );
      return choice === 'Discard Changes';
    },
  });

  const refreshCommand = vscode.commands.registerCommand('karst.refreshDiffsTree', () =>
    controller.refresh(),
  );

  const selectCommand = vscode.commands.registerCommand('karst.selectDiffsTicket', async () => {
    const picked = await pickDiffsTicket(deps.store, deps.projectId(), controller.selectedTicket());
    if (picked === undefined) return;
    await controller.show(picked);
  });

  deps.context.subscriptions.push(view, provider, refreshCommand, selectCommand, {
    dispose: () => controller.dispose(),
  });

  return controller;
}
