import { describe, it, expect } from 'vitest';
import {
  effectiveAgentPresetName,
  resolveAgentPreset,
  resolvePresetSlot,
  resolvePresetDefaults,
} from './agentPresets.js';
import { fullPreset, manifest, repo } from '../manifest/fixtures.js';
import type { AgentPreset, Manifest } from '../manifest/types.js';

function m(over: Partial<Manifest> = {}): Manifest {
  return manifest({ extention: repo() }, {
    agentPresets: {
      fast: fullPreset('opencode', 'opencode-go/deepseek-v4-flash'),
      deep: fullPreset('claude', 'claude-opus-5', 'high'),
    },
    defaultAgentPreset: 'fast',
    agentProvider: 'codex',
    defaultModel: 'gpt-5.6-sol',
    defaultEffort: 'low',
    ...over,
  });
}

describe('effectiveAgentPresetName', () => {
  it('prefers the role preset, then the ticket preset, then the default', () => {
    expect(effectiveAgentPresetName(m(), 'deep', 'fast')).toBe('fast');
    expect(effectiveAgentPresetName(m(), 'deep', undefined)).toBe('deep');
    expect(effectiveAgentPresetName(m(), null, null)).toBe('fast');
  });
  it('blank values are unset', () => {
    expect(effectiveAgentPresetName(m({ defaultAgentPreset: undefined }), '  ', '')).toBeUndefined();
  });
});

describe('resolveAgentPreset', () => {
  it('returns the named preset', () => {
    expect(resolveAgentPreset(m(), 'deep')).toEqual(fullPreset('claude', 'claude-opus-5', 'high'));
  });
  it('degrades a dangling name to undefined', () => {
    expect(resolveAgentPreset(m(), 'nope')).toBeUndefined();
  });
  it('does not resolve an inherited Object member', () => {
    expect(resolveAgentPreset(m(), 'toString')).toBeUndefined();
    expect(resolveAgentPreset(m(), '__proto__')).toBeUndefined();
  });
});

describe('resolvePresetSlot', () => {
  it('returns the whole slot — provider, model and effort — for the capability asked for', () => {
    expect(resolvePresetSlot(m(), 'review', 'deep')).toEqual({
      provider: 'claude',
      model: 'claude-opus-5',
      effort: 'high',
    });
    expect(resolvePresetSlot(m(), 'implementation', 'deep')).toEqual({
      provider: 'claude',
      model: 'claude-opus-5',
      effort: 'high',
    });
    // No name supplied → the active preset's slot, all three fields together.
    expect(resolvePresetSlot(m(), 'review')).toEqual({
      provider: 'opencode',
      model: 'opencode-go/deepseek-v4-flash',
    });
  });

  it('prefers the ticket preset name over the manifest active preset', () => {
    expect(resolvePresetSlot(m(), 'review', 'deep')?.provider).toBe('claude');
    expect(resolvePresetSlot(m(), 'review', 'fast')?.provider).toBe('opencode');
  });

  it('falls back to the active preset, then its deprecated alias', () => {
    expect(resolvePresetSlot(m(), 'review')?.provider).toBe('opencode');
    expect(
      resolvePresetSlot(
        m({ activeAgentPreset: 'deep', defaultAgentPreset: undefined }),
        'review',
      )?.provider,
    ).toBe('claude');
  });

  // Sparse: an absent capability is Inherit — it never falls through to a
  // guessed value, and it never borrows another capability's slot.
  it('returns undefined (Inherit) for a capability the preset does not override', () => {
    const sparse: Manifest = {
      ...m(),
      agentPresets: { onlyReview: { slots: { review: { provider: 'claude', model: 'claude-opus-5' } } } },
      activeAgentPreset: 'onlyReview',
      defaultAgentPreset: undefined,
    };
    expect(resolvePresetSlot(sparse, 'review')).toEqual({
      provider: 'claude',
      model: 'claude-opus-5',
    });
    expect(resolvePresetSlot(sparse, 'uatTester')).toBeUndefined();
    expect(resolvePresetSlot(sparse, 'implementation')).toBeUndefined();
    expect(resolvePresetSlot(sparse, 'graphFast')).toBeUndefined();
  });

  it('degrades a dangling name to Inherit', () => {
    expect(resolvePresetSlot(m(), 'review', 'nope')).toBeUndefined();
    expect(resolvePresetSlot(m({ agentPresets: undefined, defaultAgentPreset: undefined }), 'review')).toBeUndefined();
  });
});

