import { describe, it, expect } from 'vitest';
import type { GitBytesRunner, GitRunner } from '../../integrations/git.js';
import { gateFingerprint } from './gateFingerprint.js';

const REPOS = [{ repo: '/r', cwd: '/wt', baseRef: 'develop' }];

function deps(over: { diff?: string; untracked?: string; truncated?: boolean; diffExit?: number } = {}) {
  const git: GitRunner = async (args) => {
    if (args[0] === 'merge-base') return { stdout: 'mb\n', stderr: '', exitCode: 0 };
    if (args[0] === 'ls-files') return { stdout: over.untracked ?? '', stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const gitBytes: GitBytesRunner = async () => ({
    stdout: Buffer.from(over.diff ?? 'diff-1'),
    stdoutTruncated: over.truncated ?? false,
    stderr: '',
    exitCode: over.diffExit ?? 0,
  });
  return { git, gitBytes, readFile: async (abs: string) => Buffer.from(`content:${abs}`) };
}

describe('gateFingerprint', () => {
  it('is identical across two unchanged runs', async () => {
    const a = await gateFingerprint(deps({ untracked: 'u1\0u2\0' }), REPOS);
    const b = await gateFingerprint(deps({ untracked: 'u2\0u1\0' }), REPOS);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b); // untracked order does not matter
  });

  it('changes with the tracked diff and with the untracked set', async () => {
    const base = await gateFingerprint(deps(), REPOS);
    expect(await gateFingerprint(deps({ diff: 'diff-2' }), REPOS)).not.toBe(base);
    expect(await gateFingerprint(deps({ untracked: 'new.png\0' }), REPOS)).not.toBe(base);
  });

  it('is null — never a guess — when the diff failed or was truncated', async () => {
    expect(await gateFingerprint(deps({ truncated: true }), REPOS)).toBeNull();
    expect(await gateFingerprint(deps({ diffExit: 1 }), REPOS)).toBeNull();
  });
});
