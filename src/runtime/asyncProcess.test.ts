import { describe, expect, it } from 'vitest';
import { commandOutput } from './asyncProcess.js';

describe('commandOutput', () => {
  it('lets the extension-host event loop advance while the probe runs', async () => {
    const probe = commandOutput(process.execPath, ['-e', 'setTimeout(() => {}, 100)'], 1_000);
    const first = await Promise.race([
      probe.then(() => 'probe'),
      new Promise<'event-loop'>((resolve) => setTimeout(() => resolve('event-loop'), 0)),
    ]);

    expect(first).toBe('event-loop');
    await probe;
  });

  it('kills a probe that exceeds its deadline', async () => {
    const started = Date.now();

    const output = await commandOutput(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 10_000)'],
      50,
    );

    expect(output).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
