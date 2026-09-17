import { describe, it, expect } from 'vitest';
import { resolveLaunchIdentity, resolveTicketProvider } from './launchIdentity.js';
import type { ModelCatalog } from './modelCatalog.js';
import { manifest, repo } from '../manifest/fixtures.js';
import type { Manifest } from '../manifest/types.js';

/** The bundled opencode catalog is empty, so a preset's opencode model needs an explicit catalog. */
const catalog: ModelCatalog = {
  claude: [
    { id: 'claude-opus-5', label: 'Opus 5', providers: ['claude'], efforts: ['low', 'high'] },
  ],
  codex: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', providers: ['codex'] }],
  antigravity: [],
  opencode: [
    {
      id: 'opencode-go/deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      providers: ['opencode'],
      efforts: ['low', 'high'],
    },
  ],
};

function m(over: Partial<Manifest> = {}): Manifest {
  return manifest(
    { extention: repo() },
    {
      agentPresets: {
        fast: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
        deep: { provider: 'claude', model: 'claude-opus-5', effort: 'high' },
      },
      defaultAgentPreset: 'fast',
      agentProvider: 'codex',
      defaultModel: 'gpt-5.6-sol',
      defaultEffort: 'low',
      ...over,
    },
  );
}

describe('resolveLaunchIdentity', () => {
  it('uses the manifest default preset when the ticket names none', () => {
    expect(resolveLaunchIdentity(m(), {}, undefined, catalog)).toEqual({
      provider: 'opencode',
      model: 'opencode-go/deepseek-v4-flash',
      effort: 'low',
    });
  });

  it('lets the ticket preset override the default preset', () => {
    expect(resolveLaunchIdentity(m(), { agentPreset: 'deep' }, undefined, catalog)).toEqual({
      provider: 'claude',
      model: 'claude-opus-5',
      effort: 'high',
    });
  });

  it('lets explicit ticket provider/model beat the preset', () => {
    expect(
      resolveLaunchIdentity(
        m(),
        { agentProvider: 'codex', model: 'gpt-5.6-sol' },
        undefined,
        catalog,
      ),
    ).toEqual({ provider: 'codex', model: 'gpt-5.6-sol', effort: undefined });
  });

  it('a present override replaces model/effort, not merges them', () => {
    expect(
      resolveLaunchIdentity(
        m(),
        { agentPreset: 'deep', model: 'claude-opus-5', effort: 'high' },
        { provider: 'codex' },
        catalog,
      ),
    ).toEqual({ provider: 'codex', model: undefined, effort: undefined });
  });

  it('override.provider falls back to the resolved provider when undefined', () => {
    expect(
      resolveLaunchIdentity(m(), {}, { model: 'claude-opus-5' }, catalog),
    ).toEqual({ provider: 'opencode', model: 'claude-opus-5', effort: undefined });
  });
});

describe('resolveTicketProvider', () => {
  it('is preset-aware', () => {
    expect(resolveTicketProvider(m(), {})).toBe('opencode');
    expect(resolveTicketProvider(m(), { agentPreset: 'deep' })).toBe('claude');
    expect(resolveTicketProvider(m(), { agentProvider: 'codex' })).toBe('codex');
  });
});
