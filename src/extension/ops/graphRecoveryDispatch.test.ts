import { describe, expect, it, vi } from 'vitest';
import type { RecoveryResult } from '../../approaches/graph/coordinator/recovery.js';
import { dispatchGraphRecovery, type GraphRecoverySeams } from './graphRecoveryDispatch.js';

const replanLaunch = { graphRunId: 7 } as never;
const bootLaunch = { graphRunId: 7 } as never;

function seams(result: RecoveryResult): GraphRecoverySeams & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    recover: vi.fn(() => result),
    launchReplan: vi.fn(() => void calls.push('replan')),
    launchBootstrap: vi.fn(() => void calls.push('bootstrap')),
    onRecovered: vi.fn(() => void calls.push('recovered')),
  };
}

describe('dispatchGraphRecovery', () => {
  it('launches the elected replan planner, then wakes the work', () => {
    const s = seams({ kind: 'replanned', plannerRunId: 1, plannerRunNumber: 2, launch: replanLaunch });
    const result = dispatchGraphRecovery(s, { ticketId: 3, graphRunId: 7, mode: 'resume' });
    expect(result.kind).toBe('replanned');
    expect(s.calls).toEqual(['replan', 'recovered']);
    expect(s.recover).toHaveBeenCalledWith({ ticketId: 3, graphRunId: 7, mode: 'resume' });
    expect(s.onRecovered).toHaveBeenCalledWith(3, 7);
  });

  it('launches the bootstrap relaunch for a relaunched result', () => {
    const s = seams({ kind: 'relaunched', plannerRunId: 1, plannerRunNumber: 2, launch: bootLaunch } as RecoveryResult);
    dispatchGraphRecovery(s, { ticketId: 3, graphRunId: 7 });
    expect(s.calls).toEqual(['bootstrap', 'recovered']);
  });

  it('only wakes the work for a retried run', () => {
    const s = seams({ kind: 'retried', retried: [1], resnapshotted: [] });
    dispatchGraphRecovery(s, { ticketId: 3, graphRunId: 7 });
    expect(s.calls).toEqual(['recovered']);
  });

  it('does not launch a replan whose launch request is null', () => {
    const s = seams({ kind: 'replanned', plannerRunId: null, plannerRunNumber: null, launch: null });
    dispatchGraphRecovery(s, { ticketId: 3, graphRunId: 7 });
    expect(s.calls).toEqual(['recovered']);
  });

  it('does nothing after a refused or no-op result', () => {
    for (const result of [
      { kind: 'refused', reason: 'launch-loop' } as unknown as RecoveryResult,
      { kind: 'no-op' } as RecoveryResult,
    ]) {
      const s = seams(result);
      expect(dispatchGraphRecovery(s, { ticketId: 3, graphRunId: 7 })).toBe(result);
      expect(s.calls).toEqual([]);
    }
  });
});
