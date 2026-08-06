import { describe, expect, it, vi } from 'vitest';
import type { AgentProvider } from '../manifest/types.js';
import type { ModelCatalog, ModelOption } from './modelCatalog.js';
import type { DiscoveryResult } from './modelDiscovery.js';
import {
  catalogDiagnosticSeverity,
  fetchModelFeed,
  formatCatalogDiagnostic,
  loadModelCatalog,
  type CatalogCache,
  type CatalogCacheEntry,
  type CatalogDiagnostic,
  type CatalogDiagnosticCategory,
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
    opencode: [],
  };
}

function available(provider: AgentProvider, id: string): () => Promise<DiscoveryResult> {
  return async () => ({ status: 'available', models: models(provider, id) });
}

const unavailable = async (): Promise<DiscoveryResult> => ({
  status: 'unavailable',
  code: 'command-unavailable',
  reason: 'not installed',
});

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

const FEED_URL = 'https://feed.test/model-catalog.json';

function baseDeps(cache: CatalogCache, fetchImpl: typeof fetch): CatalogLoaderDeps {
  return {
    cache,
    fetchImpl,
    feedUrl: FEED_URL,
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

    expect(result.sources).toEqual({ claude: 'cli', codex: 'feed', antigravity: 'cache', opencode: 'bundled' });
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

    expect(result.sources).toEqual({ claude: 'feed', codex: 'cache', antigravity: 'bundled', opencode: 'bundled' });
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
      opencode: 'bundled',
    });
    expect(result.catalog).toEqual({
      claude: models('claude', 'feed-claude'),
      codex: models('codex', 'feed-codex'),
      antigravity: models('antigravity', 'feed-antigravity'),
      opencode: [],
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
    ['a missing command', 'command-unavailable'],
    ['a timeout', 'timeout'],
    ['a non-zero exit', 'nonzero-exit'],
    ['protocol or invalid output', 'invalid-output'],
    ['an unsupported provider probe', 'unsupported'],
  ] as const)('carries the discovery code for %s without retaining its raw CLI reason', async (_case, code) => {
    const result = await loadModelCatalog({
      ...baseDeps(new MemoryCache(), completeFeed()),
      cliLoaders: {
        claude: available('claude', 'cli-claude'),
        codex: async () => ({ status: 'unavailable', code, reason: 'SECRET_STDERR' }),
        antigravity: available('antigravity', 'cli-antigravity'),
      },
    });

    expect(result.sources.codex).toBe('feed');
    expect(result.diagnostics).toEqual([
      { provider: 'codex', tier: 'cli', category: code },
      { provider: 'opencode', tier: 'cli', category: 'unsupported' },
      { provider: 'opencode', tier: 'feed', category: 'empty' },
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain('SECRET_');
  });

  it('never reports an unsupported provider probe as a missing command', async () => {
    const result = await loadModelCatalog({
      ...baseDeps(new MemoryCache(), completeFeed()),
      cliLoaders: {
        claude: async () => ({
          status: 'unavailable',
          code: 'unsupported',
          reason: 'Claude CLI model discovery is unsupported',
        }),
        codex: available('codex', 'cli-codex'),
        antigravity: available('antigravity', 'cli-antigravity'),
      },
    });

    const claudeDiagnostics = result.diagnostics
      .filter((d) => d.provider === 'claude')
      .map(formatCatalogDiagnostic);
    expect(claudeDiagnostics).toEqual(['claude:cli:unsupported']);
  });

  it('accepts an opencode feed section as a curated catalog list', async () => {
    const result = await loadModelCatalog({
      ...baseDeps(new MemoryCache(), feed({
        claude: [{ id: 'feed-claude', label: 'feed-claude label' }],
        codex: [{ id: 'feed-codex', label: 'feed-codex label' }],
        antigravity: [{ id: 'feed-antigravity', label: 'feed-antigravity label' }],
        opencode: [{ id: 'openai/gpt-mini-latest', label: 'GPT Mini (latest)' }],
      })),
    });

    expect(result.sources.opencode).toBe('feed');
    expect(result.catalog.opencode).toEqual([{
      id: 'openai/gpt-mini-latest',
      label: 'GPT Mini (latest)',
      providers: ['opencode'],
    }]);
  });

  it('yields an empty opencode catalog entry when the probe is unsupported', async () => {
    const result = await loadModelCatalog(baseDeps(new MemoryCache(), completeFeed()));

    expect(result.sources.opencode).toBe('bundled');
    expect(result.catalog.opencode).toEqual([]);
    expect(result.diagnostics).toContainEqual({
      provider: 'opencode',
      tier: 'cli',
      category: 'unsupported',
    });
  });

  it.each([
    [
      'an HTTP error',
      (async () => new Response('SECRET_BODY', { status: 503 })) as typeof fetch,
      undefined,
      'http-error',
      '503',
    ],
    [
      'a timeout',
      ((_: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('SECRET_ABORT_ERROR')));
      })) as typeof fetch,
      { timeoutMs: 1 },
      'timeout',
      undefined,
    ],
    [
      'an invalid response',
      (async () => new Response('{SECRET_RESPONSE')) as typeof fetch,
      undefined,
      'invalid-response',
      'unparseable-body',
    ],
  ] as const)('names the failing feed for %s without exposing the response failure', async (
    _case,
    fetchImpl,
    feedLimits,
    category,
    cause,
  ) => {
    const result = await loadModelCatalog({
      ...baseDeps(new MemoryCache(), fetchImpl),
      feedUrl: 'https://feed.test/model-catalog.json',
      feedLimits,
    });

    expect(result.diagnostics).toContainEqual({
      tier: 'feed',
      category,
      target: 'https://feed.test/model-catalog.json',
      ...(cause === undefined ? {} : { cause }),
    });
    expect(JSON.stringify(result.diagnostics)).not.toContain('SECRET_');
  });

  it('reports a transport failure with the underlying error code, not the message', async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new TypeError('fetch failed to SECRET_HOST'), { code: 'ENOTFOUND' });
    }) as typeof fetch;

    const result = await loadModelCatalog({
      ...baseDeps(new MemoryCache(), fetchImpl),
      feedUrl: 'https://feed.test/model-catalog.json',
    });

    expect(result.diagnostics).toContainEqual({
      tier: 'feed',
      category: 'http-error',
      target: 'https://feed.test/model-catalog.json',
      cause: 'ENOTFOUND',
    });
    expect(JSON.stringify(result.diagnostics)).not.toContain('SECRET_');
  });

  it('strips credentials and query from the feed target it reports', async () => {
    const result = await loadModelCatalog({
      ...baseDeps(new MemoryCache(), (async () => new Response('no', { status: 500 })) as typeof fetch),
      feedUrl: 'https://user:SECRET_TOKEN@feed.test/model-catalog.json?key=SECRET_KEY',
    });

    expect(result.diagnostics).toContainEqual({
      tier: 'feed',
      category: 'http-error',
      target: 'https://feed.test/model-catalog.json',
      cause: '500',
    });
    expect(JSON.stringify(result.diagnostics)).not.toContain('SECRET_');
  });

  it('does not abort the catalog when the feed fails', async () => {
    const result = await loadModelCatalog({
      ...baseDeps(new MemoryCache(), (async () => new Response('no', { status: 404 })) as typeof fetch),
    });

    expect(result.sources).toEqual({ claude: 'bundled', codex: 'bundled', antigravity: 'bundled', opencode: 'bundled' });
    expect(result.diagnostics.filter((d) => d.tier === 'feed')).toHaveLength(1);
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

  it('emits no warn-level diagnostic when no optional provider CLI is installed', async () => {
    const result = await loadModelCatalog({
      ...baseDeps(new MemoryCache(), completeFeed()),
      cliLoaders: {
        claude: async () => ({ status: 'unavailable', code: 'unsupported', reason: 'unsupported' }),
        codex: unavailable,
        antigravity: unavailable,
      },
    });

    expect(result.diagnostics.filter((d) => catalogDiagnosticSeverity(d.category) === 'warn')).toEqual([]);
    expect(result.sources).toEqual({ claude: 'feed', codex: 'feed', antigravity: 'feed', opencode: 'bundled' });
  });

  it('never fetches, and reports nothing, when no feed is configured', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', { status: 404 })) as unknown as typeof fetch;

    const result = await loadModelCatalog({
      ...baseDeps(new MemoryCache(), fetchImpl),
      feedUrl: undefined,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.diagnostics.filter((d) => d.tier === 'feed')).toEqual([]);
    expect(result.sources).toEqual({ claude: 'bundled', codex: 'bundled', antigravity: 'bundled', opencode: 'bundled' });
  });

  it('populates the catalog from a provider CLI that is installed', async () => {
    const result = await loadModelCatalog({
      ...baseDeps(new MemoryCache(), completeFeed()),
      cliLoaders: {
        claude: unavailable,
        codex: available('codex', 'cli-codex'),
        antigravity: unavailable,
      },
    });

    expect(result.sources.codex).toBe('cli');
    expect(result.catalog.codex).toEqual(models('codex', 'cli-codex'));
    expect(result.diagnostics.some((d) => d.provider === 'codex')).toBe(false);
  });
});

