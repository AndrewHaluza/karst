/**
 * Cross-window ownership of one `-R` forward (D823).
 *
 * Each window has its own tunnel registry, but the remote port that an `-R`
 * forward binds is one port for every window of this user on this host. A
 * second window that spawns the same forward fails its remote bind and would
 * lose the baseline. So the first window writes an owner marker (its pid) in
 * the private per-user control dir, and a window that finds a live owner
 * shares that forward and spawns nothing.
 *
 * The marker is the proof: the listener on the remote port is a karst `-R` of
 * this host, for the same remote and the same ports. A remote port that another
 * program holds has no marker, so its bind failure stays an error.
 *
 * A sharer polls every `TUNNEL_SHARE_POLL_MS`. When the owner closes, gives up,
 * or dies (a dead pid is a stale marker), the sharer claims the marker and opens
 * its own forward. The baseline is not reachable for up to one poll interval.
 *
 * Host-agnostic: the file seam, the pid check and the timers are injected.
 */
import { createHash } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RemoteDef } from '../../manifest/types.js';
import { pidAlive } from '../../runtime/pidAlive.js';
import type { TunnelHandle, TunnelState } from './sshTunnels.js';

/** How often a sharer checks the owner marker. */
export const TUNNEL_SHARE_POLL_MS = 5000;
/** Claim tries before the marker counts as unsettled (each try is one create or one stale removal). */
export const OWNER_CLAIM_ATTEMPTS = 3;
const OWNER_PID_RE = /^[1-9][0-9]{0,9}$/;
const DEFAULT_SSH_PORT = 22;

export type OwnerClaim = 'owned' | 'shared';

export interface TunnelOwnerStore {
  /** `owned`: this process holds the marker now. `shared`: another live process holds it. */
  claim(dir: string, id: string): Promise<OwnerClaim>;
  /** Remove the marker, only when this process holds it. */
  release(dir: string, id: string): Promise<void>;
}

/** The three file calls the store makes; each rejects with the node error code. */
export interface OwnerFs {
  /** Create the file; reject with `EEXIST` when it is already there. */
  createExclusive(path: string, text: string): Promise<void>;
  read(path: string): Promise<string>;
  remove(path: string): Promise<void>;
}

export const NODE_OWNER_FS: OwnerFs = {
  createExclusive: (path, text) => writeFile(path, text, { flag: 'wx', mode: 0o600 }),
  read: (path) => readFile(path, 'utf8'),
  remove: (path) => unlink(path),
};

export interface TunnelOwnerStoreOptions {
  readonly pid?: number;
  readonly isAlive?: (pid: number) => boolean;
  readonly fs?: OwnerFs;
}

