import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planCreatedPaths, planIsEmpty, planWorkspaceDeps } from './depsPlan.js';

const dirs: string[] = [];
function repoWith(...files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-depsplan-'));
  dirs.push(dir);
  for (const file of files) writeFileSync(join(dir, file), '');
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('planWorkspaceDeps', () => {
  it('Node: merges node_modules, links nothing else, runs no setup', () => {
    const plan = planWorkspaceDeps(repoWith('package.json', 'package-lock.json'));
    expect(plan).toMatchObject({ source: 'detected', node: true, link: [], setupWhen: [] });
    expect(plan.setup).toBeUndefined();
    expect(planCreatedPaths(plan)).toEqual(['node_modules']);
  });

  it('uv: links .venv, runs `uv sync --frozen` when uv.lock changed', () => {
    const plan = planWorkspaceDeps(repoWith('pyproject.toml', 'uv.lock'));
    expect(plan).toMatchObject({ node: false, link: ['.venv'], setup: 'uv sync --frozen', setupWhen: ['uv.lock'] });
  });

  it('poetry: runs `poetry install --no-interaction`', () => {
    const plan = planWorkspaceDeps(repoWith('poetry.lock'));
    expect(plan.setup).toBe('POETRY_VIRTUALENVS_IN_PROJECT=true poetry install --no-interaction');
    expect(plan.setupWhen).toEqual(['poetry.lock']);
  });

  it('requirements only: links .venv, has no setup', () => {
    const plan = planWorkspaceDeps(repoWith('requirements-dev.txt'));
    expect(plan).toMatchObject({ link: ['.venv'], setupWhen: [] });
    expect(plan.setup).toBeUndefined();
  });

  it('uv.lock wins over requirements.txt', () => {
    expect(planWorkspaceDeps(repoWith('uv.lock', 'requirements.txt')).ecosystems).toEqual(['python-uv']);
  });

  it.each([['go.mod'], ['Cargo.toml'], ['pom.xml'], ['build.gradle'], ['Gemfile']])(
    '%s: nothing (user-level caches)',
    (file) => {
      const plan = planWorkspaceDeps(repoWith(file));
      expect(plan.source).toBe('none');
      expect(planIsEmpty(plan)).toBe(true);
    },
  );

  it('an unknown or missing worktree gives an empty plan', () => {
    expect(planIsEmpty(planWorkspaceDeps(repoWith()))).toBe(true);
    expect(planIsEmpty(planWorkspaceDeps(join(tmpdir(), 'karst-no-such-dir-xyz')))).toBe(true);
  });

  it('an explicit block replaces the defaults, even an empty one', () => {
    const dir = repoWith('package.json');
    expect(planIsEmpty(planWorkspaceDeps(dir, {}))).toBe(true);
    const plan = planWorkspaceDeps(dir, { link: ['vendor/bundle'], setup: 'bundle install', setupWhen: ['Gemfile.lock'] });
    expect(plan).toMatchObject({
      source: 'manifest',
      node: false,
      link: ['vendor/bundle'],
      setup: 'bundle install',
      setupWhen: ['Gemfile.lock'],
    });
  });
});
