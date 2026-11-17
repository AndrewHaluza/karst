import { describe, expect, it } from 'vitest';
import { Counter } from './counter.js';
import type { KeyValueStore } from './store.js';

function memoryStore(): KeyValueStore {
  const data = new Map<string, number>();
  return { get: async (k) => data.get(k), set: async (k, v) => void data.set(k, v) };
}

describe('Counter', () => {
  it('counts one after another', async () => {
    const c = new Counter(memoryStore());
    await c.increment('a');
    await c.increment('a', 2);
    expect(await c.read('a')).toBe(3);
  });
});
