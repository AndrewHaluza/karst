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
const gate = () => {
  const env = { ...process.env, KARST_BASE_REF: 'develop' };
  for (const k of ['AI_AGENT', 'CLAUDECODE', 'CI']) delete env[k];
  return spawnSync('node', [GATE, ...VITEST], { cwd: repo, encoding: 'utf8', env });
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
    // second run: cached verdict, alert deduped per base sha
    const again = gate();
    expect(again.status).toBe(0);
    expect(again.stderr).not.toContain('KARST-ALERT');
    expect(again.stderr).not.toContain('re-running');
  }, 120_000);

  it('fails as today when the ticket touches the failing test file', () => {
    write('red.test.mjs', "import {it,expect} from 'vitest';\nit('is red on develop', () => expect(1).toBe(3));\n");
    const run = gate();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('never drift');
  }, 120_000);
});
