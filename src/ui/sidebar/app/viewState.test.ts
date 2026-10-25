import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, restoreView } from './viewState.js';
import { activePreset, presetToggles, PRESETS } from './presets.js';

describe('restoreView', () => {
  it('defaults when nothing was persisted', () => {
    expect(restoreView(undefined)).toEqual(DEFAULT_VIEW);
    expect(restoreView({})).toEqual(DEFAULT_VIEW);
  });
  it('restores saved flags and ignores non-boolean junk', () => {
    expect(restoreView({ collapsed: { planning: true, tickets: false }, showArchivedPlans: true })).toEqual({ collapsed: { planning: true, tickets: false }, showArchivedPlans: true });
    expect(restoreView({ collapsed: { planning: 'yes', tickets: true }, showArchivedPlans: 1 })).toEqual({ collapsed: { planning: false, tickets: true }, showArchivedPlans: false });
  });
});

describe('presets', () => {
  it('maps each preset to its own selection and back', () => {
    for (const p of PRESETS) expect(activePreset(p.facets)?.id).toBe(p.id);
  });
  it('names no preset for a selection outside the five', () => {
    expect(activePreset(['input'])).toBeNull();
    expect(activePreset(['running', 'done'])).toBeNull();
  });
  it('is order-insensitive', () => {
    expect(activePreset(['failed', 'input'])?.id).toBe('attention');
  });
  it('resets then toggles on, except All which only resets', () => {
    const toggles = (id: string) => presetToggles(PRESETS.find((p) => p.id === id)!);
    expect(toggles('all')).toEqual(['all']);
    expect(toggles('attention')).toEqual(['all', 'input', 'failed']);
    expect(toggles('archived')).toEqual(['all', 'archived']);
  });
});
