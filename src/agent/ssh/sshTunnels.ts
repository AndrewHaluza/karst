/**
 * Host-side ssh tunnels for a remote ticket (D823, edits 1 and 5).
 *
 * A published port of a remote service is a host `ssh -N -L` forward: the host
 * browser opens `127.0.0.1:<hostPort>` and ssh carries it to the remote
 * loopback. A baseline host port reaches a `direct` remote through `ssh -N -R`
 * for exactly the declared ports.
 *
 * `mux: false` is required (`ControlMaster=no`, `ControlPath=none`): a forward
 * made through a shared master stays open in the master after the client dies,
 * so the exit watcher would never see it end.
 *
 * The module is host-agnostic: the spawn seam, the loopback probe, the timers
 * and the log callbacks are injected (`docs/arch/debug-logging.md`
 * `@arch:DBG-01`, `@arch:DBG-03`). Nothing here blocks the event loop
 * (`@arch:EVENTLOOP`): a spawn is one child process and every wait is async.
 *
 * A tunnel process ends on a network drop or a remote sshd restart. The exit
 * watcher re-opens the same argv with a 1 s, 2 s, 4 s … 60 s backoff; after
 * `TUNNEL_MAX_ATTEMPTS` failed re-opens in a row the handle is `down` with the
 * last ssh stderr tail, and one WARN names the key and the reason. `close()`
 * sets the closed flag first, so an intended close never re-opens.
 */
import { connect as netConnect } from 'node:net';
import type { RemoteDef } from '../../manifest/types.js';
import type { PortListing } from '../sessionRunner.js';
import { sshDest, sshOptions, type SshProcess } from './sshProcess.js';
import { createTunnelOwnerStore, openSharedR, tunnelOwnerId, type TunnelOwnerStore } from './sshTunnelOwner.js';

export type TunnelKind = 'L' | 'R';
export type TunnelState = 'up' | 'reconnecting' | 'down';

/** First re-open delay; kept equal to the D556 forwarder values. */
export const TUNNEL_BACKOFF_START_MS = 1000;
/** The backoff stops here; a tunnel that outlives the window is still down. */
export const TUNNEL_BACKOFF_MAX_MS = 60000;
/** Failed re-opens in a row before the handle is `down`. */
export const TUNNEL_MAX_ATTEMPTS = 10;
/** A `-R` forward counts as live when the process is still alive after this. */
export const TUNNEL_R_READY_MS = 2000;
/** Bounded `-L` readiness: a forward that never listens fails the open. */
export const TUNNEL_L_READY_TIMEOUT_MS = 15000;
/** `-L` loopback poll interval. */
export const TUNNEL_L_POLL_MS = 250;

/** The ssh stderr tail a caller may surface in the ports UI. */
const STDERR_TAIL_MAX = 300;
/** How much stderr an attempt keeps in memory (a tail line is all a caller uses). */
const STDERR_BUFFER_MAX = 4000;

const L_KEY_RE = /^(.+):L:([1-9][0-9]{0,4})$/;
const R_KEY_RE = /^(.+):R:([1-9][0-9]{0,4})$/;

/** `Address already in use` on the host side, so `publish()` can repick the port. */
const HOST_PORT_TAKEN_RE =
  /address already in use|cannot listen to port|bind(?:ing)?[^\n]*\b(?:fail(?:ed|ure)?|in use|denied)\b/i;

function assertPort(port: number, what: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`ssh: ${what} ${JSON.stringify(port)} is not a TCP port`);
  }
}

/**
 * The exact tunnel argv: the hardened options with multiplexing off, `-N`, and
 * `ExitOnForwardFailure=yes` so a forward that cannot bind ends the process
 * instead of idling. Both sides are the loopback literal; never `0.0.0.0`,
 * never `*`, never a bare port.
 */
