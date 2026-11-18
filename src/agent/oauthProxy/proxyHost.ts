/** Start the proxy and its control socket for one editor (the logic behind `proxyMain.ts`). */
import { chmodSync, closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { CONTROL_SOCKET, createProxyClient } from './client.js';
import { createControlServer, listenControl, prepareControlDir } from './controlServer.js';
import { createKeyRegistry, createOauthProxy, type Upstream } from './proxyCore.js';

export interface ProxyHostOptions {
  readonly portFile: string;
  readonly controlDir: string;
  readonly log?: (line: string) => void;
  readonly upstream?: Upstream;
}

export interface RunningProxy {
  readonly port: number;
  close(): Promise<void>;
}

function lastPort(portFile: string): number {
  try { const p = Number(readFileSync(portFile, 'utf8').trim()); return Number.isInteger(p) && p > 0 && p < 65536 ? p : 0; } catch { return 0; }
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve((server.address() as AddressInfo).port); });
  });
}

const closeServer = (server: Server): Promise<void> => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });

const LOCK_FILE = 'proxy.lock';

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Take the start lock (exclusive create). `undefined` when a live proxy process holds it. */
function acquireLock(lockPath: string): (() => void) | undefined {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => { try { unlinkSync(lockPath); } catch { /* already gone */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let holder = 0;
      try { holder = Number(readFileSync(lockPath, 'utf8').trim()); } catch { /* unreadable: stale */ }
      if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) return undefined;
      try { unlinkSync(lockPath); } catch { /* a peer removed it */ }
    }
  }
  return undefined;
}

/** `undefined` when a live proxy of this editor already owns the control socket. */
export async function startProxyHost(options: ProxyHostOptions): Promise<RunningProxy | undefined> {
  const socketPath = join(options.controlDir, CONTROL_SOCKET);
  prepareControlDir(options.controlDir);
  if (await createProxyClient({ portFile: options.portFile, controlDir: options.controlDir, socketPath }).health()) return undefined;
  // Two proxies that start together must not both bind and unlink each other's socket.
  const release = acquireLock(join(options.controlDir, LOCK_FILE));
  if (!release) return undefined;
  try {
    return await bindAll(options, socketPath, release);
  } catch (e) { release(); throw e; }
}

async function bindAll(options: ProxyHostOptions, socketPath: string, release: () => void): Promise<RunningProxy> {
  const registry = createKeyRegistry();
  const proxy = createOauthProxy({ registry, ...(options.upstream ? { upstream: options.upstream } : {}), ...(options.log ? { log: options.log } : {}) });
  const wanted = lastPort(options.portFile);
  const port = await listen(proxy, wanted).catch((e: NodeJS.ErrnoException) => {
    if (wanted === 0 || e.code !== 'EADDRINUSE') throw e;
    return listen(proxy, 0);
  });
  writeFileSync(options.portFile, `${port}\n`, { mode: 0o600 });
  chmodSync(options.portFile, 0o600);
  const control = createControlServer(registry, { port });
  await listenControl(control, socketPath);
  return { port, close: async () => { await Promise.all([closeServer(proxy), closeServer(control)]); release(); } };
}
