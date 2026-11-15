import { describe, it, expect, vi, afterEach } from 'vitest';
import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createDrain } from '../runtime/drain.js';
import { HEADLESS_DRAINING_MESSAGE, setHeadlessDrain, spawnHeadlessCli } from './headlessSpawn.js';

function fakeSpawn(close: { resolve: () => void }): typeof spawn {
  return vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter };
    child.pid = 77;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    close.resolve = () => child.emit('close', 0);
    return child;
  }) as unknown as typeof spawn;
}

describe('spawnHeadlessCli drain (@arch:DRAIN-01)', () => {
  afterEach(() => setHeadlessDrain(undefined));

  it('counts a started run as live until its child closes', async () => {
    const drain = createDrain();
    setHeadlessDrain(drain);
    const close = { resolve: () => {} };
    const run = spawnHeadlessCli('codex', [], '/wt', {}, fakeSpawn(close));
    expect(drain.inFlight()).toBe(1);
    close.resolve();
    await run;
    expect(drain.inFlight()).toBe(0);
  });

  it('refuses a start while draining, logs one line and spawns nothing', async () => {
    const drain = createDrain();
    setHeadlessDrain(drain);
    drain.begin();
    const onDebug = vi.fn();
    const impl = fakeSpawn({ resolve: () => {} });
    await expect(spawnHeadlessCli('codex', [], '/wt', { onDebug }, impl)).rejects.toThrow(HEADLESS_DRAINING_MESSAGE);
    expect(impl).not.toHaveBeenCalled();
    expect(onDebug).toHaveBeenCalledTimes(1);
    expect(drain.inFlight()).toBe(0);
  });

  it('lets a start inside a live run proceed while draining', async () => {
    const drain = createDrain();
    setHeadlessDrain(drain);
    const close = { resolve: () => {} };
    const impl = fakeSpawn(close);
    const outer = drain.track(async () => {
      drain.begin();
      const inner = spawnHeadlessCli('codex', [], '/wt', {}, impl);
      close.resolve();
      return inner;
    });
    await expect(outer).resolves.toMatchObject({ exitCode: 0 });
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('spawns normally with no drain set', async () => {
    const close = { resolve: () => {} };
    const run = spawnHeadlessCli('codex', [], '/wt', {}, fakeSpawn(close));
    close.resolve();
    await expect(run).resolves.toMatchObject({ exitCode: 0 });
  });
});
