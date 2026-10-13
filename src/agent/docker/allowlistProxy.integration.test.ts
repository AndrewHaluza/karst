import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createAllowlistProxy } from './allowlistProxy.js';

const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((close) => close()));

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    closers.push(() => server.close());
  });
}

/** Sends a CONNECT, then `payload` once tunnelled; resolves with everything read. */
function connectThrough(proxyPort: number, target: string, payload: string): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let seen = '';
    sock.on('data', (chunk) => {
      seen += chunk.toString('utf8');
      if (seen.includes(' 200 ') && !seen.includes(payload) && payload !== '') sock.write(payload);
      if (seen.includes(`echo:${payload}`)) sock.end();
    });
    sock.on('close', () => resolve(seen));
  });
}

describe('allowlist proxy (real loopback sockets)', () => {
  it('tunnels to an allowlisted host on an allowed port', async () => {
    const echo = net.createServer((s) => s.on('data', (d) => s.write(`echo:${d.toString('utf8')}`)));
    const echoPort = await listen(echo);
    const lines: string[] = [];
    const proxyPort = await listen(createAllowlistProxy({ allow: ['127.0.0.1'], ports: [echoPort], log: (l) => lines.push(l) }));
    const seen = await connectThrough(proxyPort, `127.0.0.1:${echoPort}`, 'ping');
    expect(seen).toContain('HTTP/1.1 200 Connection Established');
    expect(seen).toContain('echo:ping');
    expect(lines).toEqual([`ALLOW 127.0.0.1:${echoPort}`]);
  });

  it('refuses a host outside the allowlist', async () => {
    const lines: string[] = [];
    const proxyPort = await listen(createAllowlistProxy({ allow: ['opencode.ai'], log: (l) => lines.push(l) }));
    const seen = await connectThrough(proxyPort, 'example.com:443', '');
    expect(seen).toContain('HTTP/1.1 403 Forbidden');
    expect(lines).toEqual(['DENY example.com:443']);
  });

  it('refuses an allowlisted host on a port outside the allowed set', async () => {
    const proxyPort = await listen(createAllowlistProxy({ allow: ['127.0.0.1'] }));
    await expect(connectThrough(proxyPort, '127.0.0.1:22', '')).resolves.toContain('403 Forbidden');
  });

  it('refuses plain http', async () => {
    const proxyPort = await listen(createAllowlistProxy({ allow: ['127.0.0.1'] }));
    const status = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port: proxyPort, path: 'http://127.0.0.1/' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
    });
    expect(status).toBe(403);
  });
});
