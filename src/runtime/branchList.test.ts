import { describe, expect, it } from 'vitest';
import type { GitRunner } from '../integrations/git.js';
import { listBaseBranchCandidates } from './branchList.js';

const runner = (stdout: string, exitCode = 0): GitRunner => async () => ({
  stdout,
  stderr: '',
  exitCode,
});

describe('listBaseBranchCandidates', () => {
  it('strips the remote prefix and dedupes local against remote', async () => {
    const git = runner(
      ['develop', 'main', 'origin/develop', 'origin/epic/checkout', 'origin/HEAD'].join('\n'),
    );
    expect(await listBaseBranchCandidates(git, '/repo')).toEqual([
      'develop',
      'epic/checkout',
      'main',
    ]);
  });

  it('answers an empty list rather than throwing when git fails', async () => {
    expect(await listBaseBranchCandidates(runner('', 128), '/repo')).toEqual([]);
  });

  it('ignores blank lines and surrounding whitespace', async () => {
    expect(await listBaseBranchCandidates(runner('  main  \n\n develop \n'), '/repo')).toEqual([
      'develop',
      'main',
    ]);
  });
});
