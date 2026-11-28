/**
 * The capability visibility rules, moved out of `HeaderMeta` (T1413): which roles the Models surface names and how
 * roles that share a provider/model collapse into one group. The row-2 chips are gone; these rules are unchanged.
 */
import { describe, expect, it } from 'vitest';
import type { MetaSlice } from './headerSlices.js';
import { capabilityGroups, modelLabel } from './capabilityGroups.js';

type Cap = MetaSlice['capabilities']['implementation'];
const cap = (provider: string, model: string | null): Cap => ({ provider, model });

const meta = (over: Partial<MetaSlice> = {}): MetaSlice => ({
  subtaskParent: null,
  parent: null,
  blockers: [],
  unblocks: [],
  capabilities: {
    implementation: cap('claude', 'm1'),
    uatTester: null,
    review: null,
    graphExpert: null,
    graphWorker: null,
    graphFast: null,
  },
  modelsByCore: {},
  ...over,
});

describe('capabilityGroups — which roles show', () => {
  it('returns no group when no role names an identity', () => {
    expect(capabilityGroups(meta())).toEqual([]);
  });

  it('omits UAT and Review when they use the implementation model', () => {
    const groups = capabilityGroups(
      meta({
        capabilities: {
          ...meta().capabilities,
          uatTester: cap('claude', 'm1'),
          review: cap('claude', 'm1'),
        },
      }),
    );
    expect(groups).toEqual([]);
  });

  it('lists a differing UAT or Review identity, grouped by provider/model', () => {
    const groups = capabilityGroups(
      meta({
        capabilities: {
          ...meta().capabilities,
          uatTester: cap('claude', 'm2'),
          review: cap('claude', 'm2'),
        },
      }),
    );
    expect(groups).toEqual([{ full: 'claude/m2', provider: 'claude', model: 'm2', roles: ['UAT', 'Review'] }]);
  });

  it('always lists the graph roles, even when they match implementation', () => {
    const groups = capabilityGroups(
      meta({
        capabilities: {
          ...meta().capabilities,
          graphExpert: cap('claude', 'm2'),
          graphWorker: cap('claude', 'm1'),
          graphFast: cap('claude', 'm1'),
        },
      }),
    );
    expect(groups.map((g) => g.roles)).toEqual([['Expert'], ['Worker', 'Fast']]);
  });

  it('skips an identity that names no provider or model', () => {
    const groups = capabilityGroups(
      meta({
        capabilities: {
          ...meta().capabilities,
          implementation: null,
          review: { provider: '', model: 'm2' },
          graphExpert: { provider: 'claude', model: null },
        },
      }),
    );
    expect(groups).toEqual([]);
  });
});

describe('modelLabel — the catalog label', () => {
  it('reads the label from the per-core catalog and falls back to the raw id', () => {
    const m = meta({ modelsByCore: { claude: [{ id: 'm2', label: 'Model Two' }] } });
    expect(modelLabel(m, 'claude', 'm2')).toBe('Model Two');
    expect(modelLabel(m, 'claude', 'm9')).toBe('m9');
    expect(modelLabel(m, 'codex', 'gpt-x')).toBe('gpt-x');
  });
});