describe('catalogDiagnosticSeverity', () => {
  it.each([
    ['command-unavailable', 'info'],
    ['unsupported', 'info'],
    ['empty', 'info'],
    ['timeout', 'warn'],
    ['nonzero-exit', 'warn'],
    ['invalid-output', 'warn'],
    ['http-error', 'warn'],
    ['invalid-response', 'warn'],
    ['persistence-failed', 'warn'],
  ] as const)('reports %s at %s', (category: CatalogDiagnosticCategory, severity) => {
    expect(catalogDiagnosticSeverity(category)).toBe(severity);
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
    [
      {
        tier: 'feed',
        category: 'http-error',
        target: 'https://feed.test/model-catalog.json',
        cause: '404',
        body: 'SECRET_RESPONSE_BODY',
      },
      'all:feed:http-error target=https://feed.test/model-catalog.json cause=404',
    ],
  ] as const)('formats only the bounded structured fields', (value, expected) => {
    const diagnostic = value as unknown as CatalogDiagnostic;

    expect(formatCatalogDiagnostic(diagnostic)).toBe(expected);
    expect(formatCatalogDiagnostic(diagnostic)).not.toContain('SECRET_');
  });

  it.each([
    ['a target that is not a bounded URL', { target: 'javascript:alert(1) SECRET' }],
    ['a cause carrying free text', { cause: 'boom: SECRET_STDERR' }],
  ])('drops %s rather than rendering it', (_case, extra) => {
    const diagnostic = { tier: 'feed', category: 'http-error', ...extra } as unknown as CatalogDiagnostic;

    expect(formatCatalogDiagnostic(diagnostic)).toBe('all:feed:http-error');
  });
});

