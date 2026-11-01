import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const GATE = resolve('scripts/vitestGate.mjs');
const NODE_MODULES = resolve('node_modules');
const VITEST = ['npx', 'vitest', 'run', '--reporter=default'];

let repo;
const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
const gate = (cwd = repo, baseRef = 'develop') => {
  const env = { ...process.env, ...(baseRef ? { KARST_BASE_REF: baseRef } : {}) };
  if (!baseRef) delete env.KARST_BASE_REF;
  for (const k of ['AI_AGENT', 'CLAUDECODE', 'CI']) delete env[k];
  return spawnSync('node', [GATE, ...VITEST], { cwd, encoding: 'utf8', env });
};
const write = (name, body) => writeFileSync(join(repo, name), body);

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'karst-vgate-'));
  symlinkSync(NODE_MODULES, join(repo, 'node_modules'), 'dir');
  write('.gitignore', 'node_modules\n');
  write('red.test.mjs', "import {it,expect} from 'vitest';\nit('is red on develop', () => expect(1).toBe(2));\n");
  write('other.test.mjs', "import {it} from 'vitest';\nit('fine', () => {});\n");
  git('init', '-q', '-b', 'develop');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  git('checkout', '-qb', 'ticket');
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('vitestGate base drift', () => {
  it('passes with a NOTICE when the failing test is red on the base and untouched', () => {
    write('other.test.mjs', "import {it} from 'vitest';\nit('fine', () => {});\nit('more', () => {});\n");
    const run = gate();
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('NOTICE: develop is red:');
    expect(run.stderr).toContain('is red on develop');
    expect(run.stderr).toContain('KARST-ALERT: develop-red');
    // second run: cached verdict; the alert line repeats (the host dedupes per base sha)
    const again = gate();
    expect(again.status).toBe(0);
    expect(again.stderr).toContain('KARST-ALERT: develop-red');
    expect(again.stderr).not.toContain('re-running');
  }, 120_000);

  it('fails as today when the ticket touches the failing test file', () => {
    write('red.test.mjs', "import {it,expect} from 'vitest';\nit('is red on develop', () => expect(1).toBe(3));\n");
    const run = gate();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('never drift');
  }, 120_000);
});

describe('vitestGate in a sandbox clone (only the ticket branch)', () => {
  const cloneOf = (withBase) => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-vgate-clone-'));
    const sh = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    sh('clone', '-q', '--branch', 'ticket', '--single-branch', repo, '.');
    if (withBase) sh('fetch', '-q', repo, '+refs/heads/develop:refs/karst/base/develop');
    symlinkSync(NODE_MODULES, join(dir, 'node_modules'), 'dir');
    writeFileSync(join(dir, 'other.test.mjs'), "import {it} from 'vitest';\nit('fine', () => {});\nit('clone-only', () => {});\n");
    return dir;
  };

  it('resolves refs/karst/base/<base> and classifies a base-red test as drift', () => {
    const dir = cloneOf(true);
    const run = gate(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(run.stderr).not.toContain('base check skipped');
    expect(run.stderr).toContain('NOTICE: develop is red:');
    expect(run.status).toBe(0);
  }, 120_000);

  it('prints base check skipped: no merge base when the clone has no base ref', () => {
    const dir = cloneOf(false);
    const run = gate(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('base check skipped: no merge base for');
    expect(run.stderr).toContain('refs/karst/base/develop');
  }, 120_000);
});
