import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const GATE = resolve('scripts/dockerGate.mjs');
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
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, npm_lifecycle_event: 'test:layout:docker', KARST_BASE_REF: 'develop', ...env },
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'karst-narrow-'));
  // Stubs: a gate that does not skip reaches these and never starts a real listing or container.
  bin = mkdtempSync(join(tmpdir(), 'karst-narrow-bin-'));
  for (const tool of ['docker', 'npx']) {
    writeFileSync(join(bin, tool), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, tool), 0o755);
  }
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
    expect(run.stderr).toContain('layout: running diffs');
    expect(run.stderr).not.toContain('layout: skipped');
  });

  it('does not skip a seed or prune run', () => {
    put('tests/visual/__baselines__/catalog/catalog.png');
    git('add', '-A');
    git('commit', '-qm', 'catalog baseline');
    const run = runGate({ KARST_LAYOUT_PRUNE: '1' });
    expect(run.stderr).not.toContain('layout: skipped');
  });
});
