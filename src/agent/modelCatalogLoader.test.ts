import { describe, expect, it } from 'vitest';
import type { AgentProvider } from '../manifest/types.js';
import type { ModelCatalog, ModelOption } from './modelCatalog.js';
import type { DiscoveryResult } from './modelDiscovery.js';
import {
  fetchModelFeed,
  formatCatalogDiagnostic,
  loadModelCatalog,
  type CatalogCache,
  type CatalogCacheEntry,
  type CatalogDiagnostic,
  type CatalogLoaderDeps,
} from './modelCatalogLoader.js';

function models(provider: AgentProvider, id: string): ModelOption[] {
  return [{ id, label: `${id} label`, providers: [provider] }];
}

function catalog(): ModelCatalog {
  return {
    claude: models('claude', 'bundled-claude'),
    codex: models('codex', 'bundled-codex'),
    antigravity: models('antigravity', 'bundled-antigravity'),
  };
}

function available(provider: AgentProvider, id: string): () => Promise<DiscoveryResult> {
  return async () => ({ status: 'available', models: models(provider, id) });
}

const unavailable = async (): Promise<DiscoveryResult> => ({ status: 'unavailable', reason: 'not installed' });

class MemoryCache implements CatalogCache {
  readonly entries = new Map<AgentProvider, CatalogCacheEntry>();
  readonly writes: AgentProvider[] = [];

  get(provider: AgentProvider): CatalogCacheEntry | undefined {
    return this.entries.get(provider);
  }

  set(provider: AgentProvider, entry: CatalogCacheEntry): void {
    this.writes.push(provider);
    this.entries.set(provider, entry);
  }
}

function feedResponse(providers: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ version: 1, providers }), {
    headers: { 'content-type': 'application/json' },
  });
}

function feed(modelsByProvider: Record<string, unknown>): typeof fetch {
  return (async () => feedResponse(modelsByProvider)) as typeof fetch;
}

function completeFeed(): typeof fetch {
  return feed({
    claude: [{ id: 'feed-claude', label: 'feed-claude label' }],
    codex: [{ id: 'feed-codex', label: 'feed-codex label' }],
    antigravity: [{ id: 'feed-antigravity', label: 'feed-antigravity label' }],
  });
}

function baseDeps(cache: CatalogCache, fetchImpl: typeof fetch): CatalogLoaderDeps {
  return {
    cache,
    fetchImpl,
    bundledCatalog: catalog(),
    cliLoaders: { claude: unavailable, codex: unavailable, antigravity: unavailable },
  };
}

