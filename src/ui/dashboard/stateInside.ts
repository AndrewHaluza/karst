import type { Severity } from '../../manifest/types.js';
import { displayStatus, type StepperCell } from '../../model/stepper.js';
import type { StageKey } from '../../model/types.js';
import type { GateStage } from '../../store/ticketGates.js';
import type { WorktreeView } from '../../store/dashboard.js';
import type { ProcessRun } from '../../store/processRuns.js';
import type { ImplementationTimeline } from '../../store/implementationRuns.js';
import type { PhaseMark } from '../../store/phaseMarks.js';
import {
  dotFor,
  formatClock,
  STAGE_BLURBS,
  STAGE_TITLES,
  type InsideEvidenceTarget,
  type InsideLiveView,
  type InsideProcessView,
  type InsideStageKey,
  type InsideStageView,
  type TypedInsideAction,
} from '../../model/inside/types.js';
import { scopeProcesses, implementationSessionProcess } from '../../model/inside/index.js';
import { uatProcesses, reviewProcesses, type QualityProcessesInput } from '../../model/inside/gates.js';
import type { AttemptKey, GateAttemptView } from '../../model/inside/rounds.js';
import type { CurrentAttempt } from '../../model/inside/currentAttempt.js';
import { shipProcesses, type ShipProcessesInput } from '../../model/inside/ship.js';
import { doneReceipt, type DoneReceiptInput, type DoneReceiptView } from '../../model/inside/done.js';
import type {
  SegmentTokensInput,
  SessionConfiguredInput,
  SessionTokensInput,
} from '../../model/inside/agent.js';

/** The round switcher's tabs/effective selection, as `state.ts` resolves them. */
export interface AttemptSwitchView {
  attempts: readonly GateAttemptView[];
  selectedAttempt: AttemptKey;
  attemptNote?: string;
}

/**
 * One gate stage's round-switcher result: the effective selection restricting
 * the ledger, plus the view the stage shell renders (absent when the stage holds
 * fewer than two recorded attempts).
 */
export interface AttemptSwitch {
  selectedKey: AttemptKey | null;
  view?: AttemptSwitchView;
}

/** The `stageView` roundSwitcher argument, resolved by `state.ts` via `withNote`. */
export type RoundSwitcherArg = Parameters<typeof stageView>[5];

/**
 * Everything the six-stage inside presentation reads from ONE snapshot. All of
 * it is computed host-side by `buildDashboardState` — one read per evidence
 * table, shared by every view that renders it — and passed in so this module
 * stays a pure projection (no store access of its own).
 */
export interface InsideViewsInput {
  cellOf: (key: StageKey) => StepperCell;
  selectedRepos: readonly string[];
  worktrees: readonly WorktreeView[];
  /** The ticket's own `agent_state === 'waiting'` — the agent asked a question. */
  agentWaiting: boolean;
  now: string;
  processRuns: readonly ProcessRun[];
  timeline: ImplementationTimeline | null;
  /** Per-segment measured spend, straight from the ledger's own GROUP BY. */
  segmentTokens: readonly SegmentTokensInput[];
  marks: readonly PhaseMark[];
  assignmentFor: (processId: 'session' | 'tester' | 'review') => SessionConfiguredInput | null;
  tokensFor: (processId: string) => SessionTokensInput | null;
  attach: (target: InsideEvidenceTarget) => TypedInsideAction | undefined;
  gateRuns: QualityProcessesInput['gateRuns'];
  findings: QualityProcessesInput['findings'];
  uatFindings: QualityProcessesInput['uatFindings'];
  rounds: QualityProcessesInput['rounds'];
  services: readonly string[];
  resolvedGates?: {
    uat: readonly { name: string; disabled: boolean }[];
    review: readonly { name: string; disabled: boolean }[];
  };
  findingsRepoSelection?: Partial<Record<'uat' | 'review', string>>;
  repoNameFor: (repo: string) => string | undefined;
  graphInsideProcessOnce: InsideProcessView | null;
  uatSwitch: AttemptSwitch;
  reviewSwitch: AttemptSwitch;
  uatRoundSwitcher: RoundSwitcherArg;
  reviewRoundSwitcher: RoundSwitcherArg;
  uatCurrent: CurrentAttempt;
  reviewCurrent: CurrentAttempt;
  shipEvidence: ShipProcessesInput['evidence'];
  prs: ShipProcessesInput['prs'];
  mergeChecks: ShipProcessesInput['mergeChecks'];
  shipFindings: ShipProcessesInput['findings'];
  findingsBlockingSeverity: Severity | 'none';
  stepper: readonly StepperCell[];
  recordedTotal: NonNullable<DoneReceiptInput['tokens']>;
  roleTokens: DoneReceiptInput['roles'];
  stageCurrent: string | null;
}

