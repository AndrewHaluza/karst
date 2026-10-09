import { describe, expect, it } from 'vitest';
import { checkStuckTickets, type StuckTicket } from './stuckCheck.js';

const NOW = 10_000_000;
const THRESHOLD = 60_000;

function ticket(overrides: Partial<StuckTicket> = {}): StuckTicket {
  return {
    id: 1,
    key: 'KAR-1',
    stage: 'impl',
    updatedAtMs: NOW - THRESHOLD - 1,
    archived: false,
    paused: false,
    hasLiveSession: false,
    hasRunningGate: false,
    awaitingMerge: false,
    needsHumanRebase: false,
    hasOpenBlockingSubtask: false,
    ...overrides,
  };
}

function run(tickets: StuckTicket[]) {
  return checkStuckTickets({ nowMs: NOW, thresholdMs: THRESHOLD, tickets });
}

describe('checkStuckTickets', () => {
  it('emits one ok state.stuck when no ticket is stuck', () => {
    expect(run([])).toEqual([
      expect.objectContaining({ id: 'state.stuck', area: 'state', status: 'ok' }),
    ]);
  });

  it('flags an idle active ticket with a report-only warn', () => {
    const checks = run([ticket({ key: 'KAR-7', stage: 'review' })]);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      id: 'state.stuck.KAR-7',
      area: 'state',
      status: 'warn',
    });
    expect(checks[0]?.fix).toEqual({
      tier: 'report',
      summary: expect.any(String),
      nextStep: 'Open the ticket in the dashboard and resume or reset the stage',
    });
  });

  it('treats every active stage as stuck-eligible (impl, fix, uat, review)', () => {
    for (const stage of ['impl', 'fix', 'uat', 'review']) {
      const checks = run([ticket({ key: `K-${stage}`, stage })]);
      expect(checks.map((c) => c.id)).toEqual([`state.stuck.K-${stage}`]);
    }
  });

  it('does not flag non-active stages (scope, ship, done) or a null stage', () => {
    const tickets = ['scope', 'ship', 'done', null].map((stage, i) =>
      ticket({ id: i + 1, key: `K-${i}`, stage }),
    );
    expect(run(tickets)).toEqual([
      expect.objectContaining({ id: 'state.stuck', status: 'ok' }),
    ]);
  });

  it('does not flag a ticket idle exactly at or under the threshold', () => {
    const atThreshold = ticket({ updatedAtMs: NOW - THRESHOLD });
    const under = ticket({ id: 2, key: 'KAR-2', updatedAtMs: NOW - 1000 });
    expect(run([atThreshold, under])).toEqual([
      expect.objectContaining({ id: 'state.stuck', status: 'ok' }),
    ]);
  });

  it('does not flag a ticket with a live agent session', () => {
    expect(run([ticket({ hasLiveSession: true })])[0]?.id).toBe('state.stuck');
    expect(run([ticket({ hasLiveSession: true })])[0]?.status).toBe('ok');
  });

  it('does not flag a ticket with a running gate', () => {
    expect(run([ticket({ hasRunningGate: true })])[0]?.status).toBe('ok');
  });

  it('does not flag an archived or paused ticket', () => {
    expect(run([ticket({ archived: true })])[0]?.status).toBe('ok');
    expect(run([ticket({ paused: true })])[0]?.status).toBe('ok');
  });

  it('does not flag a ticket waiting to land (awaiting-merge)', () => {
    expect(run([ticket({ awaitingMerge: true })])[0]?.status).toBe('ok');
  });

  it('does not flag a ticket with a merge conflict needing a human rebase', () => {
    expect(run([ticket({ needsHumanRebase: true })])[0]?.status).toBe('ok');
  });

  it('does not flag a ticket with an open blocking subtask', () => {
    expect(run([ticket({ hasOpenBlockingSubtask: true })])[0]?.status).toBe('ok');
  });

  it('reports only the stuck tickets among a mixed set', () => {
    const checks = run([
      ticket({ id: 1, key: 'A' }),
      ticket({ id: 2, key: 'B', hasLiveSession: true }),
      ticket({ id: 3, key: 'C', awaitingMerge: true }),
    ]);
    expect(checks.map((c) => c.id)).toEqual(['state.stuck.A']);
  });

  it('never emits an auto fix', () => {
    for (const c of run([ticket({ key: 'X' }), ticket({ id: 2, key: 'Y' })])) {
      expect(c.fix?.tier).not.toBe('auto');
    }
  });
});
