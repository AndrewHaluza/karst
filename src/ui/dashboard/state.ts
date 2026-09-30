import type { Store } from '../../store/db.js';
import { getTicket, listSubtasks } from '../../store/tickets.js';
import { listServersByTicket } from '../../store/dashboard.js';
import type { AgentProvider, Severity, TicketProvider } from '../../manifest/types.js';
import { providerTicketUrl } from '../../integrations/ticketUrl.js';
import { buildStepper, displayStatus, type StepperCell } from '../../model/stepper.js';
import { buildShipSlot } from '../../model/shipSlot.js';
import { buildStageRail } from '../../model/stageRail.js';
import { listGateRuns } from '../../store/gateRuns.js';
import { listFindings, findingsForAttempt } from '../../store/reviewFindings.js';
import { listPhaseMarks } from '../../store/phaseMarks.js';
import { mergeGateState } from '../../workflow/mergeGate.js';
import { sendBackState, type SendBackState } from '../../workflow/sendBack.js';
import { retryGateState, type RetryGateState } from '../../workflow/retryGate.js';
import { prFeedbackFixState, type PrFeedbackFixState } from '../../workflow/prFeedbackFix.js';
import { countOpenPrFeedback } from '../../store/prFeedback.js';
import { graphInsideProcess, type GraphInsideInput } from '../../model/inside/graph.js';
import { nowIso } from '../../model/time.js';
import type { StageKey } from '../../model/types.js';
import { FIX_ATTEMPT_CAP, type GateStageKey } from '../../workflow/fixAttempts.js';
import { needsUser } from '../../model/ticketGlyph.js';
import { stageBadge } from '../../model/stageBadge.js';
import { stageColorClass } from '../../model/stagePalette.js';
import { subtaskProgress, canAddSubtask, canDetachSubtask } from '../../model/subtask.js';
import { railNeeds } from '../../model/railNeeds.js';
import { reportedPhases } from '../../model/inside/agent.js';
import { listProcessRuns } from '../../store/processRuns.js';
import { listStageRuns } from '../../store/stageRuns.js';
import { currentAttemptFor } from '../../model/inside/currentAttempt.js';
import { listRecoveryRounds } from '../../store/recoveryRounds.js';
import { listUatFindings } from '../../store/uatFindings.js';
import { listShipEvidence, countShipRuns } from '../../store/shipRuns.js';
import {
  listImplementationTimeline,
  readSegmentTokenTotals,
} from '../../store/implementationRuns.js';
import {
  summarizeRecordedTokenUsage,
  summarizeRecordedTokenUsageForProcess,
  summarizeRecordedTokenUsageByRole,
  listRecentlyUsedModels,
} from '../../store/tokenUsage.js';
import type { InsideActionRegistry } from './insideActions.js';
import type {
  InsideEvidenceTarget,
  InsideStageKey,
  TypedInsideAction,
} from '../../model/inside/types.js';
import { insideStageForRuntimeStage } from '../../model/inside/registry.js';
import { listGateAttempts, type AttemptKey, type GateAttemptView } from '../../model/inside/rounds.js';
import type { SessionConfiguredInput, SessionTokensInput } from '../../model/inside/agent.js';
import { isKarstCheckout } from '../../commands/launchWorktree.js';
import type { DashboardAgentContext, DashboardState, DashboardSubtaskRow, PathContext } from './stateTypes.js';
import { buildAgentState } from './stateAgent.js';
import { buildDashboardRows } from './stateRows.js';
import { buildInsideViews, type AttemptSwitch, type RoundSwitcherArg } from './stateInside.js';
import { buildArtifactsFrom, readPlanInput } from '../../model/artifacts.js';

export type {
  DashboardAgentContext,
  DashboardState,
  DashboardWorktreeView,
  MergeCheckPanelRow,
  PathContext,
  PrPanelRow,
  StageRail,
  StepperCell,
} from './stateTypes.js';

/**
 * Gather everything a ticket dashboard renders, in one snapshot. The stepper is
 * ordered by STAGE_KEYS (not by stage-row insertion) so the stepper is stable.
 * Throws if the ticket id is unknown (validated at the boundary).
 */
