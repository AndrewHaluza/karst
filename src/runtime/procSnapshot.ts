import { commandOutput } from './asyncProcess.js';

/**
 * One async `ps` invocation yields a typed snapshot of every process on the
 * machine, with a ppid index so process trees can be rolled up from the
 * snapshot itself — no extra spawn per leader.
 *
 * The `-o` format is fixed and deliberately minimal:
 *
 *   ps -Ao pid=,ppid=,rss=,time=,lstart=,comm=
 *
 *  - `rss=` is KiB on both BSD (macOS) and GNU ps; converted to bytes here.
 *  - `time=` is cumulative CPU seconds (different layout per platform, parsed
 *    by `parseCpuTime`) — NEVER `ps %cpu`, which is a lifetime average on Linux
 *    and a decayed average on macOS and cannot answer "what is burning my CPU
 *    right now". CPU% is derived downstream from the DELTA of these counters.
 *  - `lstart=` is exactly 5 whitespace-separated tokens on both implementations
 *    (`Tue Aug 12 10:33:21 2026`); `comm=` is everything after it.
 *
 * A snapshot whose `ps` did not answer (`commandOutput` resolved `null`) is
 * `{ supported: true, snapshot: null }` — "the OS did not answer this time",
 * which callers must render as unknown, never as zero usage.
 */
export interface ProcRecord {
  pid: number;
  ppid: number;
  /** Resident set size in BYTES (ps reports KiB; converted here). */
  rssBytes: number;
  /** Cumulative CPU time consumed since the process started, in seconds. */
  cpuSeconds: number;
  /** Process start time, epoch ms, or null when `lstart` did not parse. */
  startedMs: number | null;
  /** Executable name as ps reports it (`comm`), never a full command line. */
  comm: string;
}

export interface ProcSnapshot {
  /** Wall clock at which the snapshot was taken, epoch ms. */
  takenMs: number;
  records: ReadonlyMap<number, ProcRecord>;
  /** pid -> its direct children's pids. */
  children: ReadonlyMap<number, readonly number[]>;
}

/** Upper bound on the `ps` spawn. A hung probe must never hold a lane. */
export const PROC_SNAPSHOT_TIMEOUT_MS = 5_000;

/**
 * Parse a ps `time=` value into total CPU seconds, or null when malformed.
 *
 * Accepts `MM:SS.ss`, `MM:SS`, `HH:MM:SS`, and `D-HH:MM:SS` (the day prefix GNU
 * ps uses past 24 hours). A malformed component drops the field — never coerced
 * to 0, which would read as a measured idle process.
 */
export function parseCpuTime(value: string): number | null {
  const dash = value.indexOf('-');
  const dayPart = dash >= 0 ? value.slice(0, dash) : null;
  const timePart = dash >= 0 ? value.slice(dash + 1) : value;
  const comps = timePart.split(':');
  if (comps.length < 2 || comps.length > 3) return null;
  const nums: number[] = [];
  for (const comp of comps) {
    const n = Number(comp);
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  const seconds = nums[nums.length - 1]!;
  let total = comps.length === 3 ? nums[0]! * 3600 + nums[1]! * 60 + seconds : nums[0]! * 60 + seconds;
  if (dayPart !== null) {
    const days = Number(dayPart);
    if (!Number.isFinite(days)) return null;
    total += days * 86_400;
  }
  return total;
}

/**
 * Parse the raw stdout of `ps -Ao pid=,ppid=,rss=,time=,lstart=,comm=` into a
 * snapshot. Pure — no I/O — so it is testable over verbatim captured output.
 *
 * Token layout is fixed: [0]=pid, [1]=ppid, [2]=rss, [3]=time, [4..8]=lstart
 * (exactly 5 tokens), [9..]=comm (re-joined with a single space).
 */
export function parseProcTable(stdout: string, takenMs: number): ProcSnapshot {
  const records = new Map<number, ProcRecord>();
  const children = new Map<number, number[]>();
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 10) continue;
    const pid = Number(tokens[0]);
    const ppid = Number(tokens[1]);
    const rss = Number(tokens[2]);
    if (!Number.isInteger(pid) || pid < 0) continue;
    if (!Number.isInteger(ppid) || ppid < 0) continue;
    if (!Number.isInteger(rss) || rss < 0) continue;
    const cpuSeconds = parseCpuTime(tokens[3]!);
    if (cpuSeconds === null) continue;
    const parsedStart = Date.parse(tokens.slice(4, 9).join(' '));
    records.set(pid, {
      pid,
      ppid,
      rssBytes: rss * 1024,
      cpuSeconds,
      startedMs: Number.isNaN(parsedStart) ? null : parsedStart,
      comm: tokens.slice(9).join(' '),
    });
    const siblings = children.get(ppid);
    if (siblings !== undefined) siblings.push(pid);
    else children.set(ppid, [pid]);
  }
  return { takenMs, records, children };
}

export type ProcSnapshotResult =
  | { supported: false }
  | { supported: true; snapshot: ProcSnapshot | null };

/**
 * Take one snapshot. `win32` is unsupported (`ps` does not exist there) and
 * reports it as a STATE rather than a failure; nothing is spawned.
 */
export async function readProcSnapshot(
  now: () => number = Date.now,
  platform: NodeJS.Platform = process.platform,
  run: typeof commandOutput = commandOutput,
): Promise<ProcSnapshotResult> {
  if (platform === 'win32') return { supported: false };
  const stdout = await run(
    'ps',
    ['-Ao', 'pid=,ppid=,rss=,time=,lstart=,comm='],
    PROC_SNAPSHOT_TIMEOUT_MS,
  );
  if (stdout === null) return { supported: true, snapshot: null };
  return { supported: true, snapshot: parseProcTable(stdout, now()) };
}
