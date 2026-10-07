import { describe, expect, it } from 'vitest';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dependencyRegistry } from './deps.js';
import { commandSucceedsAsync, ensureCapabilityAsync } from './depsAsync.js';

describe('commandSucceedsAsync', () => {
  it('leaves the event loop free while a readiness command runs', async () => {
    const order: string[] = [];
    // The child polls for a release file this test writes only AFTER proving
    // the event loop ran, so the ordering is deterministic under load — a
    // wall-clock race (timer vs child exit) flaked on a busy CI box.
    const releaseFile = join(tmpdir(), `karst-deps-async-${process.pid}-${Date.now()}`);
    const childScript = [
      "const fs = require('fs');",
      `const release = ${JSON.stringify(releaseFile)};`,
      'const t = setInterval(() => {',
      '  if (fs.existsSync(release)) { clearInterval(t); process.exit(0); }',
      '}, 5);',
    ].join('');

    const probe = commandSucceedsAsync(
      process.execPath,
      ['-e', childScript],
      undefined,
      { timeoutMs: 5_000 },
    ).then((ready) => {
      order.push(`probe:${ready}`);
    });

    // Reaching this line proves the probe did not block; the child is still
    // running, so `probe` cannot have settled yet.
    await new Promise<void>((resolve) => setImmediate(resolve));
    order.push('event-loop');
    writeFileSync(releaseFile, '');
    try {
      await probe;
    } finally {
      unlinkSync(releaseFile);
    }

    expect(order).toEqual(['event-loop', 'probe:true']);
  });

  it('bounds a hung readiness command and reports it unavailable', async () => {
    const startedAt = Date.now();
    const ready = await commandSucceedsAsync(
      process.execPath,
      ['-e', 'setInterval(() => undefined, 1_000)'],
      undefined,
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
