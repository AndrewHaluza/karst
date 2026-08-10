import { readlinkSync } from 'node:fs';
import { readlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { canonicalPath } from './pathScope.js';
import { pidAlive } from './pidAlive.js';
import { commandOutput } from './asyncProcess.js';

/**
 * Whether a recorded pid may still be SIGNALLED.
 *
 * A `servers` row is a recollection, not a handle: it names a pid the OS is free
 * to reissue the moment the process it named exited. Killing on the strength of
 * that row alone means killing a whole process group that has nothing to do with
 * karst — and the reap paths signal the GROUP (`killTree` targets `-pid`), so the
 * blast radius of a wrong answer is an unrelated process tree, not one process.
 * Every kill therefore goes through this: it must produce EVIDENCE that the live
 * pid is still the server we recorded, and anything short of that is not a kill.
 */
export type Attribution =
  /** The live pid is provably still the recorded server. Safe to signal. */
  | 'attributable'
  /** Nothing is running under that pid. Clear the row; signal nothing. */
  | 'dead'
  /** Something IS running under that pid, but it is not ours. Never signal. */
  | 'foreign'
  /** Not enough is known to tell the two apart. Never signal. */
  | 'unknown';

/** The row facts an attribution is decided from. */
export interface ServerIdentity {
  pid: number | null;
  /** Directory recorded at spawn (`servers.cwd`); NULL before v21. */
  cwd: string | null;
  /** When the recorded process was actually spawned (`servers.started_at`, ISO). */
  startedAt: string | null;
}

/** What the OS says a live process's working directory is. */
export interface LiveCwd {
  path: string;
  /** The directory has been removed out from under the running process. */
  deleted: boolean;
}

/**
 * The OS probes an attribution needs, injected so the decision itself stays a
 * pure function under test — and so a platform that cannot answer one of them
 * degrades to "unknown" rather than to a guess.
 */
export interface ProcessFactsSource {
  isAlive(pid: number): boolean | Promise<boolean>;
  /** The live process's cwd, or null where the OS will not say. */
  liveCwd(pid: number): LiveCwd | null | Promise<LiveCwd | null>;
  /**
   * The live process's own start time (epoch ms), or null where the OS will not
   * say. This is EXACT (to within a second — see `systemProcessFacts`), never an
   * approximation like "some time after the last boot": a boot-time-only signal
   * cannot tell our server apart from an unrelated process that reused its pid
   * later in the SAME boot, and the reap paths signal the whole process group.
   */
  processStartMs(pid: number): number | null | Promise<number | null>;
}

/** Synchronous facts retained for existing boot/archive reconciliation paths. */
export interface ProcessFacts extends ProcessFactsSource {
  isAlive(pid: number): boolean;
  liveCwd(pid: number): LiveCwd | null;
  processStartMs(pid: number): number | null;
}

/** How far a live process's start time may drift from the recorded one and still count as a match. */
const START_TIME_TOLERANCE_MS = 2_000;

/**
 * Parse an ISO timestamp (`servers.started_at`, written by `startHot` at spawn
 * time). Anything that does not parse is treated as unusable rather than as
 * "now" or "epoch 0" — a bad timestamp must lose the match, never win it.
 */
export function parseStartedAt(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value.trim());
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Decide whether `row`'s pid may be signalled.
 *
 * Two independent kinds of evidence, strongest first:
 *
 *  1. **The live process's own cwd** (Linux `/proc/<pid>/cwd`). If the OS will
 *     say where the process is running, that settles it outright — but both
 *     sides are canonicalized before comparing: `/proc/<pid>/cwd` resolves
 *     through the kernel's own dentry (symlinks resolved), while the recorded
 *     `cwd` is the raw path `startHot` was given, which may still contain a
 *     symlinked component (e.g. macOS `/var` → `/private/var`, or a workspace
 *     root reached through a symlink on Linux). Comparing the two RAW would read
 *     the same directory as a different one and let the orphan it was meant to
 *     catch survive. This is also the exact evidence the incident was diagnosed
 *     from — a cwd that resolves with the `(deleted)` suffix IS the orphan, and
 *     still matches after canonicalization strips only the suffix, not the path.
 *  2. **The live process's own start time**, compared to the moment `startHot`
 *     recorded (`servers.started_at`), within `START_TIME_TOLERANCE_MS`. This
 *     is where a cwd probe is unavailable (Windows, a missing lsof) or
 *     unanswerable (a row with no recorded directory) — and it replaces a
 *     boot-time check that USED to stand in for it: "started after the last
 *     boot" is true for any pid the OS handed out since, including one reissued
 *     to an unrelated process hours after ours exited, and a wrong answer here
 *     is a SIGKILL to a process group we do not own. Matching the exact second
 *     closes that gap; a coincidental match to the second is the same residual
 *     risk any pid-based identification carries, not a new one.
 *
 * Undecidable rows (no usable directory AND no usable timestamp, or a probe
 * that itself failed) are `unknown`, never a kill.
 */
export function attributeServer(row: ServerIdentity, facts: ProcessFacts): Attribution {
  const { pid } = row;
  if (pid == null || !Number.isInteger(pid) || pid <= 0) return 'unknown';
  if (!facts.isAlive(pid)) return 'dead';

  const live = facts.liveCwd(pid);
  if (live && row.cwd) {
    return canonicalPath(live.path) === canonicalPath(row.cwd) ? 'attributable' : 'foreign';
  }
  // The OS answered the cwd probe, but the row never recorded a directory to
  // compare against (pre-v21 rows). A probe that cannot be COMPARED is not
  // evidence either way — falling through to the start-time rule keeps those
  // rows attributable exactly as they were on platforms without a probe,
  // instead of stranding them the day one is added (lsof on macOS).
  const liveStart = facts.processStartMs(pid);
  if (liveStart === null) return 'unknown';
  const recordedStart = parseStartedAt(row.startedAt);
  if (recordedStart === null) return 'unknown';
  return Math.abs(liveStart - recordedStart) <= START_TIME_TOLERANCE_MS ? 'attributable' : 'foreign';
}

/** `process.kill(pid, 0)` — a permission-denied answer still proves it exists. */
const isAliveNow = pidAlive;

/**
 * Read a live process's cwd where the OS exposes it. Linux publishes it as a
 * symlink under `/proc`, which `readlink` answers instantly (no spawn, so the
 * extension host's event loop is never blocked). A removed directory comes back
 * with a ` (deleted)` suffix — kept as a flag and stripped from the path, since
 * it is a property of the directory, not part of its name.
 *
 * Any failure — no `/proc` (macOS, Windows), the process gone between the
 * liveness check and this read, another user's process — is `null`: "the OS
 * will not say", which the caller must treat as evidence it does not have.
 */
function liveCwdNow(pid: number): LiveCwd | null {
  if (process.platform !== 'linux') return null;
  try {
    const raw = readlinkSync(`/proc/${pid}/cwd`);
    const deleted = raw.endsWith(' (deleted)');
    return { path: deleted ? raw.slice(0, -' (deleted)'.length) : raw, deleted };
  } catch {
    return null;
  }
}

/**
 * Read a live process's own start time via `ps -o lstart=`, which both BSD ps
 * (macOS) and GNU ps (Linux) implement identically — unlike `etime`/`etimes`,
 * whose format differs across the two. This legacy synchronous probe remains
 * for synchronous reconciliation callers. Latency-sensitive extension-host
 * flows such as Spin use `systemAsyncProcessFacts` below instead.
 *
 * `lstart`'s resolution is whole seconds, which is why `attributeServer` matches
 * within a tolerance rather than exactly. Any failure — no such pid, `ps`
 * missing, an unparseable date — is `null`: evidence not obtained, never
 * evidence of a mismatch.
 */
function processStartMsNow(pid: number): number | null {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  const ms = Date.parse(r.stdout.trim());
  return Number.isNaN(ms) ? null : ms;
}

/** The real probes. Injected everywhere so tests never depend on this machine. */
export const systemProcessFacts: ProcessFacts = {
  isAlive: isAliveNow,
  liveCwd: liveCwdNow,
  processStartMs: processStartMsNow,
};

/** Async OS probes used by Spin's extension-host path. */
async function liveCwdAsync(pid: number): Promise<LiveCwd | null> {
  if (process.platform === 'linux') {
    try {
      const raw = await readlink(`/proc/${pid}/cwd`);
      const deleted = raw.endsWith(' (deleted)');
      return { path: deleted ? raw.slice(0, -' (deleted)'.length) : raw, deleted };
    } catch {
      return null;
    }
  }
  if (process.platform === 'win32') return null;
  const stdout = await commandOutput('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  if (stdout === null) return null;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('n')) continue;
    const raw = line.slice(1);
    const deleted = raw.endsWith(' (deleted)');
    return { path: deleted ? raw.slice(0, -' (deleted)'.length) : raw, deleted };
  }
  return null;
}

type AsyncCommand = typeof commandOutput;

export async function processStartMsAsync(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: AsyncCommand = commandOutput,
): Promise<number | null> {
  const stdout =
    platform === 'win32'
      ? await run('powershell.exe', [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
        ])
      : await run('ps', ['-o', 'lstart=', '-p', String(pid)]);
  if (!stdout) return null;
  const ms = Date.parse(stdout.trim());
  return Number.isNaN(ms) ? null : ms;
}

/** Real async probes for paths that run on the VS Code extension-host thread. */
export const systemAsyncProcessFacts: ProcessFactsSource = {
  isAlive: isAliveNow,
  liveCwd: liveCwdAsync,
  processStartMs: processStartMsAsync,
};
