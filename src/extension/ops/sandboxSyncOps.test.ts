import { describe, expect, it, vi } from 'vitest';
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
    await expect(syncSandboxOp({ notify: r.notify, projectRoot: '/p', proc }, { ...target, core: 'opencode' })).resolves.toBe(false);
    await expect(syncSandboxOp({ notify: r.notify, projectRoot: '/p', proc }, { ...target, core: null })).resolves.toBe(false);
    expect(r.errors).toEqual([
      'Karst: K-7 has no worktree branch to sync into.',
      'Karst: K-7 has no worktree branch to sync into.',
      'Karst: K-7 has no sbx sandbox (core opencode).',
      'Karst: K-7 has no sbx sandbox (core unknown).',
    ]);
    expect(proc.calls).toEqual([]);
  });
});
