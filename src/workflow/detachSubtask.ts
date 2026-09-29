import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import type { GitRunner } from '../integrations/git.js';
import type { GhRunner } from '../integrations/github.js';
import { findTicketById } from '../store/tickets.js';
import { changeBaseRef, type ChangeBaseRefResult } from './changeBaseRef.js';
import { resolveTicketBaseRef } from './baseRef.js';

export interface DetachSubtaskOpts {
  store: Store;
  manifest: Manifest;
  ticketId: number;
  git: GitRunner;
  gh?: GhRunner;
  debug?: (line: string) => void;
}

export interface DetachSubtaskResult {
  ok: boolean;
  reason: string;
  rebases: Map<string, ChangeBaseRefResult>;
}

/** A non-subtask cannot be detached (already top-level). */
export class NotASubtaskError extends Error {
  constructor(ticketId: number) {
    super(`ticket #${ticketId} is not a sub-task (no parent to detach from)`);
    this.name = 'NotASubtaskError';
  }
}

/** The parent does not exist or is archived (detach state is undefined). */
export class SubtaskParentNotFoundError extends Error {
  constructor(ticketId: number, parentId: number) {
    super(`parent ticket #${parentId} of sub-task #${ticketId} does not exist or is archived`);
    this.name = 'SubtaskParentNotFoundError';
  }
}

/**
 * Detach a sub-task from its parent: rebase it onto the parent's base branch(es)
 * and clear the `subtask_parent_id` so the ticket becomes top-level.
 *
 * This is the NDL-70 design §5 'Detach' operation: a non-blocking started
 * sub-task can be detached to unblock the parent from leaving `impl`/`fix`.
 *
 * The detach rebase is shallow: only the sub-task is moved (not any of its own
 * sub-tasks, which follow the parent stack rule and move with it).
 */
export async function detachSubtask(opts: DetachSubtaskOpts): Promise<DetachSubtaskResult> {
  const { store, manifest, ticketId, git, debug } = opts;

  const ticket = findTicketById(store, ticketId);
  if (!ticket) {
    return { ok: false, reason: `ticket #${ticketId} does not exist`, rebases: new Map() };
  }

  const parentId = ticket.subtaskParentId;
  if (parentId === null || parentId === undefined) {
    debug?.(`[detach] ticket #${ticketId} is not a sub-task — refusing`);
    throw new NotASubtaskError(ticketId);
  }

  const parent = findTicketById(store, parentId);
  if (!parent || parent.archivedAt !== null) {
    debug?.(`[detach] parent ticket #${parentId} does not exist or is archived — refusing`);
    throw new SubtaskParentNotFoundError(ticketId, parentId);
  }

  debug?.(`[detach] detaching sub-task #${ticketId} from parent #${parentId}`);

  const rebases = new Map<string, ChangeBaseRefResult>();

  // For each repo the sub-task touches, rebase it onto the parent's base.
  // Deduplicate by repoPath since manifest entries may share one worktree.
  const seenRepoPaths = new Set<string>();
  for (const repoName of ticket.selectedRepos ?? []) {
    const repository = manifest.repositories[repoName];
    if (!repository) continue;
    if (seenRepoPaths.has(repository.repoPath)) continue;
    seenRepoPaths.add(repository.repoPath);

    const parentBase = resolveTicketBaseRef(store, parentId, repository.repoPath, manifest);
    debug?.(`[detach] rebasing ${repoName} (${repository.repoPath}) onto ${parentBase}`);

    const result = await changeBaseRef({
      store,
      manifest,
      ticketId,
      repoPath: repository.repoPath,
      toBase: parentBase,
      git,
      gh: opts.gh,
      debug,
    });

    rebases.set(repository.repoPath, result);
    if (!result.ok) {
      debug?.(`[detach] rebase failed for ${repoName}: ${result.reason}`);
      return { ok: false, reason: `rebase failed for ${repoName}: ${result.reason}`, rebases };
    }
  }

  // All rebases succeeded. Clear the parent link to make this ticket top-level.
  store.db.prepare('UPDATE tickets SET subtask_parent_id = NULL WHERE id = ?').run(ticketId);
  debug?.(`[detach] ticket #${ticketId} detached; subtask_parent_id cleared`);

  return { ok: true, reason: '', rebases };
}
