import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fakeDockerProcess } from '../../agent/docker/fakeDockerProcess.js';
import { dockerNames } from '../../agent/docker/dockerNames.js';
import { fakeSbxProcess } from '../../agent/sbx/fakeSbxProcess.js';
import { sbxName } from '../../agent/sbx/sbxName.js';
import { startSandboxService } from '../../agent/sandboxServices.js';
import type { Manifest } from '../../manifest/types.js';
import { openStore } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import {
  reattachTicketSandbox, resolveTicketSandbox, ticketGateProcess, ticketSandboxContext, ticketSandboxRunner, type TicketSandboxDeps,
} from './sandboxTicketOps.js';

vi.mock('../../workflow/gates/run.js', async (orig) => ({
  ...(await orig<typeof import('../../workflow/gates/run.js')>()),
  runProcess: vi.fn(() => Promise.resolve({ kind: 'completed', exitCode: 0, output: 'host' })),
}));

const SBX = sbxName({ projectRoot: '/p', ticketId: 7, core: 'claude' });
const bridge = { dir: '/g/events/7', runDir: '/karst-bridge/7' } as never;

function deps(over: Partial<TicketSandboxDeps> = {}): TicketSandboxDeps {
  return { backends: () => ({ claude: 'sbx', codex: 'sbx' }), projectRoot: () => '/p', coreOf: () => 'claude', ...over };
}

