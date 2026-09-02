import type { TicketWithStages } from '../store/tickets.js';
import { STAGE_KEYS, type StageKey } from './types.js';
import { isTerminal } from '../workflow/graph.js';
import { currentStageStatus, needsUser, ticketGlyph } from './ticketGlyph.js';
import type { Glyph } from './glyph.js';

/**
 * Human name for each stage — the one place the graph's keys become words. The
 * mock (docs/design/orchestrator-mockup.html) hand-authored these per ticket;
 * here they are derived, so the badge can never drift from the stored state.
 */
export const STAGE_TITLE: Readonly<Record<StageKey, string>> = {
  scope: 'Scope',
  impl: 'Implementation',
  uat: 'UAT',
  review: 'Review',
  fix: 'Fix',
  ship: 'Ship',
  done: 'Done',
};

/** What a stage reads as while it is actually running. */
const STAGE_ACTIVITY: Readonly<Record<StageKey, string>> = {
  scope: 'Scoping',
  impl: 'Implementing',
  uat: 'Validating',
  review: 'Reviewing',
  fix: 'Fixing',
  ship: 'Shipping',
  done: 'Done',
};

/** A ticket's stage rendered for display: the label plus its palette color. */
export interface StageBadge {
  /** Human phrase for (stage, status, agent) — e.g. "UAT failed". */
  label: string;
  /** Palette color, from the single glyph source (H1) — never a per-view hex. */
  glyph: Glyph;
  /**
   * The stage itself, or null when the ticket has none (never started, or its
   * stored stage is outside the graph).
   *
   * Separate from `label` because the two answer different questions: `label`
   * folds status and agent state into a phrase ("Implementing", "Needs you"),
   * while the row chip states WHERE the ticket is and lets the status dot on the
   * other side of the row state whether it needs you. The chip used to render
   * `label`, so a stage slot carried status words in two colors — three stages
   * were indistinguishable and `fix` never appeared at all.
   */
  stage: StageKey | null;
}

/**
 * The one derivation of a ticket's stage badge, shared by every ticket list.
 *
 * Precedence mirrors `ticketGlyph`: needs-you outranks stage state, because it
 * is the thing the user must act on — whether that is a waiting agent or a stage
 * parked on a click. A ticket with no current stage — or whose current stage has
 * no row yet — falls back rather than rendering blank, so "nothing to show"
 * never reads as an error.
 */
export function stageBadge(t: TicketWithStages): StageBadge {
  const glyph = ticketGlyph(t);
  // `stageCurrent` is a stored string: a row written by an older schema (or a
  // stage since removed from the graph) is not a StageKey, and is treated the
  // same as none rather than indexing the title map with it.
  const stage = STAGE_KEYS.find((k) => k === t.stageCurrent) ?? null;
  if (t.pausedAt != null) return { label: 'Paused', glyph: 'gray', stage };
  if (stage === null) return { label: 'Not started', glyph, stage };

  const title = STAGE_TITLE[stage];
  // Both needs-you sources (a waiting agent, a stage parked on a click) resolve
  // in `needsUser`, so this label and the amber glyph always agree.
  if (needsUser(t)) return { label: 'Needs you', glyph, stage };

  const status = currentStageStatus(t);
  if (status === 'failed') return { label: `${title} failed`, glyph, stage };
  if (status === 'running') return { label: STAGE_ACTIVITY[stage], glyph, stage };
  if (status === 'skipped') return { label: `${title} skipped`, glyph, stage };
  if (status === 'passed') {
    // Arriving at a terminal stage IS completing it (workflow/machine.ts), so
    // the exit reads as the outcome, not as another finished step.
    return { label: isTerminal(stage) ? 'Done' : `${title} passed`, glyph, stage };
  }
  // pending
  if (stage === 'scope') return { label: 'Not scoped', glyph, stage };
  return { label: `Awaiting ${title.toLowerCase()}`, glyph, stage };
}
