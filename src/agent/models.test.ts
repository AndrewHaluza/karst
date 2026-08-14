import { describe, it, expect } from 'vitest';
import {
  KNOWN_MODELS,
  isModelCompatibleWithProvider,
  modelsForProvider,
  resolveEffortForProvider,
  resolveModel,
  resolveModelForProvider,
} from './models.js';
import type { ModelCatalog } from './modelCatalog.js';

const LIVE_MODELS: ModelCatalog = {
  claude: [{ id: 'claude-live', label: 'Claude Live', providers: ['claude'] }],
  codex: [{ id: 'codex-live', label: 'Codex Live', providers: ['codex'] }],
  antigravity: [],
  opencode: [],
};

describe('KNOWN_MODELS', () => {
  it('offers the curated launch models with stable ids', () => {
    const ids = KNOWN_MODELS.map((m) => m.id);
    expect(ids).toEqual([
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'claude-fable-5',
      'gpt-5.6-sol',
      'gemini-3.6-flash-high',
      'gemini-3.6-flash-medium',
      'gemini-3.6-flash-low',
      'gemini-3.5-flash-high',
      'gemini-3.5-flash-medium',
      'gemini-3.5-flash-low',
      'gemini-3.1-pro-high',
      'gemini-3.1-pro-low',
      'claude-sonnet-4-6',
      'claude-opus-4-6-thinking',
      'gpt-oss-120b-medium',
    ]);
  });

  it('gives every model a human label', () => {
    for (const m of KNOWN_MODELS) {
      expect(m.label.length).toBeGreaterThan(0);
    }
  });

  it('filters launch models by agent provider', () => {
    expect(modelsForProvider('claude').map((m) => m.id)).toEqual([
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'claude-fable-5',
    ]);
    expect(modelsForProvider('antigravity').map((m) => m.id)).toContain(
      'gemini-3.6-flash-high',
    );
    expect(modelsForProvider('antigravity').map((m) => m.id)).not.toContain('claude-opus-4-8');
  });

  it('lists the current Claude lineup without dropping previously offered ids', () => {
    const claude = modelsForProvider('claude');
    const ids = claude.map((m) => m.id);
    // Current lineup (newest first) — a stale list is the bug this guards.
    expect(ids).toContain('claude-opus-5');
    expect(ids).toContain('claude-sonnet-5');
    expect(ids).toContain('claude-fable-5');
    // Previously offered ids keep resolving so stored selections stay valid.
    expect(ids).toContain('claude-opus-4-8');
    expect(ids).toContain('claude-haiku-4-5');
    for (const id of ids) {
      expect(isModelCompatibleWithProvider('claude', id)).toBe(true);
    }
  });

  it('offers curated Codex models', () => {
    expect(modelsForProvider('codex').map((m) => m.id)).toEqual(['gpt-5.6-sol']);
  });

  it.each(['claude', 'codex', 'antigravity'] as const)(
    'keeps a usable bundled fallback for %s',
    (provider) => {
      expect(modelsForProvider(provider)).not.toHaveLength(0);
    },
  );

  it('uses a supplied catalog for the selected provider', () => {
    expect(modelsForProvider('codex', {
      claude: [],
      codex: [{ id: 'team-codex-model', label: 'Team Codex', providers: ['codex'] }],
      antigravity: [],
      opencode: [],
    })).toEqual([{ id: 'team-codex-model', label: 'Team Codex', providers: ['codex'] }]);
  });

  it('offers no speculative curated opencode models', () => {
    expect(modelsForProvider('opencode')).toEqual([]);
  });

  it('treats only known models from another provider as incompatible', () => {
    expect(isModelCompatibleWithProvider('codex', 'claude-sonnet-5')).toBe(false);
    expect(isModelCompatibleWithProvider('codex', 'team-codex-model')).toBe(true);
  });

  it('treats a dynamically discovered cross-provider model as incompatible', () => {
    expect(isModelCompatibleWithProvider('claude', 'codex-live', LIVE_MODELS)).toBe(false);
  });

  it('retains bundled provider knowledge when a model is absent from the live catalog', () => {
    expect(isModelCompatibleWithProvider('codex', 'gpt-5.6-sol', LIVE_MODELS)).toBe(true);
    expect(isModelCompatibleWithProvider('claude', 'gpt-5.6-sol', LIVE_MODELS)).toBe(false);
  });
});

