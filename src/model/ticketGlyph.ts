import type { TicketWithStages } from '../store/tickets.js';
import { STAGE_KEYS, type StageStatus, type AgentState } from './types.js';
import { needsConfirm } from '../workflow/graph.js';
import { glyphFor, type Glyph } from './glyph.js';

/** Status of the ticket's current stage, defaulting to pending when unknown. */
export function currentStageStatus(t: TicketWithStages): StageStatus {
  const cur = t.stages.find((s) => s.stageKey === t.stageCurrent);
  return cur?.status ?? 'pending';
}

/**
 * Whether the ticket is blocked on the user — the needs-you signal, in one place
 * so the color, the badge and the facet can never disagree about it.
 *
 * TWO independent sources, because they are genuinely different situations:
 *
 *  1. A live agent presented an actionable input (`agentState='waiting'`, from
 *     permission_prompt / agent_needs_input / elicitation_dialog hooks).
 *  2. The ticket is parked at a confirm stage. No agent is involved at all here
 *     — ship runs no session, so no hook can ever fire — which is why this state
 *     was unreachable before and "Needs you" had no members.
 *
 * Only a PENDING confirm stage counts. A confirm stage that is running is
 * genuinely working (the user already clicked), and a failed one is blocked with
 * a reason to show — both are answers the existing derivation already gets right.
 */
export function needsUser(t: TicketWithStages): boolean {
  if (((t.agentState ?? 'none') as AgentState) === 'waiting') return true;

  // `stageCurrent` is a stored string: a row from an older schema (or a stage
  // since removed from the graph) is not a StageKey and must not be treated as
  // one — the same narrowing stageBadge does.
  const stage = STAGE_KEYS.find((k) => k === t.stageCurrent);
  if (stage === undefined) return false;

  return needsConfirm(stage) && currentStageStatus(t) === 'pending';
}

/**
 * The one derivation every surface (sidebar, tabs, terminal, status bar) uses so
 * they all show the same color. Wraps the H1 `glyphFor` over a ticket, with the
 * needs-you override applied first — `glyphFor` sees only (status, agentState)
 * and so cannot know that a parked confirm stage is waiting on a human.
 */
export function ticketGlyph(t: TicketWithStages): Glyph {
  if (needsUser(t)) return 'amber';
  return glyphFor(currentStageStatus(t), (t.agentState ?? 'none') as AgentState);
}
