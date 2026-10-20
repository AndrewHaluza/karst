import { describe, expect, it, vi } from 'vitest';
import { rebaseOnBase, type RebaseDeps } from './rebaseOnBaseOps.js';

interface Rig {
  deps: RebaseDeps;
  calls: string[];
  errors: string[];
}

function rig(over: Partial<RebaseDeps> & { failGit?: (args: string[]) => boolean; dirtyAfterGen?: boolean } = {}): Rig {
  const calls: string[] = [];
  const errors: string[] = [];
  const { failGit, dirtyAfterGen, ...rest } = over;
  let generated = false;
  const deps: RebaseDeps = {
    repo: 'karst',
    cwd: '/wt',
    branch: 'feat/x',
    baseRef: 'develop',
    regenerate: [],
    git: async (_cwd, args) => {
      calls.push(`git ${args.join(' ')}`);
      if (failGit?.([...args])) return { code: 1, stdout: '', stderr: 'boom' };
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'orig123\n', stderr: '' };
      if (args[0] === 'status') return { code: 0, stdout: generated && dirtyAfterGen ? ' M docs/a.md\n' : '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    runScript: async (_cwd, cmd) => {
      calls.push(`run ${cmd}`);
      generated = true;
      return { code: 0, stderr: '' };
    },
    agentActive: () => false,
    sandboxUnsynced: async () => false,
    prHeadSha: async () => 'headsha1',
    removeSandbox: async () => {
      calls.push('remove');
    },
    reopenSandbox: async () => {
      calls.push('reopen');
    },
    reprobe: async () => {
      calls.push('reprobe');
    },
    confirm: async () => true,
    info: vi.fn(),
    error: (m) => errors.push(m),
    logError: vi.fn(),
    afterServerChange: vi.fn(),
    ...rest,
  };
  return { deps, calls, errors };
}

