import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const GATE = resolve('scripts/vitestGate.mjs');
// A host ticket worktree has no full node_modules: find the nearest ancestor one that holds vitest.
const NODE_MODULES = (() => {
  for (let d = resolve('.'); ; d = dirname(d)) {
    if (existsSync(join(d, 'node_modules', 'vitest'))) return join(d, 'node_modules');
    if (dirname(d) === d) return resolve('node_modules');
  }
})();
const VITEST = ['npx', 'vitest', 'run', '--reporter=default'];

let repo;
const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
const gate = (cwd = repo, baseRef = 'develop', extraEnv = {}) => {
  const env = { ...process.env, ...extraEnv, ...(baseRef ? { KARST_BASE_REF: baseRef } : {}) };
  if (!baseRef) delete env.KARST_BASE_REF;
  for (const k of ['AI_AGENT', 'CLAUDECODE', 'CI', 'GITHUB_ACTIONS']) delete env[k];
  Object.assign(env, extraEnv);
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

  it('does not excuse a base-red failure on GitHub Actions', () => {
    write('other.test.mjs', "import {it} from 'vitest';\nit('fine', () => {});\nit('more gha', () => {});\n");
    const run = gate(repo, 'develop', { GITHUB_ACTIONS: 'true' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('base check skipped: GitHub Actions never excuses');
    expect(run.stderr).not.toContain('NOTICE: develop is red');
  }, 120_000);

  it('fails on GitHub Actions when a failure has no parseable test id', () => {
    write('crash.test.mjs', "import {it} from 'vitest';\nthrow new Error('file-level crash');\nit('x', () => {});\n");
    try {
      const run = gate(repo, 'develop', { GITHUB_ACTIONS: 'true' });
      expect(run.status).not.toBe(0);
    } finally {
      rmSync(join(repo, 'crash.test.mjs'), { force: true });
    }
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

describe('vitestGate flake re-run', () => {
  const flakyRepo = (body) => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-vgate-flake-'));
    const sh = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    symlinkSync(NODE_MODULES, join(dir, 'node_modules'), 'dir');
    writeFileSync(join(dir, '.gitignore'), 'node_modules\nmarker\n');
    writeFileSync(join(dir, 'flaky.test.mjs'), body);
    sh('init', '-q', '-b', 'develop');
    sh('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
    sh('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
    sh('checkout', '-qb', 'ticket');
    return dir;
  };
  // fails on its first run (writes a marker), passes on every later run
  const FLAKY = "import {it,expect} from 'vitest';\nimport {existsSync,writeFileSync} from 'node:fs';\nit('flips', () => { const seen = existsSync('marker'); writeFileSync('marker', '1'); expect(seen).toBe(true); });\n";

  it('passes with a flaky NOTICE when the failing file passes alone', () => {
    const dir = flakyRepo(FLAKY);
    const run = gate(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(run.stderr).toContain('NOTICE: flaky:');
    expect(run.stderr).toContain('(passed when re-run alone)');
    expect(run.status).toBe(0);
  }, 120_000);

  it('fails when the file fails again alone', () => {
    const dir = flakyRepo("import {it,expect} from 'vitest';\nit('always red', () => expect(1).toBe(2));\n");
    // touched by the ticket, so the base check cannot call it drift
    writeFileSync(join(dir, 'flaky.test.mjs'), "import {it,expect} from 'vitest';\nit('always red', () => expect(1).toBe(3));\n");
    const run = gate(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(run.stderr).not.toContain('NOTICE: flaky:');
    expect(run.status).not.toBe(0);
  }, 120_000);
});

describe('vitestGate CI mode', () => {
  it('fails a missing snapshot, names the test, and writes no snapshot file', () => {
    write('snap.test.mjs', "import {it,expect} from 'vitest';\nit('has no snapshot yet', () => expect('a').toMatchSnapshot());\n");
    const run = gate(repo, null);
    expect(run.status).not.toBe(0);
    expect(run.stdout + run.stderr).toContain('has no snapshot yet');
    expect(spawnSync('git', ['status', '--porcelain', '--', '__snapshots__'], { cwd: repo, encoding: 'utf8' }).stdout).toBe('');
    expect(existsSync(join(repo, '__snapshots__'))).toBe(false);
    rmSync(join(repo, 'snap.test.mjs'));
  });
});

// An npx copy must not rescue the base run: an empty npm cache and no network leave only the repository's vitest.
const OFFLINE_NPX = { npm_config_offline: 'true', npm_config_cache: join(tmpdir(), 'karst-vgate-empty-npm-cache') };

describe('vitestGate in a host-style worktree (partial node_modules, full node_modules in an ancestor)', () => {
  let root;
  let wt;
  const sh = (...a) => spawnSync('git', a, { cwd: wt, encoding: 'utf8' });
  const commit = (m) => {
    sh('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
    sh('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', m);
  };
  const hostRepo = (files) => {
    root = mkdtempSync(join(tmpdir(), 'karst-vgate-host-'));
    symlinkSync(NODE_MODULES, join(root, 'node_modules'), 'dir');
    wt = join(root, 'wt');
    mkdirSync(join(wt, 'node_modules', '.vite'), { recursive: true });
    writeFileSync(join(wt, '.gitignore'), 'node_modules\n');
    for (const [name, body] of Object.entries(files)) writeFileSync(join(wt, name), body);
    sh('init', '-q', '-b', 'develop');
    commit('base');
    sh('checkout', '-qb', 'ticket');
  };
  const baseCheckLeftovers = () => {
    const dir = join(root, '.karst', 'base-check');
    return existsSync(dir) ? readdirSync(dir) : [];
  };
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reaches a verdict: NOTICE develop is red, exit 0, base worktree removed', () => {
    hostRepo({
      'red.test.mjs': "import {it,expect} from 'vitest';\nit('is red on develop', () => expect(1).toBe(2));\n",
      'other.test.mjs': "import {it} from 'vitest';\nit('fine', () => {});\n",
    });
    writeFileSync(join(wt, 'other.test.mjs'), "import {it} from 'vitest';\nit('fine', () => {});\nit('more', () => {});\n");
    const run = gate(wt, 'develop', OFFLINE_NPX);
    expect(run.stderr).not.toContain('inconclusive');
    expect(run.stderr).toContain('NOTICE: develop is red:');
    expect(run.status).toBe(0);
    expect(baseCheckLeftovers()).toEqual([]);
    expect(sh('worktree', 'list').stdout.trim().split('\n')).toHaveLength(1);
  }, 120_000);

  it('still fails a test that passes at the base', () => {
    hostRepo({
      'v.mjs': 'export const v = 1;\n',
      'red.test.mjs': "import {it,expect} from 'vitest';\nimport {v} from './v.mjs';\nit('breaks on the ticket', () => expect(v).toBe(1));\n",
    });
    writeFileSync(join(wt, 'v.mjs'), 'export const v = 2;\n');
    const run = gate(wt, 'develop', OFFLINE_NPX);
    expect(run.stderr).not.toContain('NOTICE: develop is red');
    expect(run.status).not.toBe(0);
    expect(baseCheckLeftovers()).toEqual([]);
  }, 120_000);

  it('reaches the flake re-run when a failure message holds a prefixed nested FAIL line', () => {
    hostRepo({
      'flaky.test.mjs':
        "import {it,expect} from 'vitest';\nimport {existsSync,writeFileSync} from 'node:fs';\n" +
        "it('flips', () => { const seen = existsSync('marker'); writeFileSync('marker', '1'); expect(seen, 'nested output:\\n' + ['FAIL  x.test.ts > inner'].map((l) => '| ' + l).join('\\n')).toBe(true); });\n",
    });
    writeFileSync(join(wt, '.gitignore'), 'node_modules\nmarker\n');
    const run = gate(wt, 'develop', OFFLINE_NPX);
    expect(run.stderr).toContain('NOTICE: flaky:');
    expect(run.status).toBe(0);
  }, 120_000);
});
