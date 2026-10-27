import { readClonedWorktree } from '../../agent/clonedWorktree.js';
import { hostHeadFileFor, readHostHead, recordHostHead } from '../../agent/hostHead.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sbxName } from '../../agent/sbx/sbxName.js';
import { sbxCloneDir } from '../../agent/sbx/sbxClone.js';
import { describe, expect, it, vi } from 'vitest';
import { fakeDockerProcess } from '../../agent/docker/fakeDockerProcess.js';
import { fakeSbxProcess } from '../../agent/sbx/fakeSbxProcess.js';
import { HOST_SESSION_RUNNER } from '../../agent/sessionRunner.js';
import { resolveLaunchBackend, backendSessionOptions, disposeSandboxOp, ensureSandboxInSync, ensureSandboxSynced, stashSandboxAndUpdate, syncSandboxOp } from './sandboxSyncOps.js';

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
  it('logs the host decision through onBackend and defaults a missing count to single-repo', async () => {
    const info = vi.fn();
    const multi = backendSessionOptions({ backends: { claude: 'sbx' }, core: 'claude', projectRoot: '/p', ticketId: 7, ticketLabel: 'K-7', info, worktreeCount: 2 });
    multi.onBackend!('host (multi-repo ticket: no sandbox in v1)');
    expect(info).toHaveBeenCalledWith('[session] ticket K-7 backend: host (multi-repo ticket: no sandbox in v1)');
    const resolve = vi.fn(async () => ({ runner: { kind: 'sbx' }, line: 'sbx (x)' }) as never);
    await backendSessionOptions({ backends: { claude: 'sbx' }, core: 'claude', projectRoot: '/p', ticketId: 7, ticketLabel: 'K-7', info: vi.fn(), resolve }).resolveRunner!();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('a host-backend core with several repos is untouched by the guard (it is host already)', async () => {
    const resolve = vi.fn(async () => ({ runner: { kind: 'host' }, line: 'host (agentBackends.claude: host)' }) as never);
    const out = await backendSessionOptions({ backends: { claude: 'host' }, core: 'claude', projectRoot: '/p', ticketId: 7, ticketLabel: 'K-7', info: vi.fn(), resolve, worktreeCount: 3 }).resolveRunner!();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(out.line).toBe('host (agentBackends.claude: host)');
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

  it('sets both backendCoreKey and core in backends for resolveRunner when antigravity has host opt-out', async () => {
    const resolve = vi.fn().mockResolvedValue(onHost('agentBackends.agy: host'));
    const opts = backendSessionOptions({
      ...base,
      core: 'antigravity',
      backends: { agy: 'docker' },
      ticketOverride: 'host',
      resolve,
      warn: vi.fn(),
    });
    await opts.resolveRunner!();
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      backends: expect.objectContaining({ agy: 'host', antigravity: 'host' }),
    }));
  });

  it('adds nothing when neither project nor ticket picks a backend', () => {
    expect(backendSessionOptions({ ...base, backends: undefined, ticketOverride: 'host' })).toEqual({});
  });
});

describe('backendSessionOptions bridgeFor', () => {
  it('passes bridgeFor through only with a backend and forwards bridgeDir to resolve', async () => {
    const bridgeFor = vi.fn().mockResolvedValue({ dir: '/g/bridge/7' });
    const resolve = vi.fn().mockResolvedValue({ runner: HOST_SESSION_RUNNER, line: 'host (done)' });
    const base = { core: 'claude', projectRoot: '/p', ticketId: 7, ticketLabel: 'K-7', info: vi.fn(), bridgeFor, resolve };
    const opts = backendSessionOptions({ ...base, backends: { claude: 'sbx', codex: 'sbx' } });
    expect(opts.bridgeFor).toBe(bridgeFor);
    await opts.resolveRunner!();
    expect(bridgeFor).toHaveBeenCalledWith(7);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ bridgeDir: '/g/bridge/7' }));
    expect(backendSessionOptions({ ...base, backends: undefined })).toEqual({});
  });
});

const LISTED = { 'sbx ls': { stdout: `NAME\n${sbxName({ projectRoot: '/p', ticketId: 7, core: 'claude' })}` } };

