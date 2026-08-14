import { describe, expect, it } from 'vitest';
import { commandOutput } from './asyncProcess.js';

describe('commandOutput', () => {
  it('lets the extension-host event loop advance while the probe runs', async () => {
    // Count timer ticks during the probe instead of racing a real 0ms timer
    // against a real child: under full parallel load the parent's event loop
    // is starved long enough for the 100ms child to win the race, and the
    // assertion that used to fail was really about the loop advancing at all.
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 10);
    await commandOutput(process.execPath, ['-e', 'setTimeout(() => {}, 100)'], 1_000);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
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
