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
import type { TicketProvider, AgentProvider, Severity } from '../../manifest/types.js';
import { providerTicketUrl } from '../../integrations/ticketUrl.js';
import { buildStepper, displayStatus, type StepperCell } from '../../model/stepper.js';
import { buildShipSlot, type ShipSlot } from '../../model/shipSlot.js';
import { resolveProvider } from '../../agent/registry.js';
import { IMPLEMENTED_PROVIDERS } from '../../agent/provider.js';
import { resolveEffortForProvider } from '../../agent/models.js';
import type { AgentDefaults } from '../../agent/agentPresets.js';
import { AGENT_PROVIDER_LABELS } from '../../model/agentIdentity.js';
import { buildStageRail, type StageRail } from '../../model/stageRail.js';
import { listGateRuns } from '../../store/gateRuns.js';
import { listFindings, findingsForAttempt } from '../../store/reviewFindings.js';
import { listPhaseMarks } from '../../store/phaseMarks.js';
import { listMergeChecksByTicket } from '../../store/mergeChecks.js';
import { listCurrentPrsByTicket } from '../../store/prs.js';
import type { GateStage } from '../../store/ticketGates.js';
import { getEnvOverrides, type TicketEnvOverrides } from '../../store/ticketEnvOverrides.js';
import { mergeGateState } from '../../workflow/mergeGate.js';
import { sendBackState, type SendBackState } from '../../workflow/sendBack.js';
import { retryGateState, type RetryGateState } from '../../workflow/retryGate.js';
import { prFeedbackFixState, type PrFeedbackFixState } from '../../workflow/prFeedbackFix.js';
import { countOpenPrFeedback } from '../../store/prFeedback.js';
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
import { listGateAttempts, type AttemptKey, type GateAttemptView } from '../../model/inside/rounds.js';
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
  /**
   * Resolve the effective agent defaults for a ticket's preset, so the displayed
   * session identity matches what a launch would use. Injected — the state
   * builder never reads the manifest. Absent → the legacy `defaultModel` /
   * `defaultEffort` above, which is exactly the pre-preset behavior.
   */
  defaultsFor?: (ticketPreset: string | null, ticketProvider: AgentProvider | null) => AgentDefaults;
}

/**
 * A worktree row for the scope card, plus what its base-branch control needs
 * (§ per-repo base branch — live change): the manifest's resolved default (so
 * the row can mark an override, same "changed" affordance the ticket-form
 * picker uses) and the candidate branches for its combobox — the SAME shape
 * Task 8's `RepoBaseRow.candidates` carries, so the two surfaces read as one
 * idea. Candidates are loaded lazily host-side and empty until warmed; the
 * input stays free text either way.
 */
