/**
 * Machine-local file of the headless session ledger (@arch:AC-55):
 * `<globalStorage>/session-accounts.json`, a map `core:sessionId` → account name.
 * Holds no credential. A missing or unreadable file is an empty ledger.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SESSION_LEDGER_MAX } from './registry.js';

export const SESSION_LEDGER_FILE = 'session-accounts.json';

export async function loadSessionLedger(root: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(join(root, SESSION_LEDGER_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

export async function saveSessionLedger(root: string, entries: Readonly<Record<string, string>>): Promise<void> {
  const file = join(root, SESSION_LEDGER_FILE);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(entries)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Add one entry to the file. Each window writes its own entries only: the write
 * reads the file again, so the entries of other windows stay. Writes of one
 * process run one after the other.
 */
export function appendSessionLedger(root: string, key: string, account: string): Promise<void> {
  const run = async (): Promise<void> => {
    // An unreadable file is replaced: the ledger holds no data that cannot be rebuilt by a new run.
    const current = await loadSessionLedger(root).catch(() => ({} as Record<string, string>));
    const { [key]: _old, ...rest } = current;
    const entries = Object.entries({ ...rest, [key]: account }).slice(-SESSION_LEDGER_MAX);
    await saveSessionLedger(root, Object.fromEntries(entries));
  };
  const next = (queues.get(root) ?? Promise.resolve()).then(run, run);
  queues.set(root, next.catch(() => undefined));
  return next;
}