export function tunnelArgv(
  kind: TunnelKind,
  remote: RemoteDef,
  controlDir: string,
  hostPort: number,
  remotePort: number,
): string[] {
  assertPort(hostPort, 'host port');
  assertPort(remotePort, 'remote port');
  const spec =
    kind === 'L'
      ? `127.0.0.1:${String(hostPort)}:127.0.0.1:${String(remotePort)}`
      : `127.0.0.1:${String(remotePort)}:127.0.0.1:${String(hostPort)}`;
  return [
    ...sshOptions(remote, controlDir, { mux: false }),
    '-N',
    '-o',
    'ExitOnForwardFailure=yes',
    kind === 'L' ? '-L' : '-R',
    spec,
    '--',
    sshDest(remote),
  ];
}

/** `<sandboxName>:L:<hostPort>`: one `-L` handle per sandbox and published port. */
export function tunnelLKey(sandboxName: string, hostPort: number): string {
  return `${sandboxName}:L:${String(hostPort)}`;
}

/** `<remote>:R:<port>`: one `-R` tunnel per remote and port, shared by reference count. */
export function tunnelRKey(remote: string, port: number): string {
  return `${remote}:R:${String(port)}`;
}

/** 1 s, 2 s, 4 s … capped at `TUNNEL_BACKOFF_MAX_MS` (`attempt` is 0-based). */
export function tunnelBackoffMs(attempt: number): number {
  return Math.min(TUNNEL_BACKOFF_START_MS * 2 ** Math.max(0, attempt), TUNNEL_BACKOFF_MAX_MS);
}

/** The last {@link STDERR_TAIL_MAX} characters of ssh stderr; never argv, so no env value. */
function tailOf(stderr: string): string {
  return stderr.replace(/\s+$/, '').slice(-STDERR_TAIL_MAX);
}

/** A host-side bind failure, as the helper the `publishPort` caller reads. */
export function isHostPortTaken(stderr: string): boolean {
  return HOST_PORT_TAKEN_RE.test(stderr);
}

/** The first open failed; `portTaken` lets `publish()` move the host port and retry. */
export class TunnelOpenError extends Error {
  readonly key: string;
  readonly stderrTail: string;
  readonly portTaken: boolean;

  constructor(key: string, message: string, stderrTail: string, portTaken: boolean) {
    super(message);
    this.name = 'TunnelOpenError';
    this.key = key;
    this.stderrTail = stderrTail;
    this.portTaken = portTaken;
  }
}

/** The `ChildProcess` shape a tunnel reads; `SshProcess.spawnStream` returns one. */
export interface TunnelChild {
  readonly pid?: number;
  readonly stderr?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface TunnelDeps {
  /** One long-lived child for the tunnel argv (`SshProcess.spawnStream` in production). */
  spawn(argv: readonly string[]): TunnelChild;
  /** A TCP connect to `127.0.0.1:<port>`: `-L` readiness (and nothing else). */
  connect(port: number): Promise<boolean>;
  /**
   * Does another process already accept on `127.0.0.1:<port>`? Asked before each
   * `-L` spawn: a readiness connect cannot tell that process from the forward.
   */
  portInUse(port: number): Promise<boolean>;
  /** Defaults to the host timers; fake timers in tests. */
  setTimeout?(callback: () => void, ms: number): TimerHandle;
  clearTimeout?(handle: TimerHandle): void;
  /** One line when a tunnel gives up (the ports UI reads the handle, not this). */
  warn?(message: string): void;
  debug?(message: string): void;
  /** Cross-window `-R` owner markers (`sshTunnelOwner.ts`); without it each `-R` open spawns. */
  readonly rOwner?: TunnelOwnerStore;
}

export interface TunnelHandle {
  readonly key: string;
  readonly kind: TunnelKind;
  readonly hostPort: number;
  readonly remotePort: number;
  readonly state: TunnelState;
  /** The last ssh stderr tail, only while `down`. */
  readonly reason?: string;
  close(): Promise<void>;
}

/** What every tunnel needs; the registry adds the key and the kind. */
export interface TunnelRequest {
  readonly remote: RemoteDef;
  readonly controlDir: string;
  readonly hostPort: number;
  readonly remotePort: number;
}

export interface TunnelSpec extends TunnelRequest {
  readonly key: string;
  readonly kind: TunnelKind;
}

interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** One spawned tunnel process: its stderr tail and a single-settle exit promise. */
class TunnelAttempt {
  readonly child: TunnelChild;
  private text = '';
  private done = false;
  readonly exited: Promise<ExitInfo>;

