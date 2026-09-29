import { describe, it, expect } from 'vitest';
import {
  validateAgentPresets,
  validateActiveAgentPreset,
  validateDefaultAgentPreset,
  assertExclusiveActivePreset,
  assertActiveAgentPresetReference,
  assertAgentPresetReferences,
  deprecatedPresetKeyWarnings,
} from './agentPresets.js';
import { ManifestError } from '../error.js';
import { fullPreset } from '../fixtures.js';

describe('validateAgentPresets', () => {
  it('returns undefined when absent', () => {
    expect(validateAgentPresets(undefined)).toBeUndefined();
  });

  it('parses a valid map', () => {
    expect(
      validateAgentPresets({
        fast: fullPreset('opencode', 'opencode-go/deepseek-v4-flash'),
        deep: fullPreset('claude', 'claude-opus-5', 'high'),
      }),
    ).toEqual({
      fast: fullPreset('opencode', 'opencode-go/deepseek-v4-flash'),
      deep: fullPreset('claude', 'claude-opus-5', 'high'),
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
  const presets = { fast: fullPreset('opencode', 'm') };

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

describe('validateAgentPresets — per-capability form', () => {
  it('keeps a sparse slots map and its label as authored', () => {
    expect(
      validateAgentPresets({
        smart: {
          label: 'Smart',
          slots: { review: { provider: 'claude', model: 'sonnet-5' } },
        },
      }),
    ).toEqual({
      smart: {
        label: 'Smart',
        slots: { review: { provider: 'claude', model: 'sonnet-5' } },
      },
    });
  });

  it('refuses a capability outside PRESET_CAPABILITIES', () => {
    expect(() =>
      validateAgentPresets({ fast: { slots: { research: { provider: 'claude', model: 'm' } } } }),
    ).toThrow(/agentPresets\.fast\.slots has unknown capability "research"/);
  });

  it('refuses a slot with an unknown provider, naming the capability', () => {
    expect(() =>
      validateAgentPresets({ fast: { slots: { graphFast: { provider: 'gpt', model: 'm' } } } }),
    ).toThrow(/agentPresets\.fast\.slots\.graphFast\.provider must be one of/);
  });

  it('refuses a preset mixing the legacy flat block with slots', () => {
    expect(() =>
      validateAgentPresets({
        fast: {
          provider: 'claude',
          model: 'm',
          slots: { review: { provider: 'claude', model: 'm' } },
        },
      }),
    ).toThrow(/declares both the legacy flat/);
  });

  it('refuses a preset that declares neither slots nor a legacy block', () => {
    expect(() => validateAgentPresets({ fast: {} })).toThrow(/must define `slots:`/);
  });
});

describe('validateActiveAgentPreset', () => {
  it('blank normalizes to undefined', () => {
    expect(validateActiveAgentPreset('  ')).toBeUndefined();
  });
  it('refuses a non-string', () => {
    expect(() => validateActiveAgentPreset(1)).toThrow(/activeAgentPreset must be a string/);
  });
  it('keeps a name verbatim', () => {
    expect(validateActiveAgentPreset('smart')).toBe('smart');
  });
});

describe('assertExclusiveActivePreset', () => {
  it('accepts either spelling alone', () => {
    expect(() => assertExclusiveActivePreset('fast', undefined)).not.toThrow();
    expect(() => assertExclusiveActivePreset(undefined, 'fast')).not.toThrow();
    expect(() => assertExclusiveActivePreset(undefined, undefined)).not.toThrow();
  });

  it('refuses both spellings at once', () => {
    expect(() => assertExclusiveActivePreset('fast', 'fast')).toThrow(
      /declares both `activeAgentPreset:` and the legacy `defaultAgentPreset:`/,
    );
  });
});

describe('assertActiveAgentPresetReference', () => {
  it('accepts a name that defines a preset', () => {
    expect(() => assertActiveAgentPresetReference({ fast: fullPreset('claude', 'm') }, 'fast'))
      .not.toThrow();
  });

  it('refuses a dangling name, naming activeAgentPreset', () => {
    expect(() => assertActiveAgentPresetReference(undefined, 'nope')).toThrow(
      /activeAgentPreset "nope" names no agent preset/,
    );
  });

  it('refuses a name that only resolves to an inherited Object member', () => {
    expect(() => assertActiveAgentPresetReference(undefined, 'toString')).toThrow(
      /activeAgentPreset "toString" names no agent preset/,
    );
  });
});

describe('deprecatedPresetKeyWarnings', () => {
  it('warns once per process key, naming the capability row to set instead', () => {
    expect(deprecatedPresetKeyWarnings({ review: { preset: 'fast' } })).toEqual([
      expect.stringMatching(/`processes\.review\.preset` is deprecated/),
    ]);
    expect(deprecatedPresetKeyWarnings({ review: { preset: 'fast' } })[0]).toMatch(
      /`review` slot under `agentPresets`/,
    );
  });

  it('aggregates across processes and stays silent without the key', () => {
    expect(
      deprecatedPresetKeyWarnings({ review: { preset: 'fast' }, uatFix: { preset: 'fast' } }),
    ).toHaveLength(2);
    expect(deprecatedPresetKeyWarnings({ review: {} })).toEqual([]);
    expect(deprecatedPresetKeyWarnings(undefined)).toEqual([]);
  });
});
