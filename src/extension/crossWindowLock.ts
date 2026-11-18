/**
 * A lock between the windows of one user (@arch:AC-60). SecretStorage has no compare-and-set,
 * so a read-change-write of a shared record needs a lock outside it. A directory is the lock:
 * `mkdir` is atomic, and a lock older than the stale limit belongs to a holder that died.
 * Vscode-free: it takes the lock path as an argument.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const DIR_LOCK_STALE_MS = 10_000;
export const DIR_LOCK_TIMEOUT_MS = 5_000;
export const DIR_LOCK_RETRY_MS = 25;
const OWNER_FILE = 'owner';

export interface DirLockOptions {
  /** A lock older than this has no live holder. */
  readonly staleMs?: number;
  /** How long a section waits for a live lock before it fails. */
  readonly timeoutMs?: number;
  readonly retryMs?: number;
}

export type WithLock = <T>(section: () => Promise<T>) => Promise<T>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createDirLock(path: string, options: DirLockOptions = {}): WithLock {
  const staleMs = options.staleMs ?? DIR_LOCK_STALE_MS;
  const timeoutMs = options.timeoutMs ?? DIR_LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DIR_LOCK_RETRY_MS;
  const take = async (owner: string): Promise<boolean> => {
    await mkdir(dirname(path), { recursive: true });
    try {
      await mkdir(path);
      await writeFile(join(path, OWNER_FILE), owner);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const held = await stat(path).catch(() => undefined);
      if (held && Date.now() - held.mtimeMs > staleMs) await rm(path, { recursive: true, force: true });
      return false;
    }
  };
  return async <T>(section: () => Promise<T>): Promise<T> => {
    const owner = randomUUID();
    const deadline = Date.now() + timeoutMs;
    while (!(await take(owner))) {
      if (Date.now() >= deadline) throw new Error('the cross-window lock is held by another window');
      await sleep(retryMs);
    }
    try {
      return await section();
    } finally {
      // A holder that ran past the stale limit may have lost the lock to another window: remove only a lock that is still ours.
      const current = await readFile(join(path, OWNER_FILE), 'utf8').catch(() => undefined);
      if (current === owner) await rm(path, { recursive: true, force: true });
    }
  };
}
