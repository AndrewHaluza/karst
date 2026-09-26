import type { Store } from '../../store/db.js';
import type { PortAllocator } from '../../resolver/allocator.js';
import type { Notify } from './notify.js';
import { getTicket, ticketLabel } from '../../store/tickets.js';
import { deleteTicketPermanently } from '../../runtime/deleteTicket.js';
import { describeReap } from '../../runtime/worktreeServers.js';
import { createFollowUpTicket, TicketNotDoneError } from '../../workflow/stages/followUp.js';

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
