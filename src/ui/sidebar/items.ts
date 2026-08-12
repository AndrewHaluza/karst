import { ticketLabel, type TicketWithStages } from '../../store/tickets.js';
import { ticketGlyph, currentStageStatus } from '../../model/ticketGlyph.js';
import { stageBadge } from '../../model/stageBadge.js';
import { stageColorClass } from '../../model/stagePalette.js';
import type { Glyph } from '../../model/glyph.js';
import { sessionAction, type SessionAction } from '../../agent/sessionAction.js';
import { resolveProvider } from '../../agent/registry.js';
import type { AgentProvider } from '../../manifest/types.js';

/**
 * The expanded body's blocker line — the ONE thing the collapsed row can't show.
 * The row's left glyph already states the status (running / needs-you / failed /
 * done) by color and the chip states the stage, so a plain "UAT failed" phrase is
 * pure duplication. The failure REASON (the stage verdict) is the new information,
 * so this is populated only when the current stage failed; `null` otherwise, and
 * the line is then not rendered at all.
 */
export interface Blocker {
  /** The failure reason (stage `verdict`), or null when the stage failed without one. */
  reason: string | null;
  /** Attempt the failure is filed under (0 when none). */
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
   * The blocker line for the expanded body — the failure reason + attempt, and
   * only when the current stage failed. `null` (line omitted) otherwise, because
   * every non-failed status is already the row's left glyph color.
   */
  blocker: Blocker | null;
  /**
   * What the row's session button does and reads — "Continue" a captured
   * interactive session, or "Start" a fresh one. The single, always-visible
   * returning-user entry point, so it must never be a generic verb that hides
   * which of the two will happen.
   */
  sessionAction: SessionAction;
  /**
   * When the current stage last moved (its `endedAt` else `startedAt`), or null.
   * Raw ISO — the webview formats it relative to the viewer's clock ("4m ago").
   */
  lastActiveAt: string | null;
  /** Per-ticket launch model (`ticket.model`); null = inherit the manifest default. */
  model: string | null;
  /** True when soft-deleted; drives the archived row actions (unarchive/delete). */
  archived: boolean;
  /** The parent ticket's key, when this ticket was created via "create follow-up"; else null. */
  parentKey: string | null;
  collapsible: true;
}

/** Map each ticket to a collapsible root node carrying its state glyph. */
export function buildTicketNodes(
  tickets: readonly TicketWithStages[],
  labelTemplate?: string,
  /** Manifest-level agent core; see `sessionAction`'s `provider`. */
  defaultProvider?: AgentProvider,
  /** id -> key, for every ticket in the project (not just the currently visible facet). */
  parentKeys: Map<number, string> = new Map(),
): TicketNode[] {
  return tickets.map((t) => {
    const badge = stageBadge(t);
    const current = t.stages.find((s) => s.stageKey === t.stageCurrent);
    const failed = currentStageStatus(t) === 'failed';
    const blocker: Blocker | null = failed
      ? { reason: current?.verdict ?? null, attempt: current?.attempt ?? 0 }
      : null;
    return {
      kind: 'ticket',
      ticketId: t.id,
      label: ticketLabel(t, labelTemplate),
      glyph: badge.glyph,
      description: `${t.stageCurrent ?? 'none'} (${currentStageStatus(t)})`,
      stageLabel: badge.label,
      stageClass: stageColorClass(badge.stage),
      stageChip: badge.stage ?? 'none',
      blocker,
      sessionAction: sessionAction(t, resolveProvider(t.agentProvider, defaultProvider)),
      lastActiveAt: current?.endedAt ?? current?.startedAt ?? null,
      model: t.model,
      archived: t.archivedAt !== null,
      parentKey: t.parentTicketId !== null ? (parentKeys.get(t.parentTicketId) ?? null) : null,
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

/**
 * A ticket is COMPLETED when its current stage is the terminal `done` stage.
 * The sectioning source of truth — the Current list is everything this says no
 * to, so "completing a ticket removes it from Current" holds by construction,
 * and reopening a done ticket (stage moved away) restores it to Current
 * automatically. Deliberately `stageCurrent`, not the glyph-derived `done`
 * facet: the facet answers "is the row's dot green", while this answers "has
 * the ticket reached the terminal stage" — a ticket parked at a passed ship
 * is awaiting a merge (amber), never completed.
 */
export function isDoneTicket(t: TicketWithStages): boolean {
  return t.stageCurrent === 'done';
}

/**
 * Completion timestamp for ordering the completed sections: the done stage's
 * end, else its start, else the ticket's own last update. `null` only when the
 * ticket carries no timestamp at all — such a ticket sorts LAST in every
 * newest-first list, never first (an unknown completion time must not read as
 * the most recent completion).
 *
 * The `updated_at` fallback is normalized to ISO-8601 UTC: some writers use
 * SQLite's `datetime('now')` space form, and a lexicographic comparison between
 * a space-form and a `T`-form timestamp of the same day mis-orders every pair
 * where the space-form time is actually later (model/time.ts's "one format"
 * invariant only holds for the stage writers).
 */
export function completedAt(t: TicketWithStages): string | null {
  const done = t.stages.find((s) => s.stageKey === 'done');
  const raw = done?.endedAt ?? done?.startedAt ?? t.updatedAt ?? null;
  if (raw === null) return null;
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  return /[zZ]$/.test(iso) ? iso : `${iso}Z`;
}
