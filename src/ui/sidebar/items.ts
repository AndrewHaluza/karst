import { ticketLabel, type TicketWithStages } from '../../store/tickets.js';
import type { StageStatus, AgentState } from '../../model/types.js';
import { glyphFor, type Glyph } from '../../model/glyph.js';

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
  /** True when soft-deleted; drives the archived row actions (unarchive/delete). */
  archived: boolean;
  collapsible: true;
}

/** Status of the ticket's current stage, defaulting to pending when unknown. */
function currentStageStatus(t: TicketWithStages): StageStatus {
  const cur = t.stages.find((s) => s.stageKey === t.stageCurrent);
  return cur?.status ?? 'pending';
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
    glyph: glyphFor(currentStageStatus(t), (t.agentState ?? 'none') as AgentState),
    description: `${t.stageCurrent ?? 'none'} (${currentStageStatus(t)})`,
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
