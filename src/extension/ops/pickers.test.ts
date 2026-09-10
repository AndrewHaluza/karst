import { describe, it, expect } from 'vitest';
import { attentionPicks, facetPicks, resolveFacetPicks } from './pickers.js';
import type { AttentionItem } from '../../ui/attention.js';
import type { Facet, FacetKey } from '../../ui/sidebar/facets.js';

describe('attentionPicks', () => {
  it('maps failed items to warning icon', () => {
    const items: AttentionItem[] = [{ kind: 'failed', key: 'T-1', reason: 'build failed', title: 'Fix build', ticketId: 1, stage: 'impl' }];
    const picks = attentionPicks(items);
    expect(picks[0]).toEqual({
      label: '$(warning) T-1 \u00b7 build failed',
      description: 'Fix build',
      ticketId: 1,
    });
  });

  it('maps non-failed items to bell icon', () => {
    const items: AttentionItem[] = [{ kind: 'input', key: 'T-2', reason: 'awaiting review', title: 'Review PR', ticketId: 2, stage: 'uat' }];
    const picks = attentionPicks(items);
    expect(picks[0]!.label).toContain('$(bell)');
  });

  it('returns empty array for empty input', () => {
    expect(attentionPicks([])).toEqual([]);
  });
});

describe('facetPicks', () => {
  it('maps facets with counts and active state', () => {
    const facets: Facet[] = [{ key: 'running' as FacetKey, label: 'Running' }, { key: 'done' as FacetKey, label: 'Done' }];
    const counts: Record<string, number> = { running: 3, done: 5 };
    const active = new Set(['running']);
    const picks = facetPicks(counts, facets, active);
    expect(picks).toEqual([
      { label: 'Running', description: '3', facet: 'running', picked: true },
      { label: 'Done', description: '5', facet: 'done', picked: false },
    ]);
  });
});

describe('resolveFacetPicks', () => {
  it('returns null for undefined (dismissed)', () => {
    expect(resolveFacetPicks(undefined)).toBeNull();
  });

  it('returns empty array for empty array (cleared → All)', () => {
    expect(resolveFacetPicks([])).toEqual([]);
  });

  it('returns mapped facet keys', () => {
    expect(resolveFacetPicks([{ facet: 'running' as FacetKey }, { facet: 'done' as FacetKey }])).toEqual(['running', 'done']);
  });
});
