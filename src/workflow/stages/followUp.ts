import type { Store } from '../../store/db.js';
import {
  createTicket,
  getTicket,
  getTicketByKey,
  updateTicketFields,
  type ProjectScope,
  type Ticket,
} from '../../store/tickets.js';

/**
 * A ticket is only a valid follow-up source once its work has actually
 * shipped (§ continue work on a ticket) — `done` is the stage graph's only
 * terminal state (graph.ts), so this is the one deterministic gate. Checked
 * here even though the UI only offers the action once a ticket is `done`, in
 * case a stale view triggers it anyway.
 */
export class TicketNotDoneError extends Error {
  constructor(ticketId: number, stageCurrent: string | null) {
    super(`ticket #${ticketId} is not done yet (stage: ${stageCurrent ?? 'none'})`);
    this.name = 'TicketNotDoneError';
  }
}

/** Next unclaimed `<parentKey>-fu<n>` suffix, scoped like every other key lookup. */
function nextFollowUpKey(store: Store, parentKey: string, scope: ProjectScope): string {
  for (let n = 1; n <= 999; n++) {
    const candidate = `${parentKey}-fu${n}`;
    if (!getTicketByKey(store, candidate, scope)) return candidate;
  }
  throw new Error(`could not generate a unique follow-up key for ${parentKey}`);
}

/**
 * Create a follow-up ticket linked to a completed parent (§ continue work on
 * a ticket). The child inherits the parent's repos/approach/agent/model so it
 * is ready to spin immediately on a fresh worktree — no special worktree or
 * branch handling is needed, since the parent's merged work already lives on
 * the configured base branch. The user only has to write the actual
 * follow-up ask into the new ticket's description.
 */
export function createFollowUpTicket(
  store: Store,
  parentTicketId: number,
  scope: ProjectScope = {},
  debug?: (message: string) => void,
): Ticket {
  const parent = getTicket(store, parentTicketId);
  debug?.(
    `[driver] follow-up for ticket #${parentTicketId}: parent stage is '${parent.stageCurrent ?? 'none'}'`,
  );
  if (parent.stageCurrent !== 'done') {
    debug?.(
      `[driver] follow-up for ticket #${parentTicketId}: parent not done — refusing`,
    );
    throw new TicketNotDoneError(parentTicketId, parent.stageCurrent);
  }

  const parentKey = parent.key ?? `#${parent.id}`;
  const key = nextFollowUpKey(store, parentKey, scope);
  debug?.(`[driver] follow-up for ticket #${parentTicketId}: creating child '${key}'`);
  const child = createTicket(store, {
    key,
    title: parent.title ?? parentKey,
    source: 'karst',
    projectId: scope.projectId,
    parentTicketId: parent.id,
  });

  updateTicketFields(store, child.id, {
    approach: parent.approach ?? undefined,
    agent: parent.agent ?? undefined,
    selectedRepos: parent.selectedRepos,
    model: parent.model ?? undefined,
    agentProvider: parent.agentProvider ?? undefined,
  });

  debug?.(`[driver] follow-up for ticket #${parentTicketId}: child #${child.id} ('${key}') created`);
  return getTicket(store, child.id);
}
