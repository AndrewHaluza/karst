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

export type ActiveSource = 'project' | 'machine';

/** The stored choice of a project, when it still names an account that exists (or `default`). */
function projectChoice(config: AccountsConfig, core: AccountCore, projectSlug: string | undefined): string | undefined {
  if (projectSlug === undefined) return undefined;
  const choice = config.projects?.[projectSlug]?.[core];
  if (choice === undefined) return undefined;
  return choice === DEFAULT_ACCOUNT || config[core]?.list[choice] ? choice : undefined;
}

/**
 * The name of the active account of a core (@arch:AC-55): the project choice, then
 * the machine default (`accounts[core].active`), then `default`. A choice that names
 * a deleted account is skipped (one debug line): it is not an error for a NEW launch.
 */
export function activeAccountName(config: AccountsConfig, core: AccountCore, projectSlug?: string, debug?: (message: string) => void): string {
  const choice = projectChoice(config, core, projectSlug);
  if (choice !== undefined) return choice;
  if (projectSlug !== undefined && config.projects?.[projectSlug]?.[core] !== undefined) {
    debug?.(`[accounts] ${core}: the choice of this project names an account that no longer exists; using the machine default`);
  }
  return config[core]?.active ?? DEFAULT_ACCOUNT;
}

/** Where the active account of a core comes from: this project's choice or the machine default. */
export function activeAccountSource(config: AccountsConfig, core: AccountCore, projectSlug?: string): ActiveSource {
  return projectChoice(config, core, projectSlug) !== undefined ? 'project' : 'machine';
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
  /** The project whose choice picks the active account (new launches only). */
  readonly projectSlug?: string;
}): AccountLaunch {
  const name = input.account ?? activeAccountName(input.config, input.core, input.projectSlug);
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
