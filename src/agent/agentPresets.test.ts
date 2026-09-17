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
});

describe('resolveAgentDefaults', () => {
  it('a preset overrides the legacy manifest defaults', () => {
    expect(resolveAgentDefaults(m(), null)).toEqual({
      provider: 'opencode',
      model: 'opencode-go/deepseek-v4-flash',
      effort: 'low',
    });
  });
  it('no presets defined falls back to the legacy fields', () => {
    expect(
      resolveAgentDefaults(m({ agentPresets: undefined, defaultAgentPreset: undefined }), null),
    ).toEqual({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'low' });
  });
  it('a dangling ticket preset falls back to the legacy fields', () => {
    expect(resolveAgentDefaults(m(), 'nope')).toEqual({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'low',
    });
  });
  it('provider always resolves', () => {
    expect(
      resolveAgentDefaults(m({ agentPresets: undefined, defaultAgentPreset: undefined, agentProvider: undefined }), null)
        .provider,
    ).toBe('claude');
  });
});
