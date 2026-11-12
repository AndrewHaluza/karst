import { describe, expect, it } from 'vitest';
import { checkBaseMoved, type BaseMovedDeps, type MergedTree } from './baseMovedCheck.js';
import type { GitResult, GitRunner } from '../../integrations/git.js';

const HEAD = 'h'.repeat(40);
const BASE = 'b'.repeat(40);
const FORK = 'f'.repeat(40);
const TREE = 't'.repeat(40);
const MERGED = 'm'.repeat(40);
const ok = (stdout = ''): GitResult => ({ stdout, stderr: '', exitCode: 0 });

interface Script { fork?: string; probe?: GitResult; fetch?: GitResult; uiPaths?: string[] }

/** A fake git: answers by the first argument(s) and records every call. */
const fakeGit = (s: Script = {}) => {
  const calls: string[][] = [];
  const git: GitRunner = async (raw) => {
    const args = [...raw];
    while (args[0] === '-c') args.splice(0, 2); // leading config flags are not the verb
    calls.push(args);
    const [a, b] = args;
    if (a === 'fetch') return s.fetch ?? ok();
    if (a === 'rev-parse') return ok(args[1] === 'HEAD' ? HEAD : BASE);
    if (a === 'merge-base') return ok(s.fork ?? FORK);
    if (a === 'merge-tree') return s.probe ?? ok(`${TREE}\n`);
    if (a === 'commit-tree') return ok(MERGED);
    if (a === 'diff') return ok((s.uiPaths ?? ['src/a.ts']).join('\0'));
    if (a === 'worktree' && (b === 'add' || b === 'remove')) return ok();
    return { stdout: '', stderr: `unexpected ${args.join(' ')}`, exitCode: 128 };
  };
  return { git, calls };
};

const deps = (g: ReturnType<typeof fakeGit>, over: Partial<BaseMovedDeps> = {}): BaseMovedDeps => ({
  git: g.git, cwd: '/repo', baseRef: 'develop',
  lastGreenBase: async () => 'g'.repeat(40),
  worktreeParent: async () => '/repo/.karst/base-check',
  runGates: async () => null,
  ...over,
});

