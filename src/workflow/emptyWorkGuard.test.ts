import { vi, describe, it, expect, beforeEach } from 'vitest';
import { assertTicketHasChanges } from './emptyWorkGuard.js';
import { manifest, repo } from '../manifest/fixtures.js';
import type { GitRunner } from '../integrations/git.js';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from './stages/create.js';

// Fixture worktree paths are fake; stub the existence check (path-handling tests inject their own).
vi.mock('./gates/pathExists.js', () => ({ worktreePathExists: () => true }));

const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });

/** Git fake: `dirty` paths report porcelain output, every diff is empty (unchanged). */
const gitWith = (dirty: readonly string[]): GitRunner => async (args, cwd) =>
  args[0] === 'status' && dirty.includes(cwd ?? '') ? ok(' M a.ts\n') : ok();

describe('assertTicketHasChanges', () => {
  let store: Store;
  let id: number;
  const m = manifest({ api: repo({ repoPath: '/api' }), web: repo({ repoPath: '/web' }) });

  const addWorktree = (repoPath: string, path: string): void => {
    store.db
      .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)')
      .run(id, repoPath, path, 'karst/feat/x');
  };

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
  });

  it('refuses when every mapped target is unchanged, naming the worktree', async () => {
    addWorktree('/api', '/wt/api');
    await expect(assertTicketHasChanges(store, id, m, gitWith([]))).rejects.toThrow(
      /\/wt\/api.*ask the user/s,
    );
  });

  it('accepts when one of several targets has changes', async () => {
    addWorktree('/api', '/wt/api');
    addWorktree('/web', '/wt/web');
    await expect(assertTicketHasChanges(store, id, m, gitWith(['/wt/web']))).resolves.toBeUndefined();
  });

  it('leaves an unmapped worktree to UAT/review (no refusal)', async () => {
    addWorktree('/other', '/wt/other');
    await expect(assertTicketHasChanges(store, id, m, gitWith([]))).resolves.toBeUndefined();
  });

  it('does not apply without a manifest or worktrees', async () => {
    await expect(assertTicketHasChanges(store, id, m, gitWith([]))).resolves.toBeUndefined();
    addWorktree('/api', '/wt/api');
    await expect(assertTicketHasChanges(store, id, undefined, gitWith([]))).resolves.toBeUndefined();
  });

  it('lets the marker through when the probe is unavailable', async () => {
    addWorktree('/api', '/wt/api');
    const broken: GitRunner = async () => ({ exitCode: 128, stdout: '', stderr: 'boom' });
    await expect(assertTicketHasChanges(store, id, m, broken)).resolves.toBeUndefined();
  });
});
