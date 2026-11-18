import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDirLock, DIR_LOCK_RETRY_MS, DIR_LOCK_STALE_MS, DIR_LOCK_TIMEOUT_MS } from './crossWindowLock.js';

const dirs: string[] = [];
const fresh = async (): Promise<string> => { const d = await mkdtemp(join(tmpdir(), 'karst-lock-')); dirs.push(d); return d; };
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('createDirLock', () => {
  it('runs two sections of two locks on one directory one after the other', async () => {
    const dir = join(await fresh(), 'l');
    const a = createDirLock(dir, { retryMs: 2 });
    const b = createDirLock(dir, { retryMs: 2 });
    const trace: string[] = [];
    const section = (name: string) => async (): Promise<string> => { trace.push(`${name}-in`); await sleep(15); trace.push(`${name}-out`); return name; };
    expect(await Promise.all([a(section('a')), b(section('b'))])).toEqual(['a', 'b']);
    expect(trace[1]).toMatch(/-out$/);
    expect(trace[0]!.slice(0, 1)).toBe(trace[1]!.slice(0, 1));
  });

  it('releases the lock when the section throws', async () => {
    const lock = createDirLock(join(await fresh(), 'l'), { retryMs: 2 });
    await expect(lock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await lock(async () => 'again')).toBe('again');
  });

  it('takes over a lock that its holder left behind (older than the stale limit)', async () => {
    const dir = join(await fresh(), 'l');
    await mkdir(dir);
    const old = new Date(Date.now() - 60_000);
    await utimes(dir, old, old);
    expect(await createDirLock(dir, { staleMs: 1000, retryMs: 2 })(async () => 'ok')).toBe('ok');
  });

  it('fails, and does not run the section, when a live lock is held past the time limit', async () => {
    const dir = join(await fresh(), 'l');
    await mkdir(dir);
    let ran = false;
    await expect(createDirLock(dir, { staleMs: 60_000, timeoutMs: 30, retryMs: 2 })(async () => { ran = true; })).rejects.toThrow(/lock/);
    expect(ran).toBe(false);
  });

  it('creates the parent directory of the lock when it is missing', async () => {
    const dir = join(await fresh(), 'missing', 'l');
    expect(await createDirLock(dir, { retryMs: 2 })(async () => 'ok')).toBe('ok');
  });

  it('takes over a stale lock with the default stale limit', async () => {
    const dir = join(await fresh(), 'l');
    await mkdir(dir);
    const old = new Date(Date.now() - DIR_LOCK_STALE_MS - 5000);
    await utimes(dir, old, old);
    expect(await createDirLock(dir)(async () => 'ok')).toBe('ok');
  });

  it('keeps a fresh lock of a live holder with the default stale limit', async () => {
    const dir = join(await fresh(), 'l');
    await mkdir(dir);
    await expect(createDirLock(dir, { timeoutMs: 20, retryMs: 2 })(async () => 'no')).rejects.toThrow(/lock/);
    expect(await stat(dir).then(() => true, () => false)).toBe(true);
  });

  it('waits the default retry delay for a live lock, and takes it when the holder lets go', async () => {
    const dir = join(await fresh(), 'l');
    await mkdir(dir);
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      setTimeout(() => { void rm(dir, { recursive: true }); }, 60);
      expect(await createDirLock(dir)(async () => 'ok')).toBe('ok');
      expect(spy.mock.calls.some((c) => c[1] === DIR_LOCK_RETRY_MS)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('gives up after the default time limit', async () => {
    const dir = join(await fresh(), 'l');
    await mkdir(dir);
    // The clock reads 0 for the deadline, then jumps past the default limit.
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(DIR_LOCK_TIMEOUT_MS + 1);
    try {
      await expect(createDirLock(dir, { retryMs: 2 })(async () => 'no')).rejects.toThrow(/lock/);
    } finally {
      now.mockRestore();
    }
  });

  it('rethrows an error that is not "lock exists", with no wait', async () => {
    const root = await fresh();
    await chmod(root, 0o500);
    try {
      await expect(createDirLock(join(root, 'l'), { timeoutMs: 5000, retryMs: 2 })(async () => 'no')).rejects.toThrow(/EACCES/);
    } finally {
      await chmod(root, 0o700);
    }
  });

  it('does not remove the lock that another window took over while the section ran', async () => {
    const dir = join(await fresh(), 'l');
    const lock = createDirLock(dir, { staleMs: 1, retryMs: 2 });
    const other = createDirLock(dir, { staleMs: 1, retryMs: 2 });
    let inside = false;
    await lock(async () => {
      await sleep(15); // older than the stale limit: the other window takes the lock over
      await other(async () => { inside = true; await rm(join(dir, 'owner')); await writeFile(join(dir, 'owner'), 'peer'); });
    });
    expect(inside).toBe(true);
    // The peer still holds its lock (owner file 'peer'): the first holder must have left it.
    expect(await readFile(join(dir, 'owner'), 'utf8')).toBe('peer');
  });
});
