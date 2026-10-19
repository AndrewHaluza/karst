import { describe, expect, it, vi } from 'vitest';
import { fakeDockerProcess } from '../../agent/docker/fakeDockerProcess.js';
import { fakeSbxProcess } from '../../agent/sbx/fakeSbxProcess.js';
import { HOST_SESSION_RUNNER } from '../../agent/sessionRunner.js';
import { resolveLaunchBackend, backendSessionOptions, disposeSandboxOp, ensureSandboxSynced, syncSandboxOp } from './sandboxSyncOps.js';

function recorder() {
  const infos: string[] = [];
  const errors: string[] = [];
  return {
    infos,
    errors,
    notify: { info: (m: string) => infos.push(m), warn: vi.fn(), error: (m: string) => { errors.push(m); return Promise.resolve(); } },
  };
}

describe('backendSessionOptions multi-repo guard (F4/F13 v1)', () => {
  it.each([['claude', 'sbx'], ['opencode2', 'docker']] as const)('a multi-repo %s ticket resolves to the host without touching a sandbox', async (core, kind) => {
    const resolve = vi.fn();
    const warn = vi.fn();
    const opts = backendSessionOptions({ backends: { [core]: kind }, core, projectRoot: '/p', ticketId: 7, ticketLabel: 'K-7', info: vi.fn(), warn, resolve, worktreeCount: 2 });
    const out = await opts.resolveRunner!();
    expect(out.runner.kind).toBe('host');
    expect(out.line).toContain('multi-repo');
    expect(resolve).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(opts.bridgeFor).toBeUndefined();
  });
  it('a single-repo ticket still resolves normally', async () => {
    const resolve = vi.fn(async () => ({ runner: { kind: 'sbx' }, line: 'sbx (x)' }) as never);
    await backendSessionOptions({ backends: { claude: 'sbx' }, core: 'claude', projectRoot: '/p', ticketId: 7, ticketLabel: 'K-7', info: vi.fn(), resolve, worktreeCount: 1 }).resolveRunner!();
    expect(resolve).toHaveBeenCalled();
  });
});

describe('backendSessionOptions', () => {
  it('adds nothing when agentBackends is absent', () => {
    expect(backendSessionOptions({ backends: undefined, core: 'claude', projectRoot: '/p', ticketId: 7, ticketLabel: 'K-7', info: vi.fn() })).toEqual({});
  });

  it('resolves per launch and logs the backend line', async () => {
    const resolved = { runner: HOST_SESSION_RUNNER, line: 'host (sbx not signed in)' };
    const resolve = vi.fn().mockResolvedValue(resolved);
    const info = vi.fn();
    const opts = backendSessionOptions({ backends: { claude: 'sbx', codex: 'sbx' }, core: 'codex', projectRoot: '/p', ticketId: 7, ticketLabel: 'K-7', info, resolve });
    await expect(opts.resolveRunner!()).resolves.toBe(resolved);
    expect(resolve).toHaveBeenCalledWith({ backends: { claude: 'sbx', codex: 'sbx' }, core: 'codex', projectRoot: '/p', ticketId: 7 });
    opts.onBackend!(resolved.line);
    expect(info).toHaveBeenCalledWith('[session] ticket K-7 backend: host (sbx not signed in)');
  });
});

