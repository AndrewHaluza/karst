import { describe, expect, it, vi } from 'vitest';
import { fakeDockerProcess } from '../../agent/docker/fakeDockerProcess.js';
import { dockerNames } from '../../agent/docker/dockerNames.js';
import { fakeSbxProcess } from '../../agent/sbx/fakeSbxProcess.js';
import { sbxName } from '../../agent/sbx/sbxName.js';
import { startSandboxService } from '../../agent/sandboxServices.js';
import type { Manifest } from '../../manifest/types.js';
import { openStore } from '../../store/db.js';
import {
  reattachTicketSandbox, ticketGateProcess, ticketSandboxContext, ticketSandboxRunner, type TicketSandboxDeps,
} from './sandboxTicketOps.js';

vi.mock('../../workflow/gates/run.js', async (orig) => ({
  ...(await orig<typeof import('../../workflow/gates/run.js')>()),
  runProcess: vi.fn(() => Promise.resolve({ kind: 'completed', exitCode: 0, output: 'host' })),
}));

const SBX = sbxName({ projectRoot: '/p', ticketId: 7, core: 'claude' });
const bridge = { dir: '/g/events/7', runDir: '/karst-bridge/7' } as never;

function deps(over: Partial<TicketSandboxDeps> = {}): TicketSandboxDeps {
  return { backend: () => 'sbx', projectRoot: () => '/p', coreOf: () => 'claude', ...over };
}

describe('ticketSandboxRunner (arch:AC-32)', () => {
  it('sbx hosts claude/codex only; docker hosts opencode/opencode2 only; else undefined', () => {
    expect(ticketSandboxRunner(deps(), 7)).toMatchObject({ sandboxName: SBX, runner: { kind: 'sbx' } });
    expect(ticketSandboxRunner(deps({ coreOf: () => 'codex' }), 7)?.runner.kind).toBe('sbx');
    expect(ticketSandboxRunner(deps({ coreOf: () => 'opencode' }), 7)).toBeUndefined();
    expect(ticketSandboxRunner(deps({ backend: () => 'docker', coreOf: () => 'opencode' }), 7)).toMatchObject({
      sandboxName: dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode' }).container, runner: { kind: 'docker' },
    });
    expect(ticketSandboxRunner(deps({ backend: () => 'docker', coreOf: () => 'claude' }), 7)).toBeUndefined();
    expect(ticketSandboxRunner(deps({ backend: () => 'host' }), 7)).toBeUndefined();
    expect(ticketSandboxRunner(deps({ backend: () => undefined }), 7)).toBeUndefined();
    expect(ticketSandboxRunner(deps({ coreOf: () => null }), 7)).toBeUndefined();
  });

  it('exports the bridge as the gate evidence dir (sbx: host path, docker: mount path)', async () => {
    const { runProcess } = await import('../../workflow/gates/run.js');
    vi.mocked(runProcess).mockClear();
    await ticketSandboxRunner(deps({ bridgeOf: () => bridge, proc: fakeSbxProcess() }), 7)!.runner.runGate!('true', [], '/wt');
    expect(vi.mocked(runProcess).mock.calls[0]![1]).toEqual(['exec', '--env', 'KARST_EVIDENCE_DIR=/g/events/7', SBX, '--', 'true']);
    const proc = fakeDockerProcess({ 'docker container inspect': { stdout: 'true' } });
    await ticketSandboxRunner(deps({ backend: () => 'docker', coreOf: () => 'opencode', bridgeOf: () => bridge, dockerProc: proc, platform: 'linux' }), 7)!
      .runner.runGate!('true', [], '/wt');
    expect(vi.mocked(runProcess).mock.calls[1]![1]).toContain('KARST_EVIDENCE_DIR=/karst-bridge/7');
    vi.mocked(runProcess).mockClear();
    await ticketSandboxRunner(deps({ proc: fakeSbxProcess() }), 7)!.runner.runGate!('true', [], '/wt');
    expect(vi.mocked(runProcess).mock.calls[0]![1]).toEqual(['exec', SBX, '--', 'true']);
  });
});

