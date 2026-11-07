/**
 * Host wiring for agent accounts (@arch:AC-55): loads the machine-local
 * `accounts.json`, publishes it to the process-wide registry that every spawn
 * path reads, and returns the operations the account UI (D505) calls. Every
 * mutation re-publishes the config, so `setActive` reaches long-lived readers.
 * vscode-free: `extension.ts` only passes paths and the store.
 */
import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { Store } from '../../store/db.js';
import { createAccountOps, type AccountOps } from '../../agent/accounts/accountOps.js';
import { fileAccountStore, type AccountStore } from '../../agent/accounts/accountStore.js';
import { configureAccounts, configureRecordedAccountLookup } from '../../agent/accounts/registry.js';
import { recordedAccountForSession } from '../../store/sessionLaunchIntents.js';
import type { AccountCore } from '../../agent/accounts/types.js';

const ALIAS_LOOKUP_TIMEOUT_MS = 3000;
const ALIAS_NAME = /^[A-Za-z0-9._-]+$/;

export const DEFAULT_DIRS: Readonly<Record<AccountCore, (home: string) => string>> = {
  claude: (h) => join(h, '.claude'),
  codex: (h) => join(h, '.codex'),
  antigravity: (h) => join(h, '.gemini', 'antigravity-cli'),
  opencode: (h) => join(h, '.local', 'share', 'opencode'),
  opencode2: (h) => join(h, '.local', 'share', 'opencode'),
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

/** Accounts of a core with a running implementation segment (the delete guard). */
export function liveAccountNames(store: Store, core: AccountCore): string[] {
  const rows = store.db
    .prepare(
      `SELECT DISTINCT i.account AS account
         FROM session_launch_intents i
         JOIN implementation_segments s
           ON s.launch_intent_id = i.id
        WHERE i.provider = ? AND i.status = 'confirmed' AND i.account IS NOT NULL AND s.status = 'running'`,
    )
    .all(core) as Array<{ account: string }>;
  return rows.map((r) => r.account);
}

export interface AccountsWiring {
  readonly ops: AccountOps;
  /** Re-read `accounts.json` into the registry (after an external edit). */
  reload(): Promise<void>;
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
  const ops = createAccountOps({
    store: publishing,
    managedRoot: join(input.globalStorageRoot, 'accounts'),
    home,
    defaultDir: (core) => DEFAULT_DIRS[core](home),
    liveAccounts: async (core) => liveAccountNames(input.store, core),
    binaryResolves,
    lookupAlias,
    signedIn: async () => undefined,
    ...(input.debug ? { debug: input.debug } : {}),
  });
  return { ops, reload: publish };
}
