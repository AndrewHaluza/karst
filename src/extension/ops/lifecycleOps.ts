import type { Store } from '../../store/db.js';
import type { PortAllocator } from '../../resolver/allocator.js';
import type { Notify } from './notify.js';
import { getTicket, ticketLabel } from '../../store/tickets.js';
import { deleteTicketPermanently } from '../../runtime/deleteTicket.js';
import { describeReap } from '../../runtime/worktreeServers.js';
import { createFollowUpTicket, TicketNotDoneError } from '../../workflow/stages/followUp.js';
import { createSubtask } from '../../workflow/stages/subtask.js';
import type { GitRunner } from '../../integrations/git.js';
import type { GhRunner } from '../../integrations/github.js';
import { detachSubtask, DetachSubtaskError, type DetachSubtaskResult } from '../../workflow/detachSubtask.js';
import { describeChangeBaseRef } from '../../workflow/changeBaseRef.js';
import type { Manifest } from '../../manifest/types.js';
import { formatTicketRef } from '../../model/entityId.js';

export interface LifecycleOpsDeps {
  readonly store: Store;
  readonly notify: Notify;
  readonly log: { debug(m: string): void; warn(m: string): void };
  readonly confirm: (message: string, confirmLabel: string) => Promise<boolean>;
  readonly deleteDeps: {
    closePanel: (id: number) => void;
    reap: (id: number) => Promise<void>;
    allocator: PortAllocator;
    graphBytesRoot: string | undefined;
    artifactsRoot: string;
  };
  readonly openEdit: (id: number) => void;
  readonly refresh: () => void;
  readonly reloadManifest: () => Promise<void>;
  readonly projectId: () => number | undefined;
  readonly labelTemplate: () => string | undefined;
  readonly git: GitRunner;
  readonly gh?: GhRunner;
  readonly manifest: () => Manifest | undefined;
  /** Mirror a new sub-task onto the ticketing provider (`ticketing.syncSubtasks`); never throws. */
  readonly syncSubtask?: (childId: number) => Promise<void>;
}

export async function deleteTicketOp(deps: LifecycleOpsDeps, ticketId: number): Promise<void> {
  const label = ticketLabel(getTicket(deps.store, ticketId), deps.labelTemplate());
  // Hard delete is irreversible — confirm with a modal before removing the
  // ticket and all its child rows.
  if (!(await deps.confirm(`Permanently delete "${label}"? This cannot be undone.`, 'Delete'))) return;
  try {
    const outcome = await deleteTicketPermanently(deps.store, ticketId, deps.deleteDeps);
    // Deleting the ticket takes its `servers` rows with it, so this is the last
    // moment anything running inside the worktrees can be named. A kill that
    // FAILED is a live server serving a deleted tree — the exact orphan this
    // route exists to end — so it is a warning, not a debug line.
    for (const s of outcome.reapedServers) {
      deps.log.debug(describeReap(s));
      if (s.outcome === 'kill-failed') await deps.notify.warn(describeReap(s));
    }
    if (outcome.failedWorktrees > 0) {
      await deps.notify.warn(
        `Karst deleted "${label}" but could not remove ${outcome.failedWorktrees} worktree folder(s); ` +
          `they may remain on disk.`,
      );
    }
  } catch (err) {
    const message =
      `Karst could not finish permanently deleting "${label}". ` +
      `Attachment cleanup may be incomplete: ${String(err)}`;
    deps.log.warn(message);
    await deps.notify.error(message);
  }
  deps.refresh();
}

export async function createFollowUpTicketOp(deps: LifecycleOpsDeps, ticketId: number): Promise<void> {
  let child;
  try {
    child = createFollowUpTicket(deps.store, ticketId, { projectId: deps.projectId() },
      (message) => deps.log.debug(message));
  } catch (err) {
    const message =
      err instanceof TicketNotDoneError
        ? err.message
        : `Couldn't create a follow-up ticket: ${err instanceof Error ? err.message : String(err)}`;
    await deps.notify.error(message);
    return;
  }
  deps.refresh();
  await deps.reloadManifest();
  deps.openEdit(child.id);
  await deps.notify.info(`Created follow-up ticket ${child.key}.`);
}

