/**
 * Client side of the host OAuth proxy: control calls, the per-sandbox key, and
 * the paths one editor uses. One proxy runs per editor: the socket directory is
 * derived from the editor's globalStorage path, which differs in Cursor and VS Code.
 */
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, type Stats } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PORT_FILE = 'oauth-proxy.port';
export const CONTROL_SOCKET = 'control.sock';
const CALL_TIMEOUT_MS = 2000;

export interface ProxyPaths {
  readonly portFile: string;
  readonly controlDir: string;
  readonly socketPath: string;
}

/** A unix socket path is short-limited, so the control dir sits in tmp, keyed by globalStorage. */
export function proxyPaths(globalStorageRoot: string, tmp: string = tmpdir()): ProxyPaths {
  const id = createHash('sha256').update(globalStorageRoot).digest('hex').slice(0, 12);
  const uid = typeof process.getuid === 'function' ? `${process.getuid()}-` : '';
  const controlDir = join(tmp, `karst-oauth-${uid}${id}`);
  return { portFile: join(globalStorageRoot, PORT_FILE), controlDir, socketPath: join(controlDir, CONTROL_SOCKET) };
}

/** 256 random bits, URL-safe (43 characters). */
export function newSandboxKey(): string {
  return randomBytes(32).toString('base64url');
}

export interface ProxyHealth { readonly ok: boolean; readonly port: number; readonly keys: number }

export interface ProxyClient {
  health(): Promise<ProxyHealth | undefined>;
  register(key: string, token: string): Promise<void>;
  revoke(key: string): Promise<void>;
  readPort(): Promise<number | undefined>;
}

const ownedByMe = (st: Stats): boolean => typeof process.getuid !== 'function' || st.uid === process.getuid();

/**
 * The control socket carries tokens, and tmp is shared: connect only when the directory is a
 * real 0700 directory and the socket a real socket, both owned by this user. Another user can
 * pre-create the predictable path; this check refuses it (the proxy then fails closed).
 */
export function controlIsTrusted(paths: ProxyPaths): boolean {
  try {
    const dir = lstatSync(paths.controlDir);
    if (!dir.isDirectory() || (dir.mode & 0o077) !== 0 || !ownedByMe(dir)) return false;
    const sock = lstatSync(paths.socketPath);
    return sock.isSocket() && ownedByMe(sock);
  } catch { return false; }
}

function call(socketPath: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ socketPath, method, path, timeout: CALL_TIMEOUT_MS, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch { resolve({ status: res.statusCode ?? 0, data: undefined }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('The proxy control call timed out.')));
    req.on('error', reject);
    req.end(payload);
  });
}

export function createProxyClient(paths: ProxyPaths): ProxyClient {
  const post = async (path: string, body: unknown): Promise<void> => {
    if (!controlIsTrusted(paths)) throw new Error('The proxy control socket is not private to this user.');
    const { status, data } = await call(paths.socketPath, 'POST', path, body);
    if (status !== 200) throw new Error(`The proxy refused the call (${status})${typeof (data as { error?: unknown })?.error === 'string' ? `: ${(data as { error: string }).error}` : ''}.`);
  };
  return {
    async health() {
      try {
        if (!controlIsTrusted(paths)) return undefined;
        const { status, data } = await call(paths.socketPath, 'GET', '/health');
        const h = data as Partial<ProxyHealth> | undefined;
        return status === 200 && h?.ok === true && typeof h.port === 'number' ? { ok: true, port: h.port, keys: h.keys ?? 0 } : undefined;
      } catch { return undefined; }
    },
    register: (key, token) => post('/register', { key, token }),
    revoke: (key) => post('/revoke', { key }),
    async readPort() {
      try {
        const port = Number((await readFile(paths.portFile, 'utf8')).trim());
        return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
      } catch { return undefined; }
    },
  };
}
