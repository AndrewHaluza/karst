import { describe, expect, it } from 'vitest';
import {
  bundledModelCatalog,
  parseModelFeed,
  validateModelList,
} from './modelCatalog.js';

describe('validateModelList', () => {
  it('normalizes a valid provider model list', () => {
    expect(validateModelList('codex', [{ id: 'gpt-5.6-sol', label: ' GPT-5.6 Sol ' }]))
      .toEqual([{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', providers: ['codex'] }]);
  });

  it.each([
    ['blank id', [{ id: ' ', label: 'Model' }]],
    ['blank label', [{ id: 'model', label: '  ' }]],
    ['unsafe id', [{ id: 'bad id', label: 'Model' }]],
    ['duplicate id', [{ id: 'model', label: 'First' }, { id: 'model', label: 'Second' }]],
    ['empty list', []],
  ])('rejects a %s list', (_reason, models) => {
    expect(validateModelList('codex', models)).toBeUndefined();
  });
});

describe('parseModelFeed', () => {
  it('keeps valid provider sections when siblings are invalid', () => {
    expect(parseModelFeed({
      version: 1,
      providers: {
        claude: [{ id: 'opus', label: 'Opus (latest)' }],
        codex: [],
        antigravity: [{ id: 'bad id', label: 'Bad' }],
      },
    })).toEqual({ claude: [{ id: 'opus', label: 'Opus (latest)', providers: ['claude'] }] });
  });

  it('rejects an unsupported feed version', () => {
    expect(parseModelFeed({
      version: 2,
      providers: { codex: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }] },
    })).toEqual({});
  });
});

describe('bundledModelCatalog', () => {
  it('offers at least one fallback for every provider', () => {
    const catalog = bundledModelCatalog();
    for (const provider of ['claude', 'codex', 'antigravity'] as const) {
      expect(catalog[provider].length).toBeGreaterThan(0);
    }
  });
});
