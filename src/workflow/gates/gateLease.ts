import { homedir } from 'node:os';
import { join } from 'node:path';
import { leaseClaimSlot, type ClaimLease } from '../../runtime/claimLease.js';

/** Env that carries the lease to a gate process: the script then skips its own lease (arch:GATE-CONCURRENCY). */
export const GATE_LEASE_HELD_ENV = 'KARST_GATE_LEASE_HELD';

/**
 * A fixed path, not `tmpdir()`: on macOS the extension host and an agent shell resolve `tmpdir()`
 * differently, so a tmp path would not share the lease. `scripts/gateSlot.mjs` resolves the same path.
 */
export const DEFAULT_GATE_SLOTS_DIR = process.env.KARST_GATE_SLOTS_DIR || join(homedir(), '.karst', 'gate-slots');

export interface GateLeaseOptions {
  /** Pool root; the pool of one gate is `<dir>/<gate name>`. */
  dir?: string;
  pollMs?: number;
  signal?: AbortSignal;
  /** Called once when every slot is held; the argument is the held count. */
  onWait?: (held: number) => void;
}

/** One safe directory name per gate name: `test:unit` and `test_unit` stay apart, `..` cannot escape. */
export function gatePoolName(gateName: string): string {
  return encodeURIComponent(gateName).replace(/\./g, '%2E');
}

/**
 * Lease one of `maxConcurrent` host-wide slots for runs of one gate, across
 * tickets and IDE windows (arch:GATE-CONCURRENCY). Rejects when the signal aborts.
 */
export function leaseGateSlot(gateName: string, maxConcurrent: number, opts: GateLeaseOptions = {}): Promise<ClaimLease> {
  return leaseClaimSlot({
    dir: join(opts.dir ?? DEFAULT_GATE_SLOTS_DIR, gatePoolName(gateName)),
    slots: maxConcurrent,
    pollMs: opts.pollMs,
    signal: opts.signal,
    onWait: opts.onWait,
  });
}
