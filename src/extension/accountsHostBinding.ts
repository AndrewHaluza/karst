import * as vscode from 'vscode';
import type { AccountOps } from '../agent/accounts/accountOps.js';
import { createAccountsHost, type AccountsHost } from '../ui/settings/accountsHost.js';
import type { AccountsHostMessage } from '../ui/settings/accountsMessages.js';
import type { SecretStore } from './secretStore.js';
import { getSbxToken, removeSbxToken, SBX_TOKEN_CORE, setSbxToken, validateSbxToken } from './sbxTokenStore.js';

/** SecretStorage and the proxy sync behind the Accounts tab token action (@arch:AC-51). */
export interface AccountsTokenBinding {
  readonly secrets: SecretStore;
  readonly onChanged?: (name: string, change: 'set' | 'removed') => void;
}

/** Thin vscode binding of the Settings Accounts host: login terminal and folder picker (D505). */
export function bindAccountsHost(ops: AccountOps, post: (message: AccountsHostMessage) => void, tokens?: AccountsTokenBinding): AccountsHost {
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
    ...(tokens ? {
      sbxToken: {
        has: async (name: string) => (await getSbxToken(tokens.secrets, SBX_TOKEN_CORE, name)) !== undefined,
        ask: async (name: string) => vscode.window.showInputBox({
          prompt: `Subscription token for the Claude account '${name}' (from 'claude setup-token'; kept in your OS keychain)`,
          password: true, ignoreFocusOut: true, validateInput: (v: string) => validateSbxToken(v),
        }),
        store: (name: string, token: string) => setSbxToken(tokens.secrets, SBX_TOKEN_CORE, name, token),
        remove: (name: string) => removeSbxToken(tokens.secrets, SBX_TOKEN_CORE, name),
        ...(tokens.onChanged ? { onChanged: tokens.onChanged } : {}),
      },
    } : {}),
    pickFolder: async () => {
      const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Use folder' });
      return picked?.[0]?.fsPath;
    },
  });
}