describe('fetchModelFeed', () => {
  it.each([
    ['HTTP error', (async () => new Response('no', { status: 503 })) as typeof fetch],
    ['invalid JSON', (async () => new Response('{')) as typeof fetch],
    ['unknown schema version', (async () => new Response(JSON.stringify({ version: 2, providers: {} }))) as typeof fetch],
  ])('returns no feed models for a %s', async (_case, fetchImpl) => {
    expect(await fetchModelFeed(fetchImpl, FEED_URL)).toEqual({});
  });

  it('rejects a non-HTTPS final URL', async () => {
    const response = feedResponse({ codex: [{ id: 'feed-codex', label: 'Feed Codex' }] });
    Object.defineProperty(response, 'url', { value: 'http://example.test/model-catalog.json' });

    expect(await fetchModelFeed((async () => response) as typeof fetch, FEED_URL)).toEqual({});
  });

  it('bounds the response body before parsing it', async () => {
    const oversized = new Response('x'.repeat(33));
    expect(await fetchModelFeed((async () => oversized) as typeof fetch, FEED_URL, { maxBodyBytes: 32 }))
      .toEqual({});
  });

  it('times out a fetch that does not settle', async () => {
    const fetchImpl = ((_: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as typeof fetch;

    expect(await fetchModelFeed(fetchImpl, FEED_URL, { timeoutMs: 1 })).toEqual({});
  });

  it('passes a successful feed list through the shared provider validation', async () => {
    const result = await fetchModelFeed(feed({
      claude: [{ id: 'claude-current', label: ' Claude Current ' }],
      codex: [],
    }), FEED_URL);

    expect(result).toEqual({
      claude: [{ id: 'claude-current', label: 'Claude Current', providers: ['claude'] }],
      codex: [],
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
