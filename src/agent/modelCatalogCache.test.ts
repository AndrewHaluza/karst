import { describe, expect, it } from 'vitest';
import type { CatalogCacheEntry } from './modelCatalogLoader.js';
import { makeMementoCatalogCache } from './modelCatalogCache.js';

const ENTRY: CatalogCacheEntry = {
  models: [{ id: 'claude-current', label: 'Claude Current', providers: ['claude'] }],
  source: 'cli',
  fetchedAt: 123,
};

describe('makeMementoCatalogCache', () => {
  it('reads the cached entry for a provider', () => {
    const values = new Map<string, unknown>([['karst.modelCatalog.claude', ENTRY]]);
    const cache = makeMementoCatalogCache({
      get: <T>(key: string) => values.get(key) as T | undefined,
      update: async () => {},
    });

    expect(cache.get('claude')).toEqual(ENTRY);
  });

  it('persists an entry under the provider key', () => {
    const values = new Map<string, unknown>();
    const cache = makeMementoCatalogCache({
      get: <T>(key: string) => values.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        values.set(key, value);
      },
    });

    cache.set('claude', ENTRY);

    expect(values.get('karst.modelCatalog.claude')).toEqual(ENTRY);
  });

  it('returns a rejected Memento update to its caller', async () => {
    const updateFailure = Promise.reject(new Error('global state unavailable'));
    void updateFailure.catch(() => {});
    const cache = makeMementoCatalogCache({
      get: () => undefined,
      update: () => updateFailure,
    });

    await expect(cache.set('claude', ENTRY)).rejects.toThrow('global state unavailable');
  });
});