describe('ticketSandboxContext', () => {
  it('only when the sandbox exists', async () => {
    const live = fakeSbxProcess({ 'sbx ls': { stdout: `SANDBOX\n${SBX}\n` } });
    await expect(ticketSandboxContext(deps({ proc: live }), 7)).resolves.toMatchObject({ sandboxName: SBX });
    await expect(ticketSandboxContext(deps({ proc: fakeSbxProcess() }), 7)).resolves.toBeUndefined();
    await expect(ticketSandboxContext(deps({ backend: () => 'host' }), 7)).resolves.toBeUndefined();
  });
});

describe('ticketGateProcess', () => {
  it('is undefined for a core the backend does not host', () => {
    expect(ticketGateProcess(deps({ coreOf: () => 'agy' }), 7)).toBeUndefined();
  });

  it('runs inside the sandbox when it exists, else on the host', async () => {
    const debug = vi.fn();
    const live = fakeSbxProcess({ 'sbx ls': { stdout: `SANDBOX\n${SBX}\n` }, 'sbx exec': { code: 0 } });
    const inside = ticketGateProcess(deps({ proc: live, debug }), 7)!;
    const { runProcess } = await import('../../workflow/gates/run.js');
    vi.mocked(runProcess).mockClear();
    await inside('npm', ['test'], '/wt');
    expect(vi.mocked(runProcess).mock.calls[0]!.slice(0, 2)).toEqual(['sbx', ['exec', SBX, '--', 'npm', 'test']]);
    expect(debug).toHaveBeenCalledWith(`[gate] ticket 7: npm runs in sbx (${SBX})`);
    vi.mocked(runProcess).mockClear();
    const host = ticketGateProcess(deps({ proc: fakeSbxProcess(), debug }), 7)!;
    await expect(host('npm', ['test'], '/wt')).resolves.toMatchObject({ output: 'host' });
    expect(vi.mocked(runProcess).mock.calls[0]!.slice(0, 2)).toEqual(['npm', ['test']]);
    expect(debug).toHaveBeenCalledWith('[gate] ticket 7: npm runs on the host (no sandbox)');
  });
});

describe('reattachTicketSandbox', () => {
  const manifest = { repositories: { db: { repoPath: '/r/db', service: { start: 'x', ports: [{ name: 'pg', default: 5432 }] } } } } as unknown as Manifest;

  it('is null without a sandbox', async () => {
    const store = openStore(':memory:');
    await expect(reattachTicketSandbox(deps({ proc: fakeSbxProcess() }), store, manifest, 7, () => Promise.resolve(true))).resolves.toBeNull();
  });

  it('allows the baseline ports, then republishes a missing mapping', async () => {
    const store = openStore(':memory:');
    store.db.prepare("INSERT INTO baseline_refs (ticket_id, repo) VALUES (7, 'db')").run();
    const proc = fakeSbxProcess({ 'sbx ls': { stdout: `SANDBOX\n${SBX}\n` }, [`sbx ports ${SBX}`]: { stdout: 'No published ports\n' } });
    const ctx = (await ticketSandboxContext(deps({ proc }), 7))!;
    await startSandboxService({
      store, runner: { ...ctx.runner, runGate: () => Promise.resolve({ kind: 'completed', exitCode: 0, output: '' }) },
      sandboxName: SBX, ticketId: 7, service: 'api', command: 'node', args: [], env: {}, worktree: '/wt', serviceCwd: '/wt',
      port: 4100, healthUrlFor: () => 'u', logPath: '/l', reallocate: () => Promise.resolve(1), waitHealthy: () => Promise.resolve(),
    });
    proc.calls.length = 0;
    const debug = vi.fn();
    await expect(reattachTicketSandbox(deps({ proc, debug }), store, manifest, 7, () => Promise.resolve(true)))
      .resolves.toEqual({ republished: ['api'], dropped: [] });
    const lines = proc.calls.map((c) => [c.command, ...c.args].join(' '));
    expect(lines).toContain(`sbx policy allow network --sandbox ${SBX} host.docker.internal:5432`);
    expect(lines).toContain(`sbx ports ${SBX} --publish 127.0.0.1:4100:4100`);
    expect(debug).toHaveBeenCalledWith('[runtime] ticket 7: sandbox re-verify republished [api], dropped []');
  });

  it('logs a failed baseline allow and still re-verifies', async () => {
    const store = openStore(':memory:');
    store.db.prepare("INSERT INTO baseline_refs (ticket_id, repo) VALUES (7, 'db')").run();
    const proc = fakeSbxProcess({ 'sbx ls': { stdout: `SANDBOX\n${SBX}\n` }, 'sbx policy': { code: 1, stderr: 'nope' } });
    const debug = vi.fn();
    await expect(reattachTicketSandbox(deps({ proc, debug }), store, manifest, 7, () => Promise.resolve(true)))
      .resolves.toEqual({ republished: [], dropped: [] });
    expect(debug).toHaveBeenCalledWith('[runtime] ticket 7: baseline allow failed: sbx policy allow failed: nope');
  });

  it('logs nothing about re-verify when the sandbox cannot list', async () => {
    const store = openStore(':memory:');
    store.db.prepare("INSERT INTO servers (ticket_id, repo, host, port, status, sandbox) VALUES (7, 'api', '127.0.0.1', 4100, 'running', ?)").run(`sbx:${SBX}:4100`);
    const proc = fakeSbxProcess({ 'sbx ls': { stdout: `SANDBOX\n${SBX}\n` }, [`sbx ports ${SBX}`]: { code: 1 } });
    const debug = vi.fn();
    await expect(reattachTicketSandbox(deps({ proc, debug }), store, manifest, 7, () => Promise.resolve(true))).resolves.toBeNull();
    expect(debug).not.toHaveBeenCalled();
  });
});