describe('backendSessionOptions per-ticket opt-out and visible fallback (arch:AC-32)', () => {
  const base = { core: 'claude', projectRoot: '/p', ticketId: 7, ticketLabel: 'K-7', info: vi.fn() };
  const sbxOk = { runner: { ...HOST_SESSION_RUNNER, kind: 'sbx' as const }, line: 'sbx (n)' };
  const onHost = (reason: string) => ({ runner: HOST_SESSION_RUNNER, line: `host (${reason})` });

  it('a ticket host opt-out resolves with backend host, even for a sandbox project', async () => {
    const resolve = vi.fn().mockResolvedValue(onHost('agentBackends.claude: host'));
    const opts = backendSessionOptions({ ...base, backends: { claude: 'sbx', codex: 'sbx' }, ticketOverride: 'host', resolve, warn: vi.fn() });
    await opts.resolveRunner!();
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ backends: { claude: 'host', codex: 'sbx' } }));
  });

  it('a null override follows the project', async () => {
    const resolve = vi.fn().mockResolvedValue(sbxOk);
    await backendSessionOptions({ ...base, core: 'opencode', backends: { opencode: 'docker', opencode2: 'docker' }, ticketOverride: null, resolve, warn: vi.fn() }).resolveRunner!();
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ backends: { opencode: 'docker', opencode2: 'docker' } }));
  });

  it('warns "running prompted on host: <reason>" when a chosen sandbox backend is unavailable', async () => {
    const warn = vi.fn();
    const resolve = vi.fn().mockResolvedValue(onHost('sbx not signed in (run `sbx login`)'));
    await backendSessionOptions({ ...base, backends: { claude: 'sbx', codex: 'sbx' }, resolve, warn }).resolveRunner!();
    expect(warn).toHaveBeenCalledWith('Karst: K-7 running prompted on host: sbx not signed in (run `sbx login`)');
  });

  it('says nothing when the sandbox started, when the project is host, or after an explicit opt-out', async () => {
    const warn = vi.fn();
    await backendSessionOptions({ ...base, backends: { claude: 'sbx', codex: 'sbx' }, resolve: vi.fn().mockResolvedValue(sbxOk), warn }).resolveRunner!();
    await backendSessionOptions({ ...base, backends: {}, resolve: vi.fn().mockResolvedValue(onHost('agentBackends.claude: host')), warn }).resolveRunner!();
    await backendSessionOptions({ ...base, backends: { claude: 'sbx', codex: 'sbx' }, ticketOverride: 'host', resolve: vi.fn().mockResolvedValue(onHost('agentBackends.claude: host')), warn }).resolveRunner!();
    expect(warn).not.toHaveBeenCalled();
  });

  it('adds nothing when neither project nor ticket picks a backend', () => {
    expect(backendSessionOptions({ ...base, backends: undefined, ticketOverride: 'host' })).toEqual({});
  });
});

describe('backendSessionOptions bridgeFor', () => {
  it('passes bridgeFor through only with a backend', () => {
    const bridgeFor = vi.fn();
    const base = { core: 'claude', projectRoot: '/p', ticketId: 7, ticketLabel: 'K-7', info: vi.fn(), bridgeFor };
    expect(backendSessionOptions({ ...base, backends: { claude: 'sbx', codex: 'sbx' } }).bridgeFor).toBe(bridgeFor);
    expect(backendSessionOptions({ ...base, backends: undefined })).toEqual({});
  });
});