/** One id for the same login, ssh port, remote port and host port. */
export function tunnelOwnerId(remote: RemoteDef, remotePort: number, hostPort: number): string {
  const identity = JSON.stringify([remote.user, remote.host, remote.port ?? DEFAULT_SSH_PORT, remotePort, hostPort]);
  return createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The owner pid, `missing` for no file, or `invalid` for text that is not a pid. */
async function readOwner(fs: OwnerFs, path: string): Promise<number | 'missing' | 'invalid'> {
  let text: string;
  try {
    text = await fs.read(path);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return 'missing';
    throw error;
  }
  const trimmed = text.trim();
  return OWNER_PID_RE.test(trimmed) ? Number(trimmed) : 'invalid';
}

async function removeMarker(fs: OwnerFs, path: string): Promise<void> {
  try {
    await fs.remove(path);
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error;
  }
}

/** The marker store in the control dir: an exclusive create is the claim. */
export function createTunnelOwnerStore(opts: TunnelOwnerStoreOptions = {}): TunnelOwnerStore {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? pidAlive;
  const fs = opts.fs ?? NODE_OWNER_FS;
  const pathOf = (dir: string, id: string): string => join(dir, `r-${id}.owner`);

  return {
    async claim(dir, id) {
      const path = pathOf(dir, id);
      for (let attempt = 0; attempt < OWNER_CLAIM_ATTEMPTS; attempt += 1) {
        try {
          await fs.createExclusive(path, String(pid));
          return 'owned';
        } catch (error) {
          if (codeOf(error) !== 'EEXIST') throw error;
        }
        const owner = await readOwner(fs, path);
        // The owner released it between the create and the read: create again.
        if (owner === 'missing') continue;
        if (owner === pid) return 'owned';
        if (owner !== 'invalid' && isAlive(owner)) return 'shared';
        await removeMarker(fs, path);
      }
      throw new Error(`ssh: the -R owner marker ${id} did not settle`);
    },
    async release(dir, id) {
      const path = pathOf(dir, id);
      if ((await readOwner(fs, path)) === pid) await removeMarker(fs, path);
    },
  };
}

export interface SharedRDeps {
  readonly store: TunnelOwnerStore;
  readonly dir: string;
  readonly id: string;
  /** Open this window's own `-R` forward; `onDown` runs when its watcher gives up. */
  open(onDown: () => void): Promise<TunnelHandle>;
  /** Run `callback` after `ms`; the result cancels it. */
  schedule(callback: () => void, ms: number): () => void;
  readonly warn?: (message: string) => void;
  readonly debug?: (message: string) => void;
}

/** An `-R` handle that owns the forward or shares the one of another window. */
class OwnedRForward implements TunnelHandle {
  readonly kind = 'R' as const;
  private inner: TunnelHandle | undefined;
  private owned = false;
  private closed = false;
  private failed: string | undefined;
  private cancelPoll: (() => void) | undefined;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly deps: SharedRDeps,
    readonly key: string,
    readonly hostPort: number,
    readonly remotePort: number,
  ) {}

  /** A shared forward is `up`: the owner window keeps it live. */
  get state(): TunnelState {
    if (this.inner !== undefined) return this.inner.state;
    return this.closed || this.failed !== undefined ? 'down' : 'up';
  }

  get reason(): string | undefined {
    return this.inner?.reason ?? this.failed;
  }

  async start(): Promise<TunnelHandle> {
    if ((await this.claim()) === 'shared') {
      this.deps.debug?.(`[ssh] tunnel ${this.key}: another karst window forwards this port; sharing it`);
      this.poll();
      return this;
    }
    await this.openOwned();
    return this;
  }

  close(): Promise<void> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<void> {
    this.closed = true;
    this.cancelPoll?.();
    this.cancelPoll = undefined;
    await this.inner?.close();
    await this.releaseMarker();
  }

  /** A marker the store cannot read or write never blocks the forward: it opens as before. */
  private async claim(): Promise<OwnerClaim> {
    try {
      return await this.deps.store.claim(this.deps.dir, this.deps.id);
    } catch (error) {
      this.deps.debug?.(`[ssh] tunnel ${this.key}: owner marker failed, opening without it: ${messageOf(error)}`);
      return 'owned';
    }
  }

  private async openOwned(): Promise<void> {
    this.owned = true;
    try {
      this.inner = await this.deps.open(() => void this.releaseMarker());
    } catch (error) {
      await this.releaseMarker();
      throw error;
    }
  }

  private poll(): void {
    this.cancelPoll = this.deps.schedule(() => {
      this.cancelPoll = undefined;
      void this.takeOver();
    }, TUNNEL_SHARE_POLL_MS);
  }

  private async takeOver(): Promise<void> {
    if (this.closed) return;
    const claim = await this.claim();
    if (this.closed) {
      this.owned = claim === 'owned';
      await this.releaseMarker();
      return;
    }
    if (claim === 'shared') {
      this.poll();
      return;
    }
    try {
      await this.openOwned();
    } catch (error) {
      this.failed = messageOf(error);
      this.deps.warn?.(`[ssh] tunnel ${this.key} is down: ${this.failed}`);
      return;
    }
    if (this.closed) {
      await this.inner?.close();
      return;
    }
    this.deps.debug?.(`[ssh] tunnel ${this.key}: the owner window is gone; this window forwards the port now`);
  }

  private async releaseMarker(): Promise<void> {
    if (!this.owned) return;
    this.owned = false;
    try {
      await this.deps.store.release(this.deps.dir, this.deps.id);
    } catch (error) {
      this.deps.debug?.(`[ssh] tunnel ${this.key}: owner marker release failed: ${messageOf(error)}`);
    }
  }
}

/** Own the forward, or share the one another live window owns. A failed own open rejects. */
export function openSharedR(deps: SharedRDeps, key: string, hostPort: number, remotePort: number): Promise<TunnelHandle> {
  return new OwnedRForward(deps, key, hostPort, remotePort).start();
}
