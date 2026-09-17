import { describe, it, expect } from 'vitest';
import {
  effectiveAgentPresetName,
  resolveAgentPreset,
  resolveAgentDefaults,
} from './agentPresets.js';
import { manifest, repo } from '../manifest/fixtures.js';
import type { Manifest } from '../manifest/types.js';

function m(over: Partial<Manifest> = {}): Manifest {
  return manifest({ extention: repo() }, {
    agentPresets: {
      fast: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
      deep: { provider: 'claude', model: 'claude-opus-5', effort: 'high' },
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
    expect(resolveAgentPreset(m(), 'deep')).toEqual({
      provider: 'claude',
      model: 'claude-opus-5',
      effort: 'high',
    });
  });
  it('degrades a dangling name to undefined', () => {
    expect(resolveAgentPreset(m(), 'nope')).toBeUndefined();
  });
  it('does not resolve an inherited Object member', () => {
    expect(resolveAgentPreset(m(), 'toString')).toBeUndefined();
    expect(resolveAgentPreset(m(), '__proto__')).toBeUndefined();
  });
});

describe('resolveAgentDefaults', () => {
  it('a preset overrides the legacy manifest defaults', () => {
    expect(resolveAgentDefaults(m(), {})).toEqual({
      provider: 'opencode',
      model: 'opencode-go/deepseek-v4-flash',
      effort: 'low',
    });
  });
  it('no presets defined falls back to the legacy fields', () => {
    expect(
      resolveAgentDefaults(m({ agentPresets: undefined, defaultAgentPreset: undefined }), {}),
    ).toEqual({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'low' });
  });
  it('a dangling ticket preset falls back to the legacy fields', () => {
    expect(resolveAgentDefaults(m(), { ticketPreset: 'nope' })).toEqual({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'low',
    });
  });
  it('provider always resolves', () => {
    expect(
      resolveAgentDefaults(m({ agentPresets: undefined, defaultAgentPreset: undefined, agentProvider: undefined }), {})
        .provider,
    ).toBe('claude');
  });

  // A preset is a (core, model) PAIR: a catalog-unknown preset model is accepted
  // by the compatibility guard for ANY provider, so it must not travel onto a
  // core the operator explicitly chose instead.
  it('drops the preset model/effort when the explicit core differs', () => {
    expect(
      resolveAgentDefaults(m(), { ticketPreset: 'deep', explicitProvider: 'codex' }),
    ).toEqual({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'low' });
  });

  it('keeps the preset model/effort when the explicit core matches it', () => {
    expect(
      resolveAgentDefaults(m(), { ticketPreset: 'deep', explicitProvider: 'claude' }),
    ).toEqual({ provider: 'claude', model: 'claude-opus-5', effort: 'high' });
  });
});
