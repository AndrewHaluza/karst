/**
 * Commands 'Karst: Set sbx token for Claude account' and 'Remove' (@arch:AC-51).
 * Host-agnostic: the account list, the pickers, the secret input and the
 * notifications are injected; `sbxTokenBinding.ts` binds them to vscode.
 */
import type { AccountRow } from '../../agent/accounts/accountOps.js';
import type { SecretStore } from '../secretStore.js';
import { hasSbxToken, removeSbxToken, SBX_TOKEN_CORE, sbxTokenEligibility, setSbxToken } from '../sbxTokenStore.js';
import type { Notify } from './notify.js';

export interface SbxTokenOpsDeps {
  readonly secrets: SecretStore;
  readonly listAccounts: (core: typeof SBX_TOKEN_CORE) => Promise<readonly AccountRow[]>;
  readonly pickAccount: (names: readonly string[], placeHolder: string) => Promise<string | undefined>;
  /** The masked input box; `undefined` when the user cancels. */
  readonly askToken: (account: string) => Promise<string | undefined>;
  readonly notify: Notify;
  /** Called after a token is stored or removed, so a window can re-register sandboxes. */
  readonly onChanged?: (account: string, change: 'set' | 'removed') => void;
}

export function createSbxTokenOps(deps: SbxTokenOpsDeps) {
  const eligible = async (): Promise<string[]> =>
    (await deps.listAccounts(SBX_TOKEN_CORE)).filter((row) => sbxTokenEligibility(SBX_TOKEN_CORE, row.name, row.account) === null).map((row) => row.name);

  async function set(): Promise<void> {
    const names = await eligible();
    if (names.length === 0) {
      deps.notify.warn('No Claude account can hold an sbx token. Add a folder or managed account first.');
      return;
    }
    const account = await deps.pickAccount(names, 'Claude account to set the sbx token for');
    if (!account) return;
    const token = await deps.askToken(account);
    if (!token) return;
    try {
      await setSbxToken(deps.secrets, SBX_TOKEN_CORE, account, token);
    } catch (e) {
      deps.notify.warn(e instanceof Error ? e.message : 'The sbx token was not stored.');
      return;
    }
    deps.onChanged?.(account, 'set');
    deps.notify.info(`The sbx token for the Claude account '${account}' is stored.`);
  }

  async function remove(): Promise<void> {
    const withToken: string[] = [];
    for (const name of await eligible()) if (await hasSbxToken(deps.secrets, SBX_TOKEN_CORE, name)) withToken.push(name);
    if (withToken.length === 0) {
      deps.notify.info('No Claude account has an sbx token.');
      return;
    }
    const account = await deps.pickAccount(withToken, 'Claude account to remove the sbx token from');
    if (!account) return;
    await removeSbxToken(deps.secrets, SBX_TOKEN_CORE, account);
    deps.onChanged?.(account, 'removed');
    deps.notify.info(`The sbx token for the Claude account '${account}' is removed.`);
  }

  return { set, remove };
}
