import http from 'node:http';
import net from 'node:net';

/**
 * The CONNECT allowlist proxy that runs as the docker sandbox's sidecar
 * (ST2B blocker 4, exp 8). The agent container sits on an `--internal`
 * network with no route out; this proxy is its only way to the internet. It
 * tunnels HTTPS (CONNECT) to an allowlisted host suffix on an allowed port and
 * refuses everything else, including plain HTTP. Node builtins only: it is
 * bundled alone into `dist/sandbox/opencode/allowlist-proxy.mjs`.
 */

export const PROXY_PORT = 3128;
export const DEFAULT_ALLOWED_PORTS: readonly number[] = [443];

/** `ALLOW` env → lowercase host suffixes; blanks and whitespace dropped. */
export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase().replace(/\.$/, ''))
    .filter((entry) => entry !== '');
}

/** Exact host or a subdomain of an allowlisted suffix; never a lookalike (`evilopencode.ai`). */
export function isAllowedHost(host: string, allow: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h !== '' && allow.some((a) => h === a || h.endsWith(`.${a}`));
}

export interface ConnectTarget {
  readonly host: string;
  readonly port: number;
}

/** `host:port` or `[v6]:port` from a CONNECT request line; null when malformed. */
export function parseConnectTarget(url: string | undefined): ConnectTarget | null {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(url ?? '');
  if (!match) return null;
  const port = Number(match[3]);
  if (port < 1 || port > 65535) return null;
  return { host: (match[1] ?? match[2])!, port };
}

export interface AllowlistProxyOptions {
  readonly allow: readonly string[];
  readonly ports?: readonly number[];
  /** One line per decision (`ALLOW host:port` / `DENY host:port`); no payload. */
  readonly log?: (line: string) => void;
}

export function createAllowlistProxy(opts: AllowlistProxyOptions): http.Server {
  const ports = opts.ports ?? DEFAULT_ALLOWED_PORTS;
  const log = opts.log ?? (() => undefined);
  const server = http.createServer((_req, res) => {
    res.writeHead(403);
    res.end('plain http denied');
  });
  server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    const target = parseConnectTarget(req.url);
    if (!target || !ports.includes(target.port) || !isAllowedHost(target.host, opts.allow)) {
      log(`DENY ${req.url ?? ''}`);
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    log(`ALLOW ${target.host}:${target.port}`);
    const upstream = net.connect(target.port, target.host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  return server;
}
