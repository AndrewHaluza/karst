/**
 * T1386 — the account seams of the graph usage-limit `Pick account…` action.
 * The list is exactly what the Accounts settings tab shows and the probe is the
 * same signed-in check; the pick itself writes only the run snapshot, never
 * `accounts.json`, Settings or the ticket (@arch:AC-50, @arch:AC-55).
 * vscode-free: the host passes its Accounts operations. The config getter is the
 * process-wide one the host publishes from `accounts.json`, so the switch
 * validates a pick against the same menu the user saw.
 */
import type { AccountOps, AccountStatus } from '../../agent/accounts/accountOps.js';
import { accountsConfig } from '../../agent/accounts/registry.js';
import { isAccountCore, type AccountsConfig } from '../../agent/accounts/types.js';
import type { GraphAccountRow } from '../graphUsageLimitBinding.js';

export interface GraphAccountSeams {
  /** The accounts of a core, `default` first; undefined for a core with no accounts. */
  accountsOf(core: string): Promise<readonly GraphAccountRow[] | undefined>;
  /** The signed-in probe of one account folder. */
  accountStatus(core: string, name: string): Promise<AccountStatus>;
  /** The config `switchGraphRunAccount` validates a pick against (read only). */
  accountsConfig(): AccountsConfig;
}

export function makeGraphAccountSeams(ops: AccountOps | undefined): GraphAccountSeams {
  return {
    accountsOf: async (core) => {
      if (!ops || !isAccountCore(core)) return undefined;
      const rows = await ops.listAccounts(core);
      return rows.map((row) => ({ name: row.name, active: row.active }));
    },
    accountStatus: (core, name) =>
      ops && isAccountCore(core) ? ops.accountStatus(core, name) : Promise.resolve('unknown'),
    accountsConfig: () => accountsConfig(),
  };
}
