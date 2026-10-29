import * as vscode from 'vscode';
import type { Store } from '../store/db.js';
import { redesignHintAction, continueAnywayAction } from './ops/reviewStallActions.js';
import {
  buildActionDeps,
  hostFromVscode,
  registerStallCommands,
  type StallCommandBase,
  type StallHost,
  type StallPick,
} from './ops/reviewStallHost.js';

export interface ReviewStallBindingDeps {
  store: Store;
  ticketId: number;
  afterServerChange: () => void;
  logError: (message: string, err: unknown) => void;
  debug: (message: string) => void;
  drive: () => void;
  editTicket: () => void;
}

const host: StallHost = hostFromVscode(vscode);

/** The dashboard's three answers to a review stall (T845): the vscode seam over ops/reviewStallActions. */
export function reviewStallBinding(deps: ReviewStallBindingDeps) {
  const { editTicket, ...rest } = deps;
  const actionDeps = () => buildActionDeps(host, rest);
  return {
    reviewStallHint: () => redesignHintAction(actionDeps()),
    reviewStallContinue: () => continueAnywayAction(actionDeps()),
    reviewStallRescope: editTicket,
  };
}

export type ReviewStallCommandsDeps = StallCommandBase;

export function registerReviewStallCommands(deps: ReviewStallCommandsDeps): vscode.Disposable[] {
  return registerStallCommands(host, deps, (pick: StallPick, d) => reviewStallBinding(d)[pick]()) as vscode.Disposable[];
}
