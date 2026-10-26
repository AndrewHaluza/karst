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
});
