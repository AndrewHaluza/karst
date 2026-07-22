import { ticketLabel, type TicketWithStages } from '../../store/tickets.js';
import { ticketGlyph, currentStageStatus, needsUser } from '../../model/ticketGlyph.js';
import { stageBadge, STAGE_TITLE } from '../../model/stageBadge.js';
import { stageColorClass } from '../../model/stagePalette.js';
import type { Glyph } from '../../model/glyph.js';
import type { StageKey, StageStatus } from '../../model/types.js';

/** The five linear milestones the expanded rail always renders, in order. */
const RAIL_STAGES: readonly StageKey[] = ['scope', 'impl', 'uat', 'review', 'ship'];

/**
 * Which rail segment carries the "current" ring for a given stored stage. `fix`
 * (a retry loop off review) and `done` (terminal, after ship) are not linear rail
 * segments, so they borrow the nearest milestone: fix→review, done→ship. Every
 * other stage maps to itself; an unknown/absent stage → no current cell.
 */
function currentRailKey(stageCurrent: string | null): StageKey | null {
  if (stageCurrent === 'fix') return 'review';
  if (stageCurrent === 'done') return 'ship';
  return RAIL_STAGES.find((k) => k === stageCurrent) ?? null;
}

/** One segment of the expanded-body stage rail. */
export interface RailCell {
  key: StageKey;
  /** Human milestone name (STAGE_TITLE) — the same words the dashboard uses. */
  title: string;
  /** Status from the matching stage row; `pending` when the row is absent. */
  status: StageStatus;
  /** True only for the ticket's current stage. */
  current: boolean;
  /** Shared `stg-<stage>` color token (single palette source). */
  colorClass: string;
}

/** The one actionable line for the expanded body. */
export interface NextAction {
  /** The sentence, e.g. "UAT failed: 2 tests red" or "Awaiting review". */
  text: string;
  /** True when it demands attention (needs-you or a failed stage) → warn tone. */
  warn: boolean;
  /** Attempt number to show; 0 when not applicable (hidden). */
  attempt: number;
}

/**
 * Plain, vscode-free row model for the sidebar ticket list (§14). The webview
 * renders these; keeping the model pure makes it unit-testable without the editor
 * host and keeps the glyph as the single source (H1).
 */
export interface TicketNode {
  kind: 'ticket';
  ticketId: number;
  label: string;
  glyph: Glyph;
  /** Dimmed text beside the label — the current stage, visible when folded. */
  description: string;
  /**
   * Human stage phrase for the row pill and the expanded Stage line ("UAT
   * failed", "Not scoped"). Always set — `stageBadge` defines the fallback, so
   * a stageless ticket renders a phrase rather than an empty pill.
   */
  stageLabel: string;
  /**
   * Color class for the stage chip — the same `stg-<stage>` token the dashboard
   * rail paints with, so a stage reads the identical color in both views. Falls
   * back to `stg-unknown` for a stageless ticket rather than rendering uncolored.
   */
  stageClass: string;
  /**
   * The chip's TEXT: the bare stage key (the view uppercases it), NOT the
   * status phrase in `stageLabel`. Status is already the dot on the left of the
   * row, so the chip states only where the ticket is. `none` when there is no
   * stage yet.
   */
  stageChip: string;
  /**
   * Fixed 5-segment pipeline rail for the expanded body — scope→impl→uat→review
   * →ship, each colored by its own status. `fix`/`done` are not linear segments
   * (they surface in the next-action line), so the rail stays a stable width.
   */
  rail: RailCell[];
  /** Current stage's failure reason (`verdict`), or null. Drives the "… failed: <reason>" line. */
  reason: string | null;
  /** Current stage's attempt count (0 when no current stage). */
  attempt: number;
  /** The one actionable line for the expanded body, derived from real stage status. */
  nextAction: NextAction;
  /** Per-ticket launch model (`ticket.model`); null = inherit the manifest default. */
  model: string | null;
  /** True when soft-deleted; drives the archived row actions (unarchive/delete). */
  archived: boolean;
  collapsible: true;
}

/** Map each ticket to a collapsible root node carrying its state glyph. */
export function buildTicketNodes(
  tickets: readonly TicketWithStages[],
  labelTemplate?: string,
): TicketNode[] {
  return tickets.map((t) => {
    const badge = stageBadge(t);
    const current = t.stages.find((s) => s.stageKey === t.stageCurrent);
    const currentKey = currentRailKey(t.stageCurrent);
    const rail: RailCell[] = RAIL_STAGES.map((key) => {
      const s = t.stages.find((st) => st.stageKey === key);
      return {
        key,
        title: STAGE_TITLE[key],
        status: s?.status ?? 'pending',
        current: key === currentKey,
        colorClass: stageColorClass(key),
      };
    });
    const status = currentStageStatus(t);
    const failed = status === 'failed';
    const nextAction: NextAction = {
      text: failed && current?.verdict ? `${badge.label}: ${current.verdict}` : badge.label,
      warn: failed || needsUser(t),
      attempt: failed ? (current?.attempt ?? 0) : 0,
    };
    return {
      kind: 'ticket',
      ticketId: t.id,
      label: ticketLabel(t, labelTemplate),
      glyph: badge.glyph,
      description: `${t.stageCurrent ?? 'none'} (${currentStageStatus(t)})`,
      stageLabel: badge.label,
      stageClass: stageColorClass(badge.stage),
      stageChip: badge.stage ?? 'none',
      rail,
      reason: current?.verdict ?? null,
      attempt: current?.attempt ?? 0,
      nextAction,
      model: t.model,
      archived: t.archivedAt !== null,
      collapsible: true,
    };
  });
}

/** Case-insensitive substring filter over key + title; blank query = all. */
export function filterTickets(
  tickets: readonly TicketWithStages[],
  query: string,
): TicketWithStages[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...tickets];
  return tickets.filter((t) =>
    `${t.key ?? ''} ${t.title ?? ''}`.toLowerCase().includes(q),
  );
}