  constructor(child: TunnelChild) {
    this.child = child;
    child.stderr?.on('data', (chunk) => {
      this.text = `${this.text}${Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk}`.slice(-STDERR_BUFFER_MAX);
    });
    this.exited = new Promise<ExitInfo>((resolve) => {
      child.on('exit', (code, signal) => {
        this.done = true;
        resolve({ code, signal });
      });
      child.on('error', (error) => {
        this.text = `${this.text}\n${error.message}`.slice(-STDERR_BUFFER_MAX);
        this.done = true;
        resolve({ code: null, signal: null });
      });
    });
  }

  get isExited(): boolean {
    return this.done;
  }

  stderr(): string {
    return this.text;
  }

  tail(): string {
    return tailOf(this.text);
  }
}

interface Sleep {
  readonly promise: Promise<void>;
  cancel(): void;
}

function scheduleTimeout(deps: TunnelDeps, callback: () => void, ms: number): TimerHandle {
  return deps.setTimeout === undefined ? setTimeout(callback, ms) : deps.setTimeout(callback, ms);
}

function cancelTimeout(deps: TunnelDeps, handle: TimerHandle): void {
  if (deps.clearTimeout === undefined) clearTimeout(handle);
  else deps.clearTimeout(handle);
}

function sleep(deps: TunnelDeps, ms: number): Sleep {
  let handle: TimerHandle | undefined;
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => {
    settle = () => {
      if (handle !== undefined) {
        cancelTimeout(deps, handle);
        handle = undefined;
      }
      resolve();
    };
    handle = scheduleTimeout(deps, () => {
      handle = undefined;
      resolve();
    }, ms);
  });
  return { promise, cancel: settle };
}

class Tunnel implements TunnelHandle {
  readonly key: string;
  readonly kind: TunnelKind;
  readonly hostPort: number;
  readonly remotePort: number;

  private readonly deps: TunnelDeps;
  private readonly argv: readonly string[];
  private current: TunnelState = 'reconnecting';
  private why: string | undefined;
  private attempt: TunnelAttempt | undefined;
  private retry: TimerHandle | undefined;
  private failures = 0;
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly onDown: (() => void) | undefined;

  constructor(deps: TunnelDeps, spec: TunnelSpec, argv: readonly string[], onDown?: () => void) {
    this.deps = deps;
    this.onDown = onDown;
    this.key = spec.key;
    this.kind = spec.kind;
    this.hostPort = spec.hostPort;
    this.remotePort = spec.remotePort;
    this.argv = argv;
  }

  get state(): TunnelState {
    return this.current;
  }

  get reason(): string | undefined {
    return this.why;
  }

  async start(): Promise<TunnelHandle> {
    if (await this.hostPortHeld()) {
      throw new TunnelOpenError(this.key, `ssh: ${this.key} tunnel failed: ${this.heldReason()}`, '', true);
    }
    const attempt = this.launch();
    if (!(await this.waitLive(attempt))) {
      attempt.child.kill();
      throw this.openError(attempt);
    }
    this.current = 'up';
    this.deps.debug?.(`[ssh] tunnel ${this.key}: up`);
    this.watch(attempt);
    return this;
  }

  close(): Promise<void> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<void> {
    this.closed = true;
    this.current = 'down';
    if (this.retry !== undefined) {
      cancelTimeout(this.deps, this.retry);
      this.retry = undefined;
    }
    const attempt = this.attempt;
    this.attempt = undefined;
    this.deps.debug?.(`[ssh] tunnel ${this.key}: closed`);
    attempt?.child.kill();
  }

