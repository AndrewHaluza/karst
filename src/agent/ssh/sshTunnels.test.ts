import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import { sshOptions } from './sshProcess.js';
import {
  TUNNEL_BACKOFF_MAX_MS,
  TUNNEL_BACKOFF_START_MS,
  TUNNEL_L_READY_TIMEOUT_MS,
  TUNNEL_MAX_ATTEMPTS,
  TUNNEL_R_READY_MS,
  TunnelOpenError,
  createTunnelRegistry,
  isHostPortTaken,
  openTunnel,
  tunnelArgv,
  tunnelBackoffMs,
  tunnelLKey,
  tunnelRKey,
  type TunnelChild,
  type TunnelDeps,
  type TunnelRequest,
  type TunnelSpec,
} from './sshTunnels.js';

const REMOTE: RemoteDef = { host: 'vm.example.com', user: 'karst', mode: 'direct', remoteDir: '/srv/karst' };
const CONTROL_DIR = '/tmp/karst-ssh-0/';
const SANDBOX = 'karst-0123abcd-7-claude';
const KEY_L = `${SANDBOX}:L:8080`;
const KEY_R = 'devbox:R:5432';

/** A `ChildProcess`-shaped fake: the test decides when the tunnel process exits. */
class FakeChild extends EventEmitter {
  kills = 0;
  readonly stderr = new EventEmitter();
  constructor(readonly argv: readonly string[]) {
    super();
  }
  kill(): boolean {
    this.kills += 1;
    return true;
  }
  exit(code = 255, stderr?: string): void {
    if (stderr !== undefined) this.stderr.emit('data', stderr);
    this.emit('exit', code, null);
  }
}

interface Harness {
  readonly deps: TunnelDeps;
  readonly spawned: FakeChild[];
  readonly warn: ReturnType<typeof vi.fn>;
  readonly debug: ReturnType<typeof vi.fn>;
  /** What the loopback probe answers; tests flip it to fail a re-open. */
  connectOk: boolean;
  /** What the pre-spawn host port check answers; tests flip it to plant a squatter. */
  hostPortHeld: boolean;
}

function harness(
  over: {
    readonly connect?: (port: number) => Promise<boolean>;
    readonly portInUse?: (port: number) => Promise<boolean>;
    readonly onSpawn?: (child: FakeChild, index: number) => void;
  } = {},
): Harness {
  const spawned: FakeChild[] = [];
  const warn = vi.fn();
  const debug = vi.fn();
  const h: Harness = {
    spawned,
    warn,
    debug,
    connectOk: true,
    hostPortHeld: false,
    deps: {
      spawn: (argv: readonly string[]): TunnelChild => {
        const child = new FakeChild(argv);
        spawned.push(child);
        over.onSpawn?.(child, spawned.length);
        return child as unknown as TunnelChild;
      },
      connect: over.connect ?? (() => Promise.resolve(h.connectOk)),
      portInUse: over.portInUse ?? (() => Promise.resolve(h.hostPortHeld)),
      warn,
      debug,
    },
  };
  return h;
}

const spec = (over: Partial<TunnelSpec> = {}): TunnelSpec => ({
  key: KEY_L,
  kind: 'L',
  remote: REMOTE,
  controlDir: CONTROL_DIR,
  hostPort: 8080,
  remotePort: 3000,
  ...over,
});

const request = (over: Partial<TunnelRequest> = {}): TunnelRequest => ({
  remote: REMOTE,
  controlDir: CONTROL_DIR,
  hostPort: 8080,
  remotePort: 3000,
  ...over,
});

