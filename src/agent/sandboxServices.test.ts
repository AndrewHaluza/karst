import { describe, expect, it, vi } from 'vitest';
import { openStore } from '../store/db.js';
import type { GateProcessRunner, ProcessOutcome } from '../workflow/gates/run.js';
import type { PortListing, PortMapping, PublishResult } from './sessionRunner.js';
import {
  parseSandboxHandle, reverifySandboxServices, sandboxHandle, serviceToken, startSandboxService,
  START_SCRIPT, START_SCRIPT_SD, STOP_SCRIPT, STOP_SCRIPT_SD, stopSandboxService, stopTicketSandboxServices,
  type SandboxServiceRunner, type SandboxServiceStart,
} from './sandboxServices.js';

const OK: ProcessOutcome = { kind: 'completed', exitCode: 0, output: '' };

function fakeRunner(opts: { publish?: PublishResult[]; start?: ProcessOutcome; live?: PortListing[] | null } = {}) {
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

  it('accepts a remote (ssh) handle, including a qualified remote name', () => {
    expect(parseSandboxHandle(sandboxHandle('ssh', 'karst-ab-7-opencode', 3000))).toEqual({
      kind: 'ssh', name: 'karst-ab-7-opencode', sandboxPort: 3000,
    });
    expect(parseSandboxHandle('ssh:dev@vm.example/karst-ab-7-opencode:8080')).toEqual({
      kind: 'ssh', name: 'dev@vm.example/karst-ab-7-opencode', sandboxPort: 8080,
    });
    expect(parseSandboxHandle('ssh::3000')).toBeNull();
    expect(parseSandboxHandle('ssh:name:999999')).toBeNull();
  });

  it('round-trips a remote-qualified ssh handle and rejects a traversal or a space', () => {
    const name = 'devbox/karst-abcd1234-7-claude';
    expect(parseSandboxHandle(sandboxHandle('ssh', name, 8080))).toEqual({ kind: 'ssh', name, sandboxPort: 8080 });
    // A bare name is what `mode: docker` on a remote records: no remote part.
    expect(parseSandboxHandle('ssh:karst-abcd1234-7-opencode:4100')).toEqual({
      kind: 'ssh', name: 'karst-abcd1234-7-opencode', sandboxPort: 4100,
    });
    expect(parseSandboxHandle('ssh:../x:80')).toBeNull();
    expect(parseSandboxHandle('ssh:a b/x:80')).toBeNull();
    expect(parseSandboxHandle('ssh:a/b/c:80')).toBeNull();
  });
});

