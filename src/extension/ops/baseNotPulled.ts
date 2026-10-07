import type { Notify } from './notify.js';

/** The two sinks a base-refresh failure must reach: the channel record and the user toast. */
export interface BaseNotPulledDeps {
  /** The Karst output channel — the durable record of the warning. */
  warn: (message: string) => void;
  /** The user-visible notification seam. */
  notify: Notify;
}

/**
 * A base branch that could not be refreshed before its worktree was cut
 * (§ pull switch). Deliberately a warning, not an error: the ticket exists and
 * is usable — it just starts from what this clone already had, which the user
 * must be told rather than left to discover in a diff. The reason is git's own
 * first line, already bounded by `pullBaseRef`.
 */
export function warnBaseNotPulled(
  repoPath: string,
  baseRef: string,
  reason: string,
  deps: BaseNotPulledDeps,
): void {
  const message = `Could not refresh ${baseRef} in ${repoPath} — the worktree was created from the local branch: ${reason}`;
  deps.warn(message);
  deps.notify.warn(message);
}
