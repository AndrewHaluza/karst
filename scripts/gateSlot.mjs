// Host-wide gate slot lease for scripts (arch:GATE-CONCURRENCY).
//
// Same claim-directory layout and stale rules as src/runtime/claimLease.ts:
// `<dir>/<encoded gate>/slot-<n>/owner` holds the owner pid; a dead owner is
// reclaimed. The folder is a fixed path, so the extension host and an agent
// shell share one pool (macOS tmpdir() differs between them).

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pidAlive } from './playwrightSlot.mjs';

/** Set by `runGateList` while it holds the gate's slot, so the script does not wait for its own lease. */
export const LEASE_HELD_ENV = 'KARST_GATE_LEASE_HELD';
/** Overrides the pool folder (tests, unusual setups). Keep in step with `DEFAULT_GATE_SLOTS_DIR`. */
export const SLOTS_DIR_ENV = 'KARST_GATE_SLOTS_DIR';
export const GATE_POLL_MS = 2_000;
const NO_OWNER_STALE_MS = 60_000;
/** Heartbeat period of a held lease. Keep in step with src/runtime/claimLease.ts (arch:GATE-CONCURRENCY). */
export const CLAIM_HEARTBEAT_MS = 30_000;
/** A claim whose `heartbeat` file is older than this is stale, even when the owner pid is alive. Keep in step with src/runtime/claimLease.ts. */
export const CLAIM_HEARTBEAT_STALE_MS = 5 * 60_000;

export const defaultGateSlotsDir = (env = process.env) => env[SLOTS_DIR_ENV] || join(homedir(), '.karst', 'gate-slots');

export const leaseHeld = (env = process.env) => env[LEASE_HELD_ENV] === '1';

/** One safe directory name per gate name; same as `gatePoolName` in gateLease.ts. */
export const gatePoolName = (name) => encodeURIComponent(name).replace(/\./g, '%2E');

const readOwner = (path) => {
  try {
    return Number(readFileSync(join(path, 'owner'), 'utf8').trim());
  } catch {
    return null;
  }
};

function isStale(path, alive, staleMs) {
  try {
    if (Date.now() - statSync(join(path, 'heartbeat')).mtimeMs > staleMs) return true;
  } catch { /* no heartbeat file: a claim of older code, old rules only */ }
  const pid = readOwner(path);
  if (pid !== null) return !alive(pid);
  try {
    return Date.now() - statSync(path).mtimeMs > NO_OWNER_STALE_MS;
  } catch {
    return true;
  }
}

function claim(path, ticket, token) {
  try {
    mkdirSync(path);
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  writeFileSync(join(path, 'owner'), String(process.pid));
  writeFileSync(join(path, 'token'), token);
  writeFileSync(join(path, 'heartbeat'), '');
  if (ticket) writeFileSync(join(path, 'ticket'), ticket);
  return true;
}

function tryClaim(dir, slot, alive, ticket, staleMs, token) {
  const path = join(dir, `slot-${slot}`);
  if (claim(path, ticket, token)) return true;
  if (!isStale(path, alive, staleMs)) return false;
  // Serialise the reclaim: a short mutex dir, as in claimLease.ts.
  const lock = join(dir, 'reclaim.lock');
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { recursive: true, force: true });
    } catch { /* lock vanished */ }
    return false;
  }
  try {
    if (!isStale(path, alive, staleMs)) return false;
    rmSync(path, { recursive: true, force: true });
    return claim(path, ticket, token);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function holderOf(dir, slots) {
  for (let slot = 0; slot < slots; slot++) {
    const path = join(dir, `slot-${slot}`);
    const pid = readOwner(path);
    if (pid === null) continue;
    let ticket = null;
    try {
      ticket = readFileSync(join(path, 'ticket'), 'utf8').trim() || null;
    } catch { /* no ticket recorded */ }
    return { pid, ticket };
  }
  return { pid: null, ticket: null };
}

/**
 * Lease one of `slots` slots of the gate pool. `onWait({pid, ticket})` fires once when all are held.
 * Rejects with "aborted" when the signal fires. `release()` is idempotent and synchronous, so an exit handler can call it.
 */
export async function acquireGateSlot(gate, { dir = defaultGateSlotsDir(), slots = 1, pollMs = GATE_POLL_MS, signal, alive = pidAlive, onWait, ticket, heartbeatMs = CLAIM_HEARTBEAT_MS, heartbeatStaleMs = CLAIM_HEARTBEAT_STALE_MS } = {}) {
  const pool = join(dir, gatePoolName(gate));
  mkdirSync(pool, { recursive: true });
  const token = randomUUID();
  let waited = false;
  for (;;) {
    if (signal?.aborted) throw new Error('gate lease aborted');
    for (let slot = 0; slot < slots; slot++) {
      if (!tryClaim(pool, slot, alive, ticket, heartbeatStaleMs, token)) continue;
      const path = join(pool, `slot-${slot}`);
      const ownsClaim = () => {
        try {
          return readFileSync(join(path, 'token'), 'utf8').trim() === token;
        } catch {
          return false;
        }
      };
      const timer = setInterval(() => {
        if (!ownsClaim()) return clearInterval(timer);
        try {
          const now = new Date();
          utimesSync(join(path, 'heartbeat'), now, now);
        } catch {
          clearInterval(timer);
        }
      }, heartbeatMs);
      timer.unref();
      let released = false;
      return {
        slot,
        release: () => {
          if (released) return;
          released = true;
          clearInterval(timer);
          // Delete only the claim this lease made; a reclaimed slot belongs to its new holder.
          if (ownsClaim()) rmSync(path, { recursive: true, force: true });
        },
      };
    }
    if (!waited) {
      waited = true;
      onWait?.(holderOf(pool, slots));
    }
    await new Promise((resolve) => {
      const t = setTimeout(resolve, pollMs);
      signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
}
