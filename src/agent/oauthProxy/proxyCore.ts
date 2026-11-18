/**
 * Host OAuth proxy core (@arch:AC-51). A sandbox guest sends its per-sandbox key;
 * the proxy swaps it for the account's subscription token and forwards to the one
 * fixed upstream. Tokens and keys live in memory only. Nothing here logs headers,
 * bodies, tokens or keys: a log line holds a method, a checked path and a status.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { request as httpRequest, createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { checkRequestTarget } from './pathPolicy.js';

export const OAUTH_BETA = 'oauth-2025-04-20';
export const TOKEN_PREFIX = 'sk-ant-oat01-';
const KEY_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'x-api-key', 'authorization', 'proxy-connection']);

export interface Upstream {
  readonly protocol: 'https:' | 'http:';
  readonly hostname: string;
  readonly port: number;
}

export const ANTHROPIC_UPSTREAM: Upstream = { protocol: 'https:', hostname: 'api.anthropic.com', port: 443 };

export interface KeyRegistry {
  register(key: string, token: string): string | null;
  revoke(key: string): boolean;
  size(): number;
  /** The token of a presented key, or `undefined`. Compares every key in constant time per key. */
  lookup(presented: string): string | undefined;
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

export function createKeyRegistry(): KeyRegistry {
  const entries = new Map<string, { readonly digest: Buffer; readonly token: string }>();
  return {
    register(key, token) {
      if (!KEY_PATTERN.test(key)) return 'The sandbox key must be 43 to 128 URL-safe characters.';
      if (!token.startsWith(TOKEN_PREFIX) || token.length < TOKEN_PREFIX.length + 8 || /\s/.test(token)) return `The token must start with ${TOKEN_PREFIX}.`;
      entries.set(key, { digest: digest(key), token });
      return null;
    },
    revoke: (key) => entries.delete(key),
    size: () => entries.size,
    lookup(presented) {
      const probe = digest(presented);
      let found: string | undefined;
      for (const entry of entries.values()) if (timingSafeEqual(entry.digest, probe)) found = entry.token;
      return found;
    },
  };
}

export interface OauthProxyOptions {
  readonly registry: KeyRegistry;
  readonly upstream?: Upstream;
  /** Receives `METHOD /path status` lines only. */
  readonly log?: (line: string) => void;
}

function bearerOrApiKey(headers: IncomingHttpHeaders): string | undefined {
  const apiKey = headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey !== '') return apiKey;
  const auth = headers['authorization'];
  if (typeof auth === 'string' && /^bearer /i.test(auth)) return auth.slice(7).trim();
  return undefined;
}

function upstreamHeaders(headers: IncomingHttpHeaders, token: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    out[name] = value;
  }
  const beta = headers['anthropic-beta'];
  const existing = (Array.isArray(beta) ? beta.join(',') : beta ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  out['anthropic-beta'] = (existing.includes(OAUTH_BETA) ? existing : [...existing, OAUTH_BETA]).join(',');
  out['authorization'] = `Bearer ${token}`;
  return out;
}

function reject(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message } }));
}

export function createOauthProxy(options: OauthProxyOptions): Server {
  const upstream = options.upstream ?? ANTHROPIC_UPSTREAM;
  const send = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
  const log = options.log ?? (() => {});

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const method = req.method ?? '';
    const target = checkRequestTarget(req.url ?? '');
    if (method === 'CONNECT') { log('CONNECT - 405'); return reject(res, 405, 'CONNECT is not supported.'); }
    if (!target.ok) { log(`${method} - 400 ${target.reason}`); return reject(res, 400, 'The request target is not allowed.'); }
    const presented = bearerOrApiKey(req.headers);
    const token = presented === undefined ? undefined : options.registry.lookup(presented);
    if (token === undefined) { log(`${method} ${target.path} 401`); return reject(res, 401, 'Unknown or missing sandbox key.'); }
    const forward = send({
      protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, method, path: req.url as string,
      headers: upstreamHeaders(req.headers, token),
    }, (answer) => {
      const headers = { ...answer.headers };
      delete headers['connection']; delete headers['keep-alive']; delete headers['transfer-encoding'];
      res.writeHead(answer.statusCode ?? 502, headers);
      log(`${method} ${target.path} ${answer.statusCode ?? 502}`);
      answer.pipe(res);
      answer.on('error', () => res.destroy());
    });
    forward.on('error', () => {
      log(`${method} ${target.path} 502`);
      if (res.headersSent) res.destroy(); else reject(res, 502, 'The upstream request failed.');
    });
    res.on('close', () => { if (!res.writableFinished) forward.destroy(); });
    req.pipe(forward);
  };

  const server = createServer(handle);
  server.on('connect', (_req, socket) => { log('CONNECT - 405'); socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'); });
  server.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  server.on('clientError', (_err, socket) => { socket.destroy(); });
  return server;
}
