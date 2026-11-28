import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import { createTunnelDeps, openTunnel, TunnelOpenError, type TunnelChild } from './sshTunnels.js';

const REMOTE: RemoteDef = { host: 'vm.example.com', user: 'karst', mode: 'direct', remoteDir: '/srv/karst' };

function listen(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.end('other process\n'));
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no TCP address'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

describe('openTunnel with the production host port check', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
    server = undefined;
  });

  it('refuses a -L tunnel on a host port that another process listens on, before any ssh spawn', async () => {
    const held = await listen();
    server = held.server;
    const spawnStream = vi.fn((): TunnelChild => {
      throw new Error('spawn must not run');
    });
    const deps = createTunnelDeps({ spawnStream } as unknown as Parameters<typeof createTunnelDeps>[0]);

    const error = await openTunnel(deps, {
      key: `karst-0123abcd-7-claude:L:${String(held.port)}`,
      kind: 'L',
      remote: REMOTE,
      controlDir: '/tmp/karst-ssh-0/',
      hostPort: held.port,
      remotePort: 3000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TunnelOpenError);
    expect((error as TunnelOpenError).portTaken).toBe(true);
    expect(spawnStream).not.toHaveBeenCalled();
  });
});
