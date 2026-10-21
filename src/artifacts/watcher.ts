/**
 * Per-worktree output watcher. Watching the worktree root recursively costs one
 * inotify watch per directory on Linux (node_modules included), so karst watches
 * only the literal prefix dirs of the `outputs:` globs instead. fs events whose
 * reconstructed path matches an `outputs:` glob are debounced (bursts of saves
 * collapse into one pass) and handed to `capture` as the set of touched paths;
 * `onChange` receives paths relative to the worktree, so `matchOutput` is
 * unchanged. Host-agnostic: fs watching and timers are injected so tests drive
 * it with fakes.
 */

import { join } from 'node:path';

import { outputPrefix, type TaggedOutput } from '../approaches/outputs.js';
import { matchOutput } from './globMatch.js';
import type { CaptureTarget } from './capture.js';

export const DEFAULT_DEBOUNCE_MS = 1000;

export interface FsWatchHandle {
  close(): void;
  /** True once the watcher closed itself after an error; re-armed on the next sync. */
  readonly closed?: boolean;
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
  /** Start (or refresh) watching a worktree; idempotent per path. */
  add(target: CaptureTarget): void;
  /** Stop watching and drop pending paths (a final sweep covers them). */
  remove(worktreePath: string): void;
  /** Reconcile to exactly this set of live worktrees. */
  sync(targets: readonly CaptureTarget[]): void;
  closeAll(): void;
  /** The absolute directories currently watched. */
  watched(): string[];
}

interface Entry {
  target: CaptureTarget;
  /** Repo-relative prefix dir -> live handle. */
  handles: Map<string, FsWatchHandle>;
  pending: Set<string>;
  timer: unknown;
  failedPrefixes: Set<string>;
}

/**
 * The literal prefix dir of each output glob, duplicates and nested prefixes
 * removed, plus the globs that start with a glob char and so cannot be scoped.
 * The watcher skips the latter: the post-edit hook, session-end capture and
 * final sweep still see those files.
 */
export function watchPrefixes(outputs: readonly TaggedOutput[]): {
  dirs: string[];
  unwatchable: string[];
} {
  const prefixes = new Set<string>();
  const unwatchable: string[] = [];
  for (const output of outputs) {
    const prefix = outputPrefix(output.glob);
    if (prefix === '') unwatchable.push(output.glob);
    else prefixes.add(prefix);
  }
  // A dir already under another prefix adds no files this watcher would not see.
  const sorted = [...prefixes].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const dirs = sorted.filter((p) => !sorted.some((q) => q !== p && p.startsWith(`${q}/`)));
  return { dirs, unwatchable };
}

export function createWorktreeWatcher(deps: WatcherDeps): WorktreeWatcher {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const entries = new Map<string, Entry>();
  /** Globs already reported as unwatchable, so one sync per 10 s does not spam. */
  const warned = new Set<string>();

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

  const teardown = (entry: Entry): void => {
    if (entry.timer !== undefined) clearTimer(entry.timer);
    for (const handle of entry.handles.values()) handle.close();
    entry.handles.clear();
    entry.failedPrefixes.clear();
  };

  /** Watch each wanted prefix dir (recursive), re-deriving the set every sync. */
  const reconcile = (entry: Entry): void => {
    const { dirs, unwatchable } = watchPrefixes(deps.outputs());
    for (const glob of unwatchable) {
      if (warned.has(glob)) continue;
      warned.add(glob);
      deps.debug(`[artifacts] output glob "${glob}" has no literal prefix; not watched (hooks and sweeps still capture it)`);
    }
    const want = new Set(dirs);
    for (const [prefix, handle] of entry.handles) {
      if (!want.has(prefix) || handle.closed === true) {
        handle.close();
        entry.handles.delete(prefix);
      }
    }
    for (const prefix of dirs) {
      if (entry.handles.has(prefix)) continue;
      const dir = join(entry.target.worktreePath, prefix);
      try {
        const handle = deps.watch(dir, (p) => onChange(entry, `${prefix}/${p}`));
        entry.handles.set(prefix, handle);
        if (entry.failedPrefixes.delete(prefix)) {
          deps.debug(`[artifacts] watching ${dir}`);
        }
      } catch (err) {
        if (!entry.failedPrefixes.has(prefix)) {
          entry.failedPrefixes.add(prefix);
          deps.debug(`[artifacts] cannot watch ${dir}: ${String(err)}`);
        }
      }
    }
  };

  return {
    add(target) {
      const existing = entries.get(target.worktreePath);
      const entry = existing ?? {
        target,
        handles: new Map(),
        pending: new Set(),
        timer: undefined,
        failedPrefixes: new Set(),
      };
      if (existing === undefined) {
        deps.debug(`[artifacts] watching ${target.worktreePath}`);
        entries.set(target.worktreePath, entry);
      } else {
        existing.target = target;
      }
      reconcile(entry);
    },
    remove(worktreePath) {
      const entry = entries.get(worktreePath);
      if (entry === undefined) return;
      deps.debug(`[artifacts] unwatching ${worktreePath}`);
      teardown(entry);
      entries.delete(worktreePath);
    },
    sync(targets) {
      const live = new Set(targets.map((t) => t.worktreePath));
      for (const path of [...entries.keys()]) if (!live.has(path)) this.remove(path);
      for (const t of targets) this.add(t);
    },
    closeAll() {
      for (const entry of entries.values()) teardown(entry);
      entries.clear();
    },
    watched: () =>
      [...entries.values()]
        .flatMap((e) => [...e.handles.keys()].map((p) => join(e.target.worktreePath, p)))
        .sort(),
  };
}

/** Default `FsWatch` over `node:fs.watch` (recursive; macOS/Windows native, Linux Node ≥ 20). */
export function nodeFsWatch(
  fsWatch: typeof import('node:fs').watch,
  debug: (message: string) => void = () => {},
): FsWatch {
  return (dir, onChange) => {
    const w = fsWatch(dir, { recursive: true }, (_event, filename) => {
      if (filename) onChange(String(filename));
    });
    let closed = false;
    w.on('error', (err: Error) => {
      const code = (err as NodeJS.ErrnoException).code ?? err.message;
      const limit = code === 'ENOSPC' || code === 'EMFILE';
      debug(`[artifacts] watch error on ${dir} (${code})${limit ? ': inotify limit reached' : ''}`);
      closed = true;
      w.close();
    });
    return {
      get closed() { return closed; },
      close: () => { closed = true; w.close(); },
    };
  };
}
