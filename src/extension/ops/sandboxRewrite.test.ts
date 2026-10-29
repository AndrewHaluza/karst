import { describe, expect, it } from 'vitest';
import { classifyDivergence, nodeGit, type GitRun } from './sandboxRewrite.js';

const OLD = 'a'.repeat(40); const CLONE = 'b'.repeat(40); const HOST = 'c'.repeat(40); const OLDER = 'd'.repeat(40);

interface World { clone?: string; host?: string; reflog?: string[]; reflogCode?: number; inClone: string[]; inHost: string[] }
function git(w: World) {
  const calls: string[][] = [];
  const run: GitRun = async (_cwd, args) => {
    calls.push([...args]);
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    const no = () => ({ code: 1, stdout: '', stderr: '' });
    if (args[0] === 'rev-parse') {
      const v = args[3] === 'refs/karst/sandbox/feat^{commit}' ? w.clone : args[3] === 'HEAD^{commit}' ? w.host : undefined;
      return v ? ok(`${v}\n`) : no();
    }
    if (args[0] === 'reflog') return w.reflogCode ? no() : ok((w.reflog ?? []).join('\n') + '\n\n');
    if (args[0] === 'merge-base') return (args[3] === w.clone ? w.inClone : w.inHost).includes(args[2]!) ? ok() : no();
    return no();
  };
  return { run, calls };
}
const base = { worktree: '/wt', branch: 'feat' };

describe('classifyDivergence (scripted git)', () => {
  const world = (over: Partial<World> = {}): World => ({ clone: CLONE, host: HOST, inClone: [OLD], inHost: [], ...over });

  it('rewritten: the recorded head is in the clone and gone from the host', async () => {
    const g = git(world());
    expect(await classifyDivergence(g.run, { ...base, recorded: OLD })).toEqual({ kind: 'rewritten', recorded: OLD, cloneHead: CLONE });
    expect(g.calls.some((c) => c[0] === 'reflog')).toBe(false);
  });

  it('diverged when the recorded head is still on the host branch', async () => {
    expect(await classifyDivergence(git(world({ inHost: [OLD] })).run, { ...base, recorded: OLD })).toEqual({ kind: 'diverged' });
  });

  it('diverged when the recorded head is not in the clone', async () => {
    expect(await classifyDivergence(git(world({ inClone: [] })).run, { ...base, recorded: OLD })).toEqual({ kind: 'diverged' });
  });

  it('diverged when the sandbox ref or HEAD cannot be resolved', async () => {
    expect(await classifyDivergence(git(world({ clone: undefined })).run, { ...base, recorded: OLD })).toEqual({ kind: 'diverged' });
    expect(await classifyDivergence(git(world({ host: undefined })).run, { ...base, recorded: OLD })).toEqual({ kind: 'diverged' });
  });

  it('skips a candidate equal to either head', async () => {
    expect(await classifyDivergence(git(world({ inClone: [CLONE] })).run, { ...base, recorded: CLONE })).toEqual({ kind: 'diverged' });
    expect(await classifyDivergence(git(world({ inClone: [HOST] })).run, { ...base, recorded: HOST })).toEqual({ kind: 'diverged' });
  });

  it('no record: walks the host reflog of the branch and takes the first provable head', async () => {
    const g = git(world({ reflog: [HOST, OLD, OLDER], inClone: [OLD, OLDER] }));
    expect(await classifyDivergence(g.run, { ...base, recorded: undefined })).toEqual({ kind: 'rewritten', recorded: OLD, cloneHead: CLONE });
    expect(g.calls.find((c) => c[0] === 'reflog')).toEqual(['reflog', 'show', '--format=%H', 'refs/heads/feat']);
  });

  it('no record and a failing or empty reflog is true divergence', async () => {
    expect(await classifyDivergence(git(world({ reflog: [OLD], reflogCode: 1 })).run, { ...base, recorded: undefined })).toEqual({ kind: 'diverged' });
    expect(await classifyDivergence(git(world({ reflog: [] })).run, { ...base, recorded: undefined })).toEqual({ kind: 'diverged' });
  });

  it('nodeGit runs git -C <cwd> through the process seam', async () => {
    const seen: unknown[] = [];
    const proc = { run: async (...a: unknown[]) => { seen.push(a); return { code: 0, stdout: '', stderr: '' }; } };
    await nodeGit(proc as never)('/wt', ['status']);
    expect(seen).toEqual([['git', ['-C', '/wt', 'status']]]);
  });
});