/** The user-supplied facts a "Add sub-task" gathers before the writer runs. */
export interface CreateSubtaskInput {
  title: string;
  description?: string;
  /** Holds the parent before it leaves impl/fix (design NDL-70 §5). */
  blocking?: boolean;
  /** Repos the sub-task touches; defaults to every parent repo. */
  repos?: string[];
}

/**
 * Create a sub-task under `parentId` through the single writer, so every §3
 * rule (parent open, depth, repo subset) is enforced host-side. The title and
 * the blocking choice are collected by the command binding — this op stays
 * vscode-free like its follow-up sibling. On success it opens the new sub-task
 * in its edit form, which is where its description is filled in.
 */
export async function createSubtaskOp(
  deps: LifecycleOpsDeps,
  parentId: number,
  input: CreateSubtaskInput,
): Promise<void> {
  let child;
  try {
    // Not queued yet: the description is written in the edit form opened
    // below, and an agent must never launch before its ask exists. Saving the
    // form is what queues it (`setAutostartPending`).
    child = createSubtask(deps.store, parentId, { ...input, start: false, relationSource: 'user' }, { projectId: deps.projectId() },
      (message) => deps.log.debug(message));
  } catch (err) {
    // Every Subtask*Error message is user-ready (it names the rule and the
    // remedy), so it passes through unchanged.
    const message =
      err instanceof Error ? err.message : `Couldn't create a sub-task: ${String(err)}`;
    await deps.notify.error(message);
    return;
  }
  await deps.syncSubtask?.(child.id);
  deps.refresh();
  await deps.reloadManifest();
  deps.openEdit(child.id);
  await deps.notify.info(`Created sub-task ${child.key}.`);
}

/**
 * The success toast for a detach: which repos moved and onto what, reusing the
 * same per-repo wording as the live base-branch change (`describeChangeBaseRef`),
 * including a refused PR re-target. A detach with no started worktrees says so.
 */
function describeDetach(key: string, result: DetachSubtaskResult): string {
  if (result.rebases.size === 0) {
    return `Detached ${key} from its parent (no started worktrees to rebase).`;
  }
  const parts = [...result.rebases.entries()].map(
    ([repoPath, rebase]) => `${repoPath}: ${describeChangeBaseRef(rebase)}`,
  );
  return `Detached ${key} from its parent. ${parts.join(' ')}`;
}

/**
 * Detach a non-blocking sub-task from its parent (design NDL-70 §5 'Detach'):
 * rebase it onto its root ancestor's base and clear the parent link so it
 * becomes top-level. This allows a started sub-task to be detached without
 * holding the parent's ship.
 *
 * Validation refusals throw a `DetachSubtaskError` whose message is user-ready
 * and passes through unchanged; a partial git failure is a returned
 * `{ ok: false }` naming the repos that already moved.
 */
export async function detachSubtaskOp(deps: LifecycleOpsDeps, subtaskId: number): Promise<void> {
  const manifestNow = deps.manifest();
  if (!manifestNow) {
    await deps.notify.error('No manifest is loaded — cannot detach sub-task.');
    return;
  }

  let result: DetachSubtaskResult;
  try {
    result = await detachSubtask({
      store: deps.store,
      manifest: manifestNow,
      ticketId: subtaskId,
      git: deps.git,
      gh: deps.gh,
      debug: (message) => deps.log.debug(message),
    });
  } catch (err) {
    const message =
      err instanceof DetachSubtaskError
        ? err.message
        : `Couldn't detach the sub-task: ${err instanceof Error ? err.message : String(err)}`;
    await deps.notify.error(message);
    return;
  }

  if (!result.ok) {
    await deps.notify.error(`Could not detach sub-task: ${result.reason}`);
    return;
  }

  deps.refresh();
  await deps.reloadManifest();
  const ticket = getTicket(deps.store, subtaskId);
  await deps.notify.info(describeDetach(formatTicketRef(subtaskId, ticket.key), result));
}
