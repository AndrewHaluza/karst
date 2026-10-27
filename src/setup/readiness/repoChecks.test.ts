import { describe, it, expect } from 'vitest';
import { checkRepo } from './repoChecks.js';
import { fakeProbes } from './fakeProbes.testutil.js';

const repo = { repoPath: '/w/web', hasMigrations: false };
const status = (items: { id: string; status: string }[], id: string) => items.find((i) => i.id === id)?.status;

describe('checkRepo', () => {
  it('all ok', async () => {
    const items = await checkRepo('web', repo, 'main', fakeProbes());
    expect(items.map((i) => `${i.id}:${i.status}`)).toEqual([
      'repo.git.web:ok', 'repo.baseline.web:ok', 'repo.origin.web:ok', 'repo.remote.web:ok', 'repo.worktree.web:ok',
    ]);
  });
  it('not a git repo stops further checks', async () => {
    const items = await checkRepo('web', repo, 'main', fakeProbes({ isGitRepo: () => false }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'repo.git.web', status: 'fail' });
    expect(items[0]!.fix).toMatch(/init -b main/);
  });
  it('missing baseline fails and skips the rest', async () => {
    const items = await checkRepo('web', repo, 'main', fakeProbes({ branchExists: () => false }));
    expect(status(items, 'repo.baseline.web')).toBe('fail');
    expect(items).toHaveLength(2);
  });
  it('no origin fails, skips reachability, still tries the worktree', async () => {
    const items = await checkRepo('web', repo, 'main', fakeProbes({ hasRemote: () => false }));
    expect(status(items, 'repo.origin.web')).toBe('fail');
    expect(status(items, 'repo.remote.web')).toBeUndefined();
    expect(status(items, 'repo.worktree.web')).toBe('ok');
  });
  it('unreachable remote fails', async () => {
    const items = await checkRepo('web', repo, 'main', fakeProbes({ remoteReachable: async () => false }));
    expect(status(items, 'repo.remote.web')).toBe('fail');
  });
  it('worktree failure carries the error, and unknown when absent', async () => {
    const a = await checkRepo('web', repo, 'main', fakeProbes({ worktreeTrial: async () => ({ ok: false, error: 'boom' }) }));
    expect(a.find((i) => i.id === 'repo.worktree.web')!.detail).toContain('boom');
    const b = await checkRepo('web', repo, 'main', fakeProbes({ worktreeTrial: async () => ({ ok: false }) }));
    expect(b.find((i) => i.id === 'repo.worktree.web')!.detail).toContain('unknown');
  });
});
