import { describe, it, expect } from 'vitest';
import { renderConflictBrief } from './conflictBrief.js';

const BASE = {
  ticketLabel: 'ABC-1',
  repo: 'api',
  worktreePath: '/wt/api',
  branch: 'karst/feat/abc-1',
  baseRef: 'develop',
  files: ['src/a.ts', 'src/b.ts'],
  prUrl: 'https://github.com/o/r/pull/12',
};

describe('renderConflictBrief', () => {
  // The brief IS the context the resolve button promises to pass. Everything the
  // agent needs to act without re-deriving it: where, against what, and which
  // files the probe named.
  it('names the worktree, the base branch, the branch and every conflicting file', () => {
    const brief = renderConflictBrief(BASE);

    expect(brief).toContain('/wt/api');
    expect(brief).toContain('origin/develop');
    expect(brief).toContain('karst/feat/abc-1');
    expect(brief).toContain('src/a.ts');
    expect(brief).toContain('src/b.ts');
    expect(brief).toContain('https://github.com/o/r/pull/12');
    expect(brief).toContain('ABC-1');
  });

  // The branch is already pushed and a PR points at it. A rebase would rewrite
  // published history and force a force-push; the brief must ask for a merge.
  it('asks for a merge and forbids rewriting the pushed branch', () => {
    const brief = renderConflictBrief(BASE);

    expect(brief).toContain('git merge origin/develop');
    expect(brief.toLowerCase()).toContain('do not rebase');
    expect(brief.toLowerCase()).toContain('force-push');
  });

  // Without a base ref there is nothing to merge FROM. Interpolating a null
  // would send the agent at a branch literally named "null".
  it('never invents a base branch when none is recorded', () => {
    const brief = renderConflictBrief({ ...BASE, baseRef: null });

    expect(brief).not.toContain('null');
    expect(brief).not.toContain('origin/');
    expect(brief.toLowerCase()).toContain('no base branch is recorded');
  });

  // A conflicted verdict with no parsed paths is still conflicted (the verdict
  // came from an exit code). The brief must not read as "nothing to do".
  it('still asks for a resolution when the probe listed no files', () => {
    const brief = renderConflictBrief({ ...BASE, files: [] });

    expect(brief).toContain('git merge origin/develop');
    expect(brief.toLowerCase()).toContain('did not list');
  });

  // A giant list is prompt bloat, not context — git will name them all again the
  // moment the merge runs.
  it('caps the listed files and says how many were held back', () => {
    const files = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`);

    const brief = renderConflictBrief({ ...BASE, files });

    expect(brief).toContain('src/f0.ts');
    expect(brief).not.toContain('src/f29.ts');
    expect(brief).toContain('+5 more');
  });

  it('omits the PR line when the repo has no PR url', () => {
    const brief = renderConflictBrief({ ...BASE, prUrl: null });

    expect(brief).not.toContain('Pull request:');
  });
});
