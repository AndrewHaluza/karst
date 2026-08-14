import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import {
  listServersByTicket,
  listWorktreesByTicket,
  listPrsByTicket,
  type ServerView,
  type WorktreeView,
} from '../../store/dashboard.js';
import { isKarstCheckout } from '../../commands/launchWorktree.js';
import type { TicketProvider, AgentProvider } from '../../manifest/types.js';
import { providerTicketUrl } from '../../integrations/ticketUrl.js';
import { buildStepper, displayStatus, type StepperCell } from '../../model/stepper.js';
import { buildShipSlot, type ShipSlot } from '../../model/shipSlot.js';
import { resolveProvider } from '../../agent/registry.js';
import { IMPLEMENTED_PROVIDERS } from '../../agent/provider.js';
import { resolveEffortForProvider } from '../../agent/models.js';
import { AGENT_PROVIDER_LABELS } from '../../model/agentIdentity.js';
import { buildStageRail, type StageRail } from '../../model/stageRail.js';
import { listGateRuns } from '../../store/gateRuns.js';
import { listFindings } from '../../store/reviewFindings.js';
import { listPhaseMarks } from '../../store/phaseMarks.js';
import { listMergeChecksByTicket } from '../../store/mergeChecks.js';
import { listCurrentPrsByTicket } from '../../store/prs.js';
import type { GateStage } from '../../store/ticketGates.js';
import { mergeGateState } from '../../workflow/mergeGate.js';
import { sendBackState, type SendBackState } from '../../workflow/sendBack.js';
import { buildMergeCheckPanelRows, type MergeCheckPanelRow } from '../../model/mergeCheckPanel.js';
import { graphInsideProcess, type GraphInsideInput } from '../../model/inside/graph.js';
import { nowIso } from '../../model/time.js';
import type { StageKey } from '../../model/types.js';
import {
  FIX_ATTEMPT_CAP,
  type GateStageKey,
} from '../../workflow/fixAttempts.js';
import { needsUser } from '../../model/ticketGlyph.js';
import { railNeeds } from '../../model/railNeeds.js';
import { reportedPhases } from '../../model/inside/agent.js';
import { repoDisplayPath, type PathContext } from '../worktreePath.js';
import { buildPrPanelRows, type PrPanelRow } from '../../model/prPanelView.js';
import type { ModelCatalog } from '../../agent/modelCatalog.js';
import { bundledModelCatalog } from '../../agent/modelCatalog.js';
import { buildAgentSessionView, agentSwitchCoreChoices, agentSwitchModelChoices, type AgentSessionView } from '../../agent/sessionSwitch.js';
import { listProcessRuns } from '../../store/processRuns.js';
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
  InsideLiveView,
  InsideProcessView,
  InsideStageKey,
  InsideStageView,
} from '../../model/inside/types.js';
import {
  insideStageForRuntimeStage,
} from '../../model/inside/registry.js';
import {
  dotFor,
  formatClock,
  STAGE_BLURBS,
  STAGE_TITLES,
  type TypedInsideAction,
} from '../../model/inside/types.js';
import { scopeProcesses, implementationSessionProcess } from '../../model/inside/index.js';
import { uatProcesses, reviewProcesses } from '../../model/inside/gates.js';
import { shipProcesses } from '../../model/inside/ship.js';
import { doneReceipt, type DoneReceiptView } from '../../model/inside/done.js';
import type { SessionConfiguredInput, SessionTokensInput } from '../../model/inside/agent.js';
import { buildArtifactsFrom, readPlanInput, type ArtifactSummary } from '../../model/artifacts.js';

export type { PathContext, StepperCell, StageRail, PrPanelRow, MergeCheckPanelRow };

export interface DashboardAgentContext {
  defaultModel?: string | null;
  /** Manifest default effort/variant, for the switch popover's inherit row. */
  defaultEffort?: string | null;
  modelCatalog?: ModelCatalog;
}