export interface DashboardWorktreeView extends WorktreeView {
  /** The manifest's resolved default branch for this repo (never the override). */
  baseDefault: string;
  /** Local heads + `origin/*`, loaded lazily. Never a closed vocabulary. */
  baseCandidates: string[];
  /** The manifest repository name for this repo's path (host-resolved). */
  serviceName: string | undefined;
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
  paused: boolean;
  pausedAt: string | null;
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
    /**
     * The manifest's default agent core — the core `modelInheritLabel` and
     * `effortInheritLabel` describe. The picker offers those inherit rows only
     * while the picked core IS this one (a Claude default is not inheritable
     * under opencode). Null when the host declares no default core.
     */
    inheritCore: AgentProvider | null;
  };
  servers: ServerView[];
  /** False when nothing in scope declares a service — nothing can ever start. */
  hasRunnableRepos: boolean;
  /**
   * The ticket's env overrides and the services they may be set for.
   *
   * `services` is the ticket's own runnable repositories, in scope order — the
   * editor offers exactly the services this ticket can start, so a scope can
   * never be typed for a repository the ticket does not have. `values` is what
   * is saved today, keyed by that name or by `*` (every service). These are
   * merged into a service's spawn env at the next spin; nothing here ever
   * touches a repository's own `.env` on disk.
   */
  envOverrides: { services: string[]; values: TicketEnvOverrides };
  worktrees: DashboardWorktreeView[];
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
  /**
   * The "Retry gate" recovery action's availability for the CURRENT stage,
   * host-derived (`workflow/retryGate.ts`) in the same snapshot as sendBack.
   * The webview renders the retry option in the stage menu when available.
   */
  rerunGate: RetryGateState;
  /**
   * The "Address pull request feedback" recovery action's availability for the
   * ship stage, host-derived (`workflow/prFeedbackFix.ts`) in the same snapshot
   * as sendBack. The webview renders the menu option when available, so the
   * host's verdict and the control never disagree.
   */
  prFeedbackFix: PrFeedbackFixState;
  /**
   * How many review items are open on this ticket's pull requests — live,
   * unresolved, not withdrawn. Carried on the snapshot (the same read the menu
   * gate uses) so the panel and the host cannot disagree about how "open" is
   * defined; the `awaiting-merge` blocker line itself stays `mergeGate.ts`'s.
   */
  openPrFeedback: number;
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
  const rounds = listRecoveryRounds(store, ticketId);
  const defaults = agentContext.defaultsFor?.(ticket.agentPreset, ticket.agentProvider) ?? {
    provider: defaultProvider ?? 'claude',
    model: agentContext.defaultModel ?? undefined,
    effort: agentContext.defaultEffort ?? undefined,
  };
  // `defaultsFor` already folds the ticket provider into `defaults.provider`;
  // without it (no manifest) the ticket's own provider still wins over the
  // manifest default, so the resolve stays here.
  const resolvedProvider = resolveProvider(ticket.agentProvider, defaults.provider);
  const agentSession = buildAgentSessionView({
    provider: resolvedProvider,
    ticketModel: ticket.model,
    defaultModel: defaults.model ?? null,
    ticketEffort: ticket.effort,
    defaultEffort: defaults.effort ?? null,
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
    // A preset is a (core, model) pair: its model is the default only for the
    // preset's OWN core. Resolve per core so switching to another core does not
    // inherit — and cannot prefill — the preset's model.
    const coreDefaults = agentContext.defaultsFor?.(ticket.agentPreset, id) ?? defaults;
    switchModels[id] = agentSwitchModelChoices({
      provider: id,
      ticketModel: ticket.model,
      defaultModel: coreDefaults.model ?? null,
      catalog,
    }).map(({ model, label }) => ({ model, label }));
  }
  // The shared picker's inherit rows name the RESOLVED defaults, like the
  // legacy model choices did. Effort inherits the manifest default when the
  // ticket has none.
  const inheritedEffort = resolveEffortForProvider(
    resolvedProvider,
    ticket.effort,
    defaults.effort ?? null,
    agentSession.modelId ?? undefined,
    catalog,
  );
  const effortInheritLabel = inheritedEffort ? `Inherit (settings: ${inheritedEffort})` : 'No effort (agent picks)';
  const modelInheritLabel = agentSession.modelLabel === 'Agent default'
    ? 'No default (agent picks)'
    : agentSession.modelLabel;

  const worktrees: DashboardWorktreeView[] = listWorktreesByTicket(store, ticketId).map((w) => ({
    ...w,
    repoDisplay: repoDisplayPath(w.repo, pathContext),
    launchable: isCheckout(w.path),
    baseDefault: baseBranchDefaultFor(w.repo),
    baseCandidates: baseBranchCandidatesFor(w.repo),
    serviceName: repoNameFor(w.repo),
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
  // The dashboard's PR rows, host-worded and host-decided like every other
  // panel string. Hoisted so the rail and the panel share one mergeability read.
  const prRows = buildPrPanelRows(prs, now, repoNameFor);
  // The repos whose CURRENT PR karst currently offers to merge. This is the rail's
  // licence to ACT on a single waiting repo, so it must be scoped exactly like the
  // Merge the rail would fire: to the repo's CURRENT PR (`listCurrentPrsByTicket`,
  // the one `CURRENT_PR_ORDER` rule `findTicketPr` also applies), never to every
  // historical row a re-shipped repo still carries. Within that scope the verdict
  // is read off the panel rows' own `canMerge` — one answer to "may this repo be
  // merged". Two would let the rail fire an irreversible merge the panel's own
  // button refuses (GitHub reports it blocked, or an older open row lingers beside
  // the draft the repo now means).
  const currentPrKeys = new Set(
    listCurrentPrsByTicket(store, ticketId).map((p) => `${p.repo}\u0000${p.url}`),
  );
  const mergeableRepos = prRows
    .filter((p) => p.url !== null && currentPrKeys.has(`${p.repo}\u0000${p.url}`))
    .filter((p) => p.canMerge)
    .map((p) => p.repo);
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
    // nothing). The newest attempt carries no note; there is nothing to warn
    // about when the tab selected is the one already live.
    const attemptNote = effective.latest
      ? undefined
      : effective.round !== undefined
        ? `viewing round ${effective.round} — not the current result`
        : `viewing ${effective.label} — not the current result`;
    return {
      // The LATEST tab is the default path, so it selects `null` — not its own
      // key. A key restricts every downstream read to rows that carry a stage
      // run id, and a `process_runs` row written before v25 carries none:
      // selecting the latest key would have emptied the Tester/Review evidence
      // of exactly the view that renders by default. `null` is the read the
      // panel has always done, so the default view stays byte-for-byte itself
      // and only a HISTORICAL selection narrows anything.
      selectedKey: effective.latest ? null : effective.key,
      view: {
        attempts,
        selectedAttempt: effective.key,
        ...(attemptNote ? { attemptNote } : {}),
      },
    };
  };

  // The console (terminal detailed mode) is offered for a gate stage with
  // something to show: a recorded artifact log, OR a run in flight — the gate
  // lane streams live (`GateConsole`), and gating on the artifact alone hid
  // the console for exactly the window the live preview exists to cover.
  // Never for a stage that never ran, and never for non-gate stages (UI-R31:
  // availability is host-derived).
  const consoleFor = (key: GateStage): boolean =>
    !!cellOf(key).artifactPath || displayStatus(cellOf(key)) === 'running';

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
  });
  const uatSwitch = attemptSwitcherFor(uatAttempts, attemptSelection?.uat);
  const reviewAttempts = listGateAttempts({
    gateRuns,
    processRuns,
    rounds,
    stageKey: 'review',
    running: displayStatus(cellOf('review')) === 'running',
    currentAttempt: reviewCurrent ?? null,
  });
  const reviewSwitch = attemptSwitcherFor(reviewAttempts, attemptSelection?.review);

  // Hoisted once each — `supersededNote` is otherwise called twice per stage
  // below (once to decide the merge, once to build the note-only fallback).
  const uatNote = supersededNote('uat');
  const reviewNote = supersededNote('review');

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
          // The ticket's own `agent_state === 'waiting'` — the agent asked
          // the user a question and is blocked on the answer. Threaded in
          // explicitly, never re-derived: it is the same fact
          // `cli/stage.ts`'s `assertMarkerNotWhileWaiting` refuses the done
          // marker on.
          ticket.agentState === 'waiting',
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
        selectedAttempt: uatSwitch.selectedKey,
        currentAttempt: uatCurrent,
        findingsRepo: findingsRepoSelection?.uat ?? null,
      }),
      now,
      consoleFor('uat'),
      uatSwitch.view
        ? uatSwitch.view.attemptNote
          ? uatSwitch.view
          : { ...uatSwitch.view, ...(uatNote ? { attemptNote: uatNote } : {}) }
        : uatNote
          ? { attemptNote: uatNote }
          : undefined,
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
        selectedAttempt: reviewSwitch.selectedKey,
        currentAttempt: reviewCurrent,
        findingsRepo: findingsRepoSelection?.review ?? null,
      }),
      now,
      consoleFor('review'),
      reviewSwitch.view
        ? reviewSwitch.view.attemptNote
          ? reviewSwitch.view
          : { ...reviewSwitch.view, ...(reviewNote ? { attemptNote: reviewNote } : {}) }
        : reviewNote
          ? { attemptNote: reviewNote }
          : undefined,
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
        findings: findingsForAttempt(
          store,
          ticketId,
          ticket.stages.find((s) => s.stageKey === 'review')?.attempt ?? 0,
        ),
        findingsBlockingSeverity,
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
    paused: ticket.pausedAt !== null,
    pausedAt: ticket.pausedAt,
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
      inheritCore: defaultProvider ?? null,
    },
    servers: listServersByTicket(store, ticketId),
    // Drives whether "Start servers" is offered at all. A ticket scoping only
    // non-runnable repositories can never have a server, so presenting a live
    // Start button there is a dead affordance dressed as an available action.
    hasRunnableRepos: ticket.selectedRepos.some((r) => isRepoRunnable(r)),
    envOverrides: {
      services: ticket.selectedRepos.filter((r) => isRepoRunnable(r)),
      values: getEnvOverrides(store, ticketId),
    },
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
