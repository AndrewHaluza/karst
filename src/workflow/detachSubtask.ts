import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import type { GitRunner } from '../integrations/git.js';
import type { GhRunner } from '../integrations/github.js';
import { findTicketById, listOpenSubtasks, detachSubtaskParent } from '../store/tickets.js';
import { changeBaseRef, type ChangeBaseRefResult } from './changeBaseRef.js';
import { resolveTicketBaseRef } from './baseRef.js';
import { onSubtaskLanded } from './subtaskGate.js';
import { formatId } from '../model/entityId.js';

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

/**
 * Every refusal of `detachSubtask` is user-ready: the operation's ONE error
 * style is "throw a `DetachSubtaskError` whose message names the rule and the
 * remedy". The op layer passes those messages through unchanged and wraps
 * anything else. (A partial git failure is not a refusal of the shape the user
 * asked for — it is returned as `{ ok: false }` so the caller can name the
 * repos that already moved; see `detachSubtask`.)
 */
export class DetachSubtaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DetachSubtaskError';
  }
}

/** A non-subtask cannot be detached (already top-level). */
export class NotASubtaskError extends DetachSubtaskError {
  constructor(ticketId: number) {
    super(`ticket ${formatId('ticket', ticketId)} is not a sub-task (no parent to detach from)`);
    this.name = 'NotASubtaskError';
  }
}

/** The parent does not exist or is archived (detach state is undefined). */
export class SubtaskParentNotFoundError extends DetachSubtaskError {
  constructor(ticketId: number, parentId: number) {
    super(`parent ticket ${formatId('ticket', parentId)} of sub-task ${formatId('ticket', ticketId)} does not exist or is archived`);
    this.name = 'SubtaskParentNotFoundError';
  }
}

/** The ticket id does not exist. */
export class DetachTicketNotFoundError extends DetachSubtaskError {
  constructor(ticketId: number) {
    super(`ticket ${formatId('ticket', ticketId)} does not exist`);
    this.name = 'DetachTicketNotFoundError';
  }
}

/**
 * A blocking sub-task cannot be detached: `blocks_parent = 1` is the parent's
 * leave-impl gate, and silently removing it would remove a gate the user chose
 * (design §5 scopes Detach to NON-blocking sub-tasks). Archive the sub-task if
 * it should stop holding the parent.
 */
export class BlockingSubtaskDetachError extends DetachSubtaskError {
  constructor(ticketId: number) {
    super(
      `cannot detach sub-task ${formatId('ticket', ticketId)}: it blocks its parent — archive it first if it should stop holding the parent`,
    );
    this.name = 'BlockingSubtaskDetachError';
  }
}

/**
 * A sub-task with open sub-tasks of its own cannot be detached: those children's
 * `base_ref` is this ticket's branch, and the detach rebase rewrites that branch
 * out from under them. There is no restack machinery, so the refusal names the
 * children to finish or archive first.
 */
export class SubtaskHasOpenChildrenError extends DetachSubtaskError {
  /** Keys of the open children that blocked the detach, in id order. */
  readonly childKeys: string[];
  constructor(ticketId: number, childKeys: string[]) {
    super(
      `cannot detach sub-task ${formatId('ticket', ticketId)}: it has open sub-tasks (${childKeys.join(', ')}) — finish or archive them first`,
    );
    this.name = 'SubtaskHasOpenChildrenError';
    this.childKeys = childKeys;
  }
}

/** Karst never rewrites a tree under a live agent (same rule as `onSubtaskLanded`). */
export class SubtaskAgentRunningError extends DetachSubtaskError {
  constructor(ticketId: number) {
    super(`cannot detach sub-task ${formatId('ticket', ticketId)} while its agent is running — stop the agent first`);
    this.name = 'SubtaskAgentRunningError';
  }
}

/** The topmost ancestor of `ticketId` (the ticket whose own parent is null). */
function rootAncestorId(store: Store, startId: number): number {
  const seen = new Set<number>();
  let cursor = startId;
  while (!seen.has(cursor)) {
    seen.add(cursor);
    const row = store.db
      .prepare('SELECT subtask_parent_id FROM tickets WHERE id = ?')
      .get(cursor) as { subtask_parent_id: number | null } | undefined;
    const next = row?.subtask_parent_id ?? null;
    if (next === null) return cursor;
    cursor = next;
  }
  // A corrupt cycle: stop at the last ticket seen rather than loop forever.
  return cursor;
}

/** The worktrees a ticket actually has — a repo selected but never spun has none. */
function worktreeRepoPaths(store: Store, ticketId: number): string[] {
  return (
    store.db
      .prepare('SELECT repo AS repoPath FROM worktrees WHERE ticket_id = ? ORDER BY repo')
      .all(ticketId) as { repoPath: string }[]
  ).map((row) => row.repoPath);
}

/**
 * The partial-failure reason for a multi-repo detach: name the repos that
 * already moved and the one that failed, and say a re-run is safe — repos that
 * are already on the target base short-circuit (`changeBaseRef` returns
 * `already-based` without touching git), so detach is idempotent.
 */
function partialFailureReason(
  moved: readonly string[],
  failedRepo: string,
  why: string,
): string {
  const prefix =
    moved.length > 0
      ? `${failedRepo} failed (${why}) after ${moved.join(', ')} already moved. `
      : `${failedRepo} failed: ${why}. `;
  return `${prefix}Re-running detach is safe: repos already on the target base are left untouched.`;
}

