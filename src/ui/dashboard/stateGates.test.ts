import { describe, expect, it } from 'vitest';
import type { GateAttemptView } from '../../model/inside/rounds.js';
import type { StepperCell } from '../../model/stepper.js';
import type { GateRun } from '../../store/gateRuns.js';
import type { RecoveryRound } from '../../store/recoveryRounds.js';
import { attemptSwitcherFor, buildGateSwitches } from './stateGates.js';
import { CASE_API, buildCaseViews, caseTime as t, type CaseFacts } from './insideCaseFacts.js';
import type { ShipRepoStepEvidence } from '../../store/shipRuns.js';

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

describe('buildGateSwitches: the Ship round tabs (T1410)', () => {
  const note = (kind: 'ci' | 'conflicts', n: number, max: number, at: string) => ({ kind, n, max, at });
  const live = { kind: 'ci' as const, repo: CASE_API, pr: 88, check: 'lint', used: 1, max: 3 };
  const push = (startedAt: string): ShipRepoStepEvidence => ({
    id: 1, shipRunId: 1, repo: CASE_API, step: 'push', status: 'passed', detail: '1 commit',
    prNumber: 88, existedBeforeShip: true, processRunId: null, operationIntentId: null,
    startedAt, endedAt: t(46), hasIntent: true, number: 88,
  });
  const facts = (
    selection?: CaseFacts['attemptSelection'],
    notes = [note('conflicts', 1, 2, t(40)), note('ci', 1, 3, t(50))],
    liveRound: typeof live | null = live,
  ): CaseFacts => ({
    cells: { ship: { status: 'running' } },
    shipRoundFacts: { attempts: notes, liveRound, spent: null, deliverRuns: [] },
    shipEvidence: { run: undefined, repos: { [CASE_API]: { steps: { push: push(t(45)) }, commits: [], intents: {} } } },
    autofix: {
      state: 'running',
      message: 'CI lint on api #88 · round 2 of 3',
      attempts: [],
      steps: [
        { label: 'fetch CI log', detail: 'gh · lint', status: 'pass' },
        { label: 'agent fix', detail: 'round 2', status: 'run', stopAfter: true },
      ],
      stopAfterRequested: false,
    },
    ciOpen: true,
    ...(selection ? { attemptSelection: selection } : {}),
  });
  const shipOf = (selection?: CaseFacts['attemptSelection'], notes?: ReturnType<typeof note>[], liveRound?: typeof live | null) =>
    buildCaseViews(facts(selection, notes, liveRound)).ship;
  const process = (id: string, view: ReturnType<typeof shipOf>) =>
    view.processes.find((p) => p.id === id);
  const rowsOf = (id: string, view: ReturnType<typeof shipOf>) => {
    const evidence = process(id, view)?.evidence;
    return evidence?.kind === 'rows' ? evidence.rows : [];
  };

  it('builds one tab sequence across both kinds and keeps the default ledger on the latest round', () => {
    const view = shipOf();
    expect(view.attempts?.map((a) => [a.label, a.tag, a.status, a.tail])).toEqual([
      ['R1', 'conflict', 'note', 'of 2'],
      ['R2', 'CI', 'run', 'of 2 · live'],
    ]);
    expect(view.selectedAttempt).toBe(`ship:${t(50)}`);
    // The default (latest) selection keeps today's ledger: the live steps, the recorded push, and the Merge row.
    expect(rowsOf('autofix', view).map((r) => r.label)).toEqual(['fetch CI log', 'agent fix']);
    expect(rowsOf('push', view)).toHaveLength(1);
    expect(process('commit', view)).toBeDefined();
    expect(process('pr', view)).toBeDefined();
  });

  it('filters Auto-fix, Push and Merge to a historical round, and leaves Commit and Pull request alone', () => {
    const notes = [note('ci', 1, 3, t(40)), note('ci', 2, 3, t(50))];
    const selection = { ship: `ship:${t(40)}` } as const;
    const view = shipOf(selection, notes, live);
    expect(view.selectedAttempt).toBe(selection.ship);
    expect(view.attemptCaption).toBe('CI round 1 of 3 · opened by a failing check');
    // The round's own arm row, the push in its window, and the result its record holds.
    expect(rowsOf('autofix', view)).toEqual([
      expect.objectContaining({ label: 'round 1', status: 'note' }),
    ]);
    expect(rowsOf('push', view)).toEqual([
      expect.objectContaining({ label: 'api', status: 'pass' }),
    ]);
    expect(rowsOf('merge', view)).toEqual([
      expect.objectContaining({ label: 'CI', detail: 'CI still failed', status: 'fail' }),
    ]);
    // Commit and Pull request stay; the round reads in time order: arm, push, CI.
    expect(view.processes.map((p) => p.id)).toEqual(['commit', 'pr', 'autofix', 'push', 'merge']);
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