describe('syncSandboxOp', () => {
  const target = { ticketId: 7, ticketLabel: 'K-7', core: 'claude', worktree: { path: '/wt/a', branch: 'feat/x' } };

  it('fast-forwards and reports success', async () => {
    const r = recorder();
    const proc = fakeSbxProcess();
    await expect(syncSandboxOp({ notify: r.notify, projectRoot: '/p', proc }, target)).resolves.toBe(true);
    expect(r.infos).toEqual([expect.stringMatching(/^Karst: K-7 fast-forwarded feat\/x to the sbx sandbox's commits\.$/)]);
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
    const opts = backendSessionOptions({ backends: { opencode: 'docker', opencode2: 'docker' }, core: 'opencode', projectRoot: '/p', ticketId: 7, ticketLabel: 'K-7', info: vi.fn(), worktree: { path: '/wt', branch: 'b' }, debug, resolve });
    await opts.resolveRunner!();
    expect(resolve).toHaveBeenCalledWith({ backends: { opencode: 'docker', opencode2: 'docker' }, core: 'opencode', projectRoot: '/p', ticketId: 7, worktree: { hostWorktreePath: '/wt', branch: 'b' }, docker: { debug } });
    const bare = backendSessionOptions({ backends: { opencode: 'docker', opencode2: 'docker' }, core: 'opencode', projectRoot: '/p', ticketId: 7, ticketLabel: 'K-7', info: vi.fn(), worktree: { path: '/wt', branch: null }, resolve });
    await bare.resolveRunner!();
    expect(resolve).toHaveBeenLastCalledWith({ backends: { opencode: 'docker', opencode2: 'docker' }, core: 'opencode', projectRoot: '/p', ticketId: 7 });
  });
});

describe('disposeSandboxOp', () => {
  const target = { ticketId: 7, ticketLabel: 'K-7', core: 'claude', worktree: { path: '/wt/a', branch: 'feat/x' } };

  it('removes the sandbox, THEN the ticket bridge, and reports it', async () => {
    const r = recorder();
    const order: string[] = [];
    const proc = fakeSbxProcess();
    const run = proc.run;
    const traced = { ...proc, run: (c: string, a: readonly string[], o?: never) => { order.push(`${c} ${a[0]}`); return run(c, a, o); } };
    const bridges = { dispose: vi.fn(async (id: number) => { order.push(`bridge ${id}`); }) };
    await expect(disposeSandboxOp({ notify: r.notify, projectRoot: '/p', proc: traced, bridges }, target)).resolves.toBe(true);
    expect(order.at(-1)).toBe('bridge 7');
    expect(order).toContain('sbx rm');
    expect(proc.calls.some((c) => c.args.join(' ').includes('-C /wt/a remote remove'))).toBe(true);
    expect(r.infos).toEqual(['Karst: K-7 sandbox removed.']);
    expect(r.errors).toEqual([]);
  });

  it('keeps the bridge dir when the sandbox removal fails, and reports it', async () => {
    const r = recorder();
    const proc = { run: () => Promise.reject(new Error('sbx gone')) };
    const bridges = { dispose: vi.fn(async () => {}) };
    await expect(disposeSandboxOp({ notify: r.notify, projectRoot: '/p', proc, bridges }, target)).resolves.toBe(false);
    expect(bridges.dispose).not.toHaveBeenCalled();
    expect(r.errors).toEqual(['Karst: removing the sandbox for K-7 failed: sbx gone']);
    const r2 = recorder();
    await disposeSandboxOp({ notify: r2.notify, projectRoot: '/p', proc: { run: () => Promise.reject('x') }, bridges }, target);
    expect(r2.errors).toEqual(['Karst: removing the sandbox for K-7 failed: x']);
  });

  it('a bridge removal failure is reported after the sandbox is gone', async () => {
    const r = recorder();
    const bridges = { dispose: vi.fn(async () => { throw new Error('EBUSY'); }) };
    await expect(disposeSandboxOp({ notify: r.notify, projectRoot: '/p', proc: fakeSbxProcess(), bridges }, target)).resolves.toBe(false);
    expect(r.errors).toEqual(['Karst: K-7 sandbox removed, but its evidence dir was not: EBUSY']);
  });

  it('reports when the bridge registry is not ready, touching nothing', async () => {
    const r = recorder();
    const proc = fakeSbxProcess();
    await expect(disposeSandboxOp({ notify: r.notify, projectRoot: '/p', proc, bridges: undefined }, target)).resolves.toBe(false);
    expect(proc.calls).toEqual([]);
    expect(r.errors).toEqual(['Karst: cannot remove the sandbox for K-7 yet: the hook endpoint is still starting. Try again.']);
  });

  it('refuses a ticket without a worktree or a sandbox core, touching nothing', async () => {
    const r = recorder();
    const bridges = { dispose: vi.fn(async () => {}) };
    await expect(disposeSandboxOp({ notify: r.notify, projectRoot: '/p', proc: fakeSbxProcess(), bridges }, { ...target, worktree: undefined })).resolves.toBe(false);
    await expect(disposeSandboxOp({ notify: r.notify, projectRoot: '/p', proc: fakeSbxProcess(), bridges }, { ...target, core: 'gemini' })).resolves.toBe(false);
    expect(bridges.dispose).not.toHaveBeenCalled();
    await disposeSandboxOp({ notify: r.notify, projectRoot: '/p', proc: fakeSbxProcess(), bridges }, { ...target, core: null });
    expect(r.errors).toEqual(['Karst: K-7 has no worktree branch.', 'Karst: K-7 has no sandbox (core gemini).', 'Karst: K-7 has no sandbox (core unknown).']);
  });
});

describe('backendSessionOptions: baseline host ports (arch:AC-32)', () => {
  it('hands the docker resolver the baseline ports, alone or with debug', async () => {
    const resolve = vi.fn().mockResolvedValue({ runner: HOST_SESSION_RUNNER, line: 'x' });
    const base = { backends: { opencode: 'docker', opencode2: 'docker' } as const, core: 'opencode', projectRoot: '/p', ticketId: 7, ticketLabel: 'K-7', info: vi.fn(), resolve };
    await backendSessionOptions({ ...base, hostPorts: [5432] }).resolveRunner!();
    expect(resolve.mock.calls[0]![0].docker).toEqual({ hostPorts: [5432] });
    const debug = vi.fn();
    await backendSessionOptions({ ...base, hostPorts: [5432], debug }).resolveRunner!();
    expect(resolve.mock.calls[1]![0].docker).toEqual({ hostPorts: [5432], debug });
    await backendSessionOptions({ ...base, debug }).resolveRunner!();
    expect(resolve.mock.calls[2]![0].docker).toEqual({ debug });
    await backendSessionOptions(base).resolveRunner!();
    expect(resolve.mock.calls[3]![0]).not.toHaveProperty('docker');
  });
});

describe('ensureSandboxSynced (arch:AC-32 choke point)', () => {
  const target = { ticketId: 7, ticketLabel: 'K-7', core: 'claude', worktree: { path: '/wt/a', branch: 'feat/x' } };

  it('fast-forwards a sandboxed ticket', async () => {
    const proc = fakeSbxProcess();
    await expect(ensureSandboxSynced({ notify: recorder().notify, projectRoot: '/p', proc }, target)).resolves.toEqual({ ok: true });
    expect(proc.calls.length).toBeGreaterThan(0);
  });

  it('a host ticket (no sandbox core) runs nothing', async () => {
    const proc = fakeSbxProcess();
    await expect(ensureSandboxSynced({ notify: recorder().notify, projectRoot: '/p', proc }, { ...target, core: 'antigravity' })).resolves.toEqual({ ok: true });
    await expect(ensureSandboxSynced({ notify: recorder().notify, projectRoot: '/p', proc }, { ...target, core: null })).resolves.toEqual({ ok: true });
    expect(proc.calls).toEqual([]);
  });

  it('a non-fast-forward is reported as diverged, never forced', async () => {
    const proc = fakeSbxProcess({ 'git -C /wt/a merge-base': { code: 1 } });
    const r = await ensureSandboxSynced({ notify: recorder().notify, projectRoot: '/p', proc }, target);
    expect(r).toMatchObject({ ok: false, diverged: true, reason: expect.stringContaining('not a fast-forward') });
  });

  it('a sandbox without a worktree branch is a plain failure', async () => {
    const r = await ensureSandboxSynced({ notify: recorder().notify, projectRoot: '/p', proc: fakeSbxProcess() }, { ...target, worktree: undefined });
    expect(r).toMatchObject({ ok: false, diverged: false });
  });

  it('a throwing runner is a transient failure, not an exception', async () => {
    const proc = fakeSbxProcess();
    const boom = { ...proc, run: () => { throw new Error('daemon gone'); } } as unknown as typeof proc;
    const r = await ensureSandboxSynced({ notify: recorder().notify, projectRoot: '/p', proc: boom }, target);
    expect(r).toMatchObject({ ok: false, diverged: false });
  });

  it('serialises concurrent syncs of one ticket', async () => {
    let active = 0; let peak = 0;
    const proc = fakeSbxProcess();
    const slow = { ...proc, run: async (...a: Parameters<typeof proc.run>) => { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 3)); active -= 1; return proc.run(...a); } } as typeof proc;
    const deps = { notify: recorder().notify, projectRoot: '/p', proc: slow };
    await Promise.all([ensureSandboxSynced(deps, target), ensureSandboxSynced(deps, target)]);
    expect(peak).toBe(1);
  });
});

describe('resolveLaunchBackend (instructions follow the runner, F1)', () => {
  const base = { backends: { opencode2: 'docker' as const }, core: 'opencode2', projectRoot: '/p', ticketId: 7, ticketLabel: 'K-7', info: vi.fn() };
  const paths = { dir: '/g/events/7', runDir: '/karst-bridge/7' } as never;

  it('a sandbox runner reports the container-visible run dir and is handed over, not resolved twice', async () => {
    const runner = { kind: 'docker', enforcesSandbox: true, bridgeRunDir: (p: { runDir: string }) => p.runDir } as never;
    const resolve = vi.fn(async () => ({ runner, line: 'docker (x)' }));
    const out = await resolveLaunchBackend({ ...base, resolve, bridgeFor: async () => paths });
    expect(out).toMatchObject({ sandboxed: true, runDir: '/karst-bridge/7' });
    await out.options.resolveRunner!();
    await out.options.resolveRunner!();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('a fail-closed fallback is a host launch: host instructions', async () => {
    const resolve = vi.fn(async () => ({ runner: { kind: 'host', enforcesSandbox: false } as never, line: 'host (docker down)' }));
    await expect(resolveLaunchBackend({ ...base, resolve, bridgeFor: async () => paths })).resolves.toMatchObject({ sandboxed: false });
  });

  it('a sandbox without a bridge is sandboxed with no run dir (no marker to promise)', async () => {
    const runner = { kind: 'docker', enforcesSandbox: true, bridgeRunDir: (p: { runDir: string }) => p.runDir } as never;
    const out = await resolveLaunchBackend({ ...base, resolve: async () => ({ runner, line: 'docker' }) });
    expect(out.sandboxed).toBe(true);
    expect(out.runDir).toBeUndefined();
  });

  it('no backends configured: a plain host launch with no resolver', async () => {
    await expect(resolveLaunchBackend({ ...base, backends: undefined })).resolves.toEqual({ options: {}, sandboxed: false });
  });
});
