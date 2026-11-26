/**
 * Process-wide account config (@arch:AC-55), set by the host from the
 * machine-local store (like `configureOpencode2`). Adapters call
 * `accountLaunchFor` at every spawn; with no config it is the default no-op.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AccountNotFoundError, activeAccountName, resolveAccountLaunch, type AccountLaunch } from './resolve.js';
import { DEFAULT_ACCOUNT, isAccountCore, type AccountCore, type AccountsConfig } from './types.js';

let config: AccountsConfig = {};
let projectSlugOf: () => string | undefined = () => undefined;

/**
 * The host gives the slug of the project this window hosts (a getter: the project
 * binds after the accounts wiring). The project choice then picks the active account
 * for every reader below, so no call site changes (@arch:AC-55).
 */
export function configureAccountsProject(fn: (() => string | undefined) | undefined): void {
  projectSlugOf = fn ?? (() => undefined);
}

/** The active account of a core for the project of this window. */
function activeName(core: AccountCore): string {
  return activeAccountName(config, core, projectSlugOf());
}

export function configureAccounts(next: AccountsConfig): void {
  config = next;
}

export function resetAccounts(): void {
  config = {};
}

export function accountsConfig(): AccountsConfig {
  return config;
}

/**
 * The launch for a core. `account` is the RECORDED account of a resumed
 * session; omit it for a new launch (the active account). Throws
 * `AccountNotFoundError` for a deleted recorded account — no fallback.
 */
export function accountLaunchFor(core: AccountCore, defaultBinary: string, account?: string): AccountLaunch {
  return resolveAccountLaunch({ config, core, defaultBinary, ...(projectSlugOf() !== undefined ? { projectSlug: projectSlugOf() as string } : {}), ...(account !== undefined ? { account } : {}) });
}

/** Headless spawn options for an account launch: empty for the default account (byte-for-byte unchanged). */
export function accountSpawnEnv(launch: AccountLaunch): { isolationEnv?: Record<string, string> } {
  return Object.keys(launch.env).length > 0 ? { isolationEnv: { ...launch.env } } : {};
}

/** The active account of a core when it is not 'default' (shown in the quota views); otherwise undefined. */
export function activeAccountLabel(core: string): string | undefined {
  if (!isAccountCore(core)) return undefined;
  const name = activeName(core);
  return name === DEFAULT_ACCOUNT ? undefined : name;
}

/**
 * Every Claude config folder karst may have written to: the default folder and
 * the folder of each listed Claude account (the OFF restore of the global
 * statusline walks them all). A deleted account is not listed, so its folder is
 * out of reach; its backup stays in place.
 */
export function claudeAccountConfigDirs(base: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const dirs = new Set<string>([base.CLAUDE_CONFIG_DIR || join(home, '.claude')]);
  for (const name of Object.keys(config.claude?.list ?? {})) {
    const dir = accountLaunchFor('claude', '', name).env.CLAUDE_CONFIG_DIR;
    if (dir) dirs.add(dir);
  }
  return [...dirs];
}

const READER_CORES: readonly AccountCore[] = ['claude', 'codex', 'antigravity', 'opencode'];

/**
 * The env that READERS use to find a core's folder (quota readers, workspace
 * trust, transcript watchers, the auth warning). It is `base` with the home
 * variable of each core replaced by the account folder, so the reader never
 * reads `process.env` for it. A property is resolved at READ time, so a
 * `setActive` reaches long-lived readers. `accounts` pins a recorded account
 * per core (a resume); absent → the active account. The default account adds
 * nothing: `base` is returned as is.
 */
