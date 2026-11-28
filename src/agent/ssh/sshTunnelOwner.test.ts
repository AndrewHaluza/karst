import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import {
  NODE_OWNER_FS,
  OWNER_CLAIM_ATTEMPTS,
  OWNER_STALE_MS,
  TUNNEL_SHARE_POLL_MS,
  createTunnelOwnerStore,
  openSharedR,
  tunnelOwnerId,
  type OwnerFs,
  type SharedRDeps,
  type TunnelOwnerStore,
} from './sshTunnelOwner.js';
import {
  TUNNEL_R_READY_MS,
  TunnelOpenError,
  createTunnelRegistry,
  tunnelRKey,
  type TunnelChild,
  type TunnelHandle,
  type TunnelRequest,
} from './sshTunnels.js';

const REMOTE: RemoteDef = { host: 'vm.example.com', user: 'karst', mode: 'direct', remoteDir: '/srv/karst' };
const DIR = '/tmp/karst-ssh-0';
const ID = 'a'.repeat(32);
const PATH = `${DIR}/r-${ID}.owner`;

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** An in-memory `OwnerFs`: one map is one host's control dir. */
function memoryFs(files = new Map<string, string>()): OwnerFs & { readonly files: Map<string, string> } {
  return {
    files,
    createExclusive: (path, text) => {
      if (files.has(path)) return Promise.reject(errno('EEXIST'));
      files.set(path, text);
      return Promise.resolve();
    },
    read: (path) => {
      const text = files.get(path);
      return text === undefined ? Promise.reject(errno('ENOENT')) : Promise.resolve(text);
    },
    remove: (path) => (files.delete(path) ? Promise.resolve() : Promise.reject(errno('ENOENT'))),
  };
}

/** A `memoryFs` with mtimes on a fake clock: `touch` and `mtimeMs` work. */
function clockFs(files: Map<string, string>, clock: { t: number }) {
  const fs = memoryFs(files);
  const mtimes = new Map<string, number>([...files.keys()].map((k) => [k, clock.t]));
  return {
    ...fs,
    mtimes,
    createExclusive: async (path: string, text: string) => {
      await fs.createExclusive(path, text);
      mtimes.set(path, clock.t);
    },
    touch: (path: string, timeMs: number) => {
      mtimes.set(path, timeMs);
      return Promise.resolve();
    },
    mtimeMs: (path: string) => {
      const t = files.has(path) ? mtimes.get(path) : undefined;
      return t === undefined ? Promise.reject(errno('ENOENT')) : Promise.resolve(t);
    },
  } satisfies OwnerFs & { readonly mtimes: Map<string, number> };
}

describe('tunnelOwnerId', () => {
  it('is 32 hex characters and stable', () => {
    expect(tunnelOwnerId(REMOTE, 5432, 5432)).toMatch(/^[0-9a-f]{32}$/);
    expect(tunnelOwnerId(REMOTE, 5432, 5432)).toBe(tunnelOwnerId({ ...REMOTE }, 5432, 5432));
  });

  it('treats a missing ssh port as port 22', () => {
    expect(tunnelOwnerId(REMOTE, 5432, 5432)).toBe(tunnelOwnerId({ ...REMOTE, port: 22 }, 5432, 5432));
  });

  it('differs for each login, host, ssh port, remote port and host port', () => {
    const base = tunnelOwnerId(REMOTE, 5432, 5432);
    const others = [
      tunnelOwnerId({ ...REMOTE, user: 'other' }, 5432, 5432),
      tunnelOwnerId({ ...REMOTE, host: 'other.example.com' }, 5432, 5432),
      tunnelOwnerId({ ...REMOTE, port: 2222 }, 5432, 5432),
      tunnelOwnerId(REMOTE, 5433, 5432),
      tunnelOwnerId(REMOTE, 5432, 5433),
    ];
    expect(new Set([base, ...others]).size).toBe(6);
  });
});

