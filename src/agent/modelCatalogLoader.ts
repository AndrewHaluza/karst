import type { AgentProvider } from '../manifest/types.js';
import {
  bundledModelCatalog,
  parseModelFeed,
  validateModelList,
  type ModelCatalog,
  type ModelOption,
} from './modelCatalog.js';
import {
  discoverAntigravityModels,
  discoverClaudeModels,
  discoverCodexModels,
  type DiscoveryResult,
} from './modelDiscovery.js';

const DEFAULT_FEED_URL = 'https://raw.githubusercontent.com/AndrewHaluza/karst/main/model-catalog.json';
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_BODY_BYTES = 256 * 1024;
const PROVIDERS: readonly AgentProvider[] = ['claude', 'codex', 'antigravity'];

export type CatalogSource = 'cli' | 'feed' | 'cache' | 'bundled';

export type CatalogDiagnosticTier = 'cli' | 'feed' | 'cache';

export type CatalogDiagnosticCategory =
  | 'command-unavailable'
  | 'timeout'
  | 'nonzero-exit'
  | 'invalid-output'
  | 'http-error'
  | 'invalid-response'
  | 'empty'
  | 'persistence-failed';

export interface CatalogDiagnostic {
  provider?: AgentProvider;
  tier: CatalogDiagnosticTier;
  category: CatalogDiagnosticCategory;
}

/** Render only the bounded diagnostic discriminants, never untrusted failure detail. */
export function formatCatalogDiagnostic(diagnostic: CatalogDiagnostic): string {
  return `${diagnostic.provider ?? 'all'}:${diagnostic.tier}:${diagnostic.category}`;
}

export interface CatalogCacheEntry {
  models: readonly ModelOption[];
  source: 'cli' | 'feed';
  fetchedAt: number;
}

export interface CatalogCache {
  get(provider: AgentProvider): CatalogCacheEntry | undefined;
  set(provider: AgentProvider, entry: CatalogCacheEntry): void | PromiseLike<void>;
}

