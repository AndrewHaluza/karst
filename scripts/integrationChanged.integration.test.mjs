import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { relatedArgs, scopeMessage, selectChangedSrc } from './integrationChanged.mjs';

const SCRIPT = resolve('scripts/integrationChanged.mjs');
const NODE_MODULES = (() => {
  for (let d = resolve('.'); ; d = dirname(d)) {
    if (existsSync(join(d, 'node_modules', 'vitest'))) return join(d, 'node_modules');
    if (dirname(d) === d) return resolve('node_modules');
  }
})();

describe('selectChangedSrc', () => {
  it('keeps code files under src, drops docs, scripts, non-code and missing files', () => {
    const changed = ['src/b.ts', 'src/a.tsx', 'docs/x.md', 'scripts/y.mjs', 'src/data.json', 'src/gone.ts'];
    expect(selectChangedSrc(changed, (p) => p !== 'src/gone.ts')).toEqual(['src/a.tsx', 'src/b.ts']);
  });

  it('returns no file when nothing under src changed', () => {
    expect(selectChangedSrc(['README.md', 'package.json'])).toEqual([]);
  });

  it('builds the related args with the integration config', () => {
    const args = relatedArgs(['src/a.ts']);
    expect(args.slice(0, 2)).toEqual(['vitest', 'related']);
    expect(args).toEqual(expect.arrayContaining(['--run', '--passWithNoTests', 'vitest.integration.config.ts', 'src/a.ts']));
    expect(scopeMessage([], 'abc')).toContain('no changed src file');
    expect(scopeMessage(['a'], 'abcdef')).toContain('1 changed src files since abcdef');
  });
});

describe('integrationChanged script', () => {
  let repo;
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  const commit = (msg) => {
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg);
  };
  const write = (name, body) => {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), body);
  };
  const run = () => {
    const env = { ...process.env, KARST_BASE_REF: 'develop' };
    for (const k of ['AI_AGENT', 'CLAUDECODE', 'CI', 'GITHUB_ACTIONS']) delete env[k];
    return spawnSync('node', [SCRIPT], { cwd: repo, encoding: 'utf8', env });
  };
  const stateFiles = () => {
    const dir = join(repo, '.git', 'karst-gate-state');
    return existsSync(dir) ? readdirSync(dir) : [];
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'karst-intchg-'));
    symlinkSync(NODE_MODULES, join(repo, 'node_modules'), 'dir');
    write('.gitignore', 'node_modules\n');
    write('vitest.integration.config.ts', "export default { test: { include: ['src/**/*.integration.test.ts'] } };\n");
    write('src/mod.ts', 'export const v = 1;\n');
    write('src/mod.integration.test.ts', "import { it, expect } from 'vitest';\nimport { v } from './mod';\nit('v is 1', () => expect(v).toBe(1));\n");
    git('init', '-q', '-b', 'develop');
    commit('base');
    git('checkout', '-qb', 'ticket');
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('prints one scope line and exits 0 with no changed src file', () => {
    write('docs/note.md', 'x\n');
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('no changed src file');
    rmSync(join(repo, 'docs'), { recursive: true });
  }, 60_000);

  it('runs the related test for an uncommitted change and exits 0 when it passes', () => {
    write('src/mod.ts', 'export const v = 1; // edited\n');
    const r = run();
    expect(r.stderr).toContain('1 changed src files');
    expect(r.status).toBe(0);
  }, 120_000);

  it('exits nonzero when a related test fails, and leaves the gate state alone', () => {
    write('src/mod.ts', 'export const v = 2;\n');
    const r = run();
    expect(r.status).not.toBe(0);
    expect(stateFiles()).toEqual([]);
  }, 120_000);

  it('selects a committed change against the merge base', () => {
    commit('break it');
    const r = run();
    expect(r.stderr).toContain('1 changed src files');
    expect(r.status).not.toBe(0);
  }, 120_000);
});
