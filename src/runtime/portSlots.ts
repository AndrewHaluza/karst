import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  release: () => void;
}

export interface LeaseOptions {
  dir?: string;
  pollMs?: number;
  signal?: AbortSignal;
  onDebug?: (message: string) => void;
  isAlive?: (pid: number) => boolean;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const NO_OWNER_STALE_MS = 60_000;

function isStale(path: string, isAlive: (pid: number) => boolean): boolean {
  try {
    return !isAlive(Number(readFileSync(join(path, 'owner'), 'utf8').trim()));
  } catch {
    // Claim dir exists but its owner file is not written yet (mid-claim) or never was.
    try {
      return Date.now() - statSync(path).mtimeMs > NO_OWNER_STALE_MS;
    } catch {
      return true;
    }
  }
}

function tryClaim(dir: string, slot: number, isAlive: (pid: number) => boolean): boolean {
  const path = join(dir, `slot-${slot}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(path);
      writeFileSync(join(path, 'owner'), String(process.pid));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (!isStale(path, isAlive)) return false;
      rmSync(path, { recursive: true, force: true });
    }
  }
  return false;
}

/**
 * Lease one port-band slot for a gate run. Waits (logged) while every slot is
 * held; never shares one. A slot whose owner pid is dead (kill/OOM/crash) is
 * reclaimed, so an abnormal exit cannot leak it.
 */
export async function leasePortSlot(opts: LeaseOptions = {}): Promise<PortSlotLease> {
  const dir = opts.dir ?? DEFAULT_LOCK_DIR;
  const isAlive = opts.isAlive ?? pidAlive;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  mkdirSync(dir, { recursive: true });
  let logged = false;
  for (;;) {
    if (opts.signal?.aborted) throw new Error('port slot lease aborted');
    for (let slot = 0; slot < PORT_SLOT_COUNT; slot++) {
      if (!tryClaim(dir, slot, isAlive)) continue;
      let released = false;
      opts.onDebug?.(`[gate] port slot ${slot} leased (offset ${slot * PORT_SLOT_STRIDE})`);
      return {
        slot,
        offset: slot * PORT_SLOT_STRIDE,
        release: () => {
          if (released) return;
          released = true;
          rmSync(join(dir, `slot-${slot}`), { recursive: true, force: true });
        },
      };
    }
    if (!logged) {
      opts.onDebug?.(`[gate] all ${PORT_SLOT_COUNT} port slots held by concurrent gates — waiting for one`);
      logged = true;
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, pollMs);
      opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
}
