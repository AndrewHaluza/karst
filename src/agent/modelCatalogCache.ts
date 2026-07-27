import type { AgentProvider } from '../manifest/types.js';
import type {
  CatalogCache,
  CatalogCacheEntry,
} from './modelCatalogLoader.js';

interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

function cacheKey(provider: AgentProvider): string {
  return `karst.modelCatalog.${provider}`;
}

/** Adapt VS Code's global Memento to the model loader's cache seam. */
export function makeMementoCatalogCache(memento: Memento): CatalogCache {
  return {
    get: (provider) => memento.get<CatalogCacheEntry>(cacheKey(provider)),
    set: (provider, entry) => memento.update(cacheKey(provider), entry),
  };
}
