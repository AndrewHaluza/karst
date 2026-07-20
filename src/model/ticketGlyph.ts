import type { TicketWithStages } from '../store/tickets.js';
import type { StageStatus, AgentState } from './types.js';
import { glyphFor, type Glyph } from './glyph.js';

/** Status of the ticket's current stage, defaulting to pending when unknown. */
export function currentStageStatus(t: TicketWithStages): StageStatus {
  const cur = t.stages.find((s) => s.stageKey === t.stageCurrent);
  return cur?.status ?? 'pending';
}

/**
 * The one derivation every surface (sidebar, tabs, terminal, status bar) uses so
 * they all show the same color. Wraps the H1 `glyphFor` over a ticket.
 */
export function ticketGlyph(t: TicketWithStages): Glyph {
  return glyphFor(currentStageStatus(t), (t.agentState ?? 'none') as AgentState);
}
