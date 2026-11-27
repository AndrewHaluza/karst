import { describe, expect, it, vi } from 'vitest';
import type { SessionRunner } from '../../agent/sessionRunner.js';
import { recreateSandboxNoSync, sandboxHasUnsynced, type SandboxRebaseDeps } from './sandboxRebaseOps.js';
import type { SandboxSyncTarget } from './sandboxSyncOps.js';
import { fakeSshProcess } from '../../agent/ssh/fakeSshProcess.js';
import { fakeSshPlacement, fakeSshRunnerDeps } from './fakeSshRunnerDeps.js';

const target = (core: string | null, branch: string | null = 'feat/x'): SandboxSyncTarget => ({
  ticketId: 7, ticketLabel: 'T7', core, worktree: { path: '/wt', branch },
});
const base = (over: Partial<SandboxRebaseDeps> = {}): SandboxRebaseDeps =>
  ({ notify: {} as never, projectRoot: '/p', placementOf: () => null, choose: vi.fn(), owns: () => true, openSyncDiff: vi.fn(), reopen: vi.fn(async () => {}), ...over }) as SandboxRebaseDeps;
const runnerWith = (diff: unknown): SessionRunner => ({ diff: async () => diff }) as unknown as SessionRunner;

describe('sandboxHasUnsynced', () => {
  it('host ticket has none', async () => {
    expect(await sandboxHasUnsynced(base(), target(null))).toBe(false);
  });
  it('empty diff = synced', async () => {
    expect(await sandboxHasUnsynced(base({ runner: runnerWith({ ok: true, diff: '  \n', ref: 'r' }) }), target('claude'))).toBe(false);
  });
  it('non-empty diff = unsynced', async () => {
    expect(await sandboxHasUnsynced(base({ runner: runnerWith({ ok: true, diff: 'diff --git', ref: 'r' }) }), target('claude'))).toBe(true);
  });
  it('unreadable sandbox fails closed', async () => {
    expect(await sandboxHasUnsynced(base({ runner: runnerWith({ ok: false, reason: 'x' }) }), target('claude'))).toBe(true);
  });
  it('no branch fails closed, even when a runner could answer', async () => {
    const diff = vi.fn(async () => ({ ok: true, diff: '', ref: 'r' }));
    expect(await sandboxHasUnsynced(base({ runner: { diff } as unknown as SessionRunner }), target('claude', null))).toBe(true);
    expect(diff).not.toHaveBeenCalled();
  });
  it('no worktree fails closed', async () => {
    const t = { ...target('claude'), worktree: undefined } as unknown as SandboxSyncTarget;
    expect(await sandboxHasUnsynced(base({ runner: runnerWith({ ok: true, diff: '', ref: 'r' }) }), t)).toBe(true);
  });
  it('a runner that cannot diff fails closed', async () => {
    expect(await sandboxHasUnsynced(base({ runner: {} as unknown as SessionRunner }), target('claude'))).toBe(true);
  });
  it('a failed diff fails closed even with an empty body', async () => {
    expect(await sandboxHasUnsynced(base({ runner: runnerWith({ ok: false, diff: '' }) }), target('claude'))).toBe(true);
  });
  it('asks the runner about the host worktree and branch', async () => {
    const diff = vi.fn(async () => ({ ok: true, diff: '', ref: 'r' }));
    await sandboxHasUnsynced(base({ runner: { diff } as unknown as SessionRunner }), target('claude'));
    expect(diff).toHaveBeenCalledWith({ hostWorktreePath: '/wt', branch: 'feat/x' });
  });
});

describe('recreateSandboxNoSync', () => {
  it('removes without sync, then reopens', async () => {
    const remove = vi.fn(async () => true);
    const deps = base({ remove });
    await recreateSandboxNoSync(deps, target('claude'));
    expect(remove).toHaveBeenCalledWith(deps, expect.anything(), { skipSync: true });
    expect(deps.reopen).toHaveBeenCalledWith(7);
  });
  it('throws when the remove is refused and never reopens', async () => {
    const deps = base({ remove: vi.fn(async () => false) });
    await expect(recreateSandboxNoSync(deps, target('claude'))).rejects.toThrow(/could not be removed/);
    expect(deps.reopen).not.toHaveBeenCalled();
  });
  it('host ticket is a no-op', async () => {
    const remove = vi.fn(async () => true);
    const deps = base({ remove });
    await recreateSandboxNoSync(deps, target(null));
    expect(remove).not.toHaveBeenCalled();
    expect(deps.reopen).not.toHaveBeenCalled();
  });
});

describe('rebase reads the recorded placement first (D826)', () => {
  const ssh = () => fakeSshPlacement(7, 'claude');
  const host = { backend: 'host' as const, core: 'claude', sandboxName: null, reason: null };
  it('an ssh placement takes the sandbox path even with no core', async () => {
    expect(await sandboxHasUnsynced(base({ placementOf: ssh, runner: runnerWith({ ok: true, diff: 'x' }) }), target(null))).toBe(true);
    const remove = vi.fn(async () => true);
    const deps = base({ placementOf: ssh, remove });
    await recreateSandboxNoSync(deps, target(null));
    expect(remove).toHaveBeenCalledTimes(1);
    expect(deps.reopen).toHaveBeenCalledWith(7);
  });
  it('a recorded host placement runs on the host even with a sandbox core', async () => {
    const remove = vi.fn(async () => true);
    const diff = vi.fn();
    expect(await sandboxHasUnsynced(base({ placementOf: () => host, runner: { diff } as unknown as SessionRunner }), target('claude'))).toBe(false);
    expect(diff).not.toHaveBeenCalled();
    await recreateSandboxNoSync(base({ placementOf: () => host, remove }), target('claude'));
    expect(remove).not.toHaveBeenCalled();
  });
  it('the diff of an ssh ticket goes over ssh; an unconfirmed remote fails closed with no ssh call', async () => {
    const proc = fakeSshProcess();
    const deps = base({ placementOf: ssh, worktreeOf: () => '/wt', sshRunner: fakeSshRunnerDeps(proc, { remotes: () => ({}) }) });
    expect(await sandboxHasUnsynced(deps, target('claude'))).toBe(true);
    expect(proc.calls).toEqual([]);
  });
});
