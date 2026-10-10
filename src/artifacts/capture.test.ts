import { describe, expect, it, vi } from 'vitest';

import type { TaggedOutput } from '../approaches/outputs.js';
import type { GitRunner } from '../integrations/git.js';
import { captureWorktree, type CaptureDeps } from './capture.js';
import type { RevisionInput } from './store.js';

const outputs: TaggedOutput[] = [{ approachId: 'sp', glob: 'docs/plans/**', kind: 'plan' }];

/** Fake git: merge-base ok, tracked diff and untracked lists as given. */
function fakeGit(tracked: string, untracked: string): GitRunner {
  return async (args) => {
    const out = args[0] === 'merge-base' ? 'abc\n' : args[0] === 'diff' ? tracked : untracked;
    return { stdout: out, stderr: '', exitCode: 0 };
  };
}

function setup(tracked: string, untracked = '') {
  const commits: RevisionInput[] = [];
  const deps: CaptureDeps = {
    store: { commitRevision: async (i) => (commits.push(i), 'sha') },
    git: fakeGit(tracked, untracked),
    outputs: () => outputs,
    trailers: (_t, o) => ({ approach: o.approachId, kind: o.kind }),
    debug: vi.fn(),
  };
  const target = { ticketId: 4, repoPath: '/r/app', worktreePath: '/wt/app', baseRef: 'develop' };
  return { commits, deps, target };
}

describe('captureWorktree', () => {
  it('commits only files matching outputs, prefixed with the repo name', async () => {
    const { commits, deps, target } = setup('M\0docs/plans/a.md\0M\0src/x.ts\0', 'docs/plans/b.md\0');
    expect(await captureWorktree(deps, target)).toBe(2);
    expect(commits.map((c) => [c.repo, c.relPath])).toEqual([
      ['app', 'docs/plans/a.md'],
      ['app', 'docs/plans/b.md'],
    ]);
    expect(commits[0]).toMatchObject({ sourcePath: '/wt/app/docs/plans/a.md', trailers: { kind: 'plan' } });
  });

  it('records deletions without a source path', async () => {
    const { commits, deps, target } = setup('D\0docs/plans/a.md\0');
    await captureWorktree(deps, target);
    expect(commits[0]).toMatchObject({ deleted: true, relPath: 'docs/plans/a.md' });
    expect(commits[0]).not.toHaveProperty('sourcePath');
  });

  it('honors the `only` path set', async () => {
    const { commits, deps, target } = setup('M\0docs/plans/a.md\0M\0docs/plans/b.md\0');
    await captureWorktree(deps, target, new Set(['docs/plans/b.md']));
    expect(commits.map((c) => c.relPath)).toEqual(['docs/plans/b.md']);
  });

  it('never throws; a failing store yields 0', async () => {
    const { deps, target } = setup('M\0docs/plans/a.md\0');
    const failing = { ...deps, store: { commitRevision: async () => { throw new Error('boom'); } } };
    expect(await captureWorktree(failing, target)).toBe(0);
    expect(failing.debug).toHaveBeenCalledWith(expect.stringContaining('capture failed'));
  });

  it('captures nothing when no outputs are configured', async () => {
    const { commits, deps, target } = setup('M\0docs/plans/a.md\0');
    await captureWorktree({ ...deps, outputs: () => [] }, target);
    expect(commits).toEqual([]);
  });
});
