import { describe, expect, it, vi } from 'vitest';

import type { TaggedOutput } from '../approaches/outputs.js';
import type { CaptureTarget } from './capture.js';
import { createWorktreeWatcher, type FsWatch } from './watcher.js';

const outputs: TaggedOutput[] = [{ approachId: 'a', glob: 'docs/**', kind: 'plan' }];
const target: CaptureTarget = { ticketId: 1, repoPath: '/r', worktreePath: '/wt', baseRef: 'develop' };

function setup() {
  const listeners = new Map<string, (p: string) => void>();
  const closed: string[] = [];
  const watch: FsWatch = (dir, cb) => {
    listeners.set(dir, cb);
    return { close: () => closed.push(dir) };
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
  return { w, listeners, closed, capture, timers, fireLive };
}

describe('worktree watcher', () => {
  it('collapses a burst into one capture of the touched output paths', () => {
    const { w, listeners, capture, timers, fireLive } = setup();
    w.add(target);
    const emit = listeners.get('/wt')!;
    emit('docs/a.md');
    emit('docs/b.md');
    emit('docs/a.md');
    expect(timers.filter((t) => t.live)).toHaveLength(1); // earlier timers cleared
    expect(timers[0]!.ms).toBe(1000);
    expect(capture).not.toHaveBeenCalled();
    fireLive();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(target, new Set(['docs/a.md', 'docs/b.md']));
  });

  it('ignores paths outside the outputs globs', () => {
    const { w, listeners, timers } = setup();
    w.add(target);
    listeners.get('/wt')!('node_modules/x/index.js');
    expect(timers).toHaveLength(0);
  });

  it('remove closes the handle and cancels the pending pass', () => {
    const { w, listeners, closed, capture, fireLive } = setup();
    w.add(target);
    listeners.get('/wt')!('docs/a.md');
    w.remove('/wt');
    fireLive();
    expect(closed).toEqual(['/wt']);
    expect(capture).not.toHaveBeenCalled();
    expect(w.watched()).toEqual([]);
  });

  it('sync adds new worktrees and drops vanished ones', () => {
    const { w } = setup();
    const t2 = { ...target, worktreePath: '/wt2' };
    w.sync([target]);
    w.sync([t2]);
    expect(w.watched()).toEqual(['/wt2']);
  });

  it('a throwing watch does not register the worktree', () => {
    const w = createWorktreeWatcher({
      watch: () => { throw new Error('ENOSPC'); },
      capture: async () => 0,
      outputs: () => outputs,
      debug: () => {},
    });
    w.add(target);
    expect(w.watched()).toEqual([]);
  });
});