describe('checkBaseMoved', () => {
  it('runs nothing when the branch already contains the base tip', async () => {
    const g = fakeGit({ fork: BASE });
    let ran = false;
    const r = await checkBaseMoved(deps(g, { runGates: async () => { ran = true; return null; } }));
    expect(r.kind).toBe('unchanged');
    expect(ran).toBe(false);
  });

  it('runs nothing when no green gate run left a base (push as today)', async () => {
    const g = fakeGit();
    const r = await checkBaseMoved(deps(g, { lastGreenBase: async () => null }));
    expect(r.kind).toBe('no-baseline');
    expect(g.calls.some((c) => c[0] === 'merge-tree')).toBe(false);
  });

  it('runs no gate on a conflict and returns the files', async () => {
    const g = fakeGit({ probe: { stdout: `${TREE}\nsrc/x.ts\n\nCONFLICT (content)`, stderr: '', exitCode: 1 } });
    let ran = false;
    const r = await checkBaseMoved(deps(g, { runGates: async () => { ran = true; return null; } }));
    expect(r).toEqual({ kind: 'conflict', files: ['src/x.ts'] });
    expect(ran).toBe(false);
  });

  it('runs the gates on a detached merged commit and never touches the branch', async () => {
    const g = fakeGit();
    let seen: MergedTree | undefined;
    const r = await checkBaseMoved(deps(g, { runGates: async (m) => { seen = m; return null; } }));
    expect(r).toEqual({ kind: 'passed', mergedSha: MERGED });
    expect(seen).toMatchObject({ sha: MERGED, uiChanged: false });
    expect(seen?.cwd.startsWith('/repo/.karst/base-check/')).toBe(true);
    const verbs = g.calls.map((c) => c[0]);
    expect(g.calls.find((c) => c[0] === 'commit-tree')).toEqual(expect.arrayContaining(['-p', HEAD, BASE]));
    expect(verbs).not.toContain('checkout');
    expect(verbs).not.toContain('reset');
    expect(verbs).not.toContain('merge');
    const add = g.calls.find((c) => c[0] === 'worktree' && c[1] === 'add');
    expect(add).toEqual(expect.arrayContaining(['--detach', MERGED]));
  });

  it('removes the temporary worktree after a pass and after a failure', async () => {
    const pass = fakeGit();
    await checkBaseMoved(deps(pass));
    expect(pass.calls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(true);
    const fail = fakeGit();
    await checkBaseMoved(deps(fail, { runGates: async () => 'r: gate "test" failed (exit 1)' }));
    expect(fail.calls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(true);
  });

  it('removes the temporary worktree when the gate run throws', async () => {
    const g = fakeGit();
    const r = await checkBaseMoved(deps(g, { runGates: async () => { throw new Error('boom'); } }));
    expect(r.kind).toBe('unknown');
    expect(g.calls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(true);
  });

  it('a gate failure blocks the push with the CI reason', async () => {
    const g = fakeGit();
    const r = await checkBaseMoved(deps(g, { runGates: async () => 'r: gate "visual" failed (exit 1)' }));
    expect(r).toEqual({
      kind: 'failed', mergedSha: MERGED,
      reason: `fails when merged with origin/develop ${BASE.slice(0, 9)}; CI tests this merge — r: gate "visual" failed (exit 1)`,
    });
  });

  it('tells the gates when the base delta holds a UI path', async () => {
    const g = fakeGit({ uiPaths: ['src/ui/dashboard/app/Drawer.tsx'] });
    let ui: boolean | undefined;
    await checkBaseMoved(deps(g, { runGates: async (m) => { ui = m.uiChanged; return null; } }));
    expect(ui).toBe(true);
  });

  it('keeps every UI gate when the base delta cannot be read', async () => {
    const calls: string[][] = [];
    const base = fakeGit();
    const git: GitRunner = async (args, cwd) => {
      calls.push(args);
      return args[0] === 'diff' ? { stdout: '', stderr: 'bad object', exitCode: 128 } : base.git(args, cwd);
    };
    let ui: boolean | undefined;
    await checkBaseMoved(deps(base, { git, runGates: async (m) => { ui = m.uiChanged; return null; } }));
    expect(ui).toBe(true);
  });

  it('seeds the gate state of the merged worktree before the gates run', async () => {
    const g = fakeGit();
    const order: string[] = [];
    await checkBaseMoved(deps(g, {
      seedState: async (s) => { order.push(`seed ${s.baseSha === BASE} ${s.mergedCwd.startsWith('/repo/.karst/base-check/')}`); },
      runGates: async () => { order.push('gates'); return null; },
    }));
    expect(order).toEqual(['seed true true', 'gates']);
  });

  it('runs the gates in full, never blocks, when the seeding throws', async () => {
    const g = fakeGit();
    const debug: string[] = [];
    let ran = false;
    const r = await checkBaseMoved(deps(g, {
      seedState: async () => { throw new Error('disk'); },
      runGates: async () => { ran = true; return null; },
      debug: (m) => debug.push(m),
    }));
    expect(r.kind).toBe('passed');
    expect(ran).toBe(true);
    expect(debug.join()).toMatch(/not seeded.*disk/);
  });

  it('is unknown (push allowed) when the fetch fails', async () => {
    const g = fakeGit({ fetch: { stdout: '', stderr: 'no remote', exitCode: 128 } });
    const r = await checkBaseMoved(deps(g));
    expect(r).toEqual({ kind: 'unknown', reason: 'no remote' });
  });

  it('is unknown when the merge probe errors', async () => {
    const g = fakeGit({ probe: { stdout: '', stderr: 'fatal: bad', exitCode: 128 } });
    const r = await checkBaseMoved(deps(g));
    expect(r).toEqual({ kind: 'unknown', reason: 'fatal: bad' });
  });
});
