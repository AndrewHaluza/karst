/** Start the proxy and its control socket for one editor (the logic behind `proxyMain.ts`). */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
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

/** `undefined` when a live proxy of this editor already owns the control socket. */
export async function startProxyHost(options: ProxyHostOptions): Promise<RunningProxy | undefined> {
  const socketPath = join(options.controlDir, CONTROL_SOCKET);
  prepareControlDir(options.controlDir);
  if (await createProxyClient({ portFile: options.portFile, controlDir: options.controlDir, socketPath }).health()) return undefined;
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
  return { port, close: async () => { await Promise.all([closeServer(proxy), closeServer(control)]); } };
}
