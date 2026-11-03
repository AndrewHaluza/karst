import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { TaggedOutput } from '../approaches/outputs.js';
import type { GitRunner } from '../integrations/git.js';
import { captureWorktree, type CaptureDeps } from './capture.js';
import type { RevisionInput } from './store.js';

const outputs: TaggedOutput[] = [{ approachId: 'sp', glob: 'docs/plans/**', kind: 'plan' }];

/** Fake git: merge-base ok, tracked diff and untracked lists as given. */
function fakeGit(tracked: string, untracked: string, gitDir = '.git'): GitRunner {
  return async (args) => {
    if (args[0] === 'rev-parse') return { stdout: `${gitDir}\n`, stderr: '', exitCode: 0 };
    const out = args[0] === 'merge-base' ? 'abc\n' : args[0] === 'diff' ? tracked : untracked;
    return { stdout: out, stderr: '', exitCode: 0 };
  };
}

function setup(tracked: string, untracked = '', gitDir = '.git', stored: Record<string, string> = {}) {
  const commits: RevisionInput[] = [];
  const deps: CaptureDeps = {
    store: {
      commitRevision: async (i) => (commits.push(i), 'sha'),
      listArtifacts: async () => Object.keys(stored).map((path) => ({ path, revisions: 1, latestSha: 'x' })),
      history: async (_t, path) => [{ sha: 'x', at: '', trailers: { source: stored[path] ?? '' } }],
    },
    git: fakeGit(tracked, untracked, gitDir),
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
    const failing = { ...deps, store: { ...deps.store, commitRevision: async () => { throw new Error('boom'); } } };
    expect(await captureWorktree(failing, target)).toBe(0);
    expect(failing.debug).toHaveBeenCalledWith(expect.stringContaining('capture failed'));
  });

  it('captures nothing when no outputs are configured', async () => {
    const { commits, deps, target } = setup('M\0docs/plans/a.md\0');
    await captureWorktree({ ...deps, outputs: () => [] }, target);
    expect(commits).toEqual([]);
  });

  it('notifies onRevision per committed revision; a throwing listener never fails the capture', async () => {
    const { deps, target } = setup('M\0docs/plans/a.md\0');
    const events: unknown[] = [];
    expect(await captureWorktree({ ...deps, onRevision: (e) => events.push(e) }, target)).toBe(1);
    expect(events).toEqual([{ ticketId: 4, kind: 'plan', sha: 'sha', path: 'app/docs/plans/a.md' }]);
    const throwing = { ...deps, onRevision: () => { throw new Error('listener'); } };
    expect(await captureWorktree(throwing, target)).toBe(1);
    expect(throwing.debug).toHaveBeenCalledWith(expect.stringContaining('revision listener failed'));
  });

  it('does not notify for a skipped (null) commit', async () => {
    const { deps, target } = setup('M\0docs/plans/a.md\0');
    const events: unknown[] = [];
    await captureWorktree({ ...deps, store: { ...deps.store, commitRevision: async () => null }, onRevision: (e) => events.push(e) }, target);
    expect(events).toEqual([]);
  });

  describe.each(['MERGE_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'])(
    'while %s exists in the git dir',
    (marker) => {
      it('captures nothing and logs the reason', async () => {
        const gitDir = mkdtempSync(join(tmpdir(), 'karst-gd-'));
        if (marker.includes('-')) mkdirSync(join(gitDir, marker));
        else writeFileSync(join(gitDir, marker), 'abc\n');
        const { commits, deps, target } = setup('', 'docs/plans/base-only.md\0', gitDir);
        expect(await captureWorktree(deps, target)).toBe(0);
        expect(commits).toEqual([]);
        expect(deps.debug).toHaveBeenCalledWith(expect.stringContaining(marker));
      });
    },
  );

  it('resolves a relative git dir against the worktree', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'karst-wt-'));
    mkdirSync(join(wt, '.git'));
    writeFileSync(join(wt, '.git', 'MERGE_HEAD'), 'abc\n');
    const { commits, deps, target } = setup('', 'docs/plans/x.md\0');
    expect(await captureWorktree(deps, { ...target, worktreePath: wt })).toBe(0);
    expect(commits).toEqual([]);
  });

  describe('stale captured paths', () => {
    const stored = { 'app/docs/plans/old.md': 'watcher', 'app/docs/plans/hand.md': 'manual-edit', 'app/docs/plans/hook.md': 'hook', 'app/docs/plans/keep.md': 'watcher', 'other/docs/plans/z.md': 'watcher' };

    function onDisk(target: { worktreePath: string }, paths: string[]): void {
      target.worktreePath = mkdtempSync(join(tmpdir(), 'karst-wt-'));
      for (const p of paths) {
        const rel = p.slice(p.indexOf('/') + 1);
        mkdirSync(join(target.worktreePath, rel, '..'), { recursive: true });
        writeFileSync(join(target.worktreePath, rel), 'x');
      }
    }

    it('keeps the history of a stale path whose file is gone from disk', async () => {
      const { commits, deps, target } = setup('', '', '.git', stored);
      target.worktreePath = mkdtempSync(join(tmpdir(), 'karst-wt-'));
      await captureWorktree(deps, target);
      expect(commits).toEqual([]);
    });

    it('removes watcher/manual-edit revisions no longer in the base diff', async () => {
      const { commits, deps, target } = setup('M\0docs/plans/keep.md\0', '', '.git', stored);
      onDisk(target, Object.keys(stored));
      expect(await captureWorktree(deps, target)).toBe(3);
      const removed = commits.filter((c) => c.deleted).map((c) => c.relPath).sort();
      expect(removed).toEqual(['docs/plans/hand.md', 'docs/plans/old.md']);
      expect(commits.find((c) => c.deleted)).toMatchObject({ repo: 'app', trailers: { kind: 'plan' } });
    });

    it('removes nothing when the untracked listing fails', async () => {
      const { commits, deps, target } = setup('', '', '.git', stored);
      onDisk(target, Object.keys(stored));
      const ok = deps.git;
      deps.git = async (args, cwd) =>
        args[0] === 'ls-files' ? { stdout: '', stderr: 'boom', exitCode: 128 } : ok(args, cwd);
      expect(await captureWorktree(deps, target)).toBe(0);
      expect(commits).toEqual([]);
    });

    it('also removes stale paths on a watcher-scoped pass', async () => {
      const { commits, deps, target } = setup('', '', '.git', stored);
      onDisk(target, Object.keys(stored));
      await captureWorktree(deps, target, new Set(['docs/plans/other.md']));
      expect(commits.filter((c) => c.deleted).length).toBe(3); // old, hand, keep (keep is not in this diff)
    });
  });
});
