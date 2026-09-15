import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pidAlive } from './pidAlive.js';
import { baselineRoot } from './baselinePaths.js';

/**
 * A cross-process lock that lets exactly one IDE window start a given baseline
 * at a time.
 *
 * The in-memory `inFlight` map in `runtime/baseline.ts` serialises starts WITHIN
 * one window, but the `servers` table is shared by every window
 * (`docs/arch/store-and-schema.md`) while the map is not — and a baseline's row
 * is written only AFTER its health gate passes (`startHot`). Without a signal
 * that spans processes, a second window cannot tell a baseline that is
 * mid-start from one whose window crashed before writing a row: the first it
 * would clobber with a forced refresh, the second it would refuse to reap
 * forever. This lock is that signal.
 *
 * A file rather than a `servers` row on purpose: it must exist BEFORE the
 * checkout is touched and be provably alive or dead, and the owner's pid is the
 * only crash-proof liveness answer. It lives beside the checkout
 * (`<baselineRoot>/<service>.starting`), so a forced checkout inside the
 * checkout directory never touches it, and `rm -rf` of an invalid checkout
 * never removes it.
 */

interface LockRecord {
  pid: number;
  startedAt: number;
}

/**
 * How long a lock may outlive its owner before it counts as abandoned. The
 * owner's pid is the real signal; this only covers the case where the OS
 * reissued a dead owner's pid to an unrelated live process. A start is a fetch
 * (≤60s) plus a spawn and health gate (≤30s), so this is deliberately generous.
 */
const LOCK_TTL_MS = 10 * 60_000;

function lockPath(repoPath: string, service: string): string {
  return join(baselineRoot(repoPath), `${service}.starting`);
}

function readLock(path: string): LockRecord | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockRecord>;
    return typeof raw.pid === 'number' && typeof raw.startedAt === 'number'
      ? { pid: raw.pid, startedAt: raw.startedAt }
      : null;
  } catch {
    // Missing or corrupt → no usable lock; the acquirer removes and replaces it.
    return null;
  }
}

/** True when a LIVE, DIFFERENT process holds this lock. */
function lockHeld(path: string): boolean {
  const rec = readLock(path);
  if (!rec) return false;
  return rec.pid !== process.pid && pidAlive(rec.pid) && Date.now() - rec.startedAt < LOCK_TTL_MS;
}

/**
 * Claim the right to start `service`'s baseline. Atomic ACROSS processes: the
 * lock file is created exclusively (`wx`), so two windows cannot both win. A
 * lock whose owner has died — a crashed or force-quit IDE window — is stale and
 * taken over. Returns false when another live window holds it.
 */
export function acquireBaselineStartLock(repoPath: string, service: string): boolean {
  const path = lockPath(repoPath, service);
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), {
        flag: 'wx',
      });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (lockHeld(path)) return false;
      // Abandoned (dead owner) or ours from a re-entry: take it over.
      rmSync(path, { force: true });
    }
  }
  return false;
}

/** Release the lock, but only if WE still own it — never a lock taken over by another. */
export function releaseBaselineStartLock(repoPath: string, service: string): void {
  const path = lockPath(repoPath, service);
  if (readLock(path)?.pid !== process.pid) return;
  rmSync(path, { force: true });
}
