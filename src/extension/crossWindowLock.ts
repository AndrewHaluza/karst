/**
 * A lock between the windows of one user (@arch:AC-60). SecretStorage has no compare-and-set,
 * so a read-change-write of a shared record needs a lock outside it. A directory is the lock:
 * `mkdir` is atomic, and a lock older than the stale limit belongs to a holder that died.
 * Vscode-free: it takes the lock path as an argument.
 */
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DIR_LOCK_STALE_MS = 10_000;
export const DIR_LOCK_TIMEOUT_MS = 5_000;
export const DIR_LOCK_RETRY_MS = 25;

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
  const take = async (): Promise<boolean> => {
    await mkdir(dirname(path), { recursive: true });
    try {
      await mkdir(path);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const held = await stat(path).catch(() => undefined);
      if (held && Date.now() - held.mtimeMs > staleMs) await rm(path, { recursive: true, force: true });
      return false;
    }
  };
  return async <T>(section: () => Promise<T>): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await take())) {
      if (Date.now() >= deadline) throw new Error('the cross-window lock is held by another window');
      await sleep(retryMs);
    }
    try {
      return await section();
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  };
}
