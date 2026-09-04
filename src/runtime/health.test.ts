import { afterEach, describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { waitForHealth, isServing, HealthTimeoutError, HealthAbortedError } from './health.js';

/** A port nothing listens on — every probe connection-refuses. */
const DEAD_URL = 'http://127.0.0.1:1/health';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

  it('aborts a never-settling probe at the overall deadline', async () => {
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason ?? new Error('aborted')),
          { once: true },
        );
      }),
    );

    await expect(
      waitForHealth('http://never/health', { timeoutMs: 40, intervalMs: 5 }),
    ).rejects.toBeInstanceOf(HealthTimeoutError);
  });

  it('preserves caller abort while a probe is pending', async () => {
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason ?? new Error('aborted')),
          { once: true },
        );
      }),
    );
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);

    await expect(
      waitForHealth('http://never/health', { timeoutMs: 1_000, signal: ctrl.signal }),
    ).rejects.toBeInstanceOf(HealthAbortedError);
  });

  it('releases caller abort listeners after a probe succeeds normally', async () => {
    const ctrl = new AbortController();
    const add = vi.spyOn(ctrl.signal, 'addEventListener');
    const remove = vi.spyOn(ctrl.signal, 'removeEventListener');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    await waitForHealth('http://healthy/health', {
      timeoutMs: 1_000,
      signal: ctrl.signal,
    });

    expect(add.mock.calls.filter(([type]) => type === 'abort')).toHaveLength(1);
    expect(remove.mock.calls.filter(([type]) => type === 'abort')).toHaveLength(1);
  });

  it('releases caller abort listeners after a probe fails normally', async () => {
    const ctrl = new AbortController();
    const add = vi.spyOn(ctrl.signal, 'addEventListener');
    const remove = vi.spyOn(ctrl.signal, 'removeEventListener');
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockRejectedValueOnce(new Error('connection refused'))
        .mockResolvedValueOnce({ ok: true }),
    );

    await waitForHealth('http://eventually-healthy/health', {
      timeoutMs: 1_000,
      intervalMs: 1,
      signal: ctrl.signal,
    });

    const added = add.mock.calls.filter(([type]) => type === 'abort');
    const removed = remove.mock.calls.filter(([type]) => type === 'abort');
    expect(added.length).toBeGreaterThan(0);
    expect(removed).toHaveLength(added.length);
  });

  it.each([
    ['omitted options', {}],
    [
      'explicit undefined options',
      { timeoutMs: undefined, intervalMs: undefined, maxIntervalMs: undefined },
    ],
  ])('uses defaults for %s', async (_label, options) => {
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve({ ok: true } as Response), 10);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(init.signal?.reason ?? new Error('aborted'));
          },
          { once: true },
        );
      }),
    );

    await expect(
      waitForHealth('http://delayed-healthy/health', options),
    ).resolves.toBeUndefined();
  });
});

/**
 * Not every service speaks HTTP — a container running a database answers
 * nothing `fetch` can read, so the gate has to be able to ask the only question
 * that has an answer there: does the port accept a connection?
 */
describe('waitForHealth — tcp:// targets', () => {
  it('passes as soon as the port accepts a connection', async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(
        waitForHealth(`tcp://127.0.0.1:${port}`, { timeoutMs: 2_000 }),
      ).resolves.toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('times out when nothing ever listens', async () => {
    // Port 1 is privileged and unbound in every environment this runs in.
    await expect(waitForHealth('tcp://127.0.0.1:1', { timeoutMs: 300 })).rejects.toThrow(
      /did not pass/,
    );
  });

  it('isServing answers for a tcp target without a fetch', async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      expect(await isServing(`tcp://127.0.0.1:${port}`)).toBe(true);
    } finally {
      server.close();
    }
    expect(await isServing('tcp://127.0.0.1:1')).toBe(false);
  });
});
