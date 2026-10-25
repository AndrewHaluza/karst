import type { Store } from '../../store/db.js';
import type { Notify } from './notify.js';
import { getTicket } from '../../store/tickets.js';
import { formatTicketRef } from '../../model/entityId.js';
import { closeTicket, reopenTicket, type CloseReport } from '../../workflow/closeTicket.js';

/**
 * The human action behind `karst.closeTicket` / `karst.reopenTicket`: record that
 * a ticket was resolved OUTSIDE karst (`@arch:STAGEMACH`). The store move is
 * `closeTicket`; this op adds the host half. It stops the ticket's live work (the
 * driver round and the agent session) so a closed ticket stops being driven, and
 * it only REPORTS what it left behind: PRs, worktrees and running servers are
 * never touched, because an open PR or unmerged commit is work a person may
 * still want. Prompting for the reason is an injected seam, so this stays
 * host-agnostic and `extension.ts` keeps only the vscode binding.
 */
export interface CloseOpsDeps {
  readonly store: Store;
  readonly notify: Notify;
  readonly log: { error(m: string, e: unknown): void };
  /** Ask for the reason (and optional ref); `undefined` = the user cancelled. */
  readonly askReason: (ticketId: number) => Promise<{ reason: string; ref?: string } | undefined>;
  /** Stop the driver round and dispose the agent session for the ticket. */
  readonly stopWork: (ticketId: number) => void;
  readonly refresh: () => void;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** The "Left as is" tail of the close message; empty when nothing is left. */
export function describeLeft(left: CloseReport): string {
  const parts = [
    ...(left.openPrs > 0 ? [plural(left.openPrs, 'open PR')] : []),
    ...(left.worktrees > 0 ? [plural(left.worktrees, 'worktree')] : []),
    ...(left.runningServers > 0 ? [plural(left.runningServers, 'running server')] : []),
  ];
  return parts.length === 0 ? '' : ` Left as is: ${parts.join(', ')}.`;
}

const label = (store: Store, ticketId: number): string => {
  const t = getTicket(store, ticketId);
  return formatTicketRef(t.id, t.key);
};

export async function closeTicketOp(deps: CloseOpsDeps, ticketId: number): Promise<void> {
  const answer = await deps.askReason(ticketId);
  if (answer === undefined) return;
  let left: CloseReport;
  try {
    left = closeTicket(deps.store, ticketId, answer);
  } catch (err) {
    await deps.notify.error(err instanceof Error ? err.message : String(err));
    return;
  }
  try {
    deps.stopWork(ticketId);
  } catch (err) {
    deps.log.error('karst: stopping live work for a closed ticket failed', err);
  }
  deps.refresh();
  deps.notify.info(
    `Karst: closed ${label(deps.store, ticketId)} — resolved outside karst, nothing was verified.${describeLeft(left)}`,
  );
}

export async function reopenTicketOp(deps: CloseOpsDeps, ticketId: number): Promise<void> {
  try {
    reopenTicket(deps.store, ticketId);
  } catch (err) {
    await deps.notify.error(err instanceof Error ? err.message : String(err));
    return;
  }
  deps.refresh();
  deps.notify.info(`Karst: reopened ${label(deps.store, ticketId)} — back at implementation.`);
}