export interface FetchLimits {
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export type ModelDiscoveryLoader = () => Promise<DiscoveryResult>;

export interface CatalogLoaderDeps {
  fetchImpl?: typeof fetch;
  feedUrl?: string;
  feedLimits?: FetchLimits;
  cliLoaders?: Partial<Record<AgentProvider, ModelDiscoveryLoader>>;
  cache?: CatalogCache;
  bundledCatalog?: ModelCatalog;
}

interface FeedLoadResult {
  models: Partial<ModelCatalog>;
  failure?: Extract<CatalogDiagnosticCategory, 'http-error' | 'timeout' | 'invalid-response'>;
}

const DEFAULT_CLI_LOADERS: Record<AgentProvider, ModelDiscoveryLoader> = {
  claude: discoverClaudeModels,
  codex: discoverCodexModels,
  antigravity: discoverAntigravityModels,
};

async function readBody(response: Response, maxBodyBytes: number): Promise<string | undefined> {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBodyBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function loadModelFeed(
  fetchImpl: typeof fetch,
  url = DEFAULT_FEED_URL,
  limits: FetchLimits = {},
): Promise<FeedLoadResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return { models: {}, failure: 'http-error' };

    const finalUrl = response.url || url;
    try {
      if (new URL(finalUrl).protocol !== 'https:') {
        return { models: {}, failure: 'invalid-response' };
      }
    } catch {
      return { models: {}, failure: 'invalid-response' };
    }

    const body = await readBody(response, limits.maxBodyBytes ?? MAX_BODY_BYTES);
    if (body === undefined) return { models: {}, failure: 'invalid-response' };

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { models: {}, failure: 'invalid-response' };
    }
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.providers)) {
      return { models: {}, failure: 'invalid-response' };
    }
    return { models: parseModelFeed(parsed) };
  } catch {
    return {
      models: {},
      failure: controller.signal.aborted ? 'timeout' : 'http-error',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch and independently validate a versioned provider model feed. */
export async function fetchModelFeed(
  fetchImpl: typeof fetch,
  url = DEFAULT_FEED_URL,
  limits: FetchLimits = {},
): Promise<Partial<ModelCatalog>> {
  return (await loadModelFeed(fetchImpl, url, limits)).models;
}

function classifyCliFailure(reason: string): CatalogDiagnosticCategory {
  const normalized = reason.toLowerCase();
  if (
    normalized.includes('command unavailable')
    || normalized.includes('not installed')
    || normalized.includes('unsupported')
  ) {
    return 'command-unavailable';
  }
  if (normalized.includes('timed out') || normalized.includes('timeout')) return 'timeout';
  if (
    normalized.includes('command failed')
    || normalized.includes('non-zero')
    || normalized.includes('nonzero')
    || normalized.includes('exited')
  ) {
    return 'nonzero-exit';
  }
  return 'invalid-output';
}

function inspectCli(
  provider: AgentProvider,
  result: PromiseSettledResult<DiscoveryResult>,
): { models?: ModelOption[]; diagnostic?: CatalogDiagnostic } {
  if (result.status !== 'fulfilled') {
    return {
      diagnostic: { provider, tier: 'cli', category: 'invalid-output' },
    };
  }
  if (result.value.status === 'unavailable') {
    return {
      diagnostic: {
        provider,
        tier: 'cli',
        category: classifyCliFailure(result.value.reason),
      },
    };
  }

  const models = validateModelList(provider, result.value.models);
  return models
    ? { models }
    : { diagnostic: { provider, tier: 'cli', category: 'invalid-output' } };
}

function cachedModels(cache: CatalogCache | undefined, provider: AgentProvider): ModelOption[] | undefined {
  const entry = cache?.get(provider);
  if (
    !entry
    || (entry.source !== 'cli' && entry.source !== 'feed')
    || !Number.isFinite(entry.fetchedAt)
  ) return undefined;
  return validateModelList(provider, entry.models);
}

async function persistCacheEntry(
  cache: CatalogCache,
  provider: AgentProvider,
  entry: CatalogCacheEntry,
): Promise<CatalogDiagnostic | undefined> {
  try {
    await cache.set(provider, entry);
    return undefined;
  } catch {
    return { provider, tier: 'cache', category: 'persistence-failed' };
  }
}

/**
 * Resolve each provider independently. A catalog failure for one provider never
 * removes the best available models for its siblings.
 */
export async function loadModelCatalog(
  deps: CatalogLoaderDeps = {},
): Promise<{
  catalog: ModelCatalog;
  sources: Record<AgentProvider, CatalogSource>;
  diagnostics: readonly CatalogDiagnostic[];
}> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const loaders = { ...DEFAULT_CLI_LOADERS, ...deps.cliLoaders };
  const [feedResult, cliResults] = await Promise.all([
    loadModelFeed(fetchImpl, deps.feedUrl, deps.feedLimits),
    Promise.allSettled(PROVIDERS.map((provider) => loaders[provider]()))
  ]);
  const feed = feedResult.models;
  const bundled = deps.bundledCatalog ?? bundledModelCatalog();
  const catalog = {} as Record<AgentProvider, readonly ModelOption[]>;
  const sources = {} as Record<AgentProvider, CatalogSource>;
  const diagnostics: CatalogDiagnostic[] = feedResult.failure
    ? [{ tier: 'feed', category: feedResult.failure }]
    : [];
  const cache = deps.cache;
  const pendingCacheWrites: { provider: AgentProvider; entry: CatalogCacheEntry }[] = [];

  for (const [index, provider] of PROVIDERS.entries()) {
    const inspectedCli = inspectCli(provider, cliResults[index]!);
    const cli = inspectedCli.models;
    if (inspectedCli.diagnostic) diagnostics.push(inspectedCli.diagnostic);

    const fromFeed = feed[provider];
    if (!cli && !fromFeed && !feedResult.failure) {
      diagnostics.push({ provider, tier: 'feed', category: 'empty' });
    }
    const cached = cachedModels(cache, provider);
    const bundledModels = validateModelList(provider, bundled[provider]);
    const models = cli ?? fromFeed ?? cached ?? bundledModels;

    if (!models) {
      throw new Error(`No valid model catalog is available for ${provider}`);
    }

    if (cli) {
      catalog[provider] = cli;
      sources[provider] = 'cli';
      if (cache) {
        pendingCacheWrites.push({
          provider,
          entry: { models: cli, source: 'cli', fetchedAt: Date.now() },
        });
      }
    } else if (fromFeed) {
      catalog[provider] = fromFeed;
      sources[provider] = 'feed';
      if (cache) {
        pendingCacheWrites.push({
          provider,
          entry: { models: fromFeed, source: 'feed', fetchedAt: Date.now() },
        });
      }
    } else if (cached) {
      catalog[provider] = cached;
      sources[provider] = 'cache';
    } else {
      catalog[provider] = models;
      sources[provider] = 'bundled';
    }
  }

  if (cache) {
    const cacheDiagnostics = await Promise.all(
      pendingCacheWrites.map(({ provider, entry }) => persistCacheEntry(cache, provider, entry)),
    );
    for (const diagnostic of cacheDiagnostics) {
      if (diagnostic) diagnostics.push(diagnostic);
    }
  }

  return { catalog, sources, diagnostics };
}
