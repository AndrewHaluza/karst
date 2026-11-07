/**
 * Process-wide account config (@arch:AC-55), set by the host from the
 * machine-local store (like `configureOpencode2`). Adapters call
 * `accountLaunchFor` at every spawn; with no config it is the default no-op.
 */
import { resolveAccountLaunch, type AccountLaunch } from './resolve.js';
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
  if (recorded === undefined) return undefined;
  return recorded ?? DEFAULT_ACCOUNT;
}

/**
 * Why a sandbox backend (docker, sbx) cannot run this account, or `undefined`
 * when it can (@arch:AC-51). A command account names a host binary that is not
 * in the container, so the launch falls back to the host with this reason.
 * The default, folder and managed accounts only change the home folder.
 */
export function sandboxAccountBlock(core: AccountCore, account?: string): string | undefined {
  const list = config[core]?.list ?? {};
  const name = account ?? config[core]?.active ?? DEFAULT_ACCOUNT;
  const found = name === DEFAULT_ACCOUNT ? undefined : list[name];
  if (found?.source !== 'command') return undefined;
  return `${core} account '${name}' runs the host command '${found.command}', which is not in the container`;
}
