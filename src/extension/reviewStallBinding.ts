import * as vscode from 'vscode';
import type { Store } from '../store/db.js';
import { ticketIdArg } from './ops/args.js';
import { redesignHintAction, continueAnywayAction } from './ops/reviewStallActions.js';

export interface ReviewStallBindingDeps {
  store: Store;
  ticketId: number;
  afterServerChange: () => void;
  logError: (message: string, err: unknown) => void;
  debug: (message: string) => void;
  drive: () => void;
  editTicket: () => void;
}

/** The dashboard's three answers to a review stall (T845): the vscode seam over ops/reviewStallActions. */
export function reviewStallBinding(deps: ReviewStallBindingDeps) {
  const { editTicket, ...rest } = deps;
  const actionDeps = () => ({
    ...rest,
    info: (m: string) => void vscode.window.showInformationMessage(m),
    error: (m: string) => void vscode.window.showErrorMessage(m),
    confirm: async (title: string, detail: string) =>
      (await vscode.window.showWarningMessage(title, { modal: true, detail }, 'Continue')) !== undefined,
    promptHint: async () =>
      vscode.window.showInputBox({
        prompt: 'Redesign hint for the fix agent',
        placeHolder: 'e.g. split this module instead of patching it again',
        ignoreFocusOut: true,
      }),
  });
  return {
    reviewStallHint: () => redesignHintAction(actionDeps()),
    reviewStallContinue: () => continueAnywayAction(actionDeps()),
    reviewStallRescope: editTicket,
  };
}

export interface ReviewStallCommandsDeps extends Omit<ReviewStallBindingDeps, 'ticketId' | 'editTicket' | 'drive'> {
  drive: (ticketId: number) => void;
}

/** `karst.reviewStall*` — the sidebar ⋯ menu's route to the same three answers. */
export function registerReviewStallCommands(deps: ReviewStallCommandsDeps): vscode.Disposable[] {
  const { drive, ...rest } = deps;
  const answer = (pick: 'reviewStallHint' | 'reviewStallContinue' | 'reviewStallRescope') => (arg: unknown) => {
    const ticketId = ticketIdArg(arg);
    if (ticketId === undefined) return;
    reviewStallBinding({
      ...rest, ticketId, drive: () => drive(ticketId),
      editTicket: () => void vscode.commands.executeCommand('karst.editTicket', ticketId),
    })[pick]();
  };
  return [
    vscode.commands.registerCommand('karst.reviewStallHint', answer('reviewStallHint')),
    vscode.commands.registerCommand('karst.reviewStallContinue', answer('reviewStallContinue')),
    vscode.commands.registerCommand('karst.reviewStallRescope', answer('reviewStallRescope')),
  ];
}
