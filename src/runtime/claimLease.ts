import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Owner is the extension-host pid: slots are per HOST process, so a slot a live host leaks stays held until the host exits. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const NO_OWNER_STALE_MS = 60_000;
/** The reclaim mutex guards a few fs calls; one older than this belongs to a dead holder. */
const RECLAIM_LOCK_STALE_MS = 10_000;

async function isStale(path: string, isAlive: (pid: number) => boolean): Promise<boolean> {
  try {
    return !isAlive(Number(((await readFile(join(path, 'owner'), 'utf8')) as string).trim()));
  } catch {
    // Claim dir exists but its owner file is not written yet (mid-claim) or never was.
    try {
      return Date.now() - (await stat(path)).mtimeMs > NO_OWNER_STALE_MS;
    } catch {
      return true;
    }
  }
}

async function claimFresh(path: string): Promise<boolean> {
  try {
    await mkdir(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  await writeFile(join(path, 'owner'), String(process.pid));
  return true;
}

/**
 * Take over a stale claim. Check-then-remove-then-mkdir is not atomic: two
 * reclaimers could both see it stale, and the second `rm` would delete the
 * first's brand-new claim. A short mutex dir serialises the whole sequence; a
 * loser just reports "busy" and the lease loop polls again.
 */
async function reclaimStale(dir: string, path: string, isAlive: (pid: number) => boolean): Promise<boolean> {
  const lock = join(dir, 'reclaim.lock');
  try {
    await mkdir(lock);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const age = await stat(lock).then((st) => Date.now() - st.mtimeMs, () => 0);
    if (age > RECLAIM_LOCK_STALE_MS) await rm(lock, { recursive: true, force: true });
    return false;
  }
  try {
    if (!(await isStale(path, isAlive))) return false;
    await rm(path, { recursive: true, force: true });
    return await claimFresh(path);
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function tryClaim(dir: string, slot: number, isAlive: (pid: number) => boolean): Promise<boolean> {
  const path = join(dir, `slot-${slot}`);
  if (await claimFresh(path)) return true;
  if (!(await isStale(path, isAlive))) return false;
  return reclaimStale(dir, path, isAlive);
}

export interface ClaimLeaseOptions {
  /** Pool directory; one `slot-<n>` claim directory per held slot. */
  dir: string;
  /** How many slots the pool has (whole number >= 1). */
  slots: number;
  pollMs?: number;
  signal?: AbortSignal;
  isAlive?: (pid: number) => boolean;
  /** Called once, when the first pass finds every slot held, with the held count. */
  onWait?: (held: number) => void;
}

export interface ClaimLease {
  slot: number;
  release: () => Promise<void>;
}

const DEFAULT_POLL_MS = 2_000;

/**
 * Lease one of `slots` host-wide slots from a claim-directory pool. Waits while
 * every slot is held; never shares one. A slot whose owner pid is dead is
 * reclaimed. Rejects with "aborted" when the signal fires during the wait.
 */
export async function leaseClaimSlot(opts: ClaimLeaseOptions): Promise<ClaimLease> {
  if (!Number.isInteger(opts.slots) || opts.slots < 1) {
    throw new Error(`claim lease slots must be a whole number >= 1, got ${opts.slots}`);
  }
  const isAlive = opts.isAlive ?? pidAlive;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  await mkdir(opts.dir, { recursive: true });
  let waited = false;
  for (;;) {
    if (opts.signal?.aborted) throw new Error('claim lease aborted');
    for (let slot = 0; slot < opts.slots; slot++) {
      if (!(await tryClaim(opts.dir, slot, isAlive))) continue;
      let released = false;
      return {
        slot,
        release: async () => {
          if (released) return;
          released = true;
          await rm(join(opts.dir, `slot-${slot}`), { recursive: true, force: true });
        },
      };
    }
    if (!waited) {
      opts.onWait?.(opts.slots);
      waited = true;
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, pollMs);
      opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
}
