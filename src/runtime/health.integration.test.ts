import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  waitForHealth,
  isServing,
  HealthTimeoutError,
  HealthAbortedError,
  HealthPermanentError,
} from './health.js';

/**
 * A port that was just bound and closed: not blocked by Fetch (port 1 is, so
 * it fails with `bad port` before any connection), so every probe really
 * connection-refuses.
 */
let DEAD_URL = '';

beforeAll(async () => {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  DEAD_URL = `http://127.0.0.1:${port}/health`;
});

afterAll(() => {
  DEAD_URL = '';
});

/** A fetch failure as undici shapes it: `TypeError: fetch failed` with a cause. */
function fetchFailed(cause: { message?: string; code?: string }): TypeError {
  const err = new TypeError('fetch failed');
  (err as { cause?: unknown }).cause = Object.assign(new Error(cause.message ?? 'x'), cause.code ? { code: cause.code } : {});
  return err;
}

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

  describe('instance identity', () => {
    /** A 200 whose identity header is `token` (omitted when null). */
    const answering = (token: string | null) =>
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(token === null ? {} : { 'x-karst-instance': token }),
      }));

    it('passes when the response echoes the expected instance token', async () => {
      vi.stubGlobal('fetch', answering('tok-123'));
      await expect(
        waitForHealth(DEAD_URL, { timeoutMs: 500, requireInstance: 'tok-123' }),
      ).resolves.toBeUndefined();
    });

    it('keeps waiting on a 200 from a DIFFERENT instance, then reports the mismatch', async () => {
      // The wrong-pass this exists to close: another worktree's service
      // answering 200 on a port that has since been handed to this one.
      vi.stubGlobal('fetch', answering('someone-else'));
      await expect(
        waitForHealth(DEAD_URL, { timeoutMs: 300, intervalMs: 50, requireInstance: 'tok-123' }),
      ).rejects.toThrow(/another instance|identity/i);
    });

    it('treats a missing identity header as not-yet-mine, never as a pass', async () => {
      vi.stubGlobal('fetch', answering(null));
      await expect(
        waitForHealth(DEAD_URL, { timeoutMs: 300, intervalMs: 50, requireInstance: 'tok-123' }),
      ).rejects.toBeInstanceOf(HealthTimeoutError);
    });

    it('names the missing header in the timeout message and field', async () => {
      vi.stubGlobal('fetch', answering(null));
      const err = await waitForHealth(DEAD_URL, {
        timeoutMs: 300,
        intervalMs: 50,
        requireInstance: 'tok-123',
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HealthTimeoutError);
      const timeout = err as HealthTimeoutError;
      expect(timeout.message).toContain('200 without x-karst-instance');
      expect(timeout.lastOutcome).toBe('200 without x-karst-instance');
      expect(timeout.identityMissing).toBe(true);
    });

    it('ignores identity entirely when no token is required', async () => {
      vi.stubGlobal('fetch', answering('whoever'));
      await expect(waitForHealth(DEAD_URL, { timeoutMs: 500 })).resolves.toBeUndefined();
    });
  });

  describe('permanent and transient probe errors', () => {
    it.each([
      ['bad port', { message: 'bad port' }],
      ['unknown scheme', { message: 'unknown scheme' }],
      ['ERR_INVALID_URL', { message: 'Invalid URL', code: 'ERR_INVALID_URL' }],
    ])('rejects at once with HealthPermanentError on %s', async (_label, cause) => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailed(cause)));
      const start = Date.now();
      const err = await waitForHealth('http://127.0.0.1:4045/health', {
        timeoutMs: 10_000,
        intervalMs: 50,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HealthPermanentError);
      expect((err as Error).message).toContain('http://127.0.0.1:4045/health');
      expect((err as Error).message).toContain(cause.message);
      expect(Date.now() - start).toBeLessThan(2_000);
    });

    it('rejects at once when the URL cannot be parsed', async () => {
      const err = await waitForHealth('not a url', { timeoutMs: 10_000 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HealthPermanentError);
    });

    it.each(['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET', 'ENOTFOUND', 'HPE_INVALID_CONSTANT', 'ETIMEDOUT', 'EAI_AGAIN'])(
      'retries %s until a later 2xx',
      async (code) => {
        vi.stubGlobal(
          'fetch',
          vi
            .fn()
            .mockRejectedValueOnce(fetchFailed({ code, message: code }))
            .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers() }),
        );
        await expect(
          waitForHealth('http://eventually/health', { timeoutMs: 1_000, intervalMs: 1 }),
        ).resolves.toBeUndefined();
      },
    );

    it('reports the last probe outcome on a timeout', async () => {
      const err = await waitForHealth(DEAD_URL, { timeoutMs: 300, intervalMs: 50 }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(HealthTimeoutError);
      expect((err as HealthTimeoutError).lastOutcome).toBe('refused (ECONNREFUSED)');
      expect((err as Error).message).toContain('refused (ECONNREFUSED)');
    });

    it('reports an HTTP status as the last outcome', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: false, status: 503, headers: new Headers() })),
      );
      const err = await waitForHealth('http://x/health', { timeoutMs: 200, intervalMs: 20 }).catch(
        (e: unknown) => e,
      );
      expect((err as HealthTimeoutError).lastOutcome).toBe('HTTP 503');
      expect((err as HealthTimeoutError).identityMissing).toBe(false);
    });
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
