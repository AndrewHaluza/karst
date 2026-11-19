import { describe, it, expect } from 'vitest';
import { isBlockedPort } from './blockedPorts.js';

describe('isBlockedPort against real fetch', () => {
  it('matches real fetch on every port that fetch refuses with "bad port"', async () => {
    // fetch rejects a blocked port before any connection, so no port is opened.
    const refused: number[] = [];
    for (let port = 1; port <= 11000; port++) {
      if (!isBlockedPort(port)) continue;
      const err = await fetch(`http://127.0.0.1:${port}/`).then(
        () => undefined,
        (e: { cause?: { message?: string } }) => e,
      );
      if (err?.cause?.message === 'bad port') refused.push(port);
    }
    expect(refused).toHaveLength(82);
  });
});
