import { describe, it, expect } from 'vitest';
import type { GateRun } from '../../store/gateRuns.js';
import type { ProcessRun } from '../../store/processRuns.js';
import type { RecoveryRound } from '../../store/recoveryRounds.js';
import type { StageKey } from '../types.js';
import {
  ATTEMPT_TABS_LIMIT,
  attemptKey,
  batchForAttempt,
  latestAttemptKey,
  listGateAttempts,
  processRunForAttempt,
  roundsForAttempt,
} from './rounds.js';

let nextGateId = 1;
function gate(
  stageKey: StageKey,
  gateName: string,
  exitCode: number | null,
  extra: Partial<GateRun> = {},
): GateRun {
  return {
    id: nextGateId++,
    ticketId: 1,
    stageKey,
    attempt: 0,
    stageRunId: null,
    runAt: '2026-07-20T12:00:00.000Z',
    gateName,
    exitCode,
    startedAt: null,
    endedAt: null,
    repo: null,
    command: null,
    args: null,
    skipped: false,
    summary: null,
    ...extra,
  };
}

let nextRunId = 1;
function processRun(extra: Partial<ProcessRun> = {}): ProcessRun {
  return {
    id: nextRunId++,
    ticketId: 1,
    stageKey: 'uat',
    processId: 'tester',
    attempt: 0,
    stageRunId: null,
    agentName: null,
    provider: null,
    model: null,
    pid: null,
    status: 'passed',
    resultKind: 'observed',
    artifactPath: null,
    promptTelemetry: null,
    startedAt: '2026-07-20T12:00:00.000Z',
    endedAt: '2026-07-20T12:01:00.000Z',
    ...extra,
  };
}

let nextRoundId = 1;
function round(extra: Partial<RecoveryRound> = {}): RecoveryRound {
  return {
    id: nextRoundId++,
    ticketId: 1,
    interruptCount: 0,
    sourceStage: 'uat',
    sourceProcessId: 'gates',
    sourceStageRunId: null,
    sourceProcessRunId: null,
    triggerKind: 'gate-failure',
    triggerDetail: 'exit 1',
    episode: 1,
    round: 1,
    maxRounds: 3,
    fixProcessRunId: null,
    uatRevalidationStageRunId: null,
    reviewRevalidationStageRunId: null,
    status: 'pending',
    startedAt: '2026-07-20T12:00:00.000Z',
    endedAt: null,
    ...extra,
  };
}

describe('attemptKey', () => {
  it('keys by stage run id when present', () => {
    expect(attemptKey(42, '2026-07-20T12:00:00.000Z')).toBe('sr:42');
  });

  it('falls back to the batch stamp for a legacy row with no stage run id', () => {
    expect(attemptKey(null, '2026-07-20T12:00:00.000Z')).toBe('ra:2026-07-20T12:00:00.000Z');
  });

  it('treats undefined the same as null', () => {
    expect(attemptKey(undefined, '2026-07-20T12:00:00.000Z')).toBe(
      'ra:2026-07-20T12:00:00.000Z',
    );
  });
});

