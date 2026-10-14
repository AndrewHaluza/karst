import { spawn } from 'node:child_process';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { RELAY_SCRIPT } from './dockerPorts.js';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(payload));
    sock.on('data', (d) => { resolve(d.toString('utf8')); sock.end(); });
    sock.on('error', reject);
  });
}

describe('docker port relay script (real node child, loopback)', () => {
  it('forwards a connection to its env target only', async () => {
    const echo = net.createServer((s) => s.on('data', (d) => s.write(`echo:${d.toString('utf8')}`)));
    const target = await new Promise<number>((r) => echo.listen(0, '127.0.0.1', () => r((echo.address() as AddressInfo).port)));
    cleanups.push(() => echo.close());
    const listen = await freePort();
    const child = spawn(process.execPath, ['-e', RELAY_SCRIPT], {
      env: { TARGET_HOST: '127.0.0.1', TARGET_PORT: String(target), LISTEN_PORT: String(listen) },
      stdio: 'ignore',
    });
    cleanups.push(() => child.kill('SIGKILL'));
    let reply = '';
    for (let i = 0; i < 50 && reply === ''; i++) {
      reply = await roundTrip(listen, 'hi').catch(() => new Promise<string>((r) => setTimeout(() => r(''), 50)));
    }
    expect(reply).toBe('echo:hi');
  });
});
