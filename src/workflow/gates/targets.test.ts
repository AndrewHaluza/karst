import { describe, expect, it } from 'vitest';
import { manifest, runnableRepo, dependsOn } from '../../manifest/fixtures.js';
import { selectReviewTargets, type ReviewWorktree, type ReviewTarget } from './targets.js';
import type { GitRunner } from '../../integrations/git.js';
import { openStore } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';

/** Unwraps the `targets` arm, failing loudly if the selection came back unavailable. */
function targetsOf(selection: Awaited<ReturnType<typeof selectReviewTargets>>): ReviewTarget[] {
  if (selection.kind !== 'targets') {
    throw new Error(`expected targets, got unavailable: ${selection.reason}`);
  }
  return selection.targets;
}

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

function changed(...paths: string[]): GitRunner {
  return async (args, cwd) => ({
    stdout: '',
    stderr: '',
    exitCode: args[0] === 'diff' && paths.includes(cwd) ? 1 : 0,
  });
}

function dirty(...paths: string[]): GitRunner {
  return async (args, cwd) => ({
    stdout: args[0] === 'status' && paths.includes(cwd) ? ' M src/index.ts\n' : '',
    stderr: '',
    exitCode: 0,
  });
}

describe('selectReviewTargets', () => {
  it('selects nothing when no repository changed and no relation is affected', async () => {
    expect(targetsOf(await selectReviewTargets(project, worktrees, changed()))).toEqual([]);
  });

  it('selects a repository with direct changes', async () => {
    expect(targetsOf(await selectReviewTargets(project, worktrees, changed('/wt/docs')))).toEqual(
      [expect.objectContaining({ names: ['docs'], path: '/wt/docs' })],
    );
  });

  it('treats uncommitted implementation work as a direct change', async () => {
    expect(targetsOf(await selectReviewTargets(project, worktrees, dirty('/wt/docs')))).toEqual([
      expect.objectContaining({ names: ['docs'], path: '/wt/docs' }),
    ]);
  });

  it('selects a dependent repository when its dependency changed', async () => {
    expect(targetsOf(await selectReviewTargets(project, worktrees, changed('/wt/api')))).toEqual([
      expect.objectContaining({ names: ['api'], path: '/wt/api' }),
      expect.objectContaining({ names: ['web'], path: '/wt/web' }),
    ]);
  });

  it('does not select an unrelated repository for another repository change', async () => {
    const targets = targetsOf(await selectReviewTargets(project, worktrees, changed('/wt/api')));
    expect(targets.flatMap((target) => target.names)).not.toContain('docs');
  });

  it('maps a worktree to its manifest entry through a symlinked or non-normalised path', async () => {
    const slashProject = manifest({
      api: runnableRepo({}, { repoPath: '/repos/api/' }),
    });
    const targets = targetsOf(
      await selectReviewTargets(
        slashProject,
        [{ repo: '/repos/api', path: '/wt/api', baseRef: 'develop' }],
        changed('/wt/api'),
      ),
    );
    expect(targets).toEqual([expect.objectContaining({ names: ['api'], repo: '/repos/api' })]);
  });

  it('names the worktrees that matched no manifest entry', async () => {
    const selection = await selectReviewTargets(
      manifest({
        api: runnableRepo({}, { repoPath: '/repos/api' }),
      }),
      [
        { repo: '/repos/api', path: '/wt/api', baseRef: 'develop' },
        { repo: '/repos/absent', path: '/wt/absent', baseRef: 'develop' },
      ],
      changed('/wt/api'),
    );
    expect(selection).toEqual({
      kind: 'targets',
      targets: [expect.objectContaining({ names: ['api'], path: '/wt/api' })],
      unmapped: ['/repos/absent'],
    });
  });

  it('reports no unmapped worktrees when every repository resolved', async () => {
    const selection = await selectReviewTargets(project, worktrees, changed());
    expect(selection).toEqual({ kind: 'targets', targets: [], unmapped: [] });
  });

  it('reports a git failure as unavailable rather than throwing', async () => {
    const git: GitRunner = async (args) => ({
      stdout: '',
      stderr: args[0] === 'status' ? '' : 'baseline unavailable',
      exitCode: args[0] === 'status' ? 0 : 128,
    });
    await expect(selectReviewTargets(project, worktrees, git)).resolves.toEqual({
      kind: 'unavailable',
      blocker: 'capability-missing',
      reason: expect.stringMatching(/cannot determine review changes.*baseline unavailable/),
    });
  });

  // fu1: "review agent xterm log shows no changes, but diffs are present". The
  // change probe must diff `origin/<base>...origin/<branch>` so a stale local
  // branch ref never produces an empty diff — the remote state is always used.
  it('probes the diff against the worktree branch, not the checkout HEAD', async () => {
    const diffs: string[][] = [];
    const git: GitRunner = async (args, cwd) => {
      if (args[0] === 'diff') {
        diffs.push(args);
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (args[0] === 'fetch') return { stdout: '', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const targets = targetsOf(
      await selectReviewTargets(project, [{ repo: '/repos/web', path: '/wt/web', baseRef: 'develop', branch: 'karst/x' }], git),
    );
    expect(targets).toEqual([expect.objectContaining({ names: ['web'], path: '/wt/web' })]);
    expect(diffs).toContainEqual(['diff', '--quiet', 'origin/develop...origin/karst/x']);
  });

  it('falls back to probing HEAD when no branch is recorded', async () => {
    const diffs: string[][] = [];
    const git: GitRunner = async (args) => {
      if (args[0] === 'diff') {
        diffs.push(args);
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (args[0] === 'fetch') return { stdout: '', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    await selectReviewTargets(project, worktrees, git);
    expect(diffs).toContainEqual(['diff', '--quiet', 'origin/develop...HEAD']);
  });

  it('reports the worktree row base, not the manifest default', async () => {
    const store = openStore(':memory:');
    const ticket = createTicket(store, { key: 'T-1', title: 't' });
    store.db
      .prepare(
        `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
         VALUES (?, '/repos/api', '/wt/api', 'karst/t-1', 'epic/checkout', 'inherited')`,
      )
      .run(ticket.id);

    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', exitCode: args[0] === 'diff' ? 1 : 0 };
    };

    const targets = targetsOf(
      await selectReviewTargets(
        manifest({ api: runnableRepo({}, { repoPath: '/repos/api' }) }),
        [{ repo: '/repos/api', path: '/wt/api', baseRef: null }],
        git,
        { store, ticketId: ticket.id },
      ),
    );

    expect(targets).toEqual([expect.objectContaining({ names: ['api'], path: '/wt/api' })]);
    expect(calls).toContainEqual(['fetch', 'origin', 'epic/checkout']);
    expect(calls).toContainEqual(['diff', '--quiet', 'origin/epic/checkout...HEAD']);
    expect(calls.every((a) => a.join(' ') !== 'fetch origin develop')).toBe(true);

    store.close();
  });
});
