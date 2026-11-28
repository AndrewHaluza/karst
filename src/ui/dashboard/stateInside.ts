import type { ReviewStallDetection, Severity } from '../../manifest/types.js';
import type { GateLiveState } from '../../model/inside/gateWait.js';
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
  type InsideNowView,
  type InsideStageView,
  type TypedInsideAction,
} from '../../model/inside/types.js';
import { scopeProcesses, implementationSessionProcess } from '../../model/inside/index.js';
import {
  uatProcesses,
  reviewProcesses,
  type QualityProcessesInput,
  type ResolvedGate,
  type ServiceStatusView,
} from '../../model/inside/gates.js';
import type { AttemptKey, GateAttemptView } from '../../model/inside/rounds.js';
import { shipRoundLedger, shipRoundWindows, type ShipPushEvidence, type ShipRoundEvidenceFacts, type ShipRoundLedger } from '../../model/inside/shipRounds.js';
import type { AutofixAttempt, AutofixRound } from '../../model/inside/autofix.js';
import type { ShipSpentPark } from '../../model/inside/shipRounds.js';
import type { DeliverRun } from '../../store/deliverRuns.js';
import type { ShipEvidence, ShipRepoStepEvidence } from '../../store/shipRuns.js';
import type { CurrentAttempt } from '../../model/inside/currentAttempt.js';
import type { AutofixRowView } from '../../model/inside/autofix.js';
import type { DeliverRowInput } from '../../model/inside/shipDeliver.js';
import { shipProcesses, type ShipProcessesInput } from '../../model/inside/ship.js';
import type { ImplSessionReading } from '../../model/implSessionReading.js';
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
  /** Host-authored muted caption for the tab row (why the round opened, its duration). */
  attemptCaption?: string;
  /** Host-authored attention-band text: the fact the reader must act on. */
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
  /** The shared impl session reading, computed once in `state.ts`. */
  implSession?: ImplSessionReading | null;
  now: string;
  processRuns: readonly ProcessRun[];
  timeline: ImplementationTimeline | null;
  /** Per-segment measured spend, straight from the ledger's own GROUP BY. */
  segmentTokens: readonly SegmentTokensInput[];
  marks: readonly PhaseMark[];
  assignmentFor: (processId: 'session' | 'tester' | 'review') => SessionConfiguredInput | null;
  tokensFor: (processId: string) => SessionTokensInput | null;
  /** The ledger read for the exact process runs a row shows (@arch:AC-14). Wins over `tokensFor` for the round-scoped rows. */
  tokensForRuns?: (runs: readonly ProcessRun[]) => SessionTokensInput | null;
  attach: (target: InsideEvidenceTarget) => TypedInsideAction | undefined;
  gateRuns: QualityProcessesInput['gateRuns'];
  /** The host gate re-run rows (@arch:AC-45), listed after the gates batch. */
  hostRerunRuns?: QualityProcessesInput['gateRuns'];
  findings: QualityProcessesInput['findings'];
  uatFindings: QualityProcessesInput['uatFindings'];
  rounds: QualityProcessesInput['rounds'];
  /** The ticket's server rows, projected for UAT's Services process. */
  services: readonly ServiceStatusView[];
  resolvedGates?: {
    uat: readonly ResolvedGate[];
    review: readonly ResolvedGate[];
  };
  liveGates?: Readonly<Partial<Record<'uat' | 'review' | 'ship', Readonly<Record<string, GateLiveState>>>>>;
  findingsRepoSelection?: Partial<Record<'uat' | 'review', string>>;
  repoNameFor: (repo: string) => string | undefined;
  graphInsideProcessOnce: InsideProcessView | null;
  uatSwitch: AttemptSwitch;
  reviewSwitch: AttemptSwitch;
  shipSwitch?: AttemptSwitch;
  uatRoundSwitcher: RoundSwitcherArg;
  reviewRoundSwitcher: RoundSwitcherArg;
  shipRoundSwitcher?: RoundSwitcherArg;
  /** The Ship round facts the time-window join reads (T1410). */
  shipRounds?: {
    attempts: readonly AutofixAttempt[];
    liveRound: AutofixRound | null;
    spent: ShipSpentPark | null;
    deliverRuns: readonly DeliverRun[];
  };
  uatCurrent: CurrentAttempt;
  reviewCurrent: CurrentAttempt;
  shipEvidence: ShipProcessesInput['evidence'];
  prs: ShipProcessesInput['prs'];
  mergeChecks: ShipProcessesInput['mergeChecks'];
  shipFindings: ShipProcessesInput['findings'];
  findingsBlockingSeverity: Severity | 'none';
  /** The Merge row's auto-fix reading (T1004), or null. */
  autofix?: AutofixRowView | null;
  deliver?: DeliverRowInput | null;
  ciOpen?: boolean;
  ciWaiting?: boolean;
  ciNow?: InsideNowView | undefined;
  reviewBlockingSeverity?: Severity | 'none';
  testerBlockingSeverity?: Severity | 'none';
  reviewStallDetection?: ReviewStallDetection;
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
 * A recorded ship step's state, as the round evidence reads it. The mapping is
 * the one `ship.ts`'s `stepStatus` uses for the same rows.
 */
