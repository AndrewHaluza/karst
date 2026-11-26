/**
 * T1386 — the account QuickPick of a graph usage-limit park. The one vscode
 * surface of the `Pick account…` action: the logic (which accounts, which is
 * current, whether the action exists at all) lives in the host-agnostic
 * binding. A pick names an account of the parked core; nothing is written here
 * (@arch:AC-50, @arch:AC-55).
 */
import * as vscode from 'vscode';
import type { AccountStatus } from '../agent/accounts/accountOps.js';
import type { GraphAccountChoice } from './graphUsageLimitBinding.js';

/** The Accounts settings wording of a probe result (`AccountsTab.tsx`). */
const STATUS_TEXT: Readonly<Record<AccountStatus, string>> = {
  'signed-in': 'signed in',
  'not-signed-in': 'not signed in',
  unknown: 'sign-in unknown',
};

/** Build the `Pick account…` picker: the chosen account name, undefined on cancel. */
export function makeGraphAccountPicker() {
  return async (core: string, choices: readonly GraphAccountChoice[]): Promise<string | undefined> => {
    const picked = await vscode.window.showQuickPick(
      choices.map((choice) => ({
        label: choice.current ? `${choice.name} (current)` : choice.name,
        description: STATUS_TEXT[choice.status],
        name: choice.name,
      })),
      { title: `Run this graph ${core} role under account` },
    );
    return picked?.name;
  };
}
