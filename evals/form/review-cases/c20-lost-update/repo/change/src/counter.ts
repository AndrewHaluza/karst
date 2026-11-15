import type { KeyValueStore } from './store.js';

/** Counts events per key. Many requests call increment at the same time. */
export class Counter {
  constructor(private readonly store: KeyValueStore) {}

  async increment(key: string, by = 1): Promise<number> {
    const current = (await this.store.get(key)) ?? 0;
    const next = current + by;
    await this.store.set(key, next);
    return next;
  }

  async read(key: string): Promise<number> {
    return (await this.store.get(key)) ?? 0;
  }
}
