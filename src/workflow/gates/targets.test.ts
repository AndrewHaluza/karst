import { describe, expect, it } from 'vitest';
import { manifest, runnableRepo, dependsOn } from '../../manifest/fixtures.js';
import { selectReviewTargets, type ReviewWorktree } from './targets.js';
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
    expect(await selectReviewTargets(project, worktrees, changed())).toEqual([]);
  });

  it('selects a repository with direct changes', async () => {
    expect(await selectReviewTargets(project, worktrees, changed('/wt/docs'))).toEqual([
      expect.objectContaining({ names: ['docs'], path: '/wt/docs' }),
    ]);
  });

  it('treats uncommitted implementation work as a direct change', async () => {
    expect(await selectReviewTargets(project, worktrees, dirty('/wt/docs'))).toEqual([
      expect.objectContaining({ names: ['docs'], path: '/wt/docs' }),
    ]);
  });

  it('selects a dependent repository when its dependency changed', async () => {
    expect(await selectReviewTargets(project, worktrees, changed('/wt/api'))).toEqual([
      expect.objectContaining({ names: ['api'], path: '/wt/api' }),
      expect.objectContaining({ names: ['web'], path: '/wt/web' }),
    ]);
  });

  it('does not select an unrelated repository for another repository change', async () => {
    const targets = await selectReviewTargets(project, worktrees, changed('/wt/api'));
    expect(targets.flatMap((target) => target.names)).not.toContain('docs');
  });

  it('fails explicitly when neither the remote nor local baseline can be compared', async () => {
    const git: GitRunner = async (args) => ({
      stdout: '',
      stderr: args[0] === 'status' ? '' : 'baseline unavailable',
      exitCode: args[0] === 'status' ? 0 : 128,
    });
    await expect(selectReviewTargets(project, worktrees, git)).rejects.toThrow(
      /cannot determine review changes.*baseline unavailable/,
    );
  });
});
