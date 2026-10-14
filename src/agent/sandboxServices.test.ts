import { describe, expect, it, vi } from 'vitest';
import { openStore } from '../store/db.js';
import type { GateProcessRunner, ProcessOutcome } from '../workflow/gates/run.js';
import type { PortMapping, PublishResult } from './sessionRunner.js';
import {
  parseSandboxHandle, reverifySandboxServices, sandboxHandle, serviceToken, startSandboxService,
  STOP_SCRIPT, stopSandboxService, stopTicketSandboxServices, type SandboxServiceRunner, type SandboxServiceStart,
} from './sandboxServices.js';

const OK: ProcessOutcome = { kind: 'completed', exitCode: 0, output: '' };

function fakeRunner(opts: { publish?: PublishResult[]; start?: ProcessOutcome; live?: PortMapping[] | null } = {}) {
  const published: PortMapping[] = [];
  const unpublished: PortMapping[] = [];
  const queue = [...(opts.publish ?? [])];
  const execs: string[][] = [];
  const runGate = vi.fn<GateProcessRunner>((_c, args) => {
    execs.push([...args]);
    return Promise.resolve(args[1] === STOP_SCRIPT ? OK : (opts.start ?? OK));
  });
  const runner: SandboxServiceRunner = {
    kind: 'sbx',
    publishPort: (m) => { published.push(m); return Promise.resolve(queue.shift() ?? { ok: true }); },
    unpublishPort: (m) => { unpublished.push(m); return Promise.resolve(); },
    listPorts: () => Promise.resolve(opts.live === undefined ? [] : opts.live),
    runGate,
  };
  return { runner, published, unpublished, execs };
}

function input(store: ReturnType<typeof openStore>, runner: SandboxServiceRunner, over: Partial<SandboxServiceStart> = {}): SandboxServiceStart {
  return {
    store, runner, sandboxName: 'karst-ab-7-claude', ticketId: 7, service: 'api',
    command: 'npm', args: ['run', 'dev'], env: { PORT: '4100', 'BAD KEY': 'x' },
    worktree: '/wt', serviceCwd: '/wt/apps/api', port: 4100,
    healthUrlFor: (p) => `http://127.0.0.1:${p}/health`, logPath: '/wt/.karst/api.log',
    reallocate: () => Promise.resolve(4200), waitHealthy: () => Promise.resolve(), ...over,
  };
}

const rows = (store: ReturnType<typeof openStore>) =>
  store.db.prepare('SELECT ticket_id AS t, repo, host, port, pid, status, sandbox FROM servers ORDER BY id').all();

describe('sandbox handle', () => {
  it('round-trips and rejects anything else', () => {
    expect(parseSandboxHandle(sandboxHandle('docker', 'karst-ab-7-opencode', 3000))).toEqual({ kind: 'docker', name: 'karst-ab-7-opencode', sandboxPort: 3000 });
    expect(parseSandboxHandle('host:x:1')).toBeNull();
    expect(parseSandboxHandle('sbx:A B:1')).toBeNull();
    expect(serviceToken('Web/API_x')).toBe('web-api-x');
  });
});

