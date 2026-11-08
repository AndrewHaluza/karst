/**
 * The ONE account resolver (@arch:AC-55): (core, account) -> { binary, args, env, dir }.
 * Every spawn path calls it (headless, interactive, tester, Docker, sandbox, probes).
 * Pure and vscode-free. The `default` account is a no-op: no env, the normal binary.
 */
import { opencode2IsolationEnv } from '../opencode2Binary.js';
import { CORE_HOME_ENV, DEFAULT_ACCOUNT, type Account, type AccountCore, type AccountsConfig } from './types.js';

export interface AccountLaunch {
  readonly account: string;
  readonly binary: string;
  readonly args: readonly string[];
  /** Account env, merged AFTER the base env; karst-owned env wins over it (`mergeAccountEnv`). */
  readonly env: Readonly<Record<string, string>>;
  /** The account folder, or `undefined` for the default account. */
  readonly dir?: string;
}

export class AccountNotFoundError extends Error {
  constructor(readonly core: AccountCore, readonly account: string) {
    super(`The ${core} account '${account}' no longer exists. Re-create it or start a new session under another account.`);
    this.name = 'AccountNotFoundError';
  }
}

/** The name of the active account of a core (`default` when none is configured). */
export function activeAccountName(config: AccountsConfig, core: AccountCore): string {
  return config[core]?.active ?? DEFAULT_ACCOUNT;
}

/** Look up a named account; `undefined` for `default`. Throws for a missing one. */
export function findAccount(config: AccountsConfig, core: AccountCore, name: string): Account | undefined {
  if (name === DEFAULT_ACCOUNT) return undefined;
  const found = config[core]?.list[name];
  if (!found) throw new AccountNotFoundError(core, name);
  return found;
}

/** Account env for a stored account: the core's home variable, then the account's own env. */
function accountEnv(core: AccountCore, account: Account): Record<string, string> {
  if (core === 'opencode2') {
    // A karst-owned isolated XDG root per account; the isolation keys win over account env.
    return { ...(account.env ?? {}), ...(account.dir ? opencode2IsolationEnv(account.dir) : {}) };
  }
  const homeVar = CORE_HOME_ENV[core];
  return { ...(account.env ?? {}), ...(account.dir ? { [homeVar]: account.dir } : {}) };
}

/**
 * Resolve the launch for `account` (a name; omit for the ACTIVE account — new
 * launches only. A resume passes the RECORDED name and never falls back).
 */
export function resolveAccountLaunch(input: {
  readonly config: AccountsConfig;
  readonly core: AccountCore;
  readonly defaultBinary: string;
  readonly account?: string;
}): AccountLaunch {
  const name = input.account ?? activeAccountName(input.config, input.core);
  const stored = findAccount(input.config, input.core, name);
  if (!stored) return { account: DEFAULT_ACCOUNT, binary: input.defaultBinary, args: [], env: {} };
  return {
    account: name,
    binary: stored.command ?? input.defaultBinary,
    args: stored.args ?? [],
    env: accountEnv(input.core, stored),
    ...(stored.dir ? { dir: stored.dir } : {}),
  };
}

/** Account env under a base env: karst-owned keys (hook channel, isolation) win. */
export function mergeAccountEnv(
  accountEnvValues: Readonly<Record<string, string>>,
  karstOwned: Readonly<Record<string, string>>,
): Record<string, string> {
  return { ...accountEnvValues, ...karstOwned };
}
