import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyTree, dirArgs, gitArgs, planSecrets, scopeLine } from './secretsGate.mjs';

const base = { sha: 'abcdef0123456789', tried: ['develop'], changed: ['src/a.ts'], dirty: ['src/a.ts'] };

describe('planSecrets', () => {
  it('scopes to the commit range and the uncommitted files', () => {
    expect(planSecrets({ ...base, dirty: ['b', 'a'] })).toEqual({ kind: 'scoped', range: 'abcdef0123456789..HEAD', files: ['a', 'b'] });
  });
  it('keeps the commit scan when nothing is uncommitted', () => {
    expect(planSecrets({ ...base, dirty: [] })).toMatchObject({ kind: 'scoped', files: [] });
  });
  it('runs the full scan when the base is not found', () => {
    expect(planSecrets({ sha: null, tried: ['x', 'y'], changed: null, dirty: null })).toEqual({ kind: 'full', reason: 'no merge base for x, y' });
  });
  it('runs the full scan when git fails', () => {
    expect(planSecrets({ ...base, dirty: null }).kind).toBe('full');
    expect(planSecrets({ ...base, changed: null }).kind).toBe('full');
  });
  it('runs the full scan when .gitleaks.toml changed', () => {
    expect(planSecrets({ ...base, changed: ['.gitleaks.toml'] })).toEqual({ kind: 'full', reason: '.gitleaks.toml changed' });
  });
});

describe('arguments and scope line', () => {
  it('builds the git and dir scans with an absolute config', () => {
    expect(gitArgs({ range: 'a..HEAD' }, '/r/.gitleaks.toml')).toEqual(['git', '--log-opts=a..HEAD', '--config', '/r/.gitleaks.toml', '--no-banner', '--redact', '.']);
    expect(dirArgs('/r/.gitleaks.toml')).toEqual(['dir', '--config', '/r/.gitleaks.toml', '--no-banner', '--redact', '.']);
  });
  it('prints one scope line per plan kind', () => {
    expect(scopeLine({ kind: 'full', reason: 'why' })).toBe('secrets: full scan of the repo (why)');
    expect(scopeLine({ kind: 'scoped', range: 'abcdef0123456789..HEAD', files: ['a'] })).toBe('secrets: commits abcdef012345..HEAD and 1 uncommitted file(s)');
  });
});

describe('copyTree', () => {
  it('keeps repo-relative paths and skips missing files and symlinks', () => {
    const repo = mkdtempSync(join(tmpdir(), 'karst-st-'));
    const copy = [];
    try {
      mkdirSync(join(repo, 'src/deep'), { recursive: true });
      writeFileSync(join(repo, 'src/deep/a.ts'), 'x');
      symlinkSync(join(repo, 'src/deep/a.ts'), join(repo, 'link.ts'));
      const dir = copyTree(repo, ['src/deep/a.ts', 'gone.ts', 'link.ts']);
      copy.push(dir);
      expect(readFileSync(join(dir, 'src/deep/a.ts'), 'utf8')).toBe('x');
      expect(existsSync(join(dir, 'gone.ts'))).toBe(false);
      expect(existsSync(join(dir, 'link.ts'))).toBe(false);
    } finally {
      for (const d of [repo, ...copy]) rmSync(d, { recursive: true, force: true });
    }
  });
});
