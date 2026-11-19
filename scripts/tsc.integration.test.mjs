import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const TSC = resolve('scripts/tsc.mjs');

/** A minimal strict project; `git: true` makes it a git work tree with an identity-free commit. */
function project({ git = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tsc-gate-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true },
      include: ['src'],
    }),
  );
  writeFileSync(join(dir, 'src/b.ts'), 'export const b: number = 1;\n');
  writeFileSync(join(dir, 'src/a.ts'), "import { b } from './b';\nexport const a: number = b;\n");
  if (git) spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

/** Run the gate in `dir`; the karst-injected full-run switch is scrubbed unless the caller sets it. */
function run(dir, extraEnv = {}, args = ['--noEmit']) {
  const env = { ...process.env, ...extraEnv };
  if (!('GITHUB_ACTIONS' in extraEnv)) delete env.GITHUB_ACTIONS;
  if (!('KARST_GATE_FULL' in extraEnv)) delete env.KARST_GATE_FULL;
  const r = spawnSync(process.execPath, [TSC, ...args], { cwd: dir, encoding: 'utf8', env });
  return { ...r, output: `${r.stdout}${r.stderr}`, status: r.status };
}

// git resolves the worktree's git directory through a real path: on macOS the
// temp dir is a symlink (/var -> /private/var), so ask git instead of assuming `.git`.
const gitDir = (dir) => spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
const buildInfo = (dir) => join(gitDir(dir), 'karst-gate-state', 'tsc.tsbuildinfo');
const status = (dir) => spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout;

describe('scripts/tsc.mjs', () => {
  it('resolves typescript without a local node_modules (worktree shape)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsc-wt-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'tsconfig.json'), '{"files":[]}');
    const r = spawnSync(process.execPath, [TSC, '--version'], { cwd: dir, encoding: 'utf8' });
    expect(r.stderr).not.toContain('MODULE_NOT_FOUND');
    expect(r.stdout).toMatch(/Version \d+/);
  });

  it('writes the build-info file under the git directory, not in the tree', () => {
    const dir = project();
    const r = run(dir);
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain(`typecheck: incremental (${buildInfo(dir)})`);
    expect(existsSync(buildInfo(dir))).toBe(true);
    expect(readdirSync(dir).some((name) => name.endsWith('.tsbuildinfo'))).toBe(false);
    expect(status(dir)).not.toContain('tsbuildinfo');
  });

  it('still fails on a type error that a changed file causes in another file', () => {
    const dir = project();
    expect(run(dir).status).toBe(0);
    writeFileSync(join(dir, 'src/b.ts'), "export const b: string = 'x';\n");
    const r = run(dir);
    expect(r.status).toBe(2);
    expect(r.output).toContain('error TS2322');
    expect(r.output).toContain('src/a.ts');
  });

  it('runs full in CI and writes no build-info file', () => {
    const dir = project();
    const r = run(dir, { GITHUB_ACTIONS: 'true' });
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('typecheck: full: GITHUB_ACTIONS=true');
    expect(existsSync(buildInfo(dir))).toBe(false);
  });

  it('runs full when KARST_GATE_FULL=1 is set', () => {
    const dir = project();
    const r = run(dir, { KARST_GATE_FULL: '1' });
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('typecheck: full: KARST_GATE_FULL=1');
    expect(existsSync(buildInfo(dir))).toBe(false);
  });

  it('runs plain and passes outside a git work tree', () => {
    const dir = project({ git: false });
    const r = run(dir);
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('typecheck: full: not in a git work tree');
    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(readdirSync(dir).some((name) => name.endsWith('.tsbuildinfo'))).toBe(false);
  });

  it('deletes a corrupt build-info file instead of failing a clean project', () => {
    const dir = project();
    expect(run(dir).status).toBe(0);
    writeFileSync(buildInfo(dir), '{"program":');
    const r = run(dir);
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('typecheck: full: build info unreadable');
    expect(existsSync(buildInfo(dir))).toBe(false);
  });
});
