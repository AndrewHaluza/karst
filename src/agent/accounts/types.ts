/**
 * Agent accounts (@arch:AC-55): the machine-local model. vscode-free.
 *
 * `accounts[core] = { active, list }`. The built-in `default` account is never
 * stored: it means NO override. `kind` is a discriminated union, so a later
 * `apiKey` kind is an additive change.
 */
export const ACCOUNT_CORES = ['claude', 'codex', 'opencode', 'opencode2', 'antigravity'] as const;
export type AccountCore = (typeof ACCOUNT_CORES)[number];

export const DEFAULT_ACCOUNT = 'default';

export const ACCOUNT_SOURCES = ['managed', 'folder', 'command'] as const;
export type AccountSource = (typeof ACCOUNT_SOURCES)[number];

export const ACCOUNT_KINDS = ['subscription'] as const;

export interface SubscriptionAccount {
  readonly kind: 'subscription';
  readonly source: AccountSource;
  /** Absolute folder the CLI reads (its home / config / data folder). */
  readonly dir: string;
  /** Command that replaces the core binary (source `command`). Spawned without a shell. */
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** Add a variant here (e.g. `apiKey`) when API-key accounts arrive. */
export type Account = SubscriptionAccount;

export interface CoreAccounts {
  readonly active: string;
  readonly list: Readonly<Record<string, Account>>;
}

export type AccountsConfig = Readonly<Partial<Record<AccountCore, CoreAccounts>>>;

export function isAccountCore(value: unknown): value is AccountCore {
  return typeof value === 'string' && (ACCOUNT_CORES as readonly string[]).includes(value);
}

/** The env var each core reads for its home folder. opencode2 uses a karst-owned XDG root instead. */
export const CORE_HOME_ENV: Readonly<Record<Exclude<AccountCore, 'opencode2'>, string>> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  opencode: 'XDG_DATA_HOME',
  antigravity: 'ANTIGRAVITY_EXECUTABLE_DATA_DIR',
};

/** Cores whose trust, transcripts, resume and quota read the folder: `dir` is required. */
export const DIR_REQUIRED_CORES: readonly AccountCore[] = ['claude', 'codex', 'antigravity'];

const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** A safe account name: no separators, no `..`, not the reserved `default`. */
export function validateAccountName(name: unknown): string | null {
  if (typeof name !== 'string' || name === '') return 'account name is empty';
  if (name === DEFAULT_ACCOUNT) return `'${DEFAULT_ACCOUNT}' is the built-in account and cannot be stored`;
  if (name.includes('..')) return `account name '${name}' must not contain '..'`;
  if (!SLUG.test(name)) {
    return `account name '${name}' must be a lowercase slug (a-z, 0-9, '.', '_', '-'; max 64 characters)`;
  }
  return null;
}

const SECRET_ENV_KEY = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

/** `true` when an env key name looks like a secret; karst never stores such a value. */
export function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEY.test(key);
}

function isAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

/** Validate ONE stored account; returns the first problem or `null`. */
export function validateAccount(core: AccountCore, value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'account is not an object';
  const a = value as Record<string, unknown>;
  if (a['kind'] !== 'subscription') {
    return `unknown account kind '${String(a['kind'])}' (supported: ${ACCOUNT_KINDS.join(', ')})`;
  }
  if (typeof a['source'] !== 'string' || !(ACCOUNT_SOURCES as readonly string[]).includes(a['source'])) {
    return `unknown account source '${String(a['source'])}' (supported: ${ACCOUNT_SOURCES.join(', ')})`;
  }
  const dir = a['dir'];
  if (dir === undefined || dir === '') {
    if (DIR_REQUIRED_CORES.includes(core)) return `'dir' is required for ${core} accounts`;
  } else if (typeof dir !== 'string' || !isAbsolute(dir)) {
    return `'dir' must be an absolute path`;
  }
  if (core === 'opencode2' && (dir === undefined || dir === '') && a['source'] !== 'command') {
    return `'dir' is required for opencode2 accounts (the karst-owned XDG root)`;
  }
  if (a['source'] === 'command') {
    const cmd = a['command'];
    if (typeof cmd !== 'string' || cmd.trim() === '') return `a 'command' account needs a 'command'`;
    if (/[\s;&|<>$`'"\\*?(){}]/.test(cmd)) return `'command' must be one executable (PATH name or absolute path), no shell syntax`;
  }
  if (a['args'] !== undefined && !(Array.isArray(a['args']) && a['args'].every((x) => typeof x === 'string'))) {
    return `'args' must be a list of strings`;
  }
  const env = a['env'];
  if (env !== undefined) {
    if (typeof env !== 'object' || env === null || Array.isArray(env)) return `'env' must be an object of strings`;
    for (const [k, v] of Object.entries(env)) {
      if (typeof v !== 'string') return `env '${k}' must be a string`;
      if (isSecretEnvKey(k)) return `env key '${k}' looks like a secret; karst does not store it`;
    }
  }
  return null;
}

/** Validate the whole file; returns problems (empty = valid). Unknown cores are reported. */
export function validateAccountsConfig(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['accounts config is not an object'];
  const problems: string[] = [];
  for (const [core, entry] of Object.entries(value)) {
    if (!isAccountCore(core)) {
      problems.push(`unknown core '${core}'`);
      continue;
    }
    const e = entry as { active?: unknown; list?: unknown };
    if (typeof e !== 'object' || e === null || typeof e.active !== 'string' || typeof e.list !== 'object' || e.list === null) {
      problems.push(`${core}: needs { active, list }`);
      continue;
    }
    for (const [name, acct] of Object.entries(e.list as Record<string, unknown>)) {
      const nameProblem = validateAccountName(name);
      if (nameProblem) problems.push(`${core}: ${nameProblem}`);
      const p = validateAccount(core, acct);
      if (p) problems.push(`${core}/${name}: ${p}`);
    }
    if (e.active !== DEFAULT_ACCOUNT && !(e.active in (e.list as object))) {
      problems.push(`${core}: active account '${e.active}' is not in the list`);
    }
  }
  return problems;
}
