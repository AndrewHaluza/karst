import { describe, expect, it, vi } from 'vitest';
import { fakeDockerProcess } from '../../agent/docker/fakeDockerProcess.js';
import { fakeSbxProcess } from '../../agent/sbx/fakeSbxProcess.js';
import { HOST_SESSION_RUNNER } from '../../agent/sessionRunner.js';
import { backendSessionOptions, syncSandboxOp } from './sandboxSyncOps.js';

function recorder() {
  const infos: string[] = [];
  const errors: string[] = [];
  return {
    infos,
    errors,
    notify: { info: (m: string) => infos.push(m), warn: vi.fn(), error: (m: string) => { errors.push(m); return Promise.resolve(); } },
  };
}

describe('backendSessionOptions', () => {
  it('adds nothing when agentBackend is absent', () => {
    expect(backendSessionOptions({ backend: undefined, core: 'claude', projectRoot: '/p', ticketId: 7, ticketLabel: 'K-7', info: vi.fn() })).toEqual({});
  });

  it('resolves per launch and logs the backend line', async () => {
    const resolved = { runner: HOST_SESSION_RUNNER, line: 'host (sbx not signed in)' };
    const resolve = vi.fn().mockResolvedValue(resolved);
    const info = vi.fn();
    const opts = backendSessionOptions({ backend: 'sbx', core: 'codex', projectRoot: '/p', ticketId: 7, ticketLabel: 'K-7', info, resolve });
    await expect(opts.resolveRunner!()).resolves.toBe(resolved);
    expect(resolve).toHaveBeenCalledWith({ backend: 'sbx', core: 'codex', projectRoot: '/p', ticketId: 7 });
    opts.onBackend!(resolved.line);
    expect(info).toHaveBeenCalledWith('[session] ticket K-7 backend: host (sbx not signed in)');
  });
});

describe('syncSandboxOp', () => {
  const target = { ticketId: 7, ticketLabel: 'K-7', core: 'claude', worktree: { path: '/wt/a', branch: 'feat/x' } };

  it('fast-forwards and reports success', async () => {
    const r = recorder();
    const proc = fakeSbxProcess();
    await expect(syncSandboxOp({ notify: r.notify, projectRoot: '/p', proc }, target)).resolves.toBe(true);
    expect(r.infos).toEqual([expect.stringMatching(/^Karst: K-7 fast-forwarded feat\/x to sandbox-karst-[0-9a-f]{8}-7-claude\/feat\/x\.$/)]);
    expect(r.errors).toEqual([]);
  });

  it('reports a refused sync', async () => {
    const r = recorder();
    const proc = fakeSbxProcess({ 'git -C /wt/a merge-base': { code: 1 } });
    await expect(syncSandboxOp({ notify: r.notify, projectRoot: '/p', proc }, target)).resolves.toBe(false);
    expect(r.errors).toEqual([expect.stringMatching(/^Karst: sandbox sync for K-7 failed: refused: .*never forced/)]);
    expect(r.infos).toEqual([]);
  });

  it('refuses a ticket without a worktree or an sbx core, running nothing', async () => {
    const r = recorder();
    const proc = fakeSbxProcess();
    await expect(syncSandboxOp({ notify: r.notify, projectRoot: '/p', proc }, { ...target, worktree: undefined })).resolves.toBe(false);
    await expect(syncSandboxOp({ notify: r.notify, projectRoot: '/p', proc }, { ...target, worktree: { path: '/wt/a', branch: null } })).resolves.toBe(false);
    await expect(syncSandboxOp({ notify: r.notify, projectRoot: '/p', proc }, { ...target, core: 'antigravity' })).resolves.toBe(false);
    await expect(syncSandboxOp({ notify: r.notify, projectRoot: '/p', proc }, { ...target, core: null })).resolves.toBe(false);
    expect(r.errors).toEqual([
      'Karst: K-7 has no worktree branch to sync into.',
      'Karst: K-7 has no worktree branch to sync into.',
      'Karst: K-7 has no sandbox (core antigravity).',
      'Karst: K-7 has no sandbox (core unknown).',
    ]);
    expect(proc.calls).toEqual([]);
  });

  it.each(['opencode', 'opencode2'])('syncs a %s ticket from its docker clone', async (core) => {
    const r = recorder();
    const dockerProc = fakeDockerProcess();
    const temp = { make: () => Promise.resolve('/tmp/k1'), remove: () => Promise.resolve() };
    await expect(syncSandboxOp({ notify: r.notify, projectRoot: '/p', dockerProc, temp, platform: 'darwin' }, { ...target, core })).resolves.toBe(true);
    expect(r.infos).toEqual(["Karst: K-7 fast-forwarded feat/x to the docker sandbox's commits."]);
    const bundle = dockerProc.calls[0]!;
    expect(bundle.command).toBe('docker');
    expect(bundle.args.some((a) => new RegExp(`^type=volume,source=karst-[0-9a-f]{8}-7-${core}-repo,target=/work,readonly$`).test(a))).toBe(true);
    expect(bundle.args.join(' ')).not.toContain('--user');
  });

  it('runs the docker sync helpers as the host uid on linux', async () => {
    const dockerProc = fakeDockerProcess();
    const temp = { make: () => Promise.resolve('/tmp/k1'), remove: () => Promise.resolve() };
    await syncSandboxOp({ notify: recorder().notify, projectRoot: '/p', dockerProc, temp, platform: 'linux' }, { ...target, core: 'opencode' });
    expect(dockerProc.calls[0]!.args).toContain('--user');
  });
});

describe('backendSessionOptions worktree', () => {
  it('passes the worktree branch and debug to the resolver only when present', async () => {
    const resolve = vi.fn().mockResolvedValue({ runner: HOST_SESSION_RUNNER, line: 'x' });
    const debug = vi.fn();
    const opts = backendSessionOptions({ backend: 'docker', core: 'opencode', projectRoot: '/p', ticketId: 7, ticketLabel: 'K-7', info: vi.fn(), worktree: { path: '/wt', branch: 'b' }, debug, resolve });
    await opts.resolveRunner!();
    expect(resolve).toHaveBeenCalledWith({ backend: 'docker', core: 'opencode', projectRoot: '/p', ticketId: 7, worktree: { hostWorktreePath: '/wt', branch: 'b' }, docker: { debug } });
    const bare = backendSessionOptions({ backend: 'docker', core: 'opencode', projectRoot: '/p', ticketId: 7, ticketLabel: 'K-7', info: vi.fn(), worktree: { path: '/wt', branch: null }, resolve });
    await bare.resolveRunner!();
    expect(resolve).toHaveBeenLastCalledWith({ backend: 'docker', core: 'opencode', projectRoot: '/p', ticketId: 7 });
  });
});
