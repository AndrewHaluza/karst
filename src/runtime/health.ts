import { isPortOpen } from './portConflict.js';

export interface HealthOptions {
  /** Total time to wait before giving up. */
  timeoutMs?: number;
  /** Initial poll interval; backs off up to maxIntervalMs. */
  intervalMs?: number;
  maxIntervalMs?: number;
  /** Abort the wait early (spin cancellation); rejects with HealthAbortedError. */
  signal?: AbortSignal;
  /**
   * Require the health response to identify itself as THIS start, by echoing
   * this token in `X-Karst-Instance` (opt-in per service). Without it,
   * reachability is the whole test: any 200 on the port passes, including one
   * from another worktree's service that happens to hold it — a wrong PASS,
   * which is worse than a failure because everything downstream is then wired
   * to the wrong gateway. See `docs/arch/worktrees-and-servers.md`.
   */
  requireInstance?: string;
}

/** The header a service echoes karst's per-start token in. */
export const INSTANCE_HEADER = 'x-karst-instance';

/**
 * The env var karst sets to the token, for the service to echo back. Named for
 * the service's benefit: it appears in the process environment the author reads
 * when wiring the header up.
 */
export const INSTANCE_ENV = 'KARST_INSTANCE_TOKEN';

const DEFAULTS: Required<Omit<HealthOptions, 'signal' | 'requireInstance'>> = {
  timeoutMs: 30_000,
  intervalMs: 150,
  maxIntervalMs: 1_000,
};

/**
 * A `tcp://host:port` health target, or null for an HTTP(S) one.
 *
 * Not every service speaks HTTP. A container running postgres, redis or a
 * message broker answers nothing a `fetch` can read, so an HTTP-only gate could
 * only ever time out and kill it — which would make exactly the services people
 * run as images unusable. "The port accepts a connection" is the honest health
 * question for those, and it is the same question `isPortOpen` already answers
 * for port reclaim.
 */
function tcpTarget(url: string): { host: string; port: number } | null {
  if (!url.startsWith('tcp://')) return null;
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port <= 0) return null;
    // `URL` brackets an IPv6 literal; `connect` wants it bare.
    return { host: parsed.hostname.replace(/^\[|\]$/g, ''), port };
  } catch {
    return null;
  }
}

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
 * The port answers, healthily, and it is NOT this start: a service of another
 * worktree (or another run) holds the port. Distinct from a timeout because the
 * fix is different — nothing about this service will make that other process go
 * away — and because reporting it as "did not pass" would describe a service
 * that came up perfectly, somewhere else.
 */
export class HealthForeignInstanceError extends Error {
  constructor(url: string, expected: string, found: string) {
    super(
      `health check ${url} was answered by another instance — expected ${expected}, ` +
        `the service on that port reported ${found}. Something else is serving this port.`,
    );
    this.name = 'HealthForeignInstanceError';
  }
}

/**
 * Does this 2xx belong to the start karst is waiting on?
 *
 * Three answers, and only one of them is a pass:
 *  - no token required → identity is not being checked; any 2xx passes.
 *  - the header matches → this is our process.
 *  - the header is ABSENT → not yet ours. A service that has not read the env
 *    var yet (still booting, or a stale build) must not be accepted on the
 *    strength of a bare 200, or the check buys nothing.
 *  - a DIFFERENT token → someone else is serving this port; fail, don't wait.
 */
function instanceVerdict(
  res: { headers: { get(name: string): string | null } },
  expected: string | undefined,
): { ok: true } | { ok: false; found: string | null } {
  if (expected === undefined) return { ok: true };
  const found = res.headers.get(INSTANCE_HEADER);
  if (found === expected) return { ok: true };
  return { ok: false, found };
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
  const tcp = tcpTarget(url);
  if (tcp) return isPortOpen(tcp.host, tcp.port, timeoutMs);
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
      const tcp = tcpTarget(url);
      if (tcp) {
        // A raw TCP target carries no response headers, so instance identity
        // cannot be asserted here: an open port is the whole verdict.
        if (await isPortOpen(tcp.host, tcp.port, Math.min(remainingMs, 1_000))) return;
      } else {
        const res = await fetch(url, { signal: probe.signal });
        if (res.ok) {
          const verdict = instanceVerdict(res, opts.requireInstance);
          if (verdict.ok) return;
          // A different instance is not something waiting can fix; an absent
          // header may still be a service that has not finished booting, so that
          // one keeps polling and ends as an ordinary timeout.
          if (verdict.found !== null) {
            throw new HealthForeignInstanceError(url, opts.requireInstance!, verdict.found);
          }
        }
      }
    } catch (err) {
      // An abort surfaces here as a DOMException; distinguish it from a
      // connection-refused (server not up yet), which we retry.
      if (signal?.aborted) throw new HealthAbortedError(url);
      // A foreign instance is a verdict, not a probe failure: it came from the
      // `try` above, and retrying would only re-ask a question already answered.
      if (err instanceof HealthForeignInstanceError) throw err;
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
