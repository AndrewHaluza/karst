import { describe, expect, it, vi } from 'vitest';

import type { TaggedOutput } from '../approaches/outputs.js';
import type { CaptureTarget } from './capture.js';
import { createWorktreeWatcher, nodeFsWatch, watchPrefixes, type FsWatch, type FsWatchHandle } from './watcher.js';

const superpowers: TaggedOutput[] = [
  { approachId: 'superpowers', glob: 'docs/superpowers/plans/**', kind: 'plan' },
  { approachId: 'superpowers', glob: 'docs/superpowers/specs/**', kind: 'spec' },
];
const target: CaptureTarget = { ticketId: 1, repoPath: '/r', worktreePath: '/wt', baseRef: 'develop' };

function setup(outputs: readonly TaggedOutput[] = [{ approachId: 'a', glob: 'docs/**', kind: 'plan' }]) {
  const listeners = new Map<string, (p: string) => void>();
  const closed: string[] = [];
  /** Dirs the fake fs reports as existing; a watch on any other throws ENOENT. */
  const existing = new Set<string>();
  const handles: Array<FsWatchHandle & { closed: boolean }> = [];
  const watch: FsWatch = (dir, cb) => {
    if (!existing.has(dir)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    listeners.set(dir, cb);
    const handle = { closed: false, close: () => { closed.push(dir); listeners.delete(dir); } };
    handles.push(handle);
    return handle;
  };
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const capture = vi.fn(async () => 0);
  const w = createWorktreeWatcher({
    watch,
    capture,
    outputs: () => outputs,
    debug: () => {},
    debounceMs: 1000,
    setTimer: (fn, ms) => (timers.push({ fn, ms, live: true }), timers.length - 1),
    clearTimer: (h) => { timers[h as number]!.live = false; },
  });
  const fireLive = () => timers.filter((t) => t.live).forEach((t) => { t.live = false; t.fn(); });
  return { w, listeners, closed, existing, handles, capture, timers, fireLive };
}

describe('watchPrefixes', () => {
  it('keeps the literal prefixes and drops duplicates and nested ones', () => {
    const { dirs, unwatchable } = watchPrefixes([
      { approachId: 'a', glob: 'docs/**', kind: 'plan' },
      { approachId: 'a', glob: 'docs/superpowers/plans/**', kind: 'plan' },
      { approachId: 'a', glob: 'rpi/*/research/**', kind: 'research' },
      { approachId: 'a', glob: 'rpi/*/research/**', kind: 'research' },
    ]);
    expect(dirs).toEqual(['docs', 'rpi']);
    expect(unwatchable).toEqual([]);
  });

  it('reports a glob with no literal prefix as unwatchable', () => {
    const { dirs, unwatchable } = watchPrefixes([{ approachId: 'a', glob: '**/*.md', kind: 'other' }]);
    expect(dirs).toEqual([]);
    expect(unwatchable).toEqual(['**/*.md']);
  });
});

describe('worktree watcher', () => {
  it('watches only the literal prefix dirs of the outputs, never the root', () => {
    const { w, existing } = setup(superpowers);
    existing.add('/wt/docs/superpowers/plans');
    existing.add('/wt/docs/superpowers/specs');
    w.add(target);
    expect(w.watched()).toEqual(['/wt/docs/superpowers/plans', '/wt/docs/superpowers/specs']);
    expect(w.watched()).not.toContain('/wt');
  });

  it('collapses a burst into one capture of the touched output paths', () => {
    const { w, listeners, existing, capture, timers, fireLive } = setup();
    existing.add('/wt/docs');
    w.add(target);
    const emit = listeners.get('/wt/docs')!;
    emit('a.md');
    emit('b.md');
    emit('a.md');
    expect(timers.filter((t) => t.live)).toHaveLength(1); // earlier timers cleared
    expect(timers[0]!.ms).toBe(1000);
    expect(capture).not.toHaveBeenCalled();
    fireLive();
    expect(capture).toHaveBeenCalledTimes(1);
    // reconstructed worktree-relative paths, so matchOutput is unchanged
    expect(capture).toHaveBeenCalledWith(target, new Set(['docs/a.md', 'docs/b.md']));
  });

  it('ignores a watched path that the outputs glob does not match', () => {
    const { w, listeners, existing, timers } = setup([{ approachId: 'rpi', glob: 'rpi/*/research/**', kind: 'research' }]);
    existing.add('/wt/rpi');
    w.add(target);
    listeners.get('/wt/rpi')!('other/notes.md'); // prefix dir, but not the glob
    expect(timers).toHaveLength(0);
  });

  it('remove closes the handles and cancels the pending pass', () => {
    const { w, listeners, closed, existing, capture, fireLive } = setup();
    existing.add('/wt/docs');
    w.add(target);
    listeners.get('/wt/docs')!('a.md');
    w.remove('/wt');
    fireLive();
    expect(closed).toEqual(['/wt/docs']);
    expect(capture).not.toHaveBeenCalled();
    expect(w.watched()).toEqual([]);
  });

  it('sync adds new worktrees and drops vanished ones', () => {
    const { w, existing } = setup();
    const t2 = { ...target, worktreePath: '/wt2' };
    existing.add('/wt/docs');
    existing.add('/wt2/docs');
    w.sync([target]);
    w.sync([t2]);
    expect(w.watched()).toEqual(['/wt2/docs']);
  });

  it('skips a prefix dir that does not exist, then watches it once a later sync sees it', () => {
    const { w, existing } = setup();
    w.add(target);
    expect(w.watched()).toEqual([]);
    existing.add('/wt/docs');
    w.sync([target]);
    expect(w.watched()).toEqual(['/wt/docs']);
  });

  it('never watches a glob with no literal prefix, and warns once', () => {
    const debug = vi.fn();
    const existing = new Set(['/wt']);
    const w = createWorktreeWatcher({
      watch: (dir, cb) => {
        if (!existing.has(dir)) throw new Error('ENOENT');
        void cb;
        return { close: () => {} };
      },
      capture: async () => 0,
      outputs: () => [{ approachId: 'a', glob: '**/*.md', kind: 'other' }],
      debug,
    });
    w.add(target);
    w.sync([target]);
    expect(w.watched()).toEqual([]);
    const warnings = debug.mock.calls.flat().filter((m) => m.includes('no literal prefix'));
    expect(warnings).toHaveLength(1);
  });

  it('re-arms a watcher whose handle closed itself after an error', () => {
    const { w, existing, handles, closed } = setup();
    existing.add('/wt/docs');
    w.add(target);
    expect(handles).toHaveLength(1);
    handles[0]!.closed = true; // the error handler closed the fs handle
    w.sync([target]);
    expect(w.watched()).toEqual(['/wt/docs']); // re-armed
    expect(closed).toEqual(['/wt/docs']); // the dead handle was closed
    expect(handles).toHaveLength(2);
  });

  it('a worktree with no watchable outputs simply watches nothing', () => {
    const { w } = setup([]);
    w.add(target);
    expect(w.watched()).toEqual([]);
  });

  it('logs watch failure once over multiple syncs, and logs watching when it later arms', () => {
    const debug = vi.fn();
    const existing = new Set<string>();
    const w = createWorktreeWatcher({
      watch: (dir, cb) => {
        if (!existing.has(dir)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        void cb;
        return { close: () => {} };
      },
      capture: async () => 0,
      outputs: () => [{ approachId: 'a', glob: 'docs/**', kind: 'plan' }],
      debug,
    });

    // 1. Initial add - dir missing, throws ENOENT and logs once
    w.add(target);
    const failureLogs = () => debug.mock.calls.flat().filter((m) => m.includes('cannot watch /wt/docs'));
    expect(failureLogs()).toHaveLength(1);

    // 2. Subsequent syncs while still missing do not log failure again
    w.sync([target]);
    w.sync([target]);
    expect(failureLogs()).toHaveLength(1);

    // 3. Dir appears, next sync arms watch and logs watching line
    existing.add('/wt/docs');
    w.sync([target]);
    const watchingLogs = debug.mock.calls.flat().filter((m) => m === '[artifacts] watching /wt/docs');
    expect(watchingLogs).toHaveLength(1);
    expect(w.watched()).toEqual(['/wt/docs']);
  });

  it('remove clears the failedPrefixes set so a re-added missing prefix logs failure again', () => {
    const debug = vi.fn();
    const w = createWorktreeWatcher({
      watch: (dir) => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      capture: async () => 0,
      outputs: () => [{ approachId: 'a', glob: 'docs/**', kind: 'plan' }],
      debug,
    });

    w.add(target);
    const failureLogs = () => debug.mock.calls.flat().filter((m) => m.includes('cannot watch /wt/docs'));
    expect(failureLogs()).toHaveLength(1);

    w.remove(target.worktreePath);
    w.add(target);
    expect(failureLogs()).toHaveLength(2);
  });
});

describe('nodeFsWatch', () => {
  function fakeFs() {
    const listeners: Record<string, (a: unknown) => void> = {};
    const closed: string[] = [];
    const fsWatch = ((dir: string) => ({
      on: (event: string, cb: (a: unknown) => void) => { listeners[event] = cb; },
      close: () => closed.push(dir),
    })) as unknown as typeof import('node:fs').watch;
    return { fsWatch, listeners, closed };
  }

  it('logs a watch error, names the inotify limit for ENOSPC, and closes the handle', () => {
    const { fsWatch, listeners, closed } = fakeFs();
    const debug = vi.fn();
    const handle = nodeFsWatch(fsWatch, debug)('/wt/docs', () => {});
    listeners['error']!({ code: 'ENOSPC' });
    expect(closed).toEqual(['/wt/docs']);
    expect(handle.closed).toBe(true);
    const logged = debug.mock.calls.flat().join('\n');
    expect(logged).toContain('ENOSPC');
    expect(logged).toContain('inotify limit reached');
  });

  it('logs a plain watch error without the inotify note for other codes', () => {
    const { fsWatch, listeners } = fakeFs();
    const debug = vi.fn();
    nodeFsWatch(fsWatch, debug)('/wt/docs', () => {});
    listeners['error']!({ code: 'EACCES' });
    const logged = debug.mock.calls.flat().join('\n');
    expect(logged).toContain('EACCES');
    expect(logged).not.toContain('inotify limit reached');
  });
});
