import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manifest } from '../../../manifest/types.js';
import type { GateProcessRunner, ProcessOutcome } from '../../../workflow/gates/run.js';
import {
  SETUP_OUTPUT_TAIL_CHARS,
  createDepsProvisioner,
  WORKSPACE_SETUP_TIMEOUT_MS,
  mainCheckoutOf,
  provisionWorkspaceDeps,
  runWorkspaceSetup,
  type RunSetup,
} from './workspaceDeps.js';

let root: string;
let main: string;
let worktree: string;
let clone: string;

function put(path: string, text = ''): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function pkg(dir: string, name: string, version = '1.0.0'): void {
  put(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
}
const setupOk: RunSetup = async () => ({ ok: true });

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'karst-wsdeps-')));
  main = join(root, 'main');
  worktree = join(main, '.karst', 'worktrees', 'wt');
  clone = join(root, 'clone');
  for (const dir of [main, worktree, clone]) mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (explicit?: { link?: string[]; setup?: string; setupWhen?: string[] }, runSetup: RunSetup = setupOk) =>
  provisionWorkspaceDeps(
    { repoName: 'app', clone, worktree, mainCheckout: main, explicit },
    { runSetup },
  );

function nodeRepo(dir: string, deps: Record<string, string>, locked: Record<string, string>): void {
  put(join(dir, 'package.json'), JSON.stringify({ dependencies: deps }));
  put(
    join(dir, 'package-lock.json'),
    JSON.stringify({ packages: Object.fromEntries(Object.entries(locked).map(([n, v]) => [`node_modules/${n}`, { version: v }])) }),
  );
}

describe('Node merge', () => {
  it('merges the worktree entries, then the main checkout entries; the local entry wins', async () => {
    nodeRepo(worktree, { a: '1', b: '1' }, { a: '1.0.0', b: '1.0.0' });
    nodeRepo(clone, { a: '1', b: '1' }, { a: '1.0.0', b: '1.0.0' });
    pkg(worktree, 'a', '1.0.0');
    pkg(main, 'a', '9.9.9');
    pkg(main, 'b', '1.0.0');
    pkg(main, '@scope/x');
    put(join(main, 'node_modules', '.bin', 'tsc'), '#!/bin/sh');
    put(join(worktree, 'node_modules', '.vite', 'deps', 'x'), 'cache');
    put(join(worktree, 'node_modules', '.cache', 'y'), 'cache');

    const result = await run();

    expect(result).toEqual({ kind: 'ready', created: ['node_modules'] });
    const nm = join(clone, 'node_modules');
    expect(lstatSync(nm).isSymbolicLink()).toBe(false);
    expect(realpathSync(join(nm, 'a'))).toBe(join(worktree, 'node_modules', 'a'));
    expect(realpathSync(join(nm, 'b'))).toBe(join(main, 'node_modules', 'b'));
    expect(existsSync(join(nm, '@scope', 'x', 'package.json'))).toBe(true);
    expect(realpathSync(join(nm, '.bin', 'tsc'))).toBe(join(main, 'node_modules', '.bin', 'tsc'));
    expect(readdirSync(nm).filter((n) => n.startsWith('.')).sort()).toEqual(['.bin']);
    expect(readFileSync(join(clone, '.git', 'info', 'exclude'), 'utf8')).toContain('/node_modules');
  });

  it('merges a scope across trees', async () => {
    nodeRepo(worktree, {}, {});
    nodeRepo(clone, {}, {});
    pkg(worktree, '@s/one');
    pkg(main, '@s/two');
    await run();
    expect(readdirSync(join(clone, 'node_modules', '@s')).sort()).toEqual(['one', 'two']);
  });

  it('fails with the lockfile reason when the resolved tree does not match, and removes the merge', async () => {
    nodeRepo(worktree, { a: '1' }, { a: '2.0.0' });
    nodeRepo(clone, { a: '1' }, { a: '2.0.0' });
    pkg(main, 'a', '1.0.0');
    const result = await run();
    expect(result.kind).toBe('failed');
    expect(result.kind === 'failed' && result.reason).toMatch(/app: .*package-lock\.json.*invalid: a@1\.0\.0/);
    expect(existsSync(join(clone, 'node_modules'))).toBe(false);
  });

  it('a package.json with no dependencies needs no node_modules', async () => {
    put(join(worktree, 'package.json'), '{"name":"x"}');
    expect(await run()).toEqual({ kind: 'ready', created: [] });
    expect(existsSync(join(clone, 'node_modules'))).toBe(false);
  });

  it('fails when no node_modules resolves anywhere', async () => {
    nodeRepo(worktree, { a: '1' }, { a: '1.0.0' });
    const result = await run();
    expect(result.kind === 'failed' && result.reason).toContain('no node_modules resolves');
  });

  it('fails on a workspace link into the main checkout, and never writes there', async () => {
    nodeRepo(worktree, {}, {});
    nodeRepo(clone, {}, {});
    put(join(main, 'packages', 'ws', 'package.json'), '{}');
    mkdirSync(join(main, 'node_modules'), { recursive: true });
    symlinkSync(join(main, 'packages', 'ws'), join(main, 'node_modules', 'ws'));
    const result = await run();
    expect(result.kind === 'failed' && result.reason).toContain('workspace link into another tree');
    expect(existsSync(join(clone, 'node_modules'))).toBe(false);
  });

  it('accepts a link that stays inside its own node_modules (pnpm store)', async () => {
    nodeRepo(worktree, {}, {});
    nodeRepo(clone, {}, {});
    put(join(main, 'node_modules', '.pnpm', 'p@1', 'node_modules', 'p', 'package.json'), '{}');
    symlinkSync(join(main, 'node_modules', '.pnpm', 'p@1', 'node_modules', 'p'), join(main, 'node_modules', 'p'));
    expect(await run()).toEqual({ kind: 'ready', created: ['node_modules'] });
  });

  it('removing the clone keeps every link target', async () => {
    nodeRepo(worktree, {}, {});
    nodeRepo(clone, {}, {});
    pkg(main, 'a');
    await run();
    rmSync(clone, { recursive: true, force: true });
    expect(existsSync(join(main, 'node_modules', 'a', 'package.json'))).toBe(true);
  });
});

