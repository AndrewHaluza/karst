import { ticketLabel, type TicketWithStages } from '../../store/tickets.js';
import { ticketGlyph, currentStageStatus } from '../../model/ticketGlyph.js';
import { stageBadge } from '../../model/stageBadge.js';
import type { Glyph } from '../../model/glyph.js';

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
  /** True when soft-deleted; drives the archived row actions (unarchive/delete). */
  archived: boolean;
  collapsible: true;
}

/** Map each ticket to a collapsible root node carrying its state glyph. */
export function buildTicketNodes(
  tickets: readonly TicketWithStages[],
  labelTemplate?: string,
): TicketNode[] {
  return tickets.map((t) => ({
    kind: 'ticket',
    ticketId: t.id,
    label: ticketLabel(t, labelTemplate),
    glyph: ticketGlyph(t),
    description: `${t.stageCurrent ?? 'none'} (${currentStageStatus(t)})`,
    stageLabel: stageBadge(t).label,
    archived: t.archivedAt !== null,
    collapsible: true,
  }));
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