describe('startSandboxService (arch:AC-32)', () => {
  it('publishes the allocated port, starts inside the sandbox, and writes the row only after health', async () => {
    const store = openStore(':memory:');
    const f = fakeRunner();
    const order: string[] = [];
    const rec = await startSandboxService(input(store, f.runner, {
      waitHealthy: (url) => { order.push(`health ${url} rows=${rows(store).length}`); return Promise.resolve(); },
    }));
    expect(f.published).toEqual([{ hostPort: 4100, sandboxPort: 4100 }]);
    expect(f.execs[0]!.slice(2)).toEqual(['karst-svc', 'api', '/wt/apps/api', 'env', 'PORT=4100', 'npm', 'run', 'dev']);
    expect(order).toEqual(['health http://127.0.0.1:4100/health rows=0']);
    expect(rec).toMatchObject({ host: '127.0.0.1', port: 4100, pid: null, status: 'running' });
    expect(rows(store)).toEqual([{ t: 7, repo: 'api', host: '127.0.0.1', port: 4100, pid: null, status: 'running', sandbox: 'sbx:karst-ab-7-claude:4100' }]);
  });

  it('reallocates the host port ONCE on a conflict; the sandbox port stays the allocated one', async () => {
    const store = openStore(':memory:');
    const f = fakeRunner({ publish: [{ ok: false, reason: 'busy', portTaken: true }] });
    const reallocate = vi.fn(() => Promise.resolve(4200));
    const rec = await startSandboxService(input(store, f.runner, { reallocate }));
    expect(reallocate).toHaveBeenCalledWith(4100);
    expect(f.published).toEqual([{ hostPort: 4100, sandboxPort: 4100 }, { hostPort: 4200, sandboxPort: 4100 }]);
    expect(rec.port).toBe(4200);
  });

  it('a second publish failure is an explicit error and leaves no server row', async () => {
    const store = openStore(':memory:');
    const f = fakeRunner({ publish: [{ ok: false, reason: 'busy', portTaken: true }, { ok: false, reason: 'busy again', portTaken: true }] });
    await expect(startSandboxService(input(store, f.runner))).rejects.toThrow('api: cannot publish a host port after one reallocation: busy again');
    expect(rows(store)).toEqual([]);
    expect(f.execs).toEqual([]);
  });

  it('a non-conflict publish failure never reallocates', async () => {
    const store = openStore(':memory:');
    const reallocate = vi.fn(() => Promise.resolve(1));
    const f = fakeRunner({ publish: [{ ok: false, reason: 'sandbox down', portTaken: false }] });
    await expect(startSandboxService(input(store, f.runner, { reallocate }))).rejects.toThrow('api: sandbox down');
    expect(reallocate).not.toHaveBeenCalled();
  });

  it('a failed start or an unhealthy service unpublishes and writes no row', async () => {
    const store = openStore(':memory:');
    const bad = fakeRunner({ start: { kind: 'completed', exitCode: 1, output: 'no such dir ' } });
    await expect(startSandboxService(input(store, bad.runner))).rejects.toThrow('start inside the sandbox failed (exit 1: no such dir)');
    expect(bad.unpublished).toEqual([{ hostPort: 4100, sandboxPort: 4100 }]);
    const sick = fakeRunner();
    await expect(startSandboxService(input(store, sick.runner, { waitHealthy: () => Promise.reject(new Error('timeout')) })))
      .rejects.toThrow('api: not healthy on 127.0.0.1:4100: timeout');
    expect(sick.execs[1]!.slice(1)).toEqual([STOP_SCRIPT, 'karst-svc-stop', 'api']);
    expect(sick.unpublished).toHaveLength(1);
    expect(rows(store)).toEqual([]);
  });

  it('a runner without ports is refused', async () => {
    const store = openStore(':memory:');
    await expect(startSandboxService(input(store, { kind: 'host' }))).rejects.toThrow('the host runner cannot publishPort');
  });

  it('two repository entries sharing a repoPath keep distinct port identities and rows', async () => {
    const store = openStore(':memory:');
    const f = fakeRunner();
    await startSandboxService(input(store, f.runner, { service: 'web', port: 4100 }));
    await startSandboxService(input(store, f.runner, { service: 'web-admin', port: 4101 }));
    expect(rows(store).map((r) => (r as { repo: string; port: number }).repo + ':' + (r as { port: number }).port)).toEqual(['web:4100', 'web-admin:4101']);
    expect(f.execs.map((e) => e[3])).toEqual(['web', 'web-admin']);
  });
});