function shipStepStatus(step: ShipRepoStepEvidence): 'pass' | 'fail' | 'run' | 'note' {
  switch (step.status) {
    case 'passed': return 'pass';
    case 'failed': return 'fail';
    case 'running': return 'run';
    case 'note': return 'note';
  }
}

/** One auto-deliver run's state as a push row reads it: only a literal pass is green. */
function deliverRunStatus(run: DeliverRun): 'pass' | 'fail' | 'run' | 'note' {
  if (run.state === 'passed') return 'pass';
  if (run.state === 'failed') return 'fail';
  if (run.state === 'running') return 'run';
  return 'note';
}

/**
 * Every push a Ship round window can hold: the ship run's per-repo push steps,
 * then every recorded auto-deliver run. The window filter happens in
 * `shipRoundLedger`; this only states the recorded starts and outcomes.
 */
function shipPushes(
  evidence: ShipEvidence,
  deliverRuns: readonly DeliverRun[],
  repoNameFor: (repo: string) => string | undefined,
): ShipPushEvidence[] {
  const steps = Object.keys(evidence.repos).flatMap((repo): ShipPushEvidence[] => {
    const step = evidence.repos[repo]?.steps.push;
    if (!step?.startedAt) return [];
    return [{
      at: step.startedAt,
      label: repoNameFor(repo) ?? repo,
      ...(step.detail ? { detail: step.detail } : {}),
      status: shipStepStatus(step),
    }];
  });
  const runs = deliverRuns.flatMap((run): ShipPushEvidence[] => {
    if (!run.startedAt) return [];
    const sha = run.headSha ? ` · ${run.headSha.slice(0, 7)}` : '';
    return [{ at: run.startedAt, label: 'Push', detail: `gate run ${run.state}${sha}`, status: deliverRunStatus(run) }];
  });
  return [...steps, ...runs];
}

/**
 * The selected historical Ship round's own rows, or null on the default
 * (latest) path — which must keep the ledger exactly as it renders today.
 */
