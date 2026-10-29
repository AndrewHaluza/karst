import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import { getPlacement } from '../../store/placement.js';
import type { SharedServerView } from '../../store/sharedServers.js';
import type { AgentProvider, ReviewStallDetection, Severity, TicketProvider } from '../../manifest/types.js';
import { providerTicketUrl } from '../../integrations/ticketUrl.js';
import { buildStepper, markPausedCells, type StepperCell } from '../../model/stepper.js';
import { listStageRuns } from '../../store/stageRuns.js';
import { buildShipSlot } from '../../model/shipSlot.js';
import { type GraphInsideInput } from '../../model/inside/graph.js';
import { nowIso } from '../../model/time.js';
import type { StageKey } from '../../model/types.js';
import { FIX_ATTEMPT_CAP, type GateStageKey } from '../../workflow/fixAttempts.js';
import { needsUser } from '../../model/ticketGlyph.js';
import { canCloseTicket, canReopenTicket } from '../../model/closeRules.js';
import { subtaskProgress, canAddSubtask, canDetachSubtask } from '../../model/subtask.js';
import { reportedPhases } from '../../model/inside/agent.js';
import { listRecentlyUsedModels } from '../../store/tokenUsage.js';
import type { InsideActionRegistry } from './insideActions.js';
import type { SessionConfiguredInput } from '../../model/inside/agent.js';
import { isKarstCheckout } from '../../commands/launchWorktree.js';
import type { DashboardAgentContext, DashboardState, PathContext } from './stateTypes.js';
import { buildAgentState, emptyCapabilityIdentity, buildSandbox, resolveSessionCore } from './stateAgent.js';
import { buildDashboardRows } from './stateRows.js';
import { readRelations, readRounds, originLabel } from './stateRelations.js';
import { buildAttach, buildArtifacts, readEvidence } from './stateEvidence.js';
import { readActionStates, shipActionViews } from './stateActions.js';
import { buildInsideSection } from './stateInsideSection.js';
import { buildRail } from './stateRail.js';
import { formatId } from '../../model/entityId.js';

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
   * The manifest's runnable unit keys (`repo`, or `repo/service`) for this
   * ticket's scope — host-known context for the quality stages' `services`
   * process and the env-override scopes. Absent → no services named.
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
  /**
   * The thresholds the Inside rows and the review artifact count against —
   * `review.findings.blockingSeverity` and `uat.testerObservations.blockingSeverity`.
   * Display only (the verdicts are decided in `workflow/`); absent → the
   * manifest defaults. Historical attempts read the CURRENT threshold.
   * Appended LAST so existing positional callers keep their positions.
   */
  displayBlocking?: {
    review?: Severity | 'none';
    tester?: Severity | 'none';
    /** `review.stallDetection`, for the Inside review view's stall summary. */
    reviewStall?: ReviewStallDetection;
  },
  /**
   * The shared services this ticket consumes (`store/sharedServers.ts`). Built
   * host-side because it needs the manifest and the live store; injected for
   * the same reason as `serviceNames` — this builder never reads the manifest.
   * Absent → no shared rows, exactly the pre-feature panel.
   * Appended LAST so every existing positional caller keeps its argument positions.
   */
  sharedServersFor: (ticketId: number) => SharedServerView[] = () => [],
): DashboardState {
  const ticket = getTicket(store, ticketId); // throws on unknown id
  const recentByCore = listRecentlyUsedModels(store, ticket.projectId, 5);
  const { parent, subtaskParent, subtaskList, blockers, subtasks } = readRelations(store, ticket, {
    defaultProvider,
    agentContext,
    recentByCore,
  });
  const rounds = readRounds(store, ticketId);
  const { agentSession, agentSwitch } = buildAgentState({
    ticket,
    fixExecutionActive: rounds.some((round) => round.status === 'fixing'),
    defaultProvider,
    agentContext,
    recentByCore,
  });

  const placement = getPlacement(store, ticketId);
  const sessionCore = resolveSessionCore({
    capabilityIdentity: agentContext.capabilityIdentity,
    ticket,
    defaultProvider,
  });
  const capabilityIdentity = agentContext.capabilityIdentity ?? emptyCapabilityIdentity();

  const openRunStages = new Set(
    listStageRuns(store, ticketId)
      .filter((r) => r.status === 'running')
      .map((r) => r.stageKey),
  );
  const stepper = markPausedCells(buildStepper(ticket.stages), ticket.pausedAt != null, (k) =>
    openRunStages.has(k),
  );
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
    serviceKeys: serviceNames(ticketId),
  });
  const phases = approachPhases(ticket.approach);

  const {
    mergeGate,
    sendBack,
    rerunGate,
    resetStage,
    prFeedbackFix,
    ciFailure,
    rebase,
    undelivered,
    openPrFeedback,
  } = readActionStates(store, ticketId, agentContext);
  const evidence = readEvidence(store, ticketId);
  const { marks, gateRuns, findings, processRuns, uatFindings, shipEvidence } = evidence;
  // The needs-you derivation every other surface already honours. Consulted, not
  // re-derived: a second answer to "is this blocked on the user" is exactly the
  // bug the single derivation exists to prevent.
  const blocked = needsUser(ticket);
  const implCell = stepper.find((c) => c.stageKey === 'impl') ?? null;
  const reported = implCell ? reportedPhases(marks, implCell).map((m) => m.phaseName) : [];

  const attach = buildAttach(registry, ticketId);
  const cellOf = (key: StageKey): StepperCell =>
    stepper.find((c) => c.stageKey === key) ?? { stageKey: key, status: 'pending' };

  const { insideViews, presentedStage, serverRows } = buildInsideSection(store, {
    ticket,
    stepper,
    currentStage,
    rounds,
    worktrees,
    prs,
    mergeChecks,
    now,
    evidence,
    cellOf,
    attach,
    assignmentFor,
    resolvedGates,
    findingsRepoSelection,
    repoNameFor,
    graphInside,
    attemptSelection,
    findingsBlockingSeverity,
    displayBlocking,
  });

  return {
    ticketId: ticket.id,
    idLabel: formatId('ticket', ticket.id),
    origin: originLabel(store, ticket.id),
    key: ticket.key,
    title: ticket.title,
    parent,
    subtaskParent,
    subtasks,
    blockers,
    subtaskProgress: subtaskProgress(subtaskList),
    canAddSubtask: canAddSubtask(ticket),
    canDetachSubtask: canDetachSubtask(ticket, subtaskList.length),
    canClose: canCloseTicket(ticket),
    canReopen: canReopenTicket(ticket),
    stageCurrent: ticket.stageCurrent,
    agentState: ticket.agentState,
    paused: ticket.pausedAt !== null,
    pausedAt: ticket.pausedAt,
    agentSession,
    stepper,
    currentStage,
    ship: buildShipSlot(currentStage, 'repos' in mergeGate ? mergeGate : undefined),
    agentSwitch,
    capabilityIdentity,
    sandbox: buildSandbox(agentContext, ticket, sessionCore, placement),
    servers: serverRows,
    // The read-only half of the stack. Kept OUT of `servers` so no action that
    // already means "this ticket's services" silently widens to a shared one.
    sharedServers: sharedServersFor(ticketId),
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
    rail: buildRail({
      ticket,
      stepper,
      currentStage,
      blocked,
      cellOf,
      mergeGate,
      mergeableRepos,
      fixCapFor,
    }),
    insideViews,
    presentedStage,
    approach: ticket.approach ? { id: ticket.approach, phases, reported } : null,
    artifacts: buildArtifacts({
      store,
      ticket,
      gateRuns,
      findings,
      uatFindings,
      processRuns,
      shipEvidence,
      prs,
      phases,
      marks,
      attach,
      reviewBlockingSeverity: displayBlocking?.review,
    }),
    sendBack,
    rerunGate,
    resetStage,
    prFeedbackFix,
    ...shipActionViews({ ciFailure, rebase, undelivered }, ticket.stageCurrent),
    openPrFeedback,
  };
}
