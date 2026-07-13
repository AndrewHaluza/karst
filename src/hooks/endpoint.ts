import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Store } from '../store/db.js';
import { dispatchHook, parseHookPayload, type NotifyTicket } from './dispatch.js';
import { hookUrl } from '../agent/settings.js';
import type { LogError } from '../logging/logger.js';

/** Cap the accepted hook body — a local sender can't grow host memory unbounded. */
const MAX_BODY_BYTES = 64 * 1024;

export interface HookEndpoint {
  port: number;
  url: string;
  close(): void;
}

/**
 * Start the extension-host hook listener (§5.4). Each POST body is parsed and
 * dispatched to the store, then the endpoint returns a fast empty 2xx so the
 * agent never stalls (HTTP hooks are non-blocking; the fast 2xx is the whole
 * contract — T0.2 finding 2). Malformed bodies are swallowed, not errored.
 *
 * Pass port 0 to bind an ephemeral port (tests); the bound port is on the
 * returned handle. `notify` fans a mutation out to the sidebar + dashboard.
 */
export function startHookEndpoint(
  store: Store,
  port: number,
  notify?: NotifyTicket,
  logError: LogError = (m, e) => console.error(m, e),
): Promise<HookEndpoint> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Only the POST /hooks contract is served; anything else gets a fast 404.
      if (req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }

      let body = '';
      let tooLarge = false;
      req.on('data', (chunk) => {
        if (tooLarge) return;
        body += chunk.toString();
        if (body.length > MAX_BODY_BYTES) {
          tooLarge = true;
          res.writeHead(413);
          res.end();
          req.destroy();
        }
      });
      req.on('end', () => {
        if (tooLarge) return;

        // Parse + validate is the only step we treat as "malformed → ignore".
        let payload;
        try {
          payload = parseHookPayload(JSON.parse(body || '{}'));
        } catch {
          payload = null; // not JSON — swallow, never stall the agent
        }

        if (payload) {
          // Dispatch failures are real bugs (bad SQL, store error), not a
          // malformed body — surface them instead of silently swallowing.
          try {
            dispatchHook(store, payload, notify);
          } catch (err) {
            logError('karst: hook dispatch failed', err);
          }
        }

        res.writeHead(204); // fast empty 2xx
        res.end();
      });
    });

    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const bound = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        port: bound,
        url: hookUrl(bound),
        close: () => server.close(),
      });
    });
  });
}