describe('stop, restart re-verify, cleanup', () => {
  async function seeded(ticketId = 7, service = 'api', port = 4100) {
    const store = openStore(':memory:');
    const f = fakeRunner();
    await startSandboxService(input(store, f.runner, { ticketId, service, port }));
    return { store, f };
  }

  it('stop kills inside the sandbox, unpublishes, and marks the row stopped', async () => {
    const { store, f } = await seeded();
    const id = (store.db.prepare('SELECT id FROM servers').get() as { id: number }).id;
    await stopSandboxService(store, id, f.runner);
    expect(f.execs.at(-1)!.slice(1)).toEqual([STOP_SCRIPT, 'karst-svc-stop', 'api']);
    expect(f.unpublished).toEqual([{ hostPort: 4100, sandboxPort: 4100 }]);
    expect(rows(store)).toMatchObject([{ status: 'stopped', pid: null }]);
    await stopSandboxService(store, 999, f.runner);
  });

  it('stopping one ticket removes only its own mappings; the bystander ticket survives', async () => {
    const { store, f } = await seeded(7, 'api', 4100);
    await startSandboxService(input(store, f.runner, { ticketId: 8, service: 'api', port: 4300, sandboxName: 'karst-ab-8-claude' }));
    await stopTicketSandboxServices(store, 7, f.runner);
    expect(f.unpublished).toEqual([{ hostPort: 4100, sandboxPort: 4100 }]);
    expect(rows(store)).toMatchObject([{ t: 7, status: 'stopped' }, { t: 8, status: 'running', port: 4300 }]);
  });

  it('republishes a missing mapping and keeps a healthy row', async () => {
    const { store } = await seeded();
    const f = fakeRunner({ live: [] });
    await expect(reverifySandboxServices(store, 7, f.runner, () => Promise.resolve(true))).resolves.toEqual({ republished: ['api'], dropped: [] });
    expect(f.published).toEqual([{ hostPort: 4100, sandboxPort: 4100 }]);
    expect(rows(store)).toHaveLength(1);
  });

  it('keeps a present mapping untouched and drops a row whose service is not healthy', async () => {
    const { store } = await seeded();
    const f = fakeRunner({ live: [{ hostPort: 4100, sandboxPort: 4100 }] });
    await expect(reverifySandboxServices(store, 7, f.runner, () => Promise.resolve(false))).resolves.toEqual({ republished: [], dropped: ['api'] });
    expect(f.published).toEqual([]);
    expect(f.unpublished).toEqual([{ hostPort: 4100, sandboxPort: 4100 }]);
    expect(rows(store)).toEqual([]);
  });

  it('changes nothing when the sandbox cannot list (stopped), and is a no-op without rows', async () => {
    const { store } = await seeded();
    const f = fakeRunner({ live: null });
    await expect(reverifySandboxServices(store, 7, f.runner, () => Promise.resolve(false))).resolves.toBeNull();
    expect(rows(store)).toHaveLength(1);
    await expect(reverifySandboxServices(store, 99, f.runner, () => Promise.resolve(false))).resolves.toEqual({ republished: [], dropped: [] });
  });
});

describe('review fixes', () => {
  it('stopAllTicketServers stops sandboxed services inside the sandbox and unpublishes before the host path', async () => {
    const { stopAllTicketServers } = await import('./sandboxServices.js');
    const store = openStore(':memory:');
    const f = fakeRunner();
    await startSandboxService(input(store, f.runner));
    await stopAllTicketServers(store, 7, f.runner);
    expect(f.execs.at(-1)!.slice(1)).toEqual([STOP_SCRIPT, 'karst-svc-stop', 'api']);
    expect(f.unpublished).toEqual([{ hostPort: 4100, sandboxPort: 4100 }]);
    expect(rows(store)).toMatchObject([{ status: 'stopped' }]);
    const host = openStore(':memory:');
    host.db.prepare("INSERT INTO servers (ticket_id, repo, status) VALUES (7, 'x', 'running')").run();
    await stopAllTicketServers(host, 7, undefined);
    expect(host.db.prepare('SELECT status FROM servers').get()).toEqual({ status: 'stopped' });
  });

  it('re-verify drops a row whose missing mapping cannot be republished, even if something answers', async () => {
    const store = openStore(':memory:');
    await startSandboxService(input(store, fakeRunner().runner));
    const f = fakeRunner({ live: [], publish: [{ ok: false, reason: 'down', portTaken: false }] });
    const healthy = vi.fn(() => Promise.resolve(true));
    await expect(reverifySandboxServices(store, 7, f.runner, healthy)).resolves.toEqual({ republished: [], dropped: ['api'] });
    expect(healthy).not.toHaveBeenCalled();
    expect(rows(store)).toEqual([]);
  });
});

describe('review fix #109', () => {
  it('refuses to start a service when the sandbox cannot host one now: no publish, no exec, no row', async () => {
    const store = openStore(':memory:');
    const f = fakeRunner();
    const runner = { ...f.runner, canHostServices: () => Promise.resolve(false) };
    await expect(startSandboxService(input(store, runner))).rejects.toThrow('api: the sbx sandbox is not running — open the ticket');
    expect(f.published).toEqual([]);
    expect(f.execs).toEqual([]);
    expect(rows(store)).toEqual([]);
    await expect(startSandboxService(input(store, { ...f.runner, canHostServices: () => Promise.resolve(true) }))).resolves.toMatchObject({ port: 4100 });
  });
});