const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe('tunnelArgv', () => {
  it('builds the exact -L argv with loopback on both sides', () => {
    const argv = tunnelArgv('L', REMOTE, CONTROL_DIR, 8080, 3000);
    expect(argv).toEqual([
      ...sshOptions(REMOTE, CONTROL_DIR, { mux: false }),
      '-N',
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      '127.0.0.1:8080:127.0.0.1:3000',
      '--',
      'karst@vm.example.com',
    ]);
    expect(argv).toContain('ControlMaster=no');
    expect(argv).toContain('ControlPath=none');
    expect(argv.slice(-2)).toEqual(['--', 'karst@vm.example.com']);
    expect(argv.some((part) => part.includes('0.0.0.0'))).toBe(false);
  });

  it('builds the -R argv with the remote port first', () => {
    const argv = tunnelArgv('R', REMOTE, CONTROL_DIR, 5432, 5432);
    expect(argv.slice(-7)).toEqual([
      '-N',
      '-o',
      'ExitOnForwardFailure=yes',
      '-R',
      '127.0.0.1:5432:127.0.0.1:5432',
      '--',
      'karst@vm.example.com',
    ]);
    expect(argv.at(-1)).toBe('karst@vm.example.com');
    expect(argv.some((part) => part.includes('0.0.0.0'))).toBe(false);

    const split = tunnelArgv('R', REMOTE, CONTROL_DIR, 5432, 6432);
    expect(split).toContain('127.0.0.1:6432:127.0.0.1:5432');
  });

  it.each([0, -1, 65536, 1.5, Number.NaN])('refuses the invalid port %s', (port) => {
    expect(() => tunnelArgv('L', REMOTE, CONTROL_DIR, port, 3000)).toThrow(/TCP port/);
    expect(() => tunnelArgv('L', REMOTE, CONTROL_DIR, 8080, port)).toThrow(/TCP port/);
  });
});

describe('tunnelBackoffMs', () => {
  it('starts at 1 s, doubles, and stops at 60 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((attempt) => tunnelBackoffMs(attempt))).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000,
    ]);
    expect(tunnelBackoffMs(0)).toBe(TUNNEL_BACKOFF_START_MS);
    expect(tunnelBackoffMs(50)).toBe(TUNNEL_BACKOFF_MAX_MS);
  });
});

describe('isHostPortTaken', () => {
  it('recognises a host-side bind failure', () => {
    expect(isHostPortTaken('bind [127.0.0.1]:8080: Address already in use')).toBe(true);
    expect(isHostPortTaken('cannot listen to port: 8080')).toBe(true);
    expect(isHostPortTaken('bind: Permission denied')).toBe(true);
  });

  it('does not read a transport failure as a taken port', () => {
    expect(isHostPortTaken('ssh: connect to host vm.example.com port 22: Connection refused')).toBe(false);
    expect(isHostPortTaken('karst@vm.example.com: Permission denied (publickey).')).toBe(false);
    expect(isHostPortTaken('')).toBe(false);
  });
});

describe('openTunnel readiness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports -L up as soon as the loopback connect succeeds', async () => {
    const h = harness();
    const handle = await openTunnel(h.deps, spec());
    expect(handle.state).toBe('up');
    expect(handle.key).toBe(KEY_L);
    expect(handle.kind).toBe('L');
    expect(handle.hostPort).toBe(8080);
    expect(handle.remotePort).toBe(3000);
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]!.argv).toEqual(tunnelArgv('L', REMOTE, CONTROL_DIR, 8080, 3000));
  });

  it('polls the loopback until the forward is live', async () => {
    let calls = 0;
    const h = harness({
      connect: () => {
        calls += 1;
        return Promise.resolve(calls >= 3);
      },
    });
    const opened = openTunnel(h.deps, spec());
    await advance(1000);
    const handle = await opened;
    expect(handle.state).toBe('up');
    expect(calls).toBe(3);
  });

  it('fails a -L open that never becomes live after the bounded timeout', async () => {
    const h = harness({ connect: () => Promise.resolve(false) });
    const pending = openTunnel(h.deps, spec());
    const rejection = expect(pending).rejects.toBeInstanceOf(TunnelOpenError);
    await advance(TUNNEL_L_READY_TIMEOUT_MS + 1000);
    await rejection;
    expect(h.spawned[0]!.kills).toBe(1);
  });

  it('reports -R up once the process has stayed alive for the ready window', async () => {
    const connect = vi.fn(() => Promise.resolve(true));
    const h = harness({ connect });
    const opened = openTunnel(h.deps, spec({ key: KEY_R, kind: 'R', hostPort: 5432, remotePort: 5432 }));
    let state: string | undefined;
    void opened.then((handle) => {
      state = handle.state;
    });

    await advance(TUNNEL_R_READY_MS - 1);
    expect(state).toBeUndefined();
    await advance(1);
    await advance(0);
    expect(state).toBe('up');
    expect(connect).not.toHaveBeenCalled();
  });

  it('close() kills the process and stops the watcher', async () => {
    const h = harness();
    const handle = await openTunnel(h.deps, spec());
    await handle.close();
    expect(h.spawned[0]!.kills).toBe(1);
    expect(handle.state).toBe('down');

    h.spawned[0]!.exit(0);
    await advance(TUNNEL_BACKOFF_MAX_MS * 3);
    expect(h.spawned).toHaveLength(1);
  });
});

