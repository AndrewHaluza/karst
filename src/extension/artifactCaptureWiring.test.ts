import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { watch } from 'node:fs';

import type { GitRunner } from '../integrations/git.js';
import { openStore, type Store } from '../store/db.js';
import { WATCHER_SYNC_MS, wireArtifactCapture } from './artifactCaptureWiring.js';

describe('wireArtifactCapture', () => {
  let store: Store;
  const watched: string[] = [];
  const closed: string[] = [];
  const fsWatch = ((dir: string) => {
    watched.push(dir);
    return { on: () => {}, close: () => closed.push(dir) };
  }) as unknown as typeof watch;
  const git: GitRunner = async () => ({ stdout: '', stderr: '', exitCode: 1 });

  beforeEach(() => {
    vi.useFakeTimers();
    store = openStore(':memory:');
    watched.length = 0;
    closed.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  const wire = (debug: (m: string) => void = () => {}) =>
    wireArtifactCapture({
      store,
      globalStorageRoot: '/nonexistent-gs',
      projectId: () => 1,
      manifest: () => ({ approaches: [{ id: 'gsd' }] }) as never,
      git,
      debug,
      fsWatch,
    });

  const addWorktree = () => {
    store.db.prepare(`INSERT INTO projects (id, slug, name) VALUES (1, 'p', 'p')`).run();
    store.db.prepare(`INSERT INTO tickets (id, title, project_id) VALUES (5, 't', 1)`).run();
    store.db
      .prepare(`INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (5, '/r', '/wt', 'b', 'develop')`)
      .run();
  };

  it('reconciles watchers on an interval and stops on dispose', () => {
    const w = wire();
    expect(watched).toEqual([]);
    addWorktree();
    vi.advanceTimersByTime(WATCHER_SYNC_MS);
    expect(watched).toEqual(['/wt']);
    w.dispose();
    expect(closed).toEqual(['/wt']);
    store.db.prepare(`DELETE FROM worktrees`).run();
    addWorktree2();
    vi.advanceTimersByTime(WATCHER_SYNC_MS * 2);
    expect(watched).toEqual(['/wt']); // interval cleared
    function addWorktree2() {
      store.db
        .prepare(`INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (5, '/r', '/wt2', 'b', 'develop')`)
        .run();
    }
  });

  it('syncs once immediately at wire time', () => {
    addWorktree();
    const w = wire();
    expect(watched).toEqual(['/wt']);
    w.dispose();
  });

  it('onSessionEnd captures the ticket worktrees (git runs in the worktree)', async () => {
    addWorktree();
    const cwds: string[] = [];
    const w = wireArtifactCapture({
      store,
      globalStorageRoot: '/nonexistent-gs',
      projectId: () => 1,
      manifest: () => ({ approaches: [{ id: 'gsd' }] }) as never,
      git: async (_args, cwd) => (cwds.push(cwd), { stdout: '', stderr: '', exitCode: 1 }),
      debug: () => {},
      fsWatch,
    });
    w.onSessionEnd(5);
    await vi.advanceTimersByTimeAsync(0);
    w.dispose();
    expect(cwds).toContain('/wt');
  });

  it('beforeRemove passes the archive target through as a capture target (no throw on empty outputs)', async () => {
    const w = wire();
    await expect(
      w.beforeRemove({ ticketId: 5, repoPath: '/r', path: '/wt', branch: 'b', baseRef: 'develop' }),
    ).resolves.toBeUndefined();
    w.dispose();
  });

  it('onSessionEnd never rejects', async () => {
    const debug = vi.fn();
    const w = wire(debug);
    w.onSessionEnd(5);
    await vi.advanceTimersByTimeAsync(0);
    w.dispose();
    expect(debug.mock.calls.flat().join('\n')).not.toContain('failed');
  });
});
