import { describe, expect, it } from 'vitest';
import type { AgentProvider } from '../manifest/types.js';
import type { ModelCatalog, ModelOption } from './modelCatalog.js';
import type { DiscoveryResult } from './modelDiscovery.js';
import {
  fetchModelFeed,
  loadModelCatalog,
  type CatalogCache,
  type CatalogCacheEntry,
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

  it('rejects when persisting a resolved provider catalog fails', async () => {
    const updateFailure = Promise.reject(new Error('global state unavailable'));
    void updateFailure.catch(() => {});
    const cache: CatalogCache = {
      get: () => undefined,
      set: () => updateFailure,
    };

    await expect(loadModelCatalog(baseDeps(cache, feed({
      claude: [{ id: 'feed-claude', label: 'Feed Claude' }],
    })))).rejects.toThrow('global state unavailable');
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
