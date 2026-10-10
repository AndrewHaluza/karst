import { describe, it, expect } from 'vitest';
import type { Manifest } from '../../../../manifest/types.js';
import {
  clearRole, copyRoleFrom, differingRoles, effectiveRole, pinOf, pinRole, rolesUsingProfile, setDefaultRow, setRoleEnabled, setRoleProfile, unpinRole, writeRole,
} from './rolesModel.js';

const base = (over: Partial<Manifest> = {}): Manifest =>
  ({
    agentProvider: 'opencode',
    defaultModel: 'opencode-go/deepseek-v4-flash',
    agentPresets: {
      A: { slots: { planning: { provider: 'claude', model: 'claude-opus-5' }, review: { provider: 'claude', model: 'claude-opus-5', effort: 'low' } } },
      B: { slots: { planning: { provider: 'antigravity', model: 'gemini-3.8-flash-medium' } } },
    },
    activeAgentPreset: 'A',
    ...over,
  }) as unknown as Manifest;

const pinPlanning = (m: Manifest): Manifest =>
  ({ ...m, processes: { planning: { provider: 'antigravity', model: 'gemini-3.8-flash-medium', pinned: true, enabled: true } } }) as Manifest;

describe('effectiveRole', () => {
  it('a preset slot wins over the Default row, source "preset"', () => {
    expect(effectiveRole(base(), 'A', 'planning')).toEqual({ core: 'claude', model: 'claude-opus-5', effort: '', source: 'preset' });
  });
  it('falls to the Default row, source "default"', () => {
    expect(effectiveRole(base(), 'A', 'uatFix')).toEqual({ core: 'opencode', model: 'opencode-go/deepseek-v4-flash', effort: '', source: 'default' });
  });
  it('a pin beats the preset in every preset, source "pin"', () => {
    const m = pinPlanning(base());
    expect(effectiveRole(m, 'A', 'planning')).toMatchObject({ core: 'antigravity', source: 'pin' });
    expect(effectiveRole(m, 'B', 'planning')).toMatchObject({ core: 'antigravity', source: 'pin' });
  });
  it('an unpinned row is never a pin', () => {
    const m = { ...base(), processes: { planning: { provider: 'codex', model: 'x' } } } as unknown as Manifest;
    expect(pinOf(m, 'planning')).toBeUndefined();
    expect(effectiveRole(m, 'A', 'planning').source).toBe('preset');
  });
  it('a legacy flat preset is one slot on every role', () => {
    const m = base({ agentPresets: { flat: { provider: 'codex', model: 'gpt-5.6-sol' } } as never });
    expect(effectiveRole(m, 'flat', 'graphFast')).toMatchObject({ core: 'codex', source: 'preset' });
  });
});

