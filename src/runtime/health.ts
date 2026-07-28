export interface HealthOptions {
  /** Total time to wait before giving up. */
  timeoutMs?: number;
  /** Initial poll interval; backs off up to maxIntervalMs. */
  intervalMs?: number;
  maxIntervalMs?: number;
  /** Abort the wait early (spin cancellation); rejects with HealthAbortedError. */
  signal?: AbortSignal;
}

const DEFAULTS: Required<Omit<HealthOptions, 'signal'>> = {
  timeoutMs: 30_000,
  intervalMs: 150,
  maxIntervalMs: 1_000,
};

export class HealthTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`health check ${url} did not pass within ${timeoutMs}ms`);
    this.name = 'HealthTimeoutError';
  }
}

export class HealthAbortedError extends Error {
  constructor(url: string) {
    super(`health check ${url} was aborted`);
    this.name = 'HealthAbortedError';
  }
}

/**
 * Sleep `ms`, resolving early if `signal` fires. Cleans up both listeners so a
 * cancelled wait doesn't leak the timer or the abort handler.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * One probe: is something ALREADY answering this health URL? Used before a start
 * to tell "my service came up" from "someone else's is on my port" — a question
 * `waitForHealth` cannot answer, because by then both look identical.
 */
export async function isServing(url: string, timeoutMs = 1_000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false; // nothing listening, or not answering in time
  }
}

/**
 * Poll a health URL until it returns a 2xx, with exponential backoff, or reject
 * with HealthTimeoutError after timeoutMs (§7.2 step 4 — health-gated start).
 * A connection refused (server not up yet) is treated the same as a non-2xx:
 * keep polling until the deadline. If `signal` aborts (spin cancelled), rejects
 * promptly with HealthAbortedError instead of waiting out the timeout.
 */
export async function waitForHealth(url: string, opts: HealthOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const intervalMs = opts.intervalMs ?? DEFAULTS.intervalMs;
  const maxIntervalMs = opts.maxIntervalMs ?? DEFAULTS.maxIntervalMs;
  const { signal } = opts;
  const deadline = Date.now() + timeoutMs;
  let interval = intervalMs;

  for (;;) {
    if (signal?.aborted) throw new HealthAbortedError(url);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new HealthTimeoutError(url, timeoutMs);
    const probe = new AbortController();
    const onCallerAbort = (): void => probe.abort(signal?.reason);
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    if (signal?.aborted) onCallerAbort();
    const probeDeadline = setTimeout(
      () => probe.abort(new HealthTimeoutError(url, timeoutMs)),
      remainingMs,
    );
    try {
      const res = await fetch(url, { signal: probe.signal });
      if (res.ok) return;
    } catch (err) {
      // An abort surfaces here as a DOMException; distinguish it from a
      // connection-refused (server not up yet), which we retry.
      if (signal?.aborted) throw new HealthAbortedError(url);
      if (probe.signal.aborted) throw new HealthTimeoutError(url, timeoutMs);
      void err; // not listening yet — fall through to retry
    } finally {
      clearTimeout(probeDeadline);
      signal?.removeEventListener('abort', onCallerAbort);
    }
    if (signal?.aborted) throw new HealthAbortedError(url);
    if (Date.now() >= deadline) throw new HealthTimeoutError(url, timeoutMs);
    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())), signal);
    interval = Math.min(interval * 2, maxIntervalMs);
  }
}
