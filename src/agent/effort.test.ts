/**
 * Pure effort resolution/validation — vscode-free and catalog-injected.
 *
 * Effort is optional and model-capability-aware (design § Execution policy
 * resolution): a project/user explicit effort the selected model does not
 * advertise is a configuration failure, never silently discarded. The check
 * needs the LIVE catalog (feed tier can augment the bundled one), so this
 * module is consumed host-side at Save; the settings surface that calls it is
 * Slice-1 Task 6.
 */

import { describe, expect, it } from 'vitest';
import { bundledModelCatalog, type ModelCatalog } from './modelCatalog.js';
import {
  EffortError,
  assertProfileEffort,
  effortCapabilities,
  effortsForModel,
} from './effort.js';

const catalog = bundledModelCatalog();

describe('effortCapabilities', () => {
  it('declares interactive and headless effort support separately per provider', () => {
    // opencode's interactive TUI (1.18.18) has no `--variant` flag (only
    // `opencode run` accepts it), so the interactive binding cannot express
    // effort; headless keeps it.
    const opencode = effortCapabilities('opencode');
    expect(opencode.interactive).toBe(false);
    expect(opencode.headless).toBe(true);
    for (const provider of ['claude', 'codex', 'antigravity'] as const) {
      const caps = effortCapabilities(provider);
      expect(caps.interactive).toBe(true);
      expect(caps.headless).toBe(true);
    }
  });

  it('declares no custom variant support on the initial bindings', () => {
    // "Custom values are retained and attempted only when that adapter
    // explicitly supports custom variants; otherwise Save is rejected."
    for (const provider of ['claude', 'codex', 'antigravity', 'opencode'] as const) {
      expect(effortCapabilities(provider).customValues).toBe(false);
    }
  });
});

describe('effortsForModel', () => {
  it('returns the advertised efforts of a cataloged model', () => {
    expect(effortsForModel('claude', 'claude-opus-5', catalog)).toContain('high');
  });

  it('returns undefined for an uncataloged model id', () => {
    expect(effortsForModel('claude', 'my-custom-model', catalog)).toBeUndefined();
  });

  it('returns undefined for a model whose entry advertises none', () => {
    const narrow: ModelCatalog = {
      claude: [{ id: 'plain', label: 'Plain', providers: ['claude'] }],
      codex: [],
      antigravity: [],
      opencode: [],
    };
    expect(effortsForModel('claude', 'plain', narrow)).toBeUndefined();
  });
});

describe('assertProfileEffort', () => {
  it('accepts an absent effort', () => {
    expect(() => assertProfileEffort('claude', 'claude-opus-5', undefined, catalog)).not.toThrow();
  });

  it('accepts an advertised effort', () => {
    expect(() => assertProfileEffort('claude', 'claude-opus-5', 'high', catalog)).not.toThrow();
    expect(() => assertProfileEffort('claude', 'claude-sonnet-5', 'low', catalog)).not.toThrow();
  });

  it('rejects any effort for a custom model id not in the catalog', () => {
    // A custom user-typed model id is not in the catalog, so it accepts no
    // effort — intended conservative behavior, not a bug.
    expect(() => assertProfileEffort('claude', 'my-custom-model', 'high', catalog))
      .toThrow(EffortError);
    expect(() => assertProfileEffort('claude', 'my-custom-model', 'high', catalog))
      .toThrow(/not in the model catalog/);
  });

  it('rejects any effort for a model whose entry advertises none', () => {
    const narrow: ModelCatalog = {
      claude: [{ id: 'plain', label: 'Plain', providers: ['claude'] }],
      codex: [],
      antigravity: [],
      opencode: [],
    };
    expect(() => assertProfileEffort('claude', 'plain', 'high', narrow))
      .toThrow(/advertises no effort/);
  });

  it('rejects an effort the model does not advertise, naming the advertised values', () => {
    expect(() => assertProfileEffort('claude', 'claude-opus-5', 'xmedium', catalog))
      .toThrow(EffortError);
    expect(() => assertProfileEffort('claude', 'claude-opus-5', 'xmedium', catalog))
      .toThrow(/low, medium, high/);
  });

  it('rejects a profile that sets both model and effort for opencode', () => {
    // For opencode, effort IS the model variant — a profile setting both is a
    // stale, semantically conflicting pair, rejected with a named error.
    expect(() => assertProfileEffort('opencode', 'some-model', 'variant-x', catalog))
      .toThrow(EffortError);
    expect(() => assertProfileEffort('opencode', 'some-model', 'variant-x', catalog))
      .toThrow(/effort IS the model variant/);
  });

  it('accepts an effort-only opencode profile (a variant choice)', () => {
    expect(() => assertProfileEffort('opencode', undefined, 'variant-x', catalog)).not.toThrow();
  });

  it('validates the packaged graph defaults against the bundled catalog', () => {
    // builtIn.ts packaged profiles: expert = Opus high, worker/fast = Sonnet low.
    for (const profile of [
      { provider: 'claude' as const, model: 'claude-opus-5', effort: 'high' },
      { provider: 'claude' as const, model: 'claude-sonnet-5', effort: 'low' },
    ]) {
      expect(() => assertProfileEffort(profile.provider, profile.model, profile.effort, catalog))
        .not.toThrow();
    }
  });

  it('validates against a feed-supplied efforts entry for a model the bundled catalog lacks', () => {
    // "A feed that supplies efforts for a model the bundled catalog lacks wins
    // per the existing precedence, and the effort validates against the feed
    // entry." (Not opencode: a model+effort pair is rejected there
    // unconditionally — effort IS the variant.)
    const feed: ModelCatalog = {
      claude: [],
      codex: [{ id: 'gpt-6-extra', label: 'GPT-6 Extra', providers: ['codex'], efforts: ['low', 'high'] }],
      antigravity: [],
      opencode: [],
    };
    expect(() => assertProfileEffort('codex', 'gpt-6-extra', 'high', feed)).not.toThrow();
    expect(() => assertProfileEffort('codex', 'gpt-6-extra', 'medium', feed)).toThrow(EffortError);
  });
});