describe('loadModelCatalog', () => {
  it('resolves every provider independently through CLI, feed, cache, and bundled tiers', async () => {
    const cache = new MemoryCache();
    cache.entries.set('codex', { models: models('codex', 'cached-codex'), source: 'feed', fetchedAt: 10 });
    cache.entries.set('antigravity', { models: models('antigravity', 'cached-antigravity'), source: 'cli', fetchedAt: 10 });

    const result = await loadModelCatalog({
      ...baseDeps(cache, feed({
        claude: [{ id: 'feed-claude', label: 'Feed Claude' }],
        codex: [{ id: 'feed-codex', label: 'feed-codex label' }],
        antigravity: [],
      })),
      cliLoaders: {
        claude: available('claude', 'cli-claude'),
        codex: unavailable,
        antigravity: unavailable,
      },
    });

    expect(result.sources).toEqual({ claude: 'cli', codex: 'feed', antigravity: 'cache' });
    expect(result.catalog.claude).toEqual(models('claude', 'cli-claude'));
    expect(result.catalog.codex).toEqual(models('codex', 'feed-codex'));
    expect(result.catalog.antigravity).toEqual(models('antigravity', 'cached-antigravity'));
    expect(cache.writes).toEqual(['claude', 'codex']);
    expect(cache.entries.get('claude')).toMatchObject({ source: 'cli', models: models('claude', 'cli-claude') });
    expect(cache.entries.get('codex')).toMatchObject({ source: 'feed', models: models('codex', 'feed-codex') });
  });

  it('isolates invalid feed and cache sections before falling through to bundled models', async () => {
    const cache = new MemoryCache();
    cache.entries.set('codex', { models: models('codex', 'cached-codex'), source: 'feed', fetchedAt: 10 });
    cache.entries.set('antigravity', { models: [], source: 'cli', fetchedAt: 10 });

    const result = await loadModelCatalog(baseDeps(cache, feed({
      claude: [{ id: 'feed-claude', label: 'Feed Claude' }],
      codex: [],
      antigravity: [{ id: 'bad id', label: 'Bad' }],
    })));

    expect(result.sources).toEqual({ claude: 'feed', codex: 'cache', antigravity: 'bundled' });
    expect(result.catalog.antigravity).toEqual(models('antigravity', 'bundled-antigravity'));
    expect(cache.writes).toEqual(['claude']);
  });

  it('keeps every resolved provider usable when one cache persistence write rejects', async () => {
    const entries = new Map<AgentProvider, CatalogCacheEntry>();
    const cache: CatalogCache = {
      get: (provider) => entries.get(provider),
      set: async (provider, entry) => {
        if (provider === 'claude') {
          throw new Error('SECRET_GLOBAL_STATE_PATH=/private/catalog');
        }
        entries.set(provider, entry);
      },
    };

    const result = await loadModelCatalog(baseDeps(cache, completeFeed()));

    expect(result.sources).toEqual({
      claude: 'feed',
      codex: 'feed',
      antigravity: 'feed',
    });
    expect(result.catalog).toEqual({
      claude: models('claude', 'feed-claude'),
      codex: models('codex', 'feed-codex'),
      antigravity: models('antigravity', 'feed-antigravity'),
    });
    expect(entries.get('codex')).toMatchObject({
      source: 'feed',
      models: models('codex', 'feed-codex'),
    });
    expect(entries.get('antigravity')).toMatchObject({
      source: 'feed',
      models: models('antigravity', 'feed-antigravity'),
    });
    expect(result.diagnostics).toContainEqual({
      provider: 'claude',
      tier: 'cache',
      category: 'persistence-failed',
    });
    expect(JSON.stringify(result.diagnostics)).not.toContain('SECRET_GLOBAL_STATE_PATH');
  });

  it('starts every provider cache write before waiting for a deferred first write', async () => {
    const started: AgentProvider[] = [];
    let releaseClaude!: () => void;
    const claudeWrite = new Promise<void>((resolve) => {
      releaseClaude = resolve;
    });
    let markClaudeStarted!: () => void;
    const claudeStarted = new Promise<void>((resolve) => {
      markClaudeStarted = resolve;
    });
    const cache: CatalogCache = {
      get: () => undefined,
      set: (provider) => {
        started.push(provider);
        if (provider !== 'claude') return;
        markClaudeStarted();
        return claudeWrite;
      },
    };

    const loading = loadModelCatalog(baseDeps(cache, completeFeed()));
    await claudeStarted;
    try {
      expect(started).toEqual(['claude', 'codex', 'antigravity']);
    } finally {
      releaseClaude();
    }

    await expect(loading).resolves.toMatchObject({
      sources: { claude: 'feed', codex: 'feed', antigravity: 'feed' },
    });
  });
});

describe('loadModelCatalog diagnostics', () => {
  it.each([
    ['a missing command', 'command unavailable: SECRET_BINARY_PATH', 'command-unavailable'],
    ['a timeout', 'timed out after SECRET_TIMEOUT_VALUE', 'timeout'],
    ['a non-zero exit', 'command failed: SECRET_STDERR', 'nonzero-exit'],
    ['protocol or invalid output', 'Codex returned SECRET_OUTPUT as an invalid model list', 'invalid-output'],
  ])('classifies %s without retaining its raw CLI reason', async (_case, reason, category) => {
    const result = await loadModelCatalog({
      ...baseDeps(new MemoryCache(), completeFeed()),
      cliLoaders: {
        claude: available('claude', 'cli-claude'),
        codex: async () => ({ status: 'unavailable', reason }),
        antigravity: available('antigravity', 'cli-antigravity'),
      },
    });

    expect(result.sources.codex).toBe('feed');
    expect(result.diagnostics).toEqual([{
      provider: 'codex',
      tier: 'cli',
      category,
    }]);
    expect(JSON.stringify(result.diagnostics)).not.toContain('SECRET_');
  });

  it.each([
    ['an HTTP error', (async () => new Response('SECRET_BODY', { status: 503 })) as typeof fetch, undefined, 'http-error'],
    [
      'a timeout',
      ((_: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('SECRET_ABORT_ERROR')));
      })) as typeof fetch,
      { timeoutMs: 1 },
      'timeout',
    ],
    ['an invalid response', (async () => new Response('{SECRET_RESPONSE')) as typeof fetch, undefined, 'invalid-response'],
  ] as const)('reports %s without exposing the response failure', async (_case, fetchImpl, feedLimits, category) => {
    const result = await loadModelCatalog({
      ...baseDeps(new MemoryCache(), fetchImpl),
      feedLimits,
    });

    expect(result.diagnostics).toContainEqual({ tier: 'feed', category });
    expect(JSON.stringify(result.diagnostics)).not.toContain('SECRET_');
  });

  it('reports a provider-scoped empty feed section', async () => {
    const result = await loadModelCatalog(baseDeps(new MemoryCache(), feed({
      claude: [],
      codex: [{ id: 'feed-codex', label: 'Feed Codex' }],
      antigravity: [{ id: 'feed-antigravity', label: 'Feed Antigravity' }],
    })));

    expect(result.sources.claude).toBe('bundled');
    expect(result.diagnostics).toContainEqual({
      provider: 'claude',
      tier: 'feed',
      category: 'empty',
    });
  });
});

