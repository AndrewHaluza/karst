import { describe, expect, it } from 'vitest';
import type { GateAttemptView } from '../../model/inside/rounds.js';
import type { StepperCell } from '../../model/stepper.js';
import type { GateRun } from '../../store/gateRuns.js';
import type { RecoveryRound } from '../../store/recoveryRounds.js';
import { attemptSwitcherFor, buildGateSwitches } from './stateGates.js';

const attempt = (over: Partial<GateAttemptView> & { key: string }): GateAttemptView =>
  ({ label: 'R1', tail: 'of 2', status: 'fail', statusLabel: 'Failed', latest: false, ...over }) as GateAttemptView;

describe('attemptSwitcherFor: the caption and the warning are separate facts', () => {
  const attempts = [
    attempt({ key: 'a', label: 'R1', caption: '30.0s' }),
    attempt({
      key: 'b',
      label: 'R2',
      latest: true,
      caption: 'opened by gate failure · 48.0s',
      warning: 'no fix attempts left',
    }),
  ];

  it('carries a settled round’s caption and its exhaustion warning apart', () => {
    const { view } = attemptSwitcherFor(attempts, 'b', false);
    expect(view?.attemptCaption).toBe('opened by gate failure · 48.0s');
    expect(view?.attemptNote).toBe('no fix attempts left');
  });

  it('gives a plain round caption no note at all', () => {
    const { view } = attemptSwitcherFor(attempts, 'a', false);
    expect(view?.attemptCaption).toBe('30.0s');
    expect(view?.attemptNote).toBeUndefined();
  });

  it('has neither when the round says nothing', () => {
    const quiet = [attempt({ key: 'a' }), attempt({ key: 'b', latest: true })];
    const { view } = attemptSwitcherFor(quiet, 'a', false);
    expect(view?.attemptCaption).toBeUndefined();
    expect(view?.attemptNote).toBeUndefined();
  });

  it('yields no view for an un-looped stage', () => {
    expect(attemptSwitcherFor([attempts[0]!], undefined, false).view).toBeUndefined();
  });
});

describe('buildGateSwitches: the attention band', () => {
  const gateRun = (id: number, stageRunId: number, over: Partial<GateRun> = {}): GateRun =>
    ({
      id,
      ticketId: 1,
      stageKey: 'review',
      attempt: stageRunId - 1,
      stageRunId,
      runAt: `2026-09-18T09:0${stageRunId}:00.000Z`,
      gateName: 'review',
      exitCode: 1,
      startedAt: `2026-09-18T09:0${stageRunId}:00.000Z`,
      endedAt: `2026-09-18T09:0${stageRunId}:30.000Z`,
      repo: null,
      command: null,
      args: null,
      skipped: false,
      summary: null,
      ...over,
    }) as GateRun;

  const supersedingRound = (): RecoveryRound =>
    ({
      id: 1,
      ticketId: 1,
      interruptCount: 0,
      fixCommitSha: null,
      noChangeReason: null,
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
      status: 'fixing',
      startedAt: '2026-09-18T10:06:00.000Z',
      endedAt: null,
    }) as RecoveryRound;

  /** R1's own exhausted round — what makes its tab carry the warning. */
  const exhaustedRound = (): RecoveryRound =>
    ({
      ...supersedingRound(),
      id: 2,
      sourceStage: 'review',
      sourceStageRunId: 1,
      status: 'exhausted',
      endedAt: '2026-09-18T09:09:00.000Z',
    }) as RecoveryRound;

  const cell = (stageKey: 'uat' | 'review', over: Partial<StepperCell> = {}): StepperCell => ({
    stageKey,
    status: 'failed',
    startedAt: '2026-09-18T09:00:00.000Z',
    endedAt: '2026-09-18T10:05:00.000Z',
    ...over,
  });

  /** Two settled review attempts, R1 (exhausted or not) selected, while uat fixes. */
  const reviewSwitcher = (warning: boolean, round: boolean) =>
    buildGateSwitches({
      ticket: { stageCurrent: 'uat' },
      rounds: [...(warning ? [exhaustedRound()] : []), ...(round ? [supersedingRound()] : [])],
      gateRuns: [gateRun(1, 1), gateRun(2, 2)],
      processRuns: [],
      cellOf: (key) => (key === 'review' ? cell('review') : cell('uat', { status: 'running', endedAt: undefined })),
      stageRuns: [],
      attemptSelection: { review: 'sr:1' },
    }).reviewRoundSwitcher;

  it('keeps an exhausted round’s warning over the superseded note, beside its caption', () => {
    const switcher = reviewSwitcher(true, true);
    expect(switcher).toMatchObject({
      attemptCaption: '30.0s',
      attemptNote: 'no fix attempts left',
      selectedAttempt: 'sr:1',
    });
  });

  it('leaves a plain caption out of the band, so the superseded note shows', () => {
    const switcher = reviewSwitcher(false, true);
    expect(switcher).toMatchObject({
      attemptCaption: '30.0s',
      attemptNote: 'round 1 is fixing — this result predates that fix, and this stage re-runs',
    });
  });

  it('renders no band at all when nothing is exhausted or superseded', () => {
    const switcher = reviewSwitcher(false, false);
    expect(switcher).toMatchObject({ attemptCaption: '30.0s' });
    expect((switcher as { attemptNote?: string }).attemptNote).toBeUndefined();
  });
});