describe('listGateAttempts', () => {
  it('emits no tabs for a stage with zero attempts', () => {
    const views = listGateAttempts({
      gateRuns: [],
      processRuns: [],
      rounds: [],
      stageKey: 'uat',
      running: false,
    });
    expect(views).toEqual([]);
  });

  it('emits no tabs for a single-attempt stage', () => {
    const runs = [gate('uat', 'lint', 0, { stageRunId: 1, runAt: 't1' })];
    const views = listGateAttempts({
      gateRuns: runs,
      processRuns: [],
      rounds: [],
      stageKey: 'uat',
      running: false,
    });
    expect(views).toEqual([]);
  });

  it('orders attempts oldest to newest by runAt, never by array position', () => {
    // Deliberately inserted out of chronological order.
    const runs = [
      gate('uat', 'lint', 0, { stageRunId: 2, runAt: '2026-07-20T12:10:00.000Z' }),
      gate('uat', 'lint', 1, { stageRunId: 1, runAt: '2026-07-20T12:00:00.000Z' }),
    ];
    const views = listGateAttempts({
      gateRuns: runs,
      processRuns: [],
      rounds: [],
      stageKey: 'uat',
      running: false,
    });
    expect(views.map((v) => v.key)).toEqual(['sr:1', 'sr:2']);
  });

  it('labels the newest attempt latest, or live while running', () => {
    const runs = [
      gate('uat', 'lint', 1, { stageRunId: 1, runAt: '2026-07-20T12:00:00.000Z' }),
      gate('uat', 'lint', 0, { stageRunId: 2, runAt: '2026-07-20T12:10:00.000Z' }),
    ];
    const notRunning = listGateAttempts({
      gateRuns: runs,
      processRuns: [],
      rounds: [],
      stageKey: 'uat',
      running: false,
    });
    expect(notRunning[notRunning.length - 1]!.label).toBe('latest');
    expect(notRunning[notRunning.length - 1]!.latest).toBe(true);

    const runningViews = listGateAttempts({
      gateRuns: runs,
      processRuns: [],
      rounds: [],
      stageKey: 'uat',
      running: true,
    });
    expect(runningViews[runningViews.length - 1]!.label).toBe('live');
  });

  it('labels a non-latest, non-round attempt by ordinal', () => {
    const runs = [
      gate('uat', 'lint', 1, { stageRunId: 1, runAt: '2026-07-20T12:00:00.000Z' }),
      gate('uat', 'lint', 1, { stageRunId: 2, runAt: '2026-07-20T12:05:00.000Z' }),
      gate('uat', 'lint', 0, { stageRunId: 3, runAt: '2026-07-20T12:10:00.000Z' }),
    ];
    const views = listGateAttempts({
      gateRuns: runs,
      processRuns: [],
      rounds: [],
      stageKey: 'uat',
      running: false,
    });
    expect(views[0]!.label).toBe('attempt 1');
    expect(views[1]!.label).toBe('attempt 2');
    expect(views[2]!.label).toBe('latest');
  });

  it('labels the attempt that opened a round from sourceStageRunId', () => {
    const runs = [
      gate('uat', 'lint', 1, { stageRunId: 1, runAt: '2026-07-20T12:00:00.000Z' }),
      gate('uat', 'lint', 0, { stageRunId: 2, runAt: '2026-07-20T12:10:00.000Z' }),
    ];
    const rounds = [round({ sourceStage: 'uat', sourceStageRunId: 1, round: 1 })];
    const views = listGateAttempts({
      gateRuns: runs,
      processRuns: [],
      rounds,
      stageKey: 'uat',
      running: false,
    });
    // One naming series: the attempt's own position, with the round it opened
    // as a suffix — a round number is not a position (only a failing attempt
    // opens one), so the two must never look like the same counter.
    expect(views[0]!.label).toBe('attempt 1 · R1');
    expect(views[0]!.round).toBe(1);
    expect(views[1]!.label).toBe('latest');
  });

  it('derives fail/pass status per attempt from its own batch', () => {
    const runs = [
      gate('uat', 'lint', 1, { stageRunId: 1, runAt: '2026-07-20T12:00:00.000Z' }),
      gate('uat', 'lint', 0, { stageRunId: 2, runAt: '2026-07-20T12:10:00.000Z' }),
    ];
    const views = listGateAttempts({
      gateRuns: runs,
      processRuns: [],
      rounds: [],
      stageKey: 'uat',
      running: false,
    });
    expect(views[0]!.status).toBe('fail');
    expect(views[1]!.status).toBe('pass');
  });

  it('bounds to the newest ATTEMPT_TABS_LIMIT attempts', () => {
    const runs = Array.from({ length: ATTEMPT_TABS_LIMIT + 5 }, (_, i) =>
      gate('uat', 'lint', 0, {
        stageRunId: i + 1,
        runAt: `2026-07-20T12:${String(i).padStart(2, '0')}:00.000Z`,
      }),
    );
    const views = listGateAttempts({
      gateRuns: runs,
      processRuns: [],
      rounds: [],
      stageKey: 'uat',
      running: false,
    });
    expect(views).toHaveLength(ATTEMPT_TABS_LIMIT);
    // The kept attempts are the NEWEST ones — the highest stage run ids.
    expect(views[0]!.key).toBe(`sr:6`);
    expect(views[views.length - 1]!.key).toBe(`sr:${ATTEMPT_TABS_LIMIT + 5}`);
  });

  it('carries the time of the attempt earliest recorded start', () => {
    const runs = [
      gate('uat', 'lint', 0, {
        stageRunId: 1,
        runAt: 't1',
        startedAt: '2026-07-20T12:00:00.000Z',
      }),
      gate('uat', 'test', 0, {
        stageRunId: 1,
        runAt: 't1',
        startedAt: '2026-07-20T12:00:05.000Z',
      }),
      gate('uat', 'lint', 0, { stageRunId: 2, runAt: 't2' }),
    ];
    const views = listGateAttempts({
      gateRuns: runs,
      processRuns: [],
      rounds: [],
      stageKey: 'uat',
      running: false,
    });
    expect(views[0]!.time).toBeTruthy();
    expect(views[1]!.time).toBeUndefined();
  });
});

