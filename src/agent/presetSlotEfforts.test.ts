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
  it('does not refuse an uncatalogued model that carries an effort', () => {
    expect(() => validatePresetSlotEfforts(withSlot({ provider: 'claude', model: 'claude-future-9', effort: 'high' }), catalog)).not.toThrow();
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
  it('skips a slot whose provider and model the Save did not change', () => {
    const m = withSlot({ provider: 'claude', model: 'claude-future-9' });
    expect(presetSlotCatalogWarnings(m, catalog, m)).toEqual([]);
    const changed = withSlot({ provider: 'claude', model: 'claude-future-8' });
    expect(presetSlotCatalogWarnings(m, catalog, changed)).toHaveLength(1);
  });
  it('groups the slots of one preset into one warning with the role count and provider label', () => {
    const slot = { provider: 'claude', model: 'opus-5-5' };
    const m = { agentPresets: { opus: { slots: { a: slot, b: slot, c: slot } } } } as unknown as Manifest;
    const w = presetSlotCatalogWarnings(m, catalog);
    expect(w).toEqual([
      'Preset "opus": the Claude Code catalog has no model "opus-5-5" (3 roles). Karst skips these roles at launch. Select a model on the Agents page.',
    ]);
  });
});