/**
 * The console (terminal detailed mode) is offered for a gate stage with
 * something to show: a recorded artifact log, OR a run in flight — the gate
 * lane streams live (`GateConsole`), and gating on the artifact alone hid
 * the console for exactly the window the live preview exists to cover.
 * Never for a stage that never ran, and never for non-gate stages (UI-R31:
 * availability is host-derived).
 */
function consoleFor(key: GateStage, cellOf: (key: StageKey) => StepperCell): boolean {
  return !!cellOf(key).artifactPath || displayStatus(cellOf(key)) === 'running';
}

/**
 * The six-stage inside presentation (the inside redesign): one process-led view
 * per INSIDE stage, built by the pure reducers. `fix` is not a stage here — it
 * is projected onto the stage it returns to (`presentedStage`) — so this map has
 * EXACTLY six keys and never a peer `fix` entry.
 */
export function buildInsideViews(input: InsideViewsInput): Record<InsideStageKey, InsideStageView> {
  const {
    cellOf,
    selectedRepos,
    worktrees,
    agentWaiting,
    now,
    processRuns,
    timeline,
    segmentTokens,
    marks,
    assignmentFor,
    tokensFor,
    attach,
    gateRuns,
    findings,
    uatFindings,
    rounds,
    services,
    resolvedGates,
    findingsRepoSelection,
    repoNameFor,
    graphInsideProcessOnce,
    uatSwitch,
    reviewSwitch,
    uatRoundSwitcher,
    reviewRoundSwitcher,
    uatCurrent,
    reviewCurrent,
    shipEvidence,
    prs,
    mergeChecks,
    shipFindings,
    findingsBlockingSeverity,
    stepper,
    recordedTotal,
    roleTokens,
    stageCurrent,
  } = input;

  const insideViews: Record<InsideStageKey, InsideStageView> = {
    scope: stageView(
      'scope',
      cellOf('scope'),
      scopeProcesses(cellOf('scope'), selectedRepos, worktrees, now, processRuns, tokensFor('prefill')),
      now,
      undefined,
      undefined,
    ),
    impl: stageView(
      'impl',
      cellOf('impl'),
      [
        implementationSessionProcess(
          cellOf('impl'),
          timeline,
          marks,
          assignmentFor('session'),
          tokensFor('session'),
          now,
          attach,
          // Per-segment measured spend, straight from the ledger's own
          // `implementation_segment_id` GROUP BY — the switch row's Σ pill
          // states what the segment it moved TO went on to cost. A run that
          // never opened has no segments and therefore no totals.
          segmentTokens,
          // The ticket's own `agent_state === 'waiting'` — the agent asked
          // the user a question and is blocked on the answer. Threaded in
          // explicitly, never re-derived: it is the same fact
          // `cli/stage.ts`'s `assertMarkerNotWhileWaiting` refuses the done
          // marker on.
          agentWaiting,
        ),
        // The graph runtime's read-only projection (Slice 2 Task 10):
        // appended when the host supplies it, inert otherwise. Computed once
        // — the guard and the spread previously each called
        // `graphInsideProcess`, building the whole projection twice and
        // discarding one.
        ...(graphInsideProcessOnce ? [graphInsideProcessOnce] : []),
      ],
      now,
      undefined,
      undefined,
    ),
    uat: stageView(
      'uat',
      cellOf('uat'),
      uatProcesses({
        cell: cellOf('uat'),
        gateRuns,
        findings: [],
        uatFindings,
        processRuns,
        rounds,
        services,
        now,
        configured: assignmentFor('tester'),
        tokens: tokensFor('tester'),
        attach,
        resolvedGates: resolvedGates?.uat ?? [],
        // The gate rows name the service the way Settings names it, never the
        // path the evidence table keys by — the same injection ship uses.
        repoNameFor,
        selectedAttempt: uatSwitch.selectedKey,
        currentAttempt: uatCurrent,
        findingsRepo: findingsRepoSelection?.uat ?? null,
      }),
      now,
      consoleFor('uat', cellOf),
      uatRoundSwitcher,
    ),
    review: stageView(
      'review',
      cellOf('review'),
      reviewProcesses({
        cell: cellOf('review'),
        gateRuns,
        findings,
        uatFindings: [],
        processRuns,
        rounds,
        services,
        now,
        configured: assignmentFor('review'),
        tokens: tokensFor('review'),
        attach,
        resolvedGates: resolvedGates?.review ?? [],
        repoNameFor,
        selectedAttempt: reviewSwitch.selectedKey,
        currentAttempt: reviewCurrent,
        findingsRepo: findingsRepoSelection?.review ?? null,
      }),
      now,
      consoleFor('review', cellOf),
      reviewRoundSwitcher,
    ),
    ship: stageView(
      'ship',
      cellOf('ship'),
      shipProcesses({
        cell: cellOf('ship'),
        evidence: shipEvidence,
        prs,
        mergeChecks,
        now,
        attach,
        // The ship rows name the repository, never the path the evidence
        // tables key by; the host resolves the manifest name (injected).
        repoNameFor,
        processRuns,
        tokens: tokensFor('pr-description'),
        findings: shipFindings,
        findingsBlockingSeverity,
      }),
      now,
      undefined,
      undefined,
    ),
    done: doneStageView(
      cellOf('done'),
      doneReceipt({
        stageCurrent: stageCurrent === 'done' ? 'done' : 'ship',
        ship: shipEvidence,
        prs,
        mergeChecks,
        gateRuns,
        rounds,
        // Fresh-gated for the same reason `tokensFor` is: the receipt's Σ
        // headlines fresh spend, so a ticket with only cache reads must state
        // the absence rather than render a clamped "0 recorded tokens".
        tokens: recordedTotal.total - recordedTotal.cacheRead > 0 ? recordedTotal : null,
        roles: roleTokens,
        // The done stage's own stamp — the hero's completion time. An
        // unstamped cell yields no time rather than a fabricated one.
        completedAt: cellOf('done').endedAt ?? cellOf('done').startedAt ?? null,
        now,
        attach,
        // The receipt's Timing strip sums the work stages' spans — the same
        // cells the strip's rail reads, so the receipt and the strip can
        // never disagree about how long a stage took.
        stages: stepper,
        repoNameFor,
      }),
      now,
    ),
  };
  return insideViews;
}