describe('resolvePresetDefaults', () => {
  it('a preset overrides the legacy manifest defaults', () => {
    expect(resolvePresetDefaults(m(), 'implementation', {})).toEqual({
      provider: 'opencode',
      model: 'opencode-go/deepseek-v4-flash',
      effort: 'low',
    });
  });
  it('no presets defined falls back to the legacy fields', () => {
    expect(
      resolvePresetDefaults(
        m({ agentPresets: undefined, defaultAgentPreset: undefined }),
        'implementation',
        {},
      ),
    ).toEqual({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'low' });
  });
  it('a dangling ticket preset falls back to the legacy fields', () => {
    expect(resolvePresetDefaults(m(), 'implementation', { ticketPreset: 'nope' })).toEqual({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'low',
    });
  });
  it('provider always resolves', () => {
    expect(
      resolvePresetDefaults(
        m({ agentPresets: undefined, defaultAgentPreset: undefined, agentProvider: undefined }),
        'implementation',
        {},
      ).provider,
    ).toBe('claude');
  });

  // A preset slot is a (core, model, effort) TRIPLE: a catalog-unknown preset
  // model is accepted by the compatibility guard for ANY provider, so it must
  // not travel onto a core the operator explicitly chose instead.
  it('drops the preset model/effort when the explicit core differs', () => {
    expect(
      resolvePresetDefaults(m(), 'implementation', { ticketPreset: 'deep', explicitProvider: 'codex' }),
    ).toEqual({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'low' });
  });

  it('keeps the preset model/effort when the explicit core matches it', () => {
    expect(
      resolvePresetDefaults(m(), 'implementation', { ticketPreset: 'deep', explicitProvider: 'claude' }),
    ).toEqual({ provider: 'claude', model: 'claude-opus-5', effort: 'high' });
  });

  it('a role preset still beats the ticket preset (§6)', () => {
    expect(
      resolvePresetDefaults(m(), 'review', { ticketPreset: 'deep', rolePreset: 'fast' })?.provider,
    ).toBe('opencode');
  });

  // The capability decides WHICH row is read: a sparse preset that only
  // overrides `review` leaves every other row on the legacy defaults.
  it('reads only the capability asked for', () => {
    const sparse: Manifest = {
      ...m(),
      agentPresets: { onlyReview: { slots: { review: { provider: 'claude', model: 'claude-opus-5' } } } },
      activeAgentPreset: 'onlyReview',
      defaultAgentPreset: undefined,
    };
    expect(resolvePresetDefaults(sparse, 'review', {})).toEqual({
      provider: 'claude',
      model: 'claude-opus-5',
      effort: 'low',
    });
    expect(resolvePresetDefaults(sparse, 'implementation', {})).toEqual({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'low',
    });
  });
});

// The sparse fixture above is the shape §3 describes; keeping one hand-built
// AgentPreset literal here pins that `slots` is the only slot-bearing key.
describe('AgentPreset shape', () => {
  it('carries slots, never a legacy flat bundle', () => {
    const preset: AgentPreset = { label: 'Smart', slots: { graphFast: { provider: 'opencode', model: 'mimo-2.5' } } };
    expect(preset.slots.graphFast).toEqual({ provider: 'opencode', model: 'mimo-2.5' });
    expect(Object.keys(preset)).toEqual(['label', 'slots']);
  });
});
