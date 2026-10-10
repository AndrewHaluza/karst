/**
 * Per-worktree output watcher. fs events whose path matches an `outputs:` glob
 * are debounced (bursts of saves collapse into one pass) and handed to `capture`
 * as the set of touched paths. Host-agnostic: fs watching and timers are
 * injected so tests drive it with fakes.
 */

import type { TaggedOutput } from '../approaches/outputs.js';
import { matchOutput } from './globMatch.js';
import type { CaptureTarget } from './capture.js';

export const DEFAULT_DEBOUNCE_MS = 1000;

export interface FsWatchHandle {
  close(): void;
}
/** Watch `dir` recursively; `onChange` gets paths relative to `dir`. */
export type FsWatch = (dir: string, onChange: (relPath: string) => void) => FsWatchHandle;

export interface WatcherDeps {
  watch: FsWatch;
  capture: (target: CaptureTarget, only: ReadonlySet<string>) => Promise<unknown>;
  outputs: () => readonly TaggedOutput[];
  debug: (message: string) => void;
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface WorktreeWatcher {
  /** Start watching a worktree; a second call for the same path is a no-op. */
  add(target: CaptureTarget): void;
  /** Stop watching and drop pending paths (a final sweep covers them). */
  remove(worktreePath: string): void;
  /** Reconcile to exactly this set of live worktrees. */
  sync(targets: readonly CaptureTarget[]): void;
  closeAll(): void;
  watched(): string[];
}

interface Entry {
  target: CaptureTarget;
  handle: FsWatchHandle;
  pending: Set<string>;
  timer: unknown;
}

export function createWorktreeWatcher(deps: WatcherDeps): WorktreeWatcher {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const entries = new Map<string, Entry>();

  const fire = (entry: Entry): void => {
    entry.timer = undefined;
    const only = entry.pending;
    entry.pending = new Set();
    deps.debug(`[artifacts] debounce fired for ${entry.target.worktreePath}: ${only.size} path(s)`);
    deps.capture(entry.target, only).catch((err: unknown) => {
      deps.debug(`[artifacts] watcher capture failed: ${String(err)}`);
    });
  };

  const onChange = (entry: Entry, rawPath: string): void => {
    const rel = rawPath.replaceAll('\\', '/');
    if (matchOutput(deps.outputs(), rel) === undefined) return;
    entry.pending.add(rel);
    if (entry.timer !== undefined) clearTimer(entry.timer);
    entry.timer = setTimer(() => fire(entry), debounceMs);
  };

  const stop = (entry: Entry): void => {
    if (entry.timer !== undefined) clearTimer(entry.timer);
    entry.handle.close();
  };

  return {
    add(target) {
      if (entries.has(target.worktreePath)) return;
      deps.debug(`[artifacts] watching ${target.worktreePath}`);
      const entry = { target, pending: new Set<string>(), timer: undefined } as Omit<Entry, 'handle'> & { handle?: FsWatchHandle };
      try {
        entry.handle = deps.watch(target.worktreePath, (p) => onChange(entry as Entry, p));
      } catch (err) {
        deps.debug(`[artifacts] cannot watch ${target.worktreePath}: ${String(err)}`);
        return;
      }
      entries.set(target.worktreePath, entry as Entry);
    },
    remove(worktreePath) {
      const entry = entries.get(worktreePath);
      if (entry === undefined) return;
      deps.debug(`[artifacts] unwatching ${worktreePath}`);
      stop(entry);
      entries.delete(worktreePath);
    },
    sync(targets) {
      const live = new Set(targets.map((t) => t.worktreePath));
      for (const path of [...entries.keys()]) if (!live.has(path)) this.remove(path);
      for (const t of targets) this.add(t);
    },
    closeAll() {
      for (const entry of entries.values()) stop(entry);
      entries.clear();
    },
    watched: () => [...entries.keys()],
  };
}

/** Default `FsWatch` over `node:fs.watch` (recursive; macOS/Windows native, Linux Node ≥ 20). */
export function nodeFsWatch(fsWatch: typeof import('node:fs').watch): FsWatch {
  return (dir, onChange) => {
    const w = fsWatch(dir, { recursive: true }, (_event, filename) => {
      if (filename) onChange(String(filename));
    });
    w.on('error', () => {});
    return { close: () => w.close() };
  };
}
