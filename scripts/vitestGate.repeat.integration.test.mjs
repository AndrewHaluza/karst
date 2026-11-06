import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const GATE = resolve('scripts/vitestGate.mjs');
const NODE_MODULES = (() => {
  for (let d = resolve('.'); ; d = dirname(d)) {
    if (existsSync(join(d, 'node_modules', 'vitest'))) return join(d, 'node_modules');
    if (dirname(d) === d) return resolve('node_modules');
  }
})();
const VITEST = ['npx', 'vitest', 'run', '--reporter=default'];
const IDS = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const PASS = "import {it} from 'vitest';\nit('ok', () => {});\n";

let dir;
const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
const put = (name, body) => {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), body);
};
const gate = (env = {}) => {
  const e = { ...process.env, KARST_BASE_REF: 'develop', ...env };
  for (const k of ['AI_AGENT', 'CLAUDECODE', 'CI']) delete e[k];
  return spawnSync('node', [GATE, ...VITEST], { cwd: dir, encoding: 'utf8', env: e });
};
const out = (r) => r.stdout + r.stderr;
const commit = (msg) => {
  git(...IDS, 'add', '-A');
  git(...IDS, 'commit', '-qm', msg);
};

/** A repo with two related source/test pairs and an independent test; the first pass has run. */
function setup() {
  dir = mkdtempSync(join(tmpdir(), 'karst-vrepeat-'));
  symlinkSync(NODE_MODULES, join(dir, 'node_modules'), 'dir');
  put('.gitignore', 'node_modules\n');
  put('package.json', '{"type":"module"}\n');
  put('src/a.ts', 'export const a = 1;\n');
  put('src/a.test.ts', "import {it,expect} from 'vitest';\nimport {a} from './a';\nit('a', () => expect(a).toBe(1));\n");
  put('src/b.ts', 'export const b = 1;\n');
  put('src/b.test.ts', "import {it,expect} from 'vitest';\nimport {b} from './b';\nit('b', () => expect(b).toBe(1));\n");
  put('src/c.test.ts', PASS);
  put('docs/x.md', 'x\n');
  git('init', '-q', '-b', 'develop');
  commit('base');
  git('checkout', '-qb', 'ticket');
  put('src/note.txt', 'n'); // a ticket change that is not under test
  const first = gate();
  return first;
}

afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe('vitestGate repeat pass', () => {
  it('runs the first pass in full and a second pass only on the files related to a one-file change', () => {
    const first = setup();
    expect(first.status).toBe(0);
    expect(out(first)).toContain('full: no earlier run');
    for (const f of ['a.test.ts', 'b.test.ts', 'c.test.ts']) expect(out(first)).toContain(f);
    put('src/a.ts', 'export const a = 1; // touched\n');
    const second = gate();
    expect(second.status).toBe(0);
    expect(out(second)).toMatch(/: 1 files, delta since [0-9a-f]{12}/);
    expect(out(second)).toContain('a.test.ts');
    expect(out(second)).not.toContain('b.test.ts');
    expect(out(second)).not.toContain('c.test.ts');
  }, 180_000);

  it('fails the gate on a test that the delta breaks', () => {
    setup();
    put('src/a.ts', 'export const a = 2;\n');
    const second = gate();
    expect(second.status).not.toBe(0);
    expect(out(second)).toContain('a.test.ts');
  }, 180_000);

  it('re-runs a test that failed earlier and is not related to the delta', () => {
    setup();
    put('src/c.test.ts', "import {it,expect} from 'vitest';\nit('c red', () => expect(1).toBe(2));\n");
    expect(gate().status).not.toBe(0);
    put('src/b.ts', 'export const b = 1; // touched\n');
    const third = gate();
    expect(out(third)).toMatch(/: 2 files, delta since/);
    expect(out(third)).toContain('c.test.ts');
    expect(out(third)).toContain('b.test.ts');
    expect(out(third)).not.toContain('a.test.ts');
    expect(third.status).not.toBe(0);
  }, 180_000);

  it('keeps a file excused as base drift counted as failed for the next pass', () => {
    setup();
    // red on develop too: the base check excuses it, the pass exits 0
    git('checkout', '-q', 'develop');
    put('src/red.test.ts', "import {it,expect} from 'vitest';\nit('red at base', () => expect(1).toBe(2));\n");
    commit('red at base');
    git('checkout', '-q', 'ticket');
    expect(git(...IDS, 'rebase', 'develop').status).toBe(0);
    const pass = gate();
    expect(pass.status).toBe(0);
    expect(out(pass)).toContain('NOTICE: develop is red');
    put('src/b.ts', 'export const b = 1; // touched\n');
    const next = gate();
    expect(out(next)).toContain('red.test.ts');
  }, 240_000);

  it('makes a docs-only delta select no tests and exit 0', () => {
    setup();
    put('docs/x.md', 'changed\n');
    const second = gate();
    expect(second.status).toBe(0);
    expect(out(second)).toMatch(/: 0 files, delta since/);
    expect(out(second)).not.toContain('Test Files');
  }, 180_000);

  it.each([
    ['KARST_GATE_FULL=1', () => {}, { KARST_GATE_FULL: '1' }, 'KARST_GATE_FULL=1'],
    ['a deleted file', () => rmSync(join(dir, 'src/c.test.ts')), {}, 'deleted or renamed'],
    ['a renamed file', () => renameSync(join(dir, 'src/c.test.ts'), join(dir, 'src/d.test.ts')), {}, 'deleted or renamed'],
    ['package.json', () => put('package.json', '{"type":"module","x":1}\n'), {}, 'package.json changed'],
    ['a tsconfig', () => put('tsconfig.json', '{}\n'), {}, 'tsconfig.json changed'],
    ['a vitest config', () => put('vitest.config.ts', 'export default {};\n'), {}, 'vitest.config.ts changed'],
    ['a vitest setup script', () => put('scripts/vitest-setup.mjs', 'x\n'), {}, 'scripts/vitest-setup.mjs changed'],
    ['a path outside src and docs', () => put('tools/x.sh', 'x\n'), {}, 'outside src and docs'],
    ['a non-code file under src', () => put('src/data.json', '{}\n'), {}, 'non-code file under src'],
  ])('runs the full suite for %s', (_name, change, env, reason) => {
    setup();
    change();
    const second = gate(env);
    expect(out(second)).toContain('full: ');
    expect(out(second)).toContain(reason);
    expect(out(second)).toContain('Test Files');
  }, 180_000);

  it('runs the full suite when the state is missing, unreadable, or its snapshot is gone, or the earlier run was not clean', () => {
    setup();
    const state = join(dir, '.git', 'karst-gate-state');
    const file = join(state, readdirSync(state)[0]);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, '{broken');
    expect(out(gate())).toContain('full: no earlier run');
    writeFileSync(file, JSON.stringify({ ...saved, tree: 'd'.repeat(40) }));
    expect(out(gate())).toContain('full: earlier run state is unreadable');
    writeFileSync(file, JSON.stringify({ ...saved, clean: false }));
    expect(out(gate())).toContain('full: earlier run was killed, hung');
    rmSync(state, { recursive: true, force: true });
    expect(out(gate())).toContain('full: no earlier run');
  }, 240_000);

  it('runs the full suite after a rebase onto a new base', () => {
    setup();
    git('checkout', '-q', 'develop');
    put('src/new.ts', 'export {};\n');
    commit('develop moves');
    git('checkout', '-q', 'ticket');
    expect(git(...IDS, 'rebase', 'develop').status).toBe(0);
    const second = gate();
    expect(out(second)).toContain('full: the merge base moved');
    expect(out(second)).toContain('Test Files');
  }, 180_000);

  it('runs the full suite when the earlier run was killed by the idle limit', () => {
    setup();
    put('src/hang.test.ts', "import {it} from 'vitest';\nit('hangs', async () => { await new Promise(() => {}); }, 600000);\n");
    const hung = gate({ KARST_GATE_IDLE_MS: '4000' });
    expect(hung.status).not.toBe(0);
    expect(out(hung)).toContain('gate hang');
    rmSync(join(dir, 'src/hang.test.ts'));
    const next = gate();
    expect(out(next)).toContain('full: earlier run was killed, hung');
  }, 240_000);

  it('leaves the real index and the working tree as they were', () => {
    setup();
    put('src/a.ts', 'export const a = 1; // touched\n');
    git('add', 'src/a.ts');
    put('src/b.ts', 'export const b = 1; // unstaged\n');
    const sha = () => createHash('sha1').update(readFileSync(join(dir, '.git', 'index'))).digest('hex');
    const before = { index: sha(), status: git('status', '--porcelain').stdout, a: readFileSync(join(dir, 'src/a.ts'), 'utf8') };
    const run = gate();
    expect(out(run)).toContain('delta since');
    expect({ index: sha(), status: git('status', '--porcelain').stdout, a: readFileSync(join(dir, 'src/a.ts'), 'utf8') }).toEqual(before);
    expect(readdirSync(join(dir, '.git')).filter((f) => f.startsWith('karst-gate-index'))).toEqual([]);
  }, 180_000);
});

