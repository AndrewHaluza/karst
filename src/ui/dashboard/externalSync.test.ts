import { describe, expect, it, vi } from 'vitest';
import { ExternalChangeSync, EXTERNAL_SUPPLEMENTAL_DELAY_MS, type ExternalSyncDeps } from './externalSync.js';

function setup(visible: Record<number, boolean>) {
  const calls: string[] = [];
  const deps: ExternalSyncDeps = {
    openTicketIds: () => Object.keys(visible).map(Number),
    isVisible: (id) => visible[id] ?? false,
    pushStoreState: (id) => void calls.push(`store:${id}`),
    pushPassiveState: (id) => void calls.push(`passive:${id}`),
    markSupplementalStale: (id) => void calls.push(`stale:${id}`),
    logError: vi.fn(),
  };
  return { calls, deps, sync: new ExternalChangeSync(deps) };
}

describe('ExternalChangeSync', () => {
  it('pushes the store state at once and the supplemental facts after the trailing timer', () => {
    vi.useFakeTimers();
    const { calls, sync } = setup({ 1: true });
    sync.onChange();
    expect(calls).toEqual(['store:1']);
    vi.advanceTimersByTime(EXTERNAL_SUPPLEMENTAL_DELAY_MS - 1);
    expect(calls).toEqual(['store:1']);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(['store:1', 'passive:1']);
    vi.useRealTimers();
  });

  it('a burst of changes restarts the timer and runs the supplemental loaders once', () => {
    vi.useFakeTimers();
    const { calls, sync } = setup({ 1: true });
    for (let i = 0; i < 5; i++) {
      sync.onChange();
      vi.advanceTimersByTime(EXTERNAL_SUPPLEMENTAL_DELAY_MS - 1);
    }
    vi.advanceTimersByTime(EXTERNAL_SUPPLEMENTAL_DELAY_MS);
    expect(calls.filter((c) => c === 'passive:1')).toHaveLength(1);
    expect(calls.filter((c) => c === 'store:1')).toHaveLength(5);
    vi.useRealTimers();
  });

  it('a hidden panel gets no push and is marked stale for the show catch-up', () => {
    vi.useFakeTimers();
    const { calls, sync } = setup({ 1: false });
    sync.onChange();
    vi.advanceTimersByTime(EXTERNAL_SUPPLEMENTAL_DELAY_MS);
    expect(calls.every((c) => c === 'stale:1')).toBe(true);
    expect(calls).not.toContain('store:1');
    expect(calls).not.toContain('passive:1');
    vi.useRealTimers();
  });

  it('dispose cancels the pending supplemental push', () => {
    vi.useFakeTimers();
    const { calls, sync } = setup({ 1: true });
    sync.onChange();
    sync.dispose();
    vi.advanceTimersByTime(EXTERNAL_SUPPLEMENTAL_DELAY_MS * 2);
    expect(calls).toEqual(['store:1']);
    vi.useRealTimers();
  });

  it('one failing push is logged and does not stop the other panels', () => {
    const { calls, deps, sync } = setup({ 1: true, 2: true });
    deps.pushStoreState = (id) => {
      if (id === 1) throw new Error('boom');
      calls.push(`store:${id}`);
    };
    sync.onChange();
    expect(calls).toEqual(['store:2']);
    expect(deps.logError).toHaveBeenCalledTimes(1);
    sync.dispose();
  });
});
