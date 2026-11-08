/**
 * Process-wide account config (@arch:AC-55), set by the host from the
 * machine-local store (like `configureOpencode2`). Adapters call
 * `accountLaunchFor` at every spawn; with no config it is the default no-op.
 */
import { AccountNotFoundError, activeAccountName, resolveAccountLaunch, type AccountLaunch } from './resolve.js';
import { DEFAULT_ACCOUNT, type AccountCore, type AccountsConfig } from './types.js';

let config: AccountsConfig = {};

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
  return resolveAccountLaunch({ config, core, defaultBinary, ...(account !== undefined ? { account } : {}) });
}

/** Headless spawn options for an account launch: empty for the default account (byte-for-byte unchanged). */
export function accountSpawnEnv(launch: AccountLaunch): { isolationEnv?: Record<string, string> } {
  return Object.keys(launch.env).length > 0 ? { isolationEnv: { ...launch.env } } : {};
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
  return account ?? activeAccountName(config, core);
}

/**
 * Why a sandbox backend (docker, sbx) cannot run this account, or `undefined`
 * when it can (@arch:AC-51). A command account names a host binary that is not
 * in the container, so the launch falls back to the host with this reason.
 * The default, folder and managed accounts only change the home folder.
 */
export function sandboxAccountBlock(core: AccountCore, account?: string, backend: 'docker' | 'sbx' = 'docker'): string | undefined {
  const list = config[core]?.list ?? {};
  const name = account ?? config[core]?.active ?? DEFAULT_ACCOUNT;
  const found = name === DEFAULT_ACCOUNT ? undefined : list[name];
  // An sbx sandbox keeps its own login and has no account folder: any account but default would run under the wrong login.
  if (found?.source === 'command') return `${core} account '${name}' runs the host command '${found.command}', which is not in the container`;
  if (found && backend === 'sbx') return `${core} account '${name}' has its own login, which the sbx sandbox does not use`;
  return undefined;
}
