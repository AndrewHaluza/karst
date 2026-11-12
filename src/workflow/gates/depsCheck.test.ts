import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyNpmProblems, checkNodeDeps, describeDepsBlock } from './depsCheck.js';

describe('classifyNpmProblems', () => {
  it('passes a clean tree', () => {
    expect(classifyNpmProblems(JSON.stringify({ problems: [] }))).toEqual({ ok: true });
  });

  it('flags missing/invalid deps as dependency drift', () => {
    const out = JSON.stringify({
      problems: [
        'missing: @arcus-team/web-contract@0.5.0, required by web_backend',
        'invalid: @arcus-team/web-contract@0.4.0 node_modules/@arcus-team/web-contract',
      ],
    });
    expect(classifyNpmProblems(out)).toEqual({
      ok: false,
      kind: 'dependency-drift',
      reason: expect.stringContaining('missing: @arcus-team/web-contract@0.5.0'),
    });
  });

  it('ignores extraneous-only problems', () => {
    const out = JSON.stringify({ problems: ['extraneous: debug@4.3.4 node_modules/debug'] });
    expect(classifyNpmProblems(out)).toEqual({ ok: true });
  });

  it('reports unparseable output as unreadable', () => {
    expect(classifyNpmProblems('npm ERR! something broke')).toEqual({
      ok: false,
      kind: 'unreadable',
      reason: 'npm ls output was not parseable JSON',
    });
  });

  it('names the count when the whole tree is missing rather than listing three of it', () => {
    const problems = Array.from(
      { length: 1018 },
      (_, i) => `missing: pkg-${i}@1.0.0, required by Web@27.0.98`,
    );
    const result = classifyNpmProblems(JSON.stringify({ problems }));
    expect(result).toEqual({
      ok: false,
      kind: 'dependency-drift',
      reason: expect.stringContaining('1018 dependencies missing'),
    });
  });
});

function lock(deps: Record<string, string>): string {
  const packages: Record<string, { version: string }> = { '': { version: '1.0.0' } };
  for (const [name, version] of Object.entries(deps)) packages[`node_modules/${name}`] = { version };
  return JSON.stringify({ lockfileVersion: 3, packages });
}

function install(dir: string, name: string, version: string): void {
  const pkgDir = join(dir, 'node_modules', ...name.split('/'));
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version }));
}

function manifest(dir: string, deps: string[], devDeps: string[] = []): void {
  const toMap = (names: string[]): Record<string, string> =>
    Object.fromEntries(names.map((n) => [n, '*']));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ dependencies: toMap(deps), devDependencies: toMap(devDeps) }),
  );
}

describe('checkNodeDeps', () => {
  let root: string;
  let worktree: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'karst-deps-'));
    worktree = join(root, '.karst', 'worktrees', 'tkt');
    mkdirSync(worktree, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('skips when the target has no package-lock.json', async () => {
    expect(await checkNodeDeps(worktree)).toEqual({ ok: true });
  });

  it('parks when the lockfile names a package the main checkout lacks, despite a partial local node_modules', async () => {
    manifest(worktree, ['a'], ['eslint-plugin-regexp']);
    writeFileSync(join(worktree, 'package-lock.json'), lock({ a: '1.0.0', 'eslint-plugin-regexp': '2.0.0' }));
    mkdirSync(join(worktree, 'node_modules', '.vite'), { recursive: true });
    install(root, 'a', '1.0.0');
    const result = await checkNodeDeps(worktree, { repoRoot: root });
    expect(result).toEqual({
      ok: false,
      kind: 'dependency-drift',
      reason: 'missing: eslint-plugin-regexp@2.0.0',
      dir: root,
    });
  });

  it('passes when every dependency resolves at the lockfile version', async () => {
    manifest(worktree, ['a', '@s/b'], ['c']);
    writeFileSync(join(worktree, 'package-lock.json'), lock({ a: '1.0.0', '@s/b': '2.1.0', c: '3.0.0' }));
    install(root, 'a', '1.0.0');
    install(root, '@s/b', '2.1.0');
    install(worktree, 'c', '3.0.0');
    expect(await checkNodeDeps(worktree, { repoRoot: root })).toEqual({ ok: true });
  });

  it('parks on a version mismatch', async () => {
    manifest(worktree, ['a']);
    writeFileSync(join(worktree, 'package-lock.json'), lock({ a: '2.0.0' }));
    install(root, 'a', '1.0.0');
    const result = await checkNodeDeps(worktree, { repoRoot: root });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, kind: 'dependency-drift', reason: 'invalid: a@1.0.0 installed, lockfile wants 2.0.0' }),
    );
  });

  it('ignores an extraneous package that is installed but not declared', async () => {
    manifest(worktree, ['a']);
    writeFileSync(join(worktree, 'package-lock.json'), lock({ a: '1.0.0' }));
    install(root, 'a', '1.0.0');
    install(root, 'stray', '9.9.9');
    expect(await checkNodeDeps(worktree, { repoRoot: root })).toEqual({ ok: true });
  });

  it('skips the version compare for a linked or unversioned lock entry but still requires it to resolve', async () => {
    manifest(worktree, ['linked']);
    writeFileSync(
      join(worktree, 'package-lock.json'),
      JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/linked': { link: true, resolved: '../x' } } }),
    );
    install(root, 'linked', '0.0.1');
    expect(await checkNodeDeps(worktree, { repoRoot: root })).toEqual({ ok: true });
  });

  it('summarizes a whole missing tree by count', async () => {
    const names = ['a', 'b', 'c', 'd', 'e'];
    manifest(worktree, names);
    writeFileSync(join(worktree, 'package-lock.json'), lock(Object.fromEntries(names.map((n) => [n, '1.0.0']))));
    const result = await checkNodeDeps(worktree, { repoRoot: root });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: expect.stringContaining('5 dependencies missing') }));
  });

  it('reports unreadable when package.json is not valid JSON', async () => {
    writeFileSync(join(worktree, 'package.json'), '{nope');
    writeFileSync(join(worktree, 'package-lock.json'), lock({}));
    expect(await checkNodeDeps(worktree)).toEqual(
      expect.objectContaining({ ok: false, kind: 'unreadable' }),
    );
  });
});

describe('describeDepsBlock', () => {
  it('names both repairs for drift', () => {
    const text = describeDepsBlock(
      { ok: false, kind: 'dependency-drift', reason: 'missing: x@1.0.0', dir: '/main' },
      'web',
      '/wt/web',
    );
    expect(text).toContain('missing: x@1.0.0');
    expect(text).toContain("npm ci' in /main");
    expect(text).toContain("deps_mode='local'");
    expect(text).toContain('npm install');
  });

  it('reports unreadable without repairs', () => {
    expect(describeDepsBlock({ ok: false, kind: 'unreadable', reason: 'bad' }, 'web', '/wt')).toBe(
      'web: could not verify installed dependencies — bad',
    );
  });
});
