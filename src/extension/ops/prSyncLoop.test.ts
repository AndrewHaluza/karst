import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makePrSyncLoop, shouldRefresh, type PrSyncLoopDeps, type PrSyncOutcome } from './prSyncLoop.js';

function makeOutcome(overrides: Partial<PrSyncOutcome> = {}): PrSyncOutcome {
  return { changed: 0, mergeChanged: 0, landed: [], archived: [], worktreesSwept: false, ...overrides };
}

function makeDeps(overrides: Partial<Record<keyof PrSyncLoopDeps, unknown>> = {}) {
  return {
    runOnce: vi.fn().mockResolvedValue(makeOutcome()),
    onRefresh: vi.fn(),
    onError: vi.fn(),
    hasProject: vi.fn().mockReturnValue(true),
    ...overrides,
  } as unknown as PrSyncLoopDeps & {
    runOnce: ReturnType<typeof vi.fn>;
    onRefresh: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
    hasProject: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('shouldRefresh', () => {
  it('returns false when all zero and not forced', () => {
    expect(shouldRefresh(false, makeOutcome())).toBe(false);
  });

  it('returns true when forced', () => {
    expect(shouldRefresh(true, makeOutcome())).toBe(true);
  });

  it('returns true when changed > 0', () => {
    expect(shouldRefresh(false, makeOutcome({ changed: 1 }))).toBe(true);
  });

  it('returns true when mergeChanged > 0', () => {
    expect(shouldRefresh(false, makeOutcome({ mergeChanged: 1 }))).toBe(true);
  });

  it('returns true when landed has entries', () => {
    expect(shouldRefresh(false, makeOutcome({ landed: [1] }))).toBe(true);
  });

  it('returns true when archived has entries', () => {
    expect(shouldRefresh(false, makeOutcome({ archived: [1] }))).toBe(true);
  });

  it('returns true when worktreesSwept is true', () => {
    expect(shouldRefresh(false, makeOutcome({ worktreesSwept: true }))).toBe(true);
  });
});

describe('makePrSyncLoop', () => {
  it('calls runOnce and refreshes on change', async () => {
    const d = makeDeps();
    d.runOnce.mockResolvedValue(makeOutcome({ changed: 1 }));
    const loop = makePrSyncLoop(d);
    await loop();
    expect(d.runOnce).toHaveBeenCalledWith(false);
    expect(d.onRefresh).toHaveBeenCalled();
  });

  it('does not refresh when nothing changed', async () => {
    const d = makeDeps();
    const loop = makePrSyncLoop(d);
    await loop();
    expect(d.onRefresh).not.toHaveBeenCalled();
  });

  it('no project short-circuits', async () => {
    const d = makeDeps({ hasProject: vi.fn().mockReturnValue(false) });
    const loop = makePrSyncLoop(d);
    await loop();
    expect(d.runOnce).not.toHaveBeenCalled();
  });

  it('already running queues a force', async () => {
    const d = makeDeps();
    let resolveRun!: () => void;
    d.runOnce.mockImplementation(() => new Promise<void>((r) => { resolveRun = r; }));
    const loop = makePrSyncLoop(d);
    // Start first run
    const p1 = loop();
    // Try to start second run while first is in progress
    void loop(true);
    // First run completes
    resolveRun();
    await p1;
    // The queued force should have run
    expect(d.runOnce).toHaveBeenCalledTimes(2);
    expect(d.runOnce).toHaveBeenLastCalledWith(true);
  });

  it('two forced calls while running still produce only one extra run', async () => {
    const d = makeDeps();
    let resolveRun!: () => void;
    d.runOnce.mockImplementation(() => new Promise<void>((r) => { resolveRun = r; }));
    const loop = makePrSyncLoop(d);
    const p1 = loop();
    void loop(true);
    void loop(true); // second force — should not accumulate
    resolveRun();
    await p1;
    // Wait for the queued run to complete
    await vi.waitFor(() => expect(d.runOnce).toHaveBeenCalledTimes(2));
  });

  it('the force queue is cleared, so a later forced call runs exactly once more', async () => {
    const d = makeDeps();
    const resolvers: Array<() => void> = [];
    d.runOnce.mockImplementation(() => new Promise<void>((r) => { resolvers.push(r); }));
    const loop = makePrSyncLoop(d);

    // First run in flight, one forced call queued behind it.
    const p1 = loop();
    void loop(true);
    resolvers[0]!();
    await p1;
    await vi.waitFor(() => expect(d.runOnce).toHaveBeenCalledTimes(2));

    // Drain the queued run. If forceQueued were left set, draining it would
    // re-enter the loop and the count would keep climbing past 2.
    resolvers[1]!();
    await vi.waitFor(() => expect(d.runOnce).toHaveBeenCalledTimes(2));

    // A brand-new forced call must produce exactly one more run.
    const p3 = loop(true);
    resolvers[2]!();
    await p3;
    expect(d.runOnce).toHaveBeenCalledTimes(3);
  });

  it('non-forced call while running does not queue', async () => {
    const d = makeDeps();
    let resolveRun!: () => void;
    d.runOnce.mockImplementation(() => new Promise<void>((r) => { resolveRun = r; }));
    const loop = makePrSyncLoop(d);
    const p1 = loop();
    void loop(false); // non-forced — should not queue
    resolveRun();
    await p1;
    expect(d.runOnce).toHaveBeenCalledTimes(1);
  });

  it('runOnce error calls onError and clears running', async () => {
    const d = makeDeps();
    d.runOnce.mockRejectedValue(new Error('network'));
    const loop = makePrSyncLoop(d);
    await loop();
    expect(d.onError).toHaveBeenCalledWith(expect.any(Error));
    // Should be able to run again
    await loop();
    expect(d.runOnce).toHaveBeenCalledTimes(2);
  });

  it('hasProject false during queued run short-circuits', async () => {
    const d = makeDeps();
    let resolveRun!: () => void;
    d.runOnce.mockImplementation(() => new Promise<void>((r) => { resolveRun = r; }));
    const loop = makePrSyncLoop(d);
    const p1 = loop();
    void loop(true);
    // Remove project before the queued run executes
    d.hasProject.mockReturnValue(false);
    resolveRun();
    await p1;
    // The queued run should have been short-circuited
    expect(d.runOnce).toHaveBeenCalledTimes(1);
  });
});
