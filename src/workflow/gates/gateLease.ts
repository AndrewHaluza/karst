import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leaseClaimSlot, type ClaimLease } from '../../runtime/claimLease.js';

const DEFAULT_GATE_SLOTS_DIR = join(tmpdir(), 'karst-gate-slots');

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
