import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { killTree, type KillOutcome } from './processTree.js';
import { START_TIME_TOLERANCE_MS, systemAsyncProcessFacts, type ProcessFactsSource } from './serverIdentity.js';

/**
 * Spin fixture servers that outlive the test run that started them (arch:GATE-ORPHANS).
 *
 * `spinTicket` starts each server detached, in its own process group, so a `killTree` on the
 * gate group never reaches it. A reload that kills the gate leaves the servers alive on their
 * ports. The spin integration suites record each server here (test code only: the production
 * supervisor does not change); the next activation kills the groups of a dead owner.
 */

export const SPIN_FIXTURES_DIRNAME = 'karst-spin-fixtures';

/** A tmp dir prefix that the spin suites use for fixture roots (`mkdtemp(tmpdir()/karst-spin-)`). */
const SPIN_ROOT_PREFIX = 'karst-spin-';

export function defaultSpinFixturesDir(): string {
  return join(tmpdir(), SPIN_FIXTURES_DIRNAME);
}

/** One fixture server, as the helper reads it from the `servers` table. */
export interface SpinServerRow {
  pid: number;
  port: number;
  cwd: string | null;
}

/** One record on disk. The file name is the server pid (= its process group id). */
export interface SpinServerRecord {
  ownerPid: number;
  pgid: number;
  /** The group leader's start time (epoch ms). */
  startMs: number;
  port: number;
  cwd: string;
}

/** True when `path` has a `karst-spin-*` segment. */
export function isInSpinFixtureRoot(path: string): boolean {
  return path.split(sep).some((part) => part.startsWith(SPIN_ROOT_PREFIX));
}

function parseRecord(raw: string): SpinServerRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  const ok =
    Number.isInteger(r.ownerPid) &&
    Number.isInteger(r.pgid) &&
    (r.pgid as number) > 1 &&
    typeof r.startMs === 'number' &&
    Number.isFinite(r.startMs) &&
    Number.isInteger(r.port) &&
    typeof r.cwd === 'string';
  return ok ? (r as unknown as SpinServerRecord) : null;
}

export interface RecordSpinServersOptions {
  dir?: string;
  ownerPid?: number;
  /** Injected for tests; default reads the leader start time from `ps`. */
  startTime?: (pid: number) => Promise<number | null>;
}

/**
 * Record the running fixture servers of a test. A server with no start time or no cwd is
 * skipped: the reaper could not prove its identity later.
 */
export async function recordSpinServers(rows: readonly SpinServerRow[], options: RecordSpinServersOptions = {}): Promise<void> {
  const dir = options.dir ?? defaultSpinFixturesDir();
  const ownerPid = options.ownerPid ?? process.pid;
  const startTime = options.startTime ?? ((pid: number) => systemAsyncProcessFacts.processStartMs(pid) as Promise<number | null>);
  await mkdir(dir, { recursive: true });
  for (const row of rows) {
    if (row.cwd === null || !Number.isInteger(row.pid) || row.pid <= 1) continue;
    const startMs = await startTime(row.pid);
    if (startMs === null) continue;
    const record: SpinServerRecord = { ownerPid, pgid: row.pid, startMs, port: row.port, cwd: row.cwd };
    await writeFile(join(dir, String(row.pid)), JSON.stringify(record));
  }
}

/** Remove the records of servers that the test stopped itself. Best effort. */
export function removeSpinServerRecords(rows: readonly SpinServerRow[], dir: string = defaultSpinFixturesDir()): void {
  for (const row of rows) {
    try {
      rmSync(join(dir, String(row.pid)), { force: true });
    } catch {
      // The activation reaper drops a stale record.
    }
  }
}

export interface SpinReap {
  record: SpinServerRecord;
  outcome: 'killed' | 'kill-failed';
}

export interface SpinReapOptions {
  dir?: string;
  facts?: ProcessFactsSource;
  kill?: (pid: number) => KillOutcome;
  debug?: (message: string) => void;
}

/**
 * Kill the fixture groups of a dead owner. A group is signalled only when its owner is dead,
 * its leader runs with the recorded start time (a reused pid is never hit) and its live cwd
 * is inside a `karst-spin-*` root. A port or a process name alone is never proof.
 */
export async function reapOrphanedSpinServers(options: SpinReapOptions = {}): Promise<SpinReap[]> {
  const dir = options.dir ?? defaultSpinFixturesDir();
  const facts = options.facts ?? systemAsyncProcessFacts;
  const kill = options.kill ?? killTree;
  const reaped: SpinReap[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return reaped;
  }
  const drop = (name: string): Promise<void> => rm(join(dir, name), { force: true });

  for (const name of names) {
    let record: SpinServerRecord | null = null;
    try {
      record = parseRecord(await readFile(join(dir, name), 'utf8'));
    } catch {
      continue; // unreadable: leave it
    }
    if (record === null || String(record.pgid) !== name) {
      await drop(name);
      continue;
    }
    if (await facts.isAlive(record.ownerPid)) continue; // its test run still owns it
    if (!(await facts.isAlive(record.pgid))) {
      await drop(name);
      continue;
    }
    const startMs = await facts.processStartMs(record.pgid);
    if (startMs === null) continue; // identity not provable: do not act
    if (Math.abs(startMs - record.startMs) > START_TIME_TOLERANCE_MS) {
      options.debug?.(`[runtime] spin fixture record ${name}: pid reused (start time differs) — dropped`);
      await drop(name);
      continue;
    }
    const live = await facts.liveCwd(record.pgid);
    if (live === null) continue; // an unreported cwd is not proof
    if (!isInSpinFixtureRoot(live.path)) {
      options.debug?.(`[runtime] spin fixture record ${name}: cwd ${live.path} is outside a karst-spin root — dropped`);
      await drop(name);
      continue;
    }
    const outcome = kill(record.pgid) === 'denied' ? 'kill-failed' : 'killed';
    reaped.push({ record, outcome });
    if (outcome === 'killed') await drop(name);
  }
  return reaped;
}

export function describeSpinReap(reap: SpinReap): string {
  const { record, outcome } = reap;
  const what = `spin fixture server (pid ${record.pgid}, port ${record.port}, cwd ${record.cwd})`;
  return outcome === 'killed'
    ? `karst: stopped orphaned ${what}`
    : `karst: could not stop orphaned ${what}; it still runs`;
}
