import type { TicketWithStages } from '../store/tickets.js';
import type { AgentState } from '../model/types.js';
import { facetOf } from './sidebar/facets.js';

/**
 * Why a ticket is in the attention set. `input` and `failed` are the two
 * `facetOf` buckets that mean "not progressing without you"; a ticket is in
 * exactly one, because `ticketGlyph` already resolves amber (needs-you) ahead of
 * red (blocked).
 */
export type AttentionKind = 'input' | 'failed';

export interface AttentionItem {
  ticketId: number;
  /** `t.key`, falling back to `#<id>` — the same fallback the status bar uses. */
  key: string;
  /** `t.title ?? ''`; the QuickPick detail line is simply blank when empty. */
  title: string;
  stage: string;
  kind: AttentionKind;
  /** Derived phrase, e.g. `agent asked a question`. */
  reason: string;
}

/**
 * The reason is DERIVED, never stored: `stages` holds no failure text, so any
 * more specific sentence would be invented. An `input` ticket that is not
 * waiting on a live agent is, by `needsUser`'s definition, parked at a pending
 * confirm stage — that is the whole remaining case.
 */
function reasonFor(t: TicketWithStages, kind: AttentionKind, stage: string): string {
  if (kind === 'failed') return `${stage} failed`;
  if (((t.agentState ?? 'none') as AgentState) === 'waiting') return 'agent asked a question';
  return `awaiting confirmation · ${stage}`;
}

const KIND_ORDER: Record<AttentionKind, number> = { failed: 0, input: 1 };

/**
 * The tickets that will not move without the user, most urgent first.
 *
 * Membership reads `facetOf` — the same call the sidebar chips make — rather
 * than re-deriving from (status, agentState). Re-deriving is exactly how the
 * "Needs you" bucket once came to be unreachable.
 */
export function attentionItems(tickets: readonly TicketWithStages[]): AttentionItem[] {
  const rows: Array<{ item: AttentionItem; updatedAt: string | null }> = [];
  for (const t of tickets) {
    const kind = facetOf(t);
    if (kind !== 'input' && kind !== 'failed') continue;
    const stage = t.stageCurrent ?? 'none';
    rows.push({
      item: {
        ticketId: t.id,
        key: t.key ?? `#${t.id}`,
        title: t.title ?? '',
        stage,
        kind,
        reason: reasonFor(t, kind, stage),
      },
      updatedAt: t.updatedAt,
    });
  }
  rows.sort((a, b) => {
    const byKind = KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind];
    if (byKind !== 0) return byKind;
    // A missing timestamp is UNKNOWN, not ancient — it must not jump the queue
    // ahead of a ticket we know has been waiting.
    if (a.updatedAt === b.updatedAt) return a.item.ticketId - b.item.ticketId;
    if (a.updatedAt === null) return 1;
    if (b.updatedAt === null) return -1;
    return a.updatedAt < b.updatedAt ? -1 : 1;
  });
  return rows.map((r) => r.item);
}