describe('Python', () => {
  function venv(dir: string, pth?: string): void {
    put(join(dir, '.venv', 'bin', 'python'), '');
    if (pth !== undefined) put(join(dir, '.venv', 'lib', 'python3.12', 'site-packages', '__editable__.app.pth'), pth);
  }

  it('uv: links the worktree .venv when uv.lock is equal, with no setup run', async () => {
    put(join(worktree, 'uv.lock'), 'a');
    put(join(clone, 'uv.lock'), 'a');
    venv(worktree);
    const runSetup = vi.fn(setupOk);
    expect(await run(undefined, runSetup)).toEqual({ kind: 'ready', created: ['.venv'] });
    expect(runSetup).not.toHaveBeenCalled();
    expect(realpathSync(join(clone, '.venv'))).toBe(join(worktree, '.venv'));
    expect(readFileSync(join(clone, '.git', 'info', 'exclude'), 'utf8')).toContain('/.venv');
  });

  it('uv: runs `uv sync --frozen` in the clone when uv.lock changed', async () => {
    put(join(worktree, 'uv.lock'), 'a');
    put(join(clone, 'uv.lock'), 'b');
    venv(worktree);
    const runSetup = vi.fn(setupOk);
    expect((await run(undefined, runSetup)).kind).toBe('ready');
    expect(runSetup).toHaveBeenCalledWith('uv sync --frozen', clone);
    expect(existsSync(join(clone, '.venv'))).toBe(false);
  });

  it('uv: runs setup when the worktree has no .venv', async () => {
    put(join(worktree, 'uv.lock'), 'a');
    put(join(clone, 'uv.lock'), 'a');
    const runSetup = vi.fn(setupOk);
    await run(undefined, runSetup);
    expect(runSetup).toHaveBeenCalledWith('uv sync --frozen', clone);
  });

  it('poetry: runs its setup in the clone', async () => {
    put(join(worktree, 'poetry.lock'), 'a');
    put(join(clone, 'poetry.lock'), 'a');
    const runSetup = vi.fn(setupOk);
    await run(undefined, runSetup);
    expect(runSetup).toHaveBeenCalledWith('POETRY_VIRTUALENVS_IN_PROJECT=true poetry install --no-interaction', clone);
  });

  it('editable install into the worktree: not linked; setup runs instead', async () => {
    put(join(worktree, 'uv.lock'), 'a');
    put(join(clone, 'uv.lock'), 'a');
    venv(worktree, `${join(worktree, 'src')}\n`);
    mkdirSync(join(worktree, 'src'), { recursive: true });
    const runSetup = vi.fn(setupOk);
    await run(undefined, runSetup);
    expect(runSetup).toHaveBeenCalledOnce();
    expect(existsSync(join(clone, '.venv'))).toBe(false);
  });

  it('editable install into the main checkout, requirements only: parks, no setup', async () => {
    put(join(worktree, 'requirements.txt'), 'x');
    venv(worktree, `import x; x = "${join(main, 'src')}"\n`);
    mkdirSync(join(main, 'src'), { recursive: true });
    const result = await run();
    expect(result.kind === 'failed' && result.reason).toContain('editable or workspace link');
    expect(existsSync(join(clone, '.venv'))).toBe(false);
  });

  it('a .pth path outside both trees is fine', async () => {
    put(join(worktree, 'requirements.txt'), 'x');
    venv(worktree, `${join(root, 'elsewhere')}\n`);
    expect(await run()).toEqual({ kind: 'ready', created: ['.venv'] });
  });

  it('requirements only: links .venv when the worktree has one; nothing when it has none', async () => {
    put(join(worktree, 'requirements.txt'), 'x');
    expect(await run()).toEqual({ kind: 'ready', created: [] });
    venv(worktree);
    expect(await run()).toEqual({ kind: 'ready', created: ['.venv'] });
  });
});