describe('rebaseOnBase', () => {
  it('refuses while an agent turn is active and touches nothing', async () => {
    const r = rig({ agentActive: () => true });
    await rebaseOnBase(r.deps);
    expect(r.errors[0]).toMatch(/agent is working/);
    expect(r.calls).toEqual([]);
    expect(r.deps.afterServerChange).toHaveBeenCalled();
  });

  it('refuses with unsynced sandbox commits', async () => {
    const r = rig({ sandboxUnsynced: async () => true });
    await rebaseOnBase(r.deps);
    expect(r.errors[0]).toMatch(/sync or carry sandbox commits first/);
    expect(r.calls).toEqual([]);
  });

  it('does nothing when the user declines', async () => {
    const r = rig({ confirm: async () => false });
    await rebaseOnBase(r.deps);
    expect(r.calls).toEqual([]);
  });

  it('aborts on conflict and moves nothing', async () => {
    const r = rig({ failGit: (a) => a[0] === 'rebase' && a[1] !== '--abort' });
    await rebaseOnBase(r.deps);
    expect(r.calls).toContain('git rebase --abort');
    expect(r.calls.some((c) => c.startsWith('git push'))).toBe(false);
    expect(r.calls).not.toContain('remove');
    expect(r.errors[0]).toMatch(/conflict/i);
  });

  it('runs generators and commits only when they changed files', async () => {
    const r = rig({ regenerate: ['npm run -s docs:covers', 'npm run -s docs:graph'], dirtyAfterGen: true });
    await rebaseOnBase(r.deps);
    expect(r.calls.filter((c) => c.startsWith('run '))).toEqual(['run npm run -s docs:covers', 'run npm run -s docs:graph']);
    expect(r.calls).toContain('git add -A');
    expect(r.calls.some((c) => c.startsWith('git commit'))).toBe(true);
    expect(r.calls.indexOf('git add -A')).toBeLessThan(r.calls.findIndex((c) => c.startsWith('git push')));
  });

  it('skips the commit when generators change nothing', async () => {
    const r = rig({ regenerate: ['gen'] });
    await rebaseOnBase(r.deps);
    expect(r.calls.some((c) => c.startsWith('git commit'))).toBe(false);
  });

  it('resets to the pre-rebase head when a generator fails', async () => {
    const r = rig({ regenerate: ['gen'], runScript: async () => ({ code: 2, stderr: 'bad' }) });
    await rebaseOnBase(r.deps);
    expect(r.calls).toContain('git reset --hard orig123');
    expect(r.calls.some((c) => c.startsWith('git push'))).toBe(false);
    expect(r.errors[0]).toMatch(/gen/);
  });

  it('pushes with the lease on the PR head sha, then recreates in order', async () => {
    const r = rig();
    await rebaseOnBase(r.deps);
    const push = r.calls.findIndex((c) => c.startsWith('git push'));
    expect(r.calls[push]).toBe('git push --force-with-lease=feat/x:headsha1 origin HEAD:refs/heads/feat/x');
    expect(r.calls.slice(push + 1)).toEqual(['remove', 'reopen', 'reprobe']);
  });

  it('lease rejected: no recreate, reports', async () => {
    const r = rig({ failGit: (a) => a[0] === 'push' });
    await rebaseOnBase(r.deps);
    expect(r.calls).not.toContain('remove');
    expect(r.errors[0]).toMatch(/lease|moved|push/i);
  });

  it('unsynced commits appearing after the push stop before Remove', async () => {
    let n = 0;
    const r = rig({ sandboxUnsynced: async () => ++n > 1 });
    await rebaseOnBase(r.deps);
    expect(r.calls.some((c) => c.startsWith('git push'))).toBe(true);
    expect(r.calls).not.toContain('remove');
    expect(r.errors[0]).toMatch(/pushed/i);
    expect(r.calls).toContain('reprobe');
  });

  it('agent turn starting after the push stops before Remove', async () => {
    let n = 0;
    const r = rig({ agentActive: () => ++n > 1 });
    await rebaseOnBase(r.deps);
    expect(r.calls).not.toContain('remove');
    expect(r.errors[0]).toMatch(/agent is working/);
  });

  it('recreate failure is reported, push stands', async () => {
    const r = rig({
      removeSandbox: async () => {
        throw new Error('rm failed');
      },
    });
    await rebaseOnBase(r.deps);
    expect(r.errors[0]).toMatch(/rm failed/);
    expect(r.calls).toContain('reprobe');
  });

  it('fails clean when gh head lookup throws', async () => {
    const r = rig({
      prHeadSha: async () => {
        throw new Error('gh down');
      },
    });
    await rebaseOnBase(r.deps);
    expect(r.calls.some((c) => c.startsWith('git push'))).toBe(false);
    expect(r.errors[0]).toMatch(/gh down/);
  });
  it('exact refusal and confirm wording', async () => {
    const busy = rig({ agentActive: () => true });
    await rebaseOnBase(busy.deps);
    expect(busy.errors).toEqual(['Rebase on base: agent is working; try when idle.']);
    const unsynced = rig({ sandboxUnsynced: async () => true });
    await rebaseOnBase(unsynced.deps);
    expect(unsynced.errors).toEqual(['Rebase on base: sync or carry sandbox commits first.']);
    const confirm = vi.fn(async () => false);
    await rebaseOnBase(rig({ confirm }).deps);
    expect(confirm).toHaveBeenCalledWith('Rebase feat/x onto origin/develop in karst and force-push (with lease)?');
  });
  it('happy path runs the exact git sequence and reports success', async () => {
    const info = vi.fn();
    const r = rig({ info, regenerate: ['gen'], dirtyAfterGen: true });
    await rebaseOnBase(r.deps);
    expect(r.calls).toEqual([
      'git rev-parse HEAD',
      'git fetch origin develop',
      'git rebase origin/develop',
      'run gen',
      'git status --porcelain',
      'git add -A',
      'git commit -m chore: regenerate generated files after rebase',
      'git push --force-with-lease=feat/x:headsha1 origin HEAD:refs/heads/feat/x',
      'remove',
      'reopen',
      'reprobe',
    ]);
    expect(info).toHaveBeenCalledWith('Rebased feat/x onto origin/develop, pushed, and recreated the sandbox.');
    expect(r.errors).toEqual([]);
    expect(r.deps.afterServerChange).toHaveBeenCalledOnce();
  });
  it('fetch failure stops before the rebase', async () => {
    const r = rig({ failGit: (a) => a[0] === 'fetch' });
    await rebaseOnBase(r.deps);
    expect(r.errors).toEqual(['Rebase on base: fetch failed: boom']);
    expect(r.calls).toEqual(['git rev-parse HEAD', 'git fetch origin develop']);
  });
  it('conflict message names the base and aborts the rebase', async () => {
    const r = rig({ failGit: (a) => a[0] === 'rebase' && a[1] !== '--abort' });
    await rebaseOnBase(r.deps);
    expect(r.calls).toContain('git rebase --abort');
    expect(r.errors).toEqual(['Rebase on base: conflict rebasing onto origin/develop; rebase aborted, nothing changed. boom']);
  });
  it('generator failure names the command and restores the head', async () => {
    const r = rig({ regenerate: ['gen a', 'gen b'], runScript: async () => ({ code: 2, stderr: ' bad ' }) });
    await rebaseOnBase(r.deps);
    expect(r.calls).toContain('git reset --hard orig123');
    expect(r.errors).toEqual(['Rebase on base: generator `gen a` failed (bad); branch restored, nothing pushed.']);
  });
  it('commit failure of regenerated files restores the head and does not push', async () => {
    const r = rig({ regenerate: ['gen'], dirtyAfterGen: true, failGit: (a) => a[0] === 'commit' });
    await rebaseOnBase(r.deps);
    expect(r.calls).toContain('git reset --hard orig123');
    expect(r.calls.some((c) => c.startsWith('git push'))).toBe(false);
    expect(r.errors).toEqual(['Rebase on base: committing regenerated files failed: boom; branch restored.']);
  });
  it('every generator runs, in order, before the status check', async () => {
    const r = rig({ regenerate: ['one', 'two'] });
    await rebaseOnBase(r.deps);
    const i = (c: string) => r.calls.indexOf(c);
    expect(i('run one')).toBeLessThan(i('run two'));
    expect(i('run two')).toBeLessThan(i('git status --porcelain'));
  });
  it('no generators: no status, add or commit at all', async () => {
    const r = rig();
    await rebaseOnBase(r.deps);
    expect(r.calls.some((c) => c.startsWith('git status') || c.startsWith('git add') || c.startsWith('git commit'))).toBe(false);
  });
  it('head lookup failure restores the head with a clear message', async () => {
    const r = rig({ prHeadSha: async () => { throw new Error('gh down'); } });
    await rebaseOnBase(r.deps);
    expect(r.calls).toContain('git reset --hard orig123');
    expect(r.errors).toEqual(['Rebase on base: could not read the PR head (gh down); nothing pushed.']);
  });
  it('agent starting before the push restores the head and does not push', async () => {
    let n = 0;
    const r = rig({ agentActive: () => ++n > 1 });
    await rebaseOnBase(r.deps);
    expect(r.calls).toContain('git reset --hard orig123');
    expect(r.calls.some((c) => c.startsWith('git push'))).toBe(false);
    expect(r.errors).toEqual(['Rebase on base: agent is working; try when idle.']);
  });
  it('rejected push restores the head, quotes stderr and leaves the sandbox', async () => {
    const r = rig({ failGit: (a) => a[0] === 'push' });
    await rebaseOnBase(r.deps);
    expect(r.calls).toContain('git reset --hard orig123');
    expect(r.errors).toEqual(['Rebase on base: push rejected (lease: the remote branch moved, or push failed): boom. Sandbox left as is.']);
    expect(r.calls).not.toContain('remove');
    expect(r.calls).not.toContain('reprobe');
  });
  it('post-push stops still re-probe and say what happened', async () => {
    let n = 0;
    const busy = rig({ agentActive: () => ++n > 2 });
    await rebaseOnBase(busy.deps);
    expect(busy.errors).toEqual(['Pushed feat/x. Rebase on base: agent is working; try when idle. Recreate the sandbox once idle.']);
    let calls = 0;
    const unsynced = rig({ sandboxUnsynced: async () => ++calls > 1 });
    await rebaseOnBase(unsynced.deps);
    expect(unsynced.errors).toEqual(['Pushed feat/x, but new sandbox commits appeared; sync or carry them, then recreate the sandbox.']);
    expect(unsynced.calls).not.toContain('remove');
  });
  it('recreate failure logs, reports with the cause, and the push stands', async () => {
    const logError = vi.fn();
    const r = rig({ logError, removeSandbox: async () => { throw new Error('busy'); } });
    await rebaseOnBase(r.deps);
    expect(logError).toHaveBeenCalledWith('rebaseOnBase recreate failed', expect.any(Error));
    expect(r.errors).toEqual(['Pushed feat/x, but recreating the sandbox failed: busy']);
    expect(r.calls).toContain('reprobe');
    expect(r.calls).not.toContain('reopen');
  });
  it('an unexpected throw is logged, reported, and still settles the UI', async () => {
    const logError = vi.fn();
    const r = rig({ logError, git: async () => { throw 'kaput'; } });
    await rebaseOnBase(r.deps);
    expect(logError).toHaveBeenCalledWith('rebaseOnBase failed', 'kaput');
    expect(r.errors).toEqual(['Rebase on base failed: kaput']);
    expect(r.deps.afterServerChange).toHaveBeenCalledOnce();
  });
});
