import { describe, it, expect } from 'vitest';
import {
  validateAgentPresets,
  validateDefaultAgentPreset,
  assertAgentPresetReferences,
} from './agentPresets.js';
import { ManifestError } from '../error.js';

describe('validateAgentPresets', () => {
  it('returns undefined when absent', () => {
    expect(validateAgentPresets(undefined)).toBeUndefined();
  });

  it('parses a valid map', () => {
    expect(
      validateAgentPresets({
        fast: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
        deep: { provider: 'claude', model: 'claude-opus-5', effort: 'high' },
      }),
    ).toEqual({
      fast: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
      deep: { provider: 'claude', model: 'claude-opus-5', effort: 'high' },
    });
  });

  it('refuses a non-mapping', () => {
    expect(() => validateAgentPresets([])).toThrow(ManifestError);
  });

  it('refuses an unknown provider', () => {
    expect(() => validateAgentPresets({ fast: { provider: 'gpt', model: 'x' } })).toThrow(
      /agentPresets\.fast\.provider must be one of/,
    );
  });

  it('refuses a missing model', () => {
    expect(() => validateAgentPresets({ fast: { provider: 'claude' } })).toThrow(
      /agentPresets\.fast\.model must be a non-empty string/,
    );
  });

  it('refuses a malformed model id', () => {
    expect(() => validateAgentPresets({ fast: { provider: 'claude', model: 'has space' } })).toThrow(
      /agentPresets\.fast\.model is not a valid model id/,
    );
  });

  it('refuses an unknown key', () => {
    expect(() =>
      validateAgentPresets({ fast: { provider: 'claude', model: 'm', role: 'research' } }),
    ).toThrow(/agentPresets\.fast has unknown key "role"/);
  });

  it('caps the number of presets', () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 51; i++) many[`p${i}`] = { provider: 'claude', model: 'm' };
    expect(() => validateAgentPresets(many)).toThrow(/at most 50/);
  });
});

describe('validateDefaultAgentPreset', () => {
  it('blank normalizes to undefined', () => {
    expect(validateDefaultAgentPreset('  ')).toBeUndefined();
  });
  it('refuses a non-string', () => {
    expect(() => validateDefaultAgentPreset(1)).toThrow(/defaultAgentPreset must be a string/);
  });
  it('keeps a name verbatim', () => {
    expect(validateDefaultAgentPreset('fast')).toBe('fast');
  });
});

describe('assertAgentPresetReferences', () => {
  const presets = { fast: { provider: 'opencode' as const, model: 'm' } };

  it('accepts an unset default and no process preset', () => {
    expect(() => assertAgentPresetReferences(presets, undefined, undefined)).not.toThrow();
  });

  it('accepts a default that names a preset', () => {
    expect(() => assertAgentPresetReferences(presets, 'fast', undefined)).not.toThrow();
  });

  it('refuses a default that names nothing', () => {
    expect(() => assertAgentPresetReferences(presets, 'nope', undefined)).toThrow(
      /defaultAgentPreset "nope" names no agent preset/,
    );
  });

  it('accepts a process preset that names a preset', () => {
    expect(() =>
      assertAgentPresetReferences(presets, undefined, { review: { preset: 'fast' } }),
    ).not.toThrow();
  });

  it('refuses a process preset that names nothing', () => {
    expect(() =>
      assertAgentPresetReferences(presets, undefined, { review: { preset: 'nope' } }),
    ).toThrow(/processes\.review\.preset "nope" names no agent preset/);
  });

  it('refuses any reference when no presets are defined', () => {
    expect(() => assertAgentPresetReferences(undefined, 'fast', undefined)).toThrow(
      /defaultAgentPreset "fast" names no agent preset/,
    );
  });

  // `name in defined` walks the prototype chain, so an inherited Object member
  // must never satisfy reference integrity.
  it('refuses a default naming an inherited Object member', () => {
    expect(() => assertAgentPresetReferences(undefined, 'toString', undefined)).toThrow(
      /defaultAgentPreset "toString" names no agent preset/,
    );
  });

  it('refuses a process preset naming an inherited Object member', () => {
    expect(() =>
      assertAgentPresetReferences(undefined, undefined, { review: { preset: 'constructor' } }),
    ).toThrow(/processes\.review\.preset "constructor" names no agent preset/);
  });
});
