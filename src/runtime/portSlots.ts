import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leaseClaimSlot } from './claimLease.js';

/** Env var shifting every integration-suite port band; unset → 0 (CI and local runs unchanged). */
export const PORT_OFFSET_ENV = 'KARST_TEST_PORT_OFFSET';
/** Suites own [28000, 29000) at offset 0, so one slot is 1000 ports wide. */
export const PORT_SLOT_STRIDE = 1000;
/** Linux' ephemeral range starts here; no band may reach it (see freePortWindow). */
export const EPHEMERAL_FLOOR = 32_768;
const BAND_ORIGIN = 28_000;
/** Slots that fit: 28000 + n*1000 <= 32768 → 4 (offsets 0, 1000, 2000, 3000). */
export const PORT_SLOT_COUNT = Math.floor((EPHEMERAL_FLOOR - BAND_ORIGIN) / PORT_SLOT_STRIDE);

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_LOCK_DIR = join(tmpdir(), 'karst-gate-port-slots');

/** Offset from the environment; throws on garbage so a typo never silently shares a band. */
export function readPortOffset(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[PORT_OFFSET_ENV];
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  const max = (PORT_SLOT_COUNT - 1) * PORT_SLOT_STRIDE;
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw new Error(`${PORT_OFFSET_ENV}=${raw} is invalid: expected an integer in [0, ${max}]`);
  }
  return n;
}

/** Shift a suite band by the offset, refusing to cross into the ephemeral range. */
export function shiftBand(
  from: number,
  ceiling: number,
  offset: number = readPortOffset(),
): { from: number; ceiling: number } {
  if (ceiling + offset > EPHEMERAL_FLOOR) {
    throw new Error(`band [${from}, ${ceiling}) + offset ${offset} reaches the ephemeral range (${EPHEMERAL_FLOOR}+)`);
  }
  return { from: from + offset, ceiling: ceiling + offset };
}

export interface PortSlotLease {
  slot: number;
  offset: number;
  release: () => Promise<void>;
}

export interface LeaseOptions {
  dir?: string;
  pollMs?: number;
  signal?: AbortSignal;
  onDebug?: (message: string) => void;
  isAlive?: (pid: number) => boolean;
}

/**
 * Lease one port-band slot for a gate run. Waits (logged) while every slot is
 * held; never shares one. A slot whose owner pid is dead (kill/OOM/crash) is
 * reclaimed, so an abnormal exit cannot leak it.
 */
export async function leasePortSlot(opts: LeaseOptions = {}): Promise<PortSlotLease> {
  const lease = await leaseClaimSlot({
    dir: opts.dir ?? DEFAULT_LOCK_DIR,
    slots: PORT_SLOT_COUNT,
    pollMs: opts.pollMs ?? DEFAULT_POLL_MS,
    signal: opts.signal,
    isAlive: opts.isAlive,
    onWait: () => opts.onDebug?.(`[gate] all ${PORT_SLOT_COUNT} port slots held by concurrent gates — waiting for one`),
  }).catch((err: unknown) => {
    if (opts.signal?.aborted) throw new Error('port slot lease aborted');
    throw err;
  });
  opts.onDebug?.(`[gate] port slot ${lease.slot} leased (offset ${lease.slot * PORT_SLOT_STRIDE})`);
  return { slot: lease.slot, offset: lease.slot * PORT_SLOT_STRIDE, release: lease.release };
}
