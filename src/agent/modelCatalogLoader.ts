import type { AgentProvider } from '../manifest/types.js';
import {
  bundledModelCatalog,
  parseModelFeed,
  validateModelList,
  type ModelCatalog,
  type ModelOption,
  type ModelTag,
} from './modelCatalog.js';
import {
  discoverAntigravityModels,
  discoverClaudeModels,
  discoverCodexModels,
  discoverOpencodeModels,
  type DiscoveryResult,
} from './modelDiscovery.js';

const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_BODY_BYTES = 256 * 1024;
const PROVIDERS: readonly AgentProvider[] = ['claude', 'codex', 'antigravity', 'opencode'];

export type CatalogSource = 'cli' | 'feed' | 'cache' | 'bundled';

export type CatalogDiagnosticTier = 'cli' | 'feed' | 'cache';

export type CatalogDiagnosticCategory =
  | 'command-unavailable'
  | 'unsupported'
  | 'timeout'
  | 'nonzero-exit'
  | 'invalid-output'
  | 'http-error'
  | 'invalid-response'
  | 'empty'
  | 'persistence-failed';

export type CatalogDiagnosticSeverity = 'info' | 'warn';

/**
 * States that are a NORMAL property of a correct install rather than a fault:
 * an optional provider CLI that is simply not installed, a provider karst has
 * no probe for at all, and a feed that carries no section for a provider. Each
 * resolves silently through the next catalog tier, so reporting them at WARN
 * trained users to ignore a channel that also carries real failures.
 *
 * Every other category is an operation that was supposed to work and did not.
 */
const BENIGN_CATEGORIES: readonly CatalogDiagnosticCategory[] = [
  'command-unavailable',
  'unsupported',
  'empty',
];

/** The level a diagnostic must be logged at. Absence is news, not a warning. */
export function catalogDiagnosticSeverity(
  category: CatalogDiagnosticCategory,
): CatalogDiagnosticSeverity {
  return BENIGN_CATEGORIES.includes(category) ? 'info' : 'warn';
}

export interface CatalogDiagnostic {
  provider?: AgentProvider;
  tier: CatalogDiagnosticTier;
  category: CatalogDiagnosticCategory;
  /** The configured endpoint that failed, normalized to origin + path. */
  target?: string;
  /** A bounded cause token: an HTTP status, an error code, or a fixed reason. */
  cause?: string;
}

/** An https/http origin + path and nothing else — no credentials, no query. */
const SAFE_TARGET = /^https?:\/\/[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._~/-]*)?$/;
/** A status code or an error code/name — never a message. */
const SAFE_CAUSE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Strip a configured feed URL down to what is safe to print. Returns undefined
 * rather than a partial value, so a URL that cannot be reduced to origin + path
 * is omitted instead of leaking whatever else it carried.
 */
