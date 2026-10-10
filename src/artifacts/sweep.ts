/**
 * Final sweep: the last chance to capture a worktree's outputs before it
 * vanishes. Stops the live watcher for that worktree (its pending debounce is
 * superseded), then runs one full base-diff capture. Callers `await` it BEFORE
 * removing the worktree; it never throws.
 */

import { captureWorktree, type CaptureDeps, type CaptureTarget } from './capture.js';
import type { WorktreeWatcher } from './watcher.js';

export type WorktreeSweep = (target: CaptureTarget) => Promise<void>;

export function createFinalSweep(deps: {
  capture: CaptureDeps;
  watcher: Pick<WorktreeWatcher, 'remove'>;
}): WorktreeSweep {
  return async (target) => {
    deps.capture.debug(`[artifacts] final sweep of ${target.worktreePath}`);
    deps.watcher.remove(target.worktreePath);
    await captureWorktree(deps.capture, target);
  };
}