describe('service state dir (direct ssh, D823)', () => {
  /** A remote runner whose scripts write their pid and log files under `stateDir`. */
  function sdRunner(stateDir: string) {
    const execs: string[][] = [];
    const unpublished: PortMapping[] = [];
    const runGate = vi.fn<GateProcessRunner>((_c, args) => {
      execs.push([...args]);
      return Promise.resolve(OK);
    });
    const runner: SandboxServiceRunner = {
      kind: 'ssh',
      serviceStateDir: stateDir,
      publishPort: () => Promise.resolve({ ok: true }),
      unpublishPort: (m) => { unpublished.push(m); return Promise.resolve(); },
      listPorts: () => Promise.resolve([]),
      runGate,
    };
    return { runner, execs, unpublished };
  }

  it('passes the state dir as the first argv element and uses the _SD scripts', async () => {
    const store = openStore(':memory:');
    const f = sdRunner('/home/dev/karst/ws/svc');
    await expect(startSandboxService(input(store, f.runner, {
      waitHealthy: () => Promise.reject(new Error('timeout')),
    }))).rejects.toThrow('api: not healthy on 127.0.0.1:4100: timeout');
    expect(f.execs[0]!.slice(1)).toEqual([
      START_SCRIPT_SD, 'karst-svc', '/home/dev/karst/ws/svc', 'api', '/wt/apps/api',
      'env', 'PORT=4100', 'npm', 'run', 'dev',
    ]);
    // The stop after a failed health check names the same dir and no other.
    expect(f.execs[1]!.slice(1)).toEqual([
      STOP_SCRIPT_SD, 'karst-svc-stop', '/home/dev/karst/ws/svc', 'api',
    ]);
  });

  it('gives two tickets with the same unit key different pid and log paths, and stops only its own', async () => {
    const store = openStore(':memory:');
    const a = sdRunner('/ws/a/svc');
    const b = sdRunner('/ws/b/svc');
    await startSandboxService(input(store, a.runner, { ticketId: 7 }));
    await startSandboxService(input(store, b.runner, { ticketId: 8 }));
    expect(a.execs[0]![3]).toBe('/ws/a/svc');
    expect(b.execs[0]![3]).toBe('/ws/b/svc');
    // Both scripts keep the files INSIDE the state dir, never in shared /tmp.
    expect(START_SCRIPT_SD).toContain('"$sd/karst-svc-$k.pid"');
    expect(START_SCRIPT_SD).toContain('"$sd/karst-svc-$k.log"');
    expect(STOP_SCRIPT_SD).toContain('"$sd/karst-svc-$k.pid"');
    const id = (store.db.prepare('SELECT id FROM servers WHERE ticket_id = 7').get() as { id: number }).id;
    await stopSandboxService(store, id, a.runner);
    expect(a.execs.at(-1)!.slice(3)).toEqual(['/ws/a/svc', 'api']);
    expect(b.execs).toHaveLength(1);
  });

  it('never removes the env file from the _SD stop script (removeServiceEnv owns it)', () => {
    expect(STOP_SCRIPT_SD).not.toContain('svc-$k.env');
    expect(STOP_SCRIPT_SD).not.toContain('.env');
  });

  it('refuses a symlinked or foreign-owned state dir before and after the mkdir', () => {
    expect(START_SCRIPT_SD).toContain('[ -L "$sd" ]');
    expect(STOP_SCRIPT_SD).toContain('[ -L "$sd" ]');
    expect(START_SCRIPT_SD).toContain('[ -O "$sd" ]');
    expect(STOP_SCRIPT_SD).toContain('[ -O "$sd" ]');
    expect(START_SCRIPT_SD).toContain('mkdir -p -m 700 "$sd"');
    expect(STOP_SCRIPT_SD).toContain('mkdir -p -m 700 "$sd"');
    // The old scripts stay exactly as they were for a runner without a state dir.
    expect(START_SCRIPT).toContain('/tmp/karst-svc-$k.pid');
    expect(STOP_SCRIPT).toContain('/tmp/karst-svc-$1.pid');
  });
});