describe('resolveModel', () => {
  it('prefers the ticket model over the default', () => {
    expect(resolveModel('claude-opus-4-8', 'claude-sonnet-5')).toBe('claude-opus-4-8');
  });

  it('falls back to the default when the ticket has no model', () => {
    expect(resolveModel(null, 'claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('returns undefined (CLI default) when neither is set', () => {
    expect(resolveModel(null, undefined)).toBeUndefined();
  });

  it('treats a blank ticket model as "inherit"', () => {
    expect(resolveModel('  ', 'claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('treats a blank default as unset', () => {
    expect(resolveModel(null, '   ')).toBeUndefined();
  });
});

describe('resolveModelForProvider', () => {
  it('launches a saved model supported by the selected provider', () => {
    expect(
      resolveModelForProvider('codex', 'gpt-5.6-sol', undefined),
    ).toBe('gpt-5.6-sol');
  });

  it('preserves an explicit custom Codex model id', () => {
    expect(
      resolveModelForProvider('codex', 'team-codex-model', undefined),
    ).toBe('team-codex-model');
  });

  it('drops a known model from another provider when Codex is selected', () => {
    expect(
      resolveModelForProvider('codex', 'claude-sonnet-5', undefined),
    ).toBeUndefined();
  });

  it('skips a ticket model known to belong to another provider', () => {
    expect(
      resolveModelForProvider('antigravity', 'claude-opus-4-8', 'gemini-3.6-flash-high'),
    ).toBe('gemini-3.6-flash-high');
  });

  it('preserves unknown custom model ids', () => {
    expect(resolveModelForProvider('antigravity', 'custom-preview-model', undefined)).toBe(
      'custom-preview-model',
    );
  });

  it('preserves an explicit custom opencode model id (provider/model)', () => {
    expect(
      resolveModelForProvider('opencode', 'openrouter/~openai/gpt-mini-latest', undefined),
    ).toBe('openrouter/~openai/gpt-mini-latest');
  });

  it('drops a known model from another provider when opencode is selected', () => {
    expect(
      resolveModelForProvider('opencode', 'claude-sonnet-5', undefined),
    ).toBeUndefined();
  });

  it('drops a dynamically known cross-provider ticket model at launch', () => {
    expect(
      resolveModelForProvider('claude', 'codex-live', undefined, LIVE_MODELS),
    ).toBeUndefined();
  });

  it('launches a bundled-known model that is currently absent from discovery', () => {
    expect(
      resolveModelForProvider('codex', 'gpt-5.6-sol', undefined, LIVE_MODELS),
    ).toBe('gpt-5.6-sol');
  });
});

describe('resolveEffortForProvider', () => {
  const catalog = {
    claude: [
      { id: 'claude-opus-5', label: 'Opus 5', providers: ['claude'], efforts: ['low', 'medium', 'high', 'max'] },
      { id: 'claude-sonnet-5', label: 'Sonnet 5', providers: ['claude'], efforts: ['low', 'medium', 'high'] },
    ],
    codex: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', providers: ['codex'], efforts: ['low', 'high'] }],
    antigravity: [],
    opencode: [],
  } as unknown as import('./modelCatalog.js').ModelCatalog;

  it('ticket effort wins over the manifest default', () => {
    expect(resolveEffortForProvider('claude', 'high', 'low', 'claude-opus-5', catalog)).toBe('high');
  });

  it('falls back to the manifest default when the ticket has none', () => {
    expect(resolveEffortForProvider('claude', null, 'max', 'claude-opus-5', catalog)).toBe('max');
  });

  it('returns undefined when nothing is configured', () => {
    expect(resolveEffortForProvider('claude', null, null, 'claude-opus-5', catalog)).toBeUndefined();
  });

  it('drops a candidate the resolved model does not advertise (catalog moved)', () => {
    expect(resolveEffortForProvider('claude', 'ultracode', null, 'claude-opus-5', catalog)).toBeUndefined();
  });

  it('returns undefined when no model resolved (nothing to cross-check)', () => {
    expect(resolveEffortForProvider('claude', 'high', null, undefined, catalog)).toBeUndefined();
  });

  it('normalizes a blank effort to inherit', () => {
    expect(resolveEffortForProvider('claude', '  ', 'max', 'claude-opus-5', catalog)).toBe('max');
  });
});