describe('openTunnel first-open failure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('carries the ssh stderr tail, bounded, with portTaken false', async () => {
    const stderr = `${'x'.repeat(500)}\nssh: connect to host vm.example.com port 22: Connection refused`;
    const h = harness({
      connect: () => Promise.resolve(false),
      onSpawn: (child) => {
        setTimeout(() => child.exit(255, stderr), 0);
      },
    });
    const error = await openTunnel(h.deps, spec()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TunnelOpenError);
    const failure = error as TunnelOpenError;
    expect(failure.stderrTail).toContain('Connection refused');
    expect(failure.stderrTail.length).toBeLessThanOrEqual(300);
    expect(failure.portTaken).toBe(false);
    expect(h.spawned[0]!.kills).toBe(1);
  });

  it('flags a host port already in use so the caller can reallocate', async () => {
    const h = harness({
      connect: () => Promise.resolve(false),
      onSpawn: (child) => {
        setTimeout(() => child.exit(255, 'bind [127.0.0.1]:8080: Address already in use'), 0);
      },
    });
    const error = await openTunnel(h.deps, spec()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TunnelOpenError);
    expect((error as TunnelOpenError).portTaken).toBe(true);
  });
});

describe('openTunnel host port held by another process', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('refuses a -L open with portTaken when another process already listens on the host port', async () => {
    const portInUse = vi.fn(() => Promise.resolve(true));
    const h = harness({ portInUse });
    const error = await openTunnel(h.deps, spec()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TunnelOpenError);
    const failure = error as TunnelOpenError;
    expect(failure.portTaken).toBe(true);
    expect(failure.message).toBe(`ssh: ${KEY_L} tunnel failed: host port 8080 is already in use`);
    expect(portInUse).toHaveBeenCalledWith(8080);
    expect(h.spawned).toHaveLength(0);
  });

  it('does not check the host port for a -R tunnel', async () => {
    const portInUse = vi.fn(() => Promise.resolve(true));
    const h = harness({ portInUse });
    const opened = openTunnel(h.deps, spec({ key: KEY_R, kind: 'R', hostPort: 5432, remotePort: 5432 }));
    await advance(TUNNEL_R_READY_MS);
    await advance(0);
    expect((await opened).state).toBe('up');
    expect(portInUse).not.toHaveBeenCalled();
  });

  it('does not re-open a -L tunnel onto a host port that another process took meanwhile', async () => {
    const h = harness();
    const handle = await openTunnel(h.deps, spec());

    h.hostPortHeld = true;
    h.spawned[0]!.exit(255, 'ssh: Connection reset by peer');
    await advance(0);
    await advance(TUNNEL_BACKOFF_START_MS);
    await advance(0);

    expect(h.spawned).toHaveLength(1);
    expect(handle.state).toBe('reconnecting');

    h.hostPortHeld = false;
    await advance(2 * TUNNEL_BACKOFF_START_MS);
    await advance(0);
    expect(h.spawned).toHaveLength(2);
    expect(handle.state).toBe('up');
  });

  it('gives up with the in-use reason when the host port stays taken', async () => {
    const h = harness();
    const handle = await openTunnel(h.deps, spec());

    h.hostPortHeld = true;
    h.spawned[0]!.exit(255, 'ssh: Connection reset by peer');
    await advance(0);
    for (let attempt = 0; attempt < TUNNEL_MAX_ATTEMPTS; attempt += 1) {
      await advance(TUNNEL_BACKOFF_MAX_MS);
    }
    await advance(0);

    expect(h.spawned).toHaveLength(1);
    expect(handle.state).toBe('down');
    expect(handle.reason).toBe('host port 8080 is already in use');
  });
});

