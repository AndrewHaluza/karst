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

/** Fetch and independently validate a versioned provider model feed. */
export async function fetchModelFeed(
  fetchImpl: typeof fetch,
  url = DEFAULT_FEED_URL,
  limits: FetchLimits = {},
): Promise<Partial<ModelCatalog>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return {};

    const finalUrl = response.url || url;
    if (new URL(finalUrl).protocol !== 'https:') return {};

    const body = await readBody(response, limits.maxBodyBytes ?? MAX_BODY_BYTES);
    if (body === undefined) return {};
    return parseModelFeed(JSON.parse(body));
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

function cliModels(provider: AgentProvider, result: PromiseSettledResult<DiscoveryResult>): ModelOption[] | undefined {
  if (result.status !== 'fulfilled' || result.value.status !== 'available') return undefined;
  return validateModelList(provider, result.value.models);
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

/**
 * Resolve each provider independently. A catalog failure for one provider never
 * removes the best available models for its siblings.
 */
export async function loadModelCatalog(
  deps: CatalogLoaderDeps = {},
): Promise<{ catalog: ModelCatalog; sources: Record<AgentProvider, CatalogSource> }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const loaders = { ...DEFAULT_CLI_LOADERS, ...deps.cliLoaders };
  const [feed, cliResults] = await Promise.all([
    fetchModelFeed(fetchImpl, deps.feedUrl, deps.feedLimits),
    Promise.allSettled(PROVIDERS.map((provider) => loaders[provider]()))
  ]);
  const bundled = deps.bundledCatalog ?? bundledModelCatalog();
  const catalog = {} as Record<AgentProvider, readonly ModelOption[]>;
  const sources = {} as Record<AgentProvider, CatalogSource>;

  for (const [index, provider] of PROVIDERS.entries()) {
    const cli = cliModels(provider, cliResults[index]!);
    const fromFeed = feed[provider];
    const cached = cachedModels(deps.cache, provider);
    const bundledModels = validateModelList(provider, bundled[provider]);
    const models = cli ?? fromFeed ?? cached ?? bundledModels;

    if (!models) {
      throw new Error(`No valid model catalog is available for ${provider}`);
    }

    if (cli) {
      catalog[provider] = cli;
      sources[provider] = 'cli';
      await deps.cache?.set(provider, { models: cli, source: 'cli', fetchedAt: Date.now() });
    } else if (fromFeed) {
      catalog[provider] = fromFeed;
      sources[provider] = 'feed';
      await deps.cache?.set(provider, { models: fromFeed, source: 'feed', fetchedAt: Date.now() });
    } else if (cached) {
      catalog[provider] = cached;
      sources[provider] = 'cache';
    } else {
      catalog[provider] = models;
      sources[provider] = 'bundled';
    }
  }

  return { catalog, sources };
}