describe('batchForAttempt', () => {
  it('reproduces the existing latest-only behaviour for key === null', () => {
    const older = gate('uat', 'lint', 1, { runAt: '2026-07-20T12:00:00.000Z' });
    const newer = gate('uat', 'lint', 0, { runAt: '2026-07-20T12:10:00.000Z' });
    const result = batchForAttempt([older, newer], 'uat', null);
    expect(result).toEqual([newer]);
  });

  it('returns the batch for an explicit attempt key', () => {
    const a = gate('uat', 'lint', 1, { stageRunId: 1, runAt: 't1' });
    const b = gate('uat', 'lint', 0, { stageRunId: 2, runAt: 't2' });
    const result = batchForAttempt([a, b], 'uat', 'sr:1');
    expect(result).toEqual([a]);
  });

  it('degrades to empty for an unknown key rather than throwing', () => {
    const a = gate('uat', 'lint', 1, { stageRunId: 1, runAt: 't1' });
    expect(() => batchForAttempt([a], 'uat', 'sr:999')).not.toThrow();
    expect(batchForAttempt([a], 'uat', 'sr:999')).toEqual([]);
  });

  it('never includes another stage key', () => {
    const a = gate('uat', 'lint', 1, { stageRunId: 1, runAt: 't1' });
    const b = gate('review', 'lint', 1, { stageRunId: 1, runAt: 't1' });
    expect(batchForAttempt([a, b], 'uat', 'sr:1')).toEqual([a]);
  });
});

describe('processRunForAttempt', () => {
  it('reproduces the existing latest-run behaviour for key === null', () => {
    const older = processRun({ processId: 'tester', id: 1 });
    const newer = processRun({ processId: 'tester', id: 2 });
    expect(processRunForAttempt([older, newer], 'tester', null)).toEqual(newer);
  });

  it('resolves the run whose stage run id matches the attempt key', () => {
    const a = processRun({ processId: 'tester', stageRunId: 1 });
    const b = processRun({ processId: 'tester', stageRunId: 2 });
    expect(processRunForAttempt([a, b], 'tester', 'sr:1')).toEqual(a);
  });

  it('degrades to undefined for an unknown key rather than throwing', () => {
    const a = processRun({ processId: 'tester', stageRunId: 1 });
    expect(() => processRunForAttempt([a], 'tester', 'sr:999')).not.toThrow();
    expect(processRunForAttempt([a], 'tester', 'sr:999')).toBeUndefined();
  });

  it('never matches a legacy run with no stage run id against a real key', () => {
    const a = processRun({ processId: 'tester', stageRunId: null });
    expect(processRunForAttempt([a], 'tester', 'sr:1')).toBeUndefined();
  });
});

/**
 * Review round 1 (two high, two medium findings): the selectors had two ways
 * to disagree with the latest-only reads they must reproduce.
 */
describe('review fixes — the latest attempt is the default path', () => {
  it('keeps one attempt per stage run to its NEWEST batch, like latestBatch', () => {
    // One stage run that recorded two batches (a re-run inside the same
    // invocation). `latestBatch` would return the newer batch alone; the
    // attempt must not show both, or the latest tab renders more gate rows
    // than the default view of the very same evidence.
    const older = gate('uat', 'test', 1, { stageRunId: 7, runAt: '2026-07-20T12:00:00.000Z' });
    const newer = gate('uat', 'test', 0, { stageRunId: 7, runAt: '2026-07-20T12:30:00.000Z' });
    expect(batchForAttempt([older, newer], 'uat', 'sr:7')).toEqual([newer]);
  });

  it('names the latest attempt key from the attempt series, not an arbitrary row', () => {
    const a = gate('uat', 'test', 1, { stageRunId: 1, runAt: '2026-07-20T12:00:00.000Z' });
    const b = gate('uat', 'lint', 0, { stageRunId: 2, runAt: '2026-07-20T13:00:00.000Z' });
    const c = gate('uat', 'test', 0, { stageRunId: 2, runAt: '2026-07-20T13:00:00.000Z' });
    expect(latestAttemptKey([a, b, c], 'uat')).toBe('sr:2');
    expect(latestAttemptKey([], 'uat')).toBeNull();
  });

  it('reads the latest attempt key back as the same batch latestBatch returns', () => {
    const a = gate('uat', 'test', 1, { stageRunId: 1, runAt: '2026-07-20T12:00:00.000Z' });
    const b = gate('uat', 'test', 0, { stageRunId: 2, runAt: '2026-07-20T13:00:00.000Z' });
    const key = latestAttemptKey([a, b], 'uat');
    expect(batchForAttempt([a, b], 'uat', key)).toEqual(batchForAttempt([a, b], 'uat', null));
  });
});

