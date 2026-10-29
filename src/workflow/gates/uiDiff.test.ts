import { describe, expect, it } from 'vitest';
import type { GitRunner } from '../../integrations/git.js';
import type { ResolvedGate } from './resolve.js';
import { cutGatesWithoutUiChange } from './uiDiff.js';

const gate = (name: string, script: string): ResolvedGate => ({
  name, command: 'npm', args: ['run', script], script, required: false,
});
const gates = [gate('unit', 'test'), gate('visual', 'test:visual:docker'), gate('layout', 'test:layout:docker')];

function fakeGit(paths: string[], diffExit = 0): GitRunner {
  return async (args) => {
    if (args[0] === 'merge-base') return { exitCode: 0, stdout: 'abc\n', stderr: '' };
    if (args[0] === 'diff') return { exitCode: diffExit, stdout: paths.join('\0'), stderr: 'boom' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

describe('cutGatesWithoutUiChange', () => {
  it('skips both UI gates for a backend-only diff', async () => {
    const r = await cutGatesWithoutUiChange(gates, fakeGit(['src/store/a.ts']), '/w', 'develop');
    expect(r.kept.map((g) => g.name)).toEqual(['unit']);
    expect(r.skipped.map((g) => g.name)).toEqual(['visual', 'layout']);
  });
  it('keeps everything when a UI path changed', async () => {
    const r = await cutGatesWithoutUiChange(gates, fakeGit(['src/ui/a.tsx']), '/w', 'develop');
    expect(r.skipped).toEqual([]);
    expect(r.kept).toHaveLength(3);
  });
  it('keeps everything when git fails', async () => {
    const r = await cutGatesWithoutUiChange(gates, fakeGit([], 1), '/w', 'develop');
    expect(r.skipped).toEqual([]);
  });
  it('does no git work without a UI gate', async () => {
    const git: GitRunner = async () => { throw new Error('called'); };
    const r = await cutGatesWithoutUiChange([gates[0]!], git, '/w', 'develop');
    expect(r.kept).toHaveLength(1);
  });
});
