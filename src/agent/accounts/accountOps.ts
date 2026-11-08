/**
 * Account operations that D505 (UI) calls (@arch:AC-55). Host-agnostic: storage,
 * the live-session check, binary probe and shell lookup are injected.
 * Debug lines name the account, the binary and the dir only (@arch:AC-48).
 */
import { mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AccountStore } from './accountStore.js';
import { parseShellAlias, type AliasImport } from './aliasImport.js';
import { copyAccountSeed, SEED_ITEMS, type CopySeedResult, type SeedItem } from './copySeed.js';
import { activeAccountName, findAccount, resolveAccountLaunch } from './resolve.js';
import {
  DEFAULT_ACCOUNT, validateAccount, validateAccountName,
  type Account, type AccountCore, type AccountsConfig, type AccountSource, type SubscriptionAccount,
} from './types.js';

/** Default binary name of each core (opencode2 comes from its configured path). */
export const DEFAULT_BINARIES: Readonly<Record<AccountCore, string>> = {
  claude: 'claude', codex: 'codex', opencode: 'opencode', opencode2: 'opencode', antigravity: 'agy',
};

export interface AccountOpsDeps {
  readonly store: AccountStore;
  /** `<globalStorage>/accounts` root for managed accounts. */
  readonly managedRoot: string;
  readonly home: string;
  /** The default account folder of a core (for example `~/.claude`). */
  readonly defaultDir: (core: AccountCore) => string;
  /** Names of accounts with a live session, for the delete guard. */
  readonly liveAccounts: (core: AccountCore) => Promise<readonly string[]>;
  /** `true` when the binary resolves (PATH name or absolute path). */
  readonly binaryResolves: (binary: string) => Promise<boolean>;
  /** Run `$SHELL -ic 'alias <name>'` with a short timeout; returns stdout. */
  readonly lookupAlias: (name: string) => Promise<string>;
  /** Signed-in probe on an account folder; `unknown` when no probe exists. */
  readonly signedIn: (core: AccountCore, dir: string | undefined) => Promise<boolean | undefined>;
  readonly debug?: (message: string) => void;
}

export interface AccountRow {
  readonly name: string;
  readonly active: boolean;
  readonly account?: Account;
}

export type AccountSpec =
  | { readonly source: 'managed' }
  | { readonly source: 'folder'; readonly dir: string; readonly args?: string[]; readonly env?: Record<string, string> }
  | { readonly source: 'command'; readonly command: string; readonly dir?: string; readonly args?: string[]; readonly env?: Record<string, string> };

export type AccountStatus = 'signed-in' | 'not-signed-in' | 'unknown';

function withCore(config: AccountsConfig, core: AccountCore, next: { active: string; list: Record<string, Account> }): AccountsConfig {
  return { ...config, [core]: next };
}

