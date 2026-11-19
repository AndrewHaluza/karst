import { describe, it, expect } from 'vitest';
import { isBlockedPort } from './blockedPorts.js';

const MAX_PORT = 11000;
const BATCH = 200;

/** True when `fetch` refuses the port itself (undici's `bad port`), before any connection. */
async function fetchRefuses(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    return false;
  } catch (err) {
    return (err as { cause?: { message?: string } }).cause?.message === 'bad port';
  }
}

describe('isBlockedPort against real fetch', () => {
  it('lists exactly the ports that fetch refuses on 1-11000, and names any that differ', async () => {
    const mismatches: string[] = [];
    for (let from = 1; from <= MAX_PORT; from += BATCH) {
      const ports = Array.from({ length: Math.min(BATCH, MAX_PORT - from + 1) }, (_, i) => from + i);
      const refused = await Promise.all(ports.map(fetchRefuses));
      ports.forEach((port, i) => {
        if (refused[i] && !isBlockedPort(port)) mismatches.push(`${port}: fetch refuses it, list misses it`);
        if (!refused[i] && isBlockedPort(port)) mismatches.push(`${port}: listed, fetch accepts it`);
      });
    }
    expect(mismatches).toEqual([]);
  }, 60_000);
});
