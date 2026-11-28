import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import { createTunnelDeps, openTunnel, probeLocalPort, TunnelOpenError, type TunnelChild } from './sshTunnels.js';

const REMOTE: RemoteDef = { host: 'vm.example.com', user: 'karst', mode: 'direct', remoteDir: '/srv/karst' };

/** `reset`: the other process resets each connection at once (the probe must not throw on it). */
function listen(mode: 'reply' | 'reset' = 'reply'): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      // The probe destroys its end, so this end can see ECONNRESET: expected here.
      socket.on('error', () => undefined);
      if (mode === 'reset') socket.resetAndDestroy();
      else socket.end('other process\n');
    });
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

  it('the production probe settles for a port whose process resets each connection, and throws nothing later', async () => {
    const held = await listen('reset');
    server = held.server;
    for (let i = 0; i < 20; i += 1) {
      await expect(probeLocalPort(held.port)).resolves.toEqual(expect.any(Boolean));
    }
    // Let a late reset reach the probe socket before the test ends.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