describe('review findings', () => {
  it('an editable scan that reaches its cap fails closed', async () => {
    put(join(worktree, 'requirements.txt'), 'x');
    put(join(worktree, '.venv', 'bin', 'python'), '');
    for (let i = 0; i < 3; i++) put(join(worktree, '.venv', 'lib', `f${i}`), '');
    const { editableHit } = await import('./workspaceDeps.js');
    expect(editableHit(join(worktree, '.venv'), [worktree], 2)).toContain('scan limit');
    expect(editableHit(join(worktree, '.venv'), [worktree])).toBeUndefined();
  });

  it('a Python setup keeps the merged node_modules of a Node + Python repo', async () => {
    nodeRepo(worktree, { a: '1' }, { a: '1.0.0' });
    nodeRepo(clone, { a: '1' }, { a: '1.0.0' });
    pkg(worktree, 'a', '1.0.0');
    put(join(worktree, 'uv.lock'), 'a');
    put(join(clone, 'uv.lock'), 'b');
    const runSetup = vi.fn(setupOk);
    expect(await run(undefined, runSetup)).toEqual({ kind: 'ready', created: ['node_modules'] });
    expect(runSetup).toHaveBeenCalledOnce();
    expect(existsSync(join(clone, 'node_modules', 'a', 'package.json'))).toBe(true);
  });

  it('a Node problem is final even when a Python setup exists', async () => {
    nodeRepo(worktree, { a: '1' }, { a: '2.0.0' });
    nodeRepo(clone, { a: '1' }, { a: '2.0.0' });
    pkg(worktree, 'a', '1.0.0');
    put(join(worktree, 'uv.lock'), 'a');
    put(join(clone, 'uv.lock'), 'b');
    const runSetup = vi.fn(setupOk);
    const result = await run(undefined, runSetup);
    expect(result.kind).toBe('failed');
    expect(runSetup).not.toHaveBeenCalled();
  });
});

describe('other ecosystems and the explicit block', () => {
  it.each([['go.mod'], ['Cargo.toml'], ['pom.xml'], ['Gemfile']])('%s: nothing is created and nothing runs', async (file) => {
    put(join(worktree, file), '');
    const runSetup = vi.fn(setupOk);
    expect(await run(undefined, runSetup)).toEqual({ kind: 'ready', created: [] });
    expect(runSetup).not.toHaveBeenCalled();
    expect(readdirSync(clone)).toEqual([]);
  });

  it('an explicit setup only runs always; an explicit empty block turns Node off', async () => {
    nodeRepo(worktree, { a: '1' }, { a: '1.0.0' });
    const runSetup = vi.fn(setupOk);
    expect(await run({}, runSetup)).toEqual({ kind: 'ready', created: [] });
    expect(runSetup).not.toHaveBeenCalled();
    await run({ setup: 'make deps' }, runSetup);
    expect(runSetup).toHaveBeenCalledWith('make deps', clone);
  });

  it('an explicit link with a missing source and no setup fails', async () => {
    const result = await run({ link: ['vendor/bundle'] });
    expect(result.kind === 'failed' && result.reason).toContain('vendor/bundle is missing');
  });

  it('an explicit link compares setupWhen files beside the link target', async () => {
    put(join(worktree, 'vendor', 'bundle', 'gem'), '');
    put(join(worktree, 'Gemfile.lock'), 'a');
    put(join(clone, 'Gemfile.lock'), 'a');
    const explicit = { link: ['vendor/bundle'], setup: 'bundle install', setupWhen: ['Gemfile.lock'] };
    expect(await run(explicit)).toEqual({ kind: 'ready', created: ['vendor/bundle'] });
    rmSync(join(clone, 'vendor'), { recursive: true });
    put(join(clone, 'Gemfile.lock'), 'b');
    const runSetup = vi.fn(setupOk);
    await run(explicit, runSetup);
    expect(runSetup).toHaveBeenCalledWith('bundle install', clone);
  });

  it('a failed setup returns the repository, the command and the detail', async () => {
    const result = await run({ setup: 'make deps' }, async () => ({ ok: false, detail: 'exit 2: boom' }));
    expect(result).toEqual({ kind: 'failed', reason: 'app: setup "make deps" failed — exit 2: boom' });
  });

  it('removes the links before setup runs, so setup cannot write through one', async () => {
    put(join(worktree, 'uv.lock'), 'a');
    put(join(clone, 'uv.lock'), 'a');
    put(join(worktree, '.venv', 'bin', 'python'), '');
    put(join(worktree, '.venv', 'lib', 'python3.12', 'site-packages', 'x.pth'), `${join(worktree, 'src')}\n`);
    mkdirSync(join(worktree, 'src'));
    let seen = true;
    await run(undefined, async (_c, cwd) => {
      seen = existsSync(join(cwd, '.venv'));
      return { ok: true };
    });
    expect(seen).toBe(false);
  });
});

