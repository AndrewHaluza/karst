import { describe, it, expect } from 'vitest';
import { planUatTargets } from './targets.js';
import { manifest, repo, svc } from '../../manifest/fixtures.js';
import type { GitRunner } from '../../integrations/git.js';

// Every repo reports a change, so selection is not what is under test here.
const changed: GitRunner = async (args) =>
  args[0] === 'status'
    ? { exitCode: 0, stdout: ' M src/a.ts\n', stderr: '' }
    : { exitCode: 0, stdout: '', stderr: '' };

describe('planUatTargets', () => {
  it('deduplicates two repository entries that share one repoPath', async () => {
    const targets = await planUatTargets(
      manifest({
        api: repo({ repoPath: '/mono', service: svc() }),
        worker: repo({ repoPath: '/mono', service: svc() }),
      }),
      [{ repo: '/mono', path: '/wt/mono', baseRef: null }],
      changed,
    );
    // One monorepo, one worktree, one run of npm test — but both names, because
    // service identity stays keyed by repository NAME (distinct ports, distinct
    // servers rows), and evidence has to name a place.
    expect(targets).toHaveLength(1);
    expect(targets[0]!.names.sort()).toEqual(['api', 'worker']);
    expect(targets[0]!.path).toBe('/wt/mono');
  });

  it('returns every affected worktree, not just the alphabetically first', async () => {
    const targets = await planUatTargets(
      manifest({
        api: repo({ repoPath: '/api', service: svc() }),
        web: repo({ repoPath: '/web', service: svc() }),
      }),
      [
        { repo: '/web', path: '/wt/web', baseRef: null },
        { repo: '/api', path: '/wt/api', baseRef: null },
      ],
      changed,
    );
    expect(targets.map((t) => t.path).sort()).toEqual(['/wt/api', '/wt/web']);
  });

  it('includes a non-runnable repository as a gate target', async () => {
    const targets = await planUatTargets(
      manifest({ docs: repo({ repoPath: '/docs' }) }),
      [{ repo: '/docs', path: '/wt/docs', baseRef: null }],
      changed,
    );
    expect(targets).toHaveLength(1);
  });

  // Not in the brief: added to close a gap the three tests above leave open.
  // Those three already pass if planUatTargets is nothing but a rename of
  // selectReviewTargets's output, because selectReviewTargets's own
  // `namesByPath` grouping already merges manifest entries that share a
  // repoPath *within a single worktree row*. None of them ever hand
  // `planUatTargets` two *worktree* rows carrying the same repo path, so none
  // of them would fail if planUatTargets's own dedup-by-path were deleted
  // outright. This test does: a duplicated worktree row (the shape a stale or
  // double-written `worktrees` table row would produce) must still collapse
  // to one gate run with the union of names, not one run per row.
  it('collapses two worktree rows that carry the same repo path, merging their names', async () => {
    const targets = await planUatTargets(
      manifest({
        api: repo({ repoPath: '/mono', service: svc() }),
        worker: repo({ repoPath: '/mono', service: svc() }),
      }),
      [
        { repo: '/mono', path: '/wt/mono', baseRef: null },
        { repo: '/mono', path: '/wt/mono', baseRef: null },
      ],
      changed,
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]!.names.sort()).toEqual(['api', 'worker']);
  });
});
