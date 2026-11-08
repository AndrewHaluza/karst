import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindGateRuns } from './gateRunsOps.js';

const log = () => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn() });
const settle = () => new Promise((r) => setTimeout(r, 30));
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'gate-ops-test-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const gate = { ticketId: 1, gateName: 'g', pid: 4242, cwd: '/r/.karst/worktrees/t' };

describe('bindGateRuns', () => {
  it('spawned records the gate and removes it with the other registration on end', async () => {
    const binding = bindGateRuns(log(), { dir, startTime: async () => 5 });
    const unregister = vi.fn();
    const dispose = binding.spawned(gate, () => unregister);
    await settle();
    expect(await readdir(dir)).toEqual(['4242']);
    expect(unregister).not.toHaveBeenCalled();
    dispose();
    await settle();
    expect(unregister).toHaveBeenCalledOnce();
    expect(await readdir(dir)).toEqual([]);
  });

  it('spawned accepts a registration with no disposer', () => {
    const binding = bindGateRuns(log(), { dir, startTime: async () => 5 });
    expect(() => binding.spawned(gate, () => undefined)()).not.toThrow();
  });

  it('passes the debug logger to the registry', async () => {
    const l = log();
    const binding = bindGateRuns(l, { dir, startTime: async () => null });
    binding.spawned(gate, () => undefined);
    await settle();
    expect(l.debug).toHaveBeenCalled();
  });

  it('reapOrphans kills a dead host group and logs the reap', async () => {
    const l = log();
    const kill = vi.fn((_pid: number) => 'killed' as const);
    await writeFile(join(dir, '4242'), JSON.stringify({ hostPid: 1, pgid: 4242, startMs: 9, ticketId: 3, gateName: 'sast', worktree: 'w' }));
    const facts = { isAlive: (pid: number) => pid !== 1, processStartMs: () => 9, liveCwd: () => ({ path: '/r/.karst/worktrees/t', deleted: false }) };
    await bindGateRuns(l, { dir, facts, kill }).reapOrphans();
    expect(kill).toHaveBeenCalledWith(4242);
    expect(l.info).toHaveBeenCalledWith(expect.stringContaining('sast'));
  });

  it('reapOrphans reports a failure through the error logger', async () => {
    const l = log();
    await writeFile(join(dir, '4242'), JSON.stringify({ hostPid: 1, pgid: 4242, startMs: 9, ticketId: 3, gateName: 'sast', worktree: 'w' }));
    const facts = { isAlive: () => { throw new Error('probe'); }, processStartMs: () => 9, liveCwd: () => null };
    await bindGateRuns(l, { dir, facts }).reapOrphans();
    expect(l.error).toHaveBeenCalledWith(expect.stringContaining('orphaned-gate'), expect.any(Error));
  });
});
