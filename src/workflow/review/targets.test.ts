import { describe, it, expect } from 'vitest';
import { planReviewTargets, type ReviewGateTarget } from './targets.js';
import { manifest, repo, svc } from '../../manifest/fixtures.js';
import type { GitRunner } from '../../integrations/git.js';

// Every repo reports a change, so affected-set selection is not what is under
// test here — `gates/targets.test.ts` owns that.
const changed: GitRunner = async (args) =>
  args[0] === 'status'
    ? { exitCode: 0, stdout: ' M src/a.ts\n', stderr: '' }
    : { exitCode: 0, stdout: '', stderr: '' };

function targetsOf(selection: Awaited<ReturnType<typeof planReviewTargets>>): ReviewGateTarget[] {
  if (selection.kind !== 'targets') {
    throw new Error(`expected targets, got unavailable: ${selection.reason}`);
  }
  return selection.targets;
}

describe('planReviewTargets', () => {
  it('collapses two repository entries sharing one repoPath into one target, keeping both names', async () => {
    const targets = targetsOf(
      await planReviewTargets(
        manifest({
          api: repo({ repoPath: '/mono', service: svc() }),
          worker: repo({ repoPath: '/mono', service: svc() }),
        }),
        [{ repo: '/mono', path: '/wt/mono', baseRef: null }],
        changed,
      ),
    );
    // One monorepo, one worktree, one run of the review gates — but both names,
    // because evidence has to name a place and per-repository config is keyed
    // by repository NAME.
    expect(targets).toHaveLength(1);
    expect(targets[0]!.names.sort()).toEqual(['api', 'worker']);
    expect(targets[0]!.path).toBe('/wt/mono');
  });

  it('collapses two worktree rows carrying the same repo path, merging their names', async () => {
    // The shape a stale or double-written `worktrees` row produces. Running the
    // gates twice in one directory asks the same question twice.
    const targets = targetsOf(
      await planReviewTargets(
        manifest({
          api: repo({ repoPath: '/mono', service: svc() }),
          worker: repo({ repoPath: '/mono', service: svc() }),
        }),
        [
          { repo: '/mono', path: '/wt/mono', baseRef: null },
          { repo: '/mono', path: '/wt/mono', baseRef: null },
        ],
        changed,
      ),
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]!.names.sort()).toEqual(['api', 'worker']);
  });

  it('returns every affected worktree', async () => {
    const targets = targetsOf(
      await planReviewTargets(
        manifest({
          api: repo({ repoPath: '/api', service: svc() }),
          web: repo({ repoPath: '/web', service: svc() }),
        }),
        [
          { repo: '/web', path: '/wt/web', baseRef: null },
          { repo: '/api', path: '/wt/api', baseRef: null },
        ],
        changed,
      ),
    );
    expect(targets.map((t) => t.path).sort()).toEqual(['/wt/api', '/wt/web']);
  });

  it('includes a non-runnable repository — a source tree still has gates', async () => {
    const targets = targetsOf(
      await planReviewTargets(
        manifest({ docs: repo({ repoPath: '/docs' }) }),
        [{ repo: '/docs', path: '/wt/docs', baseRef: null }],
        changed,
      ),
    );
    expect(targets).toHaveLength(1);
  });

  // Environmental, not a selection result: swallowing it into "no targets" would
  // make `runReview` park with `nothing-to-run` instead of `capability-missing`.
  it('propagates a git failure as unavailable rather than collapsing it to no targets', async () => {
    const failing: GitRunner = async () => ({
      exitCode: 128,
      stdout: '',
      stderr: 'baseline unavailable',
    });
    expect(
      await planReviewTargets(
        manifest({ api: repo({ repoPath: '/api', service: svc() }) }),
        [{ repo: '/api', path: '/wt/api', baseRef: null }],
        failing,
      ),
    ).toEqual({
      kind: 'unavailable',
      blocker: 'capability-missing',
      reason: expect.stringContaining('baseline unavailable'),
    });
  });
});
