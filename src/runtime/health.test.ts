import { describe, it, expect } from 'vitest';
import { waitForHealth, HealthTimeoutError, HealthAbortedError } from './health.js';

/** A port nothing listens on — every probe connection-refuses. */
const DEAD_URL = 'http://127.0.0.1:1/health';

describe('waitForHealth', () => {
  it('times out with HealthTimeoutError when nothing ever answers', async () => {
    await expect(
      waitForHealth(DEAD_URL, { timeoutMs: 300, intervalMs: 50 }),
    ).rejects.toBeInstanceOf(HealthTimeoutError);
  });

  it('rejects promptly with HealthAbortedError when the signal fires', async () => {
    const ctrl = new AbortController();
    // Abort well before the 10s timeout would elapse.
    setTimeout(() => ctrl.abort(), 60);
    const start = Date.now();
    await expect(
      waitForHealth(DEAD_URL, { timeoutMs: 10_000, intervalMs: 50, signal: ctrl.signal }),
    ).rejects.toBeInstanceOf(HealthAbortedError);
    // Far under the timeout — proves it aborted, not timed out.
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it('rejects immediately if the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      waitForHealth(DEAD_URL, { timeoutMs: 10_000, signal: ctrl.signal }),
    ).rejects.toBeInstanceOf(HealthAbortedError);
  });
});
