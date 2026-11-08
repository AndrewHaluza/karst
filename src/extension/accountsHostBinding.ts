import * as vscode from 'vscode';
import type { AccountOps } from '../agent/accounts/accountOps.js';
import { createAccountsHost, type AccountsHost } from '../ui/settings/accountsHost.js';
import type { AccountsHostMessage } from '../ui/settings/accountsMessages.js';

/** Thin vscode binding of the Settings Accounts host: login terminal and folder picker (D505). */
export function bindAccountsHost(ops: AccountOps, post: (message: AccountsHostMessage) => void): AccountsHost {
  return createAccountsHost({
    ops,
    post,
    openLogin: (core, name, login) => {
      const terminal = vscode.window.createTerminal({
        name: `Karst login: ${core}/${name}`,
        shellPath: login.binary,
        shellArgs: login.args,
        env: login.env,
      });
      terminal.show();
    },
    pickFolder: async () => {
      const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Use folder' });
      return picked?.[0]?.fsPath;
    },
  });
}
