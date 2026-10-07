import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { freePortWindow } from './fixtures.js';

/**
 * `freePortWindow` is what keeps a leaked fixture server harmless: it must never
 * hand a suite a port that something already serves. The reported flake was a
 * leaked `0.0.0.0` listener that a `::`/`127.0.0.1` bind probe still reported
 * free, so the window included it and `startHot` refused the stranger mid-suite.
 */
describe('freePortWindow', () => {
  let held: Server | undefined;

  afterEach(async () => {
    if (held) await new Promise<void>((resolve) => held!.close(() => resolve()));
    held = undefined;
  });

  it('never hands out a port an IPv4-wildcard listener already holds', async () => {
    held = createServer();
    await new Promise<void>((resolve) => held!.listen(0, '0.0.0.0', resolve));
    const port = (held.address() as AddressInfo).port;

    const base = await freePortWindow(1, port, port + 8, 1);

    expect(base).toBeGreaterThan(port);
  });
});