describe('roundsForAttempt', () => {
  it('keeps only the rounds the selected attempt opened', () => {
    const first = round({ sourceStageRunId: 1, round: 1, status: 'passed' });
    const second = round({ sourceStageRunId: 2, round: 2, status: 'fixing' });
    expect(roundsForAttempt([first, second], 'uat', 'sr:1', 'sr:3')).toEqual([first]);
  });

  it('gives a live attempt that has opened no round nothing at all', () => {
    const first = round({ sourceStageRunId: 1, round: 1, status: 'revalidating' });
    expect(roundsForAttempt([first], 'uat', 'sr:2', 'sr:2')).toEqual([]);
  });

  it('scopes the default selection to the latest attempt', () => {
    const first = round({ sourceStageRunId: 1, round: 1, status: 'revalidating' });
    expect(roundsForAttempt([first], 'uat', null, 'sr:2')).toEqual([]);
    expect(roundsForAttempt([first], 'uat', null, 'sr:1')).toEqual([first]);
  });

  it('ignores rounds another stage opened', () => {
    const mine = round({ sourceStage: 'uat', sourceStageRunId: 1 });
    const other = round({ sourceStage: 'review', sourceStageRunId: 1 });
    expect(roundsForAttempt([mine, other], 'uat', 'sr:1', 'sr:1')).toEqual([mine]);
  });

  it('keeps a legacy round with no stage run id on the latest attempt only', () => {
    const legacy = round({ sourceStageRunId: null });
    expect(roundsForAttempt([legacy], 'uat', 'sr:2', 'sr:2')).toEqual([legacy]);
    expect(roundsForAttempt([legacy], 'uat', 'sr:1', 'sr:2')).toEqual([]);
  });

  it('keeps every stage round when the stage recorded no attempt to key by', () => {
    const legacy = round({ sourceStageRunId: null });
    expect(roundsForAttempt([legacy], 'uat', null, null)).toEqual([legacy]);
  });
});

describe('listGateAttempts: the live attempt with no recorded rows', () => {
  it('adds a synthetic newest tab for a current attempt no group holds', () => {
    const attempts = listGateAttempts({
      gateRuns: [gate('uat', 'lint', 1, { stageRunId: 1, runAt: '2026-09-18T10:00:00.000Z' })],
      processRuns: [],
      rounds: [],
      stageKey: 'uat',
      running: true,
      currentAttempt: 'sr:2',
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ key: 'sr:1', status: 'fail', latest: false });
    expect(attempts[1]).toMatchObject({ key: 'sr:2', label: 'live', status: 'run', latest: true });
    expect(attempts[1]!.time).toBeUndefined();
  });

  it('reads the live tab as pending when the stage is not running', () => {
    const attempts = listGateAttempts({
      gateRuns: [gate('uat', 'lint', 1, { stageRunId: 1, runAt: '2026-09-18T10:00:00.000Z' })],
      processRuns: [],
      rounds: [],
      stageKey: 'uat',
      running: false,
      currentAttempt: 'sr:2',
    });
    expect(attempts[1]).toMatchObject({ key: 'sr:2', label: 'latest', status: 'pending', statusLabel: 'pending' });
  });

  it('adds nothing when the current attempt already has recorded rows', () => {
    const attempts = listGateAttempts({
      gateRuns: [
        gate('uat', 'lint', 1, { stageRunId: 1, runAt: '2026-09-18T10:00:00.000Z' }),
        gate('uat', 'lint', 0, { stageRunId: 2, runAt: '2026-09-18T12:00:00.000Z' }),
      ],
      processRuns: [],
      rounds: [],
      stageKey: 'uat',
      running: false,
      currentAttempt: 'sr:2',
    });
    expect(attempts.map((a) => a.key)).toEqual(['sr:1', 'sr:2']);
  });

  it('emits no tabs for a single recorded attempt when no current attempt is given', () => {
    const attempts = listGateAttempts({
      gateRuns: [gate('uat', 'lint', 1, { stageRunId: 1, runAt: '2026-09-18T10:00:00.000Z' })],
      processRuns: [],
      rounds: [],
      stageKey: 'uat',
      running: false,
    });
    expect(attempts).toEqual([]);
  });
});
