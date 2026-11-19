import { describe, expect, it } from 'vitest';
import type { Manifest, PresetSlot } from '../manifest/types.js';
import { EffortError } from './effort.js';
import { bundledModelCatalog } from './modelCatalog.js';
import { presetSlotCatalogWarnings, validatePresetSlotEfforts } from './presetSlotEfforts.js';

const withSlot = (slot: PresetSlot): Manifest =>
  ({ agentPresets: { p: { slots: { graphExpert: slot } } } }) as unknown as Manifest;
const catalog = bundledModelCatalog();

describe('validatePresetSlotEfforts', () => {
  it('refuses a graph slot with an effort its model lacks, naming the slot', () => {
    const m = withSlot({ provider: 'claude', model: 'claude-sonnet-5-5', effort: 'max' });
    expect(() => validatePresetSlotEfforts(m, catalog)).toThrow(EffortError);
    expect(() => validatePresetSlotEfforts(m, catalog)).toThrow(/agentPresets\.p\.slots\.graphExpert/);
  });
  it('accepts an advertised effort and a slot with no effort', () => {
    expect(() => validatePresetSlotEfforts(withSlot({ provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low' }), catalog)).not.toThrow();
    expect(() => validatePresetSlotEfforts(withSlot({ provider: 'claude', model: 'claude-sonnet-5-5' }), catalog)).not.toThrow();
    expect(() => validatePresetSlotEfforts({} as Manifest, catalog)).not.toThrow();
  });
});

describe('presetSlotCatalogWarnings', () => {
  it('warns for a model the catalog does not list, and not for a listed one', () => {
    const w = presetSlotCatalogWarnings(withSlot({ provider: 'claude', model: 'claude-future-9' }), catalog);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('claude-future-9');
    expect(presetSlotCatalogWarnings(withSlot({ provider: 'claude', model: 'claude-sonnet-5-5' }), catalog)).toEqual([]);
  });
});
