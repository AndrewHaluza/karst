import { describe, expect, it, vi } from 'vitest';
import {
  LAUNCH_BACKEND_TIMEOUT_MS,
  makeStartGuards,
  settleStartOutcome,
  withBackendTimeout,
  type SessionOutcome,
} from './startOutcome.js';

const deps = () => ({
  ticketId: 7,
  log: vi.fn<(m: string) => void>(),
  markNotStarted: vi.fn<(id: number) => void>(),
});

describe('settleStartOutcome', () => {
  it('launched → ok, no mark, no failure log', () => {
    const d = deps();
    expect(settleStartOutcome({ ...d, outcome: { kind: 'launched' } })).toEqual({ ok: true });
    expect(d.markNotStarted).not.toHaveBeenCalled();
  });

  it.each(['graph-owned', 'recovery', 'cancelled'] as const)('%s is not a failed start', (reason) => {
    const d = deps();
    const outcome: SessionOutcome = { kind: 'not-applicable', reason };
    expect(settleStartOutcome({ ...d, outcome })).toEqual({ ok: true });
    expect(d.markNotStarted).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining(reason));
  });

  it('no outcome at all is a failed start', () => {
    const d = deps();
    expect(settleStartOutcome({ ...d, outcome: undefined }).ok).toBe(false);
    expect(d.markNotStarted).toHaveBeenCalledWith(7);
  });

  it('failed → not-started, a log line with the id and reason, ok:false', () => {
    const d = deps();
    const res = settleStartOutcome({ ...d, outcome: { kind: 'failed', reason: 'no worktree' } });
    expect(res).toEqual({ ok: false, message: 'Could not start ticket: no worktree' });
    expect(d.markNotStarted).toHaveBeenCalledWith(7);
    expect(d.log).toHaveBeenCalledWith(expect.stringMatching(/T?7.*no worktree/));
  });
});

describe('withBackendTimeout', () => {
  it('names a bound above the longest observed start (95 s)', () => {
    expect(LAUNCH_BACKEND_TIMEOUT_MS).toBeGreaterThan(95_000);
  });

  it('passes a result that arrives in time', async () => {
    await expect(withBackendTimeout(async () => 'ok', 50, vi.fn())).resolves.toEqual({ kind: 'done', value: 'ok' });
  });

  it('rejects a backend that fails', async () => {
    await expect(withBackendTimeout(async () => { throw new Error('boom'); }, 50, vi.fn())).rejects.toThrow('boom');
  });

  it('times out a backend that never returns', async () => {
    vi.useFakeTimers();
    const p = withBackendTimeout(() => new Promise<string>(() => {}), 1000, vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toEqual({ kind: 'timed-out' });
    vi.useRealTimers();
  });

  it('hands a late result to onLate and never to the caller', async () => {
    vi.useFakeTimers();
    let release!: (v: string) => void;
    const onLate = vi.fn();
    const p = withBackendTimeout(() => new Promise<string>((r) => { release = r; }), 1000, onLate);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toEqual({ kind: 'timed-out' });
    release('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(onLate).toHaveBeenCalledWith('late');
    vi.useRealTimers();
  });
});

describe('makeStartGuards', () => {
  const guards = (over: { open?: boolean; state?: string; stage?: string } = {}) => {
    const d = {
      log: vi.fn(), warn: vi.fn(), logError: vi.fn(), setNotStarted: vi.fn(),
      isOpen: () => over.open ?? false,
      agentStateOf: () => over.state ?? 'none',
      stageOf: () => over.stage ?? 'impl',
    };
    return { d, g: makeStartGuards(d) };
  };

  it('failedLaunch logs the id and reason and returns failed', () => {
    const { d, g } = guards();
    expect(g.failedLaunch(3, 'no worktree after scope')).toEqual({ kind: 'failed', reason: 'no worktree after scope' });
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('3'));
  });

  it('a backend that hangs marks not-started and throws; a late result is only warned', async () => {
    vi.useFakeTimers();
    const { d, g } = guards();
    let release!: (v: string) => void;
    const caught = g.boundedBackendStep(4, 'T4', () => new Promise<string>((r) => { release = r; })).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(LAUNCH_BACKEND_TIMEOUT_MS);
    expect(await caught).toContain('did not start within');
    expect(d.setNotStarted).toHaveBeenCalledWith(4);
    release('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining('ignored'));
    vi.useRealTimers();
  });

  it('a healthy backend passes its value through without marking', async () => {
    const { d, g } = guards();
    await expect(g.boundedBackendStep(5, 'T5', async () => 'ok')).resolves.toBe('ok');
    expect(d.setNotStarted).not.toHaveBeenCalled();
  });

  it('never marks a ticket with a live session', () => {
    const { d, g } = guards({ open: true });
    expect(g.settle(1, { kind: 'failed', reason: 'x' }).ok).toBe(false);
    expect(d.setNotStarted).not.toHaveBeenCalled();
  });

  it('never overwrites a state an agent already set', () => {
    const { d, g } = guards({ state: 'running' });
    g.settle(1, { kind: 'failed', reason: 'x' });
    expect(d.setNotStarted).not.toHaveBeenCalled();
  });

  it('afterThrow logs the error and marks only a ticket past scope', () => {
    const past = guards();
    past.g.afterThrow(2, new Error('boom'));
    expect(past.d.logError).toHaveBeenCalledWith(expect.stringContaining('2'), expect.any(Error));
    expect(past.d.setNotStarted).toHaveBeenCalledWith(2);
    const atScope = guards({ stage: 'scope' });
    atScope.g.afterThrow(2, new Error('boom'));
    expect(atScope.d.setNotStarted).not.toHaveBeenCalled();
  });

  it('afterThrow keeps the start error when the stage lookup throws', () => {
    const { d } = guards();
    const g = makeStartGuards({ ...d, stageOf: () => { throw new Error('gone'); } });
    expect(() => g.afterThrow(2, new Error('boom'))).not.toThrow();
    expect(d.logError).toHaveBeenCalledTimes(2);
  });
});