describe('openTunnel exit watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('re-opens the same -L tunnel after 1 s and keeps the handle', async () => {
    const h = harness();
    const handle = await openTunnel(h.deps, spec());

    h.spawned[0]!.exit(255, 'ssh: Connection reset by peer');
    await advance(0);
    expect(handle.state).toBe('reconnecting');

    await advance(TUNNEL_BACKOFF_START_MS - 1);
    expect(h.spawned).toHaveLength(1);
    await advance(1);
    await advance(0);

    expect(h.spawned).toHaveLength(2);
    expect(handle.state).toBe('up');
    expect(handle.key).toBe(KEY_L);
  });

  it('does not re-open after close(), even when the exit arrives later', async () => {
    const h = harness();
    const handle = await openTunnel(h.deps, spec());
    await handle.close();

    h.spawned[0]!.exit(0);
    await advance(TUNNEL_BACKOFF_MAX_MS * 2);
    expect(h.spawned).toHaveLength(1);
    expect(handle.state).toBe('down');
  });

  it('grows the backoff 1, 2, 4 … caps at 60 s, and gives up after 10 failures with one WARN', async () => {
    const crash = { on: false };
    const h = harness({
      onSpawn: (child) => {
        if (crash.on) queueMicrotask(() => child.exit(255, 'ssh: connect to host vm.example.com port 22: Connection timed out'));
      },
    });
    const handle = await openTunnel(h.deps, spec());

    crash.on = true;
    h.connectOk = false;
    h.spawned[0]!.exit(255, 'ssh: Connection reset by peer');
    await advance(0);

    const delays = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000];
    for (const [index, delay] of delays.entries()) {
      await advance(delay - 1);
      expect(h.spawned).toHaveLength(1 + index);
      await advance(1);
      expect(h.spawned).toHaveLength(2 + index);
    }

    expect(handle.state).toBe('down');
    expect(handle.reason).toContain('Connection timed out');
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0]?.[0]).toContain(KEY_L);

    await advance(TUNNEL_BACKOFF_MAX_MS * 3);
    expect(h.spawned).toHaveLength(1 + TUNNEL_MAX_ATTEMPTS);
  });
});

