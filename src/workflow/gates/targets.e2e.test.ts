import { describe, expect, it } from 'vitest';
import { manifest, runnableRepo, dependsOn } from '../../manifest/fixtures.js';
import { selectReviewTargets, type ReviewWorktree, type ReviewTarget } from './targets.js';
import type { GitRunner } from '../../integrations/git.js';

const worktrees: ReviewWorktree[] = [
  { repo: '/repos/api', path: '/wt/api', baseRef: 'develop' },
  { repo: '/repos/web', path: '/wt/web', baseRef: 'develop' },
  { repo: '/repos/docs', path: '/wt/docs', baseRef: 'develop' },
];

const project = manifest({
  api: runnableRepo({}, { repoPath: '/repos/api' }),
  web: runnableRepo(
    { dependsOn: [dependsOn('api', 'http', [{ env: 'API', template: '{port}' }])] },
    { repoPath: '/repos/web' },
  ),
  docs: runnableRepo({}, { repoPath: '/repos/docs' }),
});

/**
 * E2E: git fetch timeout fallback.
 *
 * These tests verify the full `selectReviewTargets` flow when the remote
 * `git fetch` hangs or fails. The fix in this ticket added a 30-second
 * timeout to `hasReviewChanges` so that an unreachable remote does not
 * stall the entire UAT stage indefinitely.
 */

describe('selectReviewTargets — git fetch timeout e2e', () => {
  it('completes when git fetch hangs forever — falls back to local branch', async () => {
    let fetchCount = 0;
    const git: GitRunner = async (args) => {
      if (args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
      if (args[0] === 'fetch') {
        fetchCount++;
        return new Promise<never>(() => {});
      }
      return { stdout: '', stderr: '', exitCode: 1 }; // diff: changes exist
    };

    const selection = await selectReviewTargets(project, worktrees, git, {
      gitFetchTimeoutMs: 50,
    });

    expect(selection.kind).toBe('targets');
    if (selection.kind === 'targets') {
      expect(selection.targets.map((t) => t.names).flat()).toEqual(
        expect.arrayContaining(['api', 'web']),
      );
    }
    expect(fetchCount).toBe(worktrees.length);
  });

  it('completes when git fetch fails fast — falls back to local branch', async () => {
    let fetchCount = 0;
    const git: GitRunner = async (args) => {
      if (args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
      if (args[0] === 'fetch') {
        fetchCount++;
        return { stdout: '', stderr: 'fatal: could not read from remote', exitCode: 128 };
      }
      return { stdout: '', stderr: '', exitCode: 0 }; // diff: no changes
    };

    const selection = await selectReviewTargets(project, worktrees, git);

    expect(selection.kind).toBe('targets');
    if (selection.kind === 'targets') {
      expect(selection.targets).toEqual([]);
    }
    expect(fetchCount).toBe(worktrees.length);
  });

  it('completes when all worktrees hang — every repo gets a timeout fallback', async () => {
    const fetchCalls: string[] = [];
    const git: GitRunner = async (args, cwd) => {
      if (args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
      if (args[0] === 'fetch') {
        fetchCalls.push(cwd);
        return new Promise<never>(() => {});
      }
      // docs has no diff, api and web have changes
      const hasDiff = cwd === '/wt/docs' ? 0 : 1;
      return { stdout: '', stderr: '', exitCode: hasDiff };
    };

    const selection = await selectReviewTargets(project, worktrees, git, {
      gitFetchTimeoutMs: 50,
    });

    expect(selection.kind).toBe('targets');
    if (selection.kind === 'targets') {
      // api changed, web depends on api, docs unchanged
      expect(selection.targets.map((t) => t.names).flat()).toEqual(
        expect.arrayContaining(['api', 'web']),
      );
      expect(selection.targets.map((t) => t.names).flat()).not.toContain('docs');
    }
    // all three worktrees were attempted
    expect(fetchCalls).toEqual(['/wt/api', '/wt/web', '/wt/docs']);
  });

  it('returns unavailable when git status fails (not just fetch)', async () => {
    const git: GitRunner = async (args) => {
      if (args[0] === 'status') {
        return { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    const selection = await selectReviewTargets(project, worktrees, git);

    expect(selection.kind).toBe('unavailable');
    if (selection.kind === 'unavailable') {
      expect(selection.blocker).toBe('capability-missing');
      expect(selection.reason).toMatch(/cannot determine review changes/);
    }
  });

  it('returns unavailable when git diff fails after successful fetch', async () => {
    const git: GitRunner = async (args) => {
      if (args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
      if (args[0] === 'fetch') return { stdout: '', stderr: '', exitCode: 0 };
      // diff fails with unexpected exit code
      return { stdout: '', stderr: 'fatal: bad revision', exitCode: 128 };
    };

    const selection = await selectReviewTargets(project, worktrees, git);

    expect(selection.kind).toBe('unavailable');
    if (selection.kind === 'unavailable') {
      expect(selection.reason).toMatch(/cannot determine review changes/);
    }
  });

  it('mix of hanging and fast worktrees — all complete correctly', async () => {
    const seen = new Set<string>();
    const git: GitRunner = async (args, cwd) => {
      if (args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
      if (args[0] === 'fetch') {
        seen.add(cwd);
        // api hangs, web fails fast, docs succeeds
        if (cwd === '/wt/api') return new Promise<never>(() => {});
        if (cwd === '/wt/web') return { stdout: '', stderr: 'timeout', exitCode: 128 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      const hasDiff = cwd === '/wt/api' ? 1 : 0;
      return { stdout: '', stderr: '', exitCode: hasDiff };
    };

    const selection = await selectReviewTargets(project, worktrees, git, {
      gitFetchTimeoutMs: 50,
    });

    expect(selection.kind).toBe('targets');
    if (selection.kind === 'targets') {
      expect(selection.targets.map((t) => t.names).flat()).toEqual(
        expect.arrayContaining(['api', 'web']),
      );
    }
    expect(seen.size).toBe(3);
  });
});
