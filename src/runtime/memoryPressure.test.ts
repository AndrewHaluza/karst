import { describe, expect, it, vi } from 'vitest';
import { makePressureWatch, type SandboxFootprint } from './memoryPressure.js';

const GB = 1024 ** 3;
const boxes: SandboxFootprint[] = [
  { name: 'small', ticketId: 1, footprintBytes: 0.6 * GB },
  { name: 'big', ticketId: 2, footprintBytes: 2.1 * GB },
];

function watch(free: number, list = boxes, answer = false) {
  let t = 0;
  const warn = vi.fn(async (_message: string, _biggest: SandboxFootprint) => answer);
  const stop = vi.fn(async () => undefined);
  const w = makePressureWatch({ freeBytes: async () => free, minFreeBytes: () => 1.5 * GB, sandboxes: () => list, warn, stop, now: () => t, debounceMs: 1000 });
  return { w, warn, stop, advance: (ms: number) => (t += ms) };
}

describe('makePressureWatch', () => {
  it('names the sandbox with the largest footprint', async () => {
    const { w, warn } = watch(0.5 * GB);
    expect(await w.tick()).toBe(true);
    expect(warn.mock.calls[0]![0]).toContain('big');
  });
  it('is quiet with enough memory or no sandbox', async () => {
    expect(await watch(4 * GB).w.tick()).toBe(false);
    expect(await watch(0.5 * GB, []).w.tick()).toBe(false);
  });
  it('debounces the warning', async () => {
    const { w, warn, advance } = watch(0.5 * GB);
    await w.tick();
    await w.tick();
    expect(warn).toHaveBeenCalledTimes(1);
    advance(1001);
    await w.tick();
    expect(warn).toHaveBeenCalledTimes(2);
  });
  it('Stop stops that sandbox', async () => {
    const { w, stop } = watch(0.5 * GB, boxes, true);
    await w.tick();
    expect(stop).toHaveBeenCalledWith(boxes[1]);
  });
});