describe('vitestGate repeat pass in a sandbox clone and a host worktree', () => {
  it('works in a linked worktree, where the git directory is not .git', () => {
    setup();
    const wt = mkdtempSync(join(tmpdir(), 'karst-vrepeat-wt-'));
    rmSync(wt, { recursive: true, force: true });
    expect(git('worktree', 'add', '-q', '-b', 'wt', wt, 'ticket').status).toBe(0);
    symlinkSync(NODE_MODULES, join(wt, 'node_modules'), 'dir');
    const run = (cwd) => {
      const e = { ...process.env, KARST_BASE_REF: 'develop' };
      for (const k of ['AI_AGENT', 'CLAUDECODE', 'CI']) delete e[k];
      return spawnSync('node', [GATE, ...VITEST], { cwd, encoding: 'utf8', env: e });
    };
    const first = run(wt);
    expect(out(first)).toContain('full: no earlier run');
    writeFileSync(join(wt, 'src/a.ts'), 'export const a = 1; // wt\n');
    const second = run(wt);
    git('worktree', 'remove', '--force', wt);
    expect(out(second)).toMatch(/: 1 files, delta since/);
  }, 240_000);

  it('works in a single-branch clone that has only the base ref', () => {
    setup();
    const clone = mkdtempSync(join(tmpdir(), 'karst-vrepeat-clone-'));
    const sh = (...a) => spawnSync('git', a, { cwd: clone, encoding: 'utf8' });
    sh('clone', '-q', '--branch', 'ticket', '--single-branch', dir, '.');
    sh('fetch', '-q', dir, '+refs/heads/develop:refs/karst/base/develop');
    symlinkSync(NODE_MODULES, join(clone, 'node_modules'), 'dir');
    const run = () => {
      const e = { ...process.env, KARST_BASE_REF: 'develop' };
      for (const k of ['AI_AGENT', 'CLAUDECODE', 'CI']) delete e[k];
      return spawnSync('node', [GATE, ...VITEST], { cwd: clone, encoding: 'utf8', env: e });
    };
    const first = run();
    writeFileSync(join(clone, 'src/a.ts'), 'export const a = 1; // clone\n');
    const second = run();
    rmSync(clone, { recursive: true, force: true });
    expect(out(first)).toContain('full: no earlier run');
    expect(out(second)).toMatch(/: 1 files, delta since/);
  }, 240_000);
});
