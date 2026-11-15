import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Owner is the extension-host pid. A live owner keeps its claim only while it refreshes the heartbeat file (arch:GATE-CONCURRENCY). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** How often a holder sets the mtime of its `heartbeat` file (arch:GATE-CONCURRENCY). */
export const CLAIM_HEARTBEAT_MS = 30_000;
/** A claim whose `heartbeat` mtime is older than this is stale, even when the owner pid is alive (arch:GATE-CONCURRENCY). */
export const CLAIM_HEARTBEAT_STALE_MS = 5 * 60_000;
const NO_OWNER_STALE_MS = 60_000;
/** The reclaim mutex guards a few fs calls; one older than this belongs to a dead holder. */
const RECLAIM_LOCK_STALE_MS = 10_000;

/** A heartbeat mtime seen stale, and when this waiter first saw that value (monotonic clock). */
type Suspects = Map<string, { mtimeMs: number; at: number }>;

/**
 * A stale heartbeat only counts when the same mtime stays stale for one full heartbeat period
 * of this waiter's monotonic clock. After a host sleep the wall clock jumps, but the holder
 * beats again within one period of the wake, which changes the mtime and clears the suspicion.
 */
function heartbeatConfirmed(suspects: Suspects, path: string, mtimeMs: number, heartbeatMs: number): boolean {
  const seen = suspects.get(path);
  if (seen === undefined || seen.mtimeMs !== mtimeMs) {
    suspects.set(path, { mtimeMs, at: performance.now() });
    return false;
  }
  return performance.now() - seen.at >= heartbeatMs;
}

interface StaleRules {
  isAlive: (pid: number) => boolean;
  heartbeatStaleMs: number;
  heartbeatMs: number;
  suspects: Suspects;
}

async function isStale(path: string, rules: StaleRules): Promise<boolean> {
  const { isAlive, heartbeatStaleMs, heartbeatMs, suspects } = rules;
  try {
    const mtimeMs = (await stat(join(path, 'heartbeat'))).mtimeMs;
    if (Date.now() - mtimeMs > heartbeatStaleMs) {
      if (heartbeatConfirmed(suspects, path, mtimeMs, heartbeatMs)) return true;
    } else {
      suspects.delete(path);
    }
  } catch {
    // No heartbeat file: a claim from older code, so only the pid rules apply.
  }
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

async function claimFresh(path: string, token: string): Promise<boolean> {
  try {
    await mkdir(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  await writeFile(join(path, 'owner'), String(process.pid));
  await writeFile(join(path, 'token'), token);
  await writeFile(join(path, 'heartbeat'), '');
  return true;
}

/**
 * Take over a stale claim. Check-then-remove-then-mkdir is not atomic: two
 * reclaimers could both see it stale, and the second `rm` would delete the
 * first's brand-new claim. A short mutex dir serialises the whole sequence; a
 * loser just reports "busy" and the lease loop polls again.
 */
async function reclaimStale(
  dir: string,
  path: string,
  rules: StaleRules,
  token: string,
): Promise<boolean> {
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
    if (!(await isStale(path, rules))) return false;
    await rm(path, { recursive: true, force: true });
    return await claimFresh(path, token);
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function tryClaim(
  dir: string,
  slot: number,
  rules: StaleRules,
  token: string,
): Promise<boolean> {
  const path = join(dir, `slot-${slot}`);
  if (await claimFresh(path, token)) return true;
  if (!(await isStale(path, rules))) return false;
  return reclaimStale(dir, path, rules, token);
}

export interface ClaimLeaseOptions {
  /** Pool directory; one `slot-<n>` claim directory per held slot. */
  dir: string;
  /** How many slots the pool has (whole number >= 1). */
  slots: number;
  pollMs?: number;
  signal?: AbortSignal;
  isAlive?: (pid: number) => boolean;
  /** Heartbeat period; default `CLAIM_HEARTBEAT_MS`. */
  heartbeatMs?: number;
  /** Heartbeat age that makes a claim stale; default `CLAIM_HEARTBEAT_STALE_MS`. */
  heartbeatStaleMs?: number;
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
 * every slot is held; never shares one. A slot whose owner pid is dead, or whose
 * heartbeat is stale, is reclaimed. Rejects with "aborted" when the signal fires during the wait.
 */
export async function leaseClaimSlot(opts: ClaimLeaseOptions): Promise<ClaimLease> {
  if (!Number.isInteger(opts.slots) || opts.slots < 1) {
    throw new Error(`claim lease slots must be a whole number >= 1, got ${opts.slots}`);
  }
  const isAlive = opts.isAlive ?? pidAlive;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const heartbeatMs = opts.heartbeatMs ?? CLAIM_HEARTBEAT_MS;
  const heartbeatStaleMs = opts.heartbeatStaleMs ?? CLAIM_HEARTBEAT_STALE_MS;
  const rules: StaleRules = { isAlive, heartbeatStaleMs, heartbeatMs, suspects: new Map() };
  const token = randomUUID();
  await mkdir(opts.dir, { recursive: true });
  let waited = false;
  for (;;) {
    if (opts.signal?.aborted) throw new Error('claim lease aborted');
    for (let slot = 0; slot < opts.slots; slot++) {
      if (!(await tryClaim(opts.dir, slot, rules, token))) continue;
      const claimPath = join(opts.dir, `slot-${slot}`);
      const ownsClaim = async (): Promise<boolean> => {
        try {
          return ((await readFile(join(claimPath, 'token'), 'utf8')) as string).trim() === token;
        } catch {
          return false;
        }
      };
      const beat = setInterval(() => { void heartbeat(); }, heartbeatMs);
      beat.unref();
      const heartbeat = async (): Promise<void> => {
        if (!(await ownsClaim())) {
          clearInterval(beat);
          return;
        }
        try {
          const now = new Date();
          await utimes(join(claimPath, 'heartbeat'), now, now);
        } catch {
          clearInterval(beat);
        }
      };
      let released = false;
      return {
        slot,
        release: async () => {
          if (released) return;
          released = true;
          clearInterval(beat);
          if (await ownsClaim()) await rm(claimPath, { recursive: true, force: true });
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
