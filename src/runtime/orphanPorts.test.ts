import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { reapOrphanedPorts, describeOrphanReap, worktreeRootsOf } from './orphanPorts.js';

const REPO = '/repos/arcus';
const ROOT = join(REPO, '.karst', 'worktrees');
const ORPHAN_CWD = join(ROOT, 'droid-15796-device-notebook');

describe('worktreeRootsOf', () => {
  it('is the .karst/worktrees directory of each repository, deduped', () => {
    expect(worktreeRootsOf([REPO, REPO, '/repos/other'])).toEqual([
      ROOT,
      join('/repos/other', '.karst', 'worktrees'),
    ]);
  });
});

describe('reapOrphanedPorts', () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => store.close());

  const facts = (cwd: string | null, deleted = false) => ({
    isAlive: async () => true,
    liveCwd: async () => (cwd === null ? null : { path: cwd, deleted }),
    processStartMs: async () => null,
  });

  const deps = (over: Partial<Parameters<typeof reapOrphanedPorts>[1]> = {}) => ({
    host: '127.0.0.1',
    ranges: [[50050, 50051]] as [number, number][],
    repoPaths: [REPO],
    isPortOpen: async () => true,
    listenerPids: async () => [4242],
    facts: facts(ORPHAN_CWD),
    kill: vi.fn(() => 'killed' as const),
    ...over,
  });

  it('kills a listener inside a karst worktree that no running row claims', async () => {
    const kill = vi.fn(() => 'killed' as const);
    const reaped = await reapOrphanedPorts(store, deps({ kill }));
    expect(kill).toHaveBeenCalledWith(4242);
    expect(reaped).toEqual([
      { pid: 4242, port: 50050, cwd: ORPHAN_CWD, outcome: 'killed' },
      { pid: 4242, port: 50051, cwd: ORPHAN_CWD, outcome: 'killed' },
    ]);
  });

  it('leaves a listener a running server row still claims', async () => {
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, cwd, started_at)
         VALUES (1, 'dbgw', '127.0.0.1', 50050, 4242, 'running', '/l', ?, ?)`,
      )
      .run(ORPHAN_CWD, new Date().toISOString());
    const kill = vi.fn(() => 'killed' as const);
    const reaped = await reapOrphanedPorts(store, deps({ kill }));
    expect(kill).not.toHaveBeenCalled();
    expect(reaped).toEqual([]);
  });

  it('never touches a process outside every karst worktree root', async () => {
    const kill = vi.fn(() => 'killed' as const);
    const reaped = await reapOrphanedPorts(
      store,
      deps({ kill, facts: facts('/home/dev/some-app') }),
    );
    expect(kill).not.toHaveBeenCalled();
    expect(reaped).toEqual([]);
  });

  it('never touches a process whose cwd the OS will not report', async () => {
    const kill = vi.fn(() => 'killed' as const);
    const reaped = await reapOrphanedPorts(store, deps({ kill, facts: facts(null) }));
    expect(kill).not.toHaveBeenCalled();
    expect(reaped).toEqual([]);
  });

  it('reaps an orphan whose worktree has since been deleted', async () => {
    // The two-day orphan of the report: its tree is gone, so nothing will ever
    // spin that worktree again and no other sweep can reach it.
    const kill = vi.fn(() => 'killed' as const);
    const reaped = await reapOrphanedPorts(
      store,
      deps({ kill, facts: facts(ORPHAN_CWD, true), ranges: [[50050, 50050]] }),
    );
    expect(kill).toHaveBeenCalledWith(4242);
    expect(reaped[0]!.outcome).toBe('killed');
  });

  it('reports a refused kill as still running, never as a stop that happened', async () => {
    const reaped = await reapOrphanedPorts(
      store,
      deps({ kill: () => 'denied' as const, ranges: [[50050, 50050]] }),
    );
    expect(reaped[0]!.outcome).toBe('kill-failed');
    expect(describeOrphanReap(reaped[0]!)).toMatch(/still running/i);
  });

  it('probes no listeners at all when nothing in the range is open', async () => {
    const listenerPids = vi.fn(async () => [4242]);
    const reaped = await reapOrphanedPorts(
      store,
      deps({ isPortOpen: async () => false, listenerPids }),
    );
    expect(listenerPids).not.toHaveBeenCalled();
    expect(reaped).toEqual([]);
  });

  it('kills one pid once even when it holds several ports', async () => {
    const kill = vi.fn(() => 'killed' as const);
    const reaped = await reapOrphanedPorts(store, deps({ kill }));
    expect(kill).toHaveBeenCalledTimes(1); // one process, one signal
    expect(reaped).toHaveLength(2); // reported per port it held
  });

  it('describes a kill with the port and the worktree it served', () => {
    expect(
      describeOrphanReap({ pid: 7, port: 50050, cwd: ORPHAN_CWD, outcome: 'killed' }),
    ).toMatch(/pid 7.*50050.*droid-15796/);
  });
});
