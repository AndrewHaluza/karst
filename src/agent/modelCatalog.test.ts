import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

  /**
   * The published feed (`model-catalog.json`) and the bundled fallback are the
   * same curated list served two ways. A drift between them means an install
   * that reaches the feed and one that falls back offer different models.
   */
  it('matches the published model feed exactly', () => {
    const feedPath = fileURLToPath(new URL('../../model-catalog.json', import.meta.url));
    const feed = JSON.parse(readFileSync(feedPath, 'utf8')) as unknown;
    expect(parseModelFeed(feed)).toEqual(bundledModelCatalog());
  });
});

// The feed tier is opt-in and has no default URL, so this file is the artifact
// an operator publishes and points `feedUrl` at. Nothing reads it at build time;
// without this guard it can be deleted, renamed, or malformed and the only
// signal is an invalid-response diagnostic on whoever enabled the feed.
describe('the publishable model-catalog.json feed asset', () => {
  const feed: unknown = JSON.parse(
    readFileSync(new URL('../../model-catalog.json', import.meta.url), 'utf8'),
  );

  it('parses through the same validation the loader applies', () => {
    const parsed = parseModelFeed(feed);
    for (const provider of ['claude', 'codex', 'antigravity'] as const) {
      expect(parsed[provider]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
