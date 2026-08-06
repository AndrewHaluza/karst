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
 *  1. A live agent asked a question (`agentState='waiting'`, from the
 *     idle_prompt / permission_prompt hooks).
 *  2. The ticket is parked at a confirm stage. No agent is involved at all here
 *     — ship runs no session, so no hook can ever fire — which is why this state
 *     was unreachable before and "Needs you" had no members.
 *
 * A PENDING confirm stage counts (the user has not clicked yet). So does `ship`
 * carrying an `awaiting-merge` block: the user already clicked "Confirm ship",
 * PRs are open, and now a merge (a human's click, on GitHub) is the only thing
 * left — that is still "blocked on the user", just a status of `passed` rather
 * than `pending`, since ship's own job did complete. A failed confirm stage is
 * blocked with a reason to show, which the existing derivation already gets
 * right.
 */
export function needsUser(t: TicketWithStages): boolean {
  if (((t.agentState ?? 'none') as AgentState) === 'waiting') return true;

  // `stageCurrent` is a stored string: a row from an older schema (or a stage
  // since removed from the graph) is not a StageKey and must not be treated as
  // one — the same narrowing stageBadge does.
  const stage = STAGE_KEYS.find((k) => k === t.stageCurrent);
  if (stage === undefined) return false;

  if (needsConfirm(stage) && currentStageStatus(t) === 'pending') return true;

  const current = t.stages.find((s) => s.stageKey === stage);
  return current?.blockedKind === 'awaiting-merge';
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
