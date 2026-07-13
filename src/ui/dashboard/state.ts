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
import { STAGE_KEYS, type StageKey, type StageStatus } from '../../model/types.js';
import { repoDisplayPath, type PathContext } from '../worktreePath.js';

export type { PathContext };

/** One stepper cell — a stage node in the dashboard's stage stepper (§14). */
export interface StepperCell {
  stageKey: StageKey;
  status: StageStatus;
}

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
): DashboardState {
  const ticket = getTicket(store, ticketId); // throws on unknown id
  const byKey = new Map(ticket.stages.map((s) => [s.stageKey, s]));
  const stepper: StepperCell[] = STAGE_KEYS.map((stageKey) => ({
    stageKey,
    status: byKey.get(stageKey)?.status ?? 'pending',
  }));

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
  };
}
