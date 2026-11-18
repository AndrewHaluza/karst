/**
 * Control API of the host OAuth proxy: register or revoke a `{sandboxKey -> token}`
 * pair and answer a health probe. HTTP over a unix socket in a 0700 directory, the
 * socket itself 0600, so only the same OS user reaches it. Bodies are never logged.
 */
import { chmodSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { KeyRegistry } from './proxyCore.js';

const MAX_BODY = 8 * 1024;

export interface ControlInfo { readonly port: number }

function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { req.destroy(); resolve(undefined); } else chunks.push(c); });
    req.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined);
      } catch { resolve(undefined); }
    });
    req.on('error', () => resolve(undefined));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createControlServer(registry: KeyRegistry, info: ControlInfo): Server {
  return createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, port: info.port, keys: registry.size() });
      if (req.method !== 'POST' || (req.url !== '/register' && req.url !== '/revoke')) return json(res, 404, { ok: false });
      const body = await readJson(req);
      if (!body || typeof body['key'] !== 'string') return json(res, 400, { ok: false, error: 'A JSON body with a key is required.' });
      if (req.url === '/revoke') return json(res, 200, { ok: true, revoked: registry.revoke(body['key']) });
      if (typeof body['token'] !== 'string') return json(res, 400, { ok: false, error: 'A token is required.' });
      const problem = registry.register(body['key'], body['token']);
      return problem ? json(res, 400, { ok: false, error: problem }) : json(res, 200, { ok: true });
    })();
  });
}

/** Create the 0700 control directory (or fail when it is not ours or is open to others). */
export function prepareControlDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = statSync(dir);
  if ((st.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
    throw new Error('The control directory is not private to this user.');
  }
}

/** Listen on the socket path with mode 0600; a stale socket file is removed first. */
export function listenControl(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try { unlinkSync(socketPath); } catch { /* no stale socket */ }
    server.once('error', reject);
    server.listen(socketPath, () => { chmodSync(socketPath, 0o600); resolve(); });
  });
}