describe('writeRole lands in the layer that wins', () => {
  it('unpinned → the selected preset, not other presets or the pin layer', () => {
    const next = writeRole(base(), 'A', 'planning', { core: 'codex', model: 'gpt-5.6-sol', effort: '' });
    expect(next.agentPresets!.A!.slots.planning).toEqual({ provider: 'codex', model: 'gpt-5.6-sol' });
    expect(next.agentPresets!.B).toEqual(base().agentPresets!.B);
    expect(next.processes).toBeUndefined();
  });
  it('pinned → the pin, leaving the preset slot alone', () => {
    const m = pinPlanning(base());
    const next = writeRole(m, 'A', 'planning', { core: 'codex', model: 'gpt-5.6-sol', effort: '' });
    expect(next.processes!.planning).toMatchObject({ provider: 'codex', model: 'gpt-5.6-sol', pinned: true });
    expect(next.agentPresets).toEqual(m.agentPresets);
  });
  it('a half-made unpinned value (no model) changes nothing', () => {
    const m = base();
    expect(writeRole(m, 'A', 'planning', { core: 'codex', model: '', effort: '' })).toBe(m);
  });
  it('does not mutate its input', () => {
    const m = base();
    const copy = structuredClone(m);
    writeRole(m, 'A', 'review', { core: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
    expect(m).toEqual(copy);
  });
  it('expands a legacy flat preset on write, only the role changed', () => {
    const m = base({ agentPresets: { flat: { provider: 'codex', model: 'gpt-5.6-sol' } } as never });
    const next = writeRole(m, 'flat', 'review', { core: 'claude', model: 'claude-opus-5', effort: '' });
    const slots = next.agentPresets!.flat!.slots;
    expect(slots.review).toEqual({ provider: 'claude', model: 'claude-opus-5' });
    expect(slots.planning).toEqual({ provider: 'codex', model: 'gpt-5.6-sol' });
  });
});

describe('pin / unpin / clear', () => {
  it('pinRole pins the current effective value, keeping the process row fields', () => {
    const m = { ...base(), processes: { planning: { agent: 'p', enabled: true } } } as unknown as Manifest;
    const next = pinRole(m, 'A', 'planning');
    expect(next.processes!.planning).toMatchObject({ agent: 'p', provider: 'claude', model: 'claude-opus-5', pinned: true });
  });
  it('implementation and graph roles cannot be pinned', () => {
    const m = base();
    expect(pinRole(m, 'A', 'implementation')).toBe(m);
    expect(pinRole(m, 'A', 'graphExpert')).toBe(m);
  });
  it('unpinRole drops the pin fields and an emptied row', () => {
    expect(unpinRole(pinPlanning(base()), 'planning').processes).toEqual({ planning: { enabled: true } });
    const bare = { ...base(), processes: { planning: { provider: 'codex', model: 'm', pinned: true } } } as unknown as Manifest;
    expect(unpinRole(bare, 'planning').processes).toBeUndefined();
  });
  it('clearRole removes the pin when pinned, else the preset slot (falls to Default)', () => {
    expect(pinOf(clearRole(pinPlanning(base()), 'A', 'planning'), 'planning')).toBeUndefined();
    const cleared = clearRole(base(), 'A', 'planning');
    expect(cleared.agentPresets!.A!.slots.planning).toBeUndefined();
    expect(effectiveRole(cleared, 'A', 'planning').source).toBe('default');
  });
});

describe('compare', () => {
  it('lists roles whose EFFECTIVE values differ; a pin is the same in both', () => {
    const caps = ['planning', 'review', 'uatFix'];
    expect(differingRoles(base(), 'A', 'B', caps)).toEqual(['planning', 'review']);
    expect(differingRoles(pinPlanning(base()), 'A', 'B', caps)).toEqual(['review']);
  });
  it('copyRoleFrom writes B\'s effective value into A only', () => {
    const next = copyRoleFrom(base(), 'A', 'B', 'planning');
    expect(next.agentPresets!.A!.slots.planning).toEqual({ provider: 'antigravity', model: 'gemini-3.8-flash-medium' });
    expect(next.agentPresets!.B).toEqual(base().agentPresets!.B);
  });
  it('copying an inherited B role clears A\'s slot when B has no complete default', () => {
    const m = base({ agentProvider: undefined, defaultModel: undefined });
    const next = copyRoleFrom(m, 'A', 'B', 'review');
    expect(next.agentPresets!.A!.slots.review).toBeUndefined();
  });
});

describe('profile, enabled and default row', () => {
  it('assigns and clears a profile on a process role, keeping other fields', () => {
    const m = pinPlanning(base());
    const assigned = setRoleProfile(m, 'planning', 'planner-strict');
    expect(assigned.processes!.planning).toMatchObject({ agent: 'planner-strict', pinned: true });
    expect(setRoleProfile(assigned, 'planning', '').processes!.planning).not.toHaveProperty('agent');
    expect(setRoleProfile(base(), 'implementation', 'x')).toEqual(base());
  });
  it('enabled:false is written only when off', () => {
    const off = setRoleEnabled(base(), 'review', false);
    expect(off.processes!.review).toEqual({ enabled: false });
    expect(setRoleEnabled(off, 'review', true).processes).toBeUndefined();
  });
  it('lists the roles using a profile in capability order', () => {
    const m = { ...base(), processes: { review: { agent: 'r' }, uatTester: { agent: 'r' }, planning: { agent: 'p' } } } as unknown as Manifest;
    expect(rolesUsingProfile(m, 'r', ['uatTester', 'review', 'planning'])).toEqual(['uatTester', 'review']);
    expect(rolesUsingProfile(m, 'none', ['review'])).toEqual([]);
  });
  it('setDefaultRow clears blank fields', () => {
    const next = setDefaultRow(base(), { core: 'codex', model: '', effort: '' });
    expect(next).toMatchObject({ agentProvider: 'codex' });
    expect(next.defaultModel).toBeUndefined();
  });
});