export function createAccountOps(deps: AccountOpsDeps) {
  const sourceDir = (core: AccountCore, name: string): string => join(deps.managedRoot, core, name);

  async function listAccounts(core: AccountCore): Promise<AccountRow[]> {
    const config = await deps.store.load();
    const active = activeAccountName(config, core);
    const rows: AccountRow[] = [{ name: DEFAULT_ACCOUNT, active: active === DEFAULT_ACCOUNT }];
    for (const [name, account] of Object.entries(config[core]?.list ?? {})) rows.push({ name, active: active === name, account });
    return rows;
  }

  async function createAccount(core: AccountCore, name: string, spec: AccountSpec): Promise<void> {
    const nameProblem = validateAccountName(name);
    if (nameProblem) throw new Error(nameProblem);
    const config = await deps.store.load();
    if (config[core]?.list[name]) throw new Error(`The ${core} account '${name}' already exists.`);
    const account: SubscriptionAccount = buildAccount(core, name, spec, sourceDir);
    const problem = validateAccount(core, account);
    if (problem) throw new Error(problem);
    if (spec.source === 'managed') await mkdir(account.dir, { recursive: true, mode: 0o700 });
    const prev = config[core];
    await deps.store.save(withCore(config, core, { active: prev?.active ?? DEFAULT_ACCOUNT, list: { ...(prev?.list ?? {}), [name]: account } }));
    deps.debug?.(`[accounts] created ${core}/${name} source=${account.source} dir=${account.dir}`);
  }

  async function importShellAlias(core: AccountCore, aliasName: string, pastedText?: string): Promise<AliasImport> {
    const text = pastedText ?? (await deps.lookupAlias(aliasName));
    const parsed = parseShellAlias({ core, name: aliasName, aliasText: text, home: deps.home, defaultBinary: DEFAULT_BINARIES[core] });
    if (!parsed.ok) return parsed;
    await createAccount(core, aliasName, parsed.account.source === 'command'
      ? { source: 'command', command: parsed.account.command as string, dir: parsed.account.dir, ...(parsed.account.args ? { args: [...parsed.account.args] } : {}), ...(parsed.account.env ? { env: { ...parsed.account.env } } : {}) }
      : { source: 'folder', dir: parsed.account.dir, ...(parsed.account.args ? { args: [...parsed.account.args] } : {}), ...(parsed.account.env ? { env: { ...parsed.account.env } } : {}) });
    return parsed;
  }

  async function setActive(core: AccountCore, name: string): Promise<void> {
    const config = await deps.store.load();
    if (name !== DEFAULT_ACCOUNT) findAccount(config, core, name);
    const prev = config[core];
    if (!prev && name === DEFAULT_ACCOUNT) return;
    await deps.store.save(withCore(config, core, { active: name, list: { ...(prev?.list ?? {}) } }));
  }

  async function deleteAccount(core: AccountCore, name: string, options: { readonly removeFolder?: boolean } = {}): Promise<void> {
    if (name === DEFAULT_ACCOUNT) throw new Error("The built-in 'default' account cannot be deleted.");
    const config = await deps.store.load();
    const account = findAccount(config, core, name) as Account;
    if ((await deps.liveAccounts(core)).includes(name)) throw new Error(`The ${core} account '${name}' is used by a live session. Stop the session first.`);
    const prev = config[core] as { active: string; list: Record<string, Account> };
    const { [name]: _removed, ...rest } = prev.list;
    await deps.store.save(withCore(config, core, { active: prev.active === name ? DEFAULT_ACCOUNT : prev.active, list: rest }));
    // Only a managed folder is removed; a folder or command account keeps the user's files.
    if (account.source !== 'managed' || options.removeFolder === false) return;
    // The stored dir is data from a file: remove it only when it is exactly the folder karst made.
    if (resolve(account.dir) !== resolve(sourceDir(core, name))) {
      deps.debug?.(`[accounts] not removed ${core}/${name}: dir is not the managed folder`);
      return;
    }
    await rm(account.dir, { recursive: true, force: true });
  }

  async function loginCommand(core: AccountCore, name?: string): Promise<{ binary: string; args: string[]; env: Record<string, string> }> {
    const config = await deps.store.load();
    const launch = resolveAccountLaunch({ config, core, defaultBinary: DEFAULT_BINARIES[core], ...(name !== undefined ? { account: name } : {}) });
    const loginArgs: Record<AccountCore, string[]> = {
      claude: ['/login'], codex: ['login'], opencode: ['auth', 'login'], opencode2: ['auth', 'login', '--standalone'], antigravity: ['login'],
    };
    return { binary: launch.binary, args: [...launch.args, ...loginArgs[core]], env: { ...launch.env } };
  }

  async function validate(core: AccountCore, name: string): Promise<string[]> {
    const config = await deps.store.load();
    const launch = resolveAccountLaunch({ config, core, defaultBinary: DEFAULT_BINARIES[core], account: name });
    const problems: string[] = [];
    if (!(await deps.binaryResolves(launch.binary))) problems.push(`The binary '${launch.binary}' was not found.`);
    if (launch.dir) {
      const ok = await stat(launch.dir).then((s) => s.isDirectory(), () => false);
      if (!ok) problems.push(`The folder '${launch.dir}' does not exist.`);
    }
    return problems;
  }

  async function accountStatus(core: AccountCore, name: string): Promise<AccountStatus> {
    const config = await deps.store.load();
    const launch = resolveAccountLaunch({ config, core, defaultBinary: DEFAULT_BINARIES[core], account: name });
    const ok = await deps.signedIn(core, launch.dir ?? (name === DEFAULT_ACCOUNT ? deps.defaultDir(core) : undefined));
    return ok === undefined ? 'unknown' : ok ? 'signed-in' : 'not-signed-in';
  }

  async function seedItems(core: AccountCore, name: string): Promise<readonly (SeedItem & { checked: boolean })[]> {
    const config = await deps.store.load();
    const acct = config[core]?.list[name];
    // A folder or alias account that already has settings: offer, but check nothing.
    // An account with no folder has nowhere to copy into: offer nothing.
    if (acct && !acct.dir) return [];
    const preChecked = !acct || acct.source === 'managed';
    return SEED_ITEMS[core].map((i) => ({ ...i, checked: preChecked && i.checked }));
  }

  async function copySeed(core: AccountCore, to: string, items: readonly string[], overwrite = false): Promise<CopySeedResult> {
    const config = await deps.store.load();
    const target = findAccount(config, core, to);
    if (!target) throw new Error("Copy needs a stored target account, not 'default'.");
    // A command account with no folder has dir '': it would resolve to the process cwd.
    if (!target.dir) throw new Error(`The ${core} account '${to}' has no folder to copy into.`);
    return copyAccountSeed({ core, fromDir: deps.defaultDir(core), toDir: target.dir, items, overwrite, home: deps.home });
  }

  return { listAccounts, createAccount, importShellAlias, setActive, deleteAccount, loginCommand, accountStatus, validateAccount: validate, seedItems, copyAccountSeed: copySeed };
}

function buildAccount(core: AccountCore, name: string, spec: AccountSpec, managedDir: (c: AccountCore, n: string) => string): SubscriptionAccount {
  const source: AccountSource = spec.source;
  if (spec.source === 'managed') return { kind: 'subscription', source, dir: managedDir(core, name) };
  if (spec.source === 'folder') return { kind: 'subscription', source, dir: spec.dir, ...(spec.args ? { args: spec.args } : {}), ...(spec.env ? { env: spec.env } : {}) };
  return {
    kind: 'subscription', source, command: spec.command,
    dir: spec.dir ?? '',
    ...(spec.args ? { args: spec.args } : {}), ...(spec.env ? { env: spec.env } : {}),
  };
}

export type AccountOps = ReturnType<typeof createAccountOps>;
