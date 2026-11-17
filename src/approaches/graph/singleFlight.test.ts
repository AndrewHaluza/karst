import { describe, it, expect } from 'vitest';
import { perKeySingleFlight } from './singleFlight.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('perKeySingleFlight', () => {
  it('never runs one key twice in parallel and re-runs once after the first run', async () => {
    const gates = [deferred(), deferred(), deferred()];
    let running = 0;
    let maxRunning = 0;
    let calls = 0;
    const guarded = perKeySingleFlight(async (_key: number) => {
      const gate = gates[calls++]!;
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await gate.promise;
      running -= 1;
    });
    const a = guarded(1);
    const b = guarded(1);
    const c = guarded(1);
    expect(calls).toBe(1);
    gates[0]!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    gates[1]!.resolve();
    await Promise.all([a, b, c]);
    expect(calls).toBe(2); // the 2nd and 3rd calls coalesce into ONE re-run
    expect(maxRunning).toBe(1);
  });

  it('runs different keys in parallel', async () => {
    const gate = deferred();
    let started = 0;
    const guarded = perKeySingleFlight(async (_key: number) => {
      started += 1;
      await gate.promise;
    });
    const a = guarded(1);
    const b = guarded(2);
    expect(started).toBe(2);
    gate.resolve();
    await Promise.all([a, b]);
  });

  it('runs again for a call made after the run finished', async () => {
    let calls = 0;
    const guarded = perKeySingleFlight(async (_key: number) => {
      calls += 1;
    });
    await guarded(1);
    await guarded(1);
    expect(calls).toBe(2);
  });

  it('frees the key when the run throws', async () => {
    let calls = 0;
    const guarded = perKeySingleFlight(async (_key: number) => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
    });
    await expect(guarded(1)).rejects.toThrow('boom');
    await guarded(1);
    expect(calls).toBe(2);
  });
});
