import { describe, expect, it } from 'vitest';
import { runsTokens, type RunUsage } from './runTokens.js';
import { tokenView } from './agent.js';
import type { ProcessRun } from '../../store/processRuns.js';

function run(id: number, status: ProcessRun['status'] = 'passed'): ProcessRun {
  return {
    id,
    ticketId: 1,
    stageKey: 'uat',
    processId: 'tester',
    attempt: 0,
    stageRunId: id,
    agentName: null,
    provider: 'claude',
    model: null,
    pid: null,
    childPid: null,
    childStartedAt: null,
    status,
    resultKind: null,
    artifactPath: null,
    failureDetail: null,
    promptTelemetry: null,
    startedAt: '2026-07-20T12:00:00.000Z',
    endedAt: status === 'running' ? null : '2026-07-20T12:01:00.000Z',
  };
}

const EMPTY: RunUsage = { total: 0, cacheRead: 0, estimatedCalls: 0, estimatedTotal: 0 };
const readOf = (usage: RunUsage) => (): RunUsage => usage;

describe('runsTokens', () => {
  it('reads nothing for no run', () => {
    expect(runsTokens([], readOf({ ...EMPTY, total: 9 }))).toBeNull();
  });

  it('asks the ledger for exactly the ids of the runs it is given', () => {
    const asked: number[][] = [];
    runsTokens([run(4), run(7)], (ids) => {
      asked.push([...ids]);
      return { ...EMPTY, total: 10 };
    });
    expect(asked).toEqual([[4, 7]]);
  });

  it('a running run with nothing counted yet is pending, never zero', () => {
    expect(runsTokens([run(1, 'running')], readOf(EMPTY))).toEqual({ total: 0, pending: true });
  });

  it('a finished run with nothing counted reads as absent', () => {
    expect(runsTokens([run(1)], readOf(EMPTY))).toBeNull();
  });

  it('a running run that already has a count shows the count', () => {
    expect(runsTokens([run(1, 'running')], readOf({ ...EMPTY, total: 5 }))).toMatchObject({ total: 5 });
    expect(runsTokens([run(1, 'running')], readOf({ ...EMPTY, total: 5 }))?.pending).toBeUndefined();
  });

  it('keeps estimate-only spend (problem 4)', () => {
    const t = runsTokens([run(1)], readOf({ ...EMPTY, estimatedCalls: 2, estimatedTotal: 3700 }));
    expect(t).toEqual({ total: 0, cacheRead: 0, estimatedCalls: 2, estimatedTotal: 3700 });
  });
});

describe('tokenView for rounds', () => {
  it('pending states why the count is missing and never a number', () => {
    const v = tokenView({ total: 0, pending: true });
    expect(v.state).toBe('pending');
    expect(v).toMatchObject({ label: 'Σ counted at end' });
    expect((v as { title: string }).title).toMatch(/end of the run/i);
    expect(JSON.stringify(v)).not.toMatch(/0 tok/);
  });

  it('estimate-only carries the estimate mark and an estimated title', () => {
    const v = tokenView({ total: 0, estimatedCalls: 2, estimatedTotal: 3700 });
    expect(v).toMatchObject({ state: 'estimated', estimateOnly: true, total: '3.7k' });
    expect((v as { title: string }).title).toMatch(/estimated/);
  });

  it('mixed shows the measured count and names the estimated calls in the title', () => {
    const v = tokenView({ total: 1200, estimatedCalls: 3, estimatedTotal: 900 });
    expect(v).toMatchObject({ state: 'measured', total: '1.2k' });
    expect((v as { title?: string }).title).toMatch(/3 estimated calls/);
  });

  it('the session reading is unchanged for a legacy input', () => {
    expect(tokenView({ total: 1200, estimatedCalls: 3 })).toMatchObject({ state: 'estimated', total: '1.2k' });
    expect((tokenView({ total: 1200, estimatedCalls: 3 }) as { estimateOnly?: boolean }).estimateOnly).toBeUndefined();
  });
});
