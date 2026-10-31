import { describe, it, expect } from 'vitest';
import { manifest, repo, uat, review } from '../fixtures.js';
import { envWarnings, type EnvProbe } from './envWarnings.js';

function probe(over: Partial<EnvProbe> = {}): EnvProbe {
  return {
    pathExists: () => true,
    branchExists: () => true,
    hasRemote: () => true,
    fileExists: () => true,
    ...over,
  };
}

describe('envWarnings', () => {
  it('is silent when the environment matches the manifest', () => {
    expect(envWarnings(manifest({ backend: repo() }), probe())).toEqual([]);
  });

  it('warns when baselineBranch develop is missing in a repo that only has main', () => {
    const m = manifest({ backend: repo({ repoPath: '/r/backend' }) }, { baselineBranch: 'develop' });
    const w = envWarnings(m, probe({ branchExists: (_p, b) => b === 'main' }));
    expect(w).toEqual([
      "repositories.backend.baselineBranch: branch 'develop' not found in /r/backend (local or origin) — create or push it, or set baselineBranch",
    ]);
  });

  it('prefers the per-repository baselineBranch over the manifest default', () => {
    const m = manifest({ backend: repo({ baselineBranch: 'main' }) }, { baselineBranch: 'develop' });
    expect(envWarnings(m, probe({ branchExists: (_p, b) => b === 'main' }))).toEqual([]);
  });

  it('warns when testerVerifier scripts/verify-uat.sh is missing from the repo', () => {
    const m = manifest(
      { backend: repo({ repoPath: '/r/backend' }) },
      { uat: uat({ testerVerifier: { name: 'v', kind: 'command', command: 'scripts/verify-uat.sh', repo: 'backend' } }) },
    );
    const w = envWarnings(m, probe({ fileExists: () => false }));
    expect(w).toEqual([
      "uat.testerVerifier.command: 'scripts/verify-uat.sh' not found in /r/backend — add the script or fix the path",
    ]);
  });

  it('checks a review gate command path against every repository when it names none', () => {
    const m = manifest(
      { a: repo({ repoPath: '/r/a' }), b: repo({ repoPath: '/r/b' }) },
      { review: review({ gates: [{ name: 'g', kind: 'command', command: './ci/check.sh' }] }) },
    );
    const w = envWarnings(m, probe({ fileExists: (p) => p === '/r/a' }));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('/r/b');
  });

  it('ignores bare binaries and absolute paths', () => {
    const m = manifest(
      { backend: repo() },
      { review: review({ gates: [
        { name: 'a', kind: 'command', command: 'npm' },
        { name: 'b', kind: 'command', command: '/usr/bin/env' },
      ] }) },
    );
    expect(envWarnings(m, probe({ fileExists: () => false }))).toEqual([]);
  });

  it('warns when the repo has no origin remote', () => {
    const m = manifest({ backend: repo({ repoPath: '/r/backend' }) });
    expect(envWarnings(m, probe({ hasRemote: () => false }))).toEqual([
      "repositories.backend: no 'origin' remote in /r/backend — ship push needs one (git remote add origin <url>)",
    ]);
  });

  it('warns when review has no gates and no repo has a package.json to probe', () => {
    const m = manifest({ backend: repo() }, { review: review() });
    const w = envWarnings(m, probe({ fileExists: () => false }));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^review\.gates: none declared/);
  });

  it('does not warn about review signal when a package.json exists', () => {
    const m = manifest({ backend: repo() }, { review: review() });
    expect(envWarnings(m, probe())).toEqual([]);
  });

  it('skips a repository whose path is missing or that is disabled', () => {
    const m = manifest({ gone: repo({ repoPath: '/x' }), off: repo({ enabled: false }) });
    const w = envWarnings(m, probe({
      pathExists: (p) => p !== '/x',
      branchExists: () => false,
      hasRemote: () => false,
    }));
    expect(w).toEqual([]);
  });

  describe('absolute in-repo gate paths', () => {
    const gitleaks = (config: string) => ({
      name: 'secrets', kind: 'command' as const, command: 'gitleaks', args: ['dir', '--config', config, '.'],
    });

    it('warns when a review gate arg pins a file in the main checkout', () => {
      const m = manifest(
        { a: repo({ repoPath: '/r/a' }) },
        { review: review({ gates: [gitleaks('/r/a/.gitleaks.toml')] }) },
      );
      expect(envWarnings(m, probe())).toEqual([
        'review.gates[0]: gate secrets pins /r/a/.gitleaks.toml in the main checkout; use a path relative to the worktree',
      ]);
    });

    it('stays silent for a relative path, an outside path and a sibling-prefix path', () => {
      const m = manifest(
        { a: repo({ repoPath: '/r/a' }) },
        { review: review({ gates: [gitleaks('.gitleaks.toml'), gitleaks('/etc/g.toml'), gitleaks('/r/ab/g.toml')] }) },
      );
      expect(envWarnings(m, probe())).toEqual([]);
    });

    it('stays silent for a path inside a ticket worktree', () => {
      const m = manifest(
        { a: repo({ repoPath: '/r/a' }) },
        { review: review({ gates: [gitleaks('/r/a/.karst/worktrees/t1/.gitleaks.toml')] }) },
      );
      expect(envWarnings(m, probe())).toEqual([]);
    });

    it('also flags an absolute command and uat gates', () => {
      const m = manifest(
        { a: repo({ repoPath: '/r/a' }) },
        { uat: uat({ gates: [{ name: 'u', kind: 'command', command: '/r/a/bin/check' }] }) },
      );
      const w = envWarnings(m, probe());
      expect(w).toEqual([
        'uat.gates[0]: gate u pins /r/a/bin/check in the main checkout; use a path relative to the worktree',
      ]);
    });
  });
});