describe('formatCatalogDiagnostic', () => {
  it.each([
    [
      {
        provider: 'codex',
        tier: 'cli',
        category: 'invalid-output',
        reason: 'SECRET_STDERR',
        environment: 'SECRET_TOKEN',
      },
      'codex:cli:invalid-output',
    ],
    [
      {
        tier: 'feed',
        category: 'http-error',
        body: 'SECRET_RESPONSE_BODY',
        error: new Error('SECRET_FETCH_ERROR'),
      },
      'all:feed:http-error',
    ],
  ] as const)('formats only the bounded structured fields', (value, expected) => {
    const diagnostic = value as unknown as CatalogDiagnostic;

    expect(formatCatalogDiagnostic(diagnostic)).toBe(expected);
    expect(formatCatalogDiagnostic(diagnostic)).not.toContain('SECRET_');
  });
});

describe('fetchModelFeed', () => {
  it.each([
    ['HTTP error', (async () => new Response('no', { status: 503 })) as typeof fetch],
    ['invalid JSON', (async () => new Response('{')) as typeof fetch],
    ['unknown schema version', (async () => new Response(JSON.stringify({ version: 2, providers: {} }))) as typeof fetch],
  ])('returns no feed models for a %s', async (_case, fetchImpl) => {
    expect(await fetchModelFeed(fetchImpl)).toEqual({});
  });

  it('rejects a non-HTTPS final URL', async () => {
    const response = feedResponse({ codex: [{ id: 'feed-codex', label: 'Feed Codex' }] });
    Object.defineProperty(response, 'url', { value: 'http://example.test/model-catalog.json' });

    expect(await fetchModelFeed((async () => response) as typeof fetch)).toEqual({});
  });

  it('bounds the response body before parsing it', async () => {
    const oversized = new Response('x'.repeat(33));
    expect(await fetchModelFeed((async () => oversized) as typeof fetch, undefined, { maxBodyBytes: 32 }))
      .toEqual({});
  });

  it('times out a fetch that does not settle', async () => {
    const fetchImpl = ((_: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as typeof fetch;

    expect(await fetchModelFeed(fetchImpl, undefined, { timeoutMs: 1 })).toEqual({});
  });

  it('passes a successful feed list through the shared provider validation', async () => {
    const result = await fetchModelFeed(feed({
      claude: [{ id: 'claude-current', label: ' Claude Current ' }],
      codex: [],
    }));

    expect(result).toEqual({
      claude: [{ id: 'claude-current', label: 'Claude Current', providers: ['claude'] }],
    });
  });
});

describe('loadModelCatalog feed failures', () => {
  const nonHttpsResponse = feedResponse({ claude: [{ id: 'feed-claude', label: 'Feed Claude' }] });
  Object.defineProperty(nonHttpsResponse, 'url', { value: 'http://example.test/model-catalog.json' });
  const failures: readonly [string, typeof fetch, CatalogLoaderDeps['feedLimits']?][] = [
    ['HTTP error', (async () => new Response('no', { status: 500 })) as typeof fetch],
    ['invalid JSON', (async () => new Response('{')) as typeof fetch],
    ['unknown schema version', (async () => new Response(JSON.stringify({ version: 2, providers: {} }))) as typeof fetch],
    ['non-HTTPS final URL', (async () => nonHttpsResponse) as typeof fetch],
    ['oversized body', (async () => new Response('x'.repeat(33))) as typeof fetch, { maxBodyBytes: 32 }],
  ];

  it.each(failures)('falls through to cache when the feed has a %s', async (_case, fetchImpl, feedLimits) => {
    const cache = new MemoryCache();
    cache.entries.set('claude', { models: models('claude', 'cached-claude'), source: 'feed', fetchedAt: 1 });

    const result = await loadModelCatalog({ ...baseDeps(cache, fetchImpl), feedLimits });

    expect(result.sources.claude).toBe('cache');
    expect(result.catalog.claude).toEqual(models('claude', 'cached-claude'));
  });

  it('falls through to cache when the feed times out', async () => {
    const cache = new MemoryCache();
    cache.entries.set('claude', { models: models('claude', 'cached-claude'), source: 'feed', fetchedAt: 1 });
    const fetchImpl = ((_: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as typeof fetch;

    const result = await loadModelCatalog({
      ...baseDeps(cache, fetchImpl),
      feedLimits: { timeoutMs: 1 },
    });

    expect(result.sources.claude).toBe('cache');
  });
});
