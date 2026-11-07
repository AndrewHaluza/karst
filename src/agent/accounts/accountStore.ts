/**
 * Machine-local account storage (@arch:AC-55): `<globalStorage>/accounts.json`.
 * Never karst.yml (a shared manifest must not carry folders, commands or logins).
 * Writes are atomic (temp file + rename). vscode-free.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateAccountsConfig, type AccountsConfig } from './types.js';

export const ACCOUNTS_FILE = 'accounts.json';

export class AccountsConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`accounts.json is invalid: ${problems.join('; ')}`);
    this.name = 'AccountsConfigError';
  }
}

export interface AccountStore {
  load(): Promise<AccountsConfig>;
  save(config: AccountsConfig): Promise<void>;
}

/** A missing file is an empty config; an invalid file THROWS (never silently ignored). */
export function fileAccountStore(globalStorageRoot: string): AccountStore {
  const file = join(globalStorageRoot, ACCOUNTS_FILE);
  return {
    async load(): Promise<AccountsConfig> {
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
        throw err;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new AccountsConfigError(['not valid JSON']);
      }
      const problems = validateAccountsConfig(parsed);
      if (problems.length > 0) throw new AccountsConfigError(problems);
      return parsed as AccountsConfig;
    },
    async save(config: AccountsConfig): Promise<void> {
      const problems = validateAccountsConfig(config);
      if (problems.length > 0) throw new AccountsConfigError(problems);
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, file);
    },
  };
}

/** In-memory store for tests and hosts without storage. */
export function memoryAccountStore(initial: AccountsConfig = {}): AccountStore & { current(): AccountsConfig } {
  let cur = initial;
  return {
    load: async () => cur,
    save: async (c) => {
      const problems = validateAccountsConfig(c);
      if (problems.length > 0) throw new AccountsConfigError(problems);
      cur = c;
    },
    current: () => cur,
  };
}
