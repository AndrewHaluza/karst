/**
 * Host wiring for agent accounts (@arch:AC-55): loads the machine-local
 * `accounts.json`, publishes it to the process-wide registry that every spawn
 * path reads, and returns the operations the account UI (D505) calls. Every
 * mutation re-publishes the config, so `setActive` reaches long-lived readers.
 * vscode-free: `extension.ts` only passes paths and the store.
 */
import { execFile } from 'node:child_process';
import { unwatchFile, watchFile } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { Store } from '../../store/db.js';
import { createAccountOps, type AccountOps } from '../../agent/accounts/accountOps.js';
import { ACCOUNTS_FILE, fileAccountStore, type AccountStore } from '../../agent/accounts/accountStore.js';
import { configureAccounts, configureRecordedAccountLookup, configureSessionLedgerSink, liveHeadlessAccounts, mergeSessionLedger, seedSessionLedger } from '../../agent/accounts/registry.js';
import { appendSessionLedger, loadSessionLedger, SESSION_LEDGER_FILE } from '../../agent/accounts/sessionLedgerStore.js';
import { opencode2Config } from '../../agent/opencode2Binary.js';
import { recordedAccountForSession } from '../../store/sessionLaunchIntents.js';
import { createFileSignedInProbe } from '../../agent/accounts/signedInProbe.js';
import type { AccountCore } from '../../agent/accounts/types.js';

const ALIAS_LOOKUP_TIMEOUT_MS = 3000;
const ALIAS_NAME = /^[A-Za-z0-9._-]+$/;

export const DEFAULT_DIRS: Readonly<Record<AccountCore, (home: string) => string>> = {
  claude: (h) => join(h, '.claude'),
  codex: (h) => join(h, '.codex'),
  antigravity: (h) => join(h, '.gemini', 'antigravity-cli'),
  opencode: (h) => join(h, '.local', 'share', 'opencode'),
  // The default opencode2 account is the Karst-owned home (its XDG_CONFIG_HOME is <home>/config); with no home set it is the shared opencode folder.
  opencode2: (h) => opencode2Config().home || join(h, '.local', 'share', 'opencode'),
};

async function isExecutable(file: string): Promise<boolean> {
  return access(file, constants.X_OK).then(() => true, () => false);
}

export async function binaryResolves(binary: string): Promise<boolean> {
  if (isAbsolute(binary)) return isExecutable(binary);
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir !== '' && (await isExecutable(join(dir, binary)))) return true;
  }
  return false;
}

/** `$SHELL -ic 'alias <name>'`, only for a name that passed the slug check. Output is parsed, never run. */
export function lookupAlias(name: string): Promise<string> {
  if (!ALIAS_NAME.test(name)) return Promise.reject(new Error(`'${name}' is not a valid alias name.`));
  const shell = process.env.SHELL ?? '/bin/sh';
  return new Promise((resolve, reject) => {
    execFile(shell, ['-ic', `alias ${name}`], { timeout: ALIAS_LOOKUP_TIMEOUT_MS, env: process.env }, (err, stdout) => {
      if (err && stdout === '') reject(new Error(`could not read the alias '${name}' from the shell`));
      else resolve(stdout);
    });
  });
}

/**
 * Accounts of a core with a live session (the delete guard): a running
 * implementation segment, or a pending or confirmed fix launch whose recovery
 * round is still open.
 */
export function liveAccountNames(store: Store, core: AccountCore): string[] {
  const rows = store.db
    .prepare(
      `SELECT i.account AS account
         FROM session_launch_intents i
         JOIN implementation_segments s
           ON s.launch_intent_id = i.id
        WHERE i.provider = ? AND i.status = 'confirmed' AND i.account IS NOT NULL AND s.status = 'running'
       UNION
       SELECT i.account AS account
         FROM session_launch_intents i
         JOIN recovery_rounds r
           ON r.id = i.recovery_round_id
        WHERE i.provider = ? AND i.purpose = 'fix' AND i.status IN ('pending','confirmed')
          AND i.account IS NOT NULL AND r.status IN ('pending','fixing')`,
    )
    .all(core, core) as Array<{ account: string }>;
  return rows.map((r) => r.account);
}

export interface AccountsWiring {
  readonly ops: AccountOps;
  /** Re-read `accounts.json` into the registry (after an external edit). */
  reload(): Promise<void>;
  /** Stop watching `accounts.json`. */
  dispose(): void;
}

/** Poll period of the `accounts.json` watch: another window's change reaches this one. */
export const ACCOUNTS_WATCH_MS = 1000;

/** Merge the entries that other windows wrote into the ledger of this window. */
export async function mergeLedgerFile(root: string, debug?: (message: string) => void): Promise<void> {
  try {
    mergeSessionLedger(await loadSessionLedger(root));
  } catch (e) {
    debug?.(`[accounts] session ledger not merged: ${String(e)}`);
  }
}

export async function wireAccounts(input: {
  readonly globalStorageRoot: string;
  readonly store: Store;
  readonly debug?: (message: string) => void;
  readonly accountStore?: AccountStore;
}): Promise<AccountsWiring> {
  const accountStore = input.accountStore ?? fileAccountStore(input.globalStorageRoot);
  const home = homedir();
  const publish = async (): Promise<void> => configureAccounts(await accountStore.load());
  // Every write through the ops re-publishes the config to the registry.
  const publishing: AccountStore = {
    load: () => accountStore.load(),
    save: async (config) => {
      await accountStore.save(config);
      configureAccounts(config);
    },
  };
  configureRecordedAccountLookup((core, sessionId) => recordedAccountForSession(input.store, core, sessionId));
  await publish();
  // Headless sessions have no launch intent: their accounts live in a small ledger file.
  seedSessionLedger(await loadSessionLedger(input.globalStorageRoot).catch((e) => {
    input.debug?.(`[accounts] session ledger not loaded: ${String(e)}`);
    return {};
  }));
  configureSessionLedgerSink((key, account) => {
    appendSessionLedger(input.globalStorageRoot, key, account).catch((e) => input.debug?.(`[accounts] session ledger not saved: ${String(e)}`));
  });
  const ops = createAccountOps({
    store: publishing,
    managedRoot: join(input.globalStorageRoot, 'accounts'),
    home,
    defaultDir: (core) => DEFAULT_DIRS[core](home),
    liveAccounts: async (core) => [...new Set([...liveAccountNames(input.store, core), ...liveHeadlessAccounts(core)])],
    binaryResolves,
    lookupAlias,
    signedIn: createFileSignedInProbe(home, (core) => DEFAULT_DIRS[core](home)),
    ...(input.debug ? { debug: input.debug } : {}),
  });
  // Another window may change accounts.json: re-publish so this window does not
  // keep a stale active account. A failed reload keeps the last good config.
  const file = join(input.globalStorageRoot, ACCOUNTS_FILE);
  const watching = input.accountStore === undefined;
  if (watching) {
    watchFile(file, { interval: ACCOUNTS_WATCH_MS, persistent: false }, () => {
      publish().catch((e) => input.debug?.(`[accounts] reload failed: ${String(e)}`));
    });
  }
  // Another window appends to the ledger: merge its entries so a resume here finds them.
  const ledgerFile = join(input.globalStorageRoot, SESSION_LEDGER_FILE);
  watchFile(ledgerFile, { interval: ACCOUNTS_WATCH_MS, persistent: false }, () => { void mergeLedgerFile(input.globalStorageRoot, input.debug); });
  return { ops, reload: publish, dispose: () => { configureSessionLedgerSink(undefined); unwatchFile(ledgerFile); if (watching) unwatchFile(file); } };
}
