import type { Store } from '../store/db.js';
import { getTicket } from '../store/tickets.js';
import { listWorktreesByTicket, listPrsByTicket } from '../store/dashboard.js';
import { getMergeCheck } from '../store/mergeChecks.js';
import { renderConflictBrief } from './conflictBrief.js';

/**
 * The prompt for a "Resolve conflicts" click, assembled from what the store
 * already knows about one repo's conflict.
 *
 * Returns null — never a generic "go look at it" prompt — whenever the click
 * cannot be honoured: the repo is not recorded as conflicted, or it has no
 * worktree to merge in. The request reaches here from a webview message, so the
 * repo name is untrusted input; the STORE decides whether there is a conflict,
 * and the host resolves the directory. A caller that got null must say so rather
 * than opening a session with nothing specific to do.
 *
 * Host-agnostic: store in, string out. No vscode, no git, no clock.
 */
export function buildConflictBrief(store: Store, ticketId: number, repo: string): string | null {
  const check = getMergeCheck(store, ticketId, repo);
  if (!check || check.state !== 'conflicted') return null;

  const wt = listWorktreesByTicket(store, ticketId).find((w) => w.repo === repo);
  if (!wt) return null;

  const ticket = getTicket(store, ticketId);
  const pr = listPrsByTicket(store, ticketId).find((p) => p.repo === repo);

  return renderConflictBrief({
    ticketLabel: ticket.key ?? `#${ticketId}`,
    repo,
    worktreePath: wt.path,
    branch: wt.branch,
    // The verdict's own base is what the conflict was measured against; the
    // worktree row is only the fallback for a row written before it was carried.
    baseRef: check.baseRef ?? wt.baseRef,
    files: check.files,
    prUrl: pr?.url ?? null,
  });
}