/**
 * Detach a sub-task from its parent (design NDL-70 §5 'Detach'): rebase it onto
 * the ROOT ancestor's base branch(es) and clear the parent link so the ticket
 * becomes genuinely top-level.
 *
 * Refusals (all thrown as `DetachSubtaskError`):
 * - the ticket does not exist, or is not a sub-task, or its parent is gone;
 * - the sub-task blocks its parent (`blocks_parent = 1`) — Detach is scoped to
 *   NON-blocking sub-tasks, and removing a leave-impl gate silently is a trap;
 * - the sub-task has open sub-tasks of its own — the rebase rewrites the branch
 *   their `base_ref` points at, and there is no restack machinery;
 * - the sub-task's agent is running — Karst never rewrites a tree under a live
 *   agent.
 *
 * Git work is done per ACTUAL `worktrees` row. A repo the sub-task selected but
 * never spun has no row and needs no rebase, so an unstarted sub-task detaches
 * by just clearing the link. For a nested sub-task the target is the root
 * ancestor's base for that repoPath: rebasing onto the immediate parent's branch
 * would leave the "top-level" ticket stacked on a feature branch no gate
 * watches.
 *
 * Ordering is the contract: every rebase happens first, then the guarded parent
 * link is cleared (with `blocks_parent` zeroed), and only then is the parent's
 * parked `awaiting-subtask` gate re-derived (`onSubtaskLanded`), so a parent
 * parked at ship is actually released instead of waiting for a reload.
 */
export async function detachSubtask(opts: DetachSubtaskOpts): Promise<DetachSubtaskResult> {
  const { store, manifest, ticketId, git, debug } = opts;

  const ticket = findTicketById(store, ticketId);
  if (!ticket) {
    debug?.(`[detach] ticket ${formatId('ticket', ticketId)} does not exist — refusing`);
    throw new DetachTicketNotFoundError(ticketId);
  }

  const parentId = ticket.subtaskParentId;
  if (parentId === null || parentId === undefined) {
    debug?.(`[detach] ticket ${formatId('ticket', ticketId)} is not a sub-task — refusing`);
    throw new NotASubtaskError(ticketId);
  }

  const parent = findTicketById(store, parentId);
  if (!parent || parent.archivedAt !== null) {
    debug?.(`[detach] parent ticket ${formatId('ticket', parentId)} does not exist or is archived — refusing`);
    throw new SubtaskParentNotFoundError(ticketId, parentId);
  }

  if (ticket.blocksParent) {
    debug?.(`[detach] sub-task ${formatId('ticket', ticketId)} blocks its parent — refusing`);
    throw new BlockingSubtaskDetachError(ticketId);
  }

  if (ticket.agentState === 'running') {
    debug?.(`[detach] sub-task ${formatId('ticket', ticketId)} has a running agent — refusing`);
    throw new SubtaskAgentRunningError(ticketId);
  }

  const openChildren = listOpenSubtasks(store, ticketId);
  if (openChildren.length > 0) {
    const keys = openChildren.map((c) => c.key ?? formatId('ticket', c.id));
    debug?.(`[detach] sub-task ${formatId('ticket', ticketId)} has open sub-tasks (${keys.join(', ')}) — refusing`);
    throw new SubtaskHasOpenChildrenError(ticketId, keys);
  }

  const rootId = rootAncestorId(store, parentId);
  debug?.(`[detach] detaching sub-task ${formatId('ticket', ticketId)} from parent ${formatId('ticket', parentId)} (root ${formatId('ticket', rootId)})`);

  const rebases = new Map<string, ChangeBaseRefResult>();
  const moved: string[] = [];

  for (const repoPath of worktreeRepoPaths(store, ticketId)) {
    const toBase = resolveTicketBaseRef(store, rootId, repoPath, manifest);
    debug?.(`[detach] rebasing worktree ${repoPath} onto root base ${toBase}`);

    const result = await changeBaseRef({
      store,
      manifest,
      ticketId,
      repoPath,
      toBase,
      git,
      gh: opts.gh,
      debug,
    });

    rebases.set(repoPath, result);
    if (!result.ok) {
      debug?.(`[detach] rebase failed for ${repoPath}: ${result.reason}`);
      return {
        ok: false,
        reason: partialFailureReason(moved, repoPath, result.reason),
        rebases,
      };
    }
    moved.push(repoPath);
  }

  // All rebases succeeded (or there was no git work). Clear the link through the
  // single guarded writer, then release any parked awaiting-subtask gate on the
  // parent — a detach exists precisely to unblock the parent's ship.
  if (!detachSubtaskParent(store, ticketId, parentId)) {
    debug?.(`[detach] ticket ${formatId('ticket', ticketId)} is no longer a sub-task of ${formatId('ticket', parentId)} — aborting`);
    return {
      ok: false,
      reason: `ticket ${formatId('ticket', ticketId)} is no longer a sub-task of ${formatId('ticket', parentId)} (re-parented or detached concurrently)`,
      rebases,
    };
  }
  debug?.(`[detach] ticket ${formatId('ticket', ticketId)} detached; subtask_parent_id cleared`);
  onSubtaskLanded(store, parentId, { debug });

  return { ok: true, reason: '', rebases };
}
