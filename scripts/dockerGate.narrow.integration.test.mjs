import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planRepeat, storeRun } from './dockerGate.mjs';

const GATE = resolve('scripts/dockerGate.mjs');
const GIT = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
const EXIT_NO_DOCKER = 127;
const IDS = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
let dir;
let bin;

const git = (...args) => spawnSync('git', [...IDS, ...args], { cwd: dir, encoding: 'utf8' });
const put = (name) => {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), 'x');
};
const runGate = (env) =>
  spawnSync(process.execPath, [GATE, 'run', '--rm', 'img'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: bin, npm_lifecycle_event: 'test:layout:docker', KARST_BASE_REF: 'develop', ...env },
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'karst-narrow-'));
  // The PATH holds git and a failing npx, and no docker: a gate that does not skip stops at
  // the missing-docker exit, and never waits on the host-wide Playwright slot.
  bin = mkdtempSync(join(tmpdir(), 'karst-narrow-bin-'));
  symlinkSync(join(GIT, 'git'), join(bin, 'git'));
  writeFileSync(join(bin, 'npx'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, 'npx'), 0o755);
  mkdirSync(join(dir, 'src/ui/settings'), { recursive: true });
  writeFileSync(join(dir, 'src/ui/settings/sections.ts'), "export const SETTINGS_SECTIONS = ['general'] as const;\n");
  spawnSync('git', ['init', '-q', '-b', 'develop'], { cwd: dir });
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'ticket');
  delete process.env.KARST_UI_GREP;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

describe('test:layout:docker with a moved file', () => {
  it('runs the full chain when a file moves out of a shared root into a view', () => {
    git('checkout', '-q', 'develop');
    put('src/ui/theme/tokens.ts');
    put('src/ui/diffs/a.tsx');
    git('add', '-A');
    git('commit', '-qm', 'shared file');
    git('checkout', '-qB', 'ticket');
    expect(git('mv', 'src/ui/theme/tokens.ts', 'src/ui/diffs/tokens.ts').status).toBe(0);
    git('commit', '-qm', 'move into a view');
    const run = runGate({});
    expect(run.status).toBe(EXIT_NO_DOCKER);
    expect(run.stderr).toContain('layout: running every view');
  });
});

describe('test:layout:docker with a selection that has no layout route', () => {
  it('prints a skip line and exits 0 without a run', () => {
    put('tests/visual/__baselines__/catalog/catalog.png');
    git('add', '-A');
    git('commit', '-qm', 'catalog baseline');
    const run = runGate({});
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('layout: skipped, catalog has no layout route');
  });

  it('does not skip when a selected view has a layout route', () => {
    put('src/ui/diffs/a.tsx');
    git('add', '-A');
    git('commit', '-qm', 'diffs change');
    const run = runGate({});
    expect(run.status).toBe(EXIT_NO_DOCKER);
    expect(run.stderr).toContain('layout: running diffs');
    expect(run.stderr).not.toContain('layout: skipped');
  });

  it('does not skip a seed or prune run', () => {
    put('tests/visual/__baselines__/catalog/catalog.png');
    git('add', '-A');
    git('commit', '-qm', 'catalog baseline');
    const run = runGate({ KARST_LAYOUT_PRUNE: '1' });
    expect(run.status).toBe(EXIT_NO_DOCKER);
    expect(run.stderr).not.toContain('layout: skipped');
  });
});

describe('test:layout:docker after a stored run', () => {
  const ARGV = ['run', '--rm', 'img'];
  let savedBase;
  const seed = async (status, report) => {
    savedBase = process.env.KARST_BASE_REF;
    process.env.KARST_BASE_REF = 'develop';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      storeRun((await planRepeat('test:layout:docker', ARGV, dir)).memo, status, report);
    } finally {
      spy.mockRestore();
      if (savedBase === undefined) delete process.env.KARST_BASE_REF;
      else process.env.KARST_BASE_REF = savedBase;
    }
  };

  it('runs only the views changed since the green run', async () => {
    put('src/ui/settings/b.tsx');
    git('add', '-A');
    git('commit', '-qm', 'settings change');
    await seed(0, null);
    put('src/ui/diffs/a.tsx');
    const run = runGate({});
    expect(run.status).toBe(EXIT_NO_DOCKER);
    expect(run.stderr).toMatch(/layout: running diffs \(changed since the green run at [0-9a-f]{12}\); full sweep runs in CI/);
    expect(run.stderr).not.toContain('settings');
  });

  it('runs every view when a shared path changed since the green run', async () => {
    put('src/ui/diffs/a.tsx');
    git('add', '-A');
    git('commit', '-qm', 'diffs change');
    await seed(0, null);
    put('src/ui/theme/tokens.ts');
    const run = runGate({});
    expect(run.status).toBe(EXIT_NO_DOCKER);
    expect(run.stderr).toContain('layout: running every view');
  });

  it('runs the failed tests of the red run with no UI change since', async () => {
    put('src/ui/diffs/a.tsx');
    git('add', '-A');
    git('commit', '-qm', 'diffs change');
    await seed(1, {
      errors: [],
      stats: { unexpected: 1 },
      suites: [{ specs: [{ title: 'diffs/empty @1280', tests: [{ projectName: 'layout', status: 'unexpected', results: [{ status: 'failed' }] }] }] }],
    });
    const run = runGate({});
    expect(run.status).toBe(EXIT_NO_DOCKER);
    expect(run.stderr).toMatch(/layout: running 1 failed test of the red run at [0-9a-f]{12}; full sweep runs in CI/);
    expect(run.stderr).not.toContain('layout: skipped');
  });

  it('uses the branch diff after a red run it cannot parse and no earlier state', async () => {
    put('src/ui/diffs/a.tsx');
    git('add', '-A');
    git('commit', '-qm', 'diffs change');
    await seed(1, null);
    const run = runGate({});
    expect(run.status).toBe(EXIT_NO_DOCKER);
    expect(run.stderr).toContain('full: no earlier green run');
    expect(run.stderr).toContain('layout: running diffs; full sweep runs in CI');
  });
});
