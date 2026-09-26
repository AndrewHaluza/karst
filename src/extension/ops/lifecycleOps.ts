import type { Store } from '../../store/db.js';
import type { Notify } from './notify.js';
import type { PortAllocator } from '../../resolver/allocator.js';
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
    graphBytesRoot: string | undefined;
    artifactsRoot: string;
    /** Frees the deleted ticket's port allocations during worktree teardown. */
    ports: PortAllocator;
    /** Debug seam for the worktree teardown (bound to the host's debug channel). */
    debug?: (message: string) => void;
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
    const reaped = await deleteTicketPermanently(deps.store, ticketId, deps.deleteDeps);
    // Deleting the ticket removes the worktree out from under anything running
    // in it, so whatever had to be stopped is named here. A kill that FAILED is
    // a live server serving a deleted tree — the exact orphan P1-03 is about —
    // so it is a warning, not a debug line.
    for (const s of reaped) {
      deps.log.debug(describeReap(s));
      if (s.outcome === 'kill-failed') deps.notify.warn(describeReap(s));
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
