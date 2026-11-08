import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { killTree, type KillOutcome } from './processTree.js';
import {
  START_TIME_TOLERANCE_MS,
  systemAsyncProcessFacts,
  type ProcessFactsSource,
} from './serverIdentity.js';

/**
 * Gate process groups that outlive the extension host (arch:GATE-ORPHANS).
 *
 * `runProcess` starts each gate detached, in its own process group, so Stop and
 * the timeout can kill the whole tree. A window reload or a quit ends the host
 * that owns the timeout and the abort signal, and the group keeps running. Each
 * running gate therefore leaves a record file; `deactivate` kills this host's
 * live groups, and the next activation reaps the groups of a host that died.
 */

export const GATE_RUNS_DIRNAME = 'karst-gate-runs';

/** The default directory for gate-run records. */
export function defaultGateRunsDir(): string {
  return join(tmpdir(), GATE_RUNS_DIRNAME);
}

/** One running gate group, as it is written to disk. */
export interface GateRunRecord {
  hostPid: number;
  pgid: number;
  /** The group leader's start time (epoch ms). */
  startMs: number;
  ticketId: number;
  gateName: string;
  worktree: string;
}

/** True when `path` lies inside a `.karst/worktrees/` directory. */
export function isInKarstWorktree(path: string): boolean {
  const parts = path.split(sep).filter((p) => p.length > 0);
  for (let i = 0; i + 2 < parts.length; i++) {
    if (parts[i] === '.karst' && parts[i + 1] === 'worktrees') return true;
  }
  return false;
}

function parseRecord(raw: string): GateRunRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  const ok =
    Number.isInteger(r.hostPid) &&
    Number.isInteger(r.pgid) &&
    (r.pgid as number) > 1 &&
    typeof r.startMs === 'number' &&
    Number.isFinite(r.startMs) &&
    typeof r.ticketId === 'number' &&
    typeof r.gateName === 'string' &&
    typeof r.worktree === 'string';
  return ok ? (r as unknown as GateRunRecord) : null;
}

export interface GateRunRegistryOptions {
  dir?: string;
  hostPid?: number;
  /** Injected for tests; default reads the leader start time from `ps`. */
  startTime?: (pid: number) => Promise<number | null>;
  /** Injected for tests; default sends SIGKILL to the process group. */
  kill?: (pid: number) => KillOutcome;
  debug?: (message: string) => void;
}

export interface TrackedGate {
  ticketId: number;
  gateName: string;
  pid: number;
  cwd: string;
}

export interface GateRunRegistry {
  /** Record a running gate. The returned disposer runs on every outcome. */
  track(gate: TrackedGate): () => void;
  /** Kill every group of this host that still runs. Synchronous; returns the pgids signalled. */
  killAll(): number[];
}