/** Fully serializable dashboard state pushed to the webview via postMessage. */
export interface DashboardState {
  ticketId: number;
  key: string | null;
  title: string | null;
  /**
   * The parent ticket's key + title, when this ticket is a follow-up; null
   * otherwise. Relationship metadata for the roomy dashboard's secondary line
   * — never part of the title (model/followUp.ts).
   */
  parent: { key: string; title: string | null } | null;
  stageCurrent: string | null;
  agentState: string | null;
  /** Resolved running-session identity and whether an in-place switch is safe. */
  agentSession: AgentSessionView;
  stepper: StepperCell[];
  /**
   * The stepper cell the ticket currently sits on — the one the "Now" line
   * and the blocked banner (§ blocked state visible) both
   * describe. `currentStage.blocked` is set only while a gate stage (uat,
   * review) sits parked (`parkGateStage`/`clearStageBlock`,
   * `store/stageBlocks.ts`) — the webview reads it directly to show the
   * banner and pass its `stageKey` back on the Resume click. Null when the
   * ticket sits at no stage at all.
   */
  currentStage: StepperCell | null;
  /**
   * The header's ship workflow-action slot (model/shipSlot.ts) — the Now line's
   * ship branch, lifted to the header. The states are mutually exclusive.
   */
  ship: ShipSlot;
  /**
   * The agent-switch choices the header popover renders: every implemented core
   * (canonical label) and each core's model choices, keyed by provider id. The
   * webview cannot import TS, so the catalog arrives here, host-resolved.
   * `modelsByCore` is the FULL model catalog (models + their advertised
   * efforts) the shared agent identity picker renders from; `models` keeps the
   * flattened legacy shape. `recentByCore` is the models most recently used per
   * provider (newest first, ≤5) for the picker's "Last used" group. `effort`
   * is the resolved current effort/variant, and the `*InheritLabel`s name the
   * switch popover's inherit rows.
   */
  agentSwitch: {
    cores: { id: AgentProvider; label: string }[];
    models: Record<string, { model: string | null; label: string }[]>;
    modelsByCore: ModelCatalog;
    recentByCore: Record<string, string[]>;
    effort: string | null;
    modelInheritLabel: string;
    effortInheritLabel: string;
  };
  servers: ServerView[];
  /** False when nothing in scope declares a service — nothing can ever start. */
  hasRunnableRepos: boolean;
  worktrees: WorktreeView[];
  /**
   * The pull requests, already worded: from-to branches, opened/merged stamps,
   * comments, and whether merging is offered (`model/prPanelView.ts`). Rendered
   * host-side like every other piece of dashboard copy — the webview is
   * standalone HTML and cannot import the formatter, so a webview-side format
   * would be untested and would drift from the ship strip's.
   */
  prs: PrPanelRow[];
  /**
   * Current mergeability per repo — the same verdicts the ship strip renders,
   * lifted to the top level because the PR panel is where a conflict is acted on
   * and a standalone webview cannot read the store. Fully worded here
   * (`model/mergeCheckPanel.ts`) so the panel cannot phrase a verdict of its own.
   * A repo with no row was never checked; absence renders as nothing, never as
   * clean.
   */
  mergeChecks: MergeCheckPanelRow[];
  /** Configured ticketing provider ('clickup' | 'manual'); null when unknown. */
  provider: string | null;
  /** The board ref the ticket was fetched from, or null. */
  sourceRef: string | null;
  /** External board URL for the ticket, or null (manual/unfetched → no link). */
  ticketUrl: string | null;
  /** Provider-native priority label (e.g. 'urgent'); null when not exposed. */
  priority: string | null;
  /**
   * The user's authored instruction (the `description` column) — the prompt a
   * manual ticket was created from. Previewed in the ticket-data drawer when
   * the ticket has no fetched brief (a manual ticket bound via "Create in
   * ClickUp" gets a provider ref but never a brief).
   */
  description: string | null;
  /** Synthesized context brief, shown in the header's ticket-data preview drawer; or null. */
  brief: string | null;
  /**
   * The stage graph as it is drawn: one segmented track the ticket travels
   * through, each segment carrying its own status, whether the ticket is there,
   * whether it is blocked on the user, and — on the gate that was retried — the
   * fix loop's meter. `stepper` above stays the flat canonical projection.
   */
  rail: StageRail;
  /**
   * The six-stage inside presentation (the inside redesign): one process-led
   * view per INSIDE stage, built by the pure reducers. `fix` is not a stage
   * here — it is projected onto the stage it returns to (`presentedStage`) —
   * so this map has EXACTLY six keys and never a peer `fix` entry.
   */
  insideViews: Record<InsideStageKey, InsideStageView>;
  /**
   * The inside stage presented as CURRENT. When the runtime ticket sits at
   * `fix`, this is the stage the fix is causally attached to (the source stage
   * of the active recovery round) — the six-stage model has no Fix stage to
   * present.
   */
  presentedStage: InsideStageKey;
  /**
   * The approach driving impl, the workflow phases it DECLARES, and the phases
   * the agent actually REPORTED by running a marker command.
   *
   * Declared is not observed — impl exposes no deterministic sub-signal (the
   * no-inference guarantee), so `phases` describes what the agent was asked to
   * do. `reported` is the one thing that may fill a phase pip: a phase mark is a
   * fact with a timestamp, the same class of evidence as the impl done marker,
   * and its absence stays evidence of nothing. Read through the SAME derivation
   * the Inside strip lists (`reportedPhases`) — two answers to "which phase is
   * the agent in" is the same class of bug as two answers to needs-you.
   */
  approach: { id: string; phases: string[]; reported: string[] } | null;
  /**
   * The ticket's semantic artifacts (model/artifacts.ts), in semantic-priority
   * order — the shelf's previews are `slice(0, 3)` of this array. Empty while
   * the ticket has no durable output; the webview renders NO section then
   * (spec §4.1: absence, never an empty state). The detail body rides each
   * summary, so the webview renders detail locally and never round-trips an
   * `artifact.get`.
   */
  artifacts: ArtifactSummary[];
  /**
   * The "Send back to Implement" recovery action's availability for the
   * CURRENT stage, host-derived (`workflow/sendBack.ts`) in the same snapshot
   * as the merge gate so the header and the action never disagree. The webview
   * renders the current stage header's ⋯ menu ONLY when this is available,
   * keyed to the stage whose header hosts it — scope/impl/fix/done, an
   * in-flight run, or a landed ship offer no menu at all.
   */
  sendBack: SendBackState;
}

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
  const rounds = listRecoveryRounds(store, ticketId);
  const resolvedProvider = resolveProvider(ticket.agentProvider, defaultProvider);
  const agentSession = buildAgentSessionView({
    provider: resolvedProvider,
    ticketModel: ticket.model,
    defaultModel: agentContext.defaultModel ?? null,
    ticketEffort: ticket.effort,
    defaultEffort: agentContext.defaultEffort ?? null,
    catalog: agentContext.modelCatalog ?? bundledModelCatalog(),
    stageCurrent: ticket.stageCurrent,
    fixExecutionActive: rounds.some((round) => round.status === 'fixing'),
  });
  const stepper = buildStepper(ticket.stages);
  const currentStage = stepper.find((c) => c.stageKey === ticket.stageCurrent) ?? null;

  const catalog = agentContext.modelCatalog ?? bundledModelCatalog();
  const recentByCore = listRecentlyUsedModels(store, ticket.projectId, 5);
  const switchModels: Record<string, { model: string | null; label: string }[]> = {};
  for (const id of IMPLEMENTED_PROVIDERS) {
    switchModels[id] = agentSwitchModelChoices({
      provider: id,
      ticketModel: ticket.model,
      defaultModel: agentContext.defaultModel ?? null,
      catalog,
    }).map(({ model, label }) => ({ model, label }));
  }
  // The shared picker's inherit rows name the RESOLVED defaults, like the
  // legacy model choices did. Effort inherits the manifest default when the
  // ticket has none.
  const inheritedEffort = resolveEffortForProvider(
    resolvedProvider,
    ticket.effort,
    agentContext.defaultEffort ?? null,
    agentSession.modelId ?? undefined,
    catalog,
  );
  const effortInheritLabel = inheritedEffort ? `Inherit (settings: ${inheritedEffort})` : 'No effort (agent picks)';
  const modelInheritLabel = agentSession.modelLabel === 'Agent default'
    ? 'No default (agent picks)'
    : agentSession.modelLabel;

  const worktrees = listWorktreesByTicket(store, ticketId).map((w) => ({
    ...w,
    repoDisplay: repoDisplayPath(w.repo, pathContext),
    launchable: isCheckout(w.path),
  }));

  // ONE clock read per push: the PR stamps, the merge rows and the stage strip
  // must not date from different instants.
  const now = nowIso();

  // Rendered through the SAME path-display preference as the worktree rows: the
  // ship stage names the same directories, and two formats for one path is the
  // bug this replaces.
  const prs = listPrsByTicket(store, ticketId).map((p) => ({
    ...p,
    repoDisplay: repoDisplayPath(p.repo, pathContext),
  }));
  // Read ONCE and share: the PR panel and the ship strip must never describe the
  // same three-valued fact from two different reads.
  const mergeChecks = listMergeChecksByTicket(store, ticketId);
  const phases = approachPhases(ticket.approach);

  // ONE read of the merge gate for the whole snapshot: the Now line and the
  // track's needs-you wording must not describe the same three-valued fact from
  // two different reads.
  const mergeGate = mergeGateState(store, ticketId);
  // The repos whose CURRENT PR karst currently offers to merge, from the SAME
  // current-PR read the gate uses. This is the rail's licence to ACT on a single
  // waiting repo; without it the track-level Merge would fire an irreversible
  // command the PR panel's own disabled button would refuse (draft/closed/
  // unknown PRs). `status === 'open'` is exactly `canMerge` for a current PR
  // (a recorded url is guaranteed by `listCurrentPrsByTicket`).
  const mergeableRepos = listCurrentPrsByTicket(store, ticketId)
    .filter((p) => p.status === 'open')
    .map((p) => p.repo);
  // The dashboard's PR rows, host-worded and host-decided like every other
  // panel string. Hoisted so the rail and the panel share one mergeability read.
  const prRows = buildPrPanelRows(prs, now, repoNameFor);
  // ONE read of the recovery action's availability, for the same reason: the
  // stage header's ⋯ menu and the host's confirm path must agree about whether
  // "Send back to Implement" exists at all. Derived here rather than on click
  // so a stale panel can never offer an action the host would refuse — and the
  // host re-derives it before mutating anyway.
  const sendBack = sendBackState(store, ticketId);
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

  // The console (terminal detailed mode) is offered for a gate stage that
  // actually has a recorded artifact log — never for a stage that has not
  // run, and never for non-gate stages (UI-R31: availability is host-derived).
  const consoleFor = (key: GateStage): boolean => !!cellOf(key).artifactPath;

  // The stage the six-stage presentation shows as CURRENT: `fix` projects onto
  // the stage its active recovery round is causally attached to.
  const fixFallback: 'uat' | 'review' =
    rounds.find(
      (r) => r.status === 'pending' || r.status === 'fixing' || r.status === 'revalidating',
    )?.sourceStage ?? 'uat';
  const presentedStage: InsideStageKey =
    ticket.stageCurrent === null || ticket.stageCurrent === 'fix'
      ? insideStageForRuntimeStage(
          (ticket.stageCurrent === 'fix' ? fixFallback : 'scope') as StageKey,
          fixFallback,
        )
      : insideStageForRuntimeStage(ticket.stageCurrent as StageKey, fixFallback);

  const insideViews: Record<InsideStageKey, InsideStageView> = {
    scope: stageView(
      'scope',
      cellOf('scope'),
      scopeProcesses(cellOf('scope'), ticket.selectedRepos, worktrees, now, processRuns, tokensFor('prefill')),
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
          timeline
            ? readSegmentTokenTotals(store, timeline.run.id).map((t) => ({
                implementationSegmentId: t.implementationSegmentId,
                total: t.totalTokens,
                cacheRead: t.cacheReadTokens,
              }))
            : [],
        ),
        // The graph runtime's read-only projection (Slice 2 Task 10):
        // appended when the host supplies it, inert otherwise.
        ...(graphInsideProcess(graphInside) ? [graphInsideProcess(graphInside)!] : []),
      ],
      now,
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
        services: serviceNames(ticketId),
        now,
        configured: assignmentFor('tester'),
        tokens: tokensFor('tester'),
        attach,
        resolvedGates: resolvedGates?.uat ?? [],
        // The gate rows name the service the way Settings names it, never the
        // path the evidence table keys by — the same injection ship uses.
        repoNameFor,
      }),
      now,
      consoleFor('uat'),
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
        services: serviceNames(ticketId),
        now,
        configured: assignmentFor('review'),
        tokens: tokensFor('review'),
        attach,
        resolvedGates: resolvedGates?.review ?? [],
        repoNameFor,
      }),
      now,
      consoleFor('review'),
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
      }),
      now,
    ),
    done: doneStageView(
      cellOf('done'),
      doneReceipt({
        stageCurrent: ticket.stageCurrent === 'done' ? 'done' : 'ship',
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

  return {
    ticketId: ticket.id,
    key: ticket.key,
    title: ticket.title,
    parent,
    stageCurrent: ticket.stageCurrent,
    agentState: ticket.agentState,
    agentSession,
    stepper,
    currentStage,
    ship: buildShipSlot(currentStage, 'repos' in mergeGate ? mergeGate : undefined),
    agentSwitch: {
      cores: agentSwitchCoreChoices(),
      models: switchModels,
      modelsByCore: catalog,
      recentByCore,
      effort: agentSession.effort,
      modelInheritLabel,
      effortInheritLabel,
    },
    servers: listServersByTicket(store, ticketId),
    // Drives whether "Start servers" is offered at all. A ticket scoping only
    // non-runnable repositories can never have a server, so presenting a live
    // Start button there is a dead affordance dressed as an available action.
    hasRunnableRepos: ticket.selectedRepos.some((r) => isRepoRunnable(r)),
    worktrees,
    prs: prRows,
    mergeChecks: buildMergeCheckPanelRows(mergeChecks, now),
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
  };
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