export function buildDashboardState(
  store: Store,
  ticketId: number,
  pathContext?: PathContext,
  ticketing?: { provider?: TicketProvider },
  /**
   * Resolve an approach id to its ordered workflow phase names (host binds this
   * to the installed package's `workflow`). Injected so this stays pure/testable.
   */
  approachPhases: (approachId: string | null) => string[] = () => [],
  /**
   * Whether a scoped repository declares a runnable service. Injected (the state
   * builder never reads the manifest) and defaults to "assume runnable", so a
   * caller that cannot resolve the manifest degrades to the previous behavior
   * rather than hiding a working button.
   */
  isRepoRunnable: (repo: string) => boolean = () => true,
  /**
   * Manifest-level agent core, so the entry-point verb resolves the same
   * provider `openSession` will launch with. Omitted → a captured session
   * cannot be verified and the verb degrades to "Start" (never a false
   * "Continue" that would die on a foreign `--resume`).
   */
  defaultProvider?: AgentProvider,
  /** Live session/model context, injected by the extension host. */
  agentContext: DashboardAgentContext = {},
  /**
   * The fix budget for ONE gate, so the retry meter draws exactly as many ticks
   * as the driver will spend. Injected (the state builder never reads the
   * manifest) and defaults to the graph's own cap — a caller that cannot resolve
   * the manifest degrades to the real backstop rather than to a number that
   * would misreport how many retries remain.
   */
  fixCapFor: (gate: GateStageKey) => number = () => FIX_ATTEMPT_CAP,
  /**
   * The manifest's service names for this ticket's scope — host-known context
   * for the quality stages' `services` process. Absent → no services named.
   */
  serviceNames: (ticketId: number) => string[] = () => [],
  /**
   * The configured AI assignment for an inside process, shown as
   * `configuredExecution` before any recorded run. Absent → none shown.
   */
  assignmentFor: (processId: 'session' | 'tester' | 'review') => SessionConfiguredInput | null =
    () => null,
  /**
   * The snapshot-scoped action registry: when supplied, every evidence row
   * that has an action mints its opaque id through it (the id rides the view;
   * the registry — and its host-only targets — never leaves the host).
   * Absent → rows carry no actions and no registry exists for the snapshot.
   */
  registry?: InsideActionRegistry | null,
  /**
   * The gate names per stage resolved by `ui/dashboard/gateOptions.ts`, shown
   * as pending rows before the stage runs. Absent → no forecast, and the row
   * states that the gates resolve when the stage runs.
   */
  resolvedGates?: {
    uat: readonly { name: string; disabled: boolean }[];
    review: readonly { name: string; disabled: boolean }[];
  },
  /**
   * Whether a worktree is a karst-extension checkout, i.e. whether its row may
   * offer the "Launch Dev" action. Injected (the state builder never reads the
   * filesystem) and defaults to the real probe, so a caller that cannot probe
   * degrades to "not launchable" rather than offering a button that would fail.
   */
  isCheckout: (path: string) => boolean = isKarstCheckout,
  /**
   * The manifest repository NAME for a recorded repo value (the runtime
   * tables key by repo PATH). The inside ship rows show the name, never the
   * path. Absent → the raw recorded value stands.
   */
  repoNameFor: (repo: string) => string | undefined = () => undefined,
  /**
   * The read-only graph runtime projection for the impl strip (Slice 2 Task
   * 10). Injected by the host — the state builder never reads the graph
   * tables — and ABSENT by default: the projection ships inert behind its
   * feature flag until Slice 3 wires the coordinator, so no caller changes
   * behavior today. Appended LAST so every existing positional caller keeps
   * its argument positions.
   */
  graphInside?: GraphInsideInput | null,
  /**
   * The round switcher's current selection (Option B, T4), keyed by gate
   * stage. Absent/undefined for a key → the effective selection falls back to
   * that stage's latest attempt, which is BYTE-FOR-BYTE what every reducer
   * downstream already renders for `selectedAttempt: null` — this is what
   * keeps `buildDashboardState`'s output unchanged for a caller that never
   * supplies this map. A key naming an attempt this stage no longer holds
   * (stale panel selection, a snapshot for a different ticket) degrades the
   * same way: silently to latest, never a thrown error and never an empty
   * stage. Appended LAST so every existing positional caller keeps its
   * argument positions.
   */
  attemptSelection?: Partial<Record<'uat' | 'review', string>>,
  /**
   * The manifest's resolved default base branch for a worktree's repoPath
   * (§ per-repo base branch — live change). Injected (the state builder never
   * reads the manifest) — absent → `''`, which never marks a base as
   * overridden (an empty default cannot equal any real branch name).
   * Appended LAST so every existing positional caller keeps its argument
   * positions.
   */
  baseBranchDefaultFor: (repoPath: string) => string = () => '',
  /**
   * The base-branch candidates for a worktree's repoPath, for its combobox —
   * loaded lazily and cached host-side (`listBaseBranchCandidates`), same
   * split as `loadStats`: a git listing is not something this synchronous
   * builder can perform itself. Absent/unwarmed → `[]`, and the input stays
   * free text either way. Appended LAST for the same reason.
   */
  baseBranchCandidatesFor: (repoPath: string) => string[] = () => [],
  /**
   * The manifest's `review.findings.blockingSeverity` (Task 4.1). Injected
   * (the state builder never reads the manifest) and defaults to `'none'`,
   * which keeps the ship-stage warning row silent for a caller that never
   * supplies this — the same "absent degrades to no signal" policy every
   * other injected manifest fact in this builder follows. Appended LAST so
   * every existing positional caller keeps its argument positions.
   */
  findingsBlockingSeverity: Severity | 'none' = 'none',
  /**
   * The findings repo scope for each gate stage (§ findings severity ramp).
   * `findingsRepoSelection?.uat` / `findingsRepoSelection?.review` names a
   * recorded repo PATH, or absent/undefined for "all repositories". A value
   * naming a repo the current batch does not hold degrades to "all" inside
   * the quality reducers — the same "absent degrades to no signal" policy
   * every other injected selection follows. Appended LAST so every existing
   * positional caller keeps its argument positions.
   */
  findingsRepoSelection?: Partial<Record<'uat' | 'review', string>>,
): DashboardState {
  const ticket = getTicket(store, ticketId); // throws on unknown id
  // The parent relationship for the dashboard's secondary metadata line. A
  // follow-up's identity is relationship metadata, never part of its title. A
  // hard-deleted parent degrades to null — same policy as ticketContext.
  let parent: { key: string; title: string | null } | null = null;
  if (ticket.parentTicketId !== null) {
    try {
      const p = getTicket(store, ticket.parentTicketId);
      parent = { key: p.key ?? `#${p.id}`, title: p.title };
    } catch {
      parent = null;
    }
  }
  // The sub-task composition relation (design NDL-70 §3/§8) — orthogonal to the
  // follow-up relation above: `subtask_parent_id` says "is part of", while
  // `parent_ticket_id` says "continues after". A hard-deleted parent degrades
  // to null, the same policy as the follow-up line.
  let subtaskParent: { key: string; title: string | null } | null = null;
  if (ticket.subtaskParentId !== null) {
    try {
      const p = getTicket(store, ticket.subtaskParentId);
      subtaskParent = { key: p.key ?? `#${p.id}`, title: p.title };
    } catch {
      subtaskParent = null;
    }
  }
  // Direct sub-tasks, oldest first, for the "Sub-tasks" section and its
  // `n/m done` progress. One row read per child powers its status glyph; the
  // sub-task count is small and bounded by the writer's depth/creation rules,
  // and the alternative — a second stage-status derivation — would drift from
  // the one `stageBadge` every other surface paints with.
  const subtaskList = listSubtasks(store, ticketId);
  const subtasks: DashboardSubtaskRow[] = subtaskList.map((s) => {
    const badge = stageBadge(getTicket(store, s.id));
    return {
      id: s.id,
      key: s.key ?? `#${s.id}`,
      title: s.title,
      stage: s.stageCurrent,
      glyph: badge.glyph,
      stageClass: stageColorClass(badge.stage),
      blocking: s.blocksParent,
      done: s.stageCurrent === 'done',
    };
  });
  const rounds = listRecoveryRounds(store, ticketId);
  const { agentSession, agentSwitch } = buildAgentState({
    ticket,
    fixExecutionActive: rounds.some((round) => round.status === 'fixing'),
    defaultProvider,
    agentContext,
    recentByCore: listRecentlyUsedModels(store, ticket.projectId, 5),
  });
  const stepper = buildStepper(ticket.stages);
  const currentStage = stepper.find((c) => c.stageKey === ticket.stageCurrent) ?? null;

  // ONE clock read per push: the PR stamps, the merge rows and the stage strip
  // must not date from different instants.
  const now = nowIso();

  const {
    worktrees,
    prs,
    prRows,
    mergeChecks,
    mergeCheckRows,
    mergeableRepos,
    hasRunnableRepos,
    envOverrides,
  } = buildDashboardRows(store, {
    ticketId,
    selectedRepos: ticket.selectedRepos,
    now,
    pathContext,
    isCheckout,
    isRepoRunnable,
    baseBranchDefaultFor,
    baseBranchCandidatesFor,
    repoNameFor,
  });
  const phases = approachPhases(ticket.approach);

  // ONE read of the merge gate for the whole snapshot: the Now line and the
  // track's needs-you wording must not describe the same three-valued fact from
  // two different reads.
  const mergeGate = mergeGateState(store, ticketId);
  // ONE read of the recovery action's availability, for the same reason: the
  // stage header's ⋯ menu and the host's confirm path must agree about whether
  // "Send back to Implement" exists at all. Derived here rather than on click
  // so a stale panel can never offer an action the host would refuse — and the
  // host re-derives it before mutating anyway.
  const sendBack = sendBackState(store, ticketId);
  const rerunGate = retryGateState(store, ticketId);
  // ONE read of the PR-feedback action's availability, for the same reason: the
  // ship header's ⋯ menu and the host's confirm path must agree about whether
  // "Address pull request feedback" exists at all.
  const prFeedbackFix = prFeedbackFixState(store, ticketId);
  const openPrFeedback = countOpenPrFeedback(store, ticketId);
  // ONE read of the marks, for the same reason — the Inside strip and the impl
  // segment's pips are two views of one set of facts.
  const marks = listPhaseMarks(store, ticketId);
  // ONE read of each inside evidence source, shared by every view that renders
  // it — two reads of one table is how two panels disagree about one fact.
  const gateRuns = listGateRuns(store, ticketId);
  const findings = listFindings(store, ticketId);
  const processRuns = listProcessRuns(store, ticketId);
  const uatFindings = listUatFindings(store, ticketId);
  const shipEvidence = listShipEvidence(store, ticketId);
  const timeline = listImplementationTimeline(store, ticketId);
  // ONE read of the invocation records, for the same reason as every other
  // evidence read here. `stage_runs` is the only table written at stage ENTRY,
  // so it is the only thing that can say a gate stage is on a NEW invocation
  // that has recorded nothing yet — the fix cycle's round 2, which every
  // finished-work table still answers with round 1's rows.
  const stageRuns = listStageRuns(store, ticketId);
  // The needs-you derivation every other surface already honours. Consulted, not
  // re-derived: a second answer to "is this blocked on the user" is exactly the
  // bug the single derivation exists to prevent.
  const blocked = needsUser(ticket);
  const implCell = stepper.find((c) => c.stageKey === 'impl') ?? null;
  const reported = implCell ? reportedPhases(marks, implCell).map((m) => m.phaseName) : [];

  // The snapshot-scoped action seam: the registry lives here in the host; only
  // the opaque {actionId, kind} pairs ride the view. The continuation label
  // ("Show 4 more", handoff §10) is presentation copy the registry does not
  // model, so it is carried alongside the minted action here.
  const attach = (target: InsideEvidenceTarget): TypedInsideAction | undefined => {
    const action = registry?.register({ ...target, ticketId: ticket.id });
    if (!action) return undefined;
    const label = 'label' in target ? (target as { label?: string }).label : undefined;
    return label ? { ...action, label } : action;
  };

  // Recorded token summaries per process and per role — a process whose calls
  // were all estimates reads as absent, never as a measured free call. The
  // estimate COUNT rides beside the measured total as a separate fact (a core
  // that fell back to estimates stays visible, never folded into the total).
  // Gated on FRESH spend, not the raw tally: the pill headlines fresh (see
  // `tokenView`), so a process whose every recorded token was a cache READ has
  // a raw total > 0 but nothing fresh, and admitting it here renders a
  // clamped "0 tok" — a fabricated zero, which decision 8 forbids (absence is
  // stated, never a measured-looking nothing). Same rule as the segment
  // timeline's filter in `model/inside/agent.ts`.
  const tokensFor = (processId: string): SessionTokensInput | null => {
    const summary = summarizeRecordedTokenUsageForProcess(store, ticketId, processId);
    return summary.total - summary.cacheRead > 0
      ? {
          total: summary.total,
          cacheRead: summary.cacheRead,
          estimatedCalls: summary.estimatedCalls,
        }
      : null;
  };
  const recordedTotal = summarizeRecordedTokenUsage(store, ticketId);
  const roleTokens = summarizeRecordedTokenUsageByRole(store, ticketId);

  const cellOf = (key: StageKey): StepperCell =>
    stepper.find((c) => c.stageKey === key) ?? { stageKey: key, status: 'pending' };

  // The gate stage's CURRENT invocation (`model/inside/currentAttempt.ts`),
  // resolved once per stage and shared by the round switcher and the quality
  // reducer below — two reads of `stage_runs` is how a tab and a ledger end
  // up disagreeing about which attempt is showing.
  const currentAttemptOf = (key: 'uat' | 'review') =>
    currentAttemptFor(stageRuns, key, cellOf(key).startedAt);
  const uatCurrent = currentAttemptOf('uat');
  const reviewCurrent = currentAttemptOf('review');

  // The round switcher's effective selection for one gate stage (T4): the
  // requested key if some recorded attempt actually holds it, otherwise the
  // newest attempt. A stage with 0 or 1 attempt emits no tabs at all (T1's
  // own contract), so `attemptSwitcherFor` degrades to "nothing to select"
  // without a caller here having to special-case the un-looped ticket.
  const attemptSwitcherFor = (
    attempts: readonly GateAttemptView[],
    requested: string | undefined,
    // True when the host's `currentAttemptFor` returned an explicit `null`
    // for this stage (the re-entry window — see `rounds.ts`'s
    // `reentryPending`). The tab flagged `latest` in that state is NOT the
    // live invocation; it is the newest SETTLED attempt, kept flagged `latest`
    // only so the default (unclicked) view still resolves to `null` below.
    reentryPending: boolean,
  ): {
    selectedKey: AttemptKey | null;
    view?: { attempts: readonly GateAttemptView[]; selectedAttempt: AttemptKey; attemptNote?: string };
  } => {
    if (attempts.length < 2) return { selectedKey: null };
    const requestedMatch = requested !== undefined ? attempts.find((a) => a.key === requested) : undefined;
    const effective = requestedMatch ?? attempts.find((a) => a.latest);
    if (effective === undefined) return { selectedKey: null };
    // Host-authored, worded from the reader's side: a settled historical
    // attempt is announced so a viewer never mistakes it for the live
    // picture (UI-R31 — the webview renders this verbatim and composes
    // nothing). The newest attempt carries no note when it is genuinely the
    // live one; during the re-entry window the `latest`-flagged tab is not,
    // so it gets the same "not the current result" note as any historical tab.
    const attemptNote =
      effective.latest && !reentryPending
        ? undefined
        : effective.round !== undefined
          ? `viewing round ${effective.round} — not the current result`
          : `viewing ${effective.label} — not the current result`;
    // An EXPLICIT click on the re-entry window's `latest`-flagged tab must
    // still reach that attempt's own recorded rows — it is a settled attempt,
    // not the live one, and collapsing it to `null` here is exactly what made
    // its evidence show as an empty ledger no matter which tab a reader
    // picked (Finding 1). Only the UNCLICKED default keeps mapping to `null`,
    // which is what lets the ledger stay empty absent a click (`effectiveAttempt`
    // in gates.ts empties on a `null` selection while the current invocation
    // has recorded nothing).
    const reachThroughLatest = reentryPending && effective.latest && requestedMatch !== undefined;
    return {
      // The LATEST tab is the default path, so it selects `null` — not its own
      // key. A key restricts every downstream read to rows that carry a stage
      // run id, and a `process_runs` row written before v25 carries none:
      // selecting the latest key would have emptied the Tester/Review evidence
      // of exactly the view that renders by default. `null` is the read the
      // panel has always done, so the default view stays byte-for-byte itself
      // and only a HISTORICAL selection narrows anything.
      selectedKey: effective.latest && !reachThroughLatest ? null : effective.key,
      view: {
        attempts,
        selectedAttempt: effective.key,
        ...(attemptNote ? { attemptNote } : {}),
      },
    };
  };


  // The stage the six-stage presentation shows as CURRENT: `fix` projects onto
  // the stage its active recovery round is causally attached to. A ship-sourced
  // round (FEAT-40) revalidates through uat first, so it projects onto uat
  // exactly as a uat round does.
  const activeRound = rounds.find(
    (r) =>
      r.status === 'pending' ||
      r.status === 'fixing' ||
      r.status === 'revalidating' ||
      r.status === 'interrupted',
  );
  const fixFallback: 'uat' | 'review' = activeRound?.sourceStage === 'review' ? 'review' : 'uat';

  /**
   * Host-authored banner for a gate stage whose recorded result is already
   * being superseded (UI-R31 — the webview renders this verbatim).
   *
   * While a recovery round works elsewhere, the OTHER gate stage still holds
   * its last verdict: red gates, blocking findings, and nothing on screen
   * saying a fix has since landed and the stage re-runs. Nothing here invents
   * a status — the result shown is the real last one — it states the fact that
   * makes it readable.
   *
   * Never for the stage the ticket is on (its own ledger is live), never for a
   * stage running right now, and never for a stage with no recorded end: there
   * is no superseded result to caption.
   */
  const supersededNote = (key: 'uat' | 'review'): string | undefined => {
    if (activeRound === undefined) return undefined;
    if (ticket.stageCurrent === key) return undefined;
    const cell = cellOf(key);
    if (displayStatus(cell) === 'running' || displayStatus(cell) === 'blocked') return undefined;
    const endedAt = cell.endedAt;
    if (endedAt === undefined) return undefined;
    // Only a result the round POSTDATES is superseded by it. A stage that ran
    // after the round opened (uat revalidating a review-origin round) is
    // reporting on the fixed tree already.
    if (activeRound.startedAt < endedAt) return undefined;
    return `round ${activeRound.round} is fixing — this result predates that fix, and this stage re-runs`;
  };
  const presentedStage: InsideStageKey =
    ticket.stageCurrent === null || ticket.stageCurrent === 'fix'
      ? insideStageForRuntimeStage(
          (ticket.stageCurrent === 'fix' ? fixFallback : 'scope') as StageKey,
          fixFallback,
        )
      : insideStageForRuntimeStage(ticket.stageCurrent as StageKey, fixFallback);

  // Computed once: this used to be called separately by the spread's guard
  // and its element, building the whole projection twice and discarding one.
  const graphInsideProcessOnce = graphInsideProcess(graphInside);

  // The round switcher's tabs and effective selection, one read per gate
  // stage, shared by the process reducer (which batch/run backs the ledger)
  // and the stage shell (which tab renders selected, and the banner). Two
  // reads of this would risk the ledger and the tab disagreeing about which
  // attempt is showing.
  const uatAttempts = listGateAttempts({
    gateRuns,
    processRuns,
    rounds,
    stageKey: 'uat',
    running: displayStatus(cellOf('uat')) === 'running',
    currentAttempt: uatCurrent ?? null,
    // `=== null` (not `?? null`) so a legacy ticket's `undefined` never reads
    // as re-entry pending — only an explicit `null` from `currentAttemptFor`
    // does.
    reentryPending: uatCurrent === null,
  });
  const uatSwitch = attemptSwitcherFor(uatAttempts, attemptSelection?.uat, uatCurrent === null);
  const reviewAttempts = listGateAttempts({
    gateRuns,
    processRuns,
    rounds,
    stageKey: 'review',
    running: displayStatus(cellOf('review')) === 'running',
    currentAttempt: reviewCurrent ?? null,
    reentryPending: reviewCurrent === null,
  });
  const reviewSwitch = attemptSwitcherFor(reviewAttempts, attemptSelection?.review, reviewCurrent === null);

  // Hoisted once each — `supersededNote` is otherwise called twice per stage
  // below (once to decide the merge, once to build the note-only fallback).
  const uatNote = supersededNote('uat');
  const reviewNote = supersededNote('review');

  /**
   * Merges a `supersededNote` fallback into an `attemptSwitcherFor` view for
   * `stageView`'s `roundSwitcher` argument. An explicit HISTORICAL
   * `attemptNote` (a reader looking at a settled round) always wins — it is
   * the more specific fact, and a superseded-round banner must never paper
   * over it. Absent a switcher view entirely, the superseded note stands
   * alone as the note-only shape `stageView` also accepts.
   */
  const withNote = (
    view: { attempts: readonly GateAttemptView[]; selectedAttempt: AttemptKey; attemptNote?: string } | undefined,
    note: string | undefined,
  ): { attempts: readonly GateAttemptView[]; selectedAttempt: AttemptKey; attemptNote?: string } | { attemptNote: string } | undefined =>
    view
      ? view.attemptNote
        ? view
        : { ...view, ...(note ? { attemptNote: note } : {}) }
      : note
        ? { attemptNote: note }
        : undefined;

  // The round switcher's rendered argument per gate stage: the switcher's own
  // selection/banner merged with the superseded-round note once here, so the
  // tab and the note can never be composed from two different reads.
  const uatRoundSwitcher: RoundSwitcherArg = withNote(uatSwitch.view, uatNote);
  const reviewRoundSwitcher: RoundSwitcherArg = withNote(reviewSwitch.view, reviewNote);

  // Per-segment measured spend, straight from the ledger's own
  // `implementation_segment_id` GROUP BY — the switch row's Σ pill states what
  // the segment it moved TO went on to cost. A run that never opened has no
  // segments and therefore no totals.
  const segmentTokens = timeline
    ? readSegmentTokenTotals(store, timeline.run.id).map((t) => ({
        implementationSegmentId: t.implementationSegmentId,
        total: t.totalTokens,
        cacheRead: t.cacheReadTokens,
      }))
    : [];

  // Ruling (fix round 1, overriding the brief's `latestFindingBatch`):
  // findings are append-only with no resolve path, and a clean re-review
  // records NO batch at all (`workflow/gates/evidence.ts`'s early return
  // on zero findings). `latestFindingBatch`'s greatest-`runAt` reduction
  // therefore keeps re-surfacing a fixed-and-passed ticket's stale batch
  // forever — it is never superseded by an empty one that was never
  // written. Scoped to the review STAGE's CURRENT `attempt` instead:
  // `attempt` only climbs on a FAILED verdict (`workflow/machine.ts`) and
  // holds on a pass, so a fail-then-fix-then-pass re-review shares its
  // attempt number with the fail it followed — the fail's findings are
  // still "this attempt"'s findings, and a LATER attempt (a fresh fail)
  // silently drops them, exactly the "cleared" reading a permanent-noise
  // row cannot give.
  //
  // Intended reach (deliberate, not an oversight): because `attempt`
  // climbs only on a failed verdict, this row is SILENT on the ordinary
  // fail→fix→clean-pass path — and a ticket with unresolved
  // current-attempt blocking findings cannot reach ship anyway, since R6
  // fails review first. The row is a BACKSTOP, not the primary gate: it
  // catches a `review.findings.blockingSeverity` threshold lowered AFTER
  // the review passed, and a ticket advanced to ship by hand. The
  // attempt scoping is the trade that buys that backstop without a
  // permanent, unclearable false-red row (see the ruling above).
  const shipFindings = findingsForAttempt(
    store,
    ticketId,
    ticket.stages.find((s) => s.stageKey === 'review')?.attempt ?? 0,
  );

  // ONE projection of the six-stage inside presentation, from the same
  // evidence reads above (one read per table per snapshot). Every input is
  // host-resolved here; `stateInside.ts` is a pure projection.
  const insideViews = buildInsideViews({
    cellOf,
    selectedRepos: ticket.selectedRepos,
    worktrees,
    // The ticket's own `agent_state === 'waiting'` — the agent asked the user a
    // question and is blocked on the answer. Threaded in explicitly, never
    // re-derived: it is the same fact `cli/stage.ts`'s
    // `assertMarkerNotWhileWaiting` refuses the done marker on.
    agentWaiting: ticket.agentState === 'waiting',
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
    services: serviceNames(ticketId),
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
    stageCurrent: ticket.stageCurrent,
    ticket: {
      agentPreset: ticket.agentPreset,
      agentProvider: ticket.agentProvider,
    },
  });

  return {
    ticketId: ticket.id,
    key: ticket.key,
    title: ticket.title,
    parent,
    subtaskParent,
    subtasks,
    subtaskProgress: subtaskProgress(subtaskList),
    canAddSubtask: canAddSubtask(ticket),
    canDetachSubtask: canDetachSubtask(ticket, subtaskList.length),
    stageCurrent: ticket.stageCurrent,
    agentState: ticket.agentState,
    paused: ticket.pausedAt !== null,
    pausedAt: ticket.pausedAt,
    agentSession,
    stepper,
    currentStage,
    ship: buildShipSlot(currentStage, 'repos' in mergeGate ? mergeGate : undefined),
    agentSwitch,
    servers: listServersByTicket(store, ticketId),
    // Drives whether "Start servers" is offered at all. A ticket scoping only
    // non-runnable repositories can never have a server, so presenting a live
    // Start button there is a dead affordance dressed as an available action.
    hasRunnableRepos,
    envOverrides,
    worktrees,
    prs: prRows,
    mergeChecks: mergeCheckRows,
    provider: ticketing?.provider ?? null,
    sourceRef: ticket.sourceRef,
    ticketUrl: providerTicketUrl(ticketing?.provider, ticket.sourceRef),
    priority: ticket.priority,
    description: ticket.description,
    brief: ticket.brief,
    rail: buildStageRail(stepper, ticket.stages, {
      current: ticket.stageCurrent,
      needsUser: blocked,
      needs: blocked
        ? railNeeds({
            stage: ticket.stageCurrent,
            blockedKind: currentStage?.blocked?.kind,
            agentWaiting: (ticket.agentState ?? 'none') === 'waiting',
            // A RUNNING ship is the driver's own work, so the agent-waiting
            // banner must not outrank it (869ed7bpd). `needsUser` already
            // excludes that case — this is the rail's own guard, belt and
            // braces with the same exception.
            shipStatus: cellOf('ship').status,
            shipAwaitingMerge:
              stepper.find((c) => c.stageKey === 'ship')?.blocked?.kind === 'awaiting-merge',
            mergeGate,
            mergeableRepos,
          })
        : null,
      capFor: fixCapFor,
    }),
    insideViews,
    presentedStage,
    approach: ticket.approach ? { id: ticket.approach, phases, reported } : null,
    // Derived from the SAME evidence reads above (one read per table per
    // snapshot): the artifacts shelf, the index, and the detail are three views
    // of one set of facts, and two reads of one table is how two views of one
    // fact disagree. Order = semantic priority; previews are the first three.
    artifacts: buildArtifactsFrom({
      ticket,
      gateRuns,
      findings,
      uatFindings,
      processRuns,
      ship: shipEvidence,
      shipRunCount: countShipRuns(store, ticketId),
      prs,
      plan: readPlanInput(store, ticketId),
      // The session-phases plan reads the SAME one-read phase marks and
      // declared workflow the approach line above already resolved — two reads
      // of one table is how two panels describe one plan differently.
      declaredPhases: phases,
      phaseMarks: marks,
      attach,
    }),
    sendBack,
    rerunGate,
    prFeedbackFix,
    openPrFeedback,
  };
}