describe('scheduleSandboxReattach / withSandboxSpin / createTicketSandboxBindings', () => {
  const m = (agentBackend?: string) => ({ repositories: {}, agentBackend }) as unknown as Manifest;

  it('schedules nothing without deps, manifest or a sandbox backend', async () => {
    const { scheduleSandboxReattach } = await import('./sandboxTicketOps.js');
    const store = openStore(':memory:');
    const ok = () => Promise.resolve(true);
    expect(scheduleSandboxReattach(undefined, store, m('sbx'), 7, ok, vi.fn())).toBe(false);
    expect(scheduleSandboxReattach(deps(), store, undefined, 7, ok, vi.fn())).toBe(false);
    expect(scheduleSandboxReattach(deps(), store, m(), 7, ok, vi.fn())).toBe(false);
    expect(scheduleSandboxReattach(deps(), store, m('host'), 7, ok, vi.fn())).toBe(false);
  });

  it('re-verifies after the delay and reports a failure', async () => {
    vi.useFakeTimers();
    try {
      const { scheduleSandboxReattach, SANDBOX_REATTACH_DELAY_MS } = await import('./sandboxTicketOps.js');
      expect(SANDBOX_REATTACH_DELAY_MS).toBe(15_000);
      const store = openStore(':memory:');
      const proc = fakeSbxProcess({ 'sbx ls': { stdout: `SANDBOX\n${SBX}\n` } });
      const onError = vi.fn();
      const broken = { ...deps({ proc }), coreOf: () => { throw new Error('boom'); } };
      expect(scheduleSandboxReattach(broken, store, m('sbx'), 7, () => Promise.resolve(true), onError, 100)).toBe(true);
      await vi.advanceTimersByTimeAsync(99);
      expect(onError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onError).toHaveBeenCalledWith(new Error('boom'));
      proc.calls.length = 0;
      scheduleSandboxReattach(deps({ proc }), store, m('sbx'), 7, () => Promise.resolve(true), onError);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(proc.calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(proc.calls[0]!.args).toEqual(['ls']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('withSandboxSpin adds the sandbox only when it exists', async () => {
    const { withSandboxSpin } = await import('./sandboxTicketOps.js');
    const spin = vi.fn((_s: unknown, _m: unknown, _id: number, _hot: string[], o?: object) => Promise.resolve(o));
    const live = fakeSbxProcess({ 'sbx ls': { stdout: `SANDBOX\n${SBX}\n` } });
    await expect(withSandboxSpin(() => deps({ proc: live }), spin)(1, 2, 7, ['a'], { signal: 's' })).resolves.toMatchObject({ signal: 's', sandbox: { sandboxName: SBX } });
    await expect(withSandboxSpin(() => deps({ proc: fakeSbxProcess() }), spin)(1, 2, 7, ['a'])).resolves.toEqual({});
    await expect(withSandboxSpin(() => undefined, spin)(1, 2, 7, ['a'], { x: 1 })).resolves.toEqual({ x: 1 });
    expect(spin.mock.calls[0]!.slice(0, 4)).toEqual([1, 2, 7, ['a']]);
  });

  it('bindings: bridge paths from the root, baseline host ports, gate runner, reattach', async () => {
    const { createTicketSandboxBindings } = await import('./sandboxTicketOps.js');
    const store = openStore(':memory:');
    store.db.prepare("INSERT INTO baseline_refs (ticket_id, repo) VALUES (7, 'db')").run();
    const manifest = { agentBackend: 'sbx', repositories: { db: { repoPath: '/r/db', service: { start: 'x', ports: [{ name: 'pg', default: 5432 }] } } } } as unknown as Manifest;
    let root: string | undefined;
    const b = createTicketSandboxBindings({ ...deps({ proc: fakeSbxProcess() }), store, manifest: () => manifest, onError: vi.fn(), bridgeRoot: () => root });
    expect(b.deps.bridgeOf!(7)).toBeUndefined();
    root = '/g';
    expect(b.deps.bridgeOf!(7)?.dir).toContain('/g');
    expect(b.hostPorts(7)).toEqual([5432]);
    expect(b.gateProcessFor(7)).toBeTypeOf('function');
    expect(b.reattach(7, 1)).toBe(true);
    const none = createTicketSandboxBindings({ ...deps(), store, manifest: () => undefined, onError: vi.fn(), bridgeRoot: () => undefined });
    expect(none.hostPorts(7)).toEqual([]);
    expect(none.reattach(7)).toBe(false);
  });
});

describe('bindings.stopTicket (review fix)', () => {
  it('stops the sandboxed services inside the sandbox, with the ticket runner', async () => {
    const { createTicketSandboxBindings } = await import('./sandboxTicketOps.js');
    const store = openStore(':memory:');
    store.db.prepare("INSERT INTO servers (ticket_id, repo, host, port, status, cwd, sandbox) VALUES (7, 'api', '127.0.0.1', 4100, 'running', '/wt', ?)").run(`sbx:${SBX}:4100`);
    const proc = fakeSbxProcess();
    const b = createTicketSandboxBindings({ ...deps({ proc }), store, manifest: () => undefined, onError: vi.fn(), bridgeRoot: () => undefined });
    await b.stopTicket(store, 7);
    expect(proc.calls.map((c) => c.args.join(' '))).toContain(`ports ${SBX} --unpublish 127.0.0.1:4100:4100`);
    expect(store.db.prepare('SELECT status FROM servers').get()).toEqual({ status: 'stopped' });
  });
});

describe('bindings.userUat (decisions 7-8)', () => {
  async function make(over: Partial<TicketSandboxDeps> = {}, manifest?: Manifest) {
    const { createTicketSandboxBindings } = await import('./sandboxTicketOps.js');
    const store = openStore(':memory:');
    const b = createTicketSandboxBindings({ ...deps(over), store, manifest: () => manifest, onError: vi.fn(), bridgeRoot: () => undefined });
    return { store, b };
  }

  it('keeps the stack only when a running row is sandboxed and the backend hosts the core', async () => {
    const { store, b } = await make();
    expect(b.userUat.keepStackForUserUat(7)).toBe(false);
    store.db.prepare("INSERT INTO servers (ticket_id, repo, host, port, status) VALUES (7, 'h', '127.0.0.1', 1, 'running')").run();
    expect(b.userUat.keepStackForUserUat(7)).toBe(false);
    store.db.prepare("INSERT INTO servers (ticket_id, repo, host, port, status, sandbox) VALUES (7, 's', '127.0.0.1', 2, 'stopped', ?)").run(`sbx:${SBX}:2`);
    expect(b.userUat.keepStackForUserUat(7)).toBe(false);
    store.db.prepare("UPDATE servers SET status = 'running' WHERE repo = 's'").run();
    expect(b.userUat.keepStackForUserUat(7)).toBe(true);
    expect(b.userUat.keepStackForUserUat(8)).toBe(false);
    const other = await make({ coreOf: () => 'agy' });
    other.store.db.prepare("INSERT INTO servers (ticket_id, repo, host, port, status, sandbox) VALUES (7, 's', '127.0.0.1', 2, 'running', ?)").run(`sbx:${SBX}:2`);
    expect(other.b.userUat.keepStackForUserUat(7)).toBe(false);
  });

  it('withholds the link between start and end, per ticket', async () => {
    const { b } = await make();
    b.userUat.agentUatPhase(7, 'start');
    expect(b.userUatWithheld(7)).toBe(true);
    expect(b.userUatWithheld(8)).toBe(false);
    b.userUat.agentUatPhase(7, 'end');
    expect(b.userUatWithheld(7)).toBe(false);
  });

  it('runs declared resets through the sandbox runner; nothing without manifest or runner', async () => {
    const { runProcess } = await import('../../workflow/gates/run.js');
    const manifest = { repositories: { api: { repoPath: '/r', service: { start: 'x', reset: 'npm run reset', ports: [{ name: 'http', default: 1 }] } } } } as unknown as Manifest;
    const { store, b } = await make({ proc: fakeSbxProcess() }, manifest);
    store.db.prepare("INSERT INTO servers (ticket_id, repo, host, port, status, cwd, sandbox) VALUES (7, 'api', '127.0.0.1', 4100, 'running', '/wt', ?)").run(`sbx:${SBX}:4100`);
    vi.mocked(runProcess).mockClear();
    await expect(b.userUat.prepareUserUat(store, 7)).resolves.toEqual([]);
    expect(vi.mocked(runProcess).mock.calls[0]![1]).toEqual(expect.arrayContaining(['exec', SBX, 'karst-reset', '/wt', 'npm run reset']));
    const noManifest = await make();
    await expect(noManifest.b.userUat.prepareUserUat(store, 7)).resolves.toEqual([]);
    const noRunner = await make({ coreOf: () => null }, manifest);
    await expect(noRunner.b.userUat.prepareUserUat(store, 7)).resolves.toEqual([]);
  });
});

describe('bindings.stopTicket on archive: only this ticket (task 9)', () => {
  it('unpublishes ticket 7 mappings and leaves the bystander ticket 8 running and published', async () => {
    const { createTicketSandboxBindings } = await import('./sandboxTicketOps.js');
    const store = openStore(':memory:');
    const SBX8 = sbxName({ projectRoot: '/p', ticketId: 8, core: 'claude' });
    const ins = store.db.prepare("INSERT INTO servers (ticket_id, repo, host, port, status, cwd, sandbox) VALUES (?, 'api', '127.0.0.1', ?, 'running', '/wt', ?)");
    ins.run(7, 4100, `sbx:${SBX}:4100`);
    ins.run(8, 4200, `sbx:${SBX8}:4200`);
    const proc = fakeSbxProcess();
    const b = createTicketSandboxBindings({ ...deps({ proc }), store, manifest: () => undefined, onError: vi.fn(), bridgeRoot: () => undefined });
    await b.stopTicket(store, 7);
    const lines = proc.calls.map((c) => c.args.join(' '));
    expect(lines).toContain(`ports ${SBX} --unpublish 127.0.0.1:4100:4100`);
    expect(lines.join('\n')).not.toContain(SBX8);
    expect(store.db.prepare('SELECT ticket_id AS t, status FROM servers ORDER BY t').all()).toEqual([{ t: 7, status: 'stopped' }, { t: 8, status: 'running' }]);
  });
});
