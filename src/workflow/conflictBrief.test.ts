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

describe('renderConflictBrief sandboxed', () => {
  it('tells the agent to commit and emit the fix marker, with no fetch or push', () => {
    const out = renderConflictBrief({ ticketLabel: 'K-1', repo: 'r', worktreePath: '/w', branch: 'b', baseRef: 'main', files: [], prUrl: null, sandboxed: true, stageCurrent: 'fix' });
    expect(out).toContain('`fix` marker');
    expect(out).toContain('Do not run `git fetch` or `git push`');
    expect(out).not.toContain('git fetch origin main');
  });
  it('names the shipped base ref and runs the gate scripts before the commit', () => {
    const out = renderConflictBrief({ ticketLabel: 'K-1', repo: 'r', worktreePath: '/w', branch: 'b', baseRef: 'develop', files: [], prUrl: null, sandboxed: true, stageCurrent: 'fix' });
    expect(out).toContain('`git merge --no-ff refs/karst/base/develop`');
    expect(out).toContain('docs check, typecheck, unit tests');
    expect(out.indexOf('gate scripts')).toBeLessThan(out.indexOf('Commit the merge'));
    expect(out).not.toContain('host merges');
  });
});

// The brief ends the way the ticket's stage ends (arch:BLOCKED, arch:STAGEMACH).
// A conflict at ship has no marker — telling the agent to fire one sent T758 and
// T765 into a refused marker and then a manual push that D247 replaces.
describe('renderConflictBrief stage-aware ending', () => {
  const at = (stageCurrent: 'impl' | 'fix' | 'ship') => ({
    ticketLabel: 'K-1', repo: 'r', worktreePath: '/w', branch: 'b', baseRef: 'main', files: [], prUrl: null, stageCurrent,
  });

  it('host + ship: no marker, no push instruction, Karst delivers', () => {
    const out = renderConflictBrief({ ...at('ship') });
    expect(out).not.toContain('`impl` marker');
    expect(out).not.toContain('`fix` marker');
    expect(out).toContain('there is no marker');
    expect(out).toContain('gate exit codes');
    expect(out).not.toContain('push it to the same branch');
    expect(out).not.toContain('git push');
    expect(out).toContain('Do not push');
    expect(out).toContain('delivers it to the open PR');
  });

  it('host + impl: names the impl marker and the automatic delivery', () => {
    const out = renderConflictBrief({ ...at('impl') });
    expect(out).toContain('`impl` marker');
    expect(out).toContain('Do not push');
    expect(out).toContain('delivers it to the open PR');
  });

  it('host + fix: names the fix marker and the automatic delivery', () => {
    const out = renderConflictBrief({ ...at('fix') });
    expect(out).toContain('`fix` marker');
    expect(out).toContain('Do not push');
    expect(out).toContain('delivers it to the open PR');
  });

  it('sandbox + ship: no marker (never the fix marker), Karst delivers', () => {
    const out = renderConflictBrief({ ...at('ship'), sandboxed: true });
    expect(out).not.toContain('`fix` marker');
    expect(out).not.toContain('`impl` marker');
    expect(out).toContain('there is no marker');
    expect(out).toContain('Do not push');
    expect(out).toContain('delivers it to the open PR');
    expect(out).not.toContain('Deliver to PR');
  });

  it('sandbox + fix: the fix marker plus the same delivery sentence', () => {
    const out = renderConflictBrief({ ...at('fix'), sandboxed: true });
    expect(out).toContain('`fix` marker');
    expect(out).toContain('Do not push');
    expect(out).toContain('delivers it to the open PR');
  });

  // The environment named must be the ticket's real one: a host ticket must not
  // be told it has no origin access, and a sandboxed one must not be sent at
  // `origin/<base>`.
  it('never calls a host ticket a sandbox', () => {
    const host = renderConflictBrief(at('ship'));
    expect(host).not.toContain('sandbox');
    expect(host).not.toContain('refs/karst/base');
  });

  it('never sends a sandboxed ticket at origin', () => {
    const sandbox = renderConflictBrief({ ...at('fix'), sandboxed: true });
    expect(sandbox).not.toContain('git fetch origin');
    expect(sandbox).not.toContain('git merge origin/');
  });
});