describe('TunnelRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps one -L handle per key', async () => {
    const h = harness();
    const registry = createTunnelRegistry(h.deps);
    const first = await registry.openL(KEY_L, request());
    const second = await registry.openL(KEY_L, request());
    expect(second).toBe(first);
    expect(h.spawned).toHaveLength(1);
    expect(registry.forSandbox(SANDBOX)).toEqual([first]);
    expect(registry.list(`${SANDBOX}:L:`)).toEqual([first]);
  });

  it('keys -L per sandbox, so one host port number never clashes', async () => {
    const h = harness();
    const registry = createTunnelRegistry(h.deps);
    await registry.openL(tunnelLKey('one', 8080), request({ hostPort: 8080 }));
    await registry.openL(tunnelLKey('two', 8080), request({ hostPort: 8080 }));
    expect(h.spawned).toHaveLength(2);
    expect(registry.forSandbox('one')).toHaveLength(1);
    expect(registry.forSandbox('two')).toHaveLength(1);
    expect(tunnelLKey('one', 8080)).not.toBe(tunnelLKey('two', 8080));
  });

  it('refuses a key whose port does not match the request', async () => {
    const registry = createTunnelRegistry(harness().deps);
    await expect(registry.openL('one:L:8080', request({ hostPort: 8081 }))).rejects.toThrow(/tunnel key/);
    await expect(registry.openL('one:8080', request({ hostPort: 8080 }))).rejects.toThrow(/tunnel key/);
  });

  it('closeL closes just that tunnel', async () => {
    const h = harness();
    const registry = createTunnelRegistry(h.deps);
    const handle = await registry.openL(KEY_L, request());
    await registry.closeL(KEY_L);
    expect(handle.state).toBe('down');
    expect(h.spawned[0]!.kills).toBe(1);
    expect(registry.forSandbox(SANDBOX)).toHaveLength(0);
  });

  it('closeSandbox closes every -L tunnel of one sandbox and keeps the others', async () => {
    const h = harness();
    const registry = createTunnelRegistry(h.deps);
    await registry.openL(tunnelLKey('one', 8080), request({ hostPort: 8080 }));
    await registry.openL(tunnelLKey('one', 8081), request({ hostPort: 8081 }));
    await registry.openL(tunnelLKey('two', 8080), request({ hostPort: 8080 }));

    await registry.closeSandbox('one');
    expect(registry.forSandbox('one')).toHaveLength(0);
    expect(registry.forSandbox('two')).toHaveLength(1);
    expect(h.spawned.map((child) => child.kills)).toEqual([1, 1, 0]);
  });

  it('replaces a down -L handle with a fresh tunnel for the same key', async () => {
    const crash = { on: false };
    const h = harness({
      onSpawn: (child) => {
        if (crash.on) queueMicrotask(() => child.exit(255, 'ssh: gone'));
      },
    });
    const registry = createTunnelRegistry(h.deps);
    const handle = await registry.openL(KEY_L, request());

    crash.on = true;
    h.connectOk = false;
    h.spawned[0]!.exit(255, 'ssh: reset');
    await advance(0);
    await advance(TUNNEL_BACKOFF_MAX_MS * 10);
    expect(handle.state).toBe('down');

    crash.on = false;
    h.connectOk = true;
    const fresh = await registry.openL(KEY_L, request());
    expect(fresh).not.toBe(handle);
    expect(fresh.state).toBe('up');
  });

  it('shares one -R tunnel between two tickets and closes it at the last release', async () => {
    const h = harness();
    const registry = createTunnelRegistry(h.deps);
    const key = tunnelRKey('devbox', 5432);
    const opening = registry.acquireR(key, 7, request({ hostPort: 5432, remotePort: 5432 }));
    await advance(TUNNEL_R_READY_MS);
    const first = await opening;

    const second = await registry.acquireR(key, 8, request({ hostPort: 5432, remotePort: 5432 }));
    expect(second).toBe(first);
    expect(h.spawned).toHaveLength(1);
    expect(key).toBe('devbox:R:5432');
    expect(registry.heldR('devbox', 7)).toEqual([5432]);
    expect(registry.heldR('devbox', 8)).toEqual([5432]);

    await registry.releaseR(key, 7);
    expect(first.state).toBe('up');
    expect(h.spawned[0]!.kills).toBe(0);
    expect(registry.heldR('devbox', 7)).toEqual([]);

    await registry.releaseR(key, 8);
    expect(first.state).toBe('down');
    expect(h.spawned[0]!.kills).toBe(1);
  });

  it('releases every -R port a ticket holds', async () => {
    const h = harness();
    const registry = createTunnelRegistry(h.deps);
    const one = registry.acquireR(tunnelRKey('devbox', 5432), 7, request({ hostPort: 5432, remotePort: 5432 }));
    const two = registry.acquireR(tunnelRKey('devbox', 6379), 7, request({ hostPort: 6379, remotePort: 6379 }));
    await advance(TUNNEL_R_READY_MS);
    await Promise.all([one, two]);

    expect(registry.heldR('devbox', 7)).toEqual([5432, 6379]);
    expect(registry.heldR('other', 7)).toEqual([]);

    await registry.releaseTicket('devbox', 7);
    expect(registry.heldR('devbox', 7)).toEqual([]);
    expect(h.spawned.map((child) => child.kills)).toEqual([1, 1]);
  });

  it('re-opens a down -R tunnel when a holder asks again', async () => {
    const crash = { on: false };
    const h = harness({
      onSpawn: (child) => {
        if (crash.on) queueMicrotask(() => child.exit(255, 'ssh: gone'));
      },
    });
    const registry = createTunnelRegistry(h.deps);
    const key = tunnelRKey('devbox', 5432);
    const target = request({ hostPort: 5432, remotePort: 5432 });
    const opening = registry.acquireR(key, 7, target);
    await advance(TUNNEL_R_READY_MS);
    const handle = await opening;

    crash.on = true;
    h.spawned[0]!.exit(255, 'ssh: reset');
    await advance(0);
    await advance(TUNNEL_BACKOFF_MAX_MS * 10);
    expect(handle.state).toBe('down');

    crash.on = false;
    const reopened = registry.acquireR(key, 7, target);
    await advance(TUNNEL_R_READY_MS);
    const fresh = await reopened;
    expect(fresh).not.toBe(handle);
    expect(fresh.state).toBe('up');
    expect(h.spawned).toHaveLength(2 + TUNNEL_MAX_ATTEMPTS);
  });

  it('closeAll closes both kinds', async () => {
    const h = harness();
    const registry = createTunnelRegistry(h.deps);
    await registry.openL(KEY_L, request());
    const r = registry.acquireR(KEY_R, 7, request({ hostPort: 5432, remotePort: 5432 }));
    await advance(TUNNEL_R_READY_MS);
    await r;

    await registry.closeAll();
    expect(h.spawned.every((child) => child.kills === 1)).toBe(true);
    expect(registry.list()).toHaveLength(0);
  });
});
