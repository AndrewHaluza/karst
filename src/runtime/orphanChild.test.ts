import { describe, expect, it, vi } from 'vitest';
import { reapOrphanedChild, type OrphanChildRun } from './orphanChild.js';

const SPAWNED = '2026-11-07T10:00:00.000Z';
const SPAWNED_MS = Date.parse(SPAWNED);

function run(over: Partial<OrphanChildRun> = {}): OrphanChildRun {
  return { id: 7, pid: 111, childPid: 222, childStartedAt: SPAWNED, ...over };
}

function setup(opts: { alive?: number[]; startMs?: number | null } = {}) {
  const alive = new Set(opts.alive ?? []);
  const facts = {
    isAlive: async (pid: number) => alive.has(pid),
    processStartMs: async () => (opts.startMs === undefined ? SPAWNED_MS : opts.startMs),
  };
  const kill = vi.fn(() => 'killed' as const);
  const debug = vi.fn();
  return { deps: { facts, kill, debug }, kill, debug };
}

describe('reapOrphanedChild', () => {
  it('kills the group of a live child whose owner host is dead', async () => {
    const { deps, kill, debug } = setup({ alive: [222] });
    expect(await reapOrphanedChild(run(), deps)).toBe('killed');
    expect(kill).toHaveBeenCalledExactlyOnceWith(222);
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0]![0]).toContain('killed');
  });

  it('does not signal when the owner host is alive', async () => {
    const { deps, kill, debug } = setup({ alive: [111, 222] });
    expect(await reapOrphanedChild(run(), deps)).toBe('refused');
    expect(kill).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('does not signal when the owner host pid is unknown', async () => {
    const { deps, kill } = setup({ alive: [222] });
    expect(await reapOrphanedChild(run({ pid: null }), deps)).toBe('refused');
    expect(kill).not.toHaveBeenCalled();
  });

  it('does not signal a reused pid (start time differs)', async () => {
    const { deps, kill, debug } = setup({ alive: [222], startMs: SPAWNED_MS + 3_600_000 });
    expect(await reapOrphanedChild(run(), deps)).toBe('refused');
    expect(kill).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('does not signal when the start time cannot be read', async () => {
    const { deps, kill } = setup({ alive: [222], startMs: null });
    expect(await reapOrphanedChild(run(), deps)).toBe('refused');
    expect(kill).not.toHaveBeenCalled();
  });

  it('does not signal when the run has no child pid', async () => {
    const { deps, kill, debug } = setup({ alive: [222] });
    expect(await reapOrphanedChild(run({ childPid: null }), deps)).toBe('refused');
    expect(kill).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('does not signal when the recorded child start time is missing', async () => {
    const { deps, kill } = setup({ alive: [222] });
    expect(await reapOrphanedChild(run({ childStartedAt: null }), deps)).toBe('refused');
    expect(kill).not.toHaveBeenCalled();
  });

  it('does not signal a child that already exited', async () => {
    const { deps, kill, debug } = setup({ alive: [] });
    expect(await reapOrphanedChild(run(), deps)).toBe('refused');
    expect(kill).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('reports a refused signal (EPERM) as a refusal', async () => {
    const { deps, kill, debug } = setup({ alive: [222] });
    kill.mockReturnValueOnce('denied' as never);
    expect(await reapOrphanedChild(run(), deps)).toBe('refused');
    expect(debug.mock.calls[0]![0]).toContain('denied');
  });
});