export function safeDiagnosticTarget(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    return normalized.length <= 200 && SAFE_TARGET.test(normalized) ? normalized : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Render only the bounded diagnostic discriminants, never untrusted failure
 * detail. `target` and `cause` are re-validated here rather than trusted from
 * the value: this is the single point where a diagnostic becomes a log line.
 */
export function formatCatalogDiagnostic(diagnostic: CatalogDiagnostic): string {
  const parts = [`${diagnostic.provider ?? 'all'}:${diagnostic.tier}:${diagnostic.category}`];
  const target = diagnostic.target === undefined ? undefined : safeDiagnosticTarget(diagnostic.target);
  if (target) parts.push(`target=${target}`);
  if (diagnostic.cause !== undefined && SAFE_CAUSE.test(diagnostic.cause)) {
    parts.push(`cause=${diagnostic.cause}`);
  }
  return parts.join(' ');
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
  /**
   * The published model feed, when one is configured. There is deliberately NO
   * default: the tier is opt-in. The former default pointed into a private
   * GitHub repo, where raw.githubusercontent answers every unauthenticated
   * client with 404 — so it produced one unavoidable `feed:http-error` on every
   * activation of every install, plus a network round trip that could never
   * succeed. An unreachable source is not a source; it is removed rather than
   * having its (correct) failure report suppressed.
   */
  feedUrl?: string;
  feedLimits?: FetchLimits;
  cliLoaders?: Partial<Record<AgentProvider, ModelDiscoveryLoader>>;
  cache?: CatalogCache;
  bundledCatalog?: ModelCatalog;
}

type FeedFailureCategory = Extract<
  CatalogDiagnosticCategory,
  'http-error' | 'timeout' | 'invalid-response'
>;

interface FeedFailure {
  category: FeedFailureCategory;
  /** Bounded cause token, or undefined when the category is the whole answer. */
  cause?: string;
}

interface FeedLoadResult {
  models: Partial<ModelCatalog>;
  /** The URL that was actually requested — what the user must be told. */
  target: string;
  failure?: FeedFailure;
}

const DEFAULT_CLI_LOADERS: Record<AgentProvider, ModelDiscoveryLoader> = {
  claude: discoverClaudeModels,
  codex: discoverCodexModels,
  antigravity: discoverAntigravityModels,
  opencode: discoverOpencodeModels,
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

/**
 * A bounded cause token for whatever `fetch` threw. Node attaches machine-set
 * codes (`ENOTFOUND`, `ECONNREFUSED`); the message is not ours and is dropped.
 */
function transportCause(error: unknown): string | undefined {
  const code = isRecord(error) ? error.code : undefined;
  if (typeof code === 'string' && SAFE_CAUSE.test(code)) return code;
  if (error instanceof Error && SAFE_CAUSE.test(error.name)) return error.name;
  return undefined;
}

async function loadModelFeed(
  fetchImpl: typeof fetch,
  url: string,
  limits: FetchLimits = {},
): Promise<FeedLoadResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const failed = (category: FeedFailureCategory, cause?: string): FeedLoadResult => ({
    models: {},
    target: url,
    failure: cause === undefined ? { category } : { category, cause },
  });
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return failed('http-error', String(response.status));

    const finalUrl = response.url || url;
    try {
      if (new URL(finalUrl).protocol !== 'https:') return failed('invalid-response', 'insecure-redirect');
    } catch {
      return failed('invalid-response', 'unparseable-url');
    }

    const body = await readBody(response, limits.maxBodyBytes ?? MAX_BODY_BYTES);
    if (body === undefined) return failed('invalid-response', 'oversized-body');

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return failed('invalid-response', 'unparseable-body');
    }
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.providers)) {
      return failed('invalid-response', 'unsupported-schema');
    }
    return { models: parseModelFeed(parsed), target: url };
  } catch (error) {
    // An abort is our own timeout firing, so it is never attributed to the host.
    return controller.signal.aborted
      ? failed('timeout')
      : failed('http-error', transportCause(error));
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch and independently validate a versioned provider model feed. */
export async function fetchModelFeed(
  fetchImpl: typeof fetch,
  url: string,
  limits: FetchLimits = {},
): Promise<Partial<ModelCatalog>> {
  return (await loadModelFeed(fetchImpl, url, limits)).models;
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
    // The discovery code IS the category — deliberately not re-derived from the
    // `reason`, which is unbounded CLI prose and must never reach a log line.
    return {
      diagnostic: { provider, tier: 'cli', category: result.value.code },
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
    // No configured feed means no fetch at all — not a fetch whose failure is
    // then ignored. `undefined` here is "this tier is off", distinct from a
    // configured feed that answered with nothing.
    deps.feedUrl === undefined
      ? Promise.resolve(undefined)
      : loadModelFeed(fetchImpl, deps.feedUrl, deps.feedLimits),
    Promise.allSettled(PROVIDERS.map((provider) => loaders[provider]()))
  ]);
  const feed = feedResult?.models ?? {};
  const bundled = deps.bundledCatalog ?? bundledModelCatalog();
  const catalog = {} as Record<AgentProvider, readonly ModelOption[]>;
  const sources = {} as Record<AgentProvider, CatalogSource>;
  // Normalized at construction, not at render: a diagnostic is retained and may
  // be serialized elsewhere, so the credentials and query never enter it at all.
  const feedFailure = feedResult?.failure;
  const feedTarget = feedResult && feedFailure ? safeDiagnosticTarget(feedResult.target) : undefined;
  const diagnostics: CatalogDiagnostic[] = feedFailure
    ? [{
      tier: 'feed',
      category: feedFailure.category,
      ...(feedTarget === undefined ? {} : { target: feedTarget }),
      ...(feedFailure.cause === undefined ? {} : { cause: feedFailure.cause }),
    }]
    : [];
  const cache = deps.cache;
  const pendingCacheWrites: { provider: AgentProvider; entry: CatalogCacheEntry }[] = [];

  for (const [index, provider] of PROVIDERS.entries()) {
    const inspectedCli = inspectCli(provider, cliResults[index]!);
    const cli = inspectedCli.models;
    if (inspectedCli.diagnostic) diagnostics.push(inspectedCli.diagnostic);

    // An EXPLICITLY empty feed section is a curated-empty list, not models:
    // `opencode: []` must not shadow a bundled/cached answer (there is none
    // beyond the empty list anyway), so it reads as absent here. The catalog
    // still lands on `opencode: []` via the bundled tier below.
    const feedRaw = feed[provider];
    const fromFeed = feedRaw !== undefined && feedRaw.length > 0 ? feedRaw : undefined;
    // "The feed carries no section for this provider" is only sayable when a
    // feed was configured AND answered. With the tier off there is no feed to
    // be empty, and a failed fetch has already been reported once as itself.
    if (!cli && !fromFeed && feedResult && !feedFailure) {
      diagnostics.push({ provider, tier: 'feed', category: 'empty' });
    }
    const cached = cachedModels(cache, provider);
    // A deliberately empty bundled list (opencode) is a valid empty catalog,
    // distinct from an invalid/missing one — validateModelList refuses empty,
    // so the empty case is admitted before it.
    const bundledList = bundled[provider];
    const bundledModels = bundledList.length === 0
      ? []
      : validateModelList(provider, bundledList);
    const models = cli ?? fromFeed ?? cached ?? bundledModels;

    if (!models) {
      throw new Error(`No valid model catalog is available for ${provider}`);
    }

    // Curated-tag overlay: CLI discovery reports id/label only, so discovered
    // models lack tags that the bundled catalog and feed already declare. Any
    // resolved row whose id matches a curated entry inherits that entry's tags;
    // a row that already carries tags is never overridden. Feed entries win over
    // bundled entries on conflict. The overlay runs before the cache write so
    // CLI-discovered lists persist with tags.
    const curatedTags = new Map<string, readonly ModelTag[]>();
    const bundledRow = bundledList;
    if (bundledRow) {
      for (const m of bundledRow) {
        if (m.tags) curatedTags.set(m.id, m.tags);
      }
    }
    const feedRow = feedRaw;
    if (feedRow) {
      for (const m of feedRow) {
        if (m.tags) curatedTags.set(m.id, m.tags);
      }
    }
    const enriched = models === cli || models === fromFeed || models === cached
      ? models.map((m) => {
        if (m.tags !== undefined) return m;
        const tags = curatedTags.get(m.id);
        return tags ? { ...m, tags } : m;
      })
      : models;

    if (cli) {
      catalog[provider] = enriched;
      sources[provider] = 'cli';
      if (cache) {
        pendingCacheWrites.push({
          provider,
          entry: { models: enriched, source: 'cli', fetchedAt: Date.now() },
        });
      }
    } else if (fromFeed) {
      catalog[provider] = enriched;
      sources[provider] = 'feed';
      if (cache) {
        pendingCacheWrites.push({
          provider,
          entry: { models: enriched, source: 'feed', fetchedAt: Date.now() },
        });
      }
    } else if (cached) {
      catalog[provider] = enriched;
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