describe('createTunnelOwnerStore', () => {
  const store = (fs: OwnerFs, pid = 100, alive: readonly number[] = []): TunnelOwnerStore =>
    createTunnelOwnerStore({ pid, fs, isAlive: (p) => alive.includes(p) });

  it('owns a free marker and writes its pid', async () => {
    const fs = memoryFs();
    await expect(store(fs).claim(DIR, ID)).resolves.toBe('owned');
    expect(fs.files.get(PATH)).toBe('100');
  });

  it('owns a marker that already holds its own pid', async () => {
    const fs = memoryFs(new Map([[PATH, '100\n']]));
    await expect(store(fs).claim(DIR, ID)).resolves.toBe('owned');
  });

  it('shares a marker of another live pid and leaves it', async () => {
    const fs = memoryFs(new Map([[PATH, '200']]));
    await expect(store(fs, 100, [200]).claim(DIR, ID)).resolves.toBe('shared');
    expect(fs.files.get(PATH)).toBe('200');
  });

  it('takes over a marker of a dead pid', async () => {
    const fs = memoryFs(new Map([[PATH, '200']]));
    await expect(store(fs).claim(DIR, ID)).resolves.toBe('owned');
    expect(fs.files.get(PATH)).toBe('100');
  });

  it.each(['', 'abc', '0', '-5', '12 13'])('takes over a marker that holds %j', async (text) => {
    const fs = memoryFs(new Map([[PATH, text]]));
    const isAlive = vi.fn(() => true);
    await expect(createTunnelOwnerStore({ pid: 100, fs, isAlive }).claim(DIR, ID)).resolves.toBe('owned');
    expect(isAlive).not.toHaveBeenCalled();
    expect(fs.files.get(PATH)).toBe('100');
  });

  it('creates again when the owner released between the create and the read', async () => {
    const fs = memoryFs();
    let first = true;
    const racing: OwnerFs = {
      ...fs,
      createExclusive: (path, text) => {
        if (first) {
          first = false;
          return Promise.reject(errno('EEXIST'));
        }
        return fs.createExclusive(path, text);
      },
    };
    await expect(store(racing).claim(DIR, ID)).resolves.toBe('owned');
    expect(fs.files.get(PATH)).toBe('100');
  });

  it(`gives up after ${String(OWNER_CLAIM_ATTEMPTS)} tries that do not settle`, async () => {
    const createExclusive = vi.fn(() => Promise.reject(errno('EEXIST')));
    const fs: OwnerFs = { createExclusive, read: () => Promise.resolve('200'), remove: () => Promise.resolve() };
    await expect(store(fs).claim(DIR, ID)).rejects.toThrow(`ssh: the -R owner marker ${ID} did not settle`);
    expect(createExclusive).toHaveBeenCalledTimes(OWNER_CLAIM_ATTEMPTS);
  });

  it('rethrows a create, read or remove failure that is not the expected code', async () => {
    const base = memoryFs(new Map([[PATH, '200']]));
    await expect(store({ ...base, createExclusive: () => Promise.reject(errno('EACCES')) }).claim(DIR, ID)).rejects.toThrow('EACCES');
    await expect(store({ ...base, read: () => Promise.reject(errno('EIO')) }).claim(DIR, ID)).rejects.toThrow('EIO');
    await expect(store({ ...base, remove: () => Promise.reject(errno('EPERM')) }).claim(DIR, ID)).rejects.toThrow('EPERM');
  });

  it('takes over when the stale marker is already gone at the remove', async () => {
    const fs = memoryFs(new Map([[PATH, '200']]));
    const remove = vi.fn((path: string) => {
      fs.files.delete(path);
      return Promise.reject(errno('ENOENT'));
    });
    await expect(store({ ...fs, remove }).claim(DIR, ID)).resolves.toBe('owned');
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('releases only its own marker', async () => {
    const own = memoryFs(new Map([[PATH, '100']]));
    await store(own).release(DIR, ID);
    expect(own.files.has(PATH)).toBe(false);

    const other = memoryFs(new Map([[PATH, '200']]));
    await store(other).release(DIR, ID);
    expect(other.files.get(PATH)).toBe('200');

    await expect(store(memoryFs()).release(DIR, ID)).resolves.toBeUndefined();
  });

  describe('heartbeat (a reused pid)', () => {
    const at = (fs: OwnerFs, clock: { t: number }, pid = 100): TunnelOwnerStore =>
      createTunnelOwnerStore({ pid, fs, isAlive: (p) => p === 200, now: () => clock.t });

    it('takes over a live pid marker with no heartbeat at two claims with one mtime', async () => {
      const clock = { t: 1_000 };
      const fs = clockFs(new Map([[PATH, '200']]), clock);
      const s = at(fs, clock);
      clock.t += OWNER_STALE_MS;
      await expect(s.claim(DIR, ID)).resolves.toBe('shared');
      clock.t += 1;
      await expect(s.claim(DIR, ID)).resolves.toBe('shared');
      clock.t += TUNNEL_SHARE_POLL_MS;
      await expect(s.claim(DIR, ID)).resolves.toBe('owned');
      expect(fs.files.get(PATH)).toBe('100');
    });

    it('keeps sharing when the owner touches the marker between the two claims (sleep and wake)', async () => {
      const clock = { t: 1_000 };
      const fs = clockFs(new Map([[PATH, '200']]), clock);
      const s = at(fs, clock);
      clock.t += OWNER_STALE_MS + 1;
      await expect(s.claim(DIR, ID)).resolves.toBe('shared');
      await at(fs, clock, 200).refresh(DIR, ID);
      clock.t += TUNNEL_SHARE_POLL_MS;
      await expect(s.claim(DIR, ID)).resolves.toBe('shared');
      // A fresh mark forgets the first look: one more old look is not enough.
      clock.t += OWNER_STALE_MS + 1;
      await expect(s.claim(DIR, ID)).resolves.toBe('shared');
      expect(fs.files.get(PATH)).toBe('200');
    });

    it('creates again when the marker goes between the read and the mtime', async () => {
      const clock = { t: 1_000 };
      const fs = clockFs(new Map([[PATH, '200']]), clock);
      const mtimeMs = (path: string) => {
        fs.files.delete(path);
        return Promise.reject(errno('ENOENT'));
      };
      await expect(at({ ...fs, mtimeMs }, clock).claim(DIR, ID)).resolves.toBe('owned');
      await expect(at({ ...fs, mtimeMs: () => Promise.reject(errno('EIO')) }, clock).claim(DIR, ID)).resolves.toBe('owned');
      fs.files.set(PATH, '200');
      await expect(at({ ...fs, mtimeMs: () => Promise.reject(errno('EIO')) }, clock).claim(DIR, ID)).rejects.toThrow('EIO');
    });

    it('refresh touches only its own marker, and is a no-op without touch', async () => {
      const clock = { t: 1_000 };
      const own = clockFs(new Map([[PATH, '100']]), clock);
      clock.t = 5_000;
      await at(own, clock).refresh(DIR, ID);
      expect(own.mtimes.get(PATH)).toBe(5_000);
      const other = clockFs(new Map([[PATH, '200']]), clock);
      clock.t = 9_000;
      await at(other, clock).refresh(DIR, ID);
      expect(other.mtimes.get(PATH)).toBe(5_000);
      await expect(store(memoryFs(new Map([[PATH, '100']]))).refresh(DIR, ID)).resolves.toBeUndefined();
    });
  });

  it('defaults to this process pid', async () => {
    const fs = memoryFs();
    await createTunnelOwnerStore({ fs }).claim(DIR, ID);
    expect(fs.files.get(PATH)).toBe(String(process.pid));
  });
});

describe('NODE_OWNER_FS', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'karst-owner-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a 0600 file once and refuses a second create with EEXIST', async () => {
    const path = join(dir, 'r-x.owner');
    await NODE_OWNER_FS.createExclusive(path, '42');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(NODE_OWNER_FS.createExclusive(path, '43')).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(NODE_OWNER_FS.read(path)).resolves.toBe('42');
    await NODE_OWNER_FS.remove(path);
    await expect(NODE_OWNER_FS.read(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('claims and releases through the real files', async () => {
    const store = createTunnelOwnerStore({ pid: 100, isAlive: () => false });
    await expect(store.claim(dir, ID)).resolves.toBe('owned');
    await store.release(dir, ID);
    await expect(NODE_OWNER_FS.read(join(dir, `r-${ID}.owner`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('touch sets the mtime that mtimeMs reads; mtimeMs of no file is ENOENT', async () => {
    const path = join(dir, 'r-y.owner');
    await NODE_OWNER_FS.createExclusive(path, '42');
    await NODE_OWNER_FS.touch!(path, 1_700_000_000_000);
    await expect(NODE_OWNER_FS.mtimeMs!(path)).resolves.toBe(1_700_000_000_000);
    await expect(NODE_OWNER_FS.mtimeMs!(join(dir, 'none'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

/** A handle the test drives: `fail()` is the watcher giving up. */
function fakeHandle(key: string): TunnelHandle & { state: 'up' | 'down'; closes: number } {
  const handle = {
    key,
    kind: 'R' as const,
    hostPort: 5432,
    remotePort: 5432,
    state: 'up' as 'up' | 'down',
    closes: 0,
    close: () => {
      handle.closes += 1;
      handle.state = 'down';
      return Promise.resolve();
    },
  };
  return handle;
}

describe('openSharedR', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  interface Rig {
    readonly deps: SharedRDeps;
    readonly fs: ReturnType<typeof memoryFs>;
    readonly alive: Set<number>;
    readonly opens: Array<{ readonly onDown: () => void; readonly handle: ReturnType<typeof fakeHandle> }>;
    readonly warn: ReturnType<typeof vi.fn>;
    readonly debug: ReturnType<typeof vi.fn>;
    openFails: Error | undefined;
    openDelayMs: number;
  }

  function rig(over: { readonly store?: TunnelOwnerStore } = {}): Rig {
    const fs = memoryFs();
    const alive = new Set<number>([100]);
    const warn = vi.fn();
    const debug = vi.fn();
    const r: Rig = {
      fs,
      alive,
      opens: [],
      warn,
      debug,
      openFails: undefined,
      openDelayMs: 0,
      deps: {
        store: over.store ?? createTunnelOwnerStore({ pid: 100, fs, isAlive: (p) => alive.has(p) }),
        dir: DIR,
        id: ID,
        open: async (onDown) => {
          if (r.openDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, r.openDelayMs));
          if (r.openFails !== undefined) throw r.openFails;
          const handle = fakeHandle('devbox:R:5432');
          r.opens.push({ onDown, handle });
          return handle;
        },
        schedule: (callback, ms) => {
          const timer = setTimeout(callback, ms);
          return () => clearTimeout(timer);
        },
        warn,
        debug,
      },
    };
    return r;
  }

  it('owns a free port: it opens its own forward and holds the marker', async () => {
    const r = rig();
    const handle = await openSharedR(r.deps, 'devbox:R:5432', 5432, 5432);
    expect(r.opens).toHaveLength(1);
    expect(handle.state).toBe('up');
    expect(handle.kind).toBe('R');
    expect([handle.key, handle.hostPort, handle.remotePort]).toEqual(['devbox:R:5432', 5432, 5432]);
    expect(r.fs.files.get(PATH)).toBe('100');

    r.opens[0]!.handle.state = 'down';
    expect(handle.state).toBe('down');
    await handle.close();
    expect(r.opens[0]!.handle.closes).toBe(1);
    expect(r.fs.files.has(PATH)).toBe(false);
  });

  it('shares a live owner: no open, up, and it takes over after the owner releases', async () => {
    const r = rig();
    r.fs.files.set(PATH, '200');
    r.alive.add(200);
    const handle = await openSharedR(r.deps, 'devbox:R:5432', 5432, 5432);
    expect(r.opens).toHaveLength(0);
    expect(handle.state).toBe('up');
    expect(handle.reason).toBeUndefined();
    expect(r.debug).toHaveBeenCalledWith(expect.stringContaining('another karst window forwards this port'));

    await vi.advanceTimersByTimeAsync(TUNNEL_SHARE_POLL_MS - 1);
    expect(r.opens).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.opens).toHaveLength(0);

    r.fs.files.delete(PATH);
    await vi.advanceTimersByTimeAsync(TUNNEL_SHARE_POLL_MS);
    expect(r.opens).toHaveLength(1);
    expect(r.fs.files.get(PATH)).toBe('100');
    expect(r.debug).toHaveBeenCalledWith(expect.stringContaining('this window forwards the port now'));
    r.opens[0]!.handle.state = 'down';
    expect(handle.state).toBe('down');
  });

  it('takes over when the owner pid dies', async () => {
    const r = rig();
    r.fs.files.set(PATH, '200');
    r.alive.add(200);
    await openSharedR(r.deps, 'devbox:R:5432', 5432, 5432);
    r.alive.delete(200);
    await vi.advanceTimersByTimeAsync(TUNNEL_SHARE_POLL_MS);
    expect(r.opens).toHaveLength(1);
    expect(r.fs.files.get(PATH)).toBe('100');
  });

  it('the owner touches its marker every poll interval until it closes', async () => {
    const r = rig();
    const touches: number[] = [];
    const fs: OwnerFs = { ...r.fs, touch: (_p, t) => { touches.push(t); return Promise.resolve(); } };
    const store = createTunnelOwnerStore({ pid: 100, fs, isAlive: () => false, now: () => Date.now() });
    const handle = await openSharedR({ ...r.deps, store }, 'devbox:R:5432', 5432, 5432);
    await vi.advanceTimersByTimeAsync(TUNNEL_SHARE_POLL_MS - 1);
    expect(touches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(touches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(TUNNEL_SHARE_POLL_MS);
    expect(touches).toHaveLength(2);
    await handle.close();
    await vi.advanceTimersByTimeAsync(TUNNEL_SHARE_POLL_MS * 3);
    expect(touches).toHaveLength(2);
  });

  it('a sharer touches nothing, and an owner whose forward gave up stops its heartbeat', async () => {
    const r = rig();
    const refresh = vi.fn(() => Promise.resolve());
    const inner = createTunnelOwnerStore({ pid: 100, fs: r.fs, isAlive: (p) => r.alive.has(p) });
    const store: TunnelOwnerStore = { claim: (d, i) => inner.claim(d, i), release: (d, i) => inner.release(d, i), refresh };
    r.fs.files.set(PATH, '200');
    r.alive.add(200);
    const sharer = await openSharedR({ ...r.deps, store }, 'devbox:R:5432', 5432, 5432);
    await vi.advanceTimersByTimeAsync(TUNNEL_SHARE_POLL_MS * 2);
    expect(refresh).not.toHaveBeenCalled();
    await sharer.close();

    r.fs.files.delete(PATH);
    const owner = await openSharedR({ ...r.deps, store }, 'devbox:R:5432', 5432, 5432);
    expect(owner.state).toBe('up');
    r.opens.at(-1)!.onDown();
    await vi.advanceTimersByTimeAsync(TUNNEL_SHARE_POLL_MS * 2);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('releases the marker when its own forward gives up', async () => {
    const r = rig();
    await openSharedR(r.deps, 'devbox:R:5432', 5432, 5432);
    r.opens[0]!.onDown();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.fs.files.has(PATH)).toBe(false);
  });

  it('releases the marker and rejects when its own first open fails', async () => {
    const r = rig();
    r.openFails = new TunnelOpenError('devbox:R:5432', 'ssh: remote port forwarding failed', '', false);
    await expect(openSharedR(r.deps, 'devbox:R:5432', 5432, 5432)).rejects.toThrow('remote port forwarding failed');
    expect(r.fs.files.has(PATH)).toBe(false);
  });

  it('is down with the reason when a take-over open fails', async () => {
    const r = rig();
    r.fs.files.set(PATH, '200');
    r.alive.add(200);
    const handle = await openSharedR(r.deps, 'devbox:R:5432', 5432, 5432);
    r.alive.delete(200);
    r.openFails = new Error('ssh: remote port forwarding failed for listen port 5432');
    await vi.advanceTimersByTimeAsync(TUNNEL_SHARE_POLL_MS);
    expect(handle.state).toBe('down');
    expect(handle.reason).toBe('ssh: remote port forwarding failed for listen port 5432');
    expect(r.warn).toHaveBeenCalledWith('[ssh] tunnel devbox:R:5432 is down: ssh: remote port forwarding failed for listen port 5432');
    expect(r.fs.files.has(PATH)).toBe(false);
    await vi.advanceTimersByTimeAsync(TUNNEL_SHARE_POLL_MS * 3);
    expect(r.opens).toHaveLength(0);
  });

  it('stops the poll on close and is down', async () => {
    const r = rig();
    r.fs.files.set(PATH, '200');
    r.alive.add(200);
    const handle = await openSharedR(r.deps, 'devbox:R:5432', 5432, 5432);
    await handle.close();
    await handle.close();
    expect(handle.state).toBe('down');
    r.fs.files.delete(PATH);
    await vi.advanceTimersByTimeAsync(TUNNEL_SHARE_POLL_MS * 3);
    expect(r.opens).toHaveLength(0);
    expect(r.fs.files.has(PATH)).toBe(false);
  });

  it('gives the marker back when it is closed during a take-over claim', async () => {
    const r = rig();
    r.fs.files.set(PATH, '200');
    r.alive.add(200);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = createTunnelOwnerStore({ pid: 100, fs: r.fs, isAlive: (p) => r.alive.has(p) });
    let calls = 0;
    const slow: TunnelOwnerStore = {
      claim: async (dir, id) => {
        calls += 1;
        if (calls > 1) await gate;
        return inner.claim(dir, id);
      },
      release: (dir, id) => inner.release(dir, id),
      refresh: (dir, id) => inner.refresh(dir, id),
    };
    const handle = await openSharedR({ ...r.deps, store: slow }, 'devbox:R:5432', 5432, 5432);
    r.fs.files.delete(PATH);
    await vi.advanceTimersByTimeAsync(TUNNEL_SHARE_POLL_MS);
    const closing = handle.close();
    release();
    await closing;
    await vi.advanceTimersByTimeAsync(0);
    expect(r.opens).toHaveLength(0);
    expect(r.fs.files.has(PATH)).toBe(false);
  });

  it('closes the new forward when it is closed during a take-over open', async () => {
    const r = rig();
    r.fs.files.set(PATH, '200');
    r.alive.add(200);
    const handle = await openSharedR(r.deps, 'devbox:R:5432', 5432, 5432);
    r.alive.delete(200);
    r.openDelayMs = 1000;
    await vi.advanceTimersByTimeAsync(TUNNEL_SHARE_POLL_MS);
    await handle.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.opens).toHaveLength(1);
    expect(r.opens[0]!.handle.closes).toBe(1);
    expect(r.fs.files.has(PATH)).toBe(false);
    expect(r.debug).not.toHaveBeenCalledWith(expect.stringContaining('this window forwards the port now'));
  });

  it('opens without a marker when the store fails, and logs it', async () => {
    const r = rig({
      store: {
        claim: () => Promise.reject(new Error('EACCES')),
        release: () => Promise.reject(new Error('EROFS')),
        refresh: () => Promise.reject(new Error('EIO')),
      },
    });
    const handle = await openSharedR(r.deps, 'devbox:R:5432', 5432, 5432);
    expect(r.opens).toHaveLength(1);
    expect(r.debug).toHaveBeenCalledWith('[ssh] tunnel devbox:R:5432: owner marker failed, opening without it: EACCES');
    await vi.advanceTimersByTimeAsync(TUNNEL_SHARE_POLL_MS);
    expect(r.debug).toHaveBeenCalledWith('[ssh] tunnel devbox:R:5432: owner marker heartbeat failed: EIO');
    await handle.close();
    expect(r.debug).toHaveBeenCalledWith('[ssh] tunnel devbox:R:5432: owner marker release failed: EROFS');
  });
});

/** A fake ssh `-R` child over one remote port table: a bound port refuses the next bind. */
class RemoteChild extends EventEmitter {
  readonly stderr = new EventEmitter();
  constructor(
    private readonly bound: Set<number>,
    private readonly port: number,
  ) {
    super();
    if (bound.has(port)) {
      queueMicrotask(() => {
        this.stderr.emit('data', `Error: remote port forwarding failed for listen port ${String(port)}\n`);
        this.emit('exit', 255, null);
      });
    } else {
      bound.add(port);
    }
  }
  kill(): boolean {
    this.bound.delete(this.port);
    this.emit('exit', null, 'SIGTERM');
    return true;
  }
}

describe('two windows on one remote -R port', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const request: TunnelRequest = { remote: REMOTE, controlDir: DIR, hostPort: 5432, remotePort: 5432 };
  const key = tunnelRKey('devbox', 5432);

  function windows(): {
    readonly a: ReturnType<typeof createTunnelRegistry>;
    readonly b: ReturnType<typeof createTunnelRegistry>;
    readonly bound: Set<number>;
    readonly spawns: { a: number; b: number };
    readonly fs: ReturnType<typeof memoryFs>;
  } {
    const bound = new Set<number>();
    const fs = memoryFs();
    const alive = new Set([100, 200]);
    const spawns = { a: 0, b: 0 };
    const window = (pid: number, name: 'a' | 'b') =>
      createTunnelRegistry({
        spawn: (argv): TunnelChild => {
          spawns[name] += 1;
          const spec = argv[argv.indexOf('-R') + 1]!;
          return new RemoteChild(bound, Number(spec.split(':')[1])) as unknown as TunnelChild;
        },
        connect: () => Promise.resolve(true),
        portInUse: () => Promise.resolve(false),
        rOwner: createTunnelOwnerStore({ pid, fs, isAlive: (p) => alive.has(p) }),
      });
    return { a: window(100, 'a'), b: window(200, 'b'), bound, spawns, fs };
  }

  it('keeps the baseline of the second window when the first one releases', async () => {
    const w = windows();
    const opening = w.a.acquireR(key, 7, request);
    await vi.advanceTimersByTimeAsync(TUNNEL_R_READY_MS);
    await expect(opening).resolves.toMatchObject({ state: 'up' });

    const shared = await w.b.acquireR(key, 8, request);
    expect(shared.state).toBe('up');
    expect(w.spawns).toEqual({ a: 1, b: 0 });
    expect(w.b.heldR('devbox', 8)).toEqual([5432]);

    await w.a.releaseR(key, 7);
    expect(w.bound.has(5432)).toBe(false);
    await vi.advanceTimersByTimeAsync(TUNNEL_SHARE_POLL_MS + TUNNEL_R_READY_MS);
    expect(w.spawns).toEqual({ a: 1, b: 1 });
    expect(w.bound.has(5432)).toBe(true);
    expect(shared.state).toBe('up');

    await w.b.closeAll();
    expect(w.bound.has(5432)).toBe(false);
    expect(w.fs.files.size).toBe(0);
  });

  it('still refuses a remote port that another program holds', async () => {
    const w = windows();
    w.bound.add(5432);
    const opening = w.b.acquireR(key, 8, request);
    const outcome = expect(opening).rejects.toThrow(/remote port forwarding failed/);
    await vi.advanceTimersByTimeAsync(TUNNEL_R_READY_MS);
    await outcome;
    expect(w.b.heldR('devbox', 8)).toEqual([]);
    expect(w.fs.files.size).toBe(0);
  });
});