function historicalShipLedger(
  input: InsideViewsInput,
  now: string,
): ShipRoundLedger | null {
  const key = input.shipSwitch?.selectedKey ?? null;
  const round = input.shipSwitch?.view?.attempts.find((a) => a.key === key);
  const facts = input.shipRounds;
  if (key === null || round === undefined || facts === undefined) return null;
  const window = shipRoundWindows({ attempts: facts.attempts, now }).find((w) => w.key === key);
  // The key IS `ship:<note time>`; a key no note holds is a stale selection.
  const attempt = facts.attempts.find((a) => (`ship:${a.at}` as AttemptKey) === key);
  if (window === undefined || attempt === undefined) return null;
  const live = round.status === 'run';
  // The newest finished CI round states the check state a record holds: open
  // and failing, or open and still running. A cleared question states none.
  const currentCi = input.ciOpen === true
    ? { label: 'CI', status: input.ciWaiting === true ? ('run' as const) : ('fail' as const) }
    : null;
  const evidence: ShipRoundEvidenceFacts = {
    round,
    attempt,
    ...(live && input.autofix ? { steps: input.autofix.steps } : {}),
    pushes: shipPushes(input.shipEvidence, facts.deliverRuns, input.repoNameFor),
    followedByCi: facts.attempts.some((a) => a.at > attempt.at && a.kind === 'ci'),
    currentCi,
  };
  return shipRoundLedger(window, evidence);
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
    implSession,
    now,
    processRuns,
    timeline,
    segmentTokens,
    marks,
    assignmentFor,
    tokensFor,
    tokensForRuns,
    attach,
    gateRuns,
    hostRerunRuns,
    findings,
    uatFindings,
    rounds,
    services,
    resolvedGates,
    liveGates,
    findingsRepoSelection,
    repoNameFor,
    graphInsideProcessOnce,
    uatSwitch,
    reviewSwitch,
    shipSwitch,
    uatRoundSwitcher,
    reviewRoundSwitcher,
    shipRoundSwitcher,
    shipRounds,
    uatCurrent,
    reviewCurrent,
    shipEvidence,
    prs,
    mergeChecks,
    shipFindings,
    findingsBlockingSeverity,
    autofix,
    deliver,
    ciOpen,
    ciWaiting,
    ciNow,
    reviewBlockingSeverity,
    testerBlockingSeverity,
    reviewStallDetection,
    stepper,
    recordedTotal,
    roleTokens,
    stageCurrent,
  } = input;

  // T1410: a historical Ship tab selects one round; the default (latest) path
  // is `null` and leaves every process reading exactly as it does today.
  const shipLedger = historicalShipLedger(input, now);
  const insideViews: Record<InsideStageKey, InsideStageView> = {
    scope: stageView(      'scope',
      cellOf('scope'),
      scopeProcesses(cellOf('scope'), selectedRepos, worktrees, now, processRuns, tokensFor('prefill'), tokensForRuns),
      now,
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
          implSession ?? null,
        ),
        // The graph runtime's read-only projection (Slice 2 Task 10):
        // appended when the host supplies it, inert otherwise. Computed once
        // — the guard and the spread previously each called
        // `graphInsideProcess`, building the whole projection twice and
        // discarding one.
        ...(graphInsideProcessOnce ? [graphInsideProcessOnce] : []),
      ],
      now,
    ),
    uat: stageView(
      'uat',
      cellOf('uat'),
      uatProcesses({
        cell: cellOf('uat'),
        gateRuns,
        ...(hostRerunRuns ? { hostRerunRuns } : {}),
        findings: [],
        uatFindings,
        processRuns,
        rounds,
        services,
        now,
        configured: assignmentFor('tester'),
        tokens: tokensFor('tester'),
        ...(tokensForRuns ? { tokensForRuns } : {}),
        attach,
        resolvedGates: resolvedGates?.uat ?? [],
        ...(liveGates?.uat ? { liveGates: liveGates.uat } : {}),
        // The gate rows name the service the way Settings names it, never the
        // path the evidence table keys by — the same injection ship uses.
        repoNameFor,
        selectedAttempt: uatSwitch.selectedKey,
        currentAttempt: uatCurrent,
        findingsRepo: findingsRepoSelection?.uat ?? null,
        testerBlockingSeverity,
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
        ...(hostRerunRuns ? { hostRerunRuns } : {}),
        findings,
        uatFindings: [],
        processRuns,
        rounds,
        services,
        now,
        configured: assignmentFor('review'),
        tokens: tokensFor('review'),
        ...(tokensForRuns ? { tokensForRuns } : {}),
        attach,
        resolvedGates: resolvedGates?.review ?? [],
        ...(liveGates?.review ? { liveGates: liveGates.review } : {}),
        repoNameFor,
        selectedAttempt: reviewSwitch.selectedKey,
        currentAttempt: reviewCurrent,
        findingsRepo: findingsRepoSelection?.review ?? null,
        reviewBlockingSeverity,
        reviewStallDetection,
      }),
      now,
      consoleFor('review', cellOf),
      reviewRoundSwitcher,
    ),
    ship: withNow(stageView(
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
        ...(tokensForRuns ? { tokensForRuns } : {}),
        findings: shipFindings,
        findingsBlockingSeverity,
        autofix: autofix ?? null,
        deliver: deliver ?? null,
        ciOpen: ciOpen === true,
        ciWaiting: ciWaiting === true,
        // T1410: the round tabs are the rounds; a historical selection narrows
        // Auto-fix, Push and Merge to that round's own rows. Commit and Pull
        // request stay in both cases.
        rounds: shipSwitch?.view?.attempts ?? [],
        ...(shipLedger ? { roundLedger: shipLedger } : {}),
      }),
      now,
      undefined,
      shipRoundSwitcher,
    ), ciNow),
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
 * arrived (a reopened panel, a window that missed the events). It carries no
 * `detail`: the row below already shows that text, and the header must not
 * become a second process row. A settled stage has no live line at all.
 */
function liveFor(processes: readonly InsideProcessView[]): InsideLiveView | undefined {
  const active =
    processes.find((p) => p.status === 'run') ?? processes.find((p) => p.status === 'wait');
  if (!active) return undefined;
  return {
    status: active.status === 'run' ? 'run' : 'wait',
    label: active.label,
    ...(active.duration ? { duration: active.duration } : {}),
  };
}

/** The ship view with its Now line, when the host states one (T1140). */
function withNow(view: InsideStageView, ciNow: InsideNowView | undefined): InsideStageView {
  return ciNow ? { ...view, now: ciNow } : view;
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
    | { attempts: readonly GateAttemptView[]; selectedAttempt: AttemptKey; attemptCaption?: string; attemptNote?: string }
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