describe('runWorkspaceSetup', () => {
  const runner = (outcome: ProcessOutcome) =>
    vi.fn(async (..._args: Parameters<GateProcessRunner>) => outcome);

  it('runs the command in a shell with the timeout constant, and reads exit 0 as ok', async () => {
    const fn = runner({ kind: 'completed', exitCode: 0, output: '' });
    expect(await runWorkspaceSetup(fn)('npm ci', '/c')).toEqual({ ok: true });
    expect(fn.mock.calls[0]![2]).toBe('/c');
    expect(fn.mock.calls[0]![1]).toContain('npm ci');
    expect(fn.mock.calls[0]![3]).toMatchObject({ timeoutMs: WORKSPACE_SETUP_TIMEOUT_MS });
  });

  it('keeps the exit code and the output tail on a nonzero exit', async () => {
    const output = `${'x'.repeat(2000)}\nlast line`;
    const out = await runWorkspaceSetup(runner({ kind: 'completed', exitCode: 3, output }))('c', '/c');
    expect(out.ok).toBe(false);
    const detail = out.ok ? '' : out.detail;
    expect(detail).toMatch(/^exit 3: …/);
    expect(detail.endsWith('last line')).toBe(true);
    expect(detail.length).toBeLessThan(SETUP_OUTPUT_TAIL_CHARS + 20);
  });

  it.each([
    [{ kind: 'timedOut', output: 'slow' } as ProcessOutcome, 'timed out: slow'],
    [{ kind: 'aborted', output: '' } as ProcessOutcome, 'aborted'],
    [{ kind: 'spawnFailed', message: 'ENOENT', output: '' } as ProcessOutcome, 'could not start: ENOENT'],
  ])('maps %#', async (outcome, detail) => {
    expect(await runWorkspaceSetup(runner(outcome))('c', '/c')).toEqual({ ok: false, detail });
  });

  it('honors a custom timeout', async () => {
    const fn = runner({ kind: 'completed', exitCode: 0, output: '' });
    await runWorkspaceSetup(fn, { timeoutMs: 5 })('c', '/c');
    expect(fn.mock.calls[0]![3]).toMatchObject({ timeoutMs: 5 });
  });
});

describe('mainCheckoutOf', () => {
  it('reads the checkout from a .git common dir only', () => {
    expect(mainCheckoutOf('/r/app/.git')).toBe('/r/app');
    expect(mainCheckoutOf('/r/app/.git/')).toBe('/r/app');
    expect(mainCheckoutOf('/r/app.git')).toBeUndefined();
    expect(mainCheckoutOf(null)).toBeUndefined();
  });
});

describe('createDepsProvisioner', () => {
  it('reads the explicit block of the matching repository and derives the main checkout', async () => {
    const run = vi.fn(async (..._args: Parameters<GateProcessRunner>): Promise<ProcessOutcome> => ({
      kind: 'completed',
      exitCode: 0,
      output: '',
    }));
    const provision = createDepsProvisioner({
      manifest: () =>
        ({ repositories: { App: { graphWorkspace: { setup: 'make deps' } } } }) as unknown as Manifest,
      run,
      debug: () => undefined,
    });
    const result = await provision(
      { repoName: 'app', canonicalWorktreePath: worktree, gitCommonDir: join(main, '.git'), baseCommit: 'x' },
      clone,
    );
    expect(result.kind).toBe('ready');
    expect(run.mock.calls[0]![1]).toContain('make deps');
    expect(run.mock.calls[0]![2]).toBe(clone);
  });
});