/** The gates this host started and that still run. */
export function createGateRunRegistry(options: GateRunRegistryOptions = {}): GateRunRegistry {
  const dir = options.dir ?? defaultGateRunsDir();
  const hostPid = options.hostPid ?? process.pid;
  const startTime = options.startTime ?? ((pid: number) => systemAsyncProcessFacts.processStartMs(pid) as Promise<number | null>);
  const kill = options.kill ?? killTree;
  const live = new Map<number, TrackedGate>();

  const writeRecord = async (gate: TrackedGate): Promise<void> => {
    try {
      const startMs = await startTime(gate.pid);
      if (startMs === null) {
        // No start time means the reaper could not prove identity later: write nothing.
        options.debug?.(`[runtime] gate record skipped: no start time for pid ${gate.pid}`);
        return;
      }
      if (!live.has(gate.pid)) return; // the gate ended before the probe answered
      const record: GateRunRecord = {
        hostPid,
        pgid: gate.pid,
        startMs,
        ticketId: gate.ticketId,
        gateName: gate.gateName,
        worktree: gate.cwd,
      };
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, String(gate.pid)), JSON.stringify(record));
      // The gate may have ended while the write was in flight.
      if (!live.has(gate.pid)) await rm(join(dir, String(gate.pid)), { force: true });
    } catch (err) {
      options.debug?.(`[runtime] gate record write failed for pid ${gate.pid}: ${String(err)}`);
    }
  };

  return {
    track(gate) {
      live.set(gate.pid, gate);
      void writeRecord(gate);
      return () => {
        live.delete(gate.pid);
        void rm(join(dir, String(gate.pid)), { force: true }).catch((err: unknown) =>
          options.debug?.(`[runtime] gate record removal failed for pid ${gate.pid}: ${String(err)}`),
        );
      };
    },
    killAll() {
      const signalled: number[] = [];
      for (const gate of [...live.values()]) {
        try {
          kill(gate.pid);
          signalled.push(gate.pid);
        } catch (err) {
          options.debug?.(`[runtime] gate group ${gate.pid} kill failed: ${String(err)}`);
        }
        live.delete(gate.pid);
        try {
          rmSync(join(dir, String(gate.pid)), { force: true });
        } catch {
          // best effort during teardown; the activation reaper drops a stale record
        }
      }
      return signalled;
    },
  };
}

export interface GateReap {
  record: GateRunRecord;
  outcome: 'killed' | 'kill-failed';
}

export interface GateReapOptions {
  dir?: string;
  /** Injected for tests; default is the real OS probes. */
  facts?: ProcessFactsSource;
  /** Injected for tests; default sends SIGKILL to the process group. */
  kill?: (pid: number) => KillOutcome;
  debug?: (message: string) => void;
}

/**
 * Kill the gate groups of a host that died. A group is signalled only when its
 * leader runs, its start time matches the record (so a reused pid is never hit)
 * and its live cwd is inside a `.karst/worktrees/` directory.
 */
export async function reapOrphanedGates(options: GateReapOptions = {}): Promise<GateReap[]> {
  const dir = options.dir ?? defaultGateRunsDir();
  const facts = options.facts ?? systemAsyncProcessFacts;
  const kill = options.kill ?? killTree;
  const reaped: GateReap[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return reaped; // no directory, no record
  }
  const drop = (name: string): Promise<void> => rm(join(dir, name), { force: true });

  for (const name of names) {
    let record: GateRunRecord | null = null;
    try {
      record = parseRecord(await readFile(join(dir, name), 'utf8'));
    } catch {
      continue; // unreadable: leave it
    }
    if (record === null || String(record.pgid) !== name) {
      await drop(name);
      continue;
    }
    if (await facts.isAlive(record.hostPid)) continue; // its host still owns it

    if (!(await facts.isAlive(record.pgid))) {
      await drop(name);
      continue;
    }
    const startMs = await facts.processStartMs(record.pgid);
    if (startMs === null) continue; // identity not provable: do not act
    if (Math.abs(startMs - record.startMs) > START_TIME_TOLERANCE_MS) {
      options.debug?.(`[runtime] gate record ${name}: pid reused (start time differs) — dropped`);
      await drop(name);
      continue;
    }
    const live = await facts.liveCwd(record.pgid);
    if (live === null) continue; // an unreported cwd is not proof
    if (!isInKarstWorktree(live.path)) {
      options.debug?.(`[runtime] gate record ${name}: cwd ${live.path} is outside a karst worktree — dropped`);
      await drop(name);
      continue;
    }
    const outcome = kill(record.pgid) === 'denied' ? 'kill-failed' : 'killed';
    reaped.push({ record, outcome });
    if (outcome === 'killed') await drop(name);
  }
  return reaped;
}

export function describeGateReap(reap: GateReap): string {
  const { record, outcome } = reap;
  const what = `gate "${record.gateName}" of ticket ${record.ticketId} (pid ${record.pgid})`;
  return outcome === 'killed'
    ? `karst: stopped orphaned ${what}`
    : `karst: could not stop orphaned ${what}; it still runs`;
}
