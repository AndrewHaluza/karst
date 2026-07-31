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

export interface AttentionSummary {
  count: number;
  /** Status-bar label, e.g. `$(bell) 2 need you`. */
  text: string;
  /** Multi-line status-bar tooltip, one `key · reason` line per ticket. */
  tooltip: string;
  /** True when any item is `failed` — drives the warning background. */
  warning: boolean;
  /** Badge tooltip, e.g. `2 tickets need your input`. */
  badgeTooltip: string;
}

/** A tooltip is not a list view; the QuickPick is where the full set lives. */
const TOOLTIP_LIMIT = 10;

/**
 * Render the set into the strings both surfaces show, or `null` when the set is
 * empty. Null means SHOW NOTHING: a permanent "all good" indicator is noise —
 * the same rule `buildDepsIndicator` follows.
 */
export function attentionSummary(items: readonly AttentionItem[]): AttentionSummary | null {
  const count = items.length;
  if (count === 0) return null;

  const lines = items.slice(0, TOOLTIP_LIMIT).map((i) => `${i.key} · ${i.reason}`);
  const dropped = count - lines.length;
  if (dropped > 0) lines.push(`…and ${dropped} more`);

  return {
    count,
    text: `$(bell) ${count} ${count === 1 ? 'needs' : 'need'} you`,
    tooltip: lines.join('\n'),
    warning: items.some((i) => i.kind === 'failed'),
    badgeTooltip: `${count} ${count === 1 ? 'ticket needs' : 'tickets need'} your input`,
  };
}

/**
 * The two surfaces the attention set paints, behind an interface so this module
 * stays free of `vscode` and unit-testable with a fake — the same shape
 * `StatusBarManager` uses.
 */
export interface AttentionHost {
  setStatus(text: string, tooltip: string, warning: boolean): void;
  hideStatus(): void;
  setBadge(value: number, tooltip: string): void;
  clearBadge(): void;
}

/**
 * Paints the activity-bar badge and the status item from ONE summary, so the
 * number on the logo and the words in the bar can never disagree.
 */
export class AttentionManager {
  constructor(private readonly host: AttentionHost) {}

  render(items: readonly AttentionItem[]): void {
    const summary = attentionSummary(items);
    if (!summary) {
      this.host.hideStatus();
      this.host.clearBadge();
      return;
    }
    this.host.setStatus(summary.text, summary.tooltip, summary.warning);
    this.host.setBadge(summary.count, summary.badgeTooltip);
  }
}
