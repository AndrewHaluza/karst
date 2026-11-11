import type { IncomingMessage } from 'node:http';

/**
 * Browser-facing guards shared by the hook routes. A web page can reach a
 * loopback port with a CORS "simple" POST (no preflight) or through DNS
 * rebinding, so a request is refused when it carries an `Origin` header or a
 * `Host` header that is not this listener's own loopback address.
 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const value = host.toLowerCase();
  return value === `127.0.0.1:${port}` || value === `localhost:${port}`;
}

/** True when the request looks like it came from a browser page or a rebound name. */
export function isBrowserRequest(req: IncomingMessage, port: number): boolean {
  return req.headers.origin !== undefined || !isAllowedHost(req.headers.host, port);
}