/**
 * The stage's CURRENT operation, derived from its own process rows: the first
 * running process, else the first waiting one. Nothing here is new information
 * — every field comes from a row already in the ledger below — which is what
 * makes it safe as the header's fallback when no ephemeral progress event has
 * arrived (a reopened panel, a window that missed the events). A settled stage
 * has no live line at all.
 */
function liveFor(processes: readonly InsideProcessView[]): InsideLiveView | undefined {
  const active =
    processes.find((p) => p.status === 'run') ?? processes.find((p) => p.status === 'wait');
  if (!active) return undefined;
  return {
    status: active.status === 'run' ? 'run' : 'wait',
    label: active.label,
    ...(active.detail ? { detail: active.detail } : {}),
    ...(active.duration ? { duration: active.duration } : {}),
  };
}

/** One inside stage's presentation shell around its ordered processes. */
function stageView(
  key: InsideStageKey,
  cell: StepperCell,
  processes: readonly InsideProcessView[],
  now: string,
  console?: boolean,
  /**
   * The round switcher's tabs/selection/banner for a gate stage (T4). Absent
   * for every non-gate stage, and for a gate stage with fewer than 2 recorded
   * attempts — `attemptSwitcherFor` in `buildDashboardState` already returns
   * no view in that case, so the control costs nothing on a ticket that never
   * looped.
   */
  roundSwitcher?:
    | { attempts: readonly GateAttemptView[]; selectedAttempt: AttemptKey; attemptNote?: string }
    | { attemptNote: string },
): InsideStageView {
  const live = liveFor(processes);
  return {
    stageKey: key,
    title: STAGE_TITLES[key as StageKey],
    dot: dotFor(cell),
    // A blocked stage is not doing anything: its elapsed span ends when the
    // park wrote the block (`blocked.at`), never at `now` — otherwise the
    // clock keeps growing beside the banner saying the stage is blocked.
    clock:
      cell.blocked && displayStatus(cell) === 'blocked'
        ? formatClock(cell, cell.blocked.at)
        : formatClock(cell, now),
    ...(live ? { live } : {}),
    processes: [...processes],
    blurb: STAGE_BLURBS[key as StageKey],
    // The key is carried for a gate stage whether or not it holds a log (an
    // explicit false beats an absent answer), and stays absent for a stage
    // that never got a console answer at all.
    ...(console !== undefined ? { console } : {}),
    ...(roundSwitcher ? roundSwitcher : {}),
  };
}

/**
 * The done stage's single process: the delivery receipt. Pending before every
 * current PR is merged (no future delivery evidence — that is the whole point
 * of the discriminated union); complete after, with the receipt's rows, hero
 * and blocks — the FULL evidence, never just the flat rows.
 */
function doneStageView(cell: StepperCell, receipt: DoneReceiptView, now: string): InsideStageView {
  const complete = receipt.status === 'complete';
  const process: InsideProcessView = {
    id: 'delivery-receipt',
    kind: 'delivery-receipt',
    label: 'Delivery receipt',
    status: complete ? 'pass' : 'wait',
    detail: receipt.detail,
    evidence: complete ? receipt.evidence : { kind: 'receipt', rows: [] },
  };
  return stageView('done', cell, [process], now);
}