describe('probeOf', () => {
  it('falls back to hasSandbox when the runner has no tri-state probe', async () => {
    const { probeOf } = await import('./sandboxSyncOps.js');
    await expect(probeOf({ hasSandbox: async () => true } as never)).resolves.toEqual({ state: 'present' });
    await expect(probeOf({ hasSandbox: async () => false } as never)).resolves.toEqual({ state: 'absent' });
    await expect(probeOf({} as never)).resolves.toEqual({ state: 'absent' });
  });
});

describe('syncSandboxOp', () => {
  const target = { ticketId: 7, ticketLabel: 'K-7', core: 'claude', worktree: { path: '/wt/a', branch: 'feat/x' } };

  it('fast-forwards and reports success', async () => {
    const r = recorder();
    const proc = fakeSbxProcess(LISTED);
    await expect(syncSandboxOp({ notify: r.notify, projectRoot: '/p', proc }, target)).resolves.toBe(true);
    expect(r.infos).toEqual([expect.stringMatching(/^Karst: K-7 fast-forwarded feat\/x to the sbx sandbox's commits\.$/)]);
    expect(r.errors).toEqual([]);
  });

  it('reports a refused sync', async () => {
    const r = recorder();
    const proc = fakeSbxProcess({ ...LISTED, 'git -C /wt/a merge-base': { code: 1 } });
    await expect(syncSandboxOp({ notify: r.notify, projectRoot: '/p', proc }, target)).resolves.toBe(false);
    expect(r.errors).toEqual([expect.stringMatching(/^Karst: sandbox sync for K-7 failed: refused: .*never forced/)]);
    expect(r.infos).toEqual([]);
  });

  it('refuses a ticket without a worktree or an sbx core, running nothing', async () => {
    const r = recorder();
    const proc = fakeSbxProcess();
    await expect(syncSandboxOp({ notify: r.notify, projectRoot: '/p', proc }, { ...target, worktree: undefined })).resolves.toBe(false);
    await expect(syncSandboxOp({ notify: r.notify, projectRoot: '/p', proc }, { ...target, worktree: { path: '/wt/a', branch: null } })).resolves.toBe(false);
    await expect(syncSandboxOp({ notify: r.notify, projectRoot: '/p', proc }, { ...target, core: 'gemini' })).resolves.toBe(false);
    await expect(syncSandboxOp({ notify: r.notify, projectRoot: '/p', proc }, { ...target, core: null })).resolves.toBe(false);
    expect(r.errors).toEqual([
      'Karst: K-7 has no worktree branch to sync into.',
      'Karst: K-7 has no worktree branch to sync into.',
      'Karst: K-7 has no sandbox (core gemini).',
      'Karst: K-7 has no sandbox (core unknown).',
    ]);
    expect(proc.calls).toEqual([]);
  });

  it('an sbx CLI that cannot run blocks the manual sync with the reason, syncing nothing', async () => {
    const r = recorder();
    const proc = fakeSbxProcess({ 'sbx ls': { code: 127, stderr: 'spawn sbx ENOENT' } });
    await expect(syncSandboxOp({ notify: r.notify, projectRoot: '/p', proc }, target)).resolves.toBe(false);
    expect(r.errors).toEqual([expect.stringContaining('sbx CLI not runnable from the extension host')]);
    expect(proc.calls.some((c) => c.args.includes('karst-bundle'))).toBe(false);
  });

  it('a listed-absent sandbox has nothing to sync manually', async () => {
    const r = recorder();
    await expect(syncSandboxOp({ notify: r.notify, projectRoot: '/p', proc: fakeSbxProcess({ 'sbx ls': { stdout: 'NAME' } }) }, target)).resolves.toBe(false);
    expect(r.errors).toEqual(['Karst: K-7 has no sandbox to sync.']);
  });

  it.each(['opencode', 'opencode2'])('syncs a %s ticket from its docker clone', async (core) => {
    const r = recorder();
    const dockerProc = fakeDockerProcess();
    const temp = { make: () => Promise.resolve('/tmp/k1'), remove: () => Promise.resolve() };
    await expect(syncSandboxOp({ notify: r.notify, projectRoot: '/p', dockerProc, temp, platform: 'darwin' }, { ...target, core })).resolves.toBe(true);
    expect(r.infos).toEqual(["Karst: K-7 fast-forwarded feat/x to the docker sandbox's commits."]);
    const bundle = dockerProc.calls[1]!;
    expect(bundle.command).toBe('docker');
    expect(bundle.args.some((a) => new RegExp(`^type=volume,source=karst-[0-9a-f]{8}-7-${core}-repo,target=/work,readonly$`).test(a))).toBe(true);
    expect(bundle.args.join(' ')).not.toContain('--user');
  });

  it('runs the docker sync helpers as the host uid on linux', async () => {
    const dockerProc = fakeDockerProcess();
    const temp = { make: () => Promise.resolve('/tmp/k1'), remove: () => Promise.resolve() };
    await syncSandboxOp({ notify: recorder().notify, projectRoot: '/p', dockerProc, temp, platform: 'linux' }, { ...target, core: 'opencode' });
    expect(dockerProc.calls[1]!.args).toContain('--user');
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
    const proc = fakeSbxProcess(LISTED);
    await expect(ensureSandboxSynced({ notify: recorder().notify, projectRoot: '/p', proc }, target)).resolves.toEqual({ ok: true });
    expect(proc.calls.length).toBeGreaterThan(0);
  });

  it('a host ticket (no sandbox core) runs nothing', async () => {
    const proc = fakeSbxProcess(LISTED);
    await expect(ensureSandboxSynced({ notify: recorder().notify, projectRoot: '/p', proc }, { ...target, core: 'antigravity' })).resolves.toEqual({ ok: true });
    await expect(ensureSandboxSynced({ notify: recorder().notify, projectRoot: '/p', proc }, { ...target, core: null })).resolves.toEqual({ ok: true });
    expect(proc.calls).toEqual([]);
  });

  it('a non-fast-forward is reported as diverged, never forced', async () => {
    const proc = fakeSbxProcess({ ...LISTED, 'git -C /wt/a merge-base': { code: 1 } });
    const r = await ensureSandboxSynced({ notify: recorder().notify, projectRoot: '/p', proc }, target);
    expect(r).toMatchObject({ ok: false, diverged: true, reason: expect.stringContaining('not a fast-forward') });
  });

  describe('host head record and rewrite classification (arch:AC-33)', () => {
    const OLD = 'a'.repeat(40); const CLONE = 'b'.repeat(40); const HOST = 'c'.repeat(40);
    const bridge = () => join(mkdtempSync(join(tmpdir(), 'karst-hh-')), 'events', '7');
    const answers = (refused: boolean) => ({
      'git -C /wt/a rev-parse HEAD': { stdout: `${HOST}\n` },
      'git -C /wt/a rev-parse --verify --quiet HEAD': { stdout: `${HOST}\n` },
      'git -C /wt/a rev-parse --verify --quiet FETCH_HEAD': { stdout: `${CLONE}\n` },
      'git -C /wt/a merge-base --is-ancestor HEAD FETCH_HEAD': { code: refused ? 1 : 0 },
      'git -C /wt/a merge-base --is-ancestor FETCH_HEAD HEAD': { code: refused ? 1 : 0 }, // refused = diverged: neither is an ancestor
      [`git -C /wt/a merge-base --is-ancestor ${OLD} ${CLONE}`]: { code: 0 },
      [`git -C /wt/a merge-base --is-ancestor ${OLD} ${HOST}`]: { code: 1 },
    });

    it('records the host head after a good sync, and not after a refused one', async () => {
      const dir = bridge();
      const ok = await ensureSandboxSynced({ notify: recorder().notify, projectRoot: '/p', proc: fakeSbxProcess({ ...LISTED, ...answers(false) }), evidenceDirOf: () => dir }, target);
      expect(ok).toEqual({ ok: true });
      expect(await readHostHead(hostHeadFileFor(dir), '/wt/a')).toBe(HOST);
      const other = bridge();
      await ensureSandboxSynced({ notify: recorder().notify, projectRoot: '/p', proc: fakeSbxProcess({ ...LISTED, ...answers(true) }), evidenceDirOf: () => other }, target);
      expect(await readHostHead(hostHeadFileFor(other), '/wt/a')).toBeUndefined();
    });

    it('classifies a refusal as rewritten when the recorded head is in the clone but not the host, and says so', async () => {
      const dir = bridge();
      await recordHostHead(hostHeadFileFor(dir), '/wt/a', OLD);
      const flags: boolean[] = [];
      const r = await ensureSandboxSynced({ notify: recorder().notify, projectRoot: '/p', proc: fakeSbxProcess({ ...LISTED, ...answers(true) }), evidenceDirOf: () => dir, onRewritten: (_id, v) => flags.push(v) }, target);
      expect(r).toMatchObject({ ok: false, diverged: true, rewritten: true });
      expect(flags).toEqual([true]);
    });

    it('with no record and no reflog it stays plain divergence', async () => {
      const flags: boolean[] = [];
      const r = await ensureSandboxSynced({ notify: recorder().notify, projectRoot: '/p', proc: fakeSbxProcess({ ...LISTED, ...answers(true) }), evidenceDirOf: () => bridge(), onRewritten: (_id, v) => flags.push(v) }, target);
      expect(r).toMatchObject({ ok: false, diverged: true });
      expect(r).not.toHaveProperty('rewritten');
      expect(flags).toEqual([false]);
    });

    it('the manual sync says how to carry a rewritten branch, and a later good sync clears the flag', async () => {
      const dir = bridge();
      await recordHostHead(hostHeadFileFor(dir), '/wt/a', OLD);
      const rec = recorder(); const flags: boolean[] = [];
      await syncSandboxOp({ notify: rec.notify, projectRoot: '/p', proc: fakeSbxProcess({ ...LISTED, ...answers(true) }), evidenceDirOf: () => dir, onRewritten: (_id, v) => flags.push(v) }, target);
      expect(rec.errors[0]).toContain('Carry sandbox commits onto host branch');
      await syncSandboxOp({ notify: rec.notify, projectRoot: '/p', proc: fakeSbxProcess({ ...LISTED, ...answers(false) }), evidenceDirOf: () => dir, onRewritten: (_id, v) => flags.push(v) }, target);
      expect(flags).toEqual([true, false]);
    });
  });

  it('a sandbox without a worktree branch is a plain failure', async () => {
    const r = await ensureSandboxSynced({ notify: recorder().notify, projectRoot: '/p', proc: fakeSbxProcess(LISTED) }, { ...target, worktree: undefined });
    expect(r).toMatchObject({ ok: false, diverged: false });
  });

  it('a throwing runner is a transient failure, not an exception', async () => {
    const proc = fakeSbxProcess(LISTED);
    const boom = { ...proc, run: (...a: Parameters<typeof proc.run>) => { if (a[1][0] === 'ls') return proc.run(...a); throw new Error('daemon gone'); } } as unknown as typeof proc;
    const r = await ensureSandboxSynced({ notify: recorder().notify, projectRoot: '/p', proc: boom }, target);
    expect(r).toMatchObject({ ok: false, diverged: false });
  });

  it('sandboxed ticket + sbx exit 127 (ENOENT) is blocked with the reason, never ok (AC-39)', async () => {
    const proc = fakeSbxProcess({ 'sbx ls': { code: 127, stderr: 'spawn sbx ENOENT' } });
    const r = await ensureSandboxSynced({ notify: recorder().notify, projectRoot: '/p', proc }, target);
    expect(r).toEqual({ ok: false, diverged: false, unknown: true, reason: expect.stringMatching(/^sbx CLI not runnable from the extension host: `sbx` was not found on the PATH \(spawn sbx ENOENT\)/) });
    expect(proc.calls.some((c) => c.args.includes('karst-bundle'))).toBe(false);
  });

  it('a signed-out or failing sbx ls (other non-zero exit) is unknown too', async () => {
    const proc = fakeSbxProcess({ 'sbx ls': { code: 1, stderr: 'not signed in' } });
    const r = await ensureSandboxSynced({ notify: recorder().notify, projectRoot: '/p', proc }, target);
    expect(r).toMatchObject({ ok: false, unknown: true, reason: expect.stringContaining('not signed in') });
  });

  it('a probe that throws is unknown, not absent', async () => {
    const boom = { run: () => Promise.reject(new Error('EPERM')) } as never;
    const r = await ensureSandboxSynced({ notify: recorder().notify, projectRoot: '/p', proc: boom }, target);
    expect(r).toMatchObject({ ok: false, unknown: true, reason: expect.stringContaining('EPERM') });
  });

  it('docker core: no such volume is a host ticket; a missing CLI or down daemon is blocked', async () => {
    const dt = { ...target, core: 'opencode2' };
    const run = (answer: Record<string, { code: number; stderr: string }>) => ensureSandboxSynced({ notify: recorder().notify, projectRoot: '/p', dockerProc: fakeDockerProcess(answer) }, dt);
    await expect(run({ 'docker volume inspect': { code: 1, stderr: 'Error: No such volume: karst-x' } })).resolves.toEqual({ ok: true });
    await expect(run({ 'docker volume inspect': { code: 127, stderr: 'spawn docker ENOENT' } })).resolves.toMatchObject({ ok: false, unknown: true, reason: expect.stringContaining('docker CLI not runnable') });
    await expect(run({ 'docker volume inspect': { code: 1, stderr: 'Cannot connect to the Docker daemon' } })).resolves.toMatchObject({ ok: false, unknown: true });
  });

  it('a sandbox that `ls` does not list is a host ticket even when ls succeeds (D244)', async () => {
    const proc = fakeSbxProcess({ 'sbx ls': { stdout: 'NAME\nother-sandbox' } });
    await expect(ensureSandboxSynced({ notify: recorder().notify, projectRoot: '/p', proc }, target)).resolves.toEqual({ ok: true });
    expect(proc.calls.some((c) => c.args.includes('karst-bundle'))).toBe(false);
  });

  it('serialises concurrent syncs of one ticket', async () => {
    let active = 0; let peak = 0;
    const proc = fakeSbxProcess(LISTED);
    const slow = { ...proc, run: async (...a: Parameters<typeof proc.run>) => { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 3)); active -= 1; return proc.run(...a); } } as typeof proc;
    const deps = { notify: recorder().notify, projectRoot: '/p', proc: slow };
    await Promise.all([ensureSandboxSynced(deps, target), ensureSandboxSynced(deps, target)]);
    expect(peak).toBe(1);
  });
  it('a host ticket (sbx listed it absent) runs no sync and spawns no sbx bundle (D244)', async () => {
    const proc = fakeSbxProcess({ 'sbx ls': { stdout: 'NAME' } });
    await expect(ensureSandboxSynced({ notify: recorder().notify, projectRoot: '/p', proc }, target)).resolves.toEqual({ ok: true });
    expect(proc.calls.some((c) => c.args.includes('karst-bundle'))).toBe(false);
  });

  it('on-disk evidence is no tiebreak: a recorded head with an absent listing is a host ticket', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'karst-hh-')), 'events', '7');
    await recordHostHead(hostHeadFileFor(dir), '/wt/a', 'c'.repeat(40));
    const proc = fakeSbxProcess({ 'sbx ls': { stdout: 'NAME' } });
    await expect(ensureSandboxSynced({ notify: recorder().notify, projectRoot: '/p', proc, evidenceDirOf: () => dir }, target)).resolves.toEqual({ ok: true });
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

  it('records the cloned worktree in the bridge dir; a missing dir only logs (F13)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'karst-launch-'));
    try {
      const runner = { kind: 'docker', enforcesSandbox: true, bridgeRunDir: (p: { runDir: string }) => p.runDir } as never;
      const worktree = { path: '/wt/b', branch: 'k/b' };
      await resolveLaunchBackend({ ...base, worktree, resolve: async () => ({ runner, line: 'docker' }), bridgeFor: async () => ({ dir, runDir: '/r' }) as never });
      expect(readClonedWorktree(dir, [{ path: '/wt/a' }, { path: '/wt/b' }])).toEqual({ path: '/wt/b' });
      const debug = vi.fn();
      await resolveLaunchBackend({ ...base, worktree, debug, resolve: async () => ({ runner, line: 'docker' }), bridgeFor: async () => ({ dir: join(dir, 'missing'), runDir: '/r' }) as never });
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('cloned-worktree record failed'));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('syncs an EXISTING sandbox before the session starts; a blocker stops the launch (F8)', async () => {
    const mk = (has: boolean) => ({ kind: 'docker', enforcesSandbox: true, hasSandbox: async () => has, bridgeRunDir: (p: { runDir: string }) => p.runDir }) as never;
    const syncExisting = vi.fn(async () => ({ ok: true as const }));
    await resolveLaunchBackend({ ...base, resolve: async () => ({ runner: mk(true), line: 'docker' }), syncExisting });
    expect(syncExisting).toHaveBeenCalledTimes(1);
    await resolveLaunchBackend({ ...base, resolve: async () => ({ runner: mk(false), line: 'docker' }), syncExisting });
    expect(syncExisting).toHaveBeenCalledTimes(1);
    const blocked = vi.fn(async () => ({ ok: false as const, reason: 'uncommitted work', diverged: false }));
    await expect(resolveLaunchBackend({ ...base, resolve: async () => ({ runner: mk(true), line: 'docker' }), syncExisting: blocked })).rejects.toThrow(/K-7 sandbox is not in sync.*uncommitted work/);
  });

  it('reports the placement it resolved: sbx / docker with the runner name, host fallback with its reason', async () => {
    const sbx = { kind: 'sbx', enforcesSandbox: true, bridgeRunDir: (p: { runDir: string }) => p.runDir } as never;
    const docker = await resolveLaunchBackend({ ...base, resolve: async () => ({ runner: { kind: 'docker', enforcesSandbox: true } as never, line: 'docker (karst-ab-7-opencode2)' }) });
    expect(docker.placement).toEqual({ backend: 'docker', core: 'opencode2', sandboxName: 'karst-ab-7-opencode2', reason: null });
    const viaSbx = await resolveLaunchBackend({ ...base, backends: { opencode2: 'host' }, core: 'claude', resolve: async () => ({ runner: sbx, line: 'sbx (karst-ab-7-claude)' }) });
    expect(viaSbx.placement).toEqual({ backend: 'sbx', core: 'claude', sandboxName: 'karst-ab-7-claude', reason: null });
    const fell = await resolveLaunchBackend({ ...base, resolve: async () => ({ runner: { kind: 'host', enforcesSandbox: false } as never, line: 'host (docker: not signed in)' }) });
    expect(fell.placement).toEqual({ backend: 'host', core: 'opencode2', sandboxName: null, reason: 'docker: not signed in' });
  });

  it('with no backends configured the launch is recorded as host with no reason', async () => {
    const out = await resolveLaunchBackend({ ...base, backends: undefined });
    expect(out.placement).toEqual({ backend: 'host', core: 'opencode2', sandboxName: null, reason: null });
  });

  it('a host launch never syncs', async () => {
    const syncExisting = vi.fn(async () => ({ ok: true as const }));
    await resolveLaunchBackend({ ...base, resolve: async () => ({ runner: { kind: 'host', enforcesSandbox: false } as never, line: 'host' }), syncExisting });
    expect(syncExisting).not.toHaveBeenCalled();
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

  it('tells the caller which core serves the ticket (or null on a host launch)', async () => {
    const runner = { kind: 'docker', enforcesSandbox: true, bridgeRunDir: (p: { runDir: string }) => p.runDir } as never;
    const remember = vi.fn();
    await resolveLaunchBackend({ ...base, resolve: async () => ({ runner, line: 'docker' }), bridgeFor: async () => paths }, remember);
    expect(remember).toHaveBeenLastCalledWith('opencode2');
    await resolveLaunchBackend({ ...base, resolve: async () => ({ runner: { kind: 'host', enforcesSandbox: false } as never, line: 'host (x)' }) }, remember);
    expect(remember).toHaveBeenLastCalledWith(null);
  });

  it('the bridge is attached once per launch and its run dir is the runner\'s view of it', async () => {
    const runner = { kind: 'docker', enforcesSandbox: true, bridgeRunDir: () => '/karst-bridge/7' } as never;
    const bridgeFor = vi.fn(async () => paths);
    const out = await resolveLaunchBackend({ ...base, resolve: async () => ({ runner, line: 'docker' }), bridgeFor });
    expect(bridgeFor).toHaveBeenCalledWith(7);
    expect(out.runDir).toBe('/karst-bridge/7');
    expect(out.options.bridgeFor).toBe(bridgeFor);
  });

  it('no backends configured: a plain host launch with no resolver', async () => {
    await expect(resolveLaunchBackend({ ...base, backends: undefined })).resolves.toEqual({ options: {}, sandboxed: false, placement: { backend: 'host', core: 'opencode2', sandboxName: null, reason: null } });
  });
});

describe('ensureSandboxInSync (F8/F12: both directions)', () => {
  const target = { ticketId: 7, ticketLabel: 'K-7', core: 'claude', worktree: { path: '/wt/a', branch: 'feat/x' } };
  const LS = { 'sbx ls': { stdout: `NAME\n${sbxName({ projectRoot: '/p', ticketId: 7, core: 'claude' })} running` } };
  const withBridge = (proc: ReturnType<typeof fakeSbxProcess>) => ({ notify: recorder().notify, projectRoot: '/p', proc, evidenceDirOf: () => '/nonexistent-bridge' });

  it('a host ticket runs nothing', async () => {
    const proc = fakeSbxProcess();
    await expect(ensureSandboxInSync(withBridge(proc), { ...target, core: null })).resolves.toEqual({ ok: true });
    expect(proc.calls).toEqual([]);
  });

  it('sandboxed ticket + sbx exit 127 is a blocker, not ok (regression)', async () => {
    const proc = fakeSbxProcess({ 'sbx ls': { code: 127, stderr: 'spawn sbx ENOENT' } });
    const r = await ensureSandboxInSync(withBridge(proc), target);
    expect(r).toMatchObject({ ok: false, unknown: true });
    expect(proc.calls.map((c) => c.args[0])).toEqual(['ls']);
  });

  it('a host ticket in a sandbox-configured project (no listed sandbox) runs no sync', async () => {
    const proc = fakeSbxProcess();
    await expect(ensureSandboxInSync(withBridge(proc), target)).resolves.toEqual({ ok: true });
    expect(proc.calls.map((c) => c.args[0])).toEqual(['ls']);
  });

  it('syncs sandbox → host first and refuses to refresh over a divergence', async () => {
    const proc = fakeSbxProcess({ ...LS, 'git -C /wt/a merge-base': { code: 1 } });
    const r = await ensureSandboxInSync(withBridge(proc), target);
    expect(r).toMatchObject({ ok: false, diverged: true });
    expect(proc.calls.some((c) => c.args.includes('karst-refresh'))).toBe(false);
  });

  it('a refresh failure (no usable bridge dir) is a blocker after a good sync', async () => {
    const r = await ensureSandboxInSync({ notify: recorder().notify, projectRoot: '/p', proc: fakeSbxProcess(LS) }, target);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('bridge') });
  });

  describe('refresh outcomes', () => {
    const bundled = (a: Parameters<typeof fakeSbxProcess>[0] = {}, refresh?: { code: number; stdout?: string }) => {
      const inner = fakeSbxProcess({ ...LS, ...a });
      return {
        calls: inner.calls,
        run: async (c: string, args: readonly string[], o?: Parameters<typeof inner.run>[2]) => {
          const r = await inner.run(c, args, o);
          if (refresh && args.includes('karst-refresh')) return { code: refresh.code, stdout: refresh.stdout ?? '', stderr: '' };
          if (c === 'git' && args.includes('bundle') && r.code === 0) writeFileSync(args[args.indexOf('-q') + 1]!, 'b');
          return r;
        },
      };
    };
    const dep = (proc: ReturnType<typeof bundled>) => ({ notify: recorder().notify, projectRoot: '/p', proc, evidenceDirOf: () => mkdtempSync(join(tmpdir(), 'karst-sync-')) });
    it('a good sync + refresh is ok', async () => {
      await expect(ensureSandboxInSync(dep(bundled()), target)).resolves.toEqual({ ok: true });
    });
    it('a diverged refresh is a diverged blocker; a dirty one is not marked diverged', async () => {
      expect(await ensureSandboxInSync(dep(bundled({}, { code: 4 })), target)).toMatchObject({ ok: false, diverged: true });
      expect(await ensureSandboxInSync(dep(bundled({}, { code: 3, stdout: ' M a' })), target)).toMatchObject({ ok: false, diverged: false, reason: expect.stringContaining('uncommitted work') });
    });
    const BEHIND = { 'git -C /wt/a merge-base --is-ancestor HEAD FETCH_HEAD': { code: 1 }, 'git -C /wt/a merge-base --is-ancestor FETCH_HEAD HEAD': { code: 0 } };
    it('a clone BEHIND the host is not a divergence: no merge, one refresh, ok (D216)', async () => {
      const proc = bundled(BEHIND, { code: 0 });
      await expect(ensureSandboxInSync(dep(proc), target)).resolves.toEqual({ ok: true });
      expect(proc.calls.filter((c) => c.args.includes('karst-refresh'))).toHaveLength(1);
      expect(proc.calls.some((c) => c.args.includes('merge'))).toBe(false);
    });
    it('behind + uncommitted work: refused with the named reason, nothing stashed, not diverged', async () => {
      const proc = bundled(BEHIND, { code: 3, stdout: 'karst-host-ahead 2\n M a\n' });
      const r = await ensureSandboxInSync(dep(proc), target);
      expect(r).toMatchObject({ ok: false, diverged: false, reason: expect.stringContaining('sandbox has uncommitted work and the host is ahead by 2 commit(s)') });
      expect(proc.calls.some((c) => c.args.some((a) => a.includes('stash push')))).toBe(false);
    });
    it('allowDirtyClone: uncommitted work with the host not ahead lets a session open; the host ahead still blocks', async () => {
      const notAhead = { code: 3, stdout: 'karst-host-ahead 0\n M a\n' };
      expect(await ensureSandboxInSync(dep(bundled({}, notAhead)), target)).toMatchObject({ ok: false });
      await expect(ensureSandboxInSync(dep(bundled({}, notAhead)), target, { allowDirtyClone: true })).resolves.toEqual({ ok: true });
      const ahead = bundled(BEHIND, { code: 3, stdout: 'karst-host-ahead 2\n M a\n' });
      expect(await ensureSandboxInSync(dep(ahead), target, { allowDirtyClone: true })).toMatchObject({ ok: false });
    });
    it('Stash and update: stashes in the sandbox, refreshes, returns the stash name', async () => {
      const proc = bundled(BEHIND, { code: 0 });
      const out = await stashSandboxAndUpdate(dep(proc), target, new Date('2026-10-21T10:00:00.000Z'));
      expect(out).toEqual({ ok: true, stash: 'karst: K-7 before host update 2026-10-21T10:00:00.000Z' });
      const call = proc.calls.find((c) => c.args.includes('karst-refresh'))!;
      expect(call.args.join(' ')).toContain('git stash push -u -m "$3"');
      expect(call.args.at(-1)).toBe('karst: K-7 before host update 2026-10-21T10:00:00.000Z');
    });
    it('Stash and update: a failed stash is reported, a host ticket has nothing to update', async () => {
      const failed = await stashSandboxAndUpdate(dep(bundled(BEHIND, { code: 5 })), target);
      expect(failed).toMatchObject({ ok: false, reason: expect.stringContaining('stash failed') });
      const none = await stashSandboxAndUpdate({ notify: recorder().notify, projectRoot: '/p', proc: fakeSbxProcess() }, target);
      expect(none).toMatchObject({ ok: false, reason: expect.stringContaining('no sandbox') });
    });
    it('Stash and update: an sbx CLI that cannot run is named, not "no sandbox"', async () => {
      const proc = fakeSbxProcess({ 'sbx ls': { code: 127, stderr: 'spawn sbx ENOENT' } });
      const r = await stashSandboxAndUpdate({ notify: recorder().notify, projectRoot: '/p', proc }, target);
      expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('sbx CLI not runnable') });
    });
    it('refresh:false stops after the sync', async () => {
      const proc = bundled();
      await expect(ensureSandboxInSync(dep(proc), target, { refresh: false })).resolves.toEqual({ ok: true });
      expect(proc.calls.some((c) => c.args.includes('karst-refresh'))).toBe(false);
    });
    it('runs concurrent calls for one ticket one after the other', async () => {
      const proc = bundled();
      const [a, b] = await Promise.all([ensureSandboxInSync(dep(proc), target), ensureSandboxInSync(dep(proc), target)]);
      expect([a.ok, b.ok]).toEqual([true, true]);
      const kinds = proc.calls.map((c) => (c.args.includes('karst-refresh') ? 'refresh' : c.args[0]));
      expect(kinds.filter((k) => k === 'refresh')).toHaveLength(2);
    });
  });
});
