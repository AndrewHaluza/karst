import { describe, it, expect } from 'vitest';
import {
  CLICKUP_TOKEN_KEY,
  setToken,
  hasToken,
  clearToken,
  type SecretStore,
} from './secretStore.js';

/** A fake SecretStore backed by a Map. */
function fakeStore(): { secrets: SecretStore; map: Map<string, string> } {
  const map = new Map<string, string>();
  const secrets: SecretStore = {
    get: async (k) => map.get(k),
    store: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
  };
  return { secrets, map };
}

describe('secretStore token management', () => {
  it('setToken stores the trimmed token under the clickup key', async () => {
    const { secrets, map } = fakeStore();
    await setToken(secrets, '  abc123  ');
    expect(map.get(CLICKUP_TOKEN_KEY)).toBe('abc123');
  });

  it('hasToken reflects presence', async () => {
    const { secrets } = fakeStore();
    expect(await hasToken(secrets)).toBe(false);
    await setToken(secrets, 'tok');
    expect(await hasToken(secrets)).toBe(true);
  });

  it('clearToken deletes the stored token (idempotent)', async () => {
    const { secrets } = fakeStore();
    await setToken(secrets, 'tok');
    await clearToken(secrets);
    expect(await hasToken(secrets)).toBe(false);
    await clearToken(secrets); // no throw on second call
    expect(await hasToken(secrets)).toBe(false);
  });
});
