import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Store } from '../store/db.js';
import {
  dispatchHook,
  parseHookPayload,
  type NotifyTicket,
  type SessionProviderFor,
  type ShouldApplyHookState,
} from './dispatch.js';
import { hookUrl } from '../agent/settings.js';
import type { LogError } from '../logging/logger.js';

/** Cap the accepted hook body — a local sender can't grow host memory unbounded. */
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const LAUNCH_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type HookRequestTarget =
  | { kind: 'ok'; launchId?: string }
  | { kind: 'bad-request' }
  | { kind: 'not-found' };

/** Parse and validate the request target before installing body listeners. */
export function parseHookRequestTarget(raw: string | undefined): HookRequestTarget {
  let target: URL;
  try {
    target = new URL(raw ?? '', 'http://127.0.0.1');
  } catch {
    return { kind: 'bad-request' };
  }
  if (target.pathname !== '/hooks') return { kind: 'not-found' };
  const launchIds = target.searchParams.getAll('karstLaunch');
  if (launchIds.length > 1) return { kind: 'bad-request' };
  const launchId = launchIds[0];
  if (launchId !== undefined && !LAUNCH_ID_RE.test(launchId)) {
    return { kind: 'bad-request' };
  }
  return launchId === undefined ? { kind: 'ok' } : { kind: 'ok', launchId };
}

export interface HookEndpoint {
  port: number;
  url: string;
  close(): Promise<void>;
}

export interface HookEndpointOptions {
  requestTimeoutMs?: number;
}

/**
 * Start the extension-host hook listener (§5.4). Each POST body is parsed and
 * dispatched to the store, then the endpoint returns a fast empty 2xx so the
 * agent never stalls (HTTP hooks are non-blocking; the fast 2xx is the whole
 * contract — T0.2 finding 2). Malformed bodies are swallowed, not errored.
 *
 * Pass port 0 to bind an ephemeral port (tests); the bound port is on the
 * returned handle. `notify` fans a mutation out to the sidebar + dashboard.
 *
 * A non-zero `port` is a REQUEST, not a requirement: if it is already taken
 * (another window's host holds it) the listener falls back to an ephemeral port
 * rather than leaving this host with no hook channel at all.
 */
export function startHookEndpoint(
  store: Store,
  port: number,
  notify?: NotifyTicket,
  logError: LogError = (m, e) => console.error(m, e),
  shouldApplyState?: ShouldApplyHookState,
  sessionProviderFor?: SessionProviderFor,
  options: HookEndpointOptions = {},
): Promise<HookEndpoint> {
  return new Promise((resolve, reject) => {
    const requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Only the POST /hooks contract is served; anything else gets a fast 404.
      if (req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }
      const target = parseHookRequestTarget(req.url);
      if (target.kind !== 'ok') {
        res.writeHead(target.kind === 'not-found' ? 404 : 400);
        res.end();
        return;
      }
      const launchId = target.launchId;

      let body = '';
      let settled = false;
      const deadline = setTimeout(() => finish(408, true), requestTimeoutMs);

      function cleanup(): void {
        clearTimeout(deadline);
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.removeListener('aborted', onAborted);
        req.removeListener('error', onAborted);
      }

      function finish(status: number, destroy = false): void {
        if (settled) return;
        settled = true;
        cleanup();
        if (destroy) {
          if (status !== 408) {
            res.writeHead(status);
            res.end();
            req.destroy();
            return;
          }
          res.destroy();
          return;
        }
        if (!res.headersSent) res.writeHead(status);
        res.end();
      }

      function onAborted(): void {
        if (settled) return;
        settled = true;
        cleanup();
      }

      function onData(chunk: Buffer | string): void {
        body += chunk.toString();
        if (body.length > MAX_BODY_BYTES) {
          finish(413, true);
        }
      }

      function onEnd(): void {
        if (settled) return;

        // Parse + validate is the only step we treat as "malformed → ignore".
        let payload;
        try {
          payload = parseHookPayload(JSON.parse(body || '{}'));
        } catch {
          payload = null; // not JSON — swallow, never stall the agent
        }

        if (payload) {
          const dispatchPayload =
            launchId === undefined
              ? payload
              : { ...payload, launchId };
          // Dispatch failures are real bugs (bad SQL, store error), not a
          // malformed body — surface them instead of silently swallowing.
          try {
            dispatchHook(
              store,
              dispatchPayload,
              notify,
              shouldApplyState,
              sessionProviderFor,
            );
          } catch (err) {
            logError('karst: hook dispatch failed', err);
          }
        }

        finish(204); // fast empty 2xx
      }

      req.on('data', onData);
      req.on('end', onEnd);
      req.on('aborted', onAborted);
      req.on('error', onAborted);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      // The remembered port belongs to someone else. Serving this host's sessions
      // on a fresh port beats serving none; sessions launched from here get the
      // fallback baked into their settings at launch.
      if (err.code === 'EADDRINUSE' && port !== 0) {
        logError(`karst: hook port ${port} in use, falling back to an ephemeral port`, err);
        server.listen(0, '127.0.0.1');
        return;
      }
      reject(err);
    });

    server.listen(port, '127.0.0.1');
    server.on('listening', () => {
      const addr = server.address();
      const bound = typeof addr === 'object' && addr ? addr.port : port;
      let closePromise: Promise<void> | undefined;
      resolve({
        port: bound,
        url: hookUrl(bound),
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
