import { describe, expect, it } from 'vitest';
import { dependencyRegistry } from './deps.js';
import { commandSucceedsAsync, ensureCapabilityAsync } from './depsAsync.js';

describe('commandSucceedsAsync', () => {
  it('leaves the event loop free while a readiness command runs', async () => {
    const order: string[] = [];
    const probe = commandSucceedsAsync(
      process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), 80)'],
      { timeoutMs: 500 },
    ).then((ready) => {
      order.push(`probe:${ready}`);
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    order.push('event-loop');
    await probe;

    expect(order).toEqual(['event-loop', 'probe:true']);
  });

  it('bounds a hung readiness command and reports it unavailable', async () => {
    const startedAt = Date.now();
    const ready = await commandSucceedsAsync(
      process.execPath,
      ['-e', 'setInterval(() => undefined, 1_000)'],
      { timeoutMs: 20 },
    );

    expect(ready).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('turns a spawn error into an unavailable result', async () => {
    await expect(commandSucceedsAsync('karst-command-that-does-not-exist', [])).resolves.toBe(false);
  });
});

describe('ensureCapabilityAsync', () => {
  it('checks only the selected capability through the async probe', async () => {
    const calls: Array<[string, readonly string[]]> = [];
    const registry = dependencyRegistry('codex');
    const faults = await ensureCapabilityAsync(
      'sessions',
      registry,
      async (binary, args) => {
        calls.push([binary, args]);
        return false;
      },
    );

    expect(calls).toEqual([['codex', ['--version']]]);
    expect(faults).toEqual([{ dep: registry[3], state: 'missing' }]);
  });
});
