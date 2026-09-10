import type { AttentionItem } from '../../ui/attention.js';
import type { Facet, FacetKey } from '../../ui/sidebar/facets.js';

export interface AttentionPick {
  readonly label: string;
  readonly description: string;
  readonly ticketId: number;
}

export function attentionPicks(items: readonly AttentionItem[]): AttentionPick[] {
  return items.map((i) => ({
    label: `${i.kind === 'failed' ? '$(warning)' : '$(bell)'} ${i.key} \u00b7 ${i.reason}`,
    description: i.title,
    ticketId: i.ticketId,
  }));
}

export interface FacetPick {
  readonly label: string;
  readonly description: string;
  readonly facet: FacetKey;
  readonly picked: boolean;
}

export function facetPicks(
  counts: Record<string, number>,
  facets: readonly Facet[],
  active: Set<string>,
): FacetPick[] {
  return facets.map((f) => ({
    label: f.label,
    description: `${counts[f.key]}`,
    facet: f.key,
    picked: active.has(f.key),
  }));
}

/**
 * Interpret the result of a multi-select quick pick for facets.
 * `undefined` = dismissed (leave selection alone); an empty array = cleared → All.
 */
export function resolveFacetPicks(picks: { facet: FacetKey }[] | undefined): FacetKey[] | null {
  if (picks === undefined) return null;
  return picks.map((p) => p.facet);
}
