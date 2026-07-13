import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import {
  listServersByTicket,
  listWorktreesByTicket,
  listPrsByTicket,
  type ServerView,
  type WorktreeView,
  type PrView,
} from '../../store/dashboard.js';
import type { TicketProvider } from '../../manifest/types.js';
import { providerTicketUrl } from '../../integrations/ticketUrl.js';
import { buildStepper, type StepperCell } from '../../model/stepper.js';
import { repoDisplayPath, type PathContext } from '../worktreePath.js';

export type { PathContext, StepperCell };

/** Fully serializable dashboard state pushed to the webview via postMessage. */
export interface DashboardState {
  ticketId: number;
  key: string | null;
  title: string | null;
  stageCurrent: string | null;
  agentState: string | null;
  stepper: StepperCell[];
  servers: ServerView[];
  worktrees: WorktreeView[];
  prs: PrView[];
  /** Configured ticketing provider ('clickup' | 'manual'); null when unknown. */
  provider: string | null;
  /** The board ref the ticket was fetched from, or null. */
  sourceRef: string | null;
  /** External board URL for the ticket, or null (manual/unfetched → no link). */
  ticketUrl: string | null;
  /** Synthesized context brief, shown as a hover on the provider link; or null. */
  brief: string | null;
}

/**
 * Gather everything a ticket dashboard renders, in one snapshot. The stepper is
 * ordered by STAGE_KEYS (not by stage-row insertion) so the stepper is stable.
 * Throws if the ticket id is unknown (validated at the boundary).
 */
export function buildDashboardState(
  store: Store,
  ticketId: number,
  pathContext?: PathContext,
  ticketing?: { provider?: TicketProvider },
): DashboardState {
  const ticket = getTicket(store, ticketId); // throws on unknown id
  const stepper = buildStepper(ticket.stages);

  const worktrees = listWorktreesByTicket(store, ticketId).map((w) => ({
    ...w,
    repoDisplay: repoDisplayPath(w.repo, pathContext),
  }));

  return {
    ticketId: ticket.id,
    key: ticket.key,
    title: ticket.title,
    stageCurrent: ticket.stageCurrent,
    agentState: ticket.agentState,
    stepper,
    servers: listServersByTicket(store, ticketId),
    worktrees,
    prs: listPrsByTicket(store, ticketId),
    provider: ticketing?.provider ?? null,
    sourceRef: ticket.sourceRef,
    ticketUrl: providerTicketUrl(ticketing?.provider, ticket.sourceRef),
    brief: ticket.brief,
  };
}
