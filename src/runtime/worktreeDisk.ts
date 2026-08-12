import { commandOutput } from './asyncProcess.js';

/**
 * Measure worktree disk usage one directory at a time, abortably, with a
 * one-hour cache. 100 worktrees × ~70 ms warm `du` cannot ride a 2 s timer, so
 * the disk lane runs ONLY while the panel is open and strictly sequentially —
 * parallel `du` over every worktree is a disk-thrash storm.
 */
export interface DiskUsage {
  path: string;
  bytes: number;
  measuredMs: number;
}

export const DISK_CACHE_TTL_MS = 60 * 60 * 1_000;
export const DISK_PROBE_TIMEOUT_MS = 30_000;

type Run = typeof commandOutput;

export class WorktreeDiskCache {
  private readonly cache = new Map<string, DiskUsage>();
  private readonly now: () => number;
  private readonly run: Run;

  constructor(now: () => number = Date.now, run: Run = commandOutput) {
    this.now = now;
    this.run = run;
  }

  /** The cached value while fresh, else undefined. Never spawns. */
  get(path: string): DiskUsage | undefined {
    const cached = this.cache.get(path);
    if (cached === undefined) return undefined;
    if (this.now() - cached.measuredMs > DISK_CACHE_TTL_MS) return undefined;
    return cached;
  }

  /**
   * Measure one directory. Returns the cached value when fresh WITHOUT
   * spawning; otherwise runs `du -sk` and parses the leading integer of the
   * first line (KiB) into bytes. A `null` from the run, unparseable output, or
   * an already-aborted signal yields `null` and caches NOTHING — a partial
   * size is never stated as a total.
   */
  async measure(path: string, signal?: AbortSignal): Promise<DiskUsage | null> {
    const fresh = this.get(path);
    if (fresh !== undefined) return fresh;
    if (signal?.aborted) return null;
    const stdout = await this.run('du', ['-sk', path], DISK_PROBE_TIMEOUT_MS);
    if (stdout === null) return null;
    const firstLine = stdout.trim().split('\n')[0];
    if (firstLine === undefined) return null;
    const match = /^\s*(\d+)/.exec(firstLine);
    if (match === null) return null;
    const usage: DiskUsage = {
      path,
      bytes: Number(match[1]) * 1024,
      measuredMs: this.now(),
    };
    this.cache.set(path, usage);
    return usage;
  }

  /**
   * Measure paths STRICTLY sequentially, calling `onEach` after each success,
   * returning early the moment the signal aborts. Scheduling belongs to the
   * caller — never call this from a timer.
   */
  async measureAll(
    paths: readonly string[],
    signal: AbortSignal,
    onEach: (usage: DiskUsage) => void,
  ): Promise<void> {
    for (const path of paths) {
      if (signal.aborted) return;
      const usage = await this.measure(path, signal);
      if (usage !== null) onEach(usage);
    }
  }
}
