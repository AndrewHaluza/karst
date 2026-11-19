import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, restoreView } from './viewState.js';
import { activePreset, presetToggles, PRESETS } from './presets.js';

describe('restoreView', () => {
  it('defaults when nothing was persisted', () => {
    expect(restoreView(undefined)).toEqual(DEFAULT_VIEW);
    expect(restoreView({})).toEqual(DEFAULT_VIEW);
  });
  it('restores saved flags and ignores non-boolean junk', () => {
    expect(restoreView({ collapsed: { planning: true, tickets: false }, showArchivedPlans: true })).toEqual({ ...DEFAULT_VIEW, collapsed: { planning: true, queue: true, tickets: false, activity: true }, showArchivedPlans: true });
    expect(restoreView({ collapsed: { queue: false } }).collapsed.queue).toBe(false);
    expect(restoreView({ collapsed: { planning: 'yes', tickets: true }, showArchivedPlans: 1 })).toEqual({ ...DEFAULT_VIEW, collapsed: { planning: false, queue: true, tickets: true, activity: true }, showArchivedPlans: false });
  });
});

describe('restoreView activity pane', () => {
  it('restores a snapshot saved before the Activity pane with the pane collapsed', () => {
    const old = { collapsed: { planning: false, queue: false, tickets: false }, showArchivedPlans: false };
    expect(restoreView(old).collapsed).toEqual({ planning: false, queue: false, tickets: false, activity: true });
  });
  it('restores an expanded Activity pane', () => {
    expect(restoreView({ collapsed: { activity: false } }).collapsed.activity).toBe(false);
    expect(restoreView({ collapsed: { activity: 'x' } }).collapsed.activity).toBe(true);
  });
});

describe('restoreView queue filters', () => {
  it('restores saved queue filters and defaults the rest', () => {
    expect(restoreView({ queueFilters: { levels: ['urgent'], chain: 'D5' } }).queueFilters).toEqual({ kinds: [], sessions: [], levels: ['urgent'], blocked: [], chain: 'D5' });
    expect(restoreView({ queueFilters: 7 }).queueFilters).toEqual(DEFAULT_VIEW.queueFilters);
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