export function accountReaderEnv(
  base: NodeJS.ProcessEnv = process.env,
  accounts: Partial<Record<AccountCore, string>> = {},
): NodeJS.ProcessEnv {
  return new Proxy(base, {
    get(target, key, receiver) {
      if (typeof key === 'string') {
        for (const core of READER_CORES) {
          if (!ACCOUNT_HOME_VARS[core].includes(key)) continue;
          const value = accountLaunchFor(core, '', accounts[core]).env[key];
          if (value !== undefined) return value;
        }
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

/**
 * Reader env for ONE session: the folder of the account that STARTED it (the
 * recorded account), not the active one. A session with no record reads the
 * active account. Used by the transcript watchers.
 */
export function sessionReaderEnv(core: AccountCore, sessionId: string | null | undefined): NodeJS.ProcessEnv {
  const account = sessionId ? accountForLaunch(core, sessionId) : undefined;
  if (account === undefined) return accountReaderEnv();
  try {
    accountLaunchFor(core, '', account);
  } catch (error) {
    // A deleted recorded account: a READ has nothing to find, so it reads the
    // default folder. A resume LAUNCH still fails (AccountNotFoundError).
    if (!(error instanceof AccountNotFoundError)) throw error;
    return accountReaderEnv(process.env, { [core]: DEFAULT_ACCOUNT });
  }
  return accountReaderEnv(process.env, { [core]: account });
}

const ACCOUNT_HOME_VARS: Readonly<Record<AccountCore, readonly string[]>> = {
  claude: ['CLAUDE_CONFIG_DIR'],
  codex: ['CODEX_HOME'],
  antigravity: ['ANTIGRAVITY_EXECUTABLE_DATA_DIR'],
  opencode: ['XDG_DATA_HOME'],
  opencode2: [],
};

export type RecordedAccountLookup = (core: string, sessionId: string) => string | null | undefined;
let recordedLookup: RecordedAccountLookup | undefined;

/** The host wires how a session id maps to the account that started it. */
export function configureRecordedAccountLookup(fn: RecordedAccountLookup | undefined): void {
  recordedLookup = fn;
}

/**
 * The account a launch must run under: an explicit name wins; a resume uses the
 * RECORDED account (`default` when the session ran under it); otherwise
 * `undefined` = the active account. A deleted recorded account is NOT replaced
 * here: the adapter's resolver throws `AccountNotFoundError`.
 */
export function accountForLaunch(core: string, resume: string | undefined, explicit?: string): string | undefined {
  if (explicit !== undefined) return explicit;
  if (resume === undefined) return undefined;
  const recorded = recordedLookup?.(core, resume);
  if (recorded !== undefined) return recorded ?? DEFAULT_ACCOUNT;
  // A headless session has no launch intent: its account sits in the ledger.
  return sessionLedger.get(ledgerKey(core, resume));
}

/** Most entries the headless session ledger keeps (the oldest are dropped first). */
export const SESSION_LEDGER_MAX = 1000;
const sessionLedger = new Map<string, string>();
let ledgerSink: ((key: string, account: string) => void) | undefined;
const ledgerKey = (core: string, sessionId: string): string => `${core}:${sessionId}`;

/** Load the persisted ledger (host start). */
export function seedSessionLedger(entries: Readonly<Record<string, string>>): void {
  sessionLedger.clear();
  for (const [k, v] of Object.entries(entries)) sessionLedger.set(k, v);
}

/** The host persists every new entry (one key, one account) through this sink; it merges, never overwrites. */
export function configureSessionLedgerSink(fn: ((key: string, account: string) => void) | undefined): void {
  ledgerSink = fn;
}

/** Add entries that another window wrote; an entry of this window stays. */
export function mergeSessionLedger(entries: Readonly<Record<string, string>>): void {
  for (const [k, v] of Object.entries(entries)) if (!sessionLedger.has(k)) sessionLedger.set(k, v);
  while (sessionLedger.size > SESSION_LEDGER_MAX) sessionLedger.delete(sessionLedger.keys().next().value as string);
}

export function resetSessionLedger(): void {
  sessionLedger.clear();
  liveHeadless.clear();
  ledgerSink = undefined;
}

/** Record the account that started a headless session, so a later resume reuses it. */
export function recordHeadlessSession(core: AccountCore, sessionId: string, account: string): void {
  if (sessionId === '') return;
  const key = ledgerKey(core, sessionId);
  sessionLedger.delete(key);
  sessionLedger.set(key, account);
  while (sessionLedger.size > SESSION_LEDGER_MAX) sessionLedger.delete(sessionLedger.keys().next().value as string);
  ledgerSink?.(key, account);
}

const liveHeadless = new Map<string, number>();

/** Mark a headless run live under an account; call the result when it ends. */
export function trackHeadlessRun(core: AccountCore, account: string): () => void {
  const key = ledgerKey(core, account);
  liveHeadless.set(key, (liveHeadless.get(key) ?? 0) + 1);
  return () => {
    const left = (liveHeadless.get(key) ?? 1) - 1;
    if (left <= 0) liveHeadless.delete(key);
    else liveHeadless.set(key, left);
  };
}

/** Accounts of a core with a headless run in flight in this process (the delete guard). */
export function liveHeadlessAccounts(core: AccountCore): string[] {
  const prefix = `${core}:`;
  return [...liveHeadless.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

/** The account name a launch runs under: the explicit or recorded one, else the active one. */
export function launchAccountName(core: AccountCore, account: string | undefined): string {
  return account ?? activeName(core);
}

/**
 * The account name when it can hold an sbx token (a stored folder or managed `claude`
 * account), else `undefined`: the default account keeps the global sbx secret, a command
 * account runs a host binary, and only `claude` has the host OAuth proxy (@arch:AC-51).
 */
export function sbxTokenAccount(core: AccountCore, account?: string): string | undefined {
  if (core !== 'claude') return undefined;
  const name = account ?? activeName(core);
  const found = name === DEFAULT_ACCOUNT ? undefined : config[core]?.list?.[name];
  return found && found.source !== 'command' ? name : undefined;
}

/**
 * Why a sandbox backend (docker, sbx) cannot run this account, or `undefined`
 * when it can (@arch:AC-51). A command account names a host binary that is not
 * in the container. Under sbx a folder or managed `claude` account runs only
 * when it has a stored token (`tokenAccounts`): the host OAuth proxy then
 * carries its login. The default account only changes the home folder.
 */
export function sandboxAccountBlock(core: AccountCore, account?: string, backend: 'docker' | 'sbx' | 'ssh' = 'docker', tokenAccounts: ReadonlySet<string> = new Set()): string | undefined {
  const list = config[core]?.list ?? {};
  const name = account ?? activeName(core);
  const found = name === DEFAULT_ACCOUNT ? undefined : list[name];
  // The remote has only its own login: a stored account never travels there (T1387).
  if (found && backend === 'ssh') return `${core} account '${name}' has its own login, so the ssh remote cannot use it`;
  if (found?.source === 'command') return `${core} account '${name}' runs the host command '${found.command}', which is not in the container`;
  if (found && backend === 'sbx') {
    if (sbxTokenAccount(core, name) !== undefined && tokenAccounts.has(name)) return undefined;
    return `${core} account '${name}' has its own login and no sbx token, so the sbx sandbox cannot use it`;
  }
  return undefined;
}
