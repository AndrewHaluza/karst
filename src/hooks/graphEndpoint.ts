/**
 * Graph loopback wake-up endpoint (Slice 3 Task 2).
 *
 * The loopback notification is ONLY a wake-up: it carries no payload that
 * advances state, and the coordinator rereads canonical state before
 * selecting any edge. The route token is a CSPRNG value of at least 128 bits
 * (`randomBytes(16)` hex = 128 bits), the listener binds `127.0.0.1`, and
 * non-loopback origins are rejected. The endpoint derives bounded routing
 * identity (the graph run id) from its host-created target, returns a fast
 * response BEFORE the coordinator runs, and schedules the coordinator after
 * the response is sent. No bearer capability appears in the URL — the token
 * rides the request body, never the path or query.
 *
 * Wake-ups are rate-limited per graph run with exponential backoff, and the
 * cap applies to VALID requests as well as malformed and stale ones: the URL
 * lives in every agent's environment and is inherited by every process that
 * agent spawns, so a valid-token flood is the realistic attack.
 *
 * A lost wake-up is harmless by construction: the coordinator sweep re-reads
 * canonical state and never depends on this callback.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

/** The bounded routing identity the endpoint derives from a host-created
 *  target: nothing but the graph run id crosses the endpoint boundary. */
export interface WakeupTarget {
  graphRunId: number;
}

export interface GraphWakeupEndpoint {
  port: number;
  /** The wake-up URL (no token in it — the token rides the request body). */
  url: string;
  /** Register a route for a graph run; returns the fresh route token. */
  registerRoute(target: WakeupTarget): { token: string; url: string };
  close(): Promise<void>;
}

export interface GraphWakeupEndpointOptions {
  /** Runs the coordinator for the graph run — never synchronously. */
  schedule: (graphRunId: number) => void;
  /** Exponential-backoff base per accepted wake-up (default 100 ms). */
  baseBackoffMs?: number;
  /** Exponential-backoff ceiling (default 10 s). */
  maxBackoffMs?: number;
  /** Injectable loopback check (tests); defaults to the socket address. */
  isLoopback?: (remoteAddress: string | undefined) => boolean;
  requestTimeoutMs?: number;
  debug?: (message: string) => void;
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_BODY_BYTES = 4096;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

interface Route {
  graphRunId: number;
}

interface BackoffState {
  nextAllowedAt: number;
  backoffMs: number;
}

export function startGraphWakeupEndpoint(
  options: GraphWakeupEndpointOptions,
  port = 0,
): Promise<GraphWakeupEndpoint> {
  const baseBackoffMs = options.baseBackoffMs ?? 100;
  const maxBackoffMs = options.maxBackoffMs ?? 10_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const isLoopback =
    options.isLoopback ?? ((remoteAddress: string | undefined) => LOOPBACK_ADDRESSES.has(remoteAddress ?? ''));
  const routes = new Map<string, Route>();
  const backoff = new Map<number, BackoffState>();

  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST' || req.url !== '/graph-wakeup') {
        res.writeHead(404);
        res.end();
        return;
      }
      if (!isLoopback(req.socket.remoteAddress)) {
        res.writeHead(403);
        res.end();
        return;
      }

      let body = '';
      let settled = false;
      const deadline = setTimeout(() => {
        if (!settled) {
          settled = true;
          res.writeHead(408);
          res.end();
        }
        if (!req.destroyed) req.destroy();
      }, requestTimeoutMs);

      function finish(status: number): void {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        res.writeHead(status);
        res.end();
      }

      function onEnd(): void {
        if (settled) return;
        let token: unknown;
        try {
          token = (JSON.parse(body || '{}') as { token?: unknown }).token;
        } catch {
          finish(400);
          return;
        }
        if (typeof token !== 'string' || token.length === 0) {
          finish(400);
          return;
        }
        const route = routes.get(token);
        if (!route) {
          finish(404);
          return;
        }
        const now = Date.now();
        const state = backoff.get(route.graphRunId);
        if (state && now < state.nextAllowedAt) {
          finish(429); // rate-limited — a valid-token flood is the realistic attack
          return;
        }
        const nextBackoff = Math.min(
          Math.max(state ? state.backoffMs * 2 : baseBackoffMs, baseBackoffMs),
          maxBackoffMs,
        );
        backoff.set(route.graphRunId, { nextAllowedAt: now + nextBackoff, backoffMs: nextBackoff });
        finish(202);
        // The fast response is the contract: the coordinator never runs
        // synchronously inside the request handler.
        setTimeout(() => {
          try {
            options.schedule(route.graphRunId);
          } catch (err) {
            try {
              options.debug?.(`[graph] wake-up schedule failed for run ${route.graphRunId}: ${String(err)}`);
            } catch {
              // Diagnostics are best-effort.
            }
          }
        }, 0);
      }

      let size = 0;
      req.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          finish(400);
          return;
        }
        body += chunk.toString();
      });
      req.on('end', onEnd);
      req.on('error', () => {
        if (!settled) {
          settled = true;
          clearTimeout(deadline);
        }
      });
    });

    server.listen(port, '127.0.0.1');
    server.on('error', reject);
    server.on('listening', () => {
      const addr = server.address();
      const bound = typeof addr === 'object' && addr ? addr.port : port;
      const url = `http://127.0.0.1:${bound}/graph-wakeup`;
      let closePromise: Promise<void> | undefined;
      resolve({
        port: bound,
        url,
        registerRoute: (target: WakeupTarget) => {
          const token = randomBytes(16).toString('hex');
          routes.set(token, { graphRunId: target.graphRunId });
          return { token, url };
        },
        close: () => {
          closePromise ??= new Promise<void>((closeResolve, closeReject) => {
            server.close((err) => {
              if (err) closeReject(err);
              else closeResolve();
            });
          });
          return closePromise;
        },
      });
    });
  });
}
