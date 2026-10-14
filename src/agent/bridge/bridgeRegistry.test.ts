import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgePaths, ensureBridgeDir, type BridgePaths } from './bridgeDir.js';
import type { BridgeAttachment } from './bridgeSink.js';
import { createBridgeRegistry } from './bridgeRegistry.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'bridge-reg-')); });
afterEach(() => rm(root, { recursive: true, force: true }));

function fakeAttachment(): BridgeAttachment & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } {
  return { start: vi.fn(), stop: vi.fn(async () => {}), pollOnce: vi.fn(async () => {}) };
}

const exists = async (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

describe('bridgeRegistry', () => {
  it('attach is idempotent: one attachment, one start()', async () => {
    const a = fakeAttachment();
    const build = vi.fn((_id: number, _p: BridgePaths) => a);
    const reg = createBridgeRegistry({ root, build });
    const p1 = await reg.attach(3);
    const p2 = await reg.attach(3);
    expect(p2).toEqual(p1);
    expect(p1).toEqual(bridgePaths(root, 3));
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith(3, p1);
    expect(a.start).toHaveBeenCalledTimes(1);
    expect(await exists(p1.eventsFile)).toBe(true);
  });

  it('attach with no attachment (ticket gone) still returns the paths and attaches nothing', async () => {
    const build = vi.fn(() => undefined);
    const reg = createBridgeRegistry({ root, build });
    await reg.attach(4);
    await reg.attach(4);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('detach stops the poller but leaves events.ndjson (sandbox keeps running)', async () => {
    const a = fakeAttachment();
    const reg = createBridgeRegistry({ root, build: () => a });
    const p = await reg.attach(3);
    await reg.detach(3);
    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(await exists(p.eventsFile)).toBe(true);
    await reg.detach(3);
    expect(a.stop).toHaveBeenCalledTimes(1);
    const b = fakeAttachment();
    const reg2 = createBridgeRegistry({ root, build: () => b });
    await reg2.attach(3);
    expect(b.start).toHaveBeenCalledTimes(1);
  });

  it('re-attach after detach builds a fresh attachment', async () => {
    const build = vi.fn(() => fakeAttachment());
    const reg = createBridgeRegistry({ root, build });
    await reg.attach(3);
    await reg.detach(3);
    await reg.attach(3);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('dispose stops the poller and removes the dir and the offset state', async () => {
    const a = fakeAttachment();
    const reg = createBridgeRegistry({ root, build: () => a });
    const p = await reg.attach(3);
    await writeFile(p.stateFile, '{"offset":1}');
    await reg.dispose(3);
    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(await exists(p.dir)).toBe(false);
    expect(await exists(p.stateFile)).toBe(false);
  });

  it('sweep re-attaches a bridge dir whose ticket is open', async () => {
    await ensureBridgeDir(bridgePaths(root, 3));
    const a = fakeAttachment();
    const reg = createBridgeRegistry({ root, build: () => a });
    expect(await reg.sweep(new Set([3]))).toEqual({ reattached: [3], removed: [] });
    expect(a.start).toHaveBeenCalledTimes(1);
  });

  it('sweep removes a bridge dir whose ticket is closed or unknown', async () => {
    const p = bridgePaths(root, 9);
    await ensureBridgeDir(p);
    const reg = createBridgeRegistry({ root, build: () => fakeAttachment() });
    expect(await reg.sweep(new Set())).toEqual({ reattached: [], removed: [9] });
    expect(await exists(p.dir)).toBe(false);
  });

  it('sweep leaves an open ticket another window owns alone (neither attached nor removed)', async () => {
    const p = bridgePaths(root, 5);
    await ensureBridgeDir(p);
    const build = vi.fn(() => fakeAttachment());
    const reg = createBridgeRegistry({ root, build });
    expect(await reg.sweep(new Set([5]), new Set())).toEqual({ reattached: [], removed: [] });
    expect(build).not.toHaveBeenCalled();
    expect(await exists(p.dir)).toBe(true);
  });

  it('sweep re-attaches an open ticket this window owns', async () => {
    await ensureBridgeDir(bridgePaths(root, 5));
    const reg = createBridgeRegistry({ root, build: () => fakeAttachment() });
    expect(await reg.sweep(new Set([5]), new Set([5]))).toEqual({ reattached: [5], removed: [] });
  });

  it('sweep is safe on an empty root', async () => {
    const reg = createBridgeRegistry({ root: join(root, 'nope'), build: () => fakeAttachment() });
    expect(await reg.sweep(new Set([1]))).toEqual({ reattached: [], removed: [] });
  });

  it('sweep never throws: a build() that throws is logged and skipped', async () => {
    await ensureBridgeDir(bridgePaths(root, 2));
    await ensureBridgeDir(bridgePaths(root, 7));
    const debug = vi.fn();
    const reg = createBridgeRegistry({
      root,
      debug,
      build: (id) => {
        if (id === 2) throw new Error('boom');
        return fakeAttachment();
      },
    });
    const result = await reg.sweep(new Set([2, 7]));
    expect(result).toEqual({ reattached: [7], removed: [] });
    expect(debug).toHaveBeenCalledWith('[bridge] sweep skipped ticket 2: boom');
  });

  it('sweep logs a non-Error throw as a string', async () => {
    await ensureBridgeDir(bridgePaths(root, 2));
    const debug = vi.fn();
    const reg = createBridgeRegistry({ root, debug, build: () => { throw 'nope'; } });
    await reg.sweep(new Set([2]));
    expect(debug).toHaveBeenCalledWith('[bridge] sweep skipped ticket 2: nope');
  });
});
