import { describe, expect, it } from 'vitest';
import { baseMovedReason, checkBaseMoved, type BaseMovedDeps, type MergedTree } from './baseMovedCheck.js';
import type { GitResult, GitRunner } from '../../integrations/git.js';

const HEAD = 'h'.repeat(40);
const BASE = 'b'.repeat(40);
const FORK = 'f'.repeat(40);
const TREE = 't'.repeat(40);
const MERGED = 'm'.repeat(40);
const ok = (stdout = ''): GitResult => ({ stdout, stderr: '', exitCode: 0 });

interface Script { fork?: string; probe?: GitResult; fetch?: GitResult; uiPaths?: string[]; ticketPaths?: string[] }

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
    if (a === 'diff') return ok((args.includes(HEAD) ? s.ticketPaths ?? ['src/a.ts'] : s.uiPaths ?? ['src/a.ts']).join('\0'));
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

  const UI = 'src/ui/dashboard/app/Drawer.tsx';
  const uiOf = async (s: Script) => {
    let seen: MergedTree | undefined;
    await checkBaseMoved(deps(fakeGit(s), { runGates: async (m) => { seen = m; return null; } }));
    return seen;
  };

  it('runs the UI gates when the ticket diff and the base delta both hold a UI path', async () => {
    expect(await uiOf({ uiPaths: [UI], ticketPaths: [UI] })).toMatchObject({ uiChanged: true, uiSkipReason: null });
  });

  it('cuts the UI gates when only the base delta holds a UI path (D592)', async () => {
    expect(await uiOf({ uiPaths: [UI], ticketPaths: ['src/approaches/graph/a.ts'] }))
      .toMatchObject({ uiChanged: false, uiSkipReason: 'skipped: no UI path in the ticket diff' });
  });

  it('cuts the UI gates when only the ticket diff holds a UI path', async () => {
    expect(await uiOf({ uiPaths: ['src/a.ts'], ticketPaths: [UI] }))
      .toMatchObject({ uiChanged: false, uiSkipReason: 'skipped: no UI path in the base delta' });
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

/** A fake git whose answer for one verb is replaced; every call is still recorded. */
const scripted = (replace: (args: string[]) => GitResult | undefined, s: Script = {}) => {
  const base = fakeGit(s);
  const git: GitRunner = async (raw, cwd) => {
    const args = [...raw];
    while (args[0] === '-c') args.splice(0, 2);
    const hit = replace(args);
    if (hit !== undefined) { base.calls.push(args); return hit; }
    return base.git(raw, cwd);
  };
  return { git, calls: base.calls };
};
const fail = (stderr: string, stdout = '', exitCode = 1): GitResult => ({ stdout, stderr, exitCode });
const reasonOf = async (g: ReturnType<typeof scripted>, over: Partial<BaseMovedDeps> = {}) =>
  (await checkBaseMoved(deps(g as never, { git: g.git, ...over }))) as { kind: string; reason?: string };

describe('checkBaseMoved git calls', () => {
  it('fetches the base ref from origin and compares the branch with the base tip', async () => {
    const g = fakeGit();
    await checkBaseMoved(deps(g));
    expect(g.calls).toContainEqual(['fetch', 'origin', 'develop']);
    expect(g.calls).toContainEqual(['rev-parse', 'HEAD']);
    expect(g.calls).toContainEqual(['rev-parse', 'origin/develop']);
    expect(g.calls).toContainEqual(['merge-base', 'HEAD', 'origin/develop']);
    expect(g.calls).toContainEqual(['merge-tree', '--write-tree', '--name-only', BASE, HEAD]);
  });

  it('commits the merge tree with both parents, the karst identity and a message', async () => {
    const g = fakeGit();
    await checkBaseMoved(deps(g));
    const raw: string[][] = [];
    const spy: GitRunner = async (a, c) => { raw.push([...a]); return g.git(a, c); };
    await checkBaseMoved(deps(g, { git: spy }));
    const commit = raw.find((c) => c.includes('commit-tree'))!;
    expect(commit.slice(0, 4)).toEqual(['-c', 'user.name=karst', '-c', 'user.email=karst@localhost']);
    expect(commit.slice(4)).toEqual(['commit-tree', TREE, '-p', HEAD, '-p', BASE, '-m', 'karst: merged tree CI would test (never pushed)']);
  });

  it('reads the base delta from the last green base and the ticket diff from the fork point', async () => {
    const g = fakeGit({ uiPaths: ['src/ui/a.tsx'] });
    await checkBaseMoved(deps(g));
    expect(g.calls).toContainEqual(['diff', '--name-only', '-z', 'g'.repeat(40), BASE]);
    expect(g.calls).toContainEqual(['diff', '--name-only', '-z', FORK, HEAD]);
  });

  it('reads no ticket diff when the base delta holds no UI path', async () => {
    const g = fakeGit({ uiPaths: ['src/a.ts'] });
    await checkBaseMoved(deps(g));
    expect(g.calls.filter((c) => c[0] === 'diff')).toHaveLength(1);
  });

  it('adds the merged worktree below the parent with a random merged- name', async () => {
    const g = fakeGit();
    await checkBaseMoved(deps(g));
    const add = g.calls.find((c) => c[0] === 'worktree' && c[1] === 'add')!;
    expect(add.slice(0, 3)).toEqual(['worktree', 'add', '--detach']);
    expect(add[3]).toMatch(/^\/repo\/\.karst\/base-check\/merged-[0-9a-f]{8}$/);
    expect(g.calls).toContainEqual(['worktree', 'remove', '--force', add[3]]);
  });

  it('treats an unreadable diff as UI on both sides and names it in the log', async () => {
    const debug: string[] = [];
    const g = scripted((a) => (a[0] === 'diff' ? fail('bad object', '', 128) : undefined));
    let seen: MergedTree | undefined;
    await checkBaseMoved(deps(g as never, { git: g.git, debug: (m) => debug.push(m), runGates: async (m) => { seen = m; return null; } }));
    expect(seen).toMatchObject({ uiChanged: true, uiSkipReason: null });
    expect(debug).toContain('[ship] base delta unreadable (bad object): keeping every UI gate');
  });

  it('treats an unreadable ticket diff as UI when the base delta holds UI', async () => {
    const debug: string[] = [];
    const g = scripted((a) => (a[0] === 'diff' && a.includes(HEAD) ? fail('', '', 128) : undefined), { uiPaths: ['src/ui/a.tsx'] });
    let seen: MergedTree | undefined;
    await checkBaseMoved(deps(g as never, { git: g.git, debug: (m) => debug.push(m), runGates: async (m) => { seen = m; return null; } }));
    expect(seen?.uiChanged).toBe(true);
    expect(debug).toContain('[ship] ticket diff unreadable (git exit 128): keeping every UI gate');
  });

  it('treats an empty fork point as an unreadable ticket diff', async () => {
    const g = scripted((a) => (a[0] === 'merge-base' ? ok('\n') : undefined), { uiPaths: ['src/ui/a.tsx'], ticketPaths: ['src/a.ts'] });
    let seen: MergedTree | undefined;
    await checkBaseMoved(deps(g as never, { git: g.git, runGates: async (m) => { seen = m; return null; } }));
    expect(seen?.uiChanged).toBe(true);
  });

  it('ignores empty entries of the NUL-separated diff', async () => {
    const g = scripted((a) => (a[0] === 'diff' ? ok('\0src/a.ts\0\0') : undefined));
    let seen: MergedTree | undefined;
    await checkBaseMoved(deps(g as never, { git: g.git, runGates: async (m) => { seen = m; return null; } }));
    expect(seen?.uiChanged).toBe(false);
  });
});

describe('checkBaseMoved unknown reasons', () => {
  it('prefers stderr, then stdout, then the exit code for the reason', async () => {
    expect(await reasonOf(scripted((a) => (a[0] === 'fetch' ? fail('  boom \n', 'out') : undefined)))).toEqual({ kind: 'unknown', reason: 'boom' });
    expect(await reasonOf(scripted((a) => (a[0] === 'fetch' ? fail('', ' only out \n') : undefined)))).toEqual({ kind: 'unknown', reason: 'only out' });
    expect(await reasonOf(scripted((a) => (a[0] === 'fetch' ? fail('', '', 7) : undefined)))).toEqual({ kind: 'unknown', reason: 'git exit 7' });
  });

  it('is unknown with the HEAD error when HEAD cannot be read', async () => {
    const g = scripted((a) => (a[0] === 'rev-parse' && a[1] === 'HEAD' ? fail('no head', '', 128) : undefined));
    expect(await reasonOf(g)).toEqual({ kind: 'unknown', reason: 'no head' });
  });

  it('is unknown with the base error when the base ref cannot be read', async () => {
    const g = scripted((a) => (a[0] === 'rev-parse' && a[1] !== 'HEAD' ? fail('no base', '', 128) : undefined));
    expect(await reasonOf(g)).toEqual({ kind: 'unknown', reason: 'no base' });
  });

  it('is unknown when a rev-parse prints nothing', async () => {
    const empty = scripted((a) => (a[0] === 'rev-parse' && a[1] === 'HEAD' ? ok('\n') : undefined));
    expect((await reasonOf(empty)).kind).toBe('unknown');
    const noBase = scripted((a) => (a[0] === 'rev-parse' && a[1] !== 'HEAD' ? ok('  ') : undefined));
    expect((await reasonOf(noBase)).kind).toBe('unknown');
  });

  it('trims the rev-parse output before it uses the SHAs', async () => {
    const g = scripted((a) => (a[0] === 'rev-parse' ? ok(`${a[1] === 'HEAD' ? HEAD : BASE}\n`) : undefined));
    await checkBaseMoved(deps(g as never, { git: g.git }));
    expect(g.calls).toContainEqual(['merge-tree', '--write-tree', '--name-only', BASE, HEAD]);
  });

  it('does not call the branch unchanged when the fork point differs from the base tip', async () => {
    const g = scripted((a) => (a[0] === 'merge-base' ? ok(`${BASE}\n`) : undefined));
    expect((await reasonOf(g)).kind).toBe('unchanged');
    const failed = scripted((a) => (a[0] === 'merge-base' ? { stdout: BASE, stderr: '', exitCode: 1 } : undefined));
    expect((await reasonOf(failed)).kind).toBe('passed');
  });

  it('is unknown when the merge probe prints no tree, even with exit 0', async () => {
    expect((await reasonOf(scripted((a) => (a[0] === 'merge-tree' ? ok('\n') : undefined)))).kind).toBe('unknown');
    expect((await reasonOf(scripted((a) => (a[0] === 'merge-tree' ? ok(`${TREE}\n`) : undefined)))).kind).toBe('passed');
  });

  it('passes the tree id without its newline to commit-tree', async () => {
    const g = scripted((a) => (a[0] === 'merge-tree' ? ok(`  ${TREE}  \nignored\n`) : undefined));
    await checkBaseMoved(deps(g as never, { git: g.git }));
    expect(g.calls.find((c) => c.includes('commit-tree'))).toContain(TREE);
  });

  it('is unknown with the commit error when commit-tree fails', async () => {
    const g = scripted((a) => (a.includes('commit-tree') ? fail('no identity') : undefined));
    expect(await reasonOf(g)).toEqual({ kind: 'unknown', reason: 'no identity' });
  });

  it('is unknown when commit-tree prints no SHA, and trims it otherwise', async () => {
    expect((await reasonOf(scripted((a) => (a.includes('commit-tree') ? ok('\n') : undefined)))).kind).toBe('unknown');
    const g = scripted((a) => (a.includes('commit-tree') ? ok(`${MERGED}\n`) : undefined));
    expect(await checkBaseMoved(deps(g as never, { git: g.git }))).toEqual({ kind: 'passed', mergedSha: MERGED });
  });

  it('is unknown with the git error when the worktree cannot be added, and runs no gate', async () => {
    let ran = false;
    const g = scripted((a) => (a[0] === 'worktree' && a[1] === 'add' ? fail('exists') : undefined));
    expect(await reasonOf(g, { runGates: async () => { ran = true; return null; } })).toEqual({ kind: 'unknown', reason: 'exists' });
    expect(ran).toBe(false);
    expect(g.calls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(false);
  });

  it('logs, and still reports the verdict, when the worktree cannot be removed', async () => {
    const debug: string[] = [];
    const g = scripted((a) => (a[0] === 'worktree' && a[1] === 'remove' ? fail('busy') : undefined));
    const r = await checkBaseMoved(deps(g as never, { git: g.git, debug: (m) => debug.push(m) }));
    expect(r.kind).toBe('passed');
    expect(debug).toHaveLength(1);
    expect(debug[0]).toMatch(/^\[ship\] base-check worktree \/repo\/\.karst\/base-check\/merged-[0-9a-f]{8} not removed: busy$/);
  });

  it('does not log when the worktree is removed', async () => {
    const debug: string[] = [];
    await checkBaseMoved(deps(fakeGit(), { debug: (m) => debug.push(m) }));
    expect(debug).toEqual([]);
  });

  it('names the error message of a thrown Error, and the value of anything else', async () => {
    const g = fakeGit();
    expect(await checkBaseMoved(deps(g, { runGates: async () => { throw new Error('boom'); } }))).toEqual({ kind: 'unknown', reason: 'boom' });
    expect(await checkBaseMoved(deps(g, { runGates: async () => { throw 'text'; } }))).toEqual({ kind: 'unknown', reason: 'text' });
  });

  it('logs a non-Error seeding failure by its value, and hands the seed the ticket cwd', async () => {
    const debug: string[] = [];
    let seen: { cwd: string; baseSha: string } | undefined;
    await checkBaseMoved(deps(fakeGit(), { debug: (m) => debug.push(m), seedState: async (s) => { seen = s; throw 'nope'; } }));
    expect(seen).toMatchObject({ cwd: '/repo', baseSha: BASE });
    expect(debug).toContain('[ship] base-check gate state not seeded (gates run in full): nope');
  });

  it('keeps the conflict files up to the first blank line and trims each', async () => {
    const g = fakeGit({ probe: { stdout: `${TREE}\n  a.ts \nb.ts\n\nc.ts\n`, stderr: '', exitCode: 1 } });
    expect(await checkBaseMoved(deps(g))).toEqual({ kind: 'conflict', files: ['a.ts', 'b.ts'] });
  });
});

describe('baseMovedReason', () => {
  it('names the base ref, the 9-character base SHA and the failure', () => {
    expect(baseMovedReason('develop', BASE, 'x')).toBe('fails when merged with origin/develop bbbbbbbbb; CI tests this merge — x');
  });
});
