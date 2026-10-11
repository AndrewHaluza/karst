import { describe, expect, it, vi } from 'vitest';

import { createArtifactCountCache } from './countCache.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('artifact count cache', () => {
  it('answers 0 at once, then the loaded count, and signals the change', async () => {
    const count = vi.fn(async () => 3);
    const onChange = vi.fn();
    const cache = createArtifactCountCache({ count, onChange });
    expect(cache.get(1)).toBe(0);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(cache.get(1)).toBe(3);
  });

  it('does not reload within the freshness window, and does not signal an unchanged count', async () => {
    let t = 0;
    const count = vi.fn(async () => 2);
    const onChange = vi.fn();
    const cache = createArtifactCountCache({ count, onChange, now: () => t, ttlMs: 1000 });
    cache.get(1);
    await flush();
    cache.get(1);
    expect(count).toHaveBeenCalledTimes(1);
    t = 1500;
    cache.get(1);
    await flush();
    expect(count).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight load per ticket', async () => {
    const count = vi.fn(async () => 1);
    const cache = createArtifactCountCache({ count, onChange: () => {}, ttlMs: 0 });
    cache.get(1);
    cache.get(1);
    expect(count).toHaveBeenCalledTimes(1);
    await flush();
  });

  it('keeps the last good count when a load fails, and reports the failure', async () => {
    let fail = false;
    const count = vi.fn(async () => {
      if (fail) throw new Error('boom');
      return 4;
    });
    const onError = vi.fn();
    let t = 0;
    const cache = createArtifactCountCache({ count, onChange: () => {}, onError, now: () => t, ttlMs: 10 });
    cache.get(1);
    await flush();
    fail = true;
    t = 100;
    cache.get(1);
    await flush();
    expect(cache.get(1)).toBe(4);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('applySet records a count the caller already knows', () => {
    const onChange = vi.fn();
    const cache = createArtifactCountCache({ count: async () => 0, onChange });
    cache.set(2, 7);
    expect(cache.get(2)).toBe(7);
    expect(onChange).not.toHaveBeenCalled();
  });
});
