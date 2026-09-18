import { describe, it, expect } from 'vitest';
import type { StageRun } from '../../store/stageRuns.js';
import { currentAttemptFor } from './currentAttempt.js';

function run(over: Partial<StageRun> & { id: number }): StageRun {
  return {
    ticketId: 1,
    stageKey: 'uat',
    attempt: 0,
    runAt: '2026-09-18T10:00:00.000Z',
    status: 'finished',
    outcome: 'blocked',
    manifestHash: null,
    pid: null,
    startedAt: '2026-09-18T10:00:00.000Z',
    endedAt: '2026-09-18T10:01:00.000Z',
    ...over,
  } as StageRun;
}

describe('currentAttemptFor', () => {
  it('is undefined when the stage recorded no stage run at all', () => {
    expect(currentAttemptFor([], 'uat', '2026-09-18T10:00:00.000Z')).toBeUndefined();
  });

  it('is undefined when every recorded run belongs to another stage', () => {
    expect(currentAttemptFor([run({ id: 1, stageKey: 'review' })], 'uat', undefined)).toBeUndefined();
  });

  it('names the newest run of the stage when the stage entry predates it', () => {
    const runs = [
      run({ id: 1, startedAt: '2026-09-18T10:00:00.000Z' }),
      run({ id: 2, startedAt: '2026-09-18T12:00:00.000Z' }),
    ];
    expect(currentAttemptFor(runs, 'uat', '2026-09-18T11:59:00.000Z')).toBe('sr:2');
  });

  it('picks the newest run by id, never by array position', () => {
    const runs = [
      run({ id: 2, startedAt: '2026-09-18T12:00:00.000Z' }),
      run({ id: 1, startedAt: '2026-09-18T10:00:00.000Z' }),
    ];
    expect(currentAttemptFor(runs, 'uat', undefined)).toBe('sr:2');
  });

  it('is null when the stage was re-entered after its newest recorded run — round 2 with nothing recorded', () => {
    const runs = [run({ id: 1, startedAt: '2026-09-18T10:00:00.000Z' })];
    // The fix landed and `entryPatch` re-entered uat at 13:00.
    expect(currentAttemptFor(runs, 'uat', '2026-09-18T13:00:00.000Z')).toBeNull();
  });

  it('names the run when the stage entry is exactly the run start (same-instant open)', () => {
    const runs = [run({ id: 4, startedAt: '2026-09-18T13:00:00.000Z' })];
    expect(currentAttemptFor(runs, 'uat', '2026-09-18T13:00:00.000Z')).toBe('sr:4');
  });

  it('names the newest run when the stage row carries no entry stamp', () => {
    const runs = [run({ id: 7 })];
    expect(currentAttemptFor(runs, 'uat', undefined)).toBe('sr:7');
  });
});
