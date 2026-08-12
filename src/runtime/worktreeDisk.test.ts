import { describe, expect, it, vi } from 'vitest';
import { DISK_CACHE_TTL_MS, WorktreeDiskCache } from './worktreeDisk.js';

const run = (line: string) =>
  vi.fn(async (_cmd: string, args: string[]) => `${line}\t${args[1] ?? ''}\n`);

describe('WorktreeDiskCache', () => {
  it("parses '145412\\t/path\\n' into bytes", async () => {
    const cache = new WorktreeDiskCache(() => 1_000, run('145412') as never);
    const usage = await cache.measure('/path');
    expect(usage?.bytes).toBe(145_412 * 1024);
    expect(usage?.path).toBe('/path');
    expect(usage?.measuredMs).toBe(1_000);
  });

  it('serves a second measure within the TTL without spawning', async () => {
    const spawned = run('100');
    const cache = new WorktreeDiskCache(() => 1_000, spawned as never);
    const first = await cache.measure('/x');
    const second = await cache.measure('/x');
    expect(first?.bytes).toBe(100 * 1024);
    expect(second?.bytes).toBe(100 * 1024);
    expect(spawned).toHaveBeenCalledTimes(1);
  });

  it('spawns again once the TTL has elapsed', async () => {
    let t = 1_000;
    const spawned = run('100');
    const cache = new WorktreeDiskCache(() => t, spawned as never);
    await cache.measure('/x');
    t += DISK_CACHE_TTL_MS + 1;
    await cache.measure('/x');
    expect(spawned).toHaveBeenCalledTimes(2);
  });

  it('returns null and caches nothing when the run answers null', async () => {
    const spawned = vi.fn(async () => null);
    const cache = new WorktreeDiskCache(() => 1_000, spawned as never);
    expect(await cache.measure('/x')).toBeNull();
    expect(cache.get('/x')).toBeUndefined();
    await cache.measure('/x');
    expect(spawned).toHaveBeenCalledTimes(2);
  });

  it('returns null and caches nothing on an already-aborted signal', async () => {
    const spawned = vi.fn(async () => '10\t/x\n');
    const cache = new WorktreeDiskCache(() => 1_000, spawned as never);
    const controller = new AbortController();
    controller.abort();
    expect(await cache.measure('/x', controller.signal)).toBeNull();
    expect(cache.get('/x')).toBeUndefined();
    expect(spawned).not.toHaveBeenCalled();
  });

  it('returns null for unparseable output and caches nothing', async () => {
    const spawned = vi.fn(async () => 'garbage');
    const cache = new WorktreeDiskCache(() => 1_000, spawned as never);
    expect(await cache.measure('/x')).toBeNull();
    expect(cache.get('/x')).toBeUndefined();
  });

  it('measureAll calls onEach once per path, in order', async () => {
    const spawned = vi.fn(async (_cmd: string, args: string[]) => `1\t${args[1] ?? ''}\n`);
    const cache = new WorktreeDiskCache(() => 1_000, spawned as never);
    const order: string[] = [];
    await cache.measureAll(['/a', '/b', '/c'], new AbortController().signal, (u) => {
      order.push(u.path);
    });
    expect(order).toEqual(['/a', '/b', '/c']);
    expect(spawned).toHaveBeenCalledTimes(3);
  });

  it('aborts part-way and stops further spawns', async () => {
    const spawned = vi.fn(async () => '10\t/path\n');
    const cache = new WorktreeDiskCache(() => 1_000, spawned as never);
    const controller = new AbortController();
    const onEach = vi.fn(() => controller.abort());
    await cache.measureAll(['/a', '/b', '/c'], controller.signal, onEach);
    expect(onEach).toHaveBeenCalledTimes(1);
    expect(spawned).toHaveBeenCalledTimes(1);
  });

  it('resolves immediately for an empty path list', async () => {
    const spawned = vi.fn(async () => '10\t/path\n');
    const cache = new WorktreeDiskCache(() => 1_000, spawned as never);
    const onEach = vi.fn();
    await cache.measureAll([], new AbortController().signal, onEach);
    expect(onEach).not.toHaveBeenCalled();
    expect(spawned).not.toHaveBeenCalled();
  });
});