  /**
   * A `-L` host port that answers before the spawn belongs to another process.
   * The readiness connect would reach that process and report `up` while ssh
   * fails its bind, so the open refuses instead.
   */
  private async hostPortHeld(): Promise<boolean> {
    if (this.kind !== 'L') return false;
    return this.deps.portInUse(this.hostPort).catch((error: unknown) => {
      // The ssh bind still fails on a held port (`ExitOnForwardFailure=yes`).
      this.deps.debug?.(`[ssh] tunnel ${this.key}: host port check failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    });
  }

  private heldReason(): string {
    return `host port ${String(this.hostPort)} is already in use`;
  }

  private launch(): TunnelAttempt {
    const attempt = new TunnelAttempt(this.deps.spawn(this.argv));
    this.attempt = attempt;
    return attempt;
  }

  private openError(attempt: TunnelAttempt): TunnelOpenError {
    const tail = attempt.tail();
    const detail = tail === '' ? '' : `: ${tail}`;
    return new TunnelOpenError(
      this.key,
      `ssh: ${this.key} tunnel failed${detail}`,
      tail,
      isHostPortTaken(attempt.stderr()),
    );
  }

  /**
   * `-L` is live when a loopback connect succeeds; `-R` is live when the process
   * is still alive after `TUNNEL_R_READY_MS` (with `ExitOnForwardFailure=yes`
   * a refused bind ends it before then).
   */
  private async waitLive(attempt: TunnelAttempt): Promise<boolean> {
    if (this.kind === 'R') {
      const wait = sleep(this.deps, TUNNEL_R_READY_MS);
      const live = await Promise.race<boolean>([
        attempt.exited.then(() => false),
        wait.promise.then(() => true),
      ]);
      wait.cancel();
      return live;
    }

    const polls = Math.max(1, Math.ceil(TUNNEL_L_READY_TIMEOUT_MS / TUNNEL_L_POLL_MS));
    for (let poll = 0; poll < polls; poll += 1) {
      if (attempt.isExited) return false;
      // The connect gets one poll interval; the pause below keeps the retry rate bounded.
      const probe = sleep(this.deps, TUNNEL_L_POLL_MS);
      const live = await Promise.race<boolean>([
        this.deps.connect(this.hostPort).then((ok) => ok, () => false),
        attempt.exited.then(() => false),
        probe.promise.then(() => false),
      ]);
      probe.cancel();
      if (live) return true;
      if (attempt.isExited) return false;

      const pause = sleep(this.deps, TUNNEL_L_POLL_MS);
      const exited = await Promise.race<boolean>([
        attempt.exited.then(() => true),
        pause.promise.then(() => false),
      ]);
      pause.cancel();
      if (exited) return false;
    }
    return false;
  }

  /** Attach the exit watcher to the attempt that is live now; a newer attempt wins. */
  private watch(attempt: TunnelAttempt): void {
    void attempt.exited.then(() => {
      if (this.closed || this.attempt !== attempt) return;
      this.current = 'reconnecting';
      this.deps.debug?.(`[ssh] tunnel ${this.key}: exited, scheduling re-open`);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.failures >= TUNNEL_MAX_ATTEMPTS) {
      this.giveUp();
      return;
    }
    const delay = tunnelBackoffMs(this.failures);
    this.failures += 1;
    this.deps.debug?.(
      `[ssh] tunnel ${this.key}: re-open in ${String(delay)} ms (attempt ${String(this.failures)}/${String(TUNNEL_MAX_ATTEMPTS)})`,
    );
    this.retry = scheduleTimeout(
      this.deps,
      () => {
        this.retry = undefined;
        if (this.closed) return;
        void this.reopen();
      },
      delay,
    );
  }

  private async reopen(): Promise<void> {
    if (await this.hostPortHeld()) {
      if (this.closed) return;
      this.why = this.heldReason();
      this.deps.debug?.(`[ssh] tunnel ${this.key}: ${this.why}`);
      this.scheduleReconnect();
      return;
    }
    if (this.closed) return;
    const attempt = this.launch();
    if (!(await this.waitLive(attempt))) {
      attempt.child.kill();
      this.why = attempt.tail();
      this.scheduleReconnect();
      return;
    }
    if (this.closed) {
      attempt.child.kill();
      return;
    }
    this.failures = 0;
    this.why = undefined;
    this.current = 'up';
    this.deps.debug?.(`[ssh] tunnel ${this.key}: re-opened`);
    this.watch(attempt);
  }

  private giveUp(): void {
    this.current = 'down';
    const tail = this.why;
    this.why =
      tail !== undefined && tail !== ''
        ? tail
        : `ssh: tunnel ${this.key} did not recover after ${String(TUNNEL_MAX_ATTEMPTS)} attempts`;
    this.deps.warn?.(`[ssh] tunnel ${this.key} is down: ${this.why}`);
    this.onDown?.();
  }
}

/**
 * Open one tunnel and resolve once it is live. The first open rejects
 * (`TunnelOpenError`) when the process exits first or `-L` never listens; the
 * exit watcher owns every later exit. `onDown` runs once when the watcher gives up.
 */
export async function openTunnel(deps: TunnelDeps, spec: TunnelSpec, onDown?: () => void): Promise<TunnelHandle> {
  const argv = tunnelArgv(spec.kind, spec.remote, spec.controlDir, spec.hostPort, spec.remotePort);
  deps.debug?.(
    `[ssh] tunnel ${spec.key}: opening -${spec.kind} ${String(spec.hostPort)} -> ${String(spec.remotePort)}`,
  );
  return new Tunnel(deps, spec, argv, onDown).start();
}

export interface TunnelRegistry {
  /** One `-L` handle per key; a `down` handle is replaced by a fresh tunnel. */
  openL(key: string, request: TunnelRequest): Promise<TunnelHandle>;
  closeL(key: string): Promise<void>;
  /** Handles whose key starts with `prefix` (both kinds; `''` = every tunnel). */
  list(prefix?: string): TunnelHandle[];
  /** The `-L` handles of one sandbox, with their state and reason. */
  forSandbox(sandboxName: string): TunnelHandle[];
  closeSandbox(sandboxName: string): Promise<void>;
  /** Open for the first holder, add a reference for the next; a `down` tunnel is re-opened. */
  acquireR(key: string, ticketId: number, request: TunnelRequest): Promise<TunnelHandle>;
  releaseR(key: string, ticketId: number): Promise<void>;
  /** Release every `-R` key the ticket holds on one remote. */
  releaseTicket(remote: string, ticketId: number): Promise<void>;
  /** The remote ports the ticket currently holds, ascending. */
  heldR(remote: string, ticketId: number): readonly number[];
  /** Window teardown: close every tunnel of both kinds. */
  closeAll(): Promise<void>;
}

interface LRecord {
  readonly sandboxName: string;
  readonly hostPort: number;
  readonly handle: TunnelHandle;
}

interface RRecord {
  readonly port: number;
  readonly holders: Set<number>;
  handle: TunnelHandle | undefined;
  opening: Promise<TunnelHandle> | undefined;
}

function parseLKey(key: string, hostPort: number): string {
  const match = L_KEY_RE.exec(key);
  if (match === null || Number(match[2]) !== hostPort) {
    throw new Error(`ssh: invalid -L tunnel key ${JSON.stringify(key)}`);
  }
  return match[1]!;
}

/** The sandbox name of a `-L` key, without needing the port (an open may still be in flight). */
function sandboxOfLKey(key: string): string | undefined {
  return L_KEY_RE.exec(key)?.[1];
}

function parseRKey(key: string, port: number): void {
  const match = R_KEY_RE.exec(key);
  if (match === null || Number(match[2]) !== port) {
    throw new Error(`ssh: invalid -R tunnel key ${JSON.stringify(key)}`);
  }
}

/**
 * The window's tunnels, keyed by the two key forms. Runners are rebuilt per
 * call, so the registry — not a runner — holds "which tunnel is live".
 */
export function createTunnelRegistry(deps: TunnelDeps): TunnelRegistry {
  const l = new Map<string, LRecord>();
  const r = new Map<string, RRecord>();
  const openingL = new Map<string, Promise<TunnelHandle>>();

  /**
   * The in-flight check and the in-flight set have no `await` between them, so
   * two concurrent callers on one key (a down key too) share one open.
   */
  async function openL(key: string, request: TunnelRequest): Promise<TunnelHandle> {
    const sandboxName = parseLKey(key, request.hostPort);
    const pending = openingL.get(key);
    if (pending !== undefined) return pending;
    const existing = l.get(key);
    if (existing !== undefined && existing.handle.state !== 'down') return existing.handle;
    // A down tunnel is replaced: its watcher is already stopped.
    if (existing !== undefined) l.delete(key);
    const closed = existing === undefined ? Promise.resolve() : existing.handle.close();

    const opening = closed
      .then(() => openTunnel(deps, { key, kind: 'L', ...request }))
      .then((handle) => {
        openingL.delete(key);
        l.set(key, { sandboxName, hostPort: request.hostPort, handle });
        return handle;
      })
      .catch((error: unknown) => {
        openingL.delete(key);
        throw error;
      });
    openingL.set(key, opening);
    return opening;
  }

  async function closeL(key: string): Promise<void> {
    const pending = openingL.get(key);
    if (pending !== undefined) {
      try {
        await (await pending).close();
      } catch {
        // The open failed: no tunnel is live.
      }
    }
    const record = l.get(key);
    l.delete(key);
    if (record !== undefined) await record.handle.close();
  }

  /** Own the `-R` forward, or share the one that a live window of this host owns. */
  function openR(key: string, request: TunnelRequest): Promise<TunnelHandle> {
    const spec: TunnelSpec = { key, kind: 'R', ...request };
    const store = deps.rOwner;
    if (store === undefined) return openTunnel(deps, spec);
    const schedule = (callback: () => void, ms: number): (() => void) => {
      const handle = scheduleTimeout(deps, callback, ms);
      return () => cancelTimeout(deps, handle);
    };
    const id = tunnelOwnerId(request.remote, request.remotePort, request.hostPort);
    const log = { warn: (m: string) => deps.warn?.(m), debug: (m: string) => deps.debug?.(m) };
    const open = (onDown: () => void): Promise<TunnelHandle> => openTunnel(deps, spec, onDown);
    return openSharedR({ store, dir: request.controlDir, id, schedule, open, ...log }, key, request.hostPort, request.remotePort);
  }

  async function ensureR(key: string, request: TunnelRequest, record: RRecord): Promise<TunnelHandle> {
    if (record.handle !== undefined && record.handle.state !== 'down') return record.handle;
    if (record.opening !== undefined) return record.opening;

    const opening = openR(key, request)
      .then((handle) => {
        record.handle = handle;
        record.opening = undefined;
        return handle;
      })
      .catch((error: unknown) => {
        record.opening = undefined;
        throw error;
      });
    record.opening = opening;
    return opening;
  }

  async function acquireR(key: string, ticketId: number, request: TunnelRequest): Promise<TunnelHandle> {
    parseRKey(key, request.remotePort);
    let record = r.get(key);
    if (record === undefined) {
      record = { port: request.remotePort, holders: new Set(), handle: undefined, opening: undefined };
      r.set(key, record);
    }
    record.holders.add(ticketId);
    try {
      return await ensureR(key, request, record);
    } catch (error) {
      record.holders.delete(ticketId);
      if (record.holders.size === 0 && r.get(key) === record) r.delete(key);
      throw error;
    }
  }

  async function releaseR(key: string, ticketId: number): Promise<void> {
    const record = r.get(key);
    if (record === undefined) return;
    record.holders.delete(ticketId);
    if (record.holders.size > 0) return;
    if (r.get(key) === record) r.delete(key);
    if (record.opening !== undefined) {
      try {
        await record.opening;
      } catch {
        return;
      }
    }
    if (record.handle !== undefined) await record.handle.close();
  }

  return {
    openL,
    closeL,
    list(prefix = '') {
      const handles: TunnelHandle[] = [];
      for (const [key, record] of l) if (key.startsWith(prefix)) handles.push(record.handle);
      for (const [key, record] of r) {
        if (record.handle !== undefined && key.startsWith(prefix)) handles.push(record.handle);
      }
      return handles;
    },
    forSandbox(sandboxName) {
      const handles: TunnelHandle[] = [];
      for (const record of l.values()) if (record.sandboxName === sandboxName) handles.push(record.handle);
      return handles;
    },
    async closeSandbox(sandboxName) {
      const keys = new Set<string>();
      for (const [key, record] of l) if (record.sandboxName === sandboxName) keys.add(key);
      for (const key of openingL.keys()) if (sandboxOfLKey(key) === sandboxName) keys.add(key);
      for (const key of keys) await closeL(key);
    },
    acquireR,
    releaseR,
    async releaseTicket(remote, ticketId) {
      const keys: string[] = [];
      for (const [key, record] of r) if (record.holders.has(ticketId)) keys.push(key);
      for (const key of keys) {
        const match = R_KEY_RE.exec(key);
        if (match === null || match[1] !== remote) continue;
        await releaseR(key, ticketId);
      }
    },
    heldR(remote, ticketId) {
      const ports: number[] = [];
      for (const [key, record] of r) {
        if (!record.holders.has(ticketId)) continue;
        const match = R_KEY_RE.exec(key);
        if (match === null || match[1] !== remote) continue;
        ports.push(record.port);
      }
      return ports.sort((a, b) => a - b);
    },
    /** Closes every tunnel at once: a window reload must not wait on each `-R` marker in series. */
    async closeAll() {
      const lClosed = [...new Set([...l.keys(), ...openingL.keys()])].map((key) => closeL(key));
      const records = [...r.values()];
      r.clear();
      const rClosed = records.map(async (record) => {
        if (record.opening === undefined) return record.handle?.close();
        // A failed open has no live tunnel to close.
        return (await record.opening.catch(() => undefined))?.close();
      });
      const failed = (await Promise.allSettled([...lClosed, ...rClosed])).find((o): o is PromiseRejectedResult => o.status === 'rejected');
      if (failed !== undefined) throw failed.reason;
    },
  };
}

/** A `listPorts` row for one `-L` handle: its ports, its state, and its reason while one is known. */
export function tunnelListing(handle: TunnelHandle): PortListing {
  return {
    hostPort: handle.hostPort,
    sandboxPort: handle.remotePort,
    state: handle.state,
    ...(handle.reason === undefined ? {} : { reason: handle.reason }),
  };
}

/** A loopback TCP connect: the `-L` host port check and readiness, the only network read in this module. */
export function probeLocalPort(port: number, timeoutMs = 1000): Promise<boolean> {
  assertPort(port, 'port');
  return new Promise<boolean>((resolve) => {
    const socket = netConnect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export interface TunnelDepsOptions {
  readonly warn?: (message: string) => void;
  readonly debug?: (message: string) => void;
  /** Override the loopback probe (tests). */
  readonly connect?: (port: number) => Promise<boolean>;
  /** Override the pre-spawn host port check (tests). */
  readonly portInUse?: (port: number) => Promise<boolean>;
  /** Override the `-R` owner markers (tests); default: files in the control dir. */
  readonly rOwner?: TunnelOwnerStore;
}

/** Production deps: the ssh seam's stream spawn, the loopback probe, the host timers. */
export function createTunnelDeps(
  ssh: Pick<SshProcess, 'spawnStream'>,
  opts: TunnelDepsOptions = {},
): TunnelDeps {
  return {
    spawn: (argv) => ssh.spawnStream(argv),
    connect: opts.connect ?? probeLocalPort,
    portInUse: opts.portInUse ?? probeLocalPort,
    rOwner: opts.rOwner ?? createTunnelOwnerStore(),
    ...(opts.warn === undefined ? {} : { warn: opts.warn }),
    ...(opts.debug === undefined ? {} : { debug: opts.debug }),
  };
}

let windowRegistry: TunnelRegistry | undefined;

/**
 * The window's registry: one per extension host process, created on first use
 * with that window's deps. Mirrors `WINDOW_SSH_GATE_REGISTRY` — a runner is
 * rebuilt per call, so tunnels must outlive it.
 */
export function windowTunnelRegistry(deps: TunnelDeps): TunnelRegistry {
  windowRegistry ??= createTunnelRegistry(deps);
  return windowRegistry;
}

/** Drop the window registry (tests, extension-host teardown). */
export function resetWindowTunnelRegistry(): void {
  windowRegistry = undefined;
}