describe('service env file seam (remote docker, T1399)', () => {
  function fakeEnvRunner(opts: { start?: ProcessOutcome; failWrite?: string } = {}) {
    const written: Array<{ key: string; env: Readonly<Record<string, string>> }> = [];
    const removed: string[] = [];
    const gateOpts: Array<{ envFile?: string } | undefined> = [];
    const execs: string[][] = [];
    const runGate = vi.fn<GateProcessRunner>((_c, args, _cwd, options) => {
      execs.push([...args]);
      gateOpts.push(options);
      return Promise.resolve(opts.start ?? OK);
    });
    const runner: SandboxServiceRunner = {
      kind: 'docker',
      publishPort: () => Promise.resolve({ ok: true }),
      unpublishPort: () => Promise.resolve(),
      listPorts: () => Promise.resolve([]),
      runGate,
      writeServiceEnv: (key, env) => {
        if (opts.failWrite) return Promise.reject(new Error(opts.failWrite));
        written.push({ key, env });
        return Promise.resolve(`/karst/ws/env/svc-${key}.env`);
      },
      removeServiceEnv: (key) => { removed.push(key); return Promise.resolve(); },
    };
    return { runner, written, removed, gateOpts, execs };
  }

  it('writes the env file, passes it as a gate option, and keeps every value off the gate argv', async () => {
    const store = openStore(':memory:');
    const f = fakeEnvRunner();
    const rec = await startSandboxService(input(store, f.runner, { env: { PORT: '4100', SECRET_TOKEN: 'sk-live-x' }, sandboxName: 'karst-ab-7-opencode' }));
    expect(f.written).toEqual([{ key: 'api', env: { PORT: '4100', SECRET_TOKEN: 'sk-live-x' } }]);
    expect(f.execs[0]!.slice(2)).toEqual(['karst-svc', 'api', '/wt/apps/api', 'npm', 'run', 'dev']);
    expect(f.execs[0]!.join(' ')).not.toContain('PORT=4100');
    expect(f.execs[0]!.join(' ')).not.toContain('sk-live-x');
    expect(f.gateOpts[0]).toMatchObject({ envFile: '/karst/ws/env/svc-api.env', timeoutMs: 30_000 });
    expect(f.removed).toEqual([]);
    expect(rec).toMatchObject({ port: 4100, status: 'running' });
    expect(rows(store)).toEqual([
      { t: 7, repo: 'api', host: '127.0.0.1', port: 4100, pid: null, status: 'running', sandbox: 'docker:karst-ab-7-opencode:4100' },
    ]);
  });

  it('a failed env write unpublishes and throws before any exec', async () => {
    const store = openStore(':memory:');
    const f = fakeEnvRunner({ failWrite: 'disk full' });
    const published: PortMapping[] = [];
    const runner = { ...f.runner, unpublishPort: (m: PortMapping) => { published.push(m); return Promise.resolve(); } };
    await expect(startSandboxService(input(store, runner))).rejects.toThrow('api: cannot write the service env file (disk full)');
    expect(published).toEqual([{ hostPort: 4100, sandboxPort: 4100 }]);
    expect(f.execs).toEqual([]);
    expect(rows(store)).toEqual([]);
  });

  it('a failed start or an unhealthy service removes the env file', async () => {
    const store = openStore(':memory:');
    const bad = fakeEnvRunner({ start: { kind: 'completed', exitCode: 1, output: 'boom' } });
    await expect(startSandboxService(input(store, bad.runner))).rejects.toThrow('start inside the sandbox failed (exit 1: boom)');
    expect(bad.removed).toEqual(['api']);
    const sick = fakeEnvRunner();
    await expect(startSandboxService(input(store, sick.runner, { waitHealthy: () => Promise.reject(new Error('timeout')) })))
      .rejects.toThrow('api: not healthy on 127.0.0.1:4100: timeout');
    expect(sick.removed).toEqual(['api']);
    expect(rows(store)).toEqual([]);
  });

  it('stop removes the env file after the stop script', async () => {
    const store = openStore(':memory:');
    const f = fakeEnvRunner();
    await startSandboxService(input(store, f.runner));
    const id = (store.db.prepare('SELECT id FROM servers').get() as { id: number }).id;
    await stopSandboxService(store, id, f.runner);
    expect(f.execs.at(-1)!.slice(1)).toEqual([STOP_SCRIPT, 'karst-svc-stop', 'api']);
    expect(f.removed).toEqual(['api']);
    expect(rows(store)).toMatchObject([{ status: 'stopped' }]);
  });

  it('a runner without writeServiceEnv keeps the old in-sandbox env argv', async () => {
    const store = openStore(':memory:');
    const f = fakeRunner();
    await startSandboxService(input(store, f.runner));
    expect(f.execs[0]!.slice(2)).toEqual(['karst-svc', 'api', '/wt/apps/api', 'env', 'PORT=4100', 'npm', 'run', 'dev']);
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

  it('republishes a listed mapping whose tunnel is down', async () => {
    const { store } = await seeded();
    const f = fakeRunner({ live: [{ hostPort: 4100, sandboxPort: 4100, state: 'down', reason: 'ssh: Connection timed out' }] });
    await expect(reverifySandboxServices(store, 7, f.runner, () => Promise.resolve(true))).resolves.toEqual({ republished: ['api'], dropped: [] });
    expect(f.published).toEqual([{ hostPort: 4100, sandboxPort: 4100 }]);
  });

  it('keeps a present mapping untouched and drops a row whose service is not healthy', async () => {
    const { store } = await seeded();
    const f = fakeRunner({ live: [{ hostPort: 4100, sandboxPort: 4100 }] });
    await expect(reverifySandboxServices(store, 7, f.runner, () => Promise.resolve(false))).resolves.toEqual({ republished: [], dropped: ['api'] });
    expect(f.published).toEqual([]);
    expect(f.unpublished).toEqual([{ hostPort: 4100, sandboxPort: 4100 }]);
    expect(rows(store)).toEqual([]);
  });

  it('ssh: keeps a healthy row when another window holds its host port (D823)', async () => {
    const { store } = await seeded();
    const taken = { ok: false, reason: 'host port 4100 is taken', portTaken: true } as const;
    const f = fakeRunner({ live: [], publish: [taken, taken] });
    const ssh = { ...f.runner, kind: 'ssh' as const };
    await expect(reverifySandboxServices(store, 7, ssh, () => Promise.resolve(true))).resolves.toEqual({ republished: [], dropped: [] });
    expect(f.unpublished).toEqual([]);
    expect(rows(store)).toHaveLength(1);
    // Nothing serves on the taken port: the row goes, as for any unhealthy row.
    await expect(reverifySandboxServices(store, 7, ssh, () => Promise.resolve(false))).resolves.toEqual({ republished: [], dropped: ['api'] });
  });

  it('drops the row when a republish fails for another reason, or on a non-ssh runner', async () => {
    const other = await seeded();
    const ssh = { ...fakeRunner({ live: [], publish: [{ ok: false, reason: 'ssh: gone', portTaken: false }] }).runner, kind: 'ssh' as const };
    await expect(reverifySandboxServices(other.store, 7, ssh, () => Promise.resolve(true))).resolves.toEqual({ republished: [], dropped: ['api'] });
    const sbx = await seeded();
    const taken = fakeRunner({ live: [], publish: [{ ok: false, reason: 'taken', portTaken: true }] });
    await expect(reverifySandboxServices(sbx.store, 7, taken.runner, () => Promise.resolve(true))).resolves.toEqual({ republished: [], dropped: ['api'] });
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

describe('resetSandboxServices (decision 8)', () => {
  it('runs only declared resets, in the service dir, on running sandboxed rows; failures are warnings', async () => {
    const { resetSandboxServices, RESET_SCRIPT } = await import('./sandboxServices.js');
    const store = openStore(':memory:');
    const f = fakeRunner();
    await startSandboxService(input(store, f.runner, { service: 'api' }));
    await startSandboxService(input(store, f.runner, { service: 'web', port: 4101 }));
    await startSandboxService(input(store, f.runner, { service: 'db', port: 4102 }));
    store.db.prepare("UPDATE servers SET status = 'stopped' WHERE repo = 'db'").run();
    f.execs.length = 0;
    const defs: Record<string, { reset?: string; cwd?: string }> = { api: { reset: 'npm run reset', cwd: 'apps/api' }, web: {}, db: { reset: 'x' } };
    await expect(resetSandboxServices(store, 7, f.runner, (k) => defs[k])).resolves.toEqual([]);
    expect(f.execs).toEqual([['-c', RESET_SCRIPT, 'karst-reset', '/wt/apps/api', 'npm run reset']]);
    const bad = fakeRunner({ start: { kind: 'completed', exitCode: 2, output: 'boom' } });
    await expect(resetSandboxServices(store, 7, bad.runner, () => ({ reset: 'r' }))).resolves.toEqual([
      'api: reset failed (exit 2: boom)', 'web: reset failed (exit 2: boom)',
    ]);
    expect(bad.execs[0]![3]).toBe('/wt');
  });
});