describe('ticketSandboxRunner (arch:AC-32)', () => {
  it('sbx hosts claude/codex only; docker hosts opencode/opencode2 only; else undefined', () => {
    expect(ticketSandboxRunner(deps(), 7)).toMatchObject({ sandboxName: SBX, runner: { kind: 'sbx' } });
    expect(ticketSandboxRunner(deps({ coreOf: () => 'codex' }), 7)?.runner.kind).toBe('sbx');
    expect(ticketSandboxRunner(deps({ coreOf: () => 'opencode' }), 7)).toBeUndefined();
    expect(ticketSandboxRunner(deps({ backends: () => ({ opencode: 'docker', opencode2: 'docker' }), coreOf: () => 'opencode' }), 7)).toMatchObject({
      sandboxName: dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode' }).container, runner: { kind: 'docker' },
    });
    expect(ticketSandboxRunner(deps({ backends: () => ({ opencode: 'docker', opencode2: 'docker' }), coreOf: () => 'claude' }), 7)).toBeUndefined();
    expect(ticketSandboxRunner(deps({ backends: () => ({}) }), 7)).toBeUndefined();
    expect(ticketSandboxRunner(deps({ backends: () => undefined }), 7)).toBeUndefined();
    expect(ticketSandboxRunner(deps({ coreOf: () => null }), 7)).toBeUndefined();
  });

  it('exports the bridge as the gate evidence dir (sbx: host path, docker: mount path)', async () => {
    const { runProcess } = await import('../../workflow/gates/run.js');
    vi.mocked(runProcess).mockClear();
    await ticketSandboxRunner(deps({ bridgeOf: () => bridge, proc: fakeSbxProcess() }), 7)!.runner.runGate!('true', [], '/wt');
    expect(vi.mocked(runProcess).mock.calls[0]![1]).toEqual(['exec', '--env', 'KARST_EVIDENCE_DIR=/g/events/7', SBX, '--', 'true']);
    const proc = fakeDockerProcess({ 'docker container inspect': { stdout: 'true' } });
    await ticketSandboxRunner(deps({ backends: () => ({ opencode: 'docker', opencode2: 'docker' }), coreOf: () => 'opencode', bridgeOf: () => bridge, dockerProc: proc, platform: 'linux' }), 7)!
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
    await expect(ticketSandboxContext(deps({ backends: () => ({}) }), 7)).resolves.toBeUndefined();
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

describe('ticketGateProcess resolves the sandbox from the listing (F4)', () => {
  const DOCKER = dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode2' }).container;
  const listed = (...boxes: Array<[string, string]>) => () => Promise.resolve(boxes.map(([core, name]) => ({
    runner: core === 'claude' || core === 'codex' ? 'sbx' as const : 'docker' as const, name, ticketId: 7, core, state: 'running' as const,
  })));
  const dockerDeps = (over: Partial<TicketSandboxDeps> = {}) => deps({
    backends: () => ({ opencode: 'docker', opencode2: 'docker' }), coreOf: () => null,
    dockerProc: fakeDockerProcess({ 'docker container inspect': { stdout: 'true' } }), platform: 'linux', ...over,
  });

  it('a null session provider still runs the gate in the listed docker sandbox, never on the host', async () => {
    const { runProcess } = await import('../../workflow/gates/run.js');
    vi.mocked(runProcess).mockClear();
    const gate = ticketGateProcess(dockerDeps({ inventory: listed(['opencode2', DOCKER]) }), 7)!;
    await gate('npm', ['test'], '/wt');
    expect(vi.mocked(runProcess).mock.calls[0]![0]).toBe('docker');
  });

  it('refuses the gate when the ticket has a sandbox but the backend config cannot run it (no host fallback)', async () => {
    const { runProcess } = await import('../../workflow/gates/run.js');
    vi.mocked(runProcess).mockClear();
    const gate = ticketGateProcess(dockerDeps({ backends: () => ({ claude: 'sbx' }), inventory: listed(['opencode2', DOCKER]) }), 7)!;
    await expect(gate('npm', ['test'], '/wt')).resolves.toMatchObject({ kind: 'spawnFailed', message: expect.stringContaining('never run on the host') });
    expect(runProcess).not.toHaveBeenCalled();
  });

  it('with no sandbox listed and no provider the gate runs on the host (a host ticket)', async () => {
    const { runProcess } = await import('../../workflow/gates/run.js');
    vi.mocked(runProcess).mockClear();
    const gate = ticketGateProcess(dockerDeps({ inventory: listed() }), 7)!;
    await expect(gate('npm', ['test'], '/wt')).resolves.toMatchObject({ output: 'host' });
    expect(vi.mocked(runProcess).mock.calls[0]!.slice(0, 2)).toEqual(['npm', ['test']]);
  });

  it('with two sandboxes the one matching the session provider wins; the choice is logged', async () => {
    const debug = vi.fn();
    const d = deps({ backends: () => ({ claude: 'sbx', opencode2: 'docker' }), coreOf: () => 'claude', proc: fakeSbxProcess(), debug,
      inventory: listed(['claude', SBX], ['opencode2', DOCKER]) });
    const { runProcess } = await import('../../workflow/gates/run.js');
    vi.mocked(runProcess).mockClear();
    await ticketGateProcess(d, 7)!('npm', ['test'], '/wt');
    expect(vi.mocked(runProcess).mock.calls[0]!.slice(0, 2)).toEqual(['sbx', ['exec', SBX, '--', 'npm', 'test']]);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('has 2 sandboxes'));
  });

  it('a failing listing falls back to the session provider and never throws', async () => {
    const d = deps({ proc: fakeSbxProcess(), inventory: () => Promise.reject(new Error('docker down')) });
    const { runProcess } = await import('../../workflow/gates/run.js');
    vi.mocked(runProcess).mockClear();
    await expect(ticketGateProcess(d, 7)!('npm', [], '/wt')).resolves.toBeDefined();
  });
});

describe('resolveTicketSandbox after a reload (null session provider, F4/Reattach)', () => {
  const DOCKER = dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode2' });
  const listing = (core: string, name: string) => () => Promise.resolve([{ runner: 'docker' as const, name, ticketId: 7, core, state: 'running' as const }]);

  it('builds the same docker runner (name, bridge evidence dir) the launch built', async () => {
    const d = deps({ backends: () => ({ opencode2: 'docker' }), coreOf: () => null, bridgeOf: () => bridge, inventory: listing('opencode2', DOCKER.container), platform: 'linux' });
    const { found, listed } = await resolveTicketSandbox(d, 7);
    expect(listed?.core).toBe('opencode2');
    expect(found).toMatchObject({ sandboxName: DOCKER.container, runner: { kind: 'docker', enforcesSandbox: true } });
    const launched = ticketSandboxRunner(deps({ backends: () => ({ opencode2: 'docker' }), coreOf: () => 'opencode2', bridgeOf: () => bridge, platform: 'linux' }), 7);
    expect(found!.sandboxName).toBe(launched!.sandboxName);
    expect(found!.runner.bridgeRunDir?.(bridge)).toBe(launched!.runner.bridgeRunDir?.(bridge));
  });

  it('sbx: the listed claude sandbox yields the sbx runner with the clone under the project dir', async () => {
    const listed = () => Promise.resolve([{ runner: 'sbx' as const, name: SBX, ticketId: 7, core: 'claude', state: 'running' as const }]);
    const { found } = await resolveTicketSandbox(deps({ coreOf: () => null, projectRoot: () => '/p/.karst/karst.yml', inventory: listed }), 7);
    expect(found?.runner.kind).toBe('sbx');
  });

  it('remembers the listed core so the sync readers (pointer channel, services) agree', async () => {
    const remember = vi.fn();
    await resolveTicketSandbox(deps({ backends: () => ({ opencode2: 'docker' }), coreOf: () => null, inventory: listing('opencode2', DOCKER.container), remember }), 7);
    expect(remember).toHaveBeenCalledWith(7, 'opencode2');
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
  const m = (agentBackend?: string) => ({ repositories: {}, agentBackends: agentBackend ? { claude: agentBackend } : undefined }) as unknown as Manifest;

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
    const manifest = { agentBackends: { claude: 'sbx' }, repositories: { db: { repoPath: '/r/db', service: { start: 'x', ports: [{ name: 'pg', default: 5432 }] } } } } as unknown as Manifest;
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

describe('bindings: listing-backed core cache, channel, resume guard (F4/F10/F16)', () => {
  const DOCKER = dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode2' });
  const box = { runner: 'docker' as const, name: DOCKER.container, ticketId: 7, core: 'opencode2', state: 'running' as const };
  async function make(over: Partial<TicketSandboxDeps> = {}, inventory: TicketSandboxDeps['inventory'] = async () => [box]) {
    const { createTicketSandboxBindings } = await import('./sandboxTicketOps.js');
    return createTicketSandboxBindings({
      ...deps({ backends: () => ({ opencode2: 'docker' }), coreOf: () => null, platform: 'linux', ...over }),
      store: openStore(':memory:'), manifest: () => undefined, onError: vi.fn(), bridgeRoot: () => '/g', inventory,
    });
  }

  it('sandboxChannel is undefined until a launch or the listing remembered a core, then names the container run dir', async () => {
    const b = await make();
    expect(b.sandboxChannel(7)).toBeUndefined();
    b.remember(7, 'opencode2');
    expect(b.sandboxChannel(7)).toEqual({ kind: 'sandbox', runDir: '/karst-bridge/7', core: 'opencode2' });
    b.remember(7, null);
    expect(b.sandboxChannel(7)).toBeUndefined();
  });

  it('sandboxChannel needs a bridge: without the hook endpoint there is no channel', async () => {
    const { createTicketSandboxBindings } = await import('./sandboxTicketOps.js');
    const b = createTicketSandboxBindings({ ...deps({ backends: () => ({ opencode2: 'docker' }), coreOf: () => null }), store: openStore(':memory:'), manifest: () => undefined, onError: vi.fn(), bridgeRoot: () => undefined });
    b.remember(7, 'opencode2');
    expect(b.sandboxChannel(7)).toBeUndefined();
  });

  it('sandboxChannel is undefined when the remembered core has no runner under the backend config', async () => {
    const b = await make({ backends: () => ({}) });
    b.remember(7, 'opencode2');
    expect(b.sandboxChannel(7)).toBeUndefined();
  });

  it('hasSandbox reflects the listing and the remembered core feeds the sync readers', async () => {
    const b = await make();
    await expect(b.hasSandbox(7)).resolves.toBe(true);
    expect(b.deps.coreOf(7)).toBe('opencode2');
    await expect(b.hasSandbox(8)).resolves.toBe(false);
  });

  it('a listing without the ticket forgets the remembered core', async () => {
    const b = await make({}, async () => []);
    b.remember(7, 'opencode2');
    await b.hasSandbox(7);
    expect(b.deps.coreOf(7)).toBeNull();
  });

  it('guardResume refuses a host resume of a ticket with a sandbox, allows the rest', async () => {
    const b = await make();
    await expect(b.guardResume({ resume: 'ses_1', tracking: { ticketId: 7 } })).rejects.toThrow(/has a sandbox/);
    await expect(b.guardResume({ resume: 'ses_1', tracking: { ticketId: 8 } })).resolves.toBeUndefined();
    await expect(b.guardResume({ tracking: { ticketId: 7 } })).resolves.toBeUndefined();
    await expect(b.guardResume({ resume: 'ses_1' })).resolves.toBeUndefined();
    await expect(b.guardResume({ resume: 'ses_1', tracking: { ticketId: null } })).resolves.toBeUndefined();
  });

  it('guardResume allows a resume for a ticket the listing does not show', async () => {
    const b = await make({}, async () => []);
    await expect(b.guardResume({ resume: 'ses_1', tracking: { ticketId: 7 } })).resolves.toBeUndefined();
  });

  it('the default inventory lists through the injected sbx/docker processes with the per-ticket project root', async () => {
    const { createTicketSandboxBindings } = await import('./sandboxTicketOps.js');
    const dockerProc = Object.assign(fakeDockerProcess({ 'docker ps': { stdout: `${DOCKER.container}\trunning\n` } }), {});
    const projectRoot = vi.fn(() => '/p');
    const b = createTicketSandboxBindings({
      ...deps({ backends: () => ({ opencode2: 'docker' }), coreOf: () => null, proc: fakeSbxProcess(), dockerProc, projectRoot, platform: 'linux' }),
      store: openStore(':memory:'), manifest: () => undefined, onError: vi.fn(), bridgeRoot: () => '/g',
    });
    await expect(b.hasSandbox(7)).resolves.toBe(true);
    expect(projectRoot).toHaveBeenCalledWith(7);
    expect(dockerProc.calls.some((c) => c.args[0] === 'ps')).toBe(true);
  });
});

describe('resolveTicketSandbox / ticketSandboxContext edge cases', () => {
  it('a listing failure is logged and the session provider decides', async () => {
    const debug = vi.fn();
    const r = await resolveTicketSandbox(deps({ debug, inventory: () => Promise.reject(new Error('docker down')) }), 7);
    expect(r.listed).toBeUndefined();
    expect(r.found?.sandboxName).toBe(SBX);
    expect(debug).toHaveBeenCalledWith('[sandbox] ticket 7: listing failed (docker down); using the session provider');
  });

  it('a runner that cannot be built for the resolved core is logged, not thrown', async () => {
    const debug = vi.fn();
    const r = await resolveTicketSandbox(deps({ debug, backends: () => ({ claude: 'sbx' }), coreOf: () => 'claude', projectRoot: () => { throw new Error('no root'); } }), 7);
    expect(r.found).toBeUndefined();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('no runner for core claude (no root)'));
  });

  it('services context: a listed sandbox needs no extra probe; an unlisted one must answer hasSandbox', async () => {
    const listed = () => Promise.resolve([{ runner: 'sbx' as const, name: SBX, ticketId: 7, core: 'claude', state: 'running' as const }]);
    const probe = fakeSbxProcess();
    await expect(ticketSandboxContext(deps({ proc: probe, inventory: listed }), 7)).resolves.toMatchObject({ sandboxName: SBX });
    expect(probe.calls).toHaveLength(0);
    await expect(ticketSandboxContext(deps({ proc: fakeSbxProcess(), inventory: async () => [] }), 7)).resolves.toBeUndefined();
  });

  it('gate refusal is logged with the reason; a gate with no sandbox backend and no provider stays undefined', async () => {
    const debug = vi.fn();
    const DOCKER = dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode2' });
    const inventory = async () => [{ runner: 'docker' as const, name: DOCKER.container, ticketId: 7, core: 'opencode2', state: 'running' as const }];
    const gate = ticketGateProcess(deps({ debug, backends: () => ({ claude: 'sbx' }), coreOf: () => null, inventory }), 7)!;
    await gate('npm', [], '/wt');
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('[gate] gate refused: ticket 7 has a sandbox'));
    expect(ticketGateProcess(deps({ backends: () => ({}), coreOf: () => null, inventory }), 7)).toBeUndefined();
    // Listing configured but no sandbox backend selected: legacy behaviour (core-only decision).
    expect(ticketGateProcess(deps({ backends: () => ({}), coreOf: () => 'claude', inventory }), 7)).toBeUndefined();
  });
});

describe('bindings.provision / provisionInBackground (arch:AC-36)', () => {
  const boxFor = (id: number) => ({ runner: 'sbx' as const, name: sbxName({ projectRoot: '/p', ticketId: id, core: 'claude' }), ticketId: id, core: 'claude', state: 'running' as const });
  const HASH = 'd'.repeat(64);
  async function make(opts: { listed?: (box: ReturnType<typeof boxFor>) => Promise<readonly ReturnType<typeof boxFor>[]>; withNotify?: boolean; setupExit?: number; extra?: Record<string, unknown>; pick?: string } = {}) {
    const { createTicketSandboxBindings } = await import('./sandboxTicketOps.js');
    const { runProcess } = await import('../../workflow/gates/run.js');
    const ran: string[] = [];
    vi.mocked(runProcess).mockImplementation((_c, args) => {
      const fp = args.join(' ').includes('command -v node');
      ran.push(args.join(' '));
      return Promise.resolve({ kind: 'completed', exitCode: fp ? 0 : (opts.setupExit ?? 0), output: fp ? HASH : 'boom', stdout: fp ? HASH : '' }) as never;
    });
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'FEAT-X', title: 't' });
    const box = boxFor(t.id);
    store.db.prepare("INSERT INTO worktrees (ticket_id, repo, path, deps_mode) VALUES (?, 'app', '/wt', 'none')").run(t.id);
    const manifest = { agentBackends: { claude: 'sbx' }, repositories: { app: { repoPath: '/r', sandbox: { setup: 'npm ci' } } } } as unknown as Manifest;
    const errors: string[] = [];
    const infos: string[] = [];
    const offered: string[][] = [];
    const notify = {
      info: (m: string) => { infos.push(m); }, warn: () => undefined, error: (m: string) => { errors.push(m); return Promise.resolve(); },
      ...(opts.pick === undefined ? {} : { errorActions: (m: string, a: readonly string[]) => { errors.push(m); offered.push([...a]); return Promise.resolve(offered.length === 1 ? opts.pick : undefined); } }),
    };
    const root = mkdtempSync(join(tmpdir(), 'prov-'));
    const b = createTicketSandboxBindings({
      ...deps({ proc: fakeSbxProcess(), inventory: () => (opts.listed ?? ((x) => Promise.resolve([x])))(box), projectRoot: () => '/p', coreOf: () => 'claude' }),
      store, manifest: () => manifest, onError: vi.fn(), bridgeRoot: () => root, ...(opts.withNotify === false ? {} : { notify }), ...opts.extra,
    });
    return { b, errors, infos, offered, ran, id: t.id, root };
  }

  it('without a notify seam, or when no sandbox is listed, nothing runs (never the host fallback)', async () => {
    const a = await make({ withNotify: false });
    expect(await a.b.provision(a.id)).toEqual({ ok: true });
    const u = await make({ listed: async () => [] });
    expect(await u.b.provision(u.id)).toEqual({ ok: true });
    expect(a.ran).toHaveLength(0);
    expect(u.ran).toHaveLength(0);
  });

  it('a listed sandbox runs the declared setup; failure is a refusal notified once with the ticket key', async () => {
    const ok = await make();
    expect(await ok.b.provision(ok.id)).toEqual({ ok: true });
    expect(ok.ran.some((a) => a.includes('exec sh -c'))).toBe(true);
    const bad = await make({ setupExit: 2 });
    expect(await bad.b.provision(bad.id)).toMatchObject({ ok: false });
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0]).toContain('Karst: FEAT-X sandbox setup failed: ');
  });

  it('rerunSetup forgets the recorded setup, runs it again and says so', async () => {
    const m = await make({ withNotify: true });
    await m.b.provision(m.id);
    const runs = () => m.ran.filter((a) => a.includes('exec sh -c')).length;
    expect(runs()).toBe(1);
    await m.b.provision(m.id);
    expect(runs()).toBe(1); // recorded ok + same fingerprint: skipped
    await m.b.rerunSetup(m.id);
    expect(runs()).toBe(2);
  });

  it('failure buttons: Re-run setup re-runs and re-drives; Show setup log opens the log; Docker memory help explains', async () => {
    const redrive = vi.fn();
    const openFile = vi.fn();
    const debug = vi.fn();
    const bareDebug = vi.fn();
    const bare = await make({ setupExit: 2, pick: 'Re-run setup', extra: { debug: bareDebug } });
    await bare.b.provision(bare.id);
    await vi.waitFor(() => expect(bare.offered.length).toBeGreaterThan(1)); // no redrive/openFile bound: re-run still completes
    const bareLog = await make({ setupExit: 2, pick: 'Show setup log', extra: { debug: bareDebug } });
    await bareLog.b.provision(bareLog.id);
    await new Promise((res) => setTimeout(res, 20));
    expect(bareDebug.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('action failed'))).toEqual([]);
    const a = await make({ setupExit: 2, pick: 'Re-run setup', extra: { redriveAfterSetup: redrive, openFile, debug } });
    await a.b.provision(a.id);
    await vi.waitFor(() => expect(redrive).toHaveBeenCalledWith(a.id));
    expect(a.offered[0]).toEqual(['Re-run setup', 'Show setup log']);
    const b = await make({ setupExit: 2, pick: 'Show setup log', extra: { redriveAfterSetup: redrive, openFile } });
    await b.b.provision(b.id);
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledTimes(1));
    expect(openFile.mock.calls[0]![0]).toMatch(/setup\.log$/);
    expect(redrive).toHaveBeenCalledTimes(1);
    const c = await make({ setupExit: 2, pick: 'Docker memory help', extra: { debug } });
    await c.b.provision(c.id);
    await vi.waitFor(() => expect(c.infos).toHaveLength(1));
    expect(c.infos[0]).toContain('Memory');
    expect(debug).toHaveBeenCalled();
  });

  /** Advance the fake clock until `p` settles (the 60 s kill-retry delay is armed after some awaits). */
  const tick = async <T>(p: Promise<T>): Promise<T> => {
    let done = false;
    void p.finally(() => { done = true; });
    for (let i = 0; i < 200 && !done; i++) await vi.advanceTimersByTimeAsync(1000);
    return p;
  };

  it('a kill in a docker sandbox carries the Docker VM context into the reason; sbx and unknown cores do not', async () => {
    const dockerProc = fakeDockerProcess({ 'docker info': { stdout: String(4 * 2 ** 30) }, 'docker ps': { stdout: 'karst-a img\n' } });
    const dockerBox = (id: number) => ({ runner: 'docker' as const, name: dockerNames({ projectRoot: '/p', ticketId: id, core: 'opencode2' }).container, ticketId: id, core: 'opencode2', state: 'running' as const });
    const k = await make({ setupExit: 137, extra: { backends: () => ({ opencode2: 'docker' }), coreOf: () => 'opencode2', dockerProc, platform: 'linux', inventory: async () => [dockerBox(1)] } });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const pending = k.b.provision(k.id);
    const r = await tick(pending);
    vi.useRealTimers();
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('likely out of memory (Docker VM 4.0 GB, 1 karst/playwright container running)') });
    const sbx = await make({ setupExit: 137, extra: { dockerProc } });
    const noCore = await make({ setupExit: 137, extra: { dockerProc, coreOf: () => null } });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const sp = sbx.b.provision(sbx.id);
    const sr = await tick(sp);
    vi.useRealTimers();
    expect(sr).toMatchObject({ ok: false, reason: expect.not.stringContaining('Docker VM') });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const nr = await tick(noCore.b.provision(noCore.id));
    vi.useRealTimers();
    expect(nr).toMatchObject({ ok: false, reason: expect.not.stringContaining('Docker VM') });
  });

  it('provisionInBackground returns at once, waits for the listing, then provisions', async () => {
    let polls = 0;
    const m = await make({ setupExit: 2, listed: async (box) => (++polls < 3 ? [] : [box]) });
    const wait = vi.fn(() => Promise.resolve());
    expect(m.b.provisionInBackground(m.id, wait)).toBeUndefined();
    await vi.waitFor(() => expect(m.errors).toHaveLength(1));
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(5_000);
  });

  it('provisionInBackground gives up waiting after 12 polls and provisions nothing', async () => {
    const m = await make({ listed: async () => [] });
    const wait = vi.fn(() => Promise.resolve());
    m.b.provisionInBackground(m.id, wait);
    await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(12));
    expect(m.ran).toHaveLength(0);
  });
});
