import * as vscode from 'vscode';
import { readFileSync, mkdirSync, existsSync, writeFileSync, statSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  lstat as fsLstat,
  readFile as fsReadFile,
  readlink as fsReadlink,
  realpath as fsRealpath,
} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { openStore, type Store } from './store/db.js';
import { runImmediateTransaction } from './store/transactions.js';
import { describeStoreOpenFailure } from './extension/storeOpenFailure.js';
import { watchExternalChanges } from './store/externalChanges.js';
import { SidebarViewManager } from './ui/sidebar/panel.js';
import { makeSidebarViewHost, SIDEBAR_VIEW_ID } from './ui/sidebar/host.js';
import { ActiveTicketTracker } from './ui/activeTicket.js';
import { FACETS, facetCounts } from './ui/sidebar/facets.js';
import { openTicketFromList } from './ui/sidebar/navigation.js';
import { DashboardManager, type DashboardPanel, type PanelHost } from './ui/dashboard/panel.js';
import type { DashboardActions } from './ui/dashboard/messages.js';
import type { AgentProcessId } from './ui/dashboard/messages.js';
import { makeWorktreeActions } from './ui/dashboard/worktreeActions.js';
import { loadWorktreeStats } from './ui/dashboard/worktreeStats.js';
import { buildGateOptionsLoader } from './ui/dashboard/gateOptions.js';
import { readStageLog } from './ui/dashboard/stageLogReader.js';
import {
  TicketChangesManager,
  type ChangesPanel,
  type ChangesPanelHost,
} from './ui/diffs/panel.js';
import {
  StaleDiffTargetError,
  TextDiffUnavailableError,
  inspectWorktree,
  prepareDiff,
  type DiffTarget,
  type PreparedDiffResource,
} from './ui/diffs/git.js';
import { buildTicketChangesSnapshot } from './ui/diffs/snapshot.js';
import {
  DisposableBag,
  type VirtualDocumentAttempt,
  VirtualDocumentRegistry,
} from './ui/diffs/hostResources.js';
import {
  deferSessionRetry,
  KARST_LAUNCH_ENV,
  SessionManager,
  ticketIdFromTerminalEnv,
  type TerminalHost,
  type SessionTerminal,
  type SessionIdentity,
  type OpenSessionOptions,
  type RestoredSession,
  type RestoredSessionDisposition,
} from './ui/session.js';
import {
  forgetSessionTerminal,
  identifyTerminal,
  parseSessionTerminalRecords,
  pruneSessionTerminals,
  rememberSessionTerminal,
  type DurableSessionIdentityLookup,
  type SessionTerminalRecord,
  type TerminalIdentity,
} from './ui/terminalIdentity.js';
import { closeDoneTerminalsOf, type DoneTerminalProbe } from './ui/doneTerminals.js';
import { TerminalDashboardBinder } from './ui/bind/binder.js';
import {
  classifyRestoredSession,
  planSessionRecovery,
  recoverSession,
  recoveryOutcomeDisposition,
  sessionOwnershipAction,
  SerializedStateWriter,
  SessionRecoveryLifecycle,
  shouldApplySessionHookState,
  type RecoveryCandidate,
} from './ui/sessionRecovery.js';
import { resolveAdapter, resolveProvider } from './agent/registry.js';
import {
  resolveProcessAssignment,
  type DriveProcessBundle,
  type ProcessAssignmentSnapshot,
} from './agent/processAssignment.js';
import {
  PROMPT_BEARING_ROLES,
  type ProcessRole,
} from './manifest/validate/processAssignments.js';
import { runProcess } from './workflow/gates/run.js';
import {
  recordSessionLaunchIntent,
  failSessionLaunchIntent,
  getSessionLaunchIntent,
} from './store/sessionLaunchIntents.js';
import {
  recordFixLaunchIntent,
  recoveryDecision,
  listRecoveryRounds,
  interruptActiveFixExecution,
  reconcileStrandedFixRounds,
  describeStrandedFixRound,
  parkFixStage,
  hasFixingRound,
  FIX_PARKED_PROCESS_UNAVAILABLE,
  FIX_PARKED_NO_EXECUTION,
} from './store/recoveryRounds.js';
import type { AgentAdapter, Materialized } from './agent/adapter.js';
import { bundledModelCatalog } from './agent/modelCatalog.js';
import type { ModelCatalog } from './agent/modelCatalog.js';
import { applyAgentSwitchSelection } from './agent/sessionSwitch.js';
import {
  catalogDiagnosticSeverity,
  formatCatalogDiagnostic,
  loadModelCatalog,
} from './agent/modelCatalogLoader.js';
import { makeMementoCatalogCache } from './agent/modelCatalogCache.js';
import { buildSessionSeed } from './agent/seed.js';
import { shouldResumeSession } from './agent/resumeDecision.js';
import { markerStageFor, type MarkerStage } from './agent/markerStage.js';
import { renderFixBrief } from './agent/fixBrief.js';
import {
  agyWatchTick,
  findConversationForWorktree,
  openAgyConversationDb,
  resolveAgyAppDataDir,
  type AgyConversationSnapshot,
  type AgyWatchState,
} from './agent/agyConversationWatch.js';
import {
  agyUsageTick,
  type AgyConversationUsage,
  type AgyUsageState,
} from './agent/agyUsageWatch.js';
import {
  resolveClaudeProjectsDir,
  transcriptPathFor,
  parseClaudeTranscript,
  claudeTranscriptTick,
  type ClaudeTranscriptSnapshot,
  type ClaudeWatchState,
} from './agent/claudeTranscriptWatch.js';
import type { HookPayload } from './hooks/dispatch.js';
import { dispatchHook } from './hooks/dispatch.js';
import type { StageKey } from './model/types.js';
import { buildTicketContext, renderTicketContext } from './context/ticketContext.js';
import { resolveEffortForProvider, resolveModelForProvider } from './agent/models.js';
import { terminalTicketName } from './store/ticketLabelTemplate.js';
import { compactTicketLabel } from './model/followUp.js';
import { ticketGlyph } from './model/ticketGlyph.js';
import { glyphIconPath } from './ui/glyphIcon.js';
import { brandIconPaths, type BrandIconPaths } from './ui/brandIcon.js';
import { brandIconUri } from './ui/panelIcon.js';
import { terminalNaming } from './ui/terminalNaming.js';
import { StatusBarManager } from './ui/statusBar.js';
import { attentionItems, AttentionManager, type AttentionItem } from './ui/attention.js';
import { composeContextCommand } from './cli/context.js';
import { composeStageCommand } from './cli/stage.js';
import { composePhaseCommand } from './cli/phaseCommand.js';
import { composeGuideCommand, renderGuideInstruction } from './cli/guide.js';
import {
  buildWorkflowInvocation,
  renderWorkflowCommand,
  renderDoneMarkerInstruction,
  KARST_PLUGIN_NAME,
  orchestratorCommandBasename,
} from './agent/workflowCommand.js';
import { startHookEndpoint, type HookEndpoint } from './hooks/endpoint.js';
import { startGraphWakeupEndpoint, type GraphWakeupEndpoint } from './hooks/graphEndpoint.js';
import { runCoordinatorTick, activeGraphRunIds } from './approaches/graph/coordinator/sweep.js';
import { reconcilableGraphRunIds } from './approaches/graph/coordinator/reconcileScope.js';
import {
  reconcileGraphRun,
  type ReconcileGraphRunDeps,
} from './approaches/graph/coordinator/reconcile.js';
import { discardUnknownProcess } from './approaches/graph/coordinator/discard.js';
import { beginReplanPlannerRun, electReplan } from './approaches/graph/coordinator/replan.js';
import {
  createSupervisedCliTransport,
  type SupervisedCliTransport,
  type SupervisedAgentSession,
  type TransportTerminal,
  type TransportTerminalHost,
} from './approaches/graph/transport/supervisedCliTransport.js';
import {
  activeGraphRunFor,
  nudgeSurface,
  shouldDriveGraphTicket,
  stoppableGraphRunFor,
  stopActiveGraph,
} from './approaches/graph/entryPoints.js';
import { reattachableSessionIdentity } from './approaches/graph/coordinator/reattach.js';
import { runCompletionPipeline, type CompletionPipelineDeps } from './approaches/graph/integration/pipeline.js';
import { artifactRootDir } from './approaches/graph/artifacts/snapshot.js';
import { declaredWritesFor } from './approaches/graph/integration/claims.js';
import { flipOnEndQuiescence } from './approaches/graph/coordinator/completion.js';
import { resolveGraphDiagnosticIdentity } from './approaches/graph/diagnostics.js';
import { recoverGraphRun, type RecoveryDeps } from './approaches/graph/coordinator/recovery.js';
import type { ReplanLaunchRequest } from './approaches/graph/coordinator/replan.js';
import type { BootstrapRelaunchRequest } from './approaches/graph/coordinator/recovery.js';
import { type ActivationDomain } from './approaches/graph/coordinator/leases.js';
import { activationDomainKeys, type AllowlistCommandAccess } from './approaches/graph/coordinator/conflicts.js';
import { parseGraphDocument } from './approaches/graph/parse.js';
import { nodeOverrideFor, type BaseHead } from './store/graph/nodeRuns.js';
import { cleanupTerminalNodeWorkspace } from './approaches/graph/workspace/cleanup.js';
import { allGraphRunsClosed } from './store/graph/graphRuns.js';
import { reapClosedGraphSubtrees, describeGraphReap } from './approaches/graph/retention.js';
import { reapOrphanedArtifactDirs, describeArtifactReap } from './runtime/artifactOrphans.js';
import {
  blockGraphStage,
  markGraphAwaitingImplMarker,
  fireGraphImplMarkerFromHost,
} from './workflow/graphMarkerGuard.js';
import { DEFAULT_GRAPH_LIMITS } from './manifest/graphConfig.js';
import {
  acceptSubmittedPlan,
  acceptSubmittedReplan,
  bootstrapAndLaunchPlanner,
  confirmGraphRun,
  driveReadyNodeRuns,
  launchReplanPlanner,
  plannerVocabularyFor,
  relaunchBootstrapPlanner,
  readPlannerDiagnostics,
  resolveProfileFor,
  PLANNER_SUBMIT_INSTRUCTION,
  type GraphDriverDeps,
} from './approaches/graph/driver.js';
import { runGraphCommand } from './cli/graph.js';
import { buildGraphSessionEnv } from './approaches/graph/transport/env.js';
import { createNodeWorkspace } from './approaches/graph/workspace/provider.js';
import type {
  CommandDefinition,
  CompileContext,
  ProfileTier,
  ResolvedRepository,
} from './approaches/graph/compile.js';
import type { GraphDocument } from './approaches/graph/parse.js';
import {
  domainKeyOf,
  gitCommonDirFromFs,
  resolvePhysicalDomains,
  repoWorktreeIndex,
  resolveRepoWorktrees,
  type DomainEntry,
} from './approaches/graph/integration/domains.js';
import { canonicalRepoId } from './runtime/repoId.js';
import { casStatus, GRAPH_RUN_TRANSITIONS, type GraphDb } from './store/graph/transitions.js';
import { canonicalPath } from './runtime/pathScope.js';
import { createHookChannelRecorder } from './diagnostics/hookChannel.js';
import { sweepHookSettings } from './agent/settingsSweep.js';
import { writeCurrentEndpoint } from './agent/hookFailureLog.js';
import { listWorktreesByTicket, listWorktreesByProject, serverAddress } from './store/dashboard.js';
import {
  LAUNCH_BUILD_SCRIPT,
  LAUNCH_BUILD_TIMEOUT_MS,
  isKarstCheckout,
  launchWorktreeDev,
  selectLaunchableWorktrees,
} from './commands/launchWorktree.js';
import { parseLaunchWorktreeConfig } from './commands/launchWorktreeConfig.js';
import { getDisabledGates, setDisabledGates, type GateStage } from './store/ticketGates.js';
import { latestFindingBatch } from './store/reviewFindings.js';
import { listGateRuns } from './store/gateRuns.js';
import { defaultGhRunnerAsync } from './integrations/github.js';
import { syncPrStatuses } from './workflow/prSync.js';
import { syncMergeChecks } from './workflow/mergeSync.js';
import { mergeTicketPr } from './workflow/mergePr.js';
import { settleShipGates } from './workflow/mergeGate.js';
import { autoArchiveDoneTickets } from './store/doneArchive.js';
import { capForGate, lastFailedGate, type GateStageKey } from './workflow/fixAttempts.js';
import { resumeConfiguredFixExecution } from './workflow/fixExecution.js';
import { findTicketPr } from './store/prs.js';
import { resumeBlockedStage } from './workflow/stageResume.js';
import { sendBackState, sendBackToImplement } from './workflow/sendBack.js';
import { buildConflictBrief } from './workflow/conflictSession.js';
import { stopServer, stopTicketServers } from './runtime/supervisor.js';
import { reapStaleServers, describeReap } from './runtime/worktreeServers.js';
import { systemAsyncProcessFacts } from './runtime/serverIdentity.js';
import { listBaseBranchCandidates } from './runtime/branchList.js';
import {
  changeBaseRef as changeBaseRefWorkflow,
  type ChangeBaseRefResult,
} from './workflow/changeBaseRef.js';
import { reconcileStageRuns, describeStaleStageRun } from './store/stageRuns.js';
import {
  reconcileProcessRuns,
  describeStaleProcessRun,
  openProcessRun,
  finishProcessRun,
} from './store/processRuns.js';
import { pidAlive } from './runtime/pidAlive.js';
import { archiveWorktree, restoreWorktree } from './runtime/archive.js';
import { archiveInactiveWorktrees, compactArchivedWorktrees } from './runtime/archiveBulk.js';
import { listArchives } from './store/worktreeArchives.js';
import { makePortAllocator } from './resolver/allocator.js';
import {
  defaultGitRunner,
} from './integrations/git.js';
import { loadManifest, loadManifestWithDiagnostics, type Manifest } from './manifest/load.js';
import { DEFAULT_ARCHIVE_DONE_AFTER_DAYS } from './manifest/schema.js';
import type { PathContext } from './ui/dashboard/state.js';
import { repoDisplayPath } from './ui/worktreePath.js';
import { writeRepoSignals } from './manifest/write.js';
import { isRunnable, serviceOf } from './manifest/runnable.js';
import { makeManifestCache } from './extension/manifestCache.js';
import {
  createReportIssueHandler,
  DiagnosticDocumentProvider,
  registerDiagnosticDocumentProvider,
} from './extension/reportIssue.js';
import {
  resolveManifest,
  manifestPathOrThrow,
  approachesDirOrThrow,
  agentsDirOrThrow,
  emptyManifest,
  scaffoldManifest,
} from './extension/manifestResolve.js';
import { manifestWatchTarget } from './extension/manifestWatch.js';
import { installApproach } from './approaches/fetch.js';
import {
  cancelAllNpmCommands,
  runNpmCommand,
} from './approaches/npmCommand.js';
import { resolveApproachPrompt } from './approaches/resolve.js';
import { resolveGraphPrompt } from './agent/graphPrompts.js';
import {
  approachDelta,
  isBuiltInApproachId,
  packagedApproachDefs,
  withBuiltInApproaches,
} from './approaches/withBuiltInApproaches.js';
import type {
  AgentProvider,
  ApproachDef,
  GraphApproachConfig,
  GraphCommandConfig,
} from './manifest/types.js';
import { instrumentAdapter } from './agent/instrumentedAdapter.js';
import { AgentConsole } from './agent/agentConsole.js';
import { recordTokenUsage, listRecentlyUsedModels } from './store/tokenUsage.js';
import { UsagePanelManager, type UsagePanel, type UsagePanelHost } from './ui/usage/panel.js';
import {
  ResourcesPanelManager,
  type ResourcesPanel,
  type ResourcesPanelHost,
} from './ui/resources/panel.js';
import {
  listInstalled,
  readApproachPackage,
  uninstallApproach,
  readArtifactBody,
  listArtifacts,
  type ApproachPackage,
} from './approaches/pkg.js';
import { readAgentFile, writeAgentFile, removeAgentFile } from './agents/pkg.js';
import { buildAgentPool, type PoolAgent } from './agents/pool.js';
import { spinTicket, SpinCancelledError } from './runtime/spin.js';
import { confirmScope } from './workflow/stages/scope.js';
import { transition } from './workflow/machine.js';
import { driveTicket as driveTicketRun } from './workflow/driveTicket.js';
import { DriverController, shouldStartDriver, ticketsToSweep } from './workflow/driverController.js';
import { shipTicket as runShipTicket } from './workflow/stages/ship.js';
import { shipClearedEvent, shipStepEvent, type InsideProgressEvent } from './model/inside/progress.js';
import type { InsideActionHost } from './ui/dashboard/insideActions.js';
import { buildGraphInsideInput } from './ui/dashboard/graphInside.js';
import { getPrById } from './store/prs.js';
import {
  getShipCommitById,
  listStrandedShipTickets,
  describeStrandedShip,
  reconcileShipRuns,
  describeStaleShipRun,
} from './store/shipRuns.js';
import { advanceTicketOnShip, statusPushSkipNote } from './workflow/stages/done.js';
import { advanceTicketOnStart } from './workflow/stages/start.js';
import { createFollowUpTicket, TicketNotDoneError } from './workflow/stages/followUp.js';
import {
  getTicket,
  ticketLabel,
  listTickets,
  listArchivedTickets,
  setAgentState,
  setSessionId,
  updateTicketFields,
  clearApproachFromTickets,
  archiveTicket,
  unarchiveTicket,
  pauseTicket,
  unpauseTicket,
} from './store/tickets.js';
import type { Project } from './store/projects.js';
import { getProjectBySlug } from './store/projects.js';
import { bindProject } from './project/bind.js';
import { resolveProjectSlug } from './project/slug.js';
import { listTicketLifecycle } from './store/runningServers.js';
import { TicketFormManager } from './ui/ticketForm/panel.js';
import {
  buildTicketFormActions,
  type StartTicketResult,
  type StartTicketOptions,
} from './ui/ticketForm/actions.js';
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from './attachments/kinds.js';
import { reapAttachments } from './attachments/reap.js';
import { deleteTicketPermanently } from './runtime/deleteTicket.js';
import { makeTicketFormPanelHost } from './ui/ticketForm/host.js';
import {
  makeTokenProvider,
  setToken,
  clearToken,
  hasToken,
} from './extension/secrets.js';
import { makeTicketingProvider } from './integrations/ticketing.js';
import { SettingsManager, type LoadedManifest } from './ui/settings/panel.js';
import { buildSettingsActions } from './ui/settings/actions.js';
import type { SettingsState } from './ui/settings/state.js';
import { makeSettingsPanelHost } from './ui/settings/host.js';
import { writeManifest } from './manifest/write.js';
import {
  makeBoundedLogBuffer,
  makeLogger,
  type LogError,
} from './logging/logger.js';
import { injectPalette } from './model/palette.js';
import { injectDesignSystem } from './model/designSystem.js';
import { injectCsp, newNonce } from './model/csp.js';
import { injectProviderIdentity } from './model/providerIdentity.js';
import { injectAgentIdentity } from './model/agentIdentity.js';
import { injectAgentPicker } from './model/agentPicker.js';
import { injectXterm, readXtermAssets } from './model/xtermAssets.js';
import { buildTicketArtifacts } from './model/artifacts.js';
import {
  binaryExists,
  checkDependencyFaults,
  commandSucceeds,
  dependencyRegistry,
  ensureCapability,
  renderDependencyFault,
  type Capability,
  type DependencyFault,
} from './runtime/deps.js';
import { ensureCapabilityAsync } from './runtime/depsAsync.js';
import { buildDepsIndicator } from './ui/depsIndicator.js';
import { buildResourceIndicator } from './ui/resourceStatus.js';
import { WorktreeDiskCache } from './runtime/worktreeDisk.js';
import { ResourceMonitor } from './runtime/resourceMonitor.js';
import { aiCallSiteLabel } from './agent/aiCallSites.js';
import { GettingStartedManager } from './ui/gettingStarted/panel.js';
import { buildGettingStartedActions } from './ui/gettingStarted/actions.js';
import { makeGettingStartedPanelHost } from './ui/gettingStarted/host.js';
import { buildSetupStatus } from './init/status.js';
import { buildGettingStartedState } from './ui/gettingStarted/state.js';

/**
 * Extension activation adapter — the host seam (§2.6). Everything below the UI
 * is host-agnostic and unit-tested; this file is the ONE place real `vscode`
 * APIs are bound to those interfaces. It holds no business logic — it wires
 * concrete `vscode` panels/terminals/tree + the hook endpoint into the tested
 * managers, so the extension is a thin shell over covered code.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** The shipped karst mark. `HERE` is `dist/`, so the asset sits one level up. */
const BRAND_SVG = join(HERE, '..', 'media', 'karst.svg');

/** Monochrome silhouette of the same mark, tinted by the status glyph hue. */
const MARK_SVG = join(HERE, '..', 'media', 'karst-mark.svg');

/**
 * The status-free karst mark for every panel tab, materialized once per window.
 * A panel that also carries a ticket (dashboard, bound ticket form) repaints over
 * it with the status-tinted glyph; the rest keep this. An unreadable asset
 * degrades to "no icon", never a throw — an unbranded tab is not worth failing
 * activation over.
 */
function brandTabIcon(context: vscode.ExtensionContext): BrandIconPaths | undefined {
  try {
    return brandIconPaths({
      storageDir: context.globalStorageUri.fsPath,
      assetSvgPath: BRAND_SVG,
    });
  } catch {
    return undefined;
  }
}

/**
 * Per-workspace flag: the user dismissed the fresh-install Getting Started
 * panel. The stored key keeps its legacy `karst.welcomeDismissed` spelling on
 * purpose — it is PERSISTED workspaceState, and renaming it would re-open the
 * panel for every user who had already dismissed it (glossary rename, 869ecknnn).
 */
const GETTING_STARTED_DISMISSED_KEY = 'karst.welcomeDismissed';
/**
 * The hook port this window bound last time. Rebinding it is what keeps a session
 * that outlived a host restart — it baked the old port into its `--settings` at
 * launch and never re-reads the file — from ECONNREFUSING on every hook it fires.
 *
 * `workspaceState`, NOT `globalState`: every window shares global storage, but each
 * window runs its OWN endpoint on its OWN port. With one global key the second
 * window to start hit EADDRINUSE on the first's port, fell back to an ephemeral
 * one, and wrote THAT over the shared key — so when the first window's host
 * restarted it could no longer reclaim the port its live sessions were still
 * posting to, and every one of them ECONNREFUSED for the rest of its life.
 */
const HOOK_PORT_KEY = 'karst.hookPort';
/** Tickets whose terminals this window launched, including hidden terminals. */
const OWNED_SESSION_TICKETS_KEY = 'karst.ownedSessionTickets';
/**
 * The pid this window launched each ticket's terminal under.
 *
 * `workspaceState`, like the keys above: pids name processes this window
 * started. It exists because a reattached terminal comes back WITHOUT its
 * launch environment (see `ui/terminalIdentity.ts`), so the pid is the only
 * surviving terminal→ticket link after a reload.
 */
const SESSION_TERMINALS_KEY = 'karst.sessionTerminals';
/**
 * How long a terminal gets to report its pid. Activation waits on this before
 * it may adopt a restored session, and `Terminal.processId` never settles for a
 * process that failed to start — so the wait is bounded rather than open-ended.
 */
const PID_PROBE_TIMEOUT_MS = 5_000;

/**
 * Whether this window binds a ticket's agent terminal to its dashboard.
 *
 * `workspaceState`, like the keys above and for the same reason: the surfaces it
 * binds — terminals and editor tabs — are window-local, so a global key would
 * make a second window's dashboard reveal terminals the user cannot see.
 */
const BIND_TERMINAL_KEY = 'karst.bindTerminalToDashboard';

/**
 * Global (cross-window) flag: the one-shot adoption of pre-v6 tickets has run.
 * Lives in `globalState` deliberately — the DB it guards is global too, so a
 * per-workspace flag would let the second window adopt all over again.
 */
const PROJECT_ADOPTION_KEY = 'karst.projectAdoptionDone';

/**
 * How often to re-probe open PRs for their real upstream state. A minute keeps
 * the dashboard current (acceptance §2) without hammering gh; the re-entrancy
 * guard drops a tick that overlaps a still-running sweep, so a slow probe never
 * stacks.
 */
const PR_SYNC_INTERVAL_MS = 60_000;

/**
 * How often the graph coordinator sweep ticks, independent of `runPrSync`
 * (G4). The sweep's own liveness promise — "a completion that committed to
 * the database is always eventually scheduled" — must not depend on GitHub
 * being reachable, so it no longer rides the tail of the PR sync's two
 * awaited `gh`/`git` phases. 15s is well under `PR_SYNC_INTERVAL_MS` (60s):
 * graph activations are meant to launch promptly once a token is pending,
 * and a bounded (≤ 100 transitions) tick against the local SQLite registry
 * is cheap enough to run four times as often with no network cost.
 */
const GRAPH_SWEEP_INTERVAL_MS = 15_000;

/**
 * How often the graph RECONCILE pass ticks (INFO-6) — deliberately its OWN,
 * slower cadence, separate from `GRAPH_SWEEP_INTERVAL_MS`. Reconcile probes
 * OS process liveness (async, per run) for every non-terminal run in the
 * project — materially more expensive than the coordinator tick's bounded,
 * local-SQLite-only pass. 60s is the rate BOTH shared before the 15s sweep
 * split (this is a restoration, not a new number): the coordinator tick stays
 * fast for prompt activation, and the crash-recovery pass stays at the old,
 * cheaper-for-the-OS rate. Reconcile also runs once at activation
 * (`runGraphReconcileSweep()` below), so a stalled run from a prior session is
 * still recovered promptly on open, not after a first 60s wait.
 */
const GRAPH_RECONCILE_INTERVAL_MS = 60_000;

/**
 * How stale a stored merge verdict may get before the sweep re-probes it. Unlike
 * a `gh` status call, every probe costs a `git fetch` per repo, so this rides the
 * same one-minute tick but only spends a fetch every five — recent enough that a
 * base moving under an open PR surfaces while the ticket is still on screen.
 */
const MERGE_SYNC_MIN_AGE_MS = 5 * 60_000;

let store: Store | undefined;
let endpoint: HookEndpoint | undefined;
let graphEndpoint: GraphWakeupEndpoint | undefined;
let graphCoordinatorStore: Store | undefined;
let graphTransport: SupervisedCliTransport | undefined;
const pendingApproachInstalls = new Set<Promise<ApproachPackage>>();
let flushSessionOwnership: (() => Promise<void>) | undefined;
let shutdownSessionRecovery: (() => void) | undefined;
/**
 * Torn down BEFORE `store.close()`: an in-flight changes refresh re-enters its
 * loader from a settlement handler, and that loader reads the store
 * synchronously. `context.subscriptions` is drained only after `deactivate`
 * returns, so the manager is registered there AND called here.
 */
let shutdownTicketChanges: (() => void) | undefined;
const pendingSessionRecoveryTasks = new Set<Promise<void>>();

/** Per-ticket single-flight + Stop bookkeeping for the auto-driver (§11/§12). */
const driver = new DriverController();

/** Minimal starter body for a brand-new agent file created from Settings. */
function agentStarterTemplate(name: string): string {
  return `---\nname: ${name}\ndescription: \n---\n\n# ${name}\n\nDescribe what this subagent does.\n`;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // globalStorageUri's directory isn't created for us — SQLite won't make the
  // parent dir, so ensure it exists before opening the store (first activation).
  const storageDir = context.globalStorageUri.fsPath;
  mkdirSync(storageDir, { recursive: true });
  const dbPath = join(storageDir, 'karst.db');
  try {
    store = openStore(dbPath);
  } catch (err) {
    // An ABI-mismatched better-sqlite3 addon makes `openStore` throw on the
    // FIRST `new Database()`, killing activation with a raw dlopen error and a
    // dead extension. Name the fix instead of dying silently (the modal is the
    // only surface left — the output channel is created below the store open).
    const fault = describeStoreOpenFailure(err);
    console.error('karst: activation aborted — store open failed', err);
    void vscode.window.showErrorMessage(
      fault.fixHint ? `${fault.message}\n\n${fault.fixHint}` : fault.message,
    );
    return;
  }
  const localStore = store;

  // One "Karst" output channel is the sink for every caught error.
  // Managers/endpoint get `logError`; the extension itself uses `logger`.
  const channel = vscode.window.createOutputChannel('Karst');
  context.subscriptions.push(channel);
  const diagnosticLogBuffer = makeBoundedLogBuffer();
  const logger = makeLogger(channel, undefined, diagnosticLogBuffer);
  const logError: LogError = (m, e) => logger.error(m, e);
  // Hook-channel observation for the issue report. A failed agent-side hook says
  // only "exited with code 1"; these counters are the host's half of that.
  const hookChannelRecorder = createHookChannelRecorder();
  const activatedAt = Date.now();
  logger.info('Karst activated');

  // The karst mark every panel tab wears. Materialized once per window and
  // handed to each panel host — a tab that carries no ticket has no glyph to
  // derive an icon from, and would otherwise be indistinguishable from a file.
  const brandIcon = brandTabIcon(context);

  /**
   * A base branch that could not be refreshed before its worktree was cut
   * (§ pull switch). Deliberately a warning, not an error: the ticket exists and
   * is usable — it just starts from what this clone already had, which the user
   * must be told rather than left to discover in a diff. The reason is git's own
   * first line, already bounded by `pullBaseRef`.
   */
  const warnBaseNotPulled = (repoPath: string, baseRef: string, reason: string): void => {
    const message = `Could not refresh ${baseRef} in ${repoPath} — the worktree was created from the local branch: ${reason}`;
    logger.warn(message);
    void vscode.window.showWarningMessage(message);
  };
  let modelCatalog = bundledModelCatalog();
  const modelCatalogCache = makeMementoCatalogCache(context.globalState);

  // Which ticket's view (dashboard/edit/diffs) is the window's ACTIVE view —
  // the sidebar highlights that ticket's row. The three per-ticket panel
  // managers report raw activation into it (each reports LOSING it too); the
  // sidebar re-pushes on change and reads the current answer at push time.
  const activeTicket = new ActiveTicketTracker();
  activeTicket.onDidChange(() => provider.refresh());

  // Sidebar ticket list — an HTML webview view (replaces the native tree). The
  // manager holds facet/filter + re-pushes state; its action factory maps webview
  // messages to the existing karst.* commands (executeCommand passthrough) so the
  // command handlers stay the single source of behavior.
  const provider = new SidebarViewManager(localStore, (mgr) => ({
    toggleFacet: (facet) => mgr.toggleFacet(facet),
    setFilter: (query) => mgr.setFilter(query),
    refresh: () => mgr.refresh(),
    requestState: () => mgr.refresh(),
    create: () => void vscode.commands.executeCommand('karst.openTicketForm'),
    openSettings: () => void vscode.commands.executeCommand('karst.openSettings'),
    openTicket: (id) => openTicketFromList(localStore, id, {
      edit: (ticketId) => vscode.commands.executeCommand('karst.editTicket', ticketId),
      openDashboard: (ticketId) =>
        vscode.commands.executeCommand('karst.openDashboard', ticketId),
      onError: (error) => logError(`ticket-list navigation failed for ticket ${id}`, error),
    }),
    openDashboard: (id) => void vscode.commands.executeCommand('karst.openDashboard', id),
    spin: (id) => void vscode.commands.executeCommand('karst.spinTicket', id),
    openSession: (id) => void vscode.commands.executeCommand('karst.openSession', id),
    edit: (id) => void vscode.commands.executeCommand('karst.editTicket', id),
    archive: (id) => void vscode.commands.executeCommand('karst.archiveTicket', id),
    unarchive: (id) => void vscode.commands.executeCommand('karst.unarchiveTicket', id),
    delete: (id) => void vscode.commands.executeCommand('karst.deleteTicket', id),
    // The expanded mini-dashboard's primary next action on a Done ticket (§
    // 869ehda7y): the command copies repos/approach/agent/model from the parent
    // and opens the ticket form so the user can type the follow-up ask.
    createFollowUp: (id) => void vscode.commands.executeCommand('karst.createFollowUpTicket', id),
    // The expanded mini-dashboard's "Resolve conflicts" CTA. The store decides
    // whether the conflict still exists — `repo` arrived in a webview message
    // and a stale row can name one that has since gone. Same handoff as the
    // dashboard's resolveConflicts: nudge a live session, else launch one
    // seeded with the brief (never drop the brief on an open terminal).
    resolveConflicts: (id, repo) => {
      if (!guardCapability('sessions', id)) return;
      const brief = buildConflictBrief(localStore, id, repo);
      if (!brief) {
        void vscode.window.showInformationMessage(
          `No merge conflict is recorded for "${repo}" on this ticket — nothing to resolve.`,
        );
        return;
      }
      if (sessions.nudge(id, brief)) {
        sessions.focusSession(id);
        return;
      }
      void vscode.commands.executeCommand('karst.openSession', id, { seedPrompt: brief });
    },
  }), () => worktreePathContext(currentManifest(), logger.warn, logger.info), () => currentManifest()?.ticketLabelTemplate, logError,
    () => currentProject()?.id,
    () => currentManifest()?.agentProvider,
    () => activeTicket.get());
  const { host: sidebarHost, provider: sidebarProvider, badge: sidebarBadge } =
    makeSidebarViewHost(context);
  provider.bind(sidebarHost);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, sidebarProvider),
  );

  const settingsDir = context.globalStorageUri.fsPath;
  // Each launch writes a hook-settings file named after this window's ephemeral
  // port, so stale ones pile up. Best-effort, never fatal.
  try {
    const swept = sweepHookSettings(settingsDir);
    if (swept > 0) logger.info(`karst: swept ${swept} stale hook-settings file(s)`);
  } catch (err) {
    logError('karst: hook-settings sweep failed', err);
  }
  // Stale-server sweep: a hot service whose working directory is gone cannot be
  // serving anything valid, yet it keeps its port bound and its memory held —
  // detached, reparented to init, unreachable by any hangup (869ed2n50).
  // `removeWorktree` reaps the servers it removes the tree out from under, so
  // this covers only what that cannot see: an already-leaked process from an
  // older build, and a worktree removed by something other than karst (a hand-run
  // `git worktree remove`, the IDE's git extension, an `rm -rf`). Reported, never
  // silent — waste nothing surfaces is how two ~1 GB servers ran for three days.
  //
  // GLOBAL, not project-scoped, for the same reason `reconcileOnStart`'s server
  // pass is: the registry is shared by every window, and a server serving a
  // deleted tree is wrong in whichever project owns it — scoping the sweep would
  // leave it running until that project's window happened to open, which for an
  // abandoned project is never. What makes that safe is not the scope but the
  // attribution: `serverIdentity.ts` requires evidence that the live pid is
  // still the recorded server, so this can never signal another window's live
  // process, let alone a stranger's. Rows it cannot attribute are cleared, not
  // killed, and every line says which path it acted on.
  try {
    for (const s of reapStaleServers(localStore, {
      debug: (message) => logger.debug(message),
    })) logger.info(describeReap(s));
  } catch (err) {
    logError('karst: stale-server sweep failed', err);
  }
  // Stale gate-run sweep (F3). A gate run is now opened durably before its first
  // gate starts, so a run whose extension host died mid-flight is still on
  // record as `running` — a state nothing can leave on its own, since process
  // death fires no abort signal and the `stopped` path therefore never ran.
  // Marking it `stale` is what turns "a stage that has been running for 37
  // minutes with nothing to show" into "the previous run was destroyed; this is
  // a fresh one", with the destroyed run's partial gate rows still readable.
  //
  // GLOBAL for the same reason as the server pass above, and safe for the same
  // reason: attribution, not scope. A run opened by ANOTHER LIVE window has a
  // live pid and is left strictly alone; a run with no recorded pid is left
  // alone too, because absence of evidence is not evidence that it died.
  //
  // Reported, never silent — an invisibly discarded run is the whole failure
  // this closes, and a sweep that quietly corrected the data would repeat it.
  try {
    for (const s of reconcileStageRuns(localStore, pidAlive)) {
      logger.info(describeStaleStageRun(s));
    }
  } catch (err) {
    logError('karst: stale gate-run sweep failed', err);
  }
  // Stale process-run sweep (inside redesign). The inside view renders a stage
  // as processes opened durably before they start, so a process whose
  // extension host died mid-flight is still on record as `running` — a state
  // nothing can leave on its own, since process death fires no abort signal.
  // Marking it `stale` is what turns a process that will never finish into the
  // record that it was destroyed, with its identity snapshot still readable.
  //
  // GLOBAL for the same reason as the gate-run pass above, and safe for the
  // same reason: attribution, not scope. A run opened by ANOTHER LIVE window
  // has a live pid and is left strictly alone; a run with no recorded pid is
  // left alone too, because absence of evidence is not evidence that it died.
  //
  // Reported, never silent — an invisibly-discarded run is the whole failure
  // this closes, and a sweep that quietly corrected the data would repeat it.
  try {
    for (const r of reconcileProcessRuns(localStore, pidAlive)) {
      logger.info(describeStaleProcessRun(r));
    }
  } catch (err) {
    logError('karst: stale process-run sweep failed', err);
  }
  // Stale ship-run sweep (869egdr2u-fu1 follow-up). A ship run killed by
  // process death mid-saga — the host died between opening the run and closing
  // it — is a state nothing can leave on its own: the saga's crash-and-retry
  // reconciliation only runs at the start of the next `shipTicket` invocation,
  // and a ticket at `ship` `running` with no block offers no retry anywhere
  // (the Now line shows no button for a running ship, and the driver only
  // auto-runs gates). Marking the dead run `interrupted` and parking the
  // stage `failed` is what turns that stuck state into the one that already
  // has a recovery path: the failed-ship surface's "Retry ship".
  //
  // GLOBAL for the same reason as the gate-run pass above, and safe for the
  // same reason: attribution, not scope. A run opened by ANOTHER LIVE window
  // has a live pid and is left strictly alone; a run with no recorded pid is
  // left alone too, because absence of evidence is not evidence that it died.
  //
  // Reported, never silent — an invisibly-discarded run is the whole failure
  // this closes, and a sweep that quietly corrected the data would repeat it.
  try {
    for (const s of reconcileShipRuns(localStore, pidAlive, new Date().toISOString())) {
      logger.info(describeStaleShipRun(s));
    }
  } catch (err) {
    logError('karst: stale ship-run sweep failed', err);
  }
  // Stranded fix-execution sweep. Runs AFTER the process-run pass above, which
  // is what turns a destroyed Fix run into a non-`running` row this can read:
  // a `fixing` recovery round whose execution is gone is a round nothing can
  // ever leave, and the driver answers it with "already in flight; leaving it"
  // on every trigger. Interrupting it puts the ticket back where a human can
  // act on it instead of watching a fix elapse for hours.
  //
  // Tickets whose round this sweep just interrupted are collected for the
  // activation-sweep drive below: the driver reopens the round within budget
  // and resumes the fix instead of leaving the ticket parked at fix forever.
  const strandedFixResumes = new Set<number>();
  try {
    for (const s of reconcileStrandedFixRounds(localStore, new Date().toISOString())) {
      logger.info(describeStrandedFixRound(s));
      if (s.kind === 'execution') strandedFixResumes.add(s.ticketId);
    }
  } catch (err) {
    logError('karst: stranded fix-round sweep failed', err);
  }
  // Auto-compact: compact archived worktrees older than 7 days and sweep
  // orphan branches/refs. Rides the activation sweep like autoArchiveDoneTickets
  // — once per activation, no second interval to dispose. The compact function
  // includes the orphan-ref sweep internally.
  try {
    const compactResult = await compactArchivedWorktrees(defaultGitRunner, localStore, 7 * 24 * 60 * 60 * 1000);
    if (compactResult.compacted > 0 || compactResult.sweep.prunedBranches > 0 || compactResult.sweep.prunedArchiveRefs > 0) {
      logger.info(
        `karst: auto-compact compacted ${compactResult.compacted} archive(s), ` +
          `swept ${compactResult.sweep.prunedBranches} orphan branch(es), ` +
          `${compactResult.sweep.prunedArchiveRefs} orphan ref(s)`,
      );
    }
  } catch (err) {
    logError('karst: auto-compact failed', err);
  }
  // Graph byte-subtree and artifact-dir orphan sweeps. A ticket's graph
  // subtree and gate console-log dir are removed on hard delete, but bytes can
  // outlive the delete that should have removed them: a delete that predates
  // this wiring, an unbound project at delete time, or a foreign removal. Both
  // live in global storage OUTSIDE every worktree, so — like `reapStaleServers`
  // and for the same reason — the net is an activation sweep, GLOBAL across
  // projects, and its predicate is a READ over state the registry already
  // keeps current. A subtree whose ticket is gone (or whose every graph run is
  // `closed`) and a console dir whose ticket no longer exists are removed;
  // anything whose ticket still exists is left strictly alone. Reported, never
  // silent — unreported removal of evidence bytes is the failure this closes.
  try {
    for (const r of reapClosedGraphSubtrees(
      join(context.globalStorageUri.fsPath, 'graph'),
      {
        ticketExists: (projectSlug, ticketId) => {
          const project = getProjectBySlug(localStore, projectSlug);
          if (!project) return false;
          try {
            return getTicket(localStore, ticketId).projectId === project.id;
          } catch {
            return false;
          }
        },
        allGraphRunsClosed: (ticketId) => allGraphRunsClosed(localStore.db, ticketId),
      },
    ).removed) {
      logger.info(describeGraphReap(r));
    }
  } catch (err) {
    logError('karst: graph byte-subtree sweep failed', err);
  }
  try {
    for (const ticketId of reapOrphanedArtifactDirs(
      join(context.globalStorageUri.fsPath, 'artifacts'),
      {
        ticketExists: (ticketId) => {
          try {
            getTicket(localStore, ticketId);
            return true;
          } catch {
            return false;
          }
        },
      },
    ).removed) {
      logger.info(describeArtifactReap(ticketId));
    }
  } catch (err) {
    logError('karst: artifact-dir orphan sweep failed', err);
  }
  // One adapter instance, shared by the session manager and the openSession
  // handler's approach materialization (the seam that turns a neutral package
  // into agent-specific launch args).
  // No manifest is resolved yet at this point in activation; only 'claude' is
  // functional today (see agent/registry.ts) so the fallback is always correct.
  const recoveryLifecycle = new SessionRecoveryLifecycle();
  const ownedSessionTickets = new Set(
    context.workspaceState.get<number[]>(OWNED_SESSION_TICKETS_KEY) ?? [],
  );
  // Per-ticket memory of the agy conversation watch (see the sweep below):
  // which conversation DB the ticket's session is writing and whether its last
  // read showed a pending permission ask. Ephemeral — rebuilt from the CLI's
  // own state on every sweep, cleared when the terminal closes.
  const agyWatchStates = new Map<number, AgyWatchState>();
  // Per-ticket memory of the agy usage watch: the last conversation step idx
  // already emitted as a UsageUpdate. Ephemeral — rebuilt from the DB on every
  // sweep, cleared when the terminal closes (the store dedupes on event id).
  const agyUsageStates = new Map<number, AgyUsageState>();
  // Per-ticket memory of the claude transcript usage watch: the last transcript
  // path, message uuid, and file fingerprint. Ephemeral — rebuilt from the file
  // on every sweep, cleared when the terminal closes.
  const claudeTranscriptStates = new Map<number, ClaudeWatchState>();
  const ownershipWriter = new SerializedStateWriter<number[]>(
    (snapshot) =>
      context.workspaceState.update(OWNED_SESSION_TICKETS_KEY, snapshot),
    (error) => {
      logError('session ownership persistence failed', error);
    },
  );
  const terminalRecordWriter = new SerializedStateWriter<SessionTerminalRecord[]>(
    (snapshot) => context.workspaceState.update(SESSION_TERMINALS_KEY, snapshot),
    (error) => {
      logError('session terminal identity persistence failed', error);
    },
  );
  // Declared before the terminal registry because the registry's session-pid
  // hook reads it (a closure running at remember/forget time, long after the
  // monitor is constructed below); assigned where the monitor is built.
  let resourceMonitor: ResourceMonitor | undefined;
  const terminalIdentity = makeTerminalIdentityRegistry(
    parseSessionTerminalRecords(context.workspaceState.get(SESSION_TERMINALS_KEY)),
    (records) => void terminalRecordWriter.enqueue(records),
    (launchId) => {
      const intent = getSessionLaunchIntent(localStore, launchId);
      return intent === undefined
        ? undefined
        : {
            ticketId: intent.ticketId,
            provider: intent.provider,
            model: intent.model,
            agentName: intent.agentName,
          };
    },
    (pid, ticketId) =>
      resourceMonitor?.registerPid({ pid, kind: 'session', ticketId, label: 'Session' }),
  );
  // Setting-gated (manifest `closeDoneTerminalsWithTicket`, OFF by default):
  // closing a ticket also closes its DONE terminals — the tabs whose process
  // already exited (VS Code marks them "Done") and would otherwise sit dead in
  // the terminal panel. Only EXITED terminals qualify, so a live agent session
  // is never torn down by closing its ticket; identity comes from the same
  // registry the adoption paths use, so a revived terminal still counts. The
  // decision is the vscode-free `ui/doneTerminals.ts`; this is the binding.
  const closeTicketDoneTerminals = (ticketId: number): number => {
    const probes: DoneTerminalProbe[] = [];
    for (const terminal of vscode.window.terminals) {
      const named = terminalIdentity.identify(terminal);
      if (!named || named.ticketId !== ticketId) continue;
      probes.push({
        ticketId,
        exited: terminal.exitStatus !== undefined,
        dispose: () => terminal.dispose(),
      });
    }
    return closeDoneTerminalsOf(probes, ticketId);
  };
  flushSessionOwnership = async () => {
    await ownershipWriter.flush();
    await terminalRecordWriter.flush();
  };
  shutdownSessionRecovery = () => recoveryLifecycle.shutdown();
  pendingSessionRecoveryTasks.clear();
  const persistOwnedSessionTickets = (): Promise<void> => {
    const snapshot = [...ownedSessionTickets].sort((a, b) => a - b);
    return ownershipWriter.enqueue(snapshot);
  };
  const sessions = new SessionManager(
    makeTerminalHost(terminalIdentity),
    (ticketId) => {
      if (!endpoint) {
        throw new Error('karst: hook endpoint is not bound');
      }
      const launchId = recoveryLifecycle.startLaunch(ticketId);
      const hookEndpoint = new URL(endpoint.url);
      hookEndpoint.searchParams.set('karstLaunch', launchId);
      return {
        endpointUrl: hookEndpoint.toString(),
        configDir: settingsDir,
        launchId,
      };
    },
    // Session-close sweep: when the agent's terminal ends, drive the ticket if it
    // is parked at a gate — no dependence on a SessionEnd hook reaching the endpoint.
    (ticketId) => {
      // The agy watch's per-ticket memory dies with the terminal: a closed
      // session must not keep a stale conversation/awaiting state behind.
      agyWatchStates.delete(ticketId);
      agyUsageStates.delete(ticketId);
      claudeTranscriptStates.delete(ticketId);
      ownedSessionTickets.delete(ticketId);
      void persistOwnedSessionTickets();
      setAgentState(localStore, ticketId, 'idle');
      // A FIX session that ends without the marker is an interrupted recovery,
      // exactly as the SessionEnd hook reads it — and this sweep exists because
      // that hook cannot be relied on to arrive (an agent core with no hook
      // channel, a killed terminal, a reload). Without it the round stays
      // `fixing` forever, the driver reads "a fix execution is already in
      // flight" on every trigger, and the ticket sits at fix indefinitely — the
      // ten-hour fix this closes. A round that is not fixing (pending, or
      // already completed by the marker) is left strictly alone.
      let interrupted = false;
      try {
        if (interruptActiveFixExecution(localStore, ticketId, new Date().toISOString())) {
          interrupted = true;
          logger.info(
            `stage driver: ticket ${ticketId} fix session closed without the marker — ` +
              `recovery round interrupted; the ticket rests at fix for a human`,
          );
        }
      } catch (err) {
        logError(`karst: interrupting the fix execution for ticket ${ticketId} failed`, err);
      }
      // A fix that NEVER had an execution (a launch that died before its
      // SessionStart, or a resume that never launched) is parked the moment its
      // session closes — the same crash the interrupt above covers for a round
      // already `fixing`, decided from the same terminal-close signal so it
      // works for every agent core (a closed terminal needs no hook channel).
      // The park is guarded, so the interrupt's own re-stamp (or a live fixing
      // round) makes it a no-op.
      try {
        const at = new Date().toISOString();
        if (
          !hasFixingRound(localStore, ticketId) &&
          parkFixStage(localStore, ticketId, FIX_PARKED_NO_EXECUTION, at)
        ) {
          logger.info(
            `stage driver: ticket ${ticketId} fix parked — its session closed with no fix ` +
              `execution in flight; the ticket rests at fix for a human`,
          );
        }
      } catch (err) {
        logError(`karst: parking the fix stage for ticket ${ticketId} failed`, err);
      }
      provider.refresh();
      dashboard.pushState(ticketId);
      // A fix round this sweep JUST interrupted (a crash, not a wait) is driven
      // straight through the driver, which reopens the round within budget and
      // resumes the fix — `maybeDrive` would not, because `shouldStartDriver`
      // never auto-drives a fix ticket, and `interrupted` is only ever true for
      // a round the interrupt above actually settled. Anything else takes the
      // normal gate-trigger path.
      if (interrupted) {
        logger.info(`stage driver: ticket ${ticketId} fix round interrupted — driving to reopen within budget`);
        void driveTicket(ticketId);
      } else {
        maybeDrive(ticketId, 'session-closed');
      }
    },
    undefined,
    (ticketId, launchId) =>
      recoveryLifecycle.sessionClosed(ticketId, launchId),
    (ticketId, launchId) =>
      recoveryLifecycle.adoptLaunch(ticketId, launchId),
    // The captured session id no longer resolves (agent CLI rejected `--resume`
    // and exited before starting) — clear it and immediately re-run the normal
    // open path. That path rebuilds the full live seed, rather than reusing the
    // terse resume prompt, so one click still produces a usable session.
    (ticketId, options) => {
      setSessionId(localStore, ticketId, null, null);
      provider.refresh();
      dashboard.pushState(ticketId);
      const t = getTicket(localStore, ticketId);
      void vscode.window.showWarningMessage(
        `Karst: couldn't resume the previous session for "${t.key ?? `#${ticketId}`}" ` +
          `(it may have expired or the worktree was recreated). Retrying with a fresh session.`,
      );
      // A background `recoverSession` observes the same close and may dispose
      // the failed generation. Defer to the next event-loop turn so its awaited
      // cleanup chain cannot mistake the fresh replacement for that terminal.
      deferSessionRetry(() => {
        void vscode.commands.executeCommand('karst.openSession', ticketId, options).then(
          undefined,
          (error) => logError(`fresh session retry failed for ticket ${ticketId}`, error),
        );
      });
    },
    // A launch is PREPARED: record the pending session launch intent so the
    // eventual SessionStart can be confirmed against the exact prepared launch
    // (durable across reloads — never recovered from in-memory callback state).
    // The provider/model/purpose/reason are re-resolved from the ticket at this
    // moment, which is what makes a switch's intent carry the NEW core: the
    // switch flow persists the selection BEFORE its launch, and this callback
    // fires synchronously inside that launch. Best-effort: a bookkeeping
    // failure must never fail the terminal launch itself.
    ({ ticketId, launchId, resume, switchLaunch, assignment }) => {
      try {
        const ticket = getTicket(localStore, ticketId);
        const purpose =
          ticket.stageCurrent === 'impl'
            ? 'implementation'
            : ticket.stageCurrent === 'fix'
              ? 'fix'
              : null;
        if (purpose === null) return;
        // Task 3: a launch prepared under a host-only configured assignment
        // (the Fix path) records THAT snapshot — provider/model/agent name as
        // resolved once at resume time, never re-derived from live config.
        const provider =
          assignment?.provider ??
          resolveProvider(ticket.agentProvider, currentManifest()?.agentProvider);
        const model =
          assignment !== undefined
            ? (assignment.model ?? null)
            : resolveModelForProvider(
                provider,
                ticket.model,
                currentManifest()?.defaultModel,
                modelCatalog,
              );
        if (purpose === 'fix') {
          // v30: a fix launch belongs to the ticket's committed recovery round
          // (the gate that failed opened it atomically). Without one — a
          // pre-v30 ticket, or a round already consumed — no fix intent is
          // recorded and the session runs untracked.
          const gate = lastFailedGate(ticket.stages);
          const round = gate === null ? null : recoveryDecision(localStore, ticketId, gate);
          if (round === null || round.status !== 'pending') return;
          recordFixLaunchIntent(localStore, {
            ticketId,
            launchId,
            provider,
            model: model ?? null,
            agentName: assignment?.agentName ?? null,
            reason: switchLaunch ? 'switch' : resume ? 'resume' : 'initial',
            sessionOrigin: resume ? 'resume' : 'new',
            recoveryRoundId: round.roundId,
            at: new Date().toISOString(),
          });
          return;
        }
        recordSessionLaunchIntent(localStore, {
          ticketId,
          launchId,
          purpose,
          provider,
          model: model ?? null,
          reason: switchLaunch ? 'switch' : resume ? 'resume' : 'initial',
          sessionOrigin: resume ? 'resume' : 'new',
          at: new Date().toISOString(),
        });
      } catch (error) {
        logError(`karst: could not record session launch intent for ticket ${ticketId}`, error);
      }
    },
    // Terminal creation failed synchronously: the prepared launch died before
    // any provider session could start. Mark the intent failed — no segment is
    // created, because the launch never started anything.
    (launchId) => {
      try {
        failSessionLaunchIntent(localStore, launchId, new Date().toISOString());
      } catch (error) {
        logError(`karst: could not record launch failure for ${launchId}`, error);
      }
    },
  );

  // The live manifest. Loaded on first read rather than assigned by whichever
  // command ran first: surfaces reachable without create/edit (the dashboard,
  // opened straight from the sidebar) used to see `undefined` here and silently
  // drop the board link, label template, and worktree paths.
  const manifests = makeManifestCache({
    pathOf: manifestPathOrThrow,
    exists: existsSync,
    load: loadManifest,
  });
  /**
   * Keep the logger's gated debug flag pointed at the live manifest's `debug`
   * field. `logger.debug()` reads this flag at call time, so a `debug: true`
   * edit to karst.yml takes effect on the next manifest (re)load — no window
   * reload, no rebuild. Idempotent and cheap (a boolean assignment), so it
   * rides every manifest read.
   */
  const applyManifestDebug = (manifest: Manifest | undefined): void => {
    logger.setDebugEnabled(manifest?.debug === true);
  };
  const currentManifest = (): Manifest | undefined => {
    const manifest = manifests.get();
    applyManifestDebug(manifest);
    return manifest;
  };
  /**
   * Every agent adapter this window hands out is INSTRUMENTED (§ token
   * consumption stats). Wrapping happens here, at the two places an adapter is
   * resolved, so a new AI integration is measured the moment it is written —
   * the alternative, a record call per call site, is the duplication the
   * instrumentation exists to avoid.
   *
   * `projectId` is a getter: the DB is shared by every IDE window, so a spend
   * row that is not project-scoped shows up in another project's totals.
   */
  const instrument = (adapter: AgentAdapter, provider: AgentProvider): AgentAdapter =>
    instrumentAdapter(adapter, {
      sink: { record: (entry) => recordTokenUsage(localStore, entry) },
      provider,
      projectId: () => currentProject()?.id ?? null,
      logError,
      // Injected ONCE here, threaded into every headless call's opts — a new
      // adapter gets debug logging by construction (gated inside the logger).
      debug: (message) => logger.debug(message),
      // Live-pid registry hook, injected at the same seam: every agent process
      // this window spawns is registered the moment it exists and unregistered
      // wherever the run settles, attributed to the call that spawned it.
      onSpawned: (pid, tracking) =>
        resourceMonitor?.registerPid({
          pid,
          kind: 'agent',
          ticketId: tracking?.ticketId ?? null,
          label: tracking ? aiCallSiteLabel(tracking.callSite) : null,
        }),
    });

  const currentAgentAdapter = (ticketId?: number): AgentAdapter => {
    const ticketProvider =
      ticketId !== undefined ? getTicket(localStore, ticketId).agentProvider : undefined;
    const provider = resolveProvider(ticketProvider, currentManifest()?.agentProvider);
    return instrument(resolveAdapter(provider), provider);
  };

  /**
   * Task 8: one inside AI process (uat-tester, review, uat-fix, review-fix,
   * pr-description), resolved as the identity SNAPSHOT its `process_runs` row
   * opens with (Task 7's `resolveProcessAssignment` — agent/provider/model,
   * immutable thereafter) plus the SAME instrumented per-ticket adapter every
   * other AI call goes through. The driver resolves each process exactly once
   * per run, so the adapter is instrumented exactly once — a second resolution
   * would wrap a second adapter around the same core.
   *
   * Finding 2: a role whose `processes.<key>.enabled` is `false` resolves to
   * NULL — configured absence. The short-circuit happens BEFORE
   * `currentAgentAdapter`, so a disabled role is never created or
   * instrumented and opens no process run. NULL is carried as NULL into the
   * drivers' nullable callbacks — never collapsed to `undefined` by an
   * assertion at this seam.
   */
  // The roles whose headless prompts consume `assignment.instructions` — the
  // vocabulary itself lives beside the role definitions
  // (`manifest/validate/processAssignments.ts`), because the Settings row
  // renders a different explanation per group and must not carry its own copy.
  const promptBearingRoles = new Set<ProcessRole>(PROMPT_BEARING_ROLES);
  const processFor = (
    ticketId: number,
    role: ProcessRole,
  ): DriveProcessBundle | null => {
    const t = getTicket(localStore, ticketId);
    const assignment = resolveProcessAssignment(
      currentManifest() ?? emptyManifest(),
      role,
      {
        provider: t.agentProvider ?? undefined,
        model: t.model || undefined,
        effort: t.effort || undefined,
      },
      modelCatalog,
    );
    if (assignment === null) return null;
    // The process-assignment PROFILE (the Settings agent-pool pick) IS the
    // process's prompt: for the prompt-BEARING roles, resolve the assigned
    // profile's body and use it as the process's `instructions`, replacing the
    // built-in role block. It is the ONLY source — the manifest-declared
    // `processes.<key>.instructions` was retired precisely because a second
    // source could silently outrank the profile the user picked in Settings.
    // A missing / unreadable profile degrades to the built-in prompt, exactly
    // like the launch path's solo-agent fallback. The Fix roles are interactive
    // sessions and pr-description has a fixed prompt — their profile body is
    // deliberately NOT resolved (a debug line would overclaim, and the value
    // would ride the session assignment with no consumer).
    // `soloAgentBody` is only CALLED here (at execution time), long after the
    // helper is initialized, so the later `const` declaration is safe.
    const instructions =
      promptBearingRoles.has(role) && assignment.agent
        ? (soloAgentBody(assignment.agent) ?? undefined)
        : undefined;
    if (instructions !== undefined) {
      logger.debug(
        `[process] ${role} for ticket #${ticketId} runs through Settings profile ` +
          `"${assignment.agent}" (profile body is the prompt)`,
      );
    }
    return {
      assignment:
        instructions === undefined ? assignment : { ...assignment, instructions },
      // The process assignment is the execution identity. In particular, a
      // configured UAT/Review/Fix role may deliberately differ from the
      // ticket's interactive provider, so resolving through the ticket here
      // would run and account the wrong core under a correct-looking snapshot.
      adapter: instrument(resolveAdapter(assignment.provider), assignment.provider),
    };
  };

  /**
   * Task 3: the configured Fix process for the gate that failed — `uat` →
   * `uat-fix`, `review` → `review-fix`, resolved EXACTLY once per driver run
   * (each call takes one branch). NULL (enabled: false) logs the refusal here,
   * where the role is known, and rides the resume call so the host's session
   * seam performs no launch and no nudge: the pending recovery round stays for
   * a human.
   */
  const fixProcess = (ticketId: number, gate: GateStageKey): DriveProcessBundle | null => {
    const bundle =
      gate === 'uat' ? processFor(ticketId, 'uat-fix') : processFor(ticketId, 'review-fix');
    if (bundle === null) {
      logger.info(
        `configured Fix process disabled (${gate === 'uat' ? 'uat-fix' : 'review-fix'}) — leaving the pending recovery round for a human`,
      );
    }
    return bundle;
  };

  /** Task 3: the configured PR-description process for Ship (nullable). */
  const prDescriptionProcess = (ticketId: number): DriveProcessBundle | null =>
    processFor(ticketId, 'pr-description');

  /**
   * Task 3: the configured ticket-analysis process for the ticket form
   * (nullable). The analyzer runs through the SETTINGS Ticket-analysis
   * assignment: `processFor` resolves the assigned profile's body as the
   * analysis `instructions`,
   * so changing the Settings → Agents → Inside process assignments →
   * Ticket analysis profile changes what the form's Improve / auto-improve
   * asks — the selected agent IS the difference. The ticket's own
   * `single-subagent` pick drives the SESSION, never this headless analysis.
   */
  const analysisProcess = (ticketId: number): DriveProcessBundle | null =>
    processFor(ticketId, 'ticket-analysis');

  // Drop the cached copy so the next read re-reads from disk. Shared by
  // the ticket form (after a signal writeback) and settings (after a save) so both
  // surfaces observe the same reload behavior from one implementation. Reloads
  // eagerly (rather than waiting for the next lazy `get`) so the debug flag is
  // re-applied the moment the file changed — including the external watcher.
  const reloadManifest = (): void => {
    manifests.reload();
    applyManifestDebug(currentManifest());
  };

  // This window's project (§ projects / multi-window). Every window shares one
  // global DB, so without a project id each one would list — and act on — the
  // others' tickets. Resolved lazily and memoized: the workspace root is fixed
  // for the window's lifetime, and so is the slug derived from it.
  //
  // Identity comes from the manifest's `id:` when present, else a slug derived
  // from the workspace root. The fallback matters: it means a project binds even
  // with no manifest yet (the Getting Started/scaffold path), so tickets created
  // in the ticket form are never orphaned.
  let boundProject: Project | undefined;
  const currentProject = (): Project | undefined => {
    if (boundProject) return boundProject;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined; // no folder → no project; commands already refuse

    const root = folder.uri.fsPath;
    const slug = resolveProjectSlug(currentManifest()?.id, root);
    try {
      const { project, adopted } = bindProject(
        localStore,
        { slug, name: folder.name, rootPath: root },
        {
          done: () => context.globalState.get<boolean>(PROJECT_ADOPTION_KEY, false),
          markDone: () => void context.globalState.update(PROJECT_ADOPTION_KEY, true),
        },
      );
      boundProject = project;
      if (adopted > 0) {
        logger.info(`karst: adopted ${adopted} pre-existing ticket(s) into project "${slug}"`);
      }
      return project;
    } catch (err) {
      // A window with no project shows an empty board rather than every other
      // project's tickets — failing closed is the safe direction here.
      logError('karst: could not bind project', err);
      return undefined;
    }
  };

  const diagnosticDocuments = new DiagnosticDocumentProvider();
  context.subscriptions.push(
    registerDiagnosticDocumentProvider(diagnosticDocuments),
    vscode.commands.registerCommand(
      'karst.reportIssue',
      createReportIssueHandler({
        context,
        store: localStore,
        logs: diagnosticLogBuffer,
        documents: diagnosticDocuments,
        currentProject,
        currentManifest,
        hookChannel: () => hookChannelRecorder.snapshot(),
        activatedAt,
      }),
    ),
  );

  // Live setup status for the Getting Started page. Reads disk/PATH fresh on every call
  // (no caching) so re-check and post-scaffold pushes reflect reality. Guarded:
  // no workspace folder → manifest counts as missing, provider defaults to claude.
  const loadGettingStartedState = () => {
    let manifestExists = false;
    try {
      manifestExists = existsSync(manifestPathOrThrow());
    } catch {
      manifestExists = false;
    }
    const provider = (currentManifest()?.agentProvider ?? 'claude');
    // The panel's re-check button routes here; repaint the bar from the same
    // moment's truth, or installing a tool clears the checklist and leaves the
    // status bar still claiming it's missing.
    refreshDepsStatus();
    return buildGettingStartedState(
      buildSetupStatus({ manifestExists, provider, probe: binaryExists, ready: commandSucceeds }),
    );
  };

  const gettingStarted = new GettingStartedManager(
    loadGettingStartedState,
    makeGettingStartedPanelHost(context, brandIcon),
    buildGettingStartedActions({
      scaffoldManifest,
      setDismissed: () => void context.workspaceState.update(GETTING_STARTED_DISMISSED_KEY, true),
      runCommand: (command) => void vscode.commands.executeCommand(command),
    }),
    logError,
  );

  // The startup toast is dismissible and gone in seconds; a tool that is missing
  // (or signed out) stays that way until the user fixes it. The status bar is the
  // surface that outlives the toast — it clicks through to the checklist, and
  // clears itself on any recheck.
  const depsStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  depsStatus.command = 'karst.recheckDeps';
  context.subscriptions.push(depsStatus);

  /** Reprobe, repaint the status bar, and report what is still unusable. */
  const refreshDepsStatus = (): DependencyFault[] => {
    const provider = currentManifest()?.agentProvider ?? 'claude';
    const faults = checkDependencyFaults(dependencyRegistry(provider), binaryExists, commandSucceeds);
    const indicator = buildDepsIndicator(faults);
    if (!indicator) {
      depsStatus.hide();
      return faults;
    }
    depsStatus.text = indicator.text;
    depsStatus.tooltip = indicator.tooltip;
    depsStatus.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    depsStatus.show();
    return faults;
  };

  /**
   * Refuse an action whose tools are missing, and say what to install.
   *
   * The startup preflight only warns, and it did so minutes ago; this is the
   * moment the user actually needs the tool. Returns true when the capability is
   * usable. The guard lives here, in the host layer, because the workflow modules
   * it protects are host-agnostic by invariant — a PATH probe wired inside them
   * would fail their own unit tests on a machine without gh.
   *
   * `ticketId` only changes the outcome for capabilities gated by
   * `AGENT_CLI_DEPENDENCIES` (currently only `'sessions'`) — pass it there;
   * omit it for `'worktrees'`/`'gates'`/`'ship'` since git/npm/gh availability
   * doesn't vary by agent provider, and passing it needlessly risks a
   * `getTicket` throw on a since-deleted ticket.
   */
  const guardProviderCapability = (
    capability: Capability,
    agentProvider: AgentProvider,
    silent = false,
  ): boolean => {
    const faults = ensureCapability(
      capability,
      dependencyRegistry(agentProvider),
      binaryExists,
      commandSucceeds,
    );
    if (faults.length === 0) return true;
    // The bar may predate this: a tool can go missing (or be installed) after
    // activation, and a refusal is proof of what PATH says right now.
    refreshDepsStatus();
    for (const f of faults) logger.warn(`blocked: '${f.dep.binary}' is ${f.state}`);
    if (!silent) {
      const text = faults
        .map((f) => renderDependencyFault(f.dep, f.state))
        .filter((m): m is string => m !== null)
        .join(' ');
      void vscode.window.showErrorMessage(text, 'Open setup checklist').then((choice) => {
        if (choice === 'Open setup checklist') gettingStarted.open();
      });
    }
    return false;
  };

  const guardCapability = (capability: Capability, ticketId?: number, silent = false): boolean => {
    const ticketProvider =
      ticketId === undefined ? undefined : getTicket(localStore, ticketId).agentProvider;
    return guardProviderCapability(
      capability,
      resolveProvider(ticketProvider, currentManifest()?.agentProvider),
      silent,
    );
  };

  /**
   * Switch-only provider probe. Unlike the activation and ordinary action
   * guards, this runs from an open dashboard and must never block the shared
   * extension-host event loop while a candidate CLI answers (or hangs).
   */
  const guardProviderCapabilityAsync = async (
    capability: Capability,
    agentProvider: AgentProvider,
  ): Promise<boolean> => {
    const faults = await ensureCapabilityAsync(capability, dependencyRegistry(agentProvider));
    if (faults.length === 0) return true;
    for (const fault of faults) logger.warn(`blocked: '${fault.dep.binary}' is ${fault.state}`);
    const message = faults
      .map((fault) => renderDependencyFault(fault.dep, fault.state))
      .filter((text): text is string => text !== null)
      .join(' ');
    void vscode.window.showErrorMessage(message, 'Open setup checklist').then((choice) => {
      if (choice === 'Open setup checklist') gettingStarted.open();
    });
    return false;
  };

  const switchAgentSession = async (
    ticketId: number,
    targetProvider: AgentProvider,
    model: string | null,
    effort: string | null,
  ): Promise<void> => {
    try {
      const outcome = await applyAgentSwitchSelection({
        read: () => {
          const ticket = getTicket(localStore, ticketId);
          return {
            stageCurrent: ticket.stageCurrent,
            provider: resolveProvider(ticket.agentProvider, currentManifest()?.agentProvider),
            ticketModel: ticket.model,
            defaultModel: currentManifest()?.defaultModel ?? null,
            ticketEffort: ticket.effort,
            defaultEffort: currentManifest()?.defaultEffort ?? null,
            fixExecutionActive: listRecoveryRounds(localStore, ticketId)
              .some((round) => round.status === 'fixing'),
          };
        },
        isSessionOpen: () => sessions.isOpen(ticketId),
        isProviderReady: (provider) => guardProviderCapabilityAsync('sessions', provider),
        confirm: async ({ from, to, willReplaceSession }) => {
          const choice = await vscode.window.showWarningMessage(
            `Switch from ${from.providerLabel} · ${from.modelLabel} to ${to.providerLabel} · ${to.modelLabel}?`,
            {
              modal: true,
              detail: willReplaceSession
                ? 'Karst will close the current terminal and start a fresh agent session. Worktree changes and ticket progress stay intact.'
                : 'Karst will start a fresh agent session with the new core. Worktree changes and ticket progress stay intact.',
            },
            'Switch and continue',
          );
          return choice === 'Switch and continue';
        },
        persist: ({ provider: p, model: m, effort: e }) => updateTicketFields(localStore, ticketId, {
          agentProvider: p,
          model: m ?? '',
          effort: e ?? '',
        }),
        dispose: () => sessions.disposeSession(ticketId),
        launch: async (options) => {
          await vscode.commands.executeCommand('karst.openSession', ticketId, options);
        },
      }, modelCatalog, { provider: targetProvider, model, effort });
      // Keep the same outcome toasts as before (stale / launch-failed).
      if (outcome.kind === 'stale') {
        void vscode.window.showInformationMessage('The ticket state changed before the agent could be switched.');
      } else if (outcome.kind === 'launch-failed') {
        void vscode.window.showErrorMessage(
          `The agent selection was saved, but its session could not start: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
        );
      }
    } catch (error) {
      logError('agent session switch failed', error);
      void vscode.window.showErrorMessage(
        `Could not switch the agent session: ${error instanceof Error ? error.message : String(error)}. Please try again.`,
      );
    } finally {
      provider.refresh();
      dashboard.pushState(ticketId);
      showStatusFor(ticketId);
    }
  };

  // Load the manifest for the settings page. Unlike resolveManifest (which gates
  // on invalid), this ALWAYS returns something to edit: a valid parse, or a raw
  // best-effort manifest plus the error so the page opens on a broken file.
  const loadSettingsState = (): LoadedManifest => {
    const path = manifestPathOrThrow();
    try {
      const { manifest, warnings, notices } = loadManifestWithDiagnostics(path);
      // Non-fatal: log to the Karst output channel rather than a toast — the
      // Settings page the user just opened is where they'd fix it, and the
      // migrate.ts warning tells them to Save here to write the new shape.
      for (const w of warnings) logger.warn(`karst.yml: ${w}`);
      for (const n of notices) logger.info(`karst.yml: ${n}`);
      // The manifest-load seam for Settings: the page renders the approaches
      // roster from this, so the packaged built-in must be present here — and
      // the settings actions resolve enable/disable through the same overlay.
      return { manifest: withBuiltInApproaches(manifest), error: null };
    } catch (e) {
      return {
        manifest: currentManifest() ?? emptyManifest(),
        error: e instanceof Error ? e.message : String(e),
      };
    }
  };

  // Bound installer for the approaches picker (Phase E). `approachesDirOrThrow`
  // is resolved at call time, not here, so it reflects the current
  // workspace/setting and doesn't throw at activation when there's no folder.
  const installApproachHere = (def: ApproachDef): Promise<ApproachPackage> => {
    const install = installApproach(def, {
      fetchFn: fetch,
      baseDir: approachesDirOrThrow(),
      runCommand: runNpmCommand,
    });
    if (def.source?.type === 'npm') {
      pendingApproachInstalls.add(install);
      void install.then(
        () => pendingApproachInstalls.delete(install),
        () => pendingApproachInstalls.delete(install),
      );
    }
    return install;
  };
  // Ids of approach packages already installed on disk, for the ticket form
  // state (Task E1). `approachesDirOrThrow` throws with no workspace folder;
  // guarded to "nothing installed" so the ticket form still opens in that case.
  // Includes every ENABLED built-in id: the disk-install machinery treats a
  // built-in as installed (it ships in the VSIX), and this is what makes
  // `syncApproachEnabled` and Settings' installed-state rendering resolve it.
  const listInstalledApproachIds = (): string[] => {
    const ids: string[] = [];
    try {
      ids.push(...listInstalled(approachesDirOrThrow()).map((p) => p.id));
    } catch {
      // no workspace folder — built-ins below still resolve
    }
    const effective = withBuiltInApproaches(currentManifest() ?? emptyManifest());
    for (const a of effective.approaches ?? []) {
      if (isBuiltInApproachId(a.id) && a.enabled !== false && !ids.includes(a.id)) {
        ids.push(a.id);
      }
    }
    return ids;
  };

  // Selectable single-subagent pool for the ticket-form picker (§ single-
  // subagent selection): local agent files ∪ agent-kind artifacts of
  // installed+enabled approaches. Guarded the same way as
  // `listInstalledApproachIds` — no workspace folder yet at activation, or a
  // transient fs error, degrades to "no agents" rather than throwing.
  const listAgents = (): PoolAgent[] => {
    try {
      return buildAgentPool({
        agentsDir: agentsDirOrThrow(),
        approachesDir: approachesDirOrThrow(),
        approaches: currentManifest()?.approaches ?? [],
        agentsMeta: currentManifest()?.agents ?? {},
      });
    } catch {
      return [];
    }
  };

  // Resolve a profile's BODY (its instructions) by name: a local agent file OR
  // an approach artifact, matching the pool entry's `source`. The ONE
  // resolution the launch path (a ticket's single-subagent) and the inside
  // process assignments (`processFor` → a Settings profile) share, so a chosen
  // agent drives the ticket analysis / UAT / Review exactly as it drives the
  // session. A missing agent / unreadable body → null (the caller keeps its
  // built-in prompt).
  const soloAgentBody = (name: string): string | null => {
    try {
      const chosen = listAgents().find((a) => a.name === name);
      if (!chosen) return null;
      return chosen.source === 'file'
        ? (readAgentFile(agentsDirOrThrow(), chosen.name)?.body ?? null)
        : readArtifactBody(approachesDirOrThrow(), chosen.approachId!, chosen.relPath!);
    } catch {
      return null;
    }
  };

  // Ticket form: create + edit tickets on one persistent surface. The
  // manifest is read fresh per-open (getter) so a signal write is reflected
  // immediately. The ClickUp provider + agent adapter are wired with the secure
  // token seam; the manifest/path are read at call time (resolved on open).
  // One status-tinted logo per glyph, materialized on demand under global
  // storage. Every karst tab derives its icon from the SAME `ticketGlyph` the
  // sidebar rows use, so a ticket reads the same color on every surface. A
  // missing ticket / unreadable asset degrades to "no icon", never a throw.
  const tabIconFor = (ticketId: number): string | undefined => {
    try {
      const t = getTicket(localStore, ticketId);
      return glyphIconPath(ticketGlyph(t), {
        storageDir: context.globalStorageUri.fsPath,
        assetSvgPath: MARK_SVG,
      });
    } catch {
      return undefined;
    }
  };

  // Base-branch candidates already fetched (§ per-repo base branch), keyed by
  // `repoPath`. One cache for the whole window: `buildTicketFormActions`'s
  // `setRepos` warms an entry lazily the first time a row is selected in ANY
  // ticket-form panel, and `TicketFormManager`'s `branchCandidates` getter
  // reads the same object on every state push — so a branch listed once
  // never re-fetches for a different panel on the same repo.
  const baseBranchCandidates = new Map<string, string[]>();

  const ticketForm = new TicketFormManager(
    localStore,
    () => currentManifest() ?? emptyManifest(),
    makeTicketFormPanelHost(context, brandIcon),
    buildTicketFormActions({
      store: localStore,
      // These read the manifest at call time so a manifest resolved on open (or
      // loaded on demand) is available to fetch/suggest/save. The built-in
      // overlay seam is the ticket-form consumer: the analyzer's approach
      // candidates resolve packaged built-ins through it (a disabled built-in
      // is then filtered out by `enabled !== false`).
      get manifest() {
        return withBuiltInApproaches(currentManifest() ?? emptyManifest());
      },
      get manifestPath() {
        return manifests.path() ?? '';
      },
      // Same getter pattern: the project binds lazily, so read it at call time
      // rather than capturing whatever was (not yet) resolved at wiring time.
      get projectId() {
        return currentProject()?.id;
      },
      // Read `ticketing` fresh so a provider/teamId change saved from settings
      // applies without a reload (same getter pattern as `manifest` above).
      get provider() {
        return makeTicketingProvider(
          (currentManifest() ?? emptyManifest()).ticketing,
          fetch,
          makeTokenProvider(context),
        );
      },
      // Read fresh so a provider choice saved from settings takes effect on
      // the next ticket-form action, mirroring `get provider()` above — this
      // object is built once at activation, so a static property would be
      // permanently stuck on the fallback ('claude') read at that moment.
      get adapter() {
        const provider = (currentManifest() ?? emptyManifest()).agentProvider ?? 'claude';
        // Instrumented like every other adapter: the ticket form's signal
        // suggestion is an AI call that must be measured. The analyzer itself
        // resolves through `resolveAnalysisProcess` below, which carries the
        // configured ticket-analysis identity.
        return instrument(resolveAdapter(provider), provider);
      },
      // The analyzer is its own inside process: resolved at analyze time
      // through the same `processFor` seam every other role uses, so
      // `processes.ticketAnalysis` picks its core/model and `enabled: false`
      // reads as configured absence (the form's analyze refuses).
      resolveAnalysisProcess: analysisProcess,
      onChange: () => provider.refresh(),
      // Finish handoff: scope the ticket's selected repos (worktrees, no
      // servers) and open the agent session seeded with its chosen approach.
      // Servers stay deferred — they come up only when a stage needs to verify.
      startTicket: async (
        ticketId: number,
        { pullBase }: StartTicketOptions,
      ): Promise<StartTicketResult> => {
        const t = getTicket(localStore, ticketId);
        const hot = t.selectedRepos;
        // Nothing to scope → the ticket stays pending. Report it so the ticket form
        // keeps the page open with the reason, instead of looking hung.
        if (hot.length === 0) {
          return { ok: false, message: 'Select at least one repository to start this ticket.' };
        }
        const manifest = currentManifest() ?? emptyManifest();
        try {
          // `pullBase` is the page's switch, honored as given. A pull that could
          // not happen is REPORTED, never fatal — the worktree still exists, it
          // just starts from what this clone already had.
          await confirmScope(localStore, manifest, ticketId, hot, {
            pullBase,
            onPullFailed: warnBaseNotPulled,
            debug: (message) => logger.debug(message),
          });
          // Scope is complete the moment its worktrees exist (scope has only a
          // pass edge → impl; it is not a gate). Pass it so the ticket advances
          // to impl running — the agent session opens in the impl worktree.
          //
          // Submit doubles as the edit surface for an already-started ticket
          // (repos/approach changed after the fact), so `scope` may already
          // have passed by the time this runs — mirror settleShipGate's
          // idiom rather than let transition() throw its internal invariant
          // string onto the page: only advance the run that is genuinely
          // still at scope, a ticket already past it just needs its session
          // opened.
          if (getTicket(localStore, ticketId).stageCurrent === 'scope') {
            transition(localStore, ticketId, 'scope', { kind: 'passed' });
          }
          provider.refresh();
          // Await so a launch failure (missing worktree, terminal spawn throw)
          // surfaces as a failed start instead of a silent stall with the ticket
          // already advanced to impl.
          await vscode.commands.executeCommand('karst.openSession', ticketId);
          // The session is open and the ticket has already advanced to impl —
          // the irreversible part succeeded, so a failed status push warns; it
          // never turns a started ticket into a failed start (mirrors
          // `advanceTicketOnShip`'s catch in `shipTicket` below).
          try {
            const res = await advanceTicketOnStart(
              localStore,
              ticketId,
              manifest.ticketing,
              makeTicketingProvider(manifest.ticketing, fetch, makeTokenProvider(context)),
              (message) => logger.debug(message),
            );
            const note = statusPushSkipNote('started', ticketId, res);
            if (note) logger.debug(note.message);
          } catch (e) {
            logError('ticket status update failed', e);
          }
          return { ok: true };
        } catch (err) {
          const message = `Could not start ticket: ${err instanceof Error ? err.message : String(err)}`;
          void vscode.window.showErrorMessage(message);
          return { ok: false, message };
        }
      },
      // A started ticket belongs to its dashboard — the ticket form hands off there.
      openDashboard: (ticketId: number) => dashboard.openDashboard(ticketId),
      writeSignals: writeRepoSignals,
      // Re-read the manifest from disk after a signal writeback so the panel's
      // manifest getter (currentManifest) reflects the saved signals — the gate
      // clears and the repo row shows them on the next pushState.
      reloadManifest,
      listInstalledIds: listInstalledApproachIds,
      openUrl: (url: string) => void vscode.env.openExternal(vscode.Uri.parse(url)),
      storageDir: context.globalStorageUri.fsPath,
      pickAttachment: async (): Promise<string[]> => {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: 'Attach',
          filters: {
            Media: [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS],
            'All Files': ['*'],
          },
        });
        return (picked ?? []).map((uri) => uri.fsPath);
      },
      openFile: async (path: string) => {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path));
      },
      listBaseBranches: (repoPath: string) => listBaseBranchCandidates(defaultGitRunner, repoPath),
      branchCandidatesCache: baseBranchCandidates,
    }),
    listInstalledApproachIds,
    listAgents,
    // Locks the model/effort picker while a session terminal is live (§ B1).
    (ticketId) => sessions.isOpen(ticketId),
    logError,
    tabIconFor,
    () => modelCatalog,
    context.globalStorageUri.fsPath,
    (ticketId, active) => activeTicket.set(ticketId, active),
    // The recently-used models for the shared picker's "Last used" group,
    // scoped to this window's project like every other ticket-adjacent read.
    () => listRecentlyUsedModels(localStore, currentProject()?.id ?? null, 5),
    // Same cache `setRepos` warms above, read fresh on every state push.
    () => Object.fromEntries(baseBranchCandidates),
  );

  // Full agent-pool rows for the Settings "Agents" tab. Unlike `listAgents`
  // (used for the ticket form solo-agent picker, which drops disabled agents),
  // this calls `buildAgentPool` WITHOUT `agentsMeta` so disabled agents stay
  // visible with `enabled:false` — the whole point of the tab is re-enabling
  // them. `body` is the file contents for a local file (so it's editable);
  // an approach artifact's body isn't surfaced here (installed, not edited).
  // Same degrade-to-[] guard as `listAgents` (no workspace folder yet, etc).
  const listAgentRows = (): SettingsState['agents'] => {
    try {
      const pool = buildAgentPool({
        agentsDir: agentsDirOrThrow(),
        approachesDir: approachesDirOrThrow(),
        approaches: currentManifest()?.approaches ?? [],
      });
      const agentsMeta = currentManifest()?.agents ?? {};
      return pool.map((a) => ({
        name: a.name,
        source: a.source,
        ...(a.approachId !== undefined ? { approachId: a.approachId } : {}),
        enabled: agentsMeta[a.name]?.enabled !== false,
        body: a.source === 'file' ? (readAgentFile(agentsDirOrThrow(), a.name)?.body ?? null) : null,
      }));
    } catch {
      return [];
    }
  };

  // Slash commands each installed approach package exposes, for the Settings
  // "Commands" tab: the generated `/karst:<id>` orchestrator when the package
  // declares a `workflow`, plus `/<id>:<basename>` for every `command`-kind
  // artifact. Same guard pattern — any read failure degrades to `{}`.
  const listApproachCommands = (): Record<string, string[]> => {
    try {
      const dir = approachesDirOrThrow();
      const result: Record<string, string[]> = {};
      for (const id of listInstalledApproachIds()) {
        const pkg = readApproachPackage(dir, id);
        if (!pkg) continue;
        // Slash-form the user actually types: a plugin named `<id>` exposes each
        // command file as `/<id>:<basename>` — the generated orchestrator is
        // `/karst:<id>`, native fetched commands are `/<id>:<their-basename>`.
        const commandNames = listArtifacts(pkg, 'command').map((a) => `/${id}:${basename(a.relPath, '.md')}`);
        result[id] = [
          ...(pkg.workflow?.length ? [`/${KARST_PLUGIN_NAME}:${orchestratorCommandBasename(id)}`] : []),
          ...commandNames,
        ];
      }
      return result;
    } catch {
      return {};
    }
  };

  // Settings page: edit the manifest (host, ports, services, agents, ...) on a
  // persistent surface. Opens even on an invalid manifest so a broken file can
  // be fixed from the UI; save re-validates before touching disk.
  const settings = new SettingsManager(
    loadSettingsState,
    () => manifestPathOrThrow(),
    makeSettingsPanelHost(context, brandIcon),
    buildSettingsActions({
      writeManifest,
      reloadManifest,
      onChange: () => {
        provider.refresh();
        // Re-push any open dashboards so worktree-path display etc. reflect edits.
      },
      loadState: loadSettingsState,
      installApproach: installApproachHere,
      // The shell-out gate for npm-source installs. Modal (like the hard-delete
      // confirm) so it can't be missed, and shows the command VERBATIM — the
      // point is that the user sees the exact string karst.yml is asking to run.
      confirmInstallCommand: async (command: string): Promise<boolean> => {
        // `message` is the dialog's bold title and `detail` its body — so the
        // question goes in the title and the command in the detail. Putting a
        // long `npx …` string in the title clips it, which would hide the very
        // thing the user is being asked to approve.
        const choice = await vscode.window.showWarningMessage(
          'Run this command to install the approach?',
          {
            modal: true,
            detail: `It comes from this workspace’s karst.yml and runs in a shell:\n\n${command}`,
          },
          'Run',
        );
        return choice === 'Run';
      },
      uninstallApproach: (id: string): boolean => {
        try {
          return uninstallApproach(approachesDirOrThrow(), id);
        } catch {
          return false;
        }
      },
      // The ticket half of an uninstall (869eckp0x). Project-scoped: the DB is
      // shared by every IDE window, so an uninstall here must never rewrite
      // another project's tickets — with no bound project, clear nothing rather
      // than everything. The count is reported because the user is losing a
      // choice they made; a silent rewrite of N tickets is not acceptable.
      clearApproachFromTickets: (id: string): number => {
        const projectId = currentProject()?.id;
        if (projectId === undefined) return 0;
        const cleared = clearApproachFromTickets(localStore, id, { projectId });
        if (cleared > 0) {
          provider.refresh();
          void vscode.window.showInformationMessage(
            `Uninstalled "${id}" — cleared it from ${cleared} ticket${cleared === 1 ? '' : 's'}. ` +
              `Pick an approach again for those tickets after reinstalling.`,
          );
        }
        return cleared;
      },
      listInstalledIds: listInstalledApproachIds,
      // Token entered host-side via a password input box; the raw token never
      // crosses back into the webview — only the boolean "configured" flag does.
      setToken: async (): Promise<boolean> => {
        const entered = await vscode.window.showInputBox({
          prompt: 'ClickUp API token (stored securely in your OS keychain)',
          password: true,
          ignoreFocusOut: true,
          validateInput: (v) => (v.trim() ? null : 'Token is required'),
        });
        if (!entered) return false;
        await setToken(context, entered);
        return true;
      },
      clearToken: (): Promise<void> => clearToken(context),
      hasToken: (): Promise<boolean> => hasToken(context),
      // Native folder picker for a repository's repoPath (§ settings). No
      // validation here — whatever the user picks is just text in the field,
      // same as typing it; validateManifest is still the authority.
      browseForFolder: async (): Promise<string | undefined> => {
        const uris = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Select repository folder',
        });
        return uris?.[0]?.fsPath;
      },
      saveAgentFile: (name: string, body: string): void =>
        writeAgentFile(agentsDirOrThrow(), name, body),
      // Deleting an agent file is irreversible, so it is confirmed by a HOST
      // modal, never by a webview dialog (UI-R33): a crafted `delete-agent`
      // message must not be able to skip the confirmation. Returning the promise
      // also lets the dispatch seam report a real terminal result — a cancelled
      // confirmation settles the control as success-with-nothing-done rather
      // than leaving it pending until the watchdog fires.
      deleteAgent: async (name: string): Promise<void> => {
        const choice = await vscode.window.showWarningMessage(
          `Permanently delete the agent "${name}"? This cannot be undone.`,
          { modal: true },
          'Delete',
        );
        if (choice !== 'Delete') return;
        removeAgentFile(agentsDirOrThrow(), name);
      },
      createAgent: (name: string): void =>
        writeAgentFile(agentsDirOrThrow(), name, agentStarterTemplate(name)),
      listAgentRows,
      listApproachCommands,
      readApproachCommandBody: (approachId: string, command: string): string => {
        const dir = approachesDirOrThrow();
        const pkg = readApproachPackage(dir, approachId);
        if (!pkg) throw new Error(`Approach "${approachId}" is not installed.`);
        // Generated orchestrator: /karst:<id> — render from the stored workflow.
        if (command === `/${KARST_PLUGIN_NAME}:${orchestratorCommandBasename(approachId)}`) {
          if (!pkg.workflow?.length) throw new Error(`Approach "${approachId}" has no workflow.`);
          return renderWorkflowCommand({ id: pkg.id, label: pkg.label, phases: pkg.workflow });
        }
        // Native command: /<id>:<name> — read commands/<name>.md from disk.
        const name = command.replace(new RegExp(`^/${approachId}:`), '');
        const art = listArtifacts(pkg, 'command').find((a) => basename(a.relPath, '.md') === name);
        if (!art) throw new Error(`No command "${command}" in approach "${approachId}".`);
        return readFileSync(join(dir, approachId, art.relPath), 'utf8');
      },
      makeProvider: (config) => makeTicketingProvider(config, fetch, makeTokenProvider(context)),
      modelCatalog: () => modelCatalog,
      openManifest: async () => {
        await vscode.commands.executeCommand('karst.openManifest');
      },
      // The Settings → Approaches prompt links. The identity is a CLOSED set
      // (graphPrompts); the reveal shows the EFFECTIVE prompt — the project
      // override when one exists, else the packaged bytes (Slice-1 T7).
      revealGraphPrompt: async (identity: string): Promise<void> => {
        const resolved = resolveGraphPrompt(
          agentsDirOrThrow(),
          context.extensionUri.fsPath,
          identity,
        );
        if (!existsSync(resolved.path)) {
          throw new Error(`Graph prompt not found: ${resolved.path}`);
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved.path));
        await vscode.window.showTextDocument(doc, { preview: true });
      },
    }),
    listInstalledApproachIds,
    () => hasToken(context),
    listAgentRows,
    listApproachCommands,
    logError,
    () => modelCatalog,
    (): { value: string; derived: boolean } => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      const root = folder?.uri.fsPath ?? '';
      const manifest = currentManifest();
      return { value: resolveProjectSlug(manifest?.id, root), derived: manifest?.id === undefined };
    },
    () => context.extension.packageJSON.version as string,
    // Packaged built-in approach definitions for the webview's delta mirror —
    // host-computed through the seam, never a literal in the HTML.
    () => [...packagedApproachDefs()],
    // The recently-used models for the shared picker's "Last used" group,
    // scoped to this window's project like every other ticket-adjacent read.
    () => listRecentlyUsedModels(localStore, currentProject()?.id ?? null, 5),
  );

  // Discovery is deliberately detached from activation: bundled models render
  // immediately, while successful CLI/feed/cache results repaint live panels.
  // Provider-level failures are normal loader values; only an unexpected
  // rejection reaches this top-level catch.
  void loadModelCatalog({ cache: modelCatalogCache })
    .then(async (loaded) => {
      for (const diagnostic of loaded.diagnostics) {
        // An optional provider CLI that is not installed is a normal state, not
        // a fault; only a source that was supposed to work and did not warns.
        const line = `karst: model catalog ${formatCatalogDiagnostic(diagnostic)}`;
        if (catalogDiagnosticSeverity(diagnostic.category) === 'warn') logger.warn(line);
        else logger.info(line);
      }
      modelCatalog = loaded.catalog;
      ticketForm.refreshModels();
      await settings.refreshModels();
    })
    .catch((error) => logError('karst: model catalog load failed', error));

  const virtualDocuments = new VirtualDocumentRegistry();
  let virtualDocumentId = 0;
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('karst-diff', {
      // `resolve`, never `?? ''`: VS Code restores open `karst-diff:` editors
      // across a window reload but the registry is rebuilt empty, and an empty
      // string is a legitimate diff side. It must refuse, not fabricate.
      provideTextDocumentContent: (uri) => virtualDocuments.resolve(uri.toString()),
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === 'karst-diff') {
        virtualDocuments.delete(document.uri.toString());
      }
    }),
  );

  const workingFile = {
    lstat: async (path: string) => {
      const entry = await fsLstat(path);
      return {
        dev: entry.dev,
        ino: entry.ino,
        mode: entry.mode,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        ctimeMs: entry.ctimeMs,
        isSymbolicLink: () => entry.isSymbolicLink(),
      };
    },
    realpath: (path: string): Promise<string> => fsRealpath(path),
    readlink: (path: string): Promise<string> => fsReadlink(path),
    read: (path: string): Promise<Buffer> => fsReadFile(path),
  };
  const materializeDiffResource = (
    resource: PreparedDiffResource,
    attempt: VirtualDocumentAttempt,
  ): vscode.Uri => {
    if (resource.kind === 'file') return vscode.Uri.file(resource.path);

    // The comparison suffix belongs in the editor label, not in the URI: it can
    // name a Git revision. The URI exposes only an opaque host token plus a
    // sanitized basename, while the provider map owns the already-prepared text.
    const basenameOnly = resource.label.replace(/\s+\([^)]*\)$/, '');
    const safeBasename =
      basename(basenameOnly).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'resource';
    const uri = vscode.Uri.from({
      scheme: 'karst-diff',
      path: `/${++virtualDocumentId}/${safeBasename}`,
    });
    attempt.set(uri.toString(), resource.content);
    return uri;
  };
  const openTicketDiff = async (
    target: DiffTarget,
    viewColumn: number | undefined,
  ): Promise<void> => {
    const virtualAttempt = virtualDocuments.beginAttempt();
    try {
      const prepared = await prepareDiff(defaultGitRunner, target, workingFile);
      const leftUri = materializeDiffResource(prepared.left, virtualAttempt);
      const rightUri = materializeDiffResource(prepared.right, virtualAttempt);
      await vscode.commands.executeCommand(
        'vscode.diff',
        leftUri,
        rightUri,
        prepared.title,
        // The column is the panel's own + 1 (see `diffViewColumn`): `Beside`
        // resolves against whatever is active when this runs, which after the
        // first diff is that diff — so every click used to open ANOTHER group.
        { preview: true, viewColumn: viewColumn ?? vscode.ViewColumn.Beside },
      );
      virtualAttempt.commit();
    } catch (error) {
      virtualAttempt.rollback();
      if (error instanceof StaleDiffTargetError) throw error;
      if (error instanceof TextDiffUnavailableError) {
        void vscode.window.showWarningMessage(error.message);
        return;
      }
      // Rethrown, not swallowed: the manager's generic branch is what tells the
      // user their click failed. Returning here would resolve the promise and
      // leave an unexpected failure completely silent in the UI.
      logError('karst: opening native ticket diff failed', error);
      throw error;
    }
  };

  const changes = new TicketChangesManager(
    makeChangesPanelHost(context, brandIcon),
    (ticketId) => {
      const t = getTicket(localStore, ticketId);
      return `${compactTicketLabel(t, ticketLabel(t))} — Changes`;
    },
    async (ticketId, signal) => {
      const pathContext = worktreePathContext(currentManifest(), logger.warn, logger.info);
      const worktrees = listWorktreesByTicket(localStore, ticketId).map((worktree) => ({
        label: repoDisplayPath(worktree.repo, pathContext),
        path: worktree.path,
        branch: worktree.branch,
        baseRef: worktree.baseRef,
      }));
      return buildTicketChangesSnapshot(
        ticketId,
        worktrees,
        (spec, inspectSignal) => inspectWorktree(defaultGitRunner, spec, inspectSignal),
        undefined,
        signal,
      );
    },
    openTicketDiff,
    (message) => void vscode.window.showWarningMessage(message),
    logError,
    (text) => void vscode.env.clipboard.writeText(text),
    (ticketId, active) => activeTicket.set(ticketId, active),
  );
  shutdownTicketChanges = () => changes.dispose();
  context.subscriptions.push(changes);

  /**
   * Push the configured post-delivery status to the ticketing provider, for a
   * ticket that has just reached `done`.
   *
   * Window-scoped rather than per-dashboard because a ticket can reach `done`
   * from three unrelated places — the ship click (nothing to merge), a merge
   * click, or the background PR sweep noticing a teammate's merge — and the
   * status must be pushed once, by whichever of them actually moved it, with no
   * dashboard open required.
   *
   * Never throws and never blocks: the merge already happened, and a provider
   * that is down must not turn a landed ticket into an error the user has to
   * clear. `warn` is off for the sweep, which runs unattended — a toast nobody
   * asked for, once a minute, is noise.
   */
  const pushDoneStatus = async (ticketId: number, warn: boolean): Promise<void> => {
    try {
      const res = await advanceTicketOnShip(
        localStore,
        ticketId,
        currentManifest()?.ticketing,
        makeTicketingProvider(currentManifest()?.ticketing, fetch, makeTokenProvider(context)),
      );
      const note = statusPushSkipNote('completed', ticketId, res);
      if (note) logger.debug(note.message);
    } catch (e) {
      logError('ticket status update failed', e);
      if (warn) {
        void vscode.window.showWarningMessage(
          `Ticket merged, but the status update failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
  };

  // Declared before the manager because the two reference each other: the
  // manager asks the binder how the toggle sits, and the binder reveals through
  // the manager. Assigned immediately below, and neither direction is read
  // until a panel actually opens.
  let binder: TerminalDashboardBinder;

  // One token-usage panel per window (§ token consumption stats). Project-scoped
  // like every other query: the DB is global storage, shared by every window.
  const tokenUsagePanel = new UsagePanelManager(localStore, makeUsagePanelHost(context, brandIcon), {
    projectId: () => currentProject()?.id,
    openDashboard: (ticketId) =>
      void vscode.commands.executeCommand('karst.openDashboard', ticketId),
    logError,
  });

  // The resource monitor (leak hunter): one slow-lane sample every 30 s for the
  // window's lifetime, a fast lane only while the Resources panel is visible.
  // Host-agnostic; every host fact is injected. Window-scoped like the usage
  // panel — each window samples independently, and display is scoped to this
  // window's project.
  const worktreeRoots = (): string[] => {
    const manifest = currentManifest();
    if (!manifest) return [];
    const roots = new Set<string>();
    for (const repo of Object.values(manifest.repositories)) {
      roots.add(join(repo.repoPath, '.karst', 'worktrees'));
    }
    return [...roots];
  };
  const resourceMonitorInstance = new ResourceMonitor({
    store: localStore,
    projectId: () => currentProject()?.id,
    worktreeRoots,
    debug: (message) => logger.debug(message),
    logError,
  });
  resourceMonitor = resourceMonitorInstance;
  resourceMonitorInstance.start();

  const resourcesDisk = new WorktreeDiskCache();
  const resourcesPanel = new ResourcesPanelManager(makeResourcesPanelHost(context, brandIcon), {
    monitor: resourceMonitorInstance,
    disk: resourcesDisk,
    worktreePaths: () => {
      const project = currentProject();
      return project ? listWorktreesByProject(localStore, project.id).map((w) => w.path) : [];
    },
    pathContext: () => worktreePathContext(currentManifest(), logger.warn, logger.info),
    // The attributed lane carries only `tickets.id`; resolve it to the key/title
    // the user can match against their board (the id is not a visible label).
    ticketIdentity: (ids) =>
      new Map([...listTicketLifecycle(localStore, ids)].map(([id, t]) => [id, { key: t.key, title: t.title }])),
    scopeLabel: () => {
      const project = currentProject();
      return project ? `Project ${project.name ?? project.slug} · this window` : '';
    },
    // The kill confirmation is HOST-side (UI-R33): the webview posts only a
    // `servers.id`, and a crafted message can never skip this modal.
    confirm: async (message) => {
      const choice = await vscode.window.showWarningMessage(message, { modal: true }, 'Stop process');
      return choice === 'Stop process';
    },
    logError,
  });
  context.subscriptions.push(
    { dispose: () => resourceMonitorInstance.dispose() },
    { dispose: () => resourcesPanel.dispose() },
  );

  // The always-on meter. Hidden while there is nothing to say — the one surface
  // the user cannot dismiss must not be permanent noise.
  const resourcesStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  resourcesStatus.command = 'karst.openResources';
  context.subscriptions.push(resourcesStatus);
  resourceMonitorInstance.onReading((reading) => {
    const indicator = buildResourceIndicator(reading);
    if (!indicator) {
      resourcesStatus.hide();
      return;
    }
    resourcesStatus.text = indicator.text;
    resourcesStatus.tooltip = indicator.tooltip;
    resourcesStatus.backgroundColor = indicator.warning
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    resourcesStatus.show();
  });

  // One launch in flight per worktree path, per window. A second click during a
  // multi-minute build must not start a second build beside the first.
  const launchingWorktrees = new Set<string>();

  // The feature is a developer convenience, so it ships OFF by default
  // (karst.launchWorktreeDev.enabled) — most projects' worktrees are not karst
  // checkouts and must not be offered a dev-host button. Read LIVE on every
  // use: a settings edit must not need a window reload.
  const launchWorktreeConfig = (): ReturnType<typeof parseLaunchWorktreeConfig> =>
    parseLaunchWorktreeConfig(vscode.workspace.getConfiguration('karst').get('launchWorktreeDev'));

  // The dashboard button's gate, composed host-side: a worktree is launchable
  // when it IS a karst checkout AND the feature is enabled. State building is
  // kept config-free; the composed probe arrives as an injected parameter.
  const launchableCheckout = (path: string): boolean =>
    launchWorktreeConfig().enabled && isKarstCheckout(path);

  /**
   * Build a worktree's karst-extension checkout (`npm run dev:extension` — the
   * same recipe the F5 preLaunchTask runs) and open it in a NEW window as the
   * extension development host. The launch is CLI-driven
   * (`--extensionDevelopmentPath`), so it works from any window: the worktree
   * never has to be the folder this IDE was opened with, which is the whole
   * point — worktrees live in the hidden `.karst/worktrees/` directory the
   * file dialogs never show.
   *
   * The outcome is reported through the progress notification + toasts, never
   * through the caller's ack: a build takes minutes, which is far past the
   * webview watchdog. The dashboard action therefore returns immediately (an
   * "accepted" ack) and this function owns the real result.
   */
  const launchWorktreeDevWindow = async (worktreePath: string): Promise<void> => {
    if (!launchWorktreeConfig().enabled) {
      void vscode.window.showWarningMessage(
        'Karst: launch-worktree-extension is disabled — set karst.launchWorktreeDev.enabled to true.',
      );
      return;
    }
    if (launchingWorktrees.has(worktreePath)) {
      void vscode.window.showInformationMessage(`Already building ${worktreePath} — one launch at a time.`);
      return;
    }
    launchingWorktrees.add(worktreePath);
    try {
      const outcome = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Building worktree extension (${worktreePath})…`,
          cancellable: true,
        },
        (_progress, token) => {
          // Bridge VS Code's CancellationToken to a standard AbortSignal, the
          // same shape spinTicket uses for its health wait + child processes.
          const ctrl = new AbortController();
          token.onCancellationRequested(() => ctrl.abort());
          return launchWorktreeDev(
            worktreePath,
            launchWorktreeConfig(),
            vscode.env.appRoot,
            process.platform,
            {
              build: async (cwd, signal) => {
                const outcome = await runProcess('npm', ['run', LAUNCH_BUILD_SCRIPT], cwd, {
                  timeoutMs: LAUNCH_BUILD_TIMEOUT_MS,
                  signal,
                });
                if (outcome.kind === 'completed') {
                  return { kind: 'completed', exitCode: outcome.exitCode, output: outcome.output };
                }
                if (outcome.kind === 'aborted') return { kind: 'aborted' };
                return {
                  kind: 'failed',
                  message:
                    outcome.kind === 'spawnFailed'
                      ? outcome.message
                      : `Build timed out after ${LAUNCH_BUILD_TIMEOUT_MS / 60_000} minutes`,
                  output: outcome.output,
                };
              },
              cliExists: (cliPath) => existsSync(cliPath),
              binaryOnPath: (binary) => binaryExists(binary),
              // Detached + ignored stdio: the new window outlives this host, and
              // nothing may read a GUI process's streams.
              spawnWindow: (cliPath, args, cwd) => {
                const child = spawn(cliPath, args, { cwd, detached: true, stdio: 'ignore' });
                child.on('error', (err) => logError('karst: launching dev window failed', err));
                child.unref();
              },
            },
            ctrl.signal,
          );
        },
      );
      if (outcome.kind === 'launched') {
        void vscode.window.showInformationMessage(
          `Launched the worktree extension in a new window (${worktreePath}).`,
        );
      } else if (outcome.kind === 'failed') {
        void vscode.window.showErrorMessage(
          `Could not launch the worktree extension: ${outcome.message}`,
        );
      }
      // aborted: the user cancelled — the progress notification is its own report.
    } catch (err) {
      logError('launch worktree extension failed', err);
      void vscode.window.showErrorMessage(
        `Could not launch the worktree extension: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      launchingWorktrees.delete(worktreePath);
      provider.refresh();
      dashboard.pushAll();
    }
  };

  // Deferred graph-stop binding (Slice 3 Task 11): the coordinator transport
  // is created later in activate; the Inside Stop action reads it only after
  // activation has fully run, like `runPrSync` and `maybeDrive`.
  let stopGraphRun: ((ticketId: number, graphRunId: number) => Promise<void>) | undefined;
  let confirmGraphRunForTicket: ((ticketId: number, graphRunId: number) => void) | undefined;

  const dashboard = new DashboardManager(
    localStore,
    makePanelHost(context, brandIcon, (m) => logger.warn(m)),
    (ticketId) =>
      makeDashboardActions(
        localStore,
        ticketId,
        () => ticketForm.openEdit(ticketId),
        () => {
          provider.refresh();
          dashboard.pushState(ticketId);
          // Same sweep the tab icon rides on — the status text must not lag it.
          showStatusFor(ticketId);
        },
        logError,
        guardCapability,
        currentManifest,
        (ticketId) => prDescriptionProcess(ticketId),
        () => pushDoneStatus(ticketId, true),
        // Live Ship rides the generic inside-progress union (Finding 12): the
        // manager has no ship-specific progress channel any more.
        (event) => dashboard.postInsideProgress(ticketId, event),
        // Same deferred-reference pattern as `runPrSync` below: `runShipSaga`
        // is declared with the activation sweep, read only once a panel is open
        // (or the sweep fires). The click asks for the status-push warning
        // toast; the sweep's own call logs instead.
        (id) => runShipSaga(id, true),
        // The inside-action seam: the panel posts only an opaque id; the
        // manager resolves it through the ticket's CURRENT snapshot registry
        // and dispatches the stored host-only target.
        (actionId) => dashboard.dispatchInsideAction(ticketId, actionId),
        // A live session already owns the worktrees: nudge it and reveal the
        // terminal so the user sees the agent take the job. With none open,
        // launch one seeded with the brief instead of the ticket's own context.
        // A graph ticket is never nudged from here: the graph coordinator owns
        // its sessions (entry-point matrix, Slice 3 Task 7).
        (prompt) => {
          if (nudgeSurface(localStore.db, ticketId) === 'no-op') {
            return;
          }
          if (sessions.nudge(ticketId, prompt)) {
            sessions.focusSession(ticketId);
            return;
          }
          void vscode.commands.executeCommand('karst.openSession', ticketId, {
            seedPrompt: prompt,
          });
        },
        () => changes.open(ticketId),
        (provider, model, effort) => void switchAgentSession(ticketId, provider, model, effort),
        () => binder.toggle(),
        // Declared below with the sweep it forces (like `binder`, the two are
        // mutually referential); read only when a panel is actually open, which
        // is long after activation has run.
        () => runPrSync(true),
        // Same deferred-reference pattern as `runPrSync` above: `maybeDrive` is
        // declared further down `activate`, read only once a panel is open.
        (id) => maybeDrive(id, 'stage-resume'),
        (path) => void launchWorktreeDevWindow(path),
        () => launchWorktreeConfig(),
        (graphRunId) => graphRecoveryDeps(graphRunId),
        (launch) => void launchReplanPlannerHost(launch),
        (launch) => void launchBootstrapRelaunchHost(launch),
        // The stage key arrives from the webview; the manager resolves the read
        // through the injected reader and posts the answer to this ticket's
        // panel (the postInsideProgress pattern).
        (stage) => dashboard.requestStageLog(ticketId, stage),
        // The process id arrives from the webview; the manager resolves the
        // persisted console tail and posts the answer to this ticket's panel.
        (processId) => dashboard.requestAgentLog(ticketId, processId),
        (message) => logger.debug(message),
      ),
    () => worktreePathContext(currentManifest(), logger.warn, logger.info),
    () => currentManifest()?.ticketLabelTemplate,
    // Live ticketing config so the dashboard links to the source board (§ C3).
    () => currentManifest()?.ticketing,
    logError,
    // Resolve an approach id → its workflow phase names for the read-only
    // impl-stage breakdown (§ impl sub-stages). Missing package/dir → no
    // breakdown, never a throw.
    (approachId) => {
      if (!approachId) return [];
      try {
        const pkg = readApproachPackage(approachesDirOrThrow(), approachId);
        return pkg?.workflow?.map((p) => p.name) ?? [];
      } catch {
        return [];
      }
    },
    tabIconFor,
    // Runnability comes from the live manifest. Report false ONLY when the
    // manifest positively says this repo has no service; an unresolved manifest
    // or an unknown name answers true, so the dashboard degrades to offering the
    // button rather than hiding one that would have worked.
    (repo) => {
      const def = currentManifest()?.repositories[repo];
      return def === undefined || isRunnable(def);
    },
    // Live manifest agent core, so the Now line's verb resolves the same
    // provider openSession will launch with (a Continue it can't honor would
    // just flash a terminal that exits on a foreign `--resume`).
    () => currentManifest()?.agentProvider,
    {
      enabled: () => binder.enabled(),
      onDidActivate: (ticketId, active) => binder.onDashboardActivated(ticketId, active),
    },
    () => ({
      defaultModel: currentManifest()?.defaultModel ?? null,
      defaultEffort: currentManifest()?.defaultEffort ?? null,
      modelCatalog,
    }),
    (worktrees, signal) => loadWorktreeStats(worktrees, defaultGitRunner, logError, signal),
    // The rail's retry meter must draw the budget the driver will actually
    // spend, so it resolves through the SAME rule fixResumeDecision uses.
    (gate) =>
      capForGate(
        gate,
        currentManifest()?.uat?.maxFixAttempts,
        currentManifest()?.review?.maxFixAttempts,
      ),
    // Resolve a ticket's togglable gate names for the Gates panel. Reads the
    // SAME live manifest getter `DriveTicketDeps.manifest` is bound to, so a
    // mid-run `karst.yml` edit and a mid-run gate toggle are honored on
    // identical terms.
    buildGateOptionsLoader({ store: localStore, manifest: currentManifest }),
    // The inside-action host: vscode bindings for the containment-checked
    // dispatches (the panel already proved ownership + containment).
    makeInsideActionHost(localStore, {
      // Open reveals a LIVE graph session's terminal — it never spawns one.
      // The dispatch proved the run row belongs to the ticket; a session that
      // died since the snapshot simply has no terminal to reveal.
      graphOpenSession: (ticketId, session) => {
        const tr = graphTransport;
        const live = tr?.sessionFor(ticketId, session.runId);
        live?.terminal?.show(true);
      },
      // Declared here with the coordinator wiring it forces (like
      // `runPrSync`): bound later in activate, read only once a panel is open.
      graphStop: (ticketId, graphRunId) => {
        const handler = stopGraphRun;
        if (handler) void handler(ticketId, graphRunId);
      },
      graphConfirm: (ticketId, graphRunId) => confirmGraphRunForTicket?.(ticketId, graphRunId),
      // Fire the impl marker for a run that finished all its node work and is
      // durably waiting (Slice 7). Runs the SAME guarded transition
      // `karst stage impl pass` runs, including the waiting-agent refusal —
      // see `fireGraphImplMarkerFromHost`'s doc comment for why this must
      // never call `graphImplMarkerGuard` directly.
      graphMarkImpl: (ticketId, graphRunId) => {
        const result = fireGraphImplMarkerFromHost(localStore, ticketId);
        if (result.ok) {
          void vscode.window.showInformationMessage(
            `Ticket #${ticketId}: the implementation marker fired (graph run ${graphRunId}) — advancing to uat.`,
          );
        } else {
          void vscode.window.showWarningMessage(
            `Ticket #${ticketId}: could not fire the implementation marker (${result.reason}).`,
          );
        }
        provider.refresh();
        dashboard.pushState(ticketId);
      },
      // Discard an ambiguous node run (Slice 4 Task 4) — the named exit for a
      // process whose fate cannot be proven. The coordinator's OWN connection
      // runs the one transaction (a contended BEGIN IMMEDIATE must abort, not
      // wait), then the dashboard and sidebar refresh so the discarded row is
      // gone from the view. A second window's discard is an idempotent no-op.
      graphDiscardNode: (ticketId, nodeRunId) => {
        const gs = graphCoordinatorStore;
        if (!gs) return;
        try {
          const result = discardUnknownProcess(
            {
              db: gs.db,
              transaction: <T>(fn: () => T): T => runImmediateTransaction(gs.db, fn),
              now: () => new Date().toISOString(),
              debug: (message) => logger.debug(message),
              cleanupNodeWorkspace: (input) =>
                cleanupTerminalNodeWorkspace(
                  {
                    store: gs,
                    transaction: <T>(fn: () => T): T => runImmediateTransaction(gs.db, fn),
                    debug: (message) => logger.debug(message),
                  },
                  input,
                ),
            },
            { nodeRunId },
          );
          if (result.discarded) {
            void vscode.window.showInformationMessage(
              `Ticket #${ticketId}: unknown process for node run #${nodeRunId} discarded` +
                (result.graphBlockedWith
                  ? ' — the graph deadlocked on topology; resume or replan to continue.'
                  : ''),
            );
          }
          provider.refresh();
          dashboard.pushState(ticketId);
        } catch (err) {
          logError(`karst: graph discard failed for ticket ${ticketId}`, err);
        }
      },
      // Slice 6 Task 4: open the override editor for an editable agent node
      // BEFORE claiming. The dispatch proved the run row belongs to the ticket
      // and the projection minted the control only on a status the store's
      // claim gate still accepts a write for — so this surface can never reach
      // a frozen launch. The per-node override editor (profile/provider/model/
      // effort/prompt, `writeNodeOverride`/`clearNodeOverride` in
      // store/graph/nodeRuns.ts) has no dedicated UI yet; the callback is the
      // deep-link stub that will open it, and it reports the intended target
      // until then. The write itself stays behind the store's claim gate.
      graphEditOverride: (ticketId, nodeRunId) => {
        void vscode.window.showInformationMessage(
          `Ticket #${ticketId}: editing overrides for node run #${nodeRunId} — the per-node override editor (profile / provider / model / effort / prompt) opens here before claiming.`,
        );
      },
    },
    // Reveal (never launch) the ticket's own interactive session — the same
    // reveal-or-adopt path `nudge` uses, so a reload that emptied this
    // window's session bookkeeping still finds the still-running agent.
    (ticketId) => void sessions.revealSession(ticketId),
    (graphRunId) => graphRecoveryDeps(graphRunId),
    (launch) => void launchReplanPlannerHost(launch),
    (launch) => void launchBootstrapRelaunchHost(launch),
    (ticketId, graphRunId) => {
      provider.refresh();
      dashboard.pushState(ticketId);
      void driveGraphRunContinuation(graphRunId);
    },
  ),
  // Live manifest getter, so the inside views resolve the REAL service names
  // and process assignments (panel.ts is manifest-free by contract).
  () => currentManifest(),
    // The Launch Dev gate, composed from the feature's live config: hidden
    // (and refused) unless karst.launchWorktreeDev.enabled is true AND the
    // worktree is a karst checkout.
    launchableCheckout,
    // Reports the panel's raw activation (including losing it, and including
    // dispose-while-focused) so the sidebar can highlight this ticket's row.
    (ticketId, active) => activeTicket.set(ticketId, active),
    // The graph Inside projection (Slice 3 Task 11): a pure read over rows
    // the coordinator keeps current, keyed by ticket. Null for a ticket with
    // no graph run — the projection is inert.
    (ticketId) =>
      buildGraphInsideInput(
        {
          store: localStore,
          manifest: () => currentManifest(),
          liveSessions: () => graphTransport?.sessions() ?? [],
          now: () => new Date().toISOString(),
        },
        ticketId,
      ),
    // The terminal view's log source: resolve the stage row's recorded
    // artifactPath and read it bounded (the webview names only a stage key).
    (ticketId, stage) =>
      readStageLog(localStore, ticketId, stage, (path) => readFileSync(path, 'utf8'), (m) =>
        logger.debug(m),
      ),
    // The terminal view's AGENT console source: the persisted tail file the
    // gate-lane AI process wrote during its run (the webview names only a
    // process id). Reads through the same bounded AgentConsole the driver
    // streamed into, so a post-run console shows exactly what ran.
    (ticketId, processId) => agentConsole.readLog(ticketId, processId),
    // The base-branch combobox's candidates (§ per-repo base branch — live
    // change), same lister the ticket-form picker uses (Task 8) — never a
    // closed vocabulary, and never throws (the lister swallows git failures).
    (repoPath) => listBaseBranchCandidates(defaultGitRunner, repoPath),
  );

  // A karst.yml edit made OUTSIDE karst (hand edit in the editor, a teammate's
  // commit, `git checkout`) must reach an in-progress ticket without a session
  // restart. It already would if the cache were fresh: `driveTicket` reads the
  // manifest via the `currentManifest` getter (never a snapshot), so a gate
  // re-run picks up whatever `reloadManifest` last cleared. What was missing is
  // anything calling `reloadManifest` for a change karst did not make itself —
  // the settings-save and ticket-form paths only cover writes karst performs.
  //
  // The watch is anchored on the RESOLVED path (`manifestPathOrThrow`, the same
  // one rule every other reader goes through), never on the raw setting: the
  // shipped default is './.karst/karst.yml' and a glob does not normalize that
  // leading './', so a pattern built from the raw string matches nothing and the
  // watcher silently never fires. `manifestWatchTarget` reduces it to a bare
  // filename for exactly that reason, and is where the case is pinned.
  //
  // Registered here rather than beside `reloadManifest` because the refresh
  // needs `dashboard`: the sidebar alone would leave an open panel showing gates
  // the manifest no longer declares. `karst.manifestPath` is read once, at
  // activation — repointing it needs a window reload, like the other settings
  // this file reads at startup.
  try {
    const target = manifestWatchTarget(manifestPathOrThrow());
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(target.dir), target.base),
    );
    const onManifestFileChanged = (): void => {
      reloadManifest();
      provider.refresh();
      dashboard.pushAll();
    };
    watcher.onDidChange(onManifestFileChanged);
    watcher.onDidCreate(onManifestFileChanged);
    watcher.onDidDelete(onManifestFileChanged);
    context.subscriptions.push(watcher);
  } catch {
    // No workspace folder: there is no manifest to watch, and every other
    // manifest reader already degrades the same way rather than failing
    // activation.
  }

  binder = new TerminalDashboardBinder({
    isEnabled: () => context.workspaceState.get<boolean>(BIND_TERMINAL_KEY) === true,
    persist: (enabled) => void context.workspaceState.update(BIND_TERMINAL_KEY, enabled),
    // Open-or-reveal: a dashboard is a read-only view of the store, so the
    // terminal click can materialize one. `preserveFocus` keeps the caret in the
    // shell the user is typing into — and keeps the panel from going ACTIVE,
    // which is what stops the two listeners revealing each other in a circle.
    revealDashboard: (ticketId) => dashboard.openDashboard(ticketId, { preserveFocus: true }),
    // Reveal only. Never `karst.openSession`: that launches an agent, and
    // clicking a tab must not spend tokens or move the ticket.
    revealTerminal: (ticketId) => sessions.focusSession(ticketId, true),
    broadcast: () => dashboard.pushBind(),
  });

  context.subscriptions.push(
    // Every terminal in the window raises this, karst's or not; the ticket comes
    // from the launch env, or — after a reload has stripped it — from the pid
    // this window recorded, and a terminal with neither resolves to undefined.
    vscode.window.onDidChangeActiveTerminal((terminal) =>
      binder.onTerminalActivated(
        terminal ? terminalIdentity.identify(terminal)?.ticketId : undefined,
      ),
    ),
  );

  // The live verbose channel (§ naming/status): whatever a tab or terminal
  // abbreviates to a color, this states in words for the ticket the user last
  // touched. Blocked (`red`) also takes the warning background — a blocker is
  // never signalled by color alone.
  const sbItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(sbItem);
  const statusBar = new StatusBarManager({
    set: (text, warning, command) => {
      sbItem.text = text;
      sbItem.backgroundColor = warning
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
      sbItem.command = { command: command.id, title: 'Open dashboard', arguments: [command.arg] };
      sbItem.show();
    },
    hide: () => sbItem.hide(),
  });

  /** Re-render the status bar for a ticket; a missing ticket hides the item. */
  const showStatusFor = (ticketId: number): void => {
    try {
      const t = getTicket(localStore, ticketId);
      statusBar.render({
        ticketId,
        key: t.key ?? `#${ticketId}`,
        stage: t.stageCurrent ?? 'none',
        state: t.agentState ?? 'none',
        glyph: ticketGlyph(t),
      });
    } catch {
      statusBar.render(null);
    }
  };

  // The needs-you channel, and the reason the activity-bar logo carries state at
  // all: this must reach the user with the Karst panel CLOSED. Priority 50 sits
  // between the deps item (0) and the focused-ticket item (100); for
  // StatusBarAlignment.Left, HIGHER priority renders further LEFT, so the bar
  // reads left to right as: where you are (100) → what needs you (50) → tools
  // broken (0).
  const attnItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  attnItem.command = 'karst.showAttention';
  context.subscriptions.push(attnItem);
  const attention = new AttentionManager({
    setStatus: (text, tooltip, warning) => {
      attnItem.text = text;
      attnItem.tooltip = tooltip;
      attnItem.backgroundColor = warning
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
      attnItem.show();
    },
    hideStatus: () => attnItem.hide(),
    setBadge: (value, tooltip) => sidebarBadge.set(value, tooltip),
    clearBadge: () => sidebarBadge.clear(),
  });

  /**
   * The tickets needing this window's user. SCOPED: the store lives in global
   * storage and every IDE window shares it, so an unscoped read would badge this
   * window with another project's waiting tickets. When no project is bound
   * (no workspace folder, or `bindProject` threw) there is no scope to read
   * safely, so this returns empty rather than issuing an unscoped query.
   */
  const currentAttention = (): AttentionItem[] => {
    const projectId = currentProject()?.id;
    return projectId === undefined ? [] : attentionItems(listTickets(localStore, { projectId }));
  };

  /** Repaint both surfaces. Never throws: a failed repaint must not break the
   * sidebar push that just succeeded, and a store closed during shutdown reads
   * as "nothing needs you" rather than an error. The fallback render is itself
   * guarded — `attention.render([])` touches vscode objects and can throw too
   * (e.g. mid-teardown), and that must not escape either. */
  const refreshAttention = (): void => {
    try {
      attention.render(currentAttention());
    } catch (err) {
      logError('karst: attention refresh failed', err);
      try {
        attention.render([]);
      } catch (fallbackErr) {
        logError('karst: attention fallback render failed', fallbackErr);
      }
    }
  };

  // Coalesce bursts of `provider.onRefresh` — every live agent's PostToolUse
  // hook lands here via `provider.refresh()`, and `refreshAttention` is a full
  // ticket scan. CLAUDE.md bans blocking the extension host, so a scan per hook
  // POST is out; collapse everything within a tick into one repaint instead.
  // The timer is disposed on deactivation so a pending repaint never fires
  // after teardown, and the leading call below runs inline (unscheduled) so
  // first paint isn't delayed by a tick.
  let attentionRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleAttentionRefresh = (): void => {
    if (attentionRefreshTimer !== undefined) return;
    attentionRefreshTimer = setTimeout(() => {
      attentionRefreshTimer = undefined;
      refreshAttention();
    }, 0);
  };
  context.subscriptions.push({
    dispose: () => {
      if (attentionRefreshTimer !== undefined) clearTimeout(attentionRefreshTimer);
    },
  });

  provider.onRefresh(scheduleAttentionRefresh);
  refreshAttention();

  // Where the auto-driver persists its gate-run evidence (§11/§12), mirroring
  // the per-ticket layout the runners themselves expect.
  const artifactDirFor = (ticketId: number): string =>
    join(context.globalStorageUri.fsPath, 'artifacts', String(ticketId));

  // The graph byte subtree root for THIS window's project: `<globalStorage>/
  // graph/<projectSlug>`, the parent every ticket's subtree hangs under
  // (Decision 15). Undefined when the project is unbound — the retention sweep
  // covers whatever a delete with no project cannot name.
  const graphBytesRootFor = (): string | undefined => {
    const project = currentProject();
    return project ? join(context.globalStorageUri.fsPath, 'graph', project.slug) : undefined;
  };

  // The gate-lane AI processes' console sink (Task 13): the UAT Tester and the
  // Review findings lane stream their headless CLI output here — bounded and
  // sanitized, the retained tail persisted to the ticket's artifact dir (so it
  // survives a host restart and is readable after the run), and each chunk
  // pushed to an OPEN dashboard panel's terminal view in real time. `dashboard`
  // is declared above; `readFileSync`/`appendFileSync`/`mkdirSync` are the
  // host's fs bindings (this file is the vscode seam).
  const agentConsole = new AgentConsole({
    dirFor: artifactDirFor,
    readFile: (path) => readFileSync(path, 'utf8'),
    appendFile: (path, text) => appendFileSync(path, text),
    mkdir: (path) => mkdirSync(path, { recursive: true }),
    onOutput: (ticketId, processId, text) =>
      dashboard.postAgentOutput(ticketId, processId, text),
    debug: (message) => logger.debug(message),
  });

  // Auto-run the deterministic uat/review gates for a ticket after the
  // impl/fix marker (or a prior gate) leaves it at a gate boundary. Single-flight
  // via `driver.begin`/`end`; never authors a transition itself — `runUat`/
  // `runReview` own that (single-writer preserved). Everything below the host
  // seam lives in `workflow/driveTicket.ts`, which imports no vscode and is
  // therefore the only version of this logic under test.
  async function driveTicket(ticketId: number): Promise<void> {
    if (!driver.begin(ticketId)) return; // a run is already in flight
    logger.info(`stage driver: begin ticket ${ticketId}`);
    try {
      await driveTicketRun(
        {
          store: localStore,
          manifest: currentManifest,
          artifactDirFor,
          // Only a fallback: with a manifest, runUat plans its own multi-repository
          // targets and this path is not what decides where gates run.
          worktreeFor: (id) => listWorktreesByTicket(localStore, id)[0]?.path ?? null,
          onProgress: (id, stage, status) => {
            logger.info(`stage driver: ticket ${id} ${stage} → ${status}`);
            provider.refresh();
            dashboard.pushState(id);
          },
          // Live inside operation events (Task 13/14): a same-tick overlay
          // between full snapshots — the driver's own onGateComplete pushes a
          // snapshot right after, which supersedes it. No-op when the panel
          // is closed; validated again at the panel boundary.
          onInsideProgress: (event) => dashboard.postInsideProgress(ticketId, event),
          // Live output from the gate-lane AI processes (the UAT Tester and the
          // Review findings lane): bounded + sanitized by the AgentConsole, the
          // retained tail persisted to the ticket's artifact dir, and each
          // chunk pushed to an OPEN panel's terminal view in real time. The
          // console tail is readable after the run through the same sink.
          onAgentOutput: (id, processId, chunk) => agentConsole.append(id, processId, chunk),
          shouldContinue: () => driver.shouldContinue(ticketId),
          // Stop, as a signal rather than a between-stages poll: `requestStop`
          // aborts this, and the abort reaches the gate child already running.
          signal: driver.signalFor(ticketId),
          resumeFix: (id, gate, attempts, roundId, process) =>
            resumeFixSession(id, gate, attempts, roundId, process),
          // Reveals the ticket's Changes panel (`TicketChangesManager`,
          // already wired above) — it does NOT itself call `openTicketDiff`/
          // `vscode.diff`; that only fires once the human clicks a file row
          // inside the panel. That distinction is deliberate: `vscode.diff`
          // compares exactly two documents, `openTicketDiff` is scoped to one
          // file at a time, and a review's affected set is an unbounded list
          // of changed files across N targets — auto-opening a diff editor
          // per file per target would fling open an unbounded, unprompted
          // stack of tabs with no way for the user to decline. The Changes
          // panel is the surface this codebase already has for presenting a
          // ticket's full change set to a human without doing that, and
          // reaching a specific file's real diff from it is one click away.
          // the persisted 'changes' evidence is worded to match this exactly
          // — "changes panel opened", never "diff
          // opened". The panel aggregates every worktree for a ticket, so
          // revealing it by ticket id covers every affected target review
          // calls this for; `cwd` names nothing further to open.
          openDiff: (id) => changes.open(id),
          // The Tester, Review and Fix AI processes (Task 8/Task 3): resolved
          // per ticket as an identity snapshot + the instrumented adapter,
          // exactly once per driver run. The callbacks return
          // `DriveProcessBundle | null` Natively — a role configured
          // `enabled: false` resolves to null and the driver omits the
          // process: nothing is created or instrumented for the disabled role,
          // and the Fix seam performs no launch or nudge.
          uatTester: (id) => processFor(id, 'uat-tester'),
          reviewProcess: (id) => processFor(id, 'review'),
          fixProcess,
          runVerifier: runProcess,
          log: (message) => logger.info(message),
          // Verbose decision-point lines (manifest `debug` flag): gated inside
          // the logger, so this binding is a no-op unless debug is on. Surfaces
          // only in the Karst output channel — see Debug Logging Rules.
          debug: (message) => logger.debug(message),
          // Findings-lane boundary diagnostics (a failed AI call, garbage
          // output, an untrustworthy `file`) — routed to `Logger.warn` so
          // they read as warnings in the output channel rather than as
          // routine `info` progress lines or (absent this) the invisible
          // extension-host console.
          warn: (message) => logger.warn(message),
        },
        ticketId,
      );
    } catch (e) {
      logError('stage driver failed', e);
    } finally {
      driver.end(ticketId);
      provider.refresh();
      dashboard.pushState(ticketId);
    }
  }

  // A failed gate parks the ticket at `fix` with nothing running: karst never
  // calls `runFix`, and the driver stops at fix because a fix needs an agent, not
  // a gate. So resume the agent here — with the failing gate's reason + log and
  // the `stage fix pass` marker.
  //
  // Two ways in, because gates now run WHILE the session is open (the marker, not
  // the terminal, says the work is done). If that session is still live, the agent
  // is sitting at its prompt: `openSession` would drop the brief on the floor, so
  // nudge it instead. Only a closed session gets a fresh background (--resume)
  // launch. Neither path reveals the IDE. The marker rides along either way —
  // the live session was seeded the IMPL marker, and firing that at fix would
  // move the wrong stage.
  //
  // Capped: an unfixable ticket would otherwise loop fix→uat/review→fix forever,
  // burning tokens with no human ever looking. The cap itself is decided by
  // the driver (`fixResumeDecision` / the committed recovery round) — this
  // function only runs once a resume has been granted, so reaching it IS the
  // decision.
  function resumeFixSession(
    ticketId: number,
    gate: GateStageKey,
    attempts: number,
    roundId: number | null,
    process: DriveProcessBundle | null,
  ): void {
    // Task 3: a configured-ABSENT Fix process (enabled: false) never reaches
    // the session manager — no launch, no nudge, no fabricated process
    // evidence. The pending recovery round is left for a human, exactly as the
    // driver's fix block reads it, and the stage row parks so it stops reading
    // as if the agent were still fixing.
    if (process === null) {
      logger.info(
        `configured Fix process disabled — ticket ${ticketId} left at fix for a human (${gate} round ${roundId ?? 'untracked'})`,
      );
      try {
        if (parkFixStage(localStore, ticketId, FIX_PARKED_PROCESS_UNAVAILABLE, new Date().toISOString())) {
          logger.info(
            `stage driver: ticket ${ticketId} fix parked — the configured Fix process is disabled`,
          );
        }
      } catch (err) {
        logError(`karst: parking the fix stage for ticket ${ticketId} failed`, err);
      }
      return;
    }
    const t = getTicket(localStore, ticketId);
    const label = t.key ?? `#${ticketId}`;
    const brief =
      renderFixBrief(
        label,
        t.stages,
        latestFindingBatch(localStore, ticketId),
        listGateRuns(localStore, ticketId),
      ) ??
      `A gate failed for ticket ${label}. Re-run the checks, fix what they report, and confirm they pass.`;
    const marker = renderDoneMarkerInstruction(
      buildCliStagePrefix(context, dbPath, 'fix'),
      t.key ?? String(ticketId),
    );
    // Task 3: the Fix execution carries the CONFIGURED identity — the bundle's
    // assignment snapshot resolved once at the driver boundary — never the
    // live session's recorded identity and never a fresh resolution.
    const configured = {
      provider: process.assignment.provider,
      model: process.assignment.model ?? null,
      agentName: process.assignment.agentName ?? null,
    };
    // v30: the Fix execution is tracked against its committed recovery round.
    // A LIVE session opens and attaches the Fix process run BEFORE the brief
    // is delivered (the configured identity snapshot is captured into the
    // run); a closed session launches and the run opens when its SessionStart
    // is accepted. Neither path reveals the IDE.
    const outcome = resumeConfiguredFixExecution(localStore, {
      ticketId,
      roundId,
      configuredIdentity: configured,
      startedAt: new Date().toISOString(),
      prompt: `${brief}\n\n${marker}`,
      isLive: () => sessions.isLive(ticketId),
      sessionIdentity: () => sessions.sessionIdentity(ticketId),
      // A matching live core is already ready and is nudged without probing.
      // Closed, divergent and unknown-identity paths prove the configured core
      // immediately before any disposal or replacement launch.
      providerReady: () =>
        guardProviderCapability('sessions', process.assignment.provider),
      nudge: (prompt) => sessions.nudge(ticketId, prompt),
      dispose: () => sessions.disposeSession(ticketId),
      open: (replacement) => {
        void vscode.commands.executeCommand('karst.openSession', ticketId, {
          reveal: false,
          providerReady: true,
          // A live terminal with a divergent or unknown identity was retired;
          // never resume its conversation under the configured assignment.
          ...(replacement ? { allowResume: false } : {}),
          // Host-only: the configured Fix identity overrides ticket/manifest
          // precedence inside `karst.openSession`.
          assignment: process.assignment,
        });
      },
    });
    if (outcome === 'unavailable') {
      // The configured Fix core could not be proven ready (missing binary,
      // unprobeable CLI): nothing launched and nothing will — the ticket is
      // parked for a human, and the stage row must read that way.
      try {
        if (parkFixStage(localStore, ticketId, FIX_PARKED_PROCESS_UNAVAILABLE, new Date().toISOString())) {
          logger.info(
            `stage driver: ticket ${ticketId} fix parked — the configured Fix core is not available`,
          );
        }
      } catch (err) {
        logError(`karst: parking the fix stage for ticket ${ticketId} failed`, err);
      }
      return;
    }
    logger.info(
      `stage driver: ticket ${ticketId} → ${outcome === 'nudged' ? 'nudged live session to fix' : 'resuming agent to fix'} (attempt ${attempts})`,
    );
  }

  // The §5.4-safe driver nudge, from any trigger: the explicit marker (or a prior
  // gate) already transitioned the stage; if the ticket now sits at a deterministic
  // gate, kick the driver to run it — an open terminal does NOT hold it back, since
  // the marker (not the session) is what says the work is done. Reused by the hook
  // channel, the session-close sweep, and the activation sweep so a gate never
  // strands just because one trigger (e.g. an unreachable SessionEnd hook) was missed.
  let gateToolsWarned = false;
  const maybeDrive = (ticketId: number, trigger: string): void => {
    const t = getTicket(localStore, ticketId);
    // Paused is the FIRST gate: a paused ticket must not spend a process, a
    // token, or a terminal on any trigger — hook, sweep, session close, or an
    // explicit resume. `driveTicket` refuses again at its own entry, but the
    // refusal belongs here too so the trigger is logged as skipped rather than
    // as a drive that did nothing.
    if (t.pausedAt != null) {
      logger.debug(`stage driver: ${trigger} → ticket ${ticketId} skipped (paused)`);
      return;
    }
    if (!shouldStartDriver(t.stageCurrent as StageKey)) return;
    // A graph ticket at impl with an active graph run is driven by the graph
    // coordinator, never by the stage driver (Slice 3 Task 7 entry-point
    // matrix: the graph owns the ticket until it completes).
    if (!shouldDriveGraphTicket(localStore.db, ticketId)) {
      logger.debug(`stage driver: ${trigger} → ticket ${ticketId} skipped (active graph)`);
      return;
    }
    // A missing gate tool is NOT a failing gate. Left unguarded, every gate exits
    // nonzero, the driver reads that as a code verdict, and the ticket parks at
    // fix in a loop no agent can win. Warn once — the activation sweep drives
    // every parked ticket, and N toasts say nothing the first one didn't.
    if (!guardCapability('gates', undefined, gateToolsWarned)) {
      gateToolsWarned = true;
      logger.warn(`stage driver: ${trigger} → ticket ${ticketId} not driven, gate tools missing`);
      return;
    }
    logger.info(`stage driver: ${trigger} → drive ticket ${ticketId} at ${t.stageCurrent}`);
    void driveTicket(ticketId);
  };

  // The hook channel fans liveness/needs-you out to the sidebar + any open
  // dashboard, so a waiting agent turns amber without opening its terminal.
  // The notify/barrier/provider closures are shared verbatim with the agy
  // conversation watch below: a watch event is a hook event, and the two
  // channels must never disagree about ownership, refresh or the generation.
  const notifyHook = (ticketId: number, payload: HookPayload): void => {
    // UsageUpdate changes only the token ledger. Refresh the two surfaces that
    // read it, then stop: usage is not lifecycle activity and must never kick
    // the stage driver or alter session ownership.
    if (payload.hook_event_name === 'UsageUpdate') {
      tokenUsagePanel.refresh();
      dashboard.pushStoreState(ticketId);
      return;
    }
    if (payload.hook_event_name === 'SessionStart') {
      recoveryLifecycle.sessionStarted(ticketId, payload.launchId);
    }
    const ownership = sessionOwnershipAction(
      payload.hook_event_name,
      sessions.isOpen(ticketId),
    );
    const ownershipChanged =
      ownership === 'add'
        ? !ownedSessionTickets.has(ticketId)
        : ownership === 'remove'
          ? ownedSessionTickets.has(ticketId)
          : false;
    if (ownership === 'add') ownedSessionTickets.add(ticketId);
    if (ownership === 'remove') ownedSessionTickets.delete(ticketId);
    if (ownershipChanged) void persistOwnedSessionTickets();
    provider.refresh();
    dashboard.pushState(ticketId);
    maybeDrive(ticketId, 'hook');
  };
  const shouldApplyHookState = (ticketId: number, payload: HookPayload): boolean =>
    shouldApplySessionHookState(sessions, recoveryLifecycle, ticketId, payload);
  // Tag each captured session with the core that minted it, so a later switch
  // (this ticket's override OR the manifest default) is detectable instead of
  // surfacing as a failed `--resume` on the next Continue.
  const sessionProviderFor = (ticketId: number): AgentProvider | null =>
    resolveProvider(
      getTicket(localStore, ticketId).agentProvider,
      currentManifest()?.agentProvider,
    );
  const rememberedPort = context.workspaceState.get<number>(HOOK_PORT_KEY) ?? 0;
  endpoint = await startHookEndpoint(
    localStore,
    rememberedPort,
    notifyHook,
    logError,
    shouldApplyHookState,
    sessionProviderFor,
    {
      recorder: hookChannelRecorder,
      debug: (message) => logger.debug(message),
      ticketApi: {
        // Same getter pattern as the ticket form: the project binds at
        // activation, read it at call time.
        projectId: () => currentProject()?.id,
        // A created ticket must appear in the sidebar immediately; a dashboard
        // tab for it is not open (no one navigated to it), and pushState is a
        // no-op when no panel is open — safe either way.
        onTicketCreated: (ticketId) => {
          provider.refresh();
          dashboard.pushState(ticketId);
        },
      },
    },
  );
  if (endpoint.port !== rememberedPort) {
    await context.workspaceState.update(HOOK_PORT_KEY, endpoint.port);
  }

  // Graph coordinator wiring (Slice 3 Task 2) — wiring only, all logic lives
  // in the coordinator modules. The coordinator gets its OWN connection with
  // a zero busy timeout: a contended BEGIN IMMEDIATE must abort immediately
  // (a synchronous busy wait would block the shared event loop), and that
  // policy must not leak onto the main connection every other path uses.
  // WAL keeps the second connection consistent with the first.
  graphCoordinatorStore = openStore(dbPath);
  graphCoordinatorStore.db.pragma('busy_timeout = 0');
  graphEndpoint = await startGraphWakeupEndpoint({
    schedule: (graphRunId) => {
      void runGraphCoordinatorTick(graphRunId);
    },
    debug: (message) => logger.debug(message),
  });

  // Per-graph-run loopback routes: created on demand and handed to the
  // launcher, which puts the URL and route token into the agent environment.
  // A route is a wake-up capability only — it can never advance state.
  const graphRoutes = new Map<number, { url: string; token: string }>();

  /** One bounded coordinator tick for a graph run; a failure only delays the
   *  next tick (the sweep is the source of truth, never this callback). The
   *  claim-time base heads are captured right before the tick and handed to
   *  it, so the activations this tick claims record exactly the integration
   *  state their workspaces must clone. */
  const runGraphCoordinatorTick = async (graphRunId: number): Promise<void> => {
    const gs = graphCoordinatorStore;
    if (!gs) return;
    let baseHeads: BaseHead[] = [];
    try {
      baseHeads = await readBaseHeads(graphRunId);
    } catch (err) {
      // A head that cannot be probed is simply not captured; the tick still
      // runs (a claim that records no base blocks no workspace launch).
      logError('karst: graph base-head capture failed', err);
    }
    // Ensure the run's wake-up route exists before any of its sessions can
    // launch; the launcher reuses the same route when composing the env.
    graphRouteFor(graphRunId);
    try {
      runCoordinatorTick(
        {
          db: gs.db,
          transaction: <T>(fn: () => T): T => runImmediateTransaction(gs.db, fn),
          now: () => new Date().toISOString(),
          debug: (message) => logger.debug(message),
          baseHeadsOf: () => baseHeads,
          // Slice 5 T2: the physical domains each activation needs, resolved
          // from the node's declared claims — the claim acquires one `held`
          // lease per domain inside its transaction.
          domainsForActivation: graphDomainsForActivation,
          // Slice 5 T3: the manifest's `graph.limits.maxParallel` — the sweep's
          // pre-claim admission and each claim's atomic slot reservation both
          // enforce the external-process ceiling against it.
          maxParallelOf: (graphRunId) => {
            const run = gs.db
              .prepare('SELECT approach_id FROM approach_graph_runs WHERE id = ?')
              .get(graphRunId) as { approach_id: string } | undefined;
            if (!run) return undefined;
            const graph = (currentManifest() ?? emptyManifest()).approaches?.find(
              (a) => a.id === run.approach_id,
            )?.graph;
            return graph?.limits?.maxParallel ?? DEFAULT_GRAPH_LIMITS.maxParallel;
          },
        },
        { graphRunId },
      );
    } catch (err) {
      // Bookkeeping over state that is already stored: the next tick retries.
      logError(`karst: graph coordinator tick failed for run ${graphRunId}`, err);
    }
    // Completing nodes are integrated by THIS window, in node-run order (the
    // pipeline's integrating-slot CAS serializes the write phases across
    // windows). A deferred node is retried on the next tick. The continuation
    // also accepts a submitted plan and executes newly claimed node runs.
    void driveGraphRunContinuation(graphRunId);
  };

  /** The wake-up route for a graph run, created on first use. */
  const graphRouteFor = (graphRunId: number): { url: string; token: string } => {
    const existing = graphRoutes.get(graphRunId);
    if (existing) return existing;
    const route = graphEndpoint!.registerRoute({ graphRunId });
    graphRoutes.set(graphRunId, route);
    return route;
  };

  /** Run the completing pipeline for every completing node of a graph run,
   *  ascending node-run order (deterministic integration order), then settle
   *  the run: a blocked node blocks the run (earliest failure by durable
   *  event order), END-quiescent runs flip to the marker-ready status, and a
   *  blocked run writes its `approach-graph-failed` stage block. */
  const driveCompletingNodes = async (graphRunId: number): Promise<void> => {
    const gs = graphCoordinatorStore;
    const tr = graphTransport;
    if (!gs || !tr) return;
    const completing = gs.db
      .prepare(
        `SELECT id FROM approach_node_runs
         WHERE graph_run_id = ? AND status = 'completing'
         ORDER BY id`,
      )
      .all(graphRunId) as { id: number }[];
    for (const row of completing) {
      try {
        const deps = graphCompletionPipelineDeps(graphRunId);
        if (!deps) return;
        await runCompletionPipeline(deps, { graphRunId, nodeRunId: row.id });
      } catch (err) {
        // A failed pipeline never retries itself; the next tick re-drives the
        // node, which is still `completing` unless a transition already moved
        // it. The pipeline is single-flighted per node by that CAS.
        logError(`karst: completion pipeline failed for graph node ${row.id}`, err);
      }
    }
    settleGraphRun(gs.db, graphRunId);
  };

  /** After integration: a blocked node blocks the run, and an END-quiescent
   *  run flips to `completed-awaiting-impl-marker`. A blocked run then gets
   *  its `approach-graph-failed` stage block, once, via the boundary module. */
  const settleGraphRun = (db: ReturnType<typeof openStore>['db'], graphRunId: number): void => {
    const run = db
      .prepare('SELECT id, status, ticket_id FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { id: number; status: string; ticket_id: number } | undefined;
    if (!run) return;
    if (run.status === 'running') {
      // A node reported `blocked` while the run kept running: the graph must
      // not dangle at impl. The earliest blocked node (durable order = id)
      // names the reason; the graph run blocks with it.
      const blockedNode = db
        .prepare(
          `SELECT id, reason, outcome FROM approach_node_runs
           WHERE graph_run_id = ? AND status = 'blocked'
           ORDER BY id LIMIT 1`,
        )
        .get(graphRunId) as { id: number; reason: string | null; outcome: string | null } | undefined;
      if (blockedNode) {
        // Slice 4 Task 5: a node reporting `replan` is an election trigger,
        // never a `node-blocked` block. `electReplan` decides it all — the
        // single-winner `running → draining` election, or the budget-refusal
        // block — in one transaction; host-agnostic logic lives in replan.ts.
        if (blockedNode.outcome === 'replan') {
          const elected = electReplan(
            {
              db,
              transaction: <T>(fn: () => T): T => runImmediateTransaction(db, fn),
              now: () => new Date().toISOString(),
              debug: (message) => logger.debug(message),
            },
            { graphRunId, requestNodeRunId: blockedNode.id },
          );
          logger.debug(
            `[graph] run ${graphRunId} replan election for node ${blockedNode.id} → ${JSON.stringify(elected)}`,
          );
          return;
        }
        const reason = `node-blocked: node ${blockedNode.id} (${blockedNode.reason ?? 'blocked by agent'})`;
        const blocked = flipOrBlockGraph(db, graphRunId, reason);
        if (blocked) {
          blockGraphStage(graphCoordinatorStore!, run.ticket_id, graphRunId, () => new Date().toISOString());
        }
        return;
      }
      const result = flipOnEndQuiescence(
        {
          db,
          transaction: <T>(fn: () => T): T => runImmediateTransaction(db, fn),
          now: () => new Date().toISOString(),
          debug: (message) => logger.debug(message),
        },
        { graphRunId },
      );
      if (result.flipped) {
        logger.debug(`[graph] run ${graphRunId} quiescent — waiting for the impl marker`);
        // Make the wait visible on the stage row itself (needs-you amber),
        // the same way blockGraphStage makes a graph fault visible.
        markGraphAwaitingImplMarker(
          graphCoordinatorStore!,
          run.ticket_id,
          graphRunId,
          () => new Date().toISOString(),
        );
      }
      return;
    }
    if (run.status === 'blocked') {
      blockGraphStage(graphCoordinatorStore!, run.ticket_id, graphRunId, () => new Date().toISOString());
    }
  };

  /** Block a running graph run with a reason, atomically; false when it
   *  already moved (a second window or an earlier event). */
  const flipOrBlockGraph = (db: ReturnType<typeof openStore>['db'], graphRunId: number, reason: string): boolean => {
    return runImmediateTransaction(db, () => {
        if (
          !casStatus(db, 'approach_graph_runs', GRAPH_RUN_TRANSITIONS, graphRunId, 'running', 'blocked')
        ) {
          return false;
        }
        db.prepare('UPDATE approach_graph_runs SET blocked_reason = ?, updated_at = ? WHERE id = ?').run(
          reason,
          new Date().toISOString(),
          graphRunId,
        );
      return true;
    });
  };

  /** The live transport session for a node OR planner run, via its ticket. */
  const graphSessionFor = (runId: number) => {
    const gs = graphCoordinatorStore;
    const tr = graphTransport;
    if (!gs || !tr) return undefined;
    const node = gs.db
      .prepare('SELECT gr.ticket_id FROM approach_node_runs nr JOIN approach_graph_runs gr ON gr.id = nr.graph_run_id WHERE nr.id = ?')
      .get(runId) as { ticket_id: number } | undefined;
    if (node) return tr.sessionFor(node.ticket_id, runId);
    // A bootstrap planner run lives in `approach_planner_runs`, not the node
    // table — the reconcile planning branch resolves planner ids too.
    const planner = gs.db
      .prepare('SELECT ticket_id FROM approach_graph_runs gr JOIN approach_planner_runs p ON p.graph_run_id = gr.id WHERE p.id = ?')
      .get(runId) as { ticket_id: number } | undefined;
    if (!planner) return undefined;
    return tr.sessionFor(planner.ticket_id, runId);
  };

  /**
   * Re-attach a live graph session to this window after a reload. The
   * transport's session registry is in-memory and recreated fresh on
   * activation; the terminals themselves survive, so a session whose
   * `KARST_LAUNCH_ID` still matches a live node/planner run of the active
   * graph is re-registered from the revived terminal — NEVER a second spawn.
   * This is what the "the coordinator re-attaches it on the next sweep"
   * message promises; without it a planning/running graph sits stalled with no
   * interaction path (the reported defect).
   */
  const reattachGraphSessions = async (): Promise<void> => {
    const gs = graphCoordinatorStore;
    const tr = graphTransport;
    if (!gs || !tr) return;
    for (const terminal of vscode.window.terminals) {
      await terminalIdentity.resolve(terminal);
      const named = terminalIdentity.identify(terminal);
      if (!named || named.launchId === undefined) continue;
      if (tr.sessionFor(named.ticketId, Number(named.launchId))) continue; // already attached
      const identity = reattachableSessionIdentity(gs.db, {
        ticketId: named.ticketId,
        launchId: named.launchId,
      });
      if (!identity) continue;
      const session: SupervisedAgentSession = {
        nodeRunId: identity.nodeRunId,
        ticketId: named.ticketId,
        graphRunId: identity.graphRunId,
        pid: identity.pid,
        cwd: graphTerminalCwd(terminal),
        generation: identity.generation,
        ownerNonce: identity.ownerNonce,
        startedAt: identity.startedAt,
        processRunId: identity.processRunId,
        providerSessionId: null,
        terminal: wrapRevivedGraphTerminal(terminal),
      };
      tr.adopt(session);
      logger.debug(
        `[graph] re-attached live ${identity.kind} session for run ${identity.nodeRunId} (ticket ${named.ticketId})`,
      );
    }
  };

  /** The graph run's artifact root under global storage (Decision 15): where
   *  node outputs stage and content-addressed snapshots land. Empty when the
   *  project is unbound — no graph work can run then, and the pipeline's
   *  validation simply finds nothing declared. */
  const graphArtifactRoot = (graphRunId: number): string => {
    const gs = graphCoordinatorStore;
    const proj = currentProject();
    if (!gs || !proj) return '';
    const run = gs.db
      .prepare('SELECT ticket_id FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { ticket_id: number } | undefined;
    if (!run) return '';
    return artifactRootDir(context.globalStorageUri.fsPath, proj.slug, run.ticket_id, graphRunId);
  };

  /** The graph recovery deps (Slice-4 T6): the atomic claim wrapper plus the
   *  prompt re-snapshot seam — content-addressed writes under the graph
   *  artifact root, and the effective-prompt resolution that consults the
   *  per-node `prompt` override. All decision logic lives in recovery.ts;
   *  this binding only supplies the seam the host owns. The prompt seams
   *  (`readPrompt`/`plannerPromptPath`/`ticketContext`) are resolved per run
   *  so a `planner-relaunch` recovery can re-snapshot the effective planner
   *  prompt and seed the relaunched bootstrap planner exactly like the initial
   *  launch does. */
  const graphRecoveryDeps = (graphRunId: number): RecoveryDeps => {
    const gs = graphCoordinatorStore;
    return {
      store: gs!,
      transaction: <T>(fn: () => T): T => runImmediateTransaction(gs!.db, fn),
      now: () => new Date().toISOString(),
      debug: (message) => logger.debug(message),
      resolveEffective: ({ revisionId, nodeId }) => {
        if (!gs) return { promptOverride: false };
        const override = nodeOverrideFor(gs.db, revisionId, nodeId, 'prompt');
        return override
          ? { prompt: override.value, promptOverride: true }
          : { promptOverride: false };
      },
      writeSnapshot: (runId, relativePath, bytes) => {
        const root = graphArtifactRoot(runId);
        if (!root) return;
        const target = join(root, relativePath);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
      },
      // The artifact-fault re-probe's root: the SAME content-addressed root the
      // integration pipeline validated the node's required outputs against, so
      // an explicit Resume re-asks the question that faulted rather than
      // assuming a human's correction. Absent, the recheck fails closed.
      artifactRoot: (runId) => graphArtifactRoot(runId),
      // The bootstrap relaunch's prompt seams: the effective planner prompt
      // bytes (packaged overlaid with the project override), its artifact
      // path, and the ticket's rendered context — resolved for THIS run so
      // the relaunched bootstrap planner is seeded exactly like the initial.
      readPrompt: () => {
        try {
          return graphDriverDeps().promptBytesOf('karst-graph-planner');
        } catch {
          return undefined;
        }
      },
      plannerPromptPath:
        graphApproachConfigFor(graphRunApproachId(graphRunId))?.planner.prompt?.artifact ??
        'skills/graph-planner/SKILL.md',
      ticketContext:
        graphRunId > 0
          ? renderTicketContext(
              buildTicketContext(
                localStore,
                currentManifest(),
                graphRunTicketId(graphRunId),
                context.globalStorageUri.fsPath,
              ),
            )
          : undefined,
    };
  };

  /** The ticket's manifest repository entries resolved to worktree paths. */
  const graphDomainsFor = (graphRunId: number): DomainEntry[] => {
    const gs = graphCoordinatorStore;
    if (!gs) return [];
    const run = gs.db
      .prepare('SELECT ticket_id FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { ticket_id: number } | undefined;
    if (!run) return [];
    const manifest = currentManifest() ?? emptyManifest();
    const worktrees = listWorktreesByTicket(localStore, run.ticket_id);
    // `worktrees.repo` stores the repo PATH, never the manifest name, so the
    // manifest names resolve through their own repoPath (a monorepo's two
    // entries sharing a repoPath resolve to the one worktree — the designed
    // outcome, not a collision).
    return resolveRepoWorktrees(manifest.repositories ?? {}, worktrees);
  };

  /**
   * Claim-time base heads (Slice 5 T1): per physical-domain HEAD of the
   * canonical worktrees, captured right before a coordinator tick claims
   * activations, so every node run records the integration state its
   * workspace must clone. A domain whose HEAD cannot be resolved simply is
   * not captured — the node run records the bases that were observable.
   */
  const readBaseHeads = async (graphRunId: number): Promise<BaseHead[]> => {
    const gs = graphCoordinatorStore;
    if (!gs) return [];
    const run = gs.db
      .prepare('SELECT ticket_id FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { ticket_id: number } | undefined;
    if (!run) return [];
    const heads: BaseHead[] = [];
    for (const domain of resolvePhysicalDomains(graphDomainsFor(graphRunId), gitCommonDirFromFs)) {
      const r = await defaultGitRunner(['rev-parse', 'HEAD'], domain.canonicalWorktree);
      if (r.exitCode !== 0) continue;
      const commit = r.stdout.trim();
      if (commit) heads.push({ domainKey: domain.key, commit });
    }
    return heads;
  };

  /**
   * Claim-time physical domains (Slice 5 Task 2/3): the physical domain keys an
   * activation needs, resolved from the node's declared claims in the active
   * revision via the PURE `activationDomainKeys` rule — an agent node's
   * `resources.reads`/`resources.writes` (path-granular, read vs write), a
   * command node's repositories with the access inherited from the PINNED
   * command allowlist (`graph.commands`), never planner prose. Each claimed
   * repo maps through its worktree path to the durable domain key (canonical
   * realpath + git common-dir), deduplicated by key with `write` winning and
   * claimed paths unioned. The claim acquires one `held` lease per domain.
   */
  const graphDomainsForActivation = (input: {
    graphRunId: number;
    revisionId: number;
    nodeId: string;
    nodeKind: 'agent' | 'command' | 'gate';
  }): ActivationDomain[] => {
    const gs = graphCoordinatorStore;
    if (!gs) return [];
    const rev = gs.db
      .prepare('SELECT canonical_graph FROM approach_graph_revisions WHERE id = ?')
      .get(input.revisionId) as { canonical_graph: string } | undefined;
    if (!rev) return [];
    const parsed = parseGraphDocument(rev.canonical_graph);
    if (!parsed.ok) return [];
    const node = parsed.document.nodes.find((n) => n.id === input.nodeId);
    if (!node || node.kind === 'join') return [];
    const worktreeByRepo = new Map(
      graphDomainsFor(input.graphRunId).map((entry) => [entry.repoName, entry.worktreePath]),
    );
    const physicalDomainOf = (repoName: string): string | null => {
      const worktreePath = worktreeByRepo.get(repoName);
      return worktreePath ? domainKeyOf(canonicalPath(worktreePath), gitCommonDirFromFs(worktreePath)) : null;
    };
    const run = gs.db
      .prepare('SELECT approach_id FROM approach_graph_runs WHERE id = ?')
      .get(input.graphRunId) as { approach_id: string } | undefined;
    const graphConfig = (currentManifest() ?? emptyManifest()).approaches?.find(
      (a) => a.id === run?.approach_id,
    )?.graph;
    const commands: AllowlistCommandAccess = new Map(
      Object.entries(graphConfig?.commands ?? {}).map(([id, def]) => [id, def.access]),
    );
    if (node.kind === 'agent') {
      return activationDomainKeys(
        { kind: 'agent', reads: node.resources.reads, writes: node.resources.writes },
        commands,
        physicalDomainOf,
      );
    }
    // A command node's access comes from the pinned allowlist; a gate claims
    // no repository resources.
    if (node.kind !== 'command') return [];
    return activationDomainKeys(
      { kind: 'command', command: node.command, repositories: node.repositories },
      commands,
      physicalDomainOf,
    );
  };

  /** The declared writes of a node run, from the active revision's graph. */
  const declaredGraphWrites = (nodeRunId: number) => {
    const gs = graphCoordinatorStore;
    if (!gs) return [];
    const run = gs.db
      .prepare('SELECT graph_run_id FROM approach_node_runs WHERE id = ?')
      .get(nodeRunId) as { graph_run_id: number } | undefined;
    if (!run) return [];
    return declaredWritesFor(
      gs.db,
      nodeRunId,
      graphDomainsFor(run.graph_run_id).map((entry) => ({
        repoName: entry.repoName,
        // The worktree IS the repository root in V1 (one worktree per
        // repoPath); the manifest's nested paths are not re-rooted here.
        root: '',
        worktreePath: entry.worktreePath,
      })),
      (worktreePath) => domainKeyOf(canonicalPath(worktreePath), gitCommonDirFromFs(worktreePath)),
    );
  };

  /** The completion-pipeline deps for a graph run — ONE construction shared by
   *  the tick's completing drive and the reload reconcile's resume, so the
   *  two never disagree about git, domains or the artifact root. Reads the
   *  coordinator store/transport late, like `driveCompletingNodes` does. */
  const graphCompletionPipelineDeps = (graphRunId: number): CompletionPipelineDeps | undefined => {
    const gs = graphCoordinatorStore;
    const tr = graphTransport;
    if (!gs || !tr) return undefined;
    return {
      db: gs.db,
      transaction: <T>(fn: () => T): T => runImmediateTransaction(gs.db, fn),
      now: () => new Date().toISOString(),
      debug: (message) => logger.debug(message),
      git: defaultGitRunner,
      gitCommonDirOf: gitCommonDirFromFs,
      transport: tr,
      getSession: (nodeRunId) => graphSessionFor(nodeRunId),
      domainsFor: () => graphDomainsFor(graphRunId),
      declaredWritesOf: (nodeRunId) => declaredGraphWrites(nodeRunId),
      artifactRoot: () => graphArtifactRoot(graphRunId),
      // Slice 5 T5: the node's isolated workspace clone per repo (T1). The
      // pipeline captures the actual diff from the clone and lands it into the
      // CANONICAL worktree; a repo with no ledger row falls back to the
      // canonical model.
      workspaceCwdOf: (nodeRunId, repoName) => {
        const gs = graphCoordinatorStore;
        if (!gs) return undefined;
        const row = gs.db
          .prepare(
            `SELECT cwd FROM approach_graph_workspaces
             WHERE node_run_id = ? AND repo_name = ? ORDER BY id LIMIT 1`,
          )
          .get(nodeRunId, repoName) as { cwd: string } | undefined;
        return row?.cwd;
      },
      cleanupNodeWorkspace: (input) =>
        cleanupTerminalNodeWorkspace(
          {
            store: gs,
            transaction: <T>(fn: () => T): T => runImmediateTransaction(gs.db, fn),
            debug: (message) => logger.debug(message),
          },
          input,
        ),
    };
  };

  // Graph node supervision (Slice 3 Task 3 + 7 wiring). Node sessions are
  // REAL vscode terminals, remembered in the identity registry so a reload
  // can re-attach them, registered in the `servers` registry for the reapers,
  // and terminated only through attribution (systemAsyncProcessFacts).
  graphTransport = createSupervisedCliTransport({
    terminalHost: makeGraphTerminalHost(terminalIdentity),
    // Token accounting (Slice 3 T10): every graph launch — planner and node —
    // opens exactly one `process_runs` row, which the interactive usage
    // sampler binds to. Opened with the resolved pid (null when the terminal
    // never started), snapshotted with the identity the launch resolved to.
    // The whole write is swallowed: a locked database must never fail a
    // launch, and a launch that cannot record is simply unattributed.
    openProcessRun: (request, pid) => {
      try {
        const gs = graphCoordinatorStore;
        if (!gs) return undefined;
        const run = gs.db
          .prepare('SELECT ticket_id, stage_attempt FROM approach_graph_runs WHERE id = ?')
          .get(request.graphRunId) as
          | { ticket_id: number; stage_attempt: number }
          | undefined;
        if (!run) return undefined;
        const node = gs.db
          .prepare('SELECT id, profile, provider, model FROM approach_node_runs WHERE id = ?')
          .get(request.nodeRunId) as
          | { id: number; profile: string | null; provider: string | null; model: string | null }
          | undefined;
        const planner = gs.db
          .prepare('SELECT id, profile, provider, model FROM approach_planner_runs WHERE id = ?')
          .get(request.nodeRunId) as
          | { id: number; profile: string | null; provider: string | null; model: string | null }
          | undefined;
        if (node === undefined && planner === undefined) return undefined;
        const identity = node ?? planner!;
        const processRun = openProcessRun(graphCoordinatorStore!, {
          ticketId: run.ticket_id,
          stageKey: 'impl',
          processId: node !== undefined ? 'graph-node' : 'graph-planner',
          attempt: run.stage_attempt,
          agentName: identity.profile,
          provider: identity.provider ?? request.adapter.requiredBinary,
          model: request.interactive.model ?? identity.model,
          pid,
          startedAt: new Date().toISOString(),
        });
        const link = node !== undefined ? 'approach_node_runs' : 'approach_planner_runs';
        gs.db
          .prepare(`UPDATE ${link} SET process_run_id = ? WHERE id = ?`)
          .run(processRun.id, request.nodeRunId);
        return processRun.id;
      } catch (err) {
        logError('karst: opening the graph launch process_runs row failed', err);
        return undefined;
      }
    },
    closeProcessRun: (processRunId, status, at) => {
      try {
        finishProcessRun(graphCoordinatorStore!, processRunId, status, at);
      } catch (err) {
        logError('karst: closing the graph launch process_runs row failed', err);
      }
    },
    recordSession: (row) => {
      graphCoordinatorStore?.db
        .prepare(
          `INSERT INTO servers (ticket_id, repo, pid, status, cwd, started_at, kind)
           VALUES (?, ?, ?, 'running', ?, ?, 'agent')`,
        )
        .run(row.ticketId, row.repo, row.pid, row.cwd, row.startedAt);
    },
    facts: systemAsyncProcessFacts,
    now: () => new Date().toISOString(),
    debug: (message) => logger.debug(message),
    // The launch diagnostic's identity (Slice-6 T3): the transport has no DB
    // handle, so the host resolves graph → project/ticket/attempt for it.
    graphIdentityOf: (graphRunId) => {
      const gs = graphCoordinatorStore;
      if (!gs) return undefined;
      return resolveGraphDiagnosticIdentity(gs.db, graphRunId);
    },
  });

  /* ------------------------------------------------------------------ */
  /* Graph-run launch seam — the missing orchestration. A graph-approach   */
  /* ticket must START the graph (bootstrap planner → plan → compile →     */
  /* confirm → execute nodes), never open a plain implementation session.  */
  /* ------------------------------------------------------------------ */

  /** The effective `graph:` block of an approach (built-in overlay applied). */
  const graphApproachConfigFor = (approachId: string): GraphApproachConfig | undefined =>
    withBuiltInApproaches(currentManifest() ?? emptyManifest())
      .approaches?.find((a) => a.id === approachId)?.graph;

  const graphRunTicketId = (graphRunId: number): number =>
    (graphCoordinatorStore?.db
      .prepare('SELECT ticket_id FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { ticket_id: number } | undefined)?.ticket_id ?? 0;

  const graphRunApproachId = (graphRunId: number): string =>
    (graphCoordinatorStore?.db
      .prepare('SELECT approach_id FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { approach_id: string } | undefined)?.approach_id ?? '';

  /** Immutable identity captured by one planner terminal's close fallback. */
  type GraphLaunchIdentity = {
    graphRunId: number;
    ticketId: number;
    plannerRunId: number;
    generation: string;
    capability: string;
    projectId: number;
    artifactRoot: string;
  };

  /** The driver's host bindings: transport, prompts, adapters, git, and the
   *  manifest/registry seams the pure driver cannot reach. */
  const graphDriverDeps = (): GraphDriverDeps => {
    const gs = graphCoordinatorStore;
    const tr = graphTransport;
    return {
      db: gs!.db,
      transaction: <T>(fn: () => T): T => runImmediateTransaction(gs!.db, fn),
      now: () => new Date().toISOString(),
      debug: (message) => logger.debug(message),
      graphConfigOf: graphApproachConfigFor,
      artifactRootOf: graphArtifactRoot,
      graphEnvOf: (input) => {
        const route = graphRouteFor(input.graphRunId);
        return buildGraphSessionEnv({
          ticketId: graphRunTicketId(input.graphRunId),
          launchId: input.launchId,
          graphRunId: input.graphRunId,
          revisionId: input.revisionId,
          generation: input.generation,
          capability: input.capability,
          artifactRoot: input.artifactRoot,
          callbackUrl: route.url,
          callbackToken: route.token,
          cliPath: join(context.extensionUri.fsPath, 'dist', 'cli', 'main.js'),
          dbPath,
          projectId: currentProject()?.id ?? 0,
        });
      },
      adapterFor: (provider) =>
        instrument(resolveAdapter(provider as AgentProvider), provider as AgentProvider),
      transport: tr!,
      promptBytesOf: (identity) => {
        try {
          const resolved = resolveGraphPrompt(
            approachesDirOrThrow(),
            context.extensionUri.fsPath,
            identity,
          );
          return new Uint8Array(readFileSync(resolved.path));
        } catch {
          return undefined;
        }
      },
      writeSnapshot: (graphRunId, relativePath, bytes) => {
        const root = graphArtifactRoot(graphRunId);
        if (!root) return;
        const target = join(root, relativePath);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
      },
      readBytes: (graphRunId, relativeOrAbsolute) => {
        // Recorded artifact-instance `snapshot_path` values are absolute
        // (content-addressed under the root); relative paths (the plan
        // snapshot, diagnostics) resolve under the run's artifact root.
        const root = graphArtifactRoot(graphRunId);
        const target = isAbsolute(relativeOrAbsolute) ? relativeOrAbsolute : join(root, relativeOrAbsolute);
        try {
          return new Uint8Array(readFileSync(target));
        } catch {
          return undefined;
        }
      },
      ticketContextOf: (ticketId) =>
        renderTicketContext(
          buildTicketContext(localStore, currentManifest(), ticketId, context.globalStorageUri.fsPath),
        ),
      compileContextOf: (graphRunId, document) => graphCompileContext(graphRunId, document),
      manifestResolvedFor: (graphRunId) => graphManifestResolution(graphRunId),
      physicalDomainsOf: (graphRunId, document, nodeId) => {
        const node = document.nodes.find((n) => n.id === nodeId);
        if (!node || node.kind === 'join') return [];
        const config = graphApproachConfigFor(graphRunApproachId(graphRunId));
        const commands: AllowlistCommandAccess = new Map(
          Object.entries(config?.commands ?? {}).map(([id, def]) => [id, def.access] as const),
        );
        const worktreeByRepo = repoWorktreeIndex(graphDomainsFor(graphRunId));
        const physicalDomainOf = (repoName: string): string | null => {
          const worktreePath = worktreeByRepo.get(canonicalRepoId(repoName));
          return worktreePath
            ? domainKeyOf(canonicalPath(worktreePath), gitCommonDirFromFs(worktreePath))
            : null;
        };
        const domains =
          node.kind === 'agent'
            ? activationDomainKeys(
                { kind: 'agent', reads: node.resources.reads, writes: node.resources.writes },
                commands,
                physicalDomainOf,
              )
            : node.kind === 'command'
              ? activationDomainKeys(
                  { kind: 'command', command: node.command, repositories: node.repositories },
                  commands,
                  physicalDomainOf,
                )
              : [];
        return domains.map((d) => d.physicalDomain);
      },
      commandDefOf: (graphRunId, commandId) =>
        graphApproachConfigFor(graphRunApproachId(graphRunId))?.commands[commandId],
      runProcess,
      plannerCwdOf: (graphRunId) => {
        const wt = listWorktreesByTicket(localStore, graphRunTicketId(graphRunId))[0];
        return wt ? { repo: wt.repo, cwd: wt.path } : undefined;
      },
      cwdForRepo: (graphRunId, repo) =>
        // The graph document claims repos by CANONICAL manifest name (a claim
        // canonicalizes at parse), and `worktrees.repo` stores the repo PATH —
        // so the name resolves through its repoPath, then through the canonical
        // index, which is what makes an uppercase manifest key claimable.
        repoWorktreeIndex(graphDomainsFor(graphRunId)).get(canonicalRepoId(repo)),
      gitCommonDirOf: gitCommonDirFromFs,
      workspaceOf: (graphRunId, nodeRunId, repo) =>
        (gs?.db
          .prepare(
            `SELECT cwd FROM approach_graph_workspaces
             WHERE graph_run_id = ? AND node_run_id = ? AND repo_name = ? ORDER BY id LIMIT 1`,
          )
          .get(graphRunId, nodeRunId, repo) as { cwd: string } | undefined)?.cwd,
      createWorkspace: (input) =>
        createNodeWorkspace(
          {
            db: gs!.db,
            transaction: <T>(fn: () => T): T => runImmediateTransaction(gs!.db, fn),
            git: defaultGitRunner,
            maxAggregateWorkspaceBytes:
              graphApproachConfigFor(graphRunApproachId(input.graphRunId))?.limits
                .maxAggregateWorkspaceBytes ?? DEFAULT_GRAPH_LIMITS.maxAggregateWorkspaceBytes,
            globalStorageRoot: context.globalStorageUri.fsPath,
            now: () => new Date().toISOString(),
            facts: systemAsyncProcessFacts,
            debug: (message) => logger.debug(message),
          },
          {
            projectSlug: currentProject()?.slug ?? 'unknown',
            ticketId: graphRunTicketId(input.graphRunId),
            graphRunId: input.graphRunId,
            nodeRunId: input.nodeRunId,
            domains: input.domains,
          },
        ),
      sessionNamingOf: (graphRunId, runId, kind) => {
        // A graph session's terminal reads like any other session terminal:
        // the manifest's terminal-name template + the brand mark. The ticket is
        // resolved through the graph run so a session can be named for the
        // ticket it belongs to, not for an opaque run id ("Karst planner 4").
        let name = `Karst ${kind} ${runId}`;
        try {
          const ticket = getTicket(localStore, graphRunTicketId(graphRunId));
          name = terminalTicketName(ticket, currentManifest()?.terminalNameTemplate);
        } catch {
          // The graph run (or its ticket) vanished after the launch was queued
          // — fall back to the opaque name rather than letting the naming
          // resolver throw out of a terminal creation.
        }
        return terminalNaming({ name, brandIcon });
      },
      cliNodeCompletionCommand: () =>
        `node "${join(context.extensionUri.fsPath, 'dist', 'cli', 'main.js')}" node complete`,
    };
  };

  /** G1b: whether this window's manifest is RESOLVED well enough to JUDGE a
   *  plan. `graphCompileContext` falls back to `emptyManifest()`, whose empty
   *  repository map turns every valid repository claim into
   *  `unknown-repository` and blocks the run permanently — so an unloaded
   *  manifest, or one that declares repositories yet resolves none to a
   *  worktree, must make the compile DECLINE rather than reject. A manifest
   *  that correctly declares zero repositories is resolved. */
  const graphManifestResolution = (
    graphRunId: number,
  ): { resolved: true } | { resolved: false; reason: string } => {
    const manifest = currentManifest();
    if (!manifest) return { resolved: false, reason: 'the manifest is not loaded in this window' };
    const declared = Object.keys(manifest.repositories ?? {});
    if (declared.length === 0) return { resolved: true };
    const worktrees = listWorktreesByTicket(localStore, graphRunTicketId(graphRunId));
    const resolved = resolveRepoWorktrees(manifest.repositories ?? {}, worktrees);
    if (resolved.length === 0) {
      return {
        resolved: false,
        reason: `no declared repository resolves to a worktree of ticket #${graphRunTicketId(graphRunId)}`,
      };
    }
    return { resolved: true };
  };

  /** The compile context for a graph run: profiles/commands/repositories from
   *  the live manifest, project maxima from the graph config, and
   *  `artifactFileExists` over the parsed document's declared staging paths. */
  const graphCompileContext = (graphRunId: number, document?: GraphDocument): CompileContext => {
    const approachId = graphRunApproachId(graphRunId);
    const config = graphApproachConfigFor(approachId);
    const manifest = currentManifest() ?? emptyManifest();
    const worktrees = listWorktreesByTicket(localStore, graphRunTicketId(graphRunId));
    // `worktrees.repo` stores the repo PATH, never the manifest name, so the
    // manifest names resolve through their own repoPath (the same resolution
    // `graphDomainsFor` uses — a monorepo's two entries sharing a repoPath
    // resolve to the one worktree).
    const repositories = new Map<string, ResolvedRepository>();
    // Keyed by the CANONICAL repository id — the one form a claim can carry —
    // so a manifest key of any casing is nameable by a graph document.
    for (const entry of resolveRepoWorktrees(manifest.repositories ?? {}, worktrees)) {
      const id = canonicalRepoId(entry.repoName);
      repositories.set(id, {
        id,
        root: '',
        domain: domainKeyOf(canonicalPath(entry.worktreePath), gitCommonDirFromFs(entry.worktreePath)),
      });
    }
    const profiles = new Map<string, ProfileTier>();
    for (const name of Object.keys(config?.profiles ?? {})) {
      profiles.set(name, name === 'expert' ? 'expert' : 'worker');
    }
    const commands = new Map<string, CommandDefinition>();
    for (const [id, def] of Object.entries(config?.commands ?? {})) {
      commands.set(id, {
        id,
        fingerprint: sha256HexCommand(def),
        access: def.access,
        timeoutSeconds: def.timeoutSeconds,
        permittedRepositories: Object.keys(manifest.repositories ?? {}).map(canonicalRepoId),
      });
    }
    const artifactPaths = new Map(
      (document?.artifacts ?? []).map((a) => [a.id, a.path]),
    );
    const root = graphArtifactRoot(graphRunId);
    const artifactFileExists = (artifactId: string): boolean => {
      const rel = artifactPaths.get(artifactId);
      if (!rel || !root) return false;
      try {
        return existsSync(join(root, rel));
      } catch {
        return false;
      }
    };
    return {
      profiles,
      commands,
      repositories,
      artifactFileExists,
      expertSpend: {
        // The bootstrap planner already ran (spent); the compile reserves the
        // permitted replan budget and charges no bootstrap for the future.
        spentPlannerRuns: 1,
        permittedReplans: config?.limits.maxReplans ?? 0,
        bootstrapUnspent: false,
      },
      projectMaxima: {
        maxNodeRuns: config?.limits.maxNodeRuns ?? DEFAULT_GRAPH_LIMITS.maxNodeRuns,
        maxExpertRuns: config?.limits.maxExpertRuns ?? DEFAULT_GRAPH_LIMITS.maxExpertRuns,
        maxReplans: config?.limits.maxReplans ?? DEFAULT_GRAPH_LIMITS.maxReplans,
      },
    };
  };

  const sha256HexCommand = (def: GraphCommandConfig): string =>
    createHash('sha256')
      .update(
        JSON.stringify({ command: def.command, args: def.args, cwd: def.cwd, access: def.access, timeoutSeconds: def.timeoutSeconds, env: def.env ?? {} }),
      )
      .digest('hex');

  /** Drive the post-tick continuation of a graph run: accept a submitted plan,
   *  execute claimed node runs, and finish completing nodes. Called after every
   *  coordinator tick, a submit, a confirm, and a replan launch. */
  // A run parked `undecidable` (its manifest unresolved) looks identical to a
  // healthy run doing nothing unless it is named. Tracked per run so entry and
  // exit each log exactly once, never once per 15s tick: keyed by the reason
  // string, so a NEW reason (a different unresolved cause) is its own entry.
  const undecidableGraphRuns = new Map<number, string>();

  const driveGraphRunContinuation = async (graphRunId: number): Promise<void> => {
    const gs = graphCoordinatorStore;
    if (!gs) return;
    try {
      const run = gs.db
        .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
        .get(graphRunId) as { status: string } | undefined;
      if (!run) return;
      // Pause gates the CONTINUATION, not the reconcile that precedes it:
      // reconcile only probes liveness and keeps the run's recorded state
      // honest (it spends no tokens), while continuation is what launches
      // planners, nodes and sessions. A paused ticket therefore stays
      // accurately reconciled and starts nothing.
      const pausedOwner = getTicket(localStore, graphRunTicketId(graphRunId));
      if (pausedOwner.pausedAt != null) {
        logger.debug(`[graph] run ${graphRunId}: continuation skipped — ticket is paused`);
        return;
      }
      if (run.status === 'planning') {
        const accepted = acceptSubmittedPlan(graphDriverDeps(), graphRunId);
        if (accepted.kind === 'undecidable') {
          // Nothing destructive: the run stays `planning` and the next tick
          // judges the same submission against a resolved manifest. Raised
          // above debug (a no-op unless debug mode is on) so a parked run is
          // visible, but only on entry into the state (or a reason change) —
          // never on every tick.
          if (undecidableGraphRuns.get(graphRunId) !== accepted.reason) {
            undecidableGraphRuns.set(graphRunId, accepted.reason);
            logger.warn(
              `[graph] run ${graphRunId}: plan left unjudged — ${accepted.reason}`,
            );
          }
          return;
        }
        if (undecidableGraphRuns.delete(graphRunId)) {
          logger.info(`[graph] run ${graphRunId}: plan is judgeable again — resuming`);
        }
        if (accepted.kind === 'repair-requested') {
          // G2: the same planner run gets its next compile attempt, re-prompted
          // with the diagnostics — asynchronously, on this tick's host seam.
          await launchPlannerRepairHost(graphRunId, accepted.plannerRunId, accepted.attempt);
          return;
        }
        if (accepted.kind === 'accepted' || accepted.kind === 'rejected') {
          provider.refresh();
          dashboard.pushState(graphRunTicketId(graphRunId));
          const after = gs.db
            .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
            .get(graphRunId) as { status: string };
          if (after.status === 'awaiting-confirmation') {
            // The human gate: the plan compiled and is awaiting review.
            void vscode.window
              .showInformationMessage(
                `Ticket #${graphRunTicketId(graphRunId)}: the implementation graph plan is ready — review it, then start the run.`,
                'Start graph',
              )
              .then((choice) => {
                if (choice === 'Start graph') void confirmGraphRunHost(graphRunId);
              });
          } else if (after.status === 'running') {
            void runGraphCoordinatorTick(graphRunId);
          }
          settleGraphRun(gs.db, graphRunId);
        }
        return;
      }
      if (run.status === 'draining') {
        // A submitted replan planner lands revision N+1 here.
        const accepted = acceptSubmittedReplan(graphDriverDeps(), graphRunId);
        if (accepted.kind === 'accepted') {
          provider.refresh();
          dashboard.pushState(graphRunTicketId(graphRunId));
          void runGraphCoordinatorTick(graphRunId);
        }
        return;
      }
      if (run.status === 'awaiting-confirmation') return;
      if (run.status === 'blocked') {
        settleGraphRun(gs.db, graphRunId);
        return;
      }
      if (run.status === 'running') {
        await driveReadyNodeRuns(graphDriverDeps(), graphRunId);
        driveCompletingNodes(graphRunId);
      }
    } catch (err) {
      logError(`karst: graph run continuation failed for run ${graphRunId}`, err);
    }
  };

  /** Bootstrap a graph-approach ticket's first impl launch: create the run,
   *  launch the planner session, and retain terminal close as a submission
   *  fallback for older or interrupted planner prompts. */
  const launchGraphRun = async (ticketId: number): Promise<void> => {
    const gs = graphCoordinatorStore;
    if (!gs) return;
    const t = getTicket(localStore, ticketId);
    if (!t.approach || t.stageCurrent !== 'impl') return;
    const attempt =
      (localStore.db
        .prepare("SELECT MAX(attempt) AS attempt FROM stages WHERE ticket_id = ? AND stage_key = 'impl'")
        .get(ticketId) as { attempt: number | null }).attempt ?? 0;
    const result = await bootstrapAndLaunchPlanner(graphDriverDeps(), {
      ticketId,
      stageAttempt: attempt,
      approachId: t.approach,
      projectSlug: currentProject()?.slug ?? 'unknown',
    }).catch((err) => {
      logError(`karst: graph bootstrap for ticket #${ticketId} failed`, err);
      return { kind: 'failed' as const, reason: 'planner session could not start' };
    });
    if (result.kind !== 'launched') {
      const reason = result.reason;
      logger.warn(`karst: graph launch for ticket #${ticketId} failed: ${reason}`);
      void vscode.window.showErrorMessage(
        `Ticket #${ticketId}: the graph engineering run could not start — ${reason}`,
      );
      return;
    }
    const identity: GraphLaunchIdentity = {
      graphRunId: result.graphRunId,
      ticketId,
      plannerRunId: result.plannerRunId,
      generation: result.generation,
      capability: result.capability,
      projectId: currentProject()?.id ?? 0,
      artifactRoot: graphArtifactRoot(result.graphRunId),
    };
    attachPlannerCloseFallback(result.session, identity);
    result.session.terminal?.show();
    provider.refresh();
    dashboard.pushState(ticketId);
    logger.info(`karst: graph run ${result.graphRunId} launched for ticket #${ticketId}`);
  };

  /** The human confirm gate: awaiting-confirmation → running, then a sweep
   *  tick claims the entry tokens and the tick's continuation executes them. */
  const confirmGraphRunHost = async (graphRunId: number): Promise<void> => {
    const gs = graphCoordinatorStore;
    if (!gs) return;
    if (confirmGraphRun(graphDriverDeps(), graphRunId)) {
      provider.refresh();
      dashboard.pushState(graphRunTicketId(graphRunId));
      void runGraphCoordinatorTick(graphRunId);
    }
  };
  confirmGraphRunForTicket = (ticketId, graphRunId) => {
    const gs = graphCoordinatorStore;
    if (!gs) return;
    const run = activeGraphRunFor(gs.db, ticketId);
    if (run?.graphRunId === graphRunId && run.status === 'awaiting-confirmation') {
      void confirmGraphRunHost(graphRunId);
    }
  };

  /** Terminal-close fallback for a planner that did not complete the explicit
   *  CLI submission. The immutable launch identity prevents a late close from
   *  submitting on behalf of a newer planner. */
  const attachPlannerCloseFallback = (
    session: { terminal?: { onDidClose(handler: (exitCode?: number) => void): void } },
    identity: GraphLaunchIdentity,
  ): void => {
    session.terminal?.onDidClose(() => {
      void (async () => {
        const env: Record<string, string | undefined> = {
          KARST_GRAPH_PROJECT: String(identity.projectId),
          KARST_TICKET_ID: String(identity.ticketId),
          KARST_GRAPH_RUN_ID: String(identity.graphRunId),
          KARST_LAUNCH_ID: String(identity.plannerRunId),
          KARST_GRAPH_GENERATION: identity.generation,
          KARST_GRAPH_CAPABILITY: identity.capability,
          KARST_GRAPH_ARTIFACT_ROOT: identity.artifactRoot,
        };
        try {
          const planner = graphCoordinatorStore?.db
            .prepare('SELECT status FROM approach_planner_runs WHERE id = ?')
            .get(identity.plannerRunId) as { status: string } | undefined;
          if (planner?.status !== 'submitted') {
            const out = runGraphCommand(graphCoordinatorStore!, env, ['graph', 'submit']);
            const parsed = JSON.parse(out) as { ok: boolean; rejected?: string; reason?: string };
            if (!parsed.ok) {
              logger.warn(
                `karst: graph submit rejected (${parsed.rejected ?? 'unknown'}) — ${parsed.reason ?? ''}`,
              );
            }
          }
        } catch (err) {
          logError('karst: graph submit on planner close failed', err);
        }
        await driveGraphRunContinuation(identity.graphRunId);
      })();
    });
  };

  /** G3: the compile diagnostics section of a planner prompt. `blockInvalidPlan`
   *  (and the repair path) write `diagnostics/planner-<id>.json`; this is the
   *  one reader. Prompt composition stays in the host — the driver only
   *  exposes the raw strings. `plannerRunId` addresses a specific run's
   *  diagnostics; without one the NEWEST planner run's file for the graph run
   *  is used (the replan case, where the failed planner is a prior run). */
  const graphDiagnosticsSection = (
    graphRunId: number,
    plannerRunId?: number,
  ): string | undefined => {
    const gs = graphCoordinatorStore;
    if (!gs) return undefined;
    const deps = graphDriverDeps();
    const candidates =
      plannerRunId !== undefined
        ? [plannerRunId]
        : (
            gs.db
              .prepare(
                'SELECT id FROM approach_planner_runs WHERE graph_run_id = ? ORDER BY id DESC',
              )
              .all(graphRunId) as { id: number }[]
          ).map((r) => r.id);
    for (const id of candidates) {
      const diagnostics = readPlannerDiagnostics(deps, graphRunId, id);
      if (diagnostics.length === 0) continue;
      return [
        'The compiler REJECTED the previous `graph.json` with these diagnostics.',
        'Each line is `code: where: message` from the karst graph compiler — fix every one of them; do not resubmit the same document.',
        '```',
        ...diagnostics.slice(0, 50).map((d) => String(d).slice(0, 500)),
        '```',
      ].join('\n');
    }
    return undefined;
  };

  /** Refuse to launch a graph planner session with no resolved worktree —
   *  cwd/repo `''` is not a recoverable state, it is an agent spawned nowhere.
   *  Shared by all three planner-launch host bindings below: the durable
   *  graph-run/planner-run state is left exactly as it was (still `blocked`/
   *  `planning`/`draining`), so the next reconcile or sweep tick retries the
   *  SAME launch once the worktree exists — no separate "worktree missing"
   *  state is invented. */
  const resolveGraphLaunchWorktree = (
    graphRunId: number,
    ticketId: number,
  ): { path: string; repo: string } | undefined => {
    const wt = listWorktreesByTicket(localStore, ticketId)[0];
    if (!wt) {
      logger.warn(
        `karst: graph run ${graphRunId} (ticket #${ticketId}): refusing to launch a planner — no worktree resolved yet; will retry`,
      );
      return undefined;
    }
    return { path: wt.path, repo: wt.repo };
  };

  /** G2's host half: re-prompt the SAME bootstrap planner run for its next
   *  compile attempt, carrying the compiler's diagnostics. No new planner run
   *  is allocated (so no planner-run or expert-run budget is charged); the
   *  driver already recorded the attempt and moved the planner run to the
   *  `blocked` status a re-prompt claims from. */
  const launchPlannerRepairHost = async (
    graphRunId: number,
    plannerRunId: number,
    attempt: number,
  ): Promise<void> => {
    const gs = graphCoordinatorStore;
    if (!gs) return;
    const base = graphDriverDeps().promptBytesOf('karst-graph-planner');
    const diagnostics = graphDiagnosticsSection(graphRunId, plannerRunId);
    const prompt = [
      base === undefined ? '# Graph Planner' : new TextDecoder().decode(base),
      renderTicketContext(
        buildTicketContext(
          localStore,
          currentManifest(),
          graphRunTicketId(graphRunId),
          context.globalStorageUri.fsPath,
        ),
      ),
      diagnostics ?? 'The compiler rejected the previous `graph.json`.',
      `This is compile attempt ${attempt + 1}: write a corrected \`graph.json\` and submit it again.`,
      PLANNER_SUBMIT_INSTRUCTION,
    ].join('\n\n');
    const worktree = resolveGraphLaunchWorktree(graphRunId, graphRunTicketId(graphRunId));
    if (!worktree) return;
    const result = await launchReplanPlanner(graphDriverDeps(), {
      graphRunId,
      plannerRunId,
      generation: '',
      capability: '',
      prompt,
      cwd: worktree.path,
      repo: worktree.repo,
    }).catch((err) => {
      logError(`karst: planner compile repair failed for run ${graphRunId}`, err);
      return { kind: 'failed' as const, reason: 'planner session could not start' };
    });
    if (result.kind === 'launched') {
      const identity: GraphLaunchIdentity = {
        graphRunId,
        ticketId: graphRunTicketId(graphRunId),
        plannerRunId,
        generation: result.generation,
        capability: result.capability,
        projectId: currentProject()?.id ?? 0,
        artifactRoot: graphArtifactRoot(graphRunId),
      };
      attachPlannerCloseFallback(result.session, identity);
      result.session.terminal?.show();
      provider.refresh();
      dashboard.pushState(graphRunTicketId(graphRunId));
      logger.info(
        `karst: graph run ${graphRunId} planner re-prompted with the compile diagnostics (attempt ${attempt + 1})`,
      );
    } else if (result.kind === 'failed') {
      logError(
        `karst: planner compile repair failed for run ${graphRunId}`,
        new Error(result.reason),
      );
    }
  };

  /** Launch the elected replan planner (Slice-4 T5): the election produced a
   *  launch request with the replan reasons as a file artifact; compose the
   *  prompt and start the session through the driver. */
  const launchReplanPlannerHost = async (launch: ReplanLaunchRequest): Promise<void> => {
    const gs = graphCoordinatorStore;
    if (!gs) return;
    const base = graphDriverDeps().promptBytesOf('karst-graph-planner');
    // G3: a replan elected from `graph-plan-invalid` used to re-run a planner
    // that had never been told what was wrong — the diagnostics were written
    // where nothing read them. They travel with the replan prompt now.
    const diagnostics = graphDiagnosticsSection(launch.graphRunId);
    const prompt = [
      base === undefined ? '# Graph Replanner' : new TextDecoder().decode(base),
      launch.ticketContext,
      // The skill calls the legal-values block authoritative, so a replanner
      // must get it too — this is the path where a plan is rewritten after a
      // failure, exactly where guessing an id costs another cycle.
      plannerVocabularyFor(() => graphCompileContext(launch.graphRunId), (m) => logger.debug(m)),
      `Replan the graph (superseding revision ${launch.priorRevisionNumber}). The replan reasons and prior plan evidence are under the artifact root: ${launch.reasonsSnapshotPath}.`,
      ...(diagnostics ? [diagnostics] : []),
      PLANNER_SUBMIT_INSTRUCTION,
    ]
      .filter((part) => part !== '')
      .join('\n\n');
    const worktree = resolveGraphLaunchWorktree(launch.graphRunId, graphRunTicketId(launch.graphRunId));
    if (!worktree) return;
    const result = await launchReplanPlanner(graphDriverDeps(), {
      graphRunId: launch.graphRunId,
      plannerRunId: launch.plannerRunId,
      generation: '',
      capability: '',
      prompt,
      cwd: worktree.path,
      repo: worktree.repo,
    }).catch((err) => {
      logError(`karst: replan planner launch failed for run ${launch.graphRunId}`, err);
      return { kind: 'failed' as const, reason: 'planner session could not start' };
    });
    if (result.kind === 'launched') {
      const identity: GraphLaunchIdentity = {
        graphRunId: launch.graphRunId,
        ticketId: graphRunTicketId(launch.graphRunId),
        plannerRunId: launch.plannerRunId,
        generation: result.generation,
        capability: result.capability,
        projectId: currentProject()?.id ?? 0,
        artifactRoot: graphArtifactRoot(launch.graphRunId),
      };
      attachPlannerCloseFallback(result.session, identity);
      result.session.terminal?.show();
      provider.refresh();
      dashboard.pushState(graphRunTicketId(launch.graphRunId));
    } else if (result.kind === 'failed') {
      logError(`karst: replan planner launch failed for run ${launch.graphRunId}`, new Error(result.reason));
      void vscode.window.showErrorMessage(
        `Ticket #${graphRunTicketId(launch.graphRunId)}: the replan planner could not start — ${result.reason}`,
      );
    }
  };

  /** Launch a fresh bootstrap planner after the `planner-relaunch` recovery:
   *  the recovery already re-opened the run to `planning` and allocated the
   *  new bootstrap planner run; this host binding composes the bootstrap prompt
   *  and starts the session through the same driver seam as a replan. */
  const launchBootstrapRelaunchHost = async (launch: BootstrapRelaunchRequest): Promise<void> => {
    const gs = graphCoordinatorStore;
    if (!gs) return;
    const base = graphDriverDeps().promptBytesOf('karst-graph-planner');
    const prompt = [
      base === undefined ? '# Graph Planner' : new TextDecoder().decode(base),
      launch.ticketContext,
      plannerVocabularyFor(() => graphCompileContext(launch.graphRunId), (m) => logger.debug(m)),
      PLANNER_SUBMIT_INSTRUCTION,
    ]
      .filter((part) => part !== '')
      .join('\n\n');
    const worktree = resolveGraphLaunchWorktree(launch.graphRunId, graphRunTicketId(launch.graphRunId));
    if (!worktree) return;
    const result = await launchReplanPlanner(graphDriverDeps(), {
      graphRunId: launch.graphRunId,
      plannerRunId: launch.plannerRunId,
      generation: '',
      capability: '',
      prompt,
      cwd: worktree.path,
      repo: worktree.repo,
    }).catch((err) => {
      logError(`karst: bootstrap relaunch failed for run ${launch.graphRunId}`, err);
      return { kind: 'failed' as const, reason: 'planner session could not start' };
    });
    if (result.kind === 'launched') {
      const identity: GraphLaunchIdentity = {
        graphRunId: launch.graphRunId,
        ticketId: graphRunTicketId(launch.graphRunId),
        plannerRunId: launch.plannerRunId,
        generation: result.generation,
        capability: result.capability,
        projectId: currentProject()?.id ?? 0,
        artifactRoot: graphArtifactRoot(launch.graphRunId),
      };
      attachPlannerCloseFallback(result.session, identity);
      result.session.terminal?.show();
      provider.refresh();
      dashboard.pushState(graphRunTicketId(launch.graphRunId));
    } else if (result.kind === 'failed') {
      logError(`karst: bootstrap relaunch failed for run ${launch.graphRunId}`, new Error(result.reason));
      void vscode.window.showErrorMessage(
        `Ticket #${graphRunTicketId(launch.graphRunId)}: the bootstrap planner could not start — ${result.reason}`,
      );
    }
  };

  // Reload/crash reconcile (Slice 4 Task 3): one pass over every graph run
  // applying the crash matrix, next to the coordinator sweep. Process facts
  // are the real OS probes and `resumePipeline` is the completion pipeline —
  // reconcile itself stays host-agnostic. Safe under concurrency: every
  // mutation is a durable conditional claim, so another window's live process
  // is left alone by attribution, never by this window's bookkeeping.
  //
  // The reconcile deps are built ONCE here and shared by every call of
  // `reconcileGraphRuns` — the immediate `runGraphReconcileSweep()` at
  // activation and its own `GRAPH_RECONCILE_INTERVAL_MS` timer — one
  // construction, so a field added to one call site can never drift from
  // another.
  const graphReconcileDeps = (): ReconcileGraphRunDeps => {
    const gs = graphCoordinatorStore!;
    return {
      db: gs.db,
      transaction: <T>(fn: () => T): T => runImmediateTransaction(gs.db, fn),
      now: () => new Date().toISOString(),
      debug: (message) => logger.debug(message),
      facts: systemAsyncProcessFacts,
      sessionFor: (nodeRunId) => graphSessionFor(nodeRunId),
      resumePipeline: (nodeRunId) => {
        const node = gs.db
          .prepare('SELECT graph_run_id FROM approach_node_runs WHERE id = ?')
          .get(nodeRunId) as { graph_run_id: number } | undefined;
        if (!node) return;
        const deps = graphCompletionPipelineDeps(node.graph_run_id);
        if (!deps) return;
        void runCompletionPipeline(deps, { graphRunId: node.graph_run_id, nodeRunId });
      },
      relaunchPlanner: (graphRunId) => void relaunchBootstrapPlannerHost(graphRunId),
      relaunchReplanPlanner: (graphRunId) => void relaunchReplanPlannerHost(graphRunId),
      // G2/1: the sweep-driven half of the fire-once compile re-prompt — a
      // planner run stuck `blocked` because the accept-path launch never
      // happened or died in flight is re-prompted through the SAME host seam
      // the live accept path uses. The single-flight claim is the
      // `blocked → launching` CAS already inside `launchReplanPlanner`
      // (`claimPlannerLaunch`), so a raced double-fire is safe by construction.
      relaunchCompileRepair: (graphRunId, plannerRunId, attempt) =>
        void launchPlannerRepairHost(graphRunId, plannerRunId, attempt),
    };
  };

  /** Relaunch a DRAINING run's replan planner whose session reconcile proved
   *  demonstrably gone. `draining` is the one run status nothing else ever
   *  leaves — only the replan planner's accepted submission does — so a lost
   *  replan planner strands the ticket exactly as a lost bootstrap planner
   *  strands a planning run. `beginReplanPlannerRun` is the SAME allocator the
   *  replan election uses (it re-checks `draining` + quiescence itself, and
   *  the reconcile pass has already marked the dead planner `stale`, so the
   *  one-planner rule is satisfied), and the launch goes through the same host
   *  seam. Never throws — reconcile fires it and forgets. */
  const relaunchReplanPlannerHost = async (graphRunId: number): Promise<void> => {
    const gs = graphCoordinatorStore;
    if (!gs) return;
    try {
      const rd = graphRecoveryDeps(graphRunId);
      if (!rd.readPrompt || !rd.writeSnapshot || !rd.plannerPromptPath || rd.ticketContext === undefined) {
        return; // the planner launch seams are unwired — nothing to launch
      }
      const begun = beginReplanPlannerRun(
        {
          db: gs.db,
          transaction: <T>(fn: () => T): T => runImmediateTransaction(gs.db, fn),
          now: () => new Date().toISOString(),
          debug: (message) => logger.debug(message),
          writeSnapshot: rd.writeSnapshot,
          readPrompt: rd.readPrompt,
          promptPath: rd.plannerPromptPath,
          ticketContext: rd.ticketContext,
        },
        { graphRunId },
      );
      if (!begun.ok) {
        logger.debug(`[graph] replan planner relaunch deferred for run ${graphRunId}: ${begun.reason}`);
        return;
      }
      await launchReplanPlannerHost(begun.launch);
    } catch (err) {
      logError(`karst: graph replan planner relaunch failed for run ${graphRunId}`, err);
    }
  };

  /** Relaunch a planning run's bootstrap planner whose session reconcile proved
   *  demonstrably gone: allocate a NEW bootstrap planner run on the SAME
   *  `planning` run and start its session, retaining its immutable launch
   *  identity for the terminal-close fallback. Never
   *  throws — both reconcile callers fire it and forget. */
  const relaunchBootstrapPlannerHost = async (graphRunId: number): Promise<void> => {
    const gs = graphCoordinatorStore;
    if (!gs) return;
    const row = gs.db
      .prepare('SELECT ticket_id FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { ticket_id: number } | undefined;
    if (!row) return;
    const result = await relaunchBootstrapPlanner(graphDriverDeps(), { graphRunId }).catch((err) => {
      logError(`karst: graph planner relaunch failed for run ${graphRunId}`, err);
      return { kind: 'failed' as const, reason: 'planner session could not start' };
    });
    if (result.kind === 'launched') {
      const identity: GraphLaunchIdentity = {
        graphRunId,
        ticketId: row.ticket_id,
        plannerRunId: result.plannerRunId,
        generation: result.generation,
        capability: result.capability,
        projectId: currentProject()?.id ?? 0,
        artifactRoot: graphArtifactRoot(graphRunId),
      };
      attachPlannerCloseFallback(result.session, identity);
      result.session.terminal?.show();
      provider.refresh();
      dashboard.pushState(row.ticket_id);
      logger.info(`karst: graph run ${graphRunId} planner relaunched for ticket #${row.ticket_id}`);
    } else if (result.kind === 'no-op') {
      logger.warn(`karst: graph planner relaunch for run ${graphRunId} was a no-op (run no longer planning)`);
    } else {
      logError(`karst: graph planner relaunch for run ${graphRunId} failed`, new Error(result.reason));
    }
  };

  // A run belongs to a project, so a window with none resolved correctly
  // skips the graph sweep and reconcile entirely (that skip is the very fix
  // f3b648e made — driving another project's run is the bug). The SILENCE
  // was not correct: this is the one funnel both the coordinator tick and
  // the reconcile pass resolve their project through, so the transition into
  // and out of "no project" logs exactly once each way, never once per tick.
  let graphSweepIdleForProject = false;
  const graphSweepProject = (): ReturnType<typeof currentProject> => {
    const project = currentProject();
    if (!project) {
      if (!graphSweepIdleForProject) {
        graphSweepIdleForProject = true;
        logger.info('[graph] sweep idle — no project resolved for this window');
      }
      return undefined;
    }
    if (graphSweepIdleForProject) {
      graphSweepIdleForProject = false;
      logger.info(`[graph] sweep resumed — project ${project.id} resolved`);
    }
    return project;
  };

  // G1b: scoped to this window's project and to non-terminal statuses
  // (`reconcilableGraphRunIds`) — the registry is shared by every IDE window
  // (`docs/arch/store-and-schema.md`), so an unscoped listing here reconciles
  // and drives continuation for other projects' runs too, including ones
  // already `closed`. `draining` stays in the eligible set: it is the one
  // status nothing else ever leaves (commit 2f7f741).
  const reconcileGraphRuns = async (): Promise<void> => {
    const gs = graphCoordinatorStore;
    const project = graphSweepProject();
    if (!gs || !project) return;
    try {
      const runIds = reconcilableGraphRunIds(gs.db, { projectId: project.id });
      for (const graphRunId of runIds) {
        const result = await reconcileGraphRun(graphReconcileDeps(), { graphRunId });
        if (
          result.transitions > 0 ||
          result.resumed.length > 0 ||
          result.reverted.length > 0 ||
          result.cancelledTokens > 0
        ) {
          logger.info(
            `[graph] reconcile: run ${graphRunId} → ${result.status}` +
              ` (${result.transitions} transition${result.transitions === 1 ? '' : 's'}, ` +
              `${result.cancelledTokens} token${result.cancelledTokens === 1 ? '' : 's'} cancelled, ` +
              `resumed ${result.resumed.length}, reverted ${result.reverted.length})`,
          );
        }
        // A run this pass blocked — a dead node OR a dead bootstrap planner —
        // gets its `approach-graph-failed` stage block written now, so the
        // dashboard offers the typed graph-recovery Resume (the reconcile
        // wrapper is the one place a reconcile-created block is observed).
        if (result.status === 'blocked') {
          settleGraphRun(gs.db, graphRunId);
        }
        await driveGraphRunContinuation(graphRunId);
      }
    } catch (err) {
      logError('karst: graph reconcile sweep failed', err);
    }
  };
  // G4/INFO-6: the graph coordinator sweep is its OWN tick, independent of
  // `runPrSync`'s GitHub calls — a throw from `syncPrStatuses` (offline, no
  // auth, rate limit) must never starve the graph of the one path that
  // brings a stalled run back (a wake-up hit a dead port, a session died
  // between activations). Its own re-entrancy guard drops a tick that lands
  // while a slow sweep is still going; its try/catch means one failure only
  // delays the next tick, never the graph's own liveness promise.
  //
  // The cheap half (re-attach + claim/token bookkeeping, no OS process
  // probes) runs every GRAPH_SWEEP_INTERVAL_MS. The reconcile pass — async OS
  // process-liveness probes per run — is materially more expensive and rides
  // its own, slower GRAPH_RECONCILE_INTERVAL_MS (60s, the rate both shared
  // before this split), plus once at activation (below). A completion
  // committed to the database is still always eventually scheduled: the
  // reconcile pass is what recovers a DEAD session, and the coordinator tick
  // is what drives a run whose session is alive and already progressing —
  // neither guarantee depends on the other's cadence.
  let graphSweepRunning = false;
  const runGraphSweep = async (): Promise<void> => {
    const gs = graphCoordinatorStore;
    if (!gs) return;
    if (graphSweepRunning) return;
    graphSweepRunning = true;
    try {
      // Re-attach sessions a terminal revival delivered after the last sweep
      // (the "coordinator re-attaches it on the next sweep" promise), then
      // tick the runs whose continuation the coordinator owns.
      await reattachGraphSessions();
      const project = graphSweepProject();
      if (project) {
        let graphRuns: number[] = [];
        try {
          graphRuns = activeGraphRunIds(gs.db, { projectId: project.id });
        } catch (e) {
          logError('karst: graph run listing failed', e);
        }
        for (const graphRunId of graphRuns) {
          void runGraphCoordinatorTick(graphRunId);
        }
      }
    } catch (err) {
      logError('karst: graph coordinator sweep failed', err);
    } finally {
      graphSweepRunning = false;
    }
  };

  let graphReconcileRunning = false;
  const runGraphReconcileSweep = async (): Promise<void> => {
    const gs = graphCoordinatorStore;
    if (!gs) return;
    if (graphReconcileRunning) return;
    graphReconcileRunning = true;
    try {
      // A run whose session DIED — not a revived terminal, which the
      // coordinator sweep's re-attach handles — is recovered by the
      // reconcile crash matrix, so a death mid-run is brought back here, not
      // only at the next activation.
      await reconcileGraphRuns();
    } catch (err) {
      logError('karst: graph reconcile sweep failed', err);
    } finally {
      graphReconcileRunning = false;
    }
  };

  void runGraphSweep();
  void runGraphReconcileSweep();
  const graphSweepTimer = setInterval(() => void runGraphSweep(), GRAPH_SWEEP_INTERVAL_MS);
  const graphReconcileTimer = setInterval(() => void runGraphReconcileSweep(), GRAPH_RECONCILE_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(graphSweepTimer) });
  context.subscriptions.push({ dispose: () => clearInterval(graphReconcileTimer) });

  // The Inside Stop binding (Slice 3 Task 11): terminates every live session
  // of the ticket's active graph through the supervised transport, then moves
  // the run `running → draining` — the coordinator's own drain. NEVER to
  // `blocked`: a stop is a deliberate halt, not a fault the Resume would
  // retry.
  stopGraphRun = async (ticketId: number, graphRunId: number): Promise<void> => {
    const gs = graphCoordinatorStore;
    const tr = graphTransport;
    if (!gs || !tr) return;
    const run = stoppableGraphRunFor(gs.db, ticketId, graphRunId);
    if (!run) return;
    try {
      const result = await stopActiveGraph(
        {
          db: gs.db,
          transaction: <T>(fn: () => T): T => runImmediateTransaction(gs.db, fn),
          transport: tr,
          sessionsFor: (graphRunId) =>
            tr.sessions().filter((s) => s.graphRunId === graphRunId),
          facts: systemAsyncProcessFacts,
          debug: (message) => logger.debug(message),
        },
        { ticketId, graphRunId: run.graphRunId },
      );
      logger.info(
        `[graph] stop: run ${result.graphRunId} outcome=${result.outcome} drained=${result.drained} terminated=${result.terminated} refused=${result.refused}`,
      );
      // The message states what happened. A run whose live process this window
      // cannot reach was NOT stopped, and saying so is the whole point of the
      // outcome: draining it would strand it behind a false success.
      void vscode.window.showInformationMessage(
        result.outcome === 'live-process-unreachable'
          ? `Ticket #${ticketId}: the implementation graph was NOT stopped — a node process is still running but is not attached to this window. Stop it from the window that launched it, or reload and try again.`
          : result.drained || result.terminated > 0
            ? `Ticket #${ticketId}: implementation graph stopped — ${result.terminated} session${result.terminated === 1 ? '' : 's'} terminated${result.refused > 0 ? `, ${result.refused} refused` : ''}.`
            : `Ticket #${ticketId}: no graph sessions were stopped.`,
      );
      provider.refresh();
      dashboard.pushState(ticketId);
    } catch (err) {
      logError(`karst: graph stop failed for ticket ${ticketId}`, err);
    }
  };

  // Write the current endpoint URL so revived Codex sessions discover the live
  // port instead of POSTing to a stale one left over from before the reload.
  writeCurrentEndpoint(settingsDir, endpoint.url);

  // Activation sweep: resume any ticket already parked at a gate. Recovers a ticket
  // stranded when the trigger that would normally kick the driver never arrived
  // (dead/stale hook port, IDE closed mid-gate) — every window reload becomes a
  // self-heal, without inferring any verdict (§5.4-safe).
  //
  // Scoped to this window's project: driving a ticket opens terminals and runs
  // gates against *this* window's manifest, so sweeping another project's
  // tickets would resolve their services against the wrong repo paths.
  const startupProject = currentProject();
  if (startupProject) {
    // The project's own tickets — the stranded-fix sweep above is GLOBAL (the
    // registry is shared by every window), so the drive set must be narrowed to
    // THIS window's project before any terminal is opened or manifest resolved:
    // driving another project's ticket would resolve its services against the
    // wrong repo paths, exactly what the ticketsToSweep scoping prevents.
    const projectTicketIds = new Set(
      listTickets(localStore, { projectId: startupProject.id }).map((t) => t.id),
    );
    for (const id of ticketsToSweep(
      listTickets(localStore, { projectId: startupProject.id }),
    )) {
      maybeDrive(id, 'activation-sweep');
    }
    // Stranded fix tickets the round sweep above interrupted (a crash, not a
    // wait) are driven straight through the driver, which reopens the round
    // within budget and resumes the fix. `driver.begin` single-flights any
    // overlap, and a stranded fix ticket is never selected by `ticketsToSweep`
    // anyway.
    for (const id of strandedFixResumes) {
      if (!projectTicketIds.has(id)) continue;
      logger.info(`stage driver: activation-sweep → reopen interrupted fix round for ticket ${id}`);
      void driveTicket(id);
    }
  }

  // ONE host seam for running the ship saga, shared by the dashboard's
  // confirm-ship click and the stranded-ship recovery below: the PRs are open
  // and the branch pushed — the irreversible part succeeded, and ship's own
  // settle may already have walked the ticket through to `done` when there was
  // nothing to merge; that is the one case the status push fires from here.
  // Everything else waits for the merge sweep. The fresh snapshot that follows
  // carries the real commit/push/pr/merge ledger, so the transient 'ship'
  // overlay is superseded and retired rather than left past its snapshot.
  // `warn` says whether a failed provider status push raises a toast: the
  // click asks for one (it owns the user's attention), the activation sweep
  // does not (its failures are logged like every other sweep's).
  const runShipSaga = async (ticketId: number, warn = false): Promise<void> => {
    await runShipTicket(
      localStore,
      {
        ticketId,
        manifest: currentManifest(),
        // Task 3: the configured pr-description process, resolved once. Its
        // adapter AND identity snapshot drive the description step; NULL
        // (enabled: false) skips the AI step for the deterministic fallback.
        prDescriptionProcess: prDescriptionProcess(ticketId),
      },
      undefined,
      undefined,
      undefined,
      (step) => {
        const event = shipStepEvent(ticketId, step);
        if (event) dashboard.postInsideProgress(ticketId, event);
        // Each step event marks a store write the ledger reads (a step row
        // opened or closed). Push the snapshot now so a subprocess's checkmark
        // lands the instant that subprocess finishes — not once the whole saga
        // ends. The live tick keeps it moving while a step reads `run`.
        dashboard.pushState(ticketId);
      },
      (event) => dashboard.postInsideProgress(ticketId, event),
    );
    if (getTicket(localStore, ticketId).stageCurrent === 'done') {
      await pushDoneStatus(ticketId, warn);
    }
    provider.refresh();
    dashboard.pushState(ticketId);
    showStatusFor(ticketId);
    dashboard.postInsideProgress(ticketId, shipClearedEvent(ticketId));
  };

  // Stranded-ship recovery. A ship killed by a dead host leaves the ticket at
  // `ship` reading `running` with a `running` ship_runs row and no way out:
  // `settleShipGates` requires the awaiting-merge block the interrupted run
  // never wrote, the drive sweep above covers only uat/review, and a `running`
  // row offers no button in the dashboard — a freeze that survives every
  // reload. The saga is built to be re-run (`reconcilePriorShipOperations`
  // adopts or refutes the interrupted run's effects; commit/push skip what
  // already landed), so RESUME it here: the describe step re-runs, the PR
  // opens, and ship's tail parks awaiting-merge or walks the ticket to done.
  // `listStrandedShipTickets` proves death from stored state — a run still
  // carrying a LIVE pid is a ship another window is executing and is left
  // strictly alone — so this never double-runs a live saga.
  if (startupProject) {
    for (const stranded of listStrandedShipTickets(
      localStore,
      pidAlive,
      { projectId: startupProject.id },
    )) {
      if (!guardCapability('ship')) continue;
      // A paused ticket starts nothing on its own, and a ship saga is work:
      // it describes with a model, pushes, and opens PRs. The stranded run
      // stays stranded until the user unpauses — the same recovery then runs
      // at the next activation.
      if (getTicket(localStore, stranded.ticketId).pausedAt != null) {
        logger.info(
          `karst: stranded ship for ticket ${stranded.ticketId} left alone — the ticket is paused`,
        );
        continue;
      }
      logger.info(describeStrandedShip(stranded));
      void runShipSaga(stranded.ticketId).catch((e) => {
        logError('karst: stranded ship resume failed', e);
        provider.refresh();
        dashboard.pushState(stranded.ticketId);
      });
    }
  }

  // PR status sync: `ship` writes every PR as 'open' and nothing ever revised it,
  // so a merged/closed/reopened PR read 'open' forever. Re-probe upstream via gh
  // on a timer AND once on activation (which corrects PRs already stuck 'open').
  //
  // Scoped to this window's project (projects invariant). Async spawn only — gh
  // runs off the event loop, and a re-entrancy guard drops a tick that lands
  // while a slow sweep is still going, so a dead remote can never pile up sweeps.
  //
  // `force` is the panel's refresh icon: same sweep, but the mergeability age
  // floor is dropped (the user is asking BECAUSE the stored answer looks stale)
  // and the dashboard is pushed even when nothing moved, so the icon's spinner
  // always has an end. A forced request that lands mid-sweep is not dropped like
  // a timer tick — it re-runs once the in-flight one finishes, because the answer
  // that sweep is producing may predate whatever the user just pushed.
  let prSyncRunning = false;
  let forceQueued = false;
  const runPrSync = async (force = false): Promise<void> => {
    const project = currentProject();
    if (!project) return;
    if (prSyncRunning) {
      forceQueued ||= force;
      return;
    }
    prSyncRunning = true;
    try {
      const changed = await syncPrStatuses(localStore, defaultGhRunnerAsync, {
        projectId: project.id,
      });
      // Mergeability rides the same tick: ship's verdict describes the base as
      // it stood that minute, and the base keeps moving under an open PR. Same
      // baseline the ship itself measured against, so the two can't disagree
      // about which branch a repo merges into. The age floor keeps a multi-repo
      // project from fetching once per repo per minute forever.
      let mergeChanged = 0;
      try {
        // No `baseRefFor` override: `syncMergeChecks` already defaults to
        // `pr.baseRef` (which is `worktrees.base_ref` — see `listSyncablePrs`),
        // the same per-ticket, per-repository base the resolver in
        // `workflow/baseRef.ts` produces. Re-deriving from the manifest here
        // would undo a live `changeBaseRef` override and probe the wrong base
        // (see docs/arch/worktrees-and-servers.md, "The base branch is per
        // TICKET and per REPOSITORY").
        mergeChanged = await syncMergeChecks(localStore, defaultGitRunner, {
          scope: { projectId: project.id },
          minAgeMs: force ? 0 : MERGE_SYNC_MIN_AGE_MS,
        });
      } catch (e) {
        // The PR statuses above already landed; a failed merge sweep must not
        // discard them or stop the next tick.
        logError('karst: merge check sync failed', e);
      }
      // A PR the sweep just found merged may have been the last one a ticket was
      // waiting on — including one a teammate landed on GitHub, which no click in
      // this window will ever report. This is the only path that notices, so the
      // ticket reaches `done` (and pushes its provider status) without anyone
      // having to reopen the dashboard.
      let landed: number[] = [];
      try {
        landed = settleShipGates(
          localStore,
          { projectId: project.id },
          (message) => logger.debug(message),
        );
        for (const id of landed) void pushDoneStatus(id, false);
      } catch (e) {
        // Bookkeeping over state that is already stored: the next tick retries.
        logError('karst: merge gate settle failed', e);
      }
      // The graph coordinator sweep (G4) is no longer part of `runPrSync` —
      // it has its own tick (`runGraphSweep`, `GRAPH_SWEEP_INTERVAL_MS`)
      // that does not depend on the gh/git calls above succeeding.
      // Done tickets are archived on a DELAY (manifest `archiveDoneAfterDays`,
      // default 3 days), never when they reach done — and a ticket can sit at
      // done for any duration, so this is a sweep, not a transition hook. It
      // rides this tick like settleShipGates: once at activation, then every
      // PR_SYNC_INTERVAL_MS, with no second interval to dispose. Pure store
      // bookkeeping (no git, no gh), and a failure only delays the next tick.
      let archived: number[] = [];
      try {
        archived = autoArchiveDoneTickets(localStore, {
          afterDays:
            (currentManifest() ?? emptyManifest()).archiveDoneAfterDays ??
            DEFAULT_ARCHIVE_DONE_AFTER_DAYS,
          scope: { projectId: project.id },
        });
      } catch (e) {
        logError('karst: done ticket auto-archive failed', e);
      }
      // The ticket sweep above only stamps `archived_at`; it never removes the
      // worktree folder, so an auto-archived ticket's dir would sit on disk
      // forever — the archive-compact plan's 'No auto-sweep' gap. This rides
      // the same tick (once at activation, then every PR_SYNC_INTERVAL_MS, no
      // second interval to dispose) to sweep those folders for real.
      //
      // It keys on `archived_at` ALONE (`onlyArchived`), not the broad
      // archived-or-done predicate the manual command uses: a freshly-merged
      // ticket must keep its folder until `archiveDoneAfterDays` lets the
      // done-archive above stamp `archived_at` — this sweep undercutting that
      // delay is what would reap a done-but-on-the-board ticket 3 days early.
      // The selection predicate also guards agent-not-running, and like the
      // rest of the tick this is fault-isolated: a failure only delays the
      // next sweep. Scoped to the current project so one IDE window never
      // reaps another's worktrees.
      let worktreesSwept = false;
      try {
        const archiveAllocator = makePortAllocator(
          localStore,
          (currentManifest() ?? emptyManifest()).portRange,
        );
        const archivedTrees = await archiveInactiveWorktrees(
          defaultGitRunner,
          localStore,
          archiveAllocator,
          { projectId: project.id, onlyArchived: true },
        );
        worktreesSwept =
          archivedTrees.archived > 0 ||
          archivedTrees.failed > 0 ||
          archivedTrees.reapedServers.length > 0;
        if (archivedTrees.archived > 0 || archivedTrees.failed > 0) {
          logger.info(
            `karst: auto-swept ${archivedTrees.archived} inactive worktree(s), ` +
              `skipped ${archivedTrees.skipped}, failed ${archivedTrees.failed}`,
          );
        }
        // A background sweep must not spam a popup every PR tick for a server
        // it cannot stop (the same worktree retries next sweep), so a kill that
        // FAILED — a live server serving a deleted tree — is promoted to the
        // warn level in the Karst output channel, not left at info. Successful
        // reaps stay at info.
        for (const s of archivedTrees.reapedServers) {
          if (s.outcome === 'kill-failed') logger.warn(describeReap(s));
          else logger.info(describeReap(s));
        }
      } catch (e) {
        logError('karst: inactive worktree auto-archive failed', e);
      }
      // The same setting gates the background sweep: a ticket the sweep
      // archives is closed exactly like one archived by a click, so its done
      // terminals go with it — off by default, and never a live session.
      if ((currentManifest() ?? emptyManifest()).closeDoneTerminalsWithTicket === true) {
        let closed = 0;
        try {
          for (const id of archived) closed += closeTicketDoneTerminals(id);
        } catch (e) {
          logError('karst: closing done terminals failed', e);
        }
        if (closed > 0) {
          logger.info(
            `karst: closed ${closed} done terminal(s) of ${archived.length} auto-archived ticket(s)`,
          );
        }
      }
      // A forced sweep pushes unconditionally: "nothing changed" is the answer
      // the user asked for, and it is also what clears the panel's spinner.
      if (force || changed > 0 || mergeChanged > 0 || landed.length > 0 || archived.length > 0 || worktreesSwept) {
        provider.refresh();
        dashboard.pushAll();
      }
    } catch (e) {
      logError('karst: PR status sync failed', e);
    } finally {
      prSyncRunning = false;
      if (forceQueued) {
        forceQueued = false;
        void runPrSync(true);
      }
    }
  };
  void runPrSync();
  const prSyncTimer = setInterval(() => void runPrSync(), PR_SYNC_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(prSyncTimer) });

  // Antigravity conversation watch: agy 1.1.11 executes no hooks in the CLI
  // (its hooks.json loads but never runs — see docs/guides/adding-agent-core.md
  // § Antigravity), so its lifecycle signals are READ, not pushed — from the
  // CLI's own conversation DB. A permission ask is a `steps` row with
  // status = 9, observed while the approval dialog is on screen; answering
  // resolves it to status = 3. The sweep locates the conversation by the
  // worktree path stored in the DB's workspace blob, diffs the pending
  // approval state per ticket, and posts the normalized events (SessionStart /
  // permission.asked / UserPromptSubmit) through the SAME dispatchHook seam
  // and closures as the hook endpoint, so session-id capture (--conversation
  // resume), launch-intent confirmation, the generation barrier, the amber
  // glyph, the Now line and the dashboard refresh are shared. Session end →
  // idle is the terminal-close sweep's job, not this one's.
  const AGY_WATCH_INTERVAL_MS = 10_000;
  let agyWatchRunning = false;
  const runAgyConversationWatch = (): void => {
    if (agyWatchRunning) return;
    agyWatchRunning = true;
    try {
      const appDataDir = resolveAgyAppDataDir();
      const terminals = [...vscode.window.terminals];
      logger.debug(`[agy] sweep tick: ${terminals.length} terminals`);
      for (const terminal of terminals) {
        const named = terminalIdentity.identify(terminal);
        if (named?.identity?.provider !== 'antigravity') continue;
        const worktree = listWorktreesByTicket(localStore, named.ticketId)[0];
        if (!worktree) {
          logger.debug(`[agy] ticket ${named.ticketId}: no worktree found`);
          continue;
        }
        let snapshot: AgyConversationSnapshot | null = null;
        let agyUsage: AgyConversationUsage | null = null;
        try {
          const found = findConversationForWorktree(appDataDir, worktree.path);
          if (found) {
            const db = openAgyConversationDb(found.dbPath);
            try {
              snapshot = {
                dbPath: found.dbPath,
                conversationId: found.conversationId,
                pendingApproval: db.pendingApprovalCount() > 0,
              };
              // Read usage while the DB is open — the lifecycle watch
              // doubles as the usage channel for antigravity sessions.
              agyUsage = db.usage();
            } finally {
              db.close();
            }
          }
        } catch (error) {
          logError(`karst: agy conversation read failed for ticket ${named.ticketId}`, error);
          continue;
        }
        logger.debug(`[agy] ticket ${named.ticketId}: conversation=${snapshot?.conversationId ?? 'none'}, usage=${agyUsage ? `${agyUsage.input}/${agyUsage.output}/${agyUsage.cacheRead}` : 'null'}, launchId=${named.launchId ?? 'none'}`);
        const state =
          agyWatchStates.get(named.ticketId) ?? { dbPath: null, started: false, awaiting: false };
        const events = agyWatchTick(state, snapshot);
        if (events.length === 0) {
          // Lifecycle produced no events, but still dispatch any usage
          // observation (the usage read is outside the lifecycle continue).
          const usageState = agyUsageStates.get(named.ticketId) ?? { eventId: null };
          const usageEvents = agyUsageTick(usageState, agyUsage);
          agyUsageStates.set(named.ticketId, usageState);
          for (const event of usageEvents) {
            logger.debug(`[agy] ticket ${named.ticketId}: dispatching UsageUpdate event_id=${event.usage.event_id}`);
            const usagePayload: HookPayload = {
              hook_event_name: 'UsageUpdate',
              cwd: worktree.path,
              session_id: snapshot?.conversationId ?? '',
              usage: event.usage,
              ...(named.launchId ? { launchId: named.launchId } : {}),
            };
            try {
              dispatchHook(
                localStore,
                usagePayload,
                notifyHook,
                shouldApplyHookState,
                sessionProviderFor,
                hookChannelRecorder,
              );
            } catch (error) {
              logError(`karst: agy usage dispatch failed for ticket ${named.ticketId}`, error);
            }
          }
          continue;
        }
        agyWatchStates.set(named.ticketId, state);
        // The session id for non-SessionStart events is the CURRENT
        // conversation's id — the same one SessionStart carried.
        const conversationId = snapshot?.conversationId;
        for (const event of events) {
          const base = {
            cwd: worktree.path,
            session_id:
              event.kind === 'SessionStart'
                ? event.sessionId
                : (conversationId ?? undefined),
            ...(named.launchId ? { launchId: named.launchId } : {}),
          };
          const payload: HookPayload =
            event.kind === 'SessionStart'
              ? { hook_event_name: 'SessionStart', ...base }
              : event.kind === 'permission.asked'
                ? { hook_event_name: 'permission.asked', ...base }
                : { hook_event_name: 'UserPromptSubmit', ...base };
            try {
              dispatchHook(
                localStore,
                payload,
                notifyHook,
                shouldApplyHookState,
                sessionProviderFor,
                hookChannelRecorder,
                logger.debug,
              );
            } catch (error) {
              logError(`karst: agy watch dispatch failed for ticket ${named.ticketId}`, error);
            }
        }
        // Conversation-DB token usage: agy 1.1.12 persists per-call usage in
        // this same DB (steps.metadata field-9 submessage — see agyUsageWatch.ts),
        // so the lifecycle watch doubles as the usage channel. The cumulative
        // sample rides the same UsageUpdate seam and closures as the
        // codex/opencode bridges — attribution (impl segment vs fix), the
        // generation barrier, and the store's cumulative-delta ledger are shared.
        // A re-sweep of an unchanged DB emits nothing; the store dedupes on
        // event id anyway.
        {
          const usageState = agyUsageStates.get(named.ticketId) ?? { eventId: null };
          const usageEvents = agyUsageTick(usageState, agyUsage);
          agyUsageStates.set(named.ticketId, usageState);
          for (const event of usageEvents) {
            const usagePayload: HookPayload = {
              hook_event_name: 'UsageUpdate',
              cwd: worktree.path,
              session_id: snapshot?.conversationId ?? '',
              usage: event.usage,
              ...(named.launchId ? { launchId: named.launchId } : {}),
            };
            try {
              dispatchHook(
                localStore,
                usagePayload,
                notifyHook,
                shouldApplyHookState,
                sessionProviderFor,
                hookChannelRecorder,
                logger.debug,
              );
            } catch (error) {
              logError(`karst: agy usage dispatch failed for ticket ${named.ticketId}`, error);
            }
          }
        }
      }
    } catch (error) {
      logError('karst: agy conversation watch failed', error);
    } finally {
      agyWatchRunning = false;
    }
  };
  void runAgyConversationWatch();
  const agyWatchTimer = setInterval(runAgyConversationWatch, AGY_WATCH_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(agyWatchTimer) });

  // Claude interactive usage watch: Claude's documented hooks carry no token
  // counters, but Claude Code writes a per-session JSONL transcript at
  // ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl whose `assistant`
  // messages carry per-API-call token usage (input_tokens/output_tokens/
  // cache_read_input_tokens/cache_creation_input_tokens) with a stable message
  // uuid. The sweep reads that file (read-only, like the agy conversation DB),
  // sums the messages into a CUMULATIVE session sample keyed by the LAST
  // message's uuid, and posts it through the SAME UsageUpdate seam and closures
  // as the codex/opencode bridges — attribution (impl segment vs fix), the
  // generation barrier, and the store's cumulative-delta ledger are shared. A
  // re-sweep of an unchanged transcript emits nothing; the store dedupes on
  // event id anyway. Session end -> the terminal-close callback clears the watch
  // state. Interactive usage is not a liveness signal: nothing here touches
  // agent_state.
  const CLAUDE_TRANSCRIPT_WATCH_INTERVAL_MS = 10_000;
  let claudeTranscriptWatchRunning = false;
  const runClaudeTranscriptWatch = async (): Promise<void> => {
    if (claudeTranscriptWatchRunning) return;
    claudeTranscriptWatchRunning = true;
    try {
      const projectsDir = resolveClaudeProjectsDir();
      const terminals = [...vscode.window.terminals];
      logger.debug(`[claude] sweep tick: ${terminals.length} terminals`);
      for (const terminal of terminals) {
        const named = terminalIdentity.identify(terminal);
        if (named?.identity?.provider !== 'claude') continue;
        const worktree = listWorktreesByTicket(localStore, named.ticketId)[0];
        if (!worktree) {
          logger.debug(`[claude] ticket ${named.ticketId}: no worktree found`);
          continue;
        }
        const sessionId = getTicket(localStore, named.ticketId).sessionId;
        if (!sessionId) {
          logger.debug(`[claude] ticket ${named.ticketId}: no sessionId`);
          continue;
        }
        const transcriptPath = transcriptPathFor(projectsDir, worktree.path, sessionId);
        let fingerprint: { mtimeMs: number; size: number } | null = null;
        try {
          const st = statSync(transcriptPath);
          fingerprint = { mtimeMs: st.mtimeMs, size: st.size };
        } catch {
          continue; // no transcript yet — the session may not have written one
        }
        const state =
          claudeTranscriptStates.get(named.ticketId) ??
          { transcriptPath: null, eventId: null, fingerprint: null };
        if (
          state.transcriptPath === transcriptPath &&
          state.fingerprint !== null &&
          state.fingerprint.mtimeMs === fingerprint.mtimeMs &&
          state.fingerprint.size === fingerprint.size
        ) {
          continue; // unchanged since the last read — nothing new to parse
        }
        let text: string;
        try {
          text = await fsReadFile(transcriptPath, 'utf8');
        } catch (error) {
          logError(`karst: claude transcript read failed for ticket ${named.ticketId}`, error);
          continue;
        }
        const usage = parseClaudeTranscript(text);
        const snapshot: ClaudeTranscriptSnapshot = { transcriptPath, usage };
        const events = claudeTranscriptTick(state, snapshot);
        state.fingerprint = fingerprint;
        claudeTranscriptStates.set(named.ticketId, state);
        logger.debug(`[claude] ticket ${named.ticketId}: usage=${usage ? `${usage.input}/${usage.output}/${usage.cacheRead}/${usage.cacheWrite}` : 'null'}, events=${events.length}, launchId=${named.launchId ?? 'none'}`);
        if (events.length === 0) continue;
        for (const event of events) {
          const payload: HookPayload = {
            hook_event_name: 'UsageUpdate',
            cwd: worktree.path,
            session_id: sessionId,
            usage: event.usage,
            ...(named.launchId ? { launchId: named.launchId } : {}),
          };
          try {
            dispatchHook(
              localStore,
              payload,
              notifyHook,
              shouldApplyHookState,
              sessionProviderFor,
              hookChannelRecorder,
              logger.debug,
            );
          } catch (error) {
            logError(
              `karst: claude transcript usage dispatch failed for ticket ${named.ticketId}`,
              error,
            );
          }
        }
      }
    } catch (error) {
      logError('karst: claude transcript usage watch failed', error);
    } finally {
      claudeTranscriptWatchRunning = false;
    }
  };
  void runClaudeTranscriptWatch();
  const claudeTranscriptTimer = setInterval(
    () => void runClaudeTranscriptWatch(),
    CLAUDE_TRANSCRIPT_WATCH_INTERVAL_MS,
  );
  context.subscriptions.push({ dispose: () => clearInterval(claudeTranscriptTimer) });

  // The `karst` CLI commits to the registry from its own `node` process; this
  // host's connection never sees those writes, so an open dashboard would keep
  // rendering the last snapshot it built. `PRAGMA data_version` changes only
  // for OTHER connections' commits — the watcher refreshes every open panel
  // when the CLI lands a marker, and stays silent for the host's own writes,
  // which already push state. Observer only: it must never trigger the stage
  // driver, or a change notification could start the same run in two windows
  // at once (the DB is shared by every window).
  context.subscriptions.push(
    watchExternalChanges(localStore, () => {
      // Window-level first, and unconditionally: the sidebar reflects registry
      // state whether or not any dashboard happens to be open, and refreshing
      // it once per open panel was N calls for one change.
      provider.refresh();
      for (const ticketId of dashboard.openTicketIds()) {
        // A CLI write requires a complete redraw (including supplemental
        // facts), but it is not the answer to a dashboard action in flight.
        dashboard.pushPassiveState(ticketId);
      }
    }),
  );

  // Startup dependency preflight: karst shells out to tools it doesn't
  // bundle. The registry is the whole list — never hand-maintain one here, or the
  // preflight and the Getting Started checklist drift apart.
  const depFaults = refreshDepsStatus();

  // Fresh-install: auto-open the getting-started panel when this
  // workspace has no manifest yet and the user hasn't dismissed it. Per-workspace
  // (workspaceState) so a new project re-triggers even if dismissed elsewhere.
  let autoOpenedGettingStarted = false;
  if (vscode.workspace.workspaceFolders?.[0]) {
    let manifestExists = false;
    try {
      manifestExists = existsSync(manifestPathOrThrow());
    } catch {
      manifestExists = false;
    }
    const dismissed = context.workspaceState.get<boolean>(GETTING_STARTED_DISMISSED_KEY) === true;
    if (!manifestExists && !dismissed) {
      gettingStarted.open();
      autoOpenedGettingStarted = true;
    }
  }

  // Suppress the toast when the panel already shows the same dependency status.
  if (depFaults.length > 0 && !autoOpenedGettingStarted) {
    for (const f of depFaults) logger.warn(`dependency '${f.dep.binary}' is ${f.state}`);
    void vscode.window
      .showWarningMessage(
        depFaults
          .map((f) => renderDependencyFault(f.dep, f.state))
          .filter((m): m is string => m !== null)
          .join(' '),
        'Open setup checklist',
      )
      .then((choice) => {
        if (choice === 'Open setup checklist') gettingStarted.open();
      });
  }

  // Shared entry: resolve the manifest, remember it for ticket-form actions, and
  // open the create-mode page. Backs the ticket-form command and the deprecated
  // onboarding alias.
  const openTicketFormCreate = async (): Promise<void> => {
    const manifest = await resolveManifest(logger.info);
    if (!manifest) return; // no folder / scaffolded / invalid — message shown
    manifests.set(manifest, manifestPathOrThrow());
    ticketForm.openCreate();
  };

  // Cross-window freshness (§ projects / multi-window). Sidebar refreshes are
  // driven by in-window commands and this window's own hook endpoint, so work
  // done in another window — even on a ticket this project owns, via a session
  // whose hooks land there — leaves this board stale until something local
  // happens. Regaining focus is the cheap, well-timed moment to re-read: it is
  // exactly when the user looks at the board, and it costs nothing while the
  // window sits in the background.
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) provider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('karst.openDashboard', (arg: unknown) => {
      const ticketId = ticketIdArg(arg);
      if (ticketId === undefined) return;
      dashboard.openDashboard(ticketId);
      showStatusFor(ticketId);
    }),
    vscode.commands.registerCommand(
      'karst.openSession',
      async (arg: unknown, options: OpenSessionOptions = {}) => {
        const ticketId = ticketIdArg(arg);
        if (ticketId === undefined) return;
        // Task 3: a host-only configured assignment (the Fix path) resolves the
        // adapter from ITS provider — the ticket/manifest precedence only
        // applies when no assignment is present. The assignment is never
        // accepted from a webview message (it is not a webview message shape).
        const adapter = options.assignment
          ? instrument(resolveAdapter(options.assignment.provider), options.assignment.provider)
          : currentAgentAdapter(ticketId);
      // A completed graph is waiting only for Karst's local marker; this must
      // not depend on the formerly used provider still being available.
      const activeGraph = activeGraphRunFor(localStore.db, ticketId);
      if (activeGraph && activeGraph.status === 'completed-awaiting-impl-marker') {
        void vscode.window.showInformationMessage(
          `Ticket #${ticketId}: the implementation graph is complete — run \`karst stage impl pass\` to advance.`,
        );
        return;
      }
      // Without the CLI the terminal opens, prints a shell "command not found",
      // and sits there looking like karst did something.
      if (!options.providerReady && !guardCapability('sessions', ticketId)) return;
      // A graph ticket with an active run is owned by the graph coordinator:
      // REVEAL the live node terminal, never spawn a second agent (entry-point
      // matrix, Slice 3 Task 7).
      if (activeGraph) {
        let session = graphTransport?.sessions().find((s) => s.ticketId === ticketId);
        // The terminal may be a revived one this window has not re-attached yet
        // (a reload between the session's launch and this click). Re-attach it
        // BEFORE reporting "not attached" — a live session is recoverable, and
        // the message is only correct when the coordinator genuinely cannot
        // find the session.
        if (!session) await reattachGraphSessions();
        session = graphTransport?.sessions().find((s) => s.ticketId === ticketId);
        if (session) {
          session.terminal?.show();
        } else {
          void vscode.window.showInformationMessage(
            `Ticket #${ticketId} is owned by an active graph run (${activeGraph.status}) — its session is not attached to this window; the coordinator re-attaches it on the next sweep.`,
          );
        }
        return;
      }
      // The single continue-or-start entry point must never dead-end. A drafted
      // ticket that was never run has no worktree yet — rather than tell the user
      // to "scope it first", scope its selected repos now (the same confirmScope +
      // scope→impl transition the ticket form's Start runs), then open the session in
      // the fresh worktree. This is what makes the sidebar/dashboard button work
      // for the drafted-but-unstarted case, not just the interrupted one.
      let wt = listWorktreesByTicket(localStore, ticketId)[0];
      if (!wt) {
        // Recovery must never reinterpret an already-impl/fix ticket as a new
        // draft. A missing recovery worktree is corruption/recoverable idle,
        // not permission to run scope and transition the stage.
        if (options.recovery) return;
        const draft = getTicket(localStore, ticketId);
        if (draft.selectedRepos.length === 0) {
          void vscode.window.showWarningMessage(
            `Ticket #${ticketId} has no repositories selected — edit it to choose one, then start.`,
          );
          return;
        }
        try {
          // No page to ask here (this is Start on a saved draft), so the pull
          // takes its default: ON, the same as the ticket form's switch ships.
          await confirmScope(
            localStore,
            currentManifest() ?? emptyManifest(),
            ticketId,
            draft.selectedRepos,
            { onPullFailed: warnBaseNotPulled, debug: (message) => logger.debug(message) },
          );
          // Scope has only a pass edge → impl (it is not a gate), so pass it: the
          // session then opens in the impl worktree, and the dashboard reads impl.
          transition(localStore, ticketId, 'scope', { kind: 'passed' });
          provider.refresh();
        } catch (e) {
          logError('start ticket (scope on session open) failed', e);
          void vscode.window.showErrorMessage(
            `Could not start ticket #${ticketId}: ${e instanceof Error ? e.message : String(e)}`,
          );
          return;
        }
        wt = listWorktreesByTicket(localStore, ticketId)[0];
        if (!wt) {
          void vscode.window.showWarningMessage(`Ticket #${ticketId} could not be scoped — check its repositories.`);
          return;
        }
      }
      const t = getTicket(localStore, ticketId);

      // A GRAPH approach ticket at impl runs the graph — never a plain
      // implementation session (the reported defect: the graph approach was
      // selected and a plain session opened instead). The active-run reveal
      // above already returned; here a run in any other state exists (blocked/
      // completed/stale — the coordinator owns continuation) or none at all
      // (bootstrap the run and launch the planner session now).
      const graphApproachDef = withBuiltInApproaches(currentManifest() ?? emptyManifest())
        .approaches?.find((a) => a.id === t.approach)?.graph;
      if (graphApproachDef && t.stageCurrent === 'impl') {
        if (options.recovery) return; // recovery never launches a second run
        const existing = graphCoordinatorStore?.db
          .prepare('SELECT id, status FROM approach_graph_runs WHERE ticket_id = ? ORDER BY id DESC LIMIT 1')
          .get(ticketId) as { id: number; status: string } | undefined;
        if (existing) {
          const live = graphTransport?.sessions().find((s) => s.ticketId === ticketId);
          if (live) {
            live.terminal?.show();
          } else {
            void vscode.window.showInformationMessage(
              `Ticket #${ticketId} is owned by graph run ${existing.id} (${existing.status}) — the coordinator owns continuation; use the Inside panel.`,
            );
          }
          return;
        }
        await launchGraphRun(ticketId);
        return;
      }

      // Resolve the approach's method prompt (its entrypoint), if one resolves.
      // Any failure (no folder, no package, bad id) → no method, ticket context
      // alone. Built-in approaches (direct, single-subagent) have no entrypoint.
      // The built-in overlay seam is the launch consumer: the packaged built-in
      // must resolve here exactly as it does in the ticket form and Settings.
      let approachPrompt: string | null = null;
      try {
        const approaches = withBuiltInApproaches(currentManifest() ?? emptyManifest())
          .approaches ?? [];
        approachPrompt = resolveApproachPrompt(approachesDirOrThrow(), approaches, t.approach);
      } catch {
        approachPrompt = null;
      }

      // Read the ticket's approach package ONCE — its `workflow` drives both the
      // seed invocation and the materialize call below, so both always agree on
      // what the generated `/karst:<id>` command looks like. Any read failure
      // (no folder, not installed) degrades to no package, not a thrown error.
      let pkg: ReturnType<typeof readApproachPackage> = null;
      try {
        pkg = t.approach ? readApproachPackage(approachesDirOrThrow(), t.approach) : null;
      } catch {
        pkg = null;
      }

      // A workflow-bearing approach gets an explicit `/karst:<id> <ticket-key>`
      // invocation as the seed's first line, so the generated command (written by
      // materializeApproach below under the sibling `karst` plugin) actually gets
      // invoked with the ticket key. `buildWorkflowInvocation` is the single source
      // of truth for the command name, shared with the materializer so they can't drift.
      let invocation =
        pkg?.workflow?.length && t.approach
          ? buildWorkflowInvocation(t.approach, t.key ?? '')
          : null;

      // For a single-subagent ticket with a chosen agent, resolve its body (a
      // local agent file OR an approach artifact, matching the pool entry's
      // `source`) so it can be materialized into the launch plugin and named in
      // the delegation instruction below. Any resolution failure degrades to no
      // solo agent — the session still opens, just without the plugin/delegation.
      // Shares `soloAgentBody` with the inside process assignments (`processFor`),
      // so a chosen agent drives the session and the processes with the same body.
      let soloAgent: { name: string; body: string } | undefined;
      if (t.approach === 'single-subagent' && t.agent) {
        const body = soloAgentBody(t.agent);
        if (body) soloAgent = { name: t.agent, body };
      }

      // ALWAYS seed the session with the ticket's own context (key, title,
      // description, fetched brief, repos), then the approach method if any — so
      // even a built-in "direct" approach opens with full context, not a dull
      // empty session. A built-in single-subagent has no method prompt of its
      // own, so a resolved solo agent contributes a delegation instruction
      // instead. undefined only when there's genuinely nothing to say.
      const delegation = soloAgent
        ? `Delegate this ticket to the \`${soloAgent.name}\` subagent and oversee it to completion.`
        : null;
      // Aggregate the ticket's full implementation context (prompt/brief/repos
      // plus live worktrees/branches/services/PRs) into markdown and seed it —
      // in-process, no CLI round-trip (the extension already holds the data).
      const ticketContextMd = renderTicketContext(
        buildTicketContext(
          localStore,
          currentManifest(),
          ticketId,
          context.globalStorageUri.fsPath,
        ),
      );
      // The done marker (§5.4) rides every seed, not just the approach path:
      // `materializeApproach` only runs for an installed package or a solo agent,
      // so a `direct` ticket would otherwise never be told to fire the marker and
      // would strand at `impl`. The marker names the stage the session is actually
      // working on — a resume at `fix` gets `stage fix pass`, not the impl marker.
      // ONLY marker stages carry one: seeded at `uat`/`review`/`ship` the command
      // names an earlier stage and the CLI refuses it, so an agent that trusted
      // it would report the ticket advanced when it had not moved (869edna84).
      // The concrete ticket key is the arg (the seed is plain text — no
      // `$ARGUMENTS` substitution).
      const markerStage = markerStageFor(t.stageCurrent as StageKey | null);
      const markerInstruction =
        markerStage === null
          ? null
          : renderDoneMarkerInstruction(
              buildCliStagePrefix(context, dbPath, markerStage),
              t.key ?? String(ticketId),
            );
      const initialPrompt = buildSessionSeed(
        ticketContextMd,
        approachPrompt ?? delegation,
        invocation,
        markerInstruction,
        // The one-line pointer to the agent manual rides every fresh seed
        // (869edmcme): it costs ~40 tokens and saves the agent from reading the
        // extension's dist/ to learn how Karst works and what the CLI can do.
        renderGuideInstruction(buildCliGuidePrefix(context)),
      );

      // Resume the captured session when continuing interactive work, so the
      // agent keeps its context instead of re-deriving from a cold seed (§5.3).
      // `stageCurrent` is stored loosely as `string | null` at the store layer
      // (like `stages.ts`'s `stage_key as StageKey`); it is always one of
      // STAGE_KEYS in practice. The marker rides the resume nudge too — a
      // resumed impl/fix session still has to fire it when work is done.
      // One resolution for the whole launch: the resume check below and the
      // model pick further down must agree on which core is actually starting,
      // or a ticket could be handed a session id the launching CLI cannot find.
      // A host-only assignment override wins over ticket/manifest precedence.
      const launchProvider =
        options.assignment?.provider ??
        resolveProvider(t.agentProvider, currentManifest()?.agentProvider);
      const resumeId = shouldResumeSession({
        sessionId: t.sessionId,
        sessionProvider: t.sessionProvider,
        stageCurrent: t.stageCurrent as StageKey,
        provider: launchProvider,
        allowResume: options.allowResume,
      })
        ? (t.sessionId ?? undefined)
        : undefined;
      // At `fix` the resume has a specific job — the gate that just failed wrote
      // its reason and log, so point the agent at them instead of a vague
      // "continue". `currentStage` carries both (state.ts → buildStepper).
      const fixBrief =
        t.stageCurrent === 'fix'
          ? renderFixBrief(
              t.key ?? `#${ticketId}`,
              t.stages,
              latestFindingBatch(localStore, ticketId),
              listGateRuns(localStore, ticketId),
            )
          : null;
      let seedPrompt = resumeId
        ? `${fixBrief ?? `Continue the in-progress work on ticket ${t.key ?? `#${ticketId}`}. Re-read live state if needed.`}${markerInstruction ? `\n\n${markerInstruction}` : ''}`
        : initialPrompt;

      // Materialize the ticket's approach package (and/or its chosen solo agent)
      // into agent-specific launch args (e.g. Claude's `--plugin-dir`) so its
      // agents/skills/commands are actually available in the session — not just
      // the entrypoint prompt. `matPkg` falls back to a synthetic minimal package
      // when there's a solo agent but no installed package (single-subagent is
      // built-in, never installed) — the adapter still needs an id/label to build
      // the plugin dir. Any failure degrades gracefully to no extras (still a
      // valid session).
      let materialized: Materialized = { extraArgs: [], ownedPaths: [] };
      try {
        const matPkg = pkg ?? (soloAgent ? { id: t.approach!, label: t.approach! } : null);
        if (matPkg && adapter.materializeApproach) {
          materialized = adapter.materializeApproach({
            pkg: matPkg,
            baseDir: approachesDirOrThrow(),
            sessionDir: wt.path,
            soloAgent,
            cliContextPrefix: buildCliContextPrefix(context, dbPath),
            // Same marker gating as the seed above: a materialized workflow
            // command appends its done-marker step ONLY when a stage prefix is
            // given, so a session opened at a non-marker stage (uat/review/
            // ship) must not be handed a command whose closing step is the
            // `stage impl pass` the CLI would refuse (869edna84). At `fix` this
            // also corrects the default: the command's marker step names `fix`,
            // not the `impl` the old unconditional call defaulted to.
            cliStagePrefix:
              markerStage === null
                ? undefined
                : buildCliStagePrefix(context, dbPath, markerStage),
            cliPhasePrefix: buildCliPhasePrefix(context, dbPath),
            cliGuidePrefix: buildCliGuidePrefix(context),
          });
        }
      } catch (error) {
        logError(`approach materialization failed for ticket ${ticketId}`, error);
      }
      invocation =
        materialized.invocation && pkg?.workflow?.length
          ? `${materialized.invocation} ${t.key ?? ''}`.trim()
          : null;
      if (!resumeId) {
        seedPrompt = buildSessionSeed(
          ticketContextMd,
          approachPrompt ?? delegation,
          invocation,
          markerInstruction,
          renderGuideInstruction(buildCliGuidePrefix(context)),
        );
      }
      // A caller with one specific job for this session (the merge brief behind
      // "Resolve conflicts") wins over every composed seed above, resume line
      // included: the ticket's own context would bury the one instruction the
      // click was about. Set host-side only — never from a webview message.
      if (options.seedPrompt) seedPrompt = options.seedPrompt;
      const extraArgs =
        materialized.extraArgs.length > 0
          ? materialized.extraArgs
          : undefined;

      // A SOURCED approach (git/npm) that produced neither a method prompt NOR
      // materialized artifacts is broken (dangling entrypoint / package missing)
      // — warn so it isn't mistaken for the approach's method being applied. The
      // session still opens with ticket context; only the approach method is
      // missing. A BUILT-IN approach (no source) legitimately has no method —
      // never warn there.
      const approachDef = (currentManifest()?.approaches ?? []).find((a) => a.id === t.approach);
      const approachIsSourced = approachDef?.source !== undefined;
      if (t.approach && approachIsSourced && approachPrompt === null && extraArgs === undefined) {
        void vscode.window.showWarningMessage(
          `Approach "${t.approach}" produced no method prompt or loadable artifacts — ` +
            `opening with ticket context only. Check the approach's entrypoint in the manifest and reinstall it.`,
        );
      }

      // Resolve the launch model: the ticket's own model wins, else the manifest
      // default, else undefined (let the agent CLI pick). Threaded as `--model`.
      // The provider it's resolved against is this same ticket's own resolved
      // agent core (§ agent core selection) — a ticket overridden to a different
      // provider must not carry an incompatible model pick across the switch.
      // A host-only assignment override (the Fix path) supplies the model
      // VERBATIM: the assignment was already provider-checked and fully
      // resolved at the process boundary, so no precedence is re-applied here.
      const model = options.assignment
        ? (options.assignment.model ?? undefined)
        : resolveModelForProvider(
            launchProvider,
            t.model,
            currentManifest()?.defaultModel,
            modelCatalog,
          );

      // Resolve the launch effort the same way: the ticket's own effort wins,
      // else the manifest default, else undefined (the agent CLI's default).
      // Only carried when the RESOLVED model advertises it (§ Execution policy
      // resolution). A host-only assignment override supplies it verbatim.
      const effort = options.assignment
        ? (options.assignment.effort ?? undefined)
        : resolveEffortForProvider(
            launchProvider,
            t.effort,
            currentManifest()?.defaultEffort,
            model,
            modelCatalog,
          );

      // Terminal name/icon/color are frozen at creation, so the tab carries the
      // status-free brand mark from the start — never a stage-at-launch glyph
      // hue, which the tab would keep for the rest of its life (869egvp46-fu2).
      // The template keeps the stage legible as text. The one-char follow-up
      // marker is FORCED at this seam (terminalTicketName) so a follow-up's
      // terminal reads as a follow-up whatever the template says (869ehqx68-fu1).
      const naming = terminalNaming({
        name: terminalTicketName(t, currentManifest()?.terminalNameTemplate),
        brandIcon,
      });

        sessions.openSession(
          adapter,
          ticketId,
          wt.path,
          { key: t.key, title: t.title },
          seedPrompt,
          extraArgs,
          model,
          resumeId,
          naming,
          materialized.ownedPaths,
          { ...options, ...(effort ? { effort } : {}) },
          // Record the session manager's active provider/model snapshot, so a
          // later fix recovery reads the identity that ACTUALLY launched this
          // session — not the one a manifest edit resolves today. A host-only
          // assignment carries its configured agent name too.
          {
            provider: launchProvider,
            model: model ?? null,
            ...(options.assignment?.agentName
              ? { agentName: options.assignment.agentName }
              : {}),
          },
        );
        if (sessions.isOpen(ticketId)) {
          ownedSessionTickets.add(ticketId);
          await persistOwnedSessionTickets();
        }
        showStatusFor(ticketId);
      },
    ),
    vscode.commands.registerCommand('karst.spinTicket', async (arg: unknown) => {
      const ticketId = ticketIdArg(arg);
      if (ticketId === undefined) return;
      // A spin creates worktrees and installs deps into them; both tools fail
      // deep inside that, long after the user stopped watching.
      if (!guardCapability('worktrees') || !guardCapability('gates')) return;

      const manifest = await resolveManifest(logger.info);
      if (!manifest) return; // no folder / scaffolded / invalid — message already shown

      // Ticket label (key — title) for all the spin chrome, not the raw id —
      // prefixed with the one-char follow-up marker when applicable.
      let label: string;
      try {
        const t = getTicket(localStore, ticketId);
        label = compactTicketLabel(t, ticketLabel(t, manifest.ticketLabelTemplate));
      } catch {
        void vscode.window.showErrorMessage(`Ticket #${ticketId} not found.`);
        return;
      }

      // Pre-select all repositories on first spin; on later spins default to the
      // set the user last chose for THIS ticket (workspace-scoped memory). A
      // repository removed from the manifest since then simply drops out.
      //
      // Repositories with no service are offered too — they get a worktree so the
      // agent can edit them, they just never start a process. The description
      // says so, rather than leaving the user to wonder why nothing came up.
      const repoNames = Object.keys(manifest.repositories);
      const memKey = `karst.spin.services.${ticketId}`;
      const remembered = context.workspaceState.get<string[]>(memKey);
      const items = repoNames.map((name) => ({
        label: name,
        description: serviceOf(manifest, name) !== undefined
          ? undefined
          : 'no service — worktree only',
        picked: remembered ? remembered.includes(name) : true,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: `Spin ${label} — select repositories`,
      });
      if (!picked || picked.length === 0) return; // cancelled or empty
      const hot = picked.map((i) => i.label);

      // Remember this choice so the next spin of this ticket pre-selects it.
      await context.workspaceState.update(memKey, hot);

      try {
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Spinning ${label}…`,
            cancellable: true,
          },
          (_progress, token) => {
            // Bridge VS Code's CancellationToken to a standard AbortSignal that
            // threads down into the health wait + child processes.
            const ctrl = new AbortController();
            token.onCancellationRequested(() => ctrl.abort());
            return spinTicket(localStore, manifest, ticketId, hot, {
              signal: ctrl.signal,
              debug: (message) => logger.debug(message),
            });
          },
        );
        provider.refresh();
        dashboard.pushState(ticketId);
        void vscode.window.showInformationMessage(
          `Spun ${label} — ${result.servers.length} server(s) running.`,
        );
        // A conflicting dev server that had to be killed is the user's own
        // process — an unreported reap is how a "why did my dev server die?"
        // mystery starts (the archive paths raise the same warning).
        if (result.reclaimedPids.length > 0) {
          void vscode.window.showWarningMessage(
            `Spin for ${label} stopped ${result.reclaimedPids.length} conflicting dev server(s) ` +
              `(pid ${result.reclaimedPids.join(', ')}) to free the allocated port(s).`,
          );
        }
      } catch (err) {
        provider.refresh(); // partial state is real; surface it
        if (err instanceof SpinCancelledError) {
          // User-initiated: quiet info, not a red error toast.
          void vscode.window.showInformationMessage(`Spin cancelled for ${label}.`);
        } else {
          void vscode.window.showErrorMessage(
            `Spin failed for ${label}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }),
    // Build a chosen worktree's karst-extension checkout and open it as the
    // extension development host in a new window — the F5 flow without ever
    // opening the (hidden, path-typed) worktree folder. OFF by default
    // (karst.launchWorktreeDev.enabled), and lists only worktrees whose
    // package.json says "karst"; a ticket's other repos are not launchable and
    // never appear.
    vscode.commands.registerCommand('karst.launchWorktreeExtension', async () => {
      if (!guardCapability('worktrees')) return;
      if (!launchWorktreeConfig().enabled) {
        void vscode.window.showWarningMessage(
          'Karst: launch worktree extension is disabled — set karst.launchWorktreeDev.enabled to true.',
        );
        return;
      }
      const project = currentProject();
      if (!project) {
        void vscode.window.showWarningMessage(
          'Karst: open a workspace folder first, then launch a worktree extension.',
        );
        return;
      }
      const rows = selectLaunchableWorktrees(listWorktreesByProject(localStore, project.id));
      if (rows.length === 0) {
        void vscode.window.showInformationMessage(
          'No karst-extension worktrees in this project — scope a ticket against the karst repository first.',
        );
        return;
      }
      const items = rows.map((r) => ({
        label: `${r.key ?? `#${r.ticketId}`} · ${r.branch ?? 'no branch'}`,
        description: r.repo,
        detail: r.path,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        title: 'Launch Worktree Extension (Development)',
        placeHolder: 'Pick a worktree to build and open as the extension dev host',
      });
      if (!picked) return;
      const row = rows[items.indexOf(picked)];
      if (row) await launchWorktreeDevWindow(row.path);
    }),
    // "Add ticket" opens the ticket form (create mode). A manifest is
    // resolved first so the classify-gate + repo picker have services to show.
    vscode.commands.registerCommand('karst.openTicketForm', () => openTicketFormCreate()),
    // Deprecated alias. A command id is externally consumable — a user's
    // keybindings.json or another extension may already invoke it — so the old
    // `onboarding` spelling stays registered and simply forwards. It is hidden
    // from the palette via `menus.commandPalette` in package.json; drop it only
    // in a release that can state the break (glossary rename, 869ecknnn).
    vscode.commands.registerCommand('karst.openOnboarding', () => openTicketFormCreate()),
    vscode.commands.registerCommand('karst.editTicket', async (arg: unknown) => {
      const ticketId = ticketIdArg(arg);
      if (ticketId === undefined) return;
      const manifest = await resolveManifest(logger.info);
      if (!manifest) return;
      manifests.set(manifest, manifestPathOrThrow());
      ticketForm.openEdit(ticketId);
    }),
    // Follow-up: a done ticket spawns a linked child that inherits its
    // repos/approach/agent/model and carries its brief+PRs into the new
    // session's context (§ continue work on a ticket). Opens the ticket form in edit mode so
    // the user types the actual follow-up ask straight away.
    vscode.commands.registerCommand('karst.createFollowUpTicket', async (arg: unknown) => {
      const ticketId = ticketIdArg(arg);
      if (ticketId === undefined) return;
      let child;
      try {
        child = createFollowUpTicket(localStore, ticketId, { projectId: currentProject()?.id },
          (message) => logger.debug(message));
      } catch (err) {
        const message =
          err instanceof TicketNotDoneError
            ? err.message
            : `Couldn't create a follow-up ticket: ${err instanceof Error ? err.message : String(err)}`;
        void vscode.window.showErrorMessage(message);
        return;
      }
      provider.refresh();
      const manifest = await resolveManifest(logger.info);
      if (manifest) manifests.set(manifest, manifestPathOrThrow());
      ticketForm.openEdit(child.id);
      void vscode.window.showInformationMessage(`Created follow-up ticket ${child.key}.`);
    }),
    vscode.commands.registerCommand('karst.archiveTicket', async (arg: unknown) => {
      const ticketId = ticketIdArg(arg);
      if (ticketId === undefined) return;
      archiveTicket(localStore, ticketId);
      // Setting-gated (`closeDoneTerminalsWithTicket`, OFF by default): the
      // ticket is being closed, so its DONE terminals go with it — dead tabs
      // whose process already exited, never a live session. A disposal failure
      // must not fail the archive itself, so this is wrapped and reported.
      if ((currentManifest() ?? emptyManifest()).closeDoneTerminalsWithTicket === true) {
        try {
          const closed = closeTicketDoneTerminals(ticketId);
          if (closed > 0) {
            logger.info(`karst: closed ${closed} done terminal(s) with ticket ${ticketId}`);
          }
        } catch (err) {
          logError('karst: closing done terminals with ticket failed', err);
        }
      }
      const manifest = currentManifest();
      if (manifest) {
        const allocator = makePortAllocator(localStore, manifest.portRange);
        for (const w of listWorktreesByTicket(localStore, ticketId)) {
          if (!w.branch) continue;
          try {
            const r = await archiveWorktree(defaultGitRunner, localStore, allocator, {
              ticketId,
              repoPath: w.repo,
              path: w.path,
              branch: w.branch,
              baseRef: w.baseRef ?? w.branch,
            });
            // Archiving removes the tree out from under anything running in it,
            // so whatever had to be stopped is named here. A kill that FAILED is
            // a live server serving a deleted tree — the exact orphan this
            // ticket exists to end — so it is a warning, not a log line.
            for (const s of r.reapedServers) {
              logger.info(describeReap(s));
              if (s.outcome === 'kill-failed') {
                void vscode.window.showWarningMessage(describeReap(s));
              }
            }
          } catch (err) {
            channel.appendLine(`archive worktree failed for ${w.path}: ${String(err)}`);
            void vscode.window.showWarningMessage(`Worktree not archived: ${String(err)}`);
          }
        }
      }
      provider.refresh();
    }),
    vscode.commands.registerCommand('karst.unarchiveTicket', async (arg: unknown) => {
      const ticketId = ticketIdArg(arg);
      if (ticketId === undefined) return;
      for (const a of listArchives(localStore, ticketId)) {
        try {
          const r = await restoreWorktree(defaultGitRunner, localStore, { ticketId, path: a.path });
          if (r.outcome === 'skipped') {
            void vscode.window.showWarningMessage(`Worktree not restored: ${r.reason ?? 'unknown reason'}`);
          }
        } catch (err) {
          channel.appendLine(`restore worktree failed for ${a.path}: ${String(err)}`);
          void vscode.window.showWarningMessage(`Worktree not restored: ${String(err)}`);
        }
      }
      unarchiveTicket(localStore, ticketId);
      provider.refresh();
    }),
    // Pause/unpause from the sidebar context menu. Same seam as the dashboard
    // action: the store flag is stamped BEFORE the running round is asked to
    // stop, and unpause nudges the driver through `maybeDrive` rather than
    // driving directly, so §5.4's single-flight rules still hold.
    vscode.commands.registerCommand('karst.pauseTicket', async (arg: unknown) => {
      const ticketId = ticketIdArg(arg);
      if (ticketId === undefined) return;
      pauseTicket(localStore, ticketId);
      driver.requestStop(ticketId);
      provider.refresh();
      dashboard.pushState(ticketId);
    }),
    vscode.commands.registerCommand('karst.unpauseTicket', async (arg: unknown) => {
      const ticketId = ticketIdArg(arg);
      if (ticketId === undefined) return;
      unpauseTicket(localStore, ticketId);
      provider.refresh();
      dashboard.pushState(ticketId);
      maybeDrive(ticketId, 'unpause');
    }),
    vscode.commands.registerCommand('karst.deleteTicket', async (arg: unknown) => {
      const ticketId = ticketIdArg(arg);
      if (ticketId === undefined) return;
      const label = ticketLabel(getTicket(localStore, ticketId), currentManifest()?.ticketLabelTemplate);
      // Hard delete is irreversible — confirm with a modal before removing the
      // ticket and all its child rows.
      const choice = await vscode.window.showWarningMessage(
        `Permanently delete "${label}"? This cannot be undone.`,
        { modal: true },
        'Delete',
      );
      if (choice !== 'Delete') return;
      try {
        await deleteTicketPermanently(localStore, ticketId, {
          closePanel: (id) => ticketForm.closeTicket(id),
          reap: (id) => reapAttachments(context.globalStorageUri.fsPath, id),
          graphBytesRoot: graphBytesRootFor(),
          artifactsRoot: join(context.globalStorageUri.fsPath, 'artifacts'),
        });
      } catch (err) {
        const message =
          `Karst could not finish permanently deleting "${label}". ` +
          `Attachment cleanup may be incomplete: ${String(err)}`;
        logger.warn(message);
        await vscode.window.showErrorMessage(message);
      }
      provider.refresh();
    }),
    vscode.commands.registerCommand('karst.archiveInactiveWorktrees', async () => {
      const manifest = currentManifest();
      if (!manifest) {
        void vscode.window.showWarningMessage('Karst: no manifest loaded.');
        return;
      }
      const allocator = makePortAllocator(localStore, manifest.portRange);
      const summary = await archiveInactiveWorktrees(defaultGitRunner, localStore, allocator, {
        projectId: currentProject()?.id,
      });
      // Say what the sweep had to stop to remove those trees. An unattended
      // bulk archive is the last place a killed — or unkillable — dev server may
      // go unsaid; a kill that FAILED leaves a live server serving a deleted
      // tree, the exact orphan this ticket exists to end, so it gets the same
      // warning the single-ticket archive command raises for it, not just a log
      // line. Aggregated into one message rather than one popup per row, since a
      // sweep can touch many worktrees at once.
      for (const s of summary.reapedServers) logger.info(describeReap(s));
      const stopped = summary.reapedServers.filter((s) => s.outcome === 'killed').length;
      const stillRunning = summary.reapedServers.filter((s) => s.outcome === 'kill-failed');
      void vscode.window.showInformationMessage(
        `Karst: archived ${summary.archived} worktree(s), skipped ${summary.skipped}, failed ${summary.failed}` +
          (stopped > 0 ? `, stopped ${stopped} running server(s).` : '.'),
      );
      if (stillRunning.length > 0) {
        void vscode.window.showWarningMessage(
          `Karst: could not stop ${stillRunning.length} server(s) still running in archived ` +
            `worktrees — ${stillRunning.map((s) => `'${s.repo}' (pid ${s.pid ?? 'unknown'})`).join(', ')}.`,
        );
      }
      provider.refresh();
    }),
    vscode.commands.registerCommand('karst.compactArchivedWorktrees', async () => {
      const manifest = currentManifest();
      if (!manifest) {
        void vscode.window.showWarningMessage('Karst: no manifest loaded.');
        return;
      }
      const result = await compactArchivedWorktrees(defaultGitRunner, localStore, 7 * 24 * 60 * 60 * 1000);
      void vscode.window.showInformationMessage(
        `Karst: compacted ${result.compacted} archive(s), skipped ${result.skipped}, failed ${result.failed}` +
          ` — swept ${result.sweep.prunedBranches} orphan branch(es), ${result.sweep.prunedArchiveRefs} orphan ref(s).`,
      );
      provider.refresh();
    }),
    vscode.commands.registerCommand('karst.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('karst.showAttention', async () => {
      const items = currentAttention();
      if (items.length === 0) {
        // The command is palette-reachable even at zero; an empty picker would
        // read as a broken list rather than an answer.
        void vscode.window.showInformationMessage('No tickets need your input.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        items.map((i) => ({
          label: `${i.kind === 'failed' ? '$(warning)' : '$(bell)'} ${i.key} · ${i.reason}`,
          description: i.title,
          ticketId: i.ticketId,
        })),
        { placeHolder: 'Tickets needing you' },
      );
      if (picked) void vscode.commands.executeCommand('karst.openDashboard', picked.ticketId);
    }),
    vscode.commands.registerCommand('karst.openTokenUsage', () => tokenUsagePanel.open()),
    vscode.commands.registerCommand('karst.openResources', () => resourcesPanel.open()),
    vscode.commands.registerCommand('karst.showLogs', () => channel.show()),
    vscode.commands.registerCommand('karst.search', async () => {
      const query = await vscode.window.showInputBox({ prompt: 'Filter tickets' });
      provider.setFilter(query ?? '');
    }),
    vscode.commands.registerCommand('karst.filterState', async () => {
      // Facet counts reflect the live store; the current selection is pre-picked
      // so the multi-select picker reads as a stateful toggle. Multiple status
      // facets can be chosen at once (their union); `normalizeSelection` (via
      // setFacets) resolves the exclusive All/Archived cases.
      const scope = { projectId: currentProject()?.id };
      const counts = facetCounts(
        listTickets(localStore, scope),
        listArchivedTickets(localStore, scope).length,
      );
      const active = new Set(provider.getFacets());
      const picks = await vscode.window.showQuickPick(
        FACETS.map((f) => ({
          label: f.label,
          description: `${counts[f.key]}`,
          facet: f.key,
          picked: active.has(f.key),
        })),
        { placeHolder: 'Filter tickets by state (pick any)', canPickMany: true },
      );
      // `undefined` = dismissed (leave selection); an empty array = cleared → All.
      if (picks) provider.setFacets(picks.map((p) => p.facet));
    }),
    vscode.commands.registerCommand('karst.openSettings', () => {
      // Settings reads the manifest file DIRECTLY, not via resolveManifest — an
      // INVALID manifest must open the panel (with its error banner) rather than
      // fire a toast, since fixing a broken manifest is the point of this page.
      // We only bail (with a message) for the two cases the panel can't help:
      // no workspace folder, and no manifest file to edit at all.
      let path: string;
      try {
        path = manifestPathOrThrow();
      } catch {
        void vscode.window.showErrorMessage('Open a folder before using Karst.');
        return;
      }
      if (!existsSync(path)) {
        void vscode.window.showWarningMessage(
          'No karst.yml in this workspace yet — create a ticket to scaffold one.',
        );
        return;
      }
      // loadSettingsState reads the file: valid → typed values, invalid → raw
      // fallback + the error, shown inline. No toast either way.
      settings.open();
    }),
    vscode.commands.registerCommand('karst.openManifest', async () => {
      // Opens the FILE, deliberately — not the settings panel. Config karst
      // parses but does not render (docs/config-ui-coverage.md, D1) is only
      // reachable here, so this must work even when the manifest is invalid.
      let path: string;
      try {
        path = manifestPathOrThrow();
      } catch {
        void vscode.window.showWarningMessage('Karst: no workspace folder is open.');
        return;
      }
      if (!existsSync(path)) {
        void vscode.window.showWarningMessage(
          `Karst: no manifest at ${path}. Run onboarding to scaffold one.`,
        );
        return;
      }
      const doc = await vscode.workspace.openTextDocument(path);
      await vscode.window.showTextDocument(doc);
    }),
    vscode.commands.registerCommand('karst.openGettingStarted', () => gettingStarted.open()),
    // Reprobe on demand: the user installs a tool in a terminal, clicks the status
    // bar, and karst answers without a window reload. No polling — nothing else
    // knows when an install finishes, and a timer would probe PATH forever.
    vscode.commands.registerCommand('karst.recheckDeps', () => {
      const missing = refreshDepsStatus();
      if (missing.length === 0) {
        void vscode.window.showInformationMessage('Karst has every tool it needs.');
        return;
      }
      gettingStarted.open();
    }),
  );

  // VS Code restores terminal tabs across an extension-host reload, but the old
  // host's SessionManager cannot be restored with them. Adopt visible current-
  // project terminals into the new manager, then recover only owned sessions
  // that remain hidden in the background through the registered command so its
  // usual scoping/seed/materialization path is preserved.
  const toRecoveryCandidate = (
    ticket: ReturnType<typeof listTickets>[number],
  ): RecoveryCandidate => ({
    id: ticket.id,
    agentState: ticket.agentState,
    canResume: shouldResumeSession({
      sessionId: ticket.sessionId,
      sessionProvider: ticket.sessionProvider,
      stageCurrent: ticket.stageCurrent as StageKey,
      provider: resolveProvider(ticket.agentProvider, currentManifest()?.agentProvider),
    }),
    hasWorktree: listWorktreesByTicket(localStore, ticket.id).length > 0,
  });
  const projectId = currentProject()?.id;
  const currentTickets =
    projectId === undefined ? [] : listTickets(localStore, { projectId });
  const candidates: RecoveryCandidate[] = currentTickets.map(toRecoveryCandidate);
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));

  // A terminal tab can be revived AFTER this activation scan — VS Code restores
  // them on its own schedule — and one that lands late used to be invisible to
  // karst forever: background recovery then launched a SECOND agent beside the
  // still-running first, leaving the user two tabs for one ticket. Every
  // terminal opened from here on is reconciled the same way the scan does it,
  // classified against the store as it stands at that moment.
  const classifyLateSession = (ticketId: number): RestoredSessionDisposition => {
    const project = currentProject()?.id;
    if (project === undefined) return 'ignore';
    const ticket = listTickets(localStore, { projectId: project }).find(
      (row) => row.id === ticketId,
    );
    return classifyRestoredSession(ticket ? toRecoveryCandidate(ticket) : undefined);
  };
  context.subscriptions.push(
    // A terminal karst launched in a PREVIOUS window comes back without its
    // env, so its pid has to be read before it can be named — that probe is
    // what makes this handler async.
    vscode.window.onDidOpenTerminal(async (terminal) => {
      await terminalIdentity.resolve(terminal);
      // A graph session terminal can be revived AFTER the activation scan too;
      // re-attach it now (idempotent) so a live graph session is never left
      // "not attached to this window" until the next coordinator sweep.
      await reattachGraphSessions();
      const session = restoredSessionOf(terminal, terminalIdentity);
      if (!session) return;
      const outcome = sessions.adoptLateSession(session, classifyLateSession);
      if (outcome.kind === 'adopted') {
        logger.info(
          `session recovery: adopted late-restored terminal for ticket ${session.ticketId}`,
        );
        provider.refresh();
        dashboard.pushState(session.ticketId);
        return;
      }
      if (outcome.kind === 'duplicate') {
        logger.warn(
          `session recovery: closed a duplicate restored terminal for ticket ${session.ticketId}`,
        );
      }
    }),
    // A closed terminal's pid is free for the OS to hand to anything, so its
    // record must not outlive it.
    vscode.window.onDidCloseTerminal((terminal) => {
      const named = terminalIdentity.identify(terminal);
      if (named) terminalIdentity.forget(named.ticketId);
    }),
  );

  // Records for tickets this window can no longer act on are dead weight, and
  // every one of them is a pid that could be reused by an unrelated process.
  if (projectId !== undefined) {
    terminalIdentity.prune(currentTickets.map((ticket) => ticket.id));
  }
  // Every terminal already revived must be identifiable BEFORE the scan below
  // decides what to adopt: a pid still being probed reads as "no session here",
  // and background recovery would launch a second agent beside the live one.
  await Promise.all(
    vscode.window.terminals.map((terminal) => terminalIdentity.resolve(terminal)),
  );

  const adoptedVisibleSessions = sessions.reconcileRestoredSessions((ticketId) => {
    return classifyRestoredSession(candidateById.get(ticketId));
  });
  const backgroundRecoveryPlan = planSessionRecovery(
    candidates,
    [...ownedSessionTickets],
    adoptedVisibleSessions,
  );
  let ownershipChanged = false;
  for (const ticketId of backgroundRecoveryPlan.discard) {
    ownershipChanged = ownedSessionTickets.delete(ticketId) || ownershipChanged;
  }

  for (const ticketId of backgroundRecoveryPlan.idle) {
    setAgentState(localStore, ticketId, 'idle');
    // No resumable session and no worktree means nothing of this ticket is
    // running anywhere — so a recovery round still reading `fixing` is a fix
    // that died with a previous host and will never report. Interrupting it
    // here is what keeps the driver from answering every later trigger with
    // "a fix execution is already in flight" for a session that is gone.
    try {
      if (interruptActiveFixExecution(localStore, ticketId, new Date().toISOString())) {
        logger.info(
          `session recovery: ticket ${ticketId} had a fix execution with no resumable ` +
            `session — recovery round interrupted; the ticket rests at fix for a human`,
        );
      }
    } catch (err) {
      logError(`karst: interrupting the fix execution for ticket ${ticketId} failed`, err);
    }
    ownershipChanged =
      ownedSessionTickets.delete(ticketId) || ownershipChanged;
    logger.warn(
      `session recovery: ticket ${ticketId} has no resumable session or worktree`,
    );
  }
  if (ownershipChanged) await persistOwnedSessionTickets();
  if (backgroundRecoveryPlan.idle.length > 0) {
    provider.refresh();
    dashboard.pushAll();
  }
  // Each replacement below reveals its terminal, and every reveal raises the
  // activation the binding listens for. None of that is the user landing on a
  // ticket, so the binding stays out of it until recovery has settled —
  // otherwise a window coming up with several live sessions drags a dashboard
  // open per recovered ticket while it is still starting.
  const revealsDuringRecovery = backgroundRecoveryPlan.resume.length > 0;
  if (revealsDuringRecovery) binder.suspend();
  const recoveryTasks: Array<Promise<unknown>> = [];
  for (const ticketId of backgroundRecoveryPlan.resume) {
    const recoveryTask = recoverSession(
      sessions,
      recoveryLifecycle,
      ticketId,
      (id) =>
        vscode.commands.executeCommand('karst.openSession', id, {
          recovery: true,
        }),
    ).then(async (outcome) => {
      const disposition = recoveryOutcomeDisposition(outcome);
      if (disposition === 'ready') return;
      if (disposition === 'retry-next-activation') {
        if (outcome.kind === 'interrupted' && outcome.cleanupError !== undefined) {
          logError(
            `session recovery interrupted cleanup failed for ticket ${ticketId}`,
            outcome.cleanupError,
          );
        }
        return;
      }
      setAgentState(localStore, ticketId, 'idle');
      ownedSessionTickets.delete(ticketId);
      await persistOwnedSessionTickets();
      if (outcome.kind === 'rejected') {
        logError(`session recovery failed for ticket ${ticketId}`, outcome.error);
      } else {
        logger.warn(
          `session recovery failed for ticket ${ticketId}: replacement ${outcome.kind}`,
        );
      }
      provider.refresh();
      dashboard.pushState(ticketId);
    }).catch((error) => {
      logError(`session recovery completion failed for ticket ${ticketId}`, error);
    });
    pendingSessionRecoveryTasks.add(recoveryTask);
    recoveryTasks.push(recoveryTask);
    void recoveryTask.finally(() => {
      pendingSessionRecoveryTasks.delete(recoveryTask);
    });
  }
  if (revealsDuringRecovery) {
    // Released whatever the outcomes were: a recovery that failed still stops
    // producing reveals, and a binding left suspended would need a reload. One
    // turn after the last task settles, because a reveal's activation event
    // crosses the host boundary and can land just behind the command that
    // caused it. Best-effort by nature — an activation that arrives later still
    // costs one dashboard reveal, never a loop.
    void Promise.allSettled(recoveryTasks).then(() =>
      setTimeout(() => binder.resume(), 0),
    );
  }
}

export async function deactivate(): Promise<void> {
  const cleanupErrors: unknown[] = [];
  try {
    await cancelAllNpmCommands();
  } catch (error) {
    cleanupErrors.push(error);
  }
  await Promise.allSettled([...pendingApproachInstalls]);
  pendingApproachInstalls.clear();
  try {
    await endpoint?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  endpoint = undefined;
  try {
    await graphEndpoint?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  graphEndpoint = undefined;
  try {
    graphCoordinatorStore?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  graphCoordinatorStore = undefined;
  // Live graph node sessions are NOT terminated here: they are detached
  // vscode terminals whose rows stay `running`, and the next activation
  // re-attaches them via the identity registry (the coordinator's job, not
  // a window's teardown).
  graphTransport = undefined;
  try {
    shutdownSessionRecovery?.();
  } catch (error) {
    cleanupErrors.push(error);
  }
  await Promise.allSettled([...pendingSessionRecoveryTasks]);
  try {
    await flushSessionOwnership?.();
  } catch (error) {
    cleanupErrors.push(error);
  }
  pendingSessionRecoveryTasks.clear();
  shutdownSessionRecovery = undefined;
  flushSessionOwnership = undefined;
  try {
    shutdownTicketChanges?.();
  } catch (error) {
    cleanupErrors.push(error);
  }
  shutdownTicketChanges = undefined;
  try {
    store?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  store = undefined;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'karst: extension deactivation cleanup failed');
  }
}

/**
 * The worktree-path rendering context for the dashboard: the manifest's
 * `worktreePathDisplay` + the workspace root. Reads the already-resolved
 * manifest when available, else quietly loads it (no prompts — the dashboard
 * shouldn't nag). Returns undefined (→ absolute paths) when nothing is resolvable.
 *
 * `warn`/`info` are only invoked on the fallback disk-read (the common case
 * reuses `current`, already surfaced by whoever resolved it) — each defaults to
 * a no-op so this stays silent, matching the "no prompts" contract, unless a
 * caller opts into logging (extension.ts's activate() passes `logger.warn`/
 * `logger.info`).
 */
function worktreePathContext(
  current: Manifest | undefined,
  warn: (message: string) => void = () => {},
  info: (message: string) => void = () => {},
): PathContext | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;

  let manifest = current;
  if (!manifest) {
    try {
      const loaded = loadManifestWithDiagnostics(manifestPathOrThrow());
      for (const w of loaded.warnings) warn(`karst.yml: ${w}`);
      for (const n of loaded.notices) info(`karst.yml: ${n}`);
      manifest = loaded.manifest;
    } catch {
      return undefined; // no/invalid manifest — fall back to absolute paths
    }
  }
  const display = manifest.worktreePathDisplay ?? 'absolute';
  if (display !== 'relative') return undefined;
  return { display, projectRoot: folder.uri.fsPath };
}

/**
 * A ticket command arg is either a bare ticketId (webview row action posts a
 * number) or an object carrying `ticketId`. Normalize both to a ticket id, or
 * `undefined` if neither shape carries one.
 */
function ticketIdArg(arg: unknown): number | undefined {
  if (typeof arg === 'number') return arg;
  if (arg && typeof arg === 'object' && 'ticketId' in arg) {
    const id = (arg as { ticketId: unknown }).ticketId;
    return typeof id === 'number' ? id : undefined;
  }
  return undefined;
}

/**
 * Compose the `node <cli> context --db <db> --manifest <yml>` prefix the
 * generated `/karst:<id>` command runs to refresh live ticket context. The CLI
 * ships in `dist/cli/main.js`; the manifest path is best-effort (omitted when
 * unresolved — the CLI then renders without the services section).
 */
function buildCliContextPrefix(context: vscode.ExtensionContext, dbPath: string): string {
  const cliEntry = join(context.extensionUri.fsPath, 'dist', 'cli', 'main.js');
  let manifestPath: string | undefined;
  try {
    manifestPath = manifestPathOrThrow();
  } catch {
    manifestPath = undefined;
  }
  return composeContextCommand(cliEntry, dbPath, manifestPath);
}

/**
 * Compose the `node <cli> stage <stage> pass --db <db> --ticket` prefix a session
 * runs (ticket key appended) to fire the done marker for the stage it is working
 * on. Same CLI entry as context. The manifest rides along so the CLI can tell
 * which project the ticket key belongs to — two projects sharing the DB may
 * legitimately use the same key.
 *
 * `stage` defaults to `impl` — the generated `/karst:<id>` command is
 * materialized once at install time, before any ticket exists, so it can only
 * ever carry the impl boundary. A live session seed passes the ticket's actual
 * stage, so a resume at `fix` fires `fix pass` instead of the impl marker (which
 * would throw: there is no impl→? edge from fix).
 */
function buildCliStagePrefix(
  context: vscode.ExtensionContext,
  dbPath: string,
  stage: MarkerStage = 'impl',
): string {
  const cliEntry = join(context.extensionUri.fsPath, 'dist', 'cli', 'main.js');
  // Best-effort, same as the context prefix: an unresolved manifest just means
  // the CLI falls back to an unscoped key lookup.
  let manifestPath: string | undefined;
  try {
    manifestPath = manifestPathOrThrow();
  } catch {
    manifestPath = undefined;
  }
  return composeStageCommand(cliEntry, dbPath, stage, manifestPath);
}

/**
 * Compose, for one phase name, the `node <cli> phase <name> --db <db> --ticket`
 * prefix a workflow step runs (ticket key appended) to report entering that
 * phase. Same CLI entry and same best-effort manifest as the stage prefix — the
 * manifest is what stops a key two projects share from marking the wrong board.
 *
 * Returned as a function because the phase name is baked into each command, so
 * the renderer needs one per declared phase rather than a single prefix.
 */
function buildCliPhasePrefix(
  context: vscode.ExtensionContext,
  dbPath: string,
): (phaseName: string) => string {
  const cliEntry = join(context.extensionUri.fsPath, 'dist', 'cli', 'main.js');
  let manifestPath: string | undefined;
  try {
    manifestPath = manifestPathOrThrow();
  } catch {
    manifestPath = undefined;
  }
  return (phaseName: string): string =>
    composePhaseCommand(cliEntry, dbPath, phaseName, manifestPath);
}

/**
 * Compose the `node <cli> guide` command a session runs to read the agent
 * manual (how Karst works, the flow, the CLI verbs). Same CLI entry as the
 * context/stage/phase prefixes; no DB, no manifest, no ticket — the guide is
 * static karst-authored content.
 */
function buildCliGuidePrefix(context: vscode.ExtensionContext): string {
  const cliEntry = join(context.extensionUri.fsPath, 'dist', 'cli', 'main.js');
  return composeGuideCommand(cliEntry);
}

/**
 * The injected dashboard webview asset, built once per call: design system,
 * status palette, provider identity, agent-core identity, and the vendored
 * xterm bundles are all substituted host-side (CSP forbids a shared
 * stylesheet/script). Shared by the production dashboard panels and the
 * development-only Inside preview, so the preview renders the exact asset
 * production does (Finding 1). The agent identity injection is applied
 * outermost, in the same order the settings and ticket form hosts use it.
 *
 * xterm is injected HERE, before `injectCsp` runs at panel creation: the
 * vendored JS lands inside the document's own `<script>` block, so the nonce
 * pass tags it along with the dashboard script. A missing vendor asset (a
 * packaging regression) degrades to the marker comments the webview already
 * guards — the console view reports "unavailable" instead of the dashboard
 * failing to open at all.
 */
function dashboardWebviewHtml(warn: (message: string) => void): string {
  let html = injectAgentPicker(injectAgentIdentity(
    injectProviderIdentity(
      injectPalette(
        injectDesignSystem(readFileSync(join(HERE, 'ui', 'dashboard', 'webview.html'), 'utf8')),
      ),
    ),
  ));
  try {
    html = injectXterm(html, readXtermAssets(join(HERE, 'vendor', 'xterm')));
  } catch (e) {
    warn(`xterm vendor assets unavailable — console view disabled (${(e as Error).message})`);
  }
  return html;
}

/** Real webview panels, wrapped in the `DashboardPanel` interface. */
function makePanelHost(
  context: vscode.ExtensionContext,
  brandIcon?: BrandIconPaths,
  warn: (message: string) => void = () => {},
): PanelHost {
  const html = dashboardWebviewHtml(warn);
  return {
    createPanel(title, _ticketId, preserveFocus): DashboardPanel {
      const panel = vscode.window.createWebviewPanel(
        'karst.dashboard',
        title,
        // A bound open rides on the user clicking the TERMINAL: the panel must
        // appear beside it without taking the caret out of the shell.
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: preserveFocus === true },
        { enableScripts: true, retainContextWhenHidden: true },
      );
      // The brand mark until the first state push repaints it with the ticket's
      // status glyph — a dashboard tab is never unmarked, not even for a frame.
      panel.iconPath = brandIconUri(brandIcon);
      // Nonce per panel, not per host (the html above is built once and reused).
      panel.webview.html = injectCsp(html, newNonce());
      return {
        reveal: (keepFocus) => panel.reveal(undefined, keepFocus),
        postMessage: (message) => void panel.webview.postMessage(message),
        onDidReceiveMessage: (handler) =>
          panel.webview.onDidReceiveMessage(handler, undefined, context.subscriptions),
        // `active` — not `visible`: a preserve-focus reveal makes the panel
        // visible without the user being on it, and binding off that would fire
        // on karst's own reveal rather than on a real click.
        onDidChangeViewState: (handler) =>
          panel.onDidChangeViewState(
            (e) => handler(e.webviewPanel.active),
            undefined,
            context.subscriptions,
          ),
        onDidDispose: (handler) => panel.onDidDispose(handler, undefined, context.subscriptions),
        // `visible` — the counterpart of `active` above: the live repaint asks
        // "can anyone see this?", and a dashboard watched beside a terminal the
        // user types in is visible and inactive.
        isVisible: () => panel.visible,
        setIcon: (p: string) => {
          panel.iconPath = vscode.Uri.file(p);
        },
      };
    },
  };
}

/** Real token-usage panel, with a fresh CSP nonce for every panel. */
function makeUsagePanelHost(
  context: vscode.ExtensionContext,
  brandIcon?: BrandIconPaths,
): UsagePanelHost {
  const html = injectPalette(
    injectDesignSystem(readFileSync(join(HERE, 'ui', 'usage', 'webview.html'), 'utf8')),
  );
  return {
    createPanel(title): UsagePanel {
      const panel = vscode.window.createWebviewPanel(
        'karst.tokenUsage',
        title,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      context.subscriptions.push(panel);
      // Spend across every ticket — no single ticket's status to carry.
      panel.iconPath = brandIconUri(brandIcon);
      panel.webview.html = injectCsp(html, newNonce());
      return {
        reveal: (keepFocus) => panel.reveal(undefined, keepFocus),
        postMessage: (message) => void panel.webview.postMessage(message),
        onDidReceiveMessage: (handler) =>
          panel.webview.onDidReceiveMessage(handler, undefined, context.subscriptions),
        onDidDispose: (handler) => panel.onDidDispose(handler, undefined, context.subscriptions),
      };
    },
  };
}

/** Real resources panel, with a fresh CSP nonce for every panel. */
function makeResourcesPanelHost(
  context: vscode.ExtensionContext,
  brandIcon?: BrandIconPaths,
): ResourcesPanelHost {
  const html = injectPalette(
    injectDesignSystem(readFileSync(join(HERE, 'ui', 'resources', 'webview.html'), 'utf8')),
  );
  return {
    createPanel(title): ResourcesPanel {
      const panel = vscode.window.createWebviewPanel(
        'karst.resources',
        title,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      context.subscriptions.push(panel);
      panel.iconPath = brandIconUri(brandIcon);
      panel.webview.html = injectCsp(html, newNonce());
      return {
        reveal: (keepFocus) => panel.reveal(undefined, keepFocus),
        postMessage: (message) => void panel.webview.postMessage(message),
        onDidReceiveMessage: (handler) =>
          panel.webview.onDidReceiveMessage(handler, undefined, context.subscriptions),
        onDidDispose: (handler) => panel.onDidDispose(handler, undefined, context.subscriptions),
      };
    },
  };
}

/** Real ticket-changes panels, with a fresh CSP nonce for every panel. */
function makeChangesPanelHost(
  context: vscode.ExtensionContext,
  brandIcon?: BrandIconPaths,
): ChangesPanelHost {
  const html = injectPalette(
    injectDesignSystem(readFileSync(join(HERE, 'ui', 'diffs', 'webview.html'), 'utf8')),
  );
  return {
    createPanel(title, _ticketId): ChangesPanel {
      const panel = vscode.window.createWebviewPanel(
        'karst.changes',
        title,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      // The panel itself, not only its listeners: without this the webview
      // outlives extension unload with no owner. VS Code tolerates a second
      // dispose of an already-closed panel.
      context.subscriptions.push(panel);
      panel.iconPath = brandIconUri(brandIcon);
      panel.webview.html = injectCsp(html, newNonce());
      const listeners = new DisposableBag();
      return {
        reveal: () => panel.reveal(),
        // Read per call, not captured: the user can drag the panel to another
        // group, and the diff belongs beside wherever it is NOW.
        viewColumn: () => panel.viewColumn,
        postMessage: (message) => void panel.webview.postMessage(message),
        onDidReceiveMessage: (handler) => {
          listeners.add(panel.webview.onDidReceiveMessage(handler));
        },
        onDidChangeViewState: (handler) =>
          panel.onDidChangeViewState(
            (e) => handler(e.webviewPanel.active),
            undefined,
            context.subscriptions,
          ),
        onDidDispose: (handler) => {
          listeners.add(panel.onDidDispose(() => {
            try {
              handler();
            } finally {
              listeners.dispose();
            }
          }));
        },
      };
    },
  };
}

/**
 * A terminal's launch environment, when it has one. `creationOptions` is a union
 * — a pty-backed terminal carries no `env` at all — so the narrowing lives here
 * rather than at each call site.
 */
function terminalEnv(
  terminal: vscode.Terminal | undefined,
): Readonly<Record<string, string | undefined>> | undefined {
  const opts = terminal?.creationOptions;
  return opts && 'env' in opts
    ? (opts.env as Readonly<Record<string, string | undefined>> | undefined)
    : undefined;
}

/**
 * This window's terminal→ticket lookup, and the only place a pid is captured.
 * `identify` never awaits: `restoredSessions()` is called synchronously from the
 * open path, so a pid must already be resolved (via `resolve`) to count.
 */
interface TerminalIdentityRegistry {
  /** Learn a terminal's pid. Idempotent — repeat calls share one probe. */
  resolve(terminal: vscode.Terminal): Promise<void>;
  /** Name a terminal's ticket from what is already known. Never awaits. */
  identify(terminal: vscode.Terminal): TerminalIdentity | undefined;
  /** Remember a terminal karst just launched, once its pid resolves. */
  remember(
    terminal: vscode.Terminal,
    env: Record<string, string>,
    identity?: SessionIdentity,
  ): void;
  /** Release a ticket's record — its terminal closed, freeing the pid. */
  forget(ticketId: number): void;
  /** Drop records for tickets this window can no longer act on. */
  prune(knownTicketIds: readonly number[]): void;
}

function makeTerminalIdentityRegistry(
  initial: readonly SessionTerminalRecord[],
  persist: (records: SessionTerminalRecord[]) => void,
  lookupIdentity?: DurableSessionIdentityLookup,
  /**
   * Live-pid registry hook (the resource monitor): called once a remembered
   * terminal's pid resolves, with the pid and its ticket. The returned disposer
   * runs when the ticket's record is forgotten — a closed terminal's pid is
   * free for the OS to reissue, so the registration must not outlive it.
   */
  onSessionTerminal?: (pid: number, ticketId: number) => (() => void) | void,
): TerminalIdentityRegistry {
  let records: SessionTerminalRecord[] = [...initial];
  const pidByTerminal = new WeakMap<vscode.Terminal, number>();
  const probes = new WeakMap<vscode.Terminal, Promise<void>>();
  const sessionDisposers = new Map<number, () => void>();

  const resolve = (terminal: vscode.Terminal): Promise<void> => {
    const running = probes.get(terminal);
    if (running) return running;
    // `Terminal.processId` never settles for a terminal whose process never
    // reported one, and activation awaits this before it may adopt anything —
    // so the probe is bounded. A pid that never arrives simply leaves the
    // terminal unidentifiable: the state karst was in before records existed,
    // never a hang and never a failure.
    const probe = new Promise<number | undefined>((done) => {
      const timer = setTimeout(() => done(undefined), PID_PROBE_TIMEOUT_MS);
      void Promise.resolve(terminal.processId).then(
        (pid) => {
          clearTimeout(timer);
          done(pid);
        },
        () => {
          clearTimeout(timer);
          done(undefined);
        },
      );
    }).then((pid) => {
      if (typeof pid === 'number' && pid > 0) pidByTerminal.set(terminal, pid);
    });
    probes.set(terminal, probe);
    return probe;
  };

  const write = (next: SessionTerminalRecord[]): void => {
    records = next;
    persist(records);
  };

  return {
    resolve,
    identify: (terminal) =>
      identifyTerminal(
        { env: terminalEnv(terminal), pid: pidByTerminal.get(terminal) },
        records,
        lookupIdentity,
      ),
    remember: (terminal, env, sessionIdentity) => {
      const ticketId = ticketIdFromTerminalEnv(env);
      if (ticketId === undefined) return;
      const launchId = env[KARST_LAUNCH_ENV];
      void resolve(terminal).then(() => {
        const pid = pidByTerminal.get(terminal);
        if (pid === undefined) return;
        write(
          rememberSessionTerminal(records, {
            ticketId,
            pid,
            ...(launchId ? { launchId } : {}),
            ...(sessionIdentity ? { identity: sessionIdentity } : {}),
          }),
        );
        const dispose = onSessionTerminal?.(pid, ticketId);
        if (dispose) sessionDisposers.set(ticketId, dispose);
      });
    },
    forget: (ticketId) => {
      const next = forgetSessionTerminal(records, ticketId);
      if (next.length !== records.length) write(next);
      const dispose = sessionDisposers.get(ticketId);
      if (dispose) {
        sessionDisposers.delete(ticketId);
        dispose();
      }
    },
    prune: (knownTicketIds) => {
      const next = pruneSessionTerminals(records, knownTicketIds);
      if (next.length !== records.length) write(next);
    },
  };
}

/**
 * Read a terminal's karst identity, or undefined when it has none. `exitStatus`
 * is what separates a live session from a tab whose agent already quit.
 */
function restoredSessionOf(
  terminal: vscode.Terminal,
  identity: TerminalIdentityRegistry,
): RestoredSession | undefined {
  const named = identity.identify(terminal);
  if (!named) return undefined;
  return {
    ticketId: named.ticketId,
    ...(named.launchId ? { launchId: named.launchId } : {}),
    ...(named.identity ? { identity: named.identity } : {}),
    ...(terminal.exitStatus !== undefined ? { exited: true } : {}),
    terminal: wrapTerminal(terminal),
  };
}

/** Wrap a VS Code terminal for both freshly-created and restored sessions. */
function wrapTerminal(terminal: vscode.Terminal): SessionTerminal {
  return {
    show: (preserveFocus) => terminal.show(preserveFocus),
    sendText: (text) => terminal.sendText(text, true),
    dispose: () => terminal.dispose(),
    onDidClose: (handler) => {
      const sub = vscode.window.onDidCloseTerminal((closed) => {
        if (closed === terminal) {
          sub.dispose();
          handler(closed.exitStatus?.code);
        }
      });
    },
  };
}

/** The workspace a revived graph terminal was launched in, when recoverable.
 *  `creationOptions.cwd` survives a reload (the pty details carry it); a
 *  non-string value degrades to '' — the session's cwd is used for attribution
 *  on terminate, and an empty value simply falls back to start-time matching. */
function graphTerminalCwd(terminal: vscode.Terminal): string {
  const opts = terminal.creationOptions;
  const cwd = opts && 'cwd' in opts ? opts.cwd : undefined;
  return typeof cwd === 'string' ? cwd : '';
}

/** Wrap a REVIVED vscode terminal in the graph transport's `TransportTerminal`
 *  surface (the graph host's `createTerminal` returns the same shape for a
 *  freshly-spawned one). Only ever used to re-attach a session that already
 *  exists — it never spawns, and never re-registers in the identity registry. */
function wrapRevivedGraphTerminal(terminal: vscode.Terminal): TransportTerminal {
  return {
    processId: () => Promise.resolve(terminal.processId),
    show: (preserveFocus) => terminal.show(preserveFocus),
    sendText: (text) => terminal.sendText(text, true),
    dispose: () => terminal.dispose(),
    onDidClose: (handler) => {
      const sub = vscode.window.onDidCloseTerminal((closed) => {
        if (closed === terminal) {
          sub.dispose();
          handler(closed.exitStatus?.code);
        }
      });
    },
  };
}

/** Real terminals, wrapped in the `SessionTerminal` interface. */
function makeTerminalHost(identity: TerminalIdentityRegistry): TerminalHost {
  return {
    createTerminal(opts): SessionTerminal {
      // VS Code terminals have no separate "description" field — fold the title
      // into the tab name so the terminal reads "Karst: <key> — <title>".
      const name = opts.description ? `${opts.name} — ${opts.description}` : opts.name;
      const terminal = vscode.window.createTerminal({
        name,
        cwd: opts.cwd,
        shellPath: opts.shellPath,
        shellArgs: opts.shellArgs,
        env: opts.env,
        hideFromUser: opts.hideFromUser,
        // Name/icon/color are frozen at creation — `Terminal.creationOptions` is
        // readonly, so the launch glyph is what the tab keeps for its lifetime.
        ...(opts.iconPath ? { iconPath: vscode.Uri.file(opts.iconPath) } : {}),
        ...(opts.color ? { color: new vscode.ThemeColor(opts.color) } : {}),
      });
      // Capture the launch pid NOW: it is what re-identifies this terminal
      // after a reload strips the env that carries the ticket today.
      identity.remember(terminal, opts.env, opts.identity);
      return wrapTerminal(terminal);
    },
    restoredSessions: () =>
      vscode.window.terminals.flatMap((terminal) => {
        const session = restoredSessionOf(terminal, identity);
        return session ? [session] : [];
      }),
  };
}

/** Graph node terminals, wrapped in the `TransportTerminal` interface. */
function makeGraphTerminalHost(identity: TerminalIdentityRegistry): TransportTerminalHost {
  return {
    createTerminal(opts): TransportTerminal {
      const terminal = vscode.window.createTerminal({
        name: opts.name,
        cwd: opts.cwd,
        shellPath: opts.shellPath,
        shellArgs: opts.shellArgs,
        env: opts.env,
        hideFromUser: opts.hideFromUser,
        // The brand mark rides the graph tab exactly like a regular session's
        // (Terminal.creationOptions is readonly — the launch glyph is frozen).
        ...(opts.iconPath ? { iconPath: vscode.Uri.file(opts.iconPath) } : {}),
      });
      // Remembered in the same per-window registry the session terminals use:
      // the graph env carries KARST_TICKET_ID + KARST_LAUNCH_ID, so a reload
      // re-attaches a live node session instead of launching a second one.
      identity.remember(terminal, opts.env, undefined);
      return {
        processId: () => Promise.resolve(terminal.processId),
        show: (preserveFocus) => terminal.show(preserveFocus),
        sendText: (text) => terminal.sendText(text, true),
        dispose: () => terminal.dispose(),
        onDidClose: (handler) => {
          const sub = vscode.window.onDidCloseTerminal((closed) => {
            if (closed === terminal) {
              sub.dispose();
              handler(closed.exitStatus?.code);
            }
          });
        },
      };
    },
  };
}

/**
 * Bind dashboard actions to real vscode side-effects. Server lifecycle: stop and
 * open are wired to the supervisor + browser; restart can't fully re-run without
 * the original spawn opts (not persisted), so it stops the server and tells the
 * user to re-spin — honest rather than a fake no-op.
 */
/** True when the capability's tools are present; otherwise tells the user why not. */
type CapabilityGuard = (capability: Capability, ticketId?: number, silent?: boolean) => boolean;

/** The vscode bindings for the inside-action dispatches (Task 13). Every
 *  target was already containment- and ownership-checked by the panel; these
 *  resolve the recorded object to its real-world surface. Graph controls
 *  (Slice 3 Task 11) arrive as host callbacks — the transport/session surface
 *  they need lives in `activate`, not here. */
function makeInsideActionHost(
  store: Store,
  graphHost: {
    graphOpenSession: (
      ticketId: number,
      session: { kind: 'planner' | 'node'; runId: number },
    ) => void;
    graphStop: (ticketId: number, graphRunId: number) => void | Promise<void>;
    graphConfirm: (ticketId: number, graphRunId: number) => void | Promise<void>;
    graphMarkImpl: (ticketId: number, graphRunId: number) => void | Promise<void>;
    graphDiscardNode: (ticketId: number, nodeRunId: number) => void | Promise<void>;
    graphEditOverride: (ticketId: number, nodeRunId: number) => void | Promise<void>;
  },
  // The impl stage's Session row: reveal (never launch) the ticket's own
  // interactive session terminal. The dispatch already proved a live
  // implementation run exists; this goes through `SessionManager.revealSession`
  // — the same reveal-or-adopt path `nudge` uses — so a reload that emptied
  // this window's bookkeeping still finds the still-running agent.
  revealSession: (ticketId: number) => void,
  // The graph recovery action's host binding (Slice-4 T6): the atomic claim
  // wrapper plus the prompt re-snapshot seam. Bound in activate where the
  // snapshot root is known; the panel host only routes Resume to it.
  graphRecoveryDeps: (graphRunId: number) => RecoveryDeps,
  // Launch the elected replan planner session (Slice-4 T5) — the recovery
  // election returns a launch request; the host starts the session.
  graphReplanLaunch: (launch: ReplanLaunchRequest) => void,
  // Launch a fresh bootstrap planner on a graph run whose previous bootstrap
  // planner died before ever submitting — the `planner-relaunch` recovery.
  graphBootstrapRelaunch: (launch: BootstrapRelaunchRequest) => void,
  /** Refresh the graph surfaces and immediately continue recoverable work. */
  onGraphRecovered: (ticketId: number, graphRunId: number) => void,
): InsideActionHost {
  /** Run either explicit graph recovery control. `recoverGraphRun` owns every
   * state transition; this host binding only launches the planner it elected
   * and reports the resulting non-verdict outcome. */
  const recoverBlockedGraph = (
    ticketId: number,
    graphRunId: number,
    mode: 'resume' | 'replan',
  ): void => {
    try {
      const recovery = recoverGraphRun(
        graphRecoveryDeps(graphRunId),
        { ticketId, graphRunId, mode },
      );
      if (recovery.kind === 'replanned' && recovery.launch) {
        graphReplanLaunch(recovery.launch);
      }
      if (recovery.kind === 'relaunched' && recovery.launch) {
        graphBootstrapRelaunch(recovery.launch);
      }
      if (recovery.kind === 'refused') {
        void vscode.window.showInformationMessage(
          `Ticket #${ticketId}: the implementation graph cannot ${mode} itself (${recovery.reason}).`,
        );
        return;
      }
      if (recovery.kind !== 'no-op') {
        onGraphRecovered(ticketId, graphRunId);
        void vscode.window.showInformationMessage(
          mode === 'replan'
            ? `Ticket #${ticketId}: the implementation graph is replanning (graph run ${graphRunId}).`
            : `Ticket #${ticketId}: the implementation graph recovery started (graph run ${graphRunId}).`,
        );
      }
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Could not ${mode} the implementation graph: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  return {
    openFile: (path, line) => {
      void (async () => {
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
          const options: vscode.TextDocumentShowOptions = { preview: true };
          if (line !== undefined && line !== null && Number.isFinite(line) && line > 0) {
            // The evidence's 1-based line → the editor's 0-based caret position:
            // the cursor lands on the referenced line (869eja6uv).
            options.selection = new vscode.Range(line - 1, 0, line - 1, 0);
          }
          await vscode.window.showTextDocument(doc, options);
        } catch (e) {
          // The dispatch already proved the deepest ancestor exists, but the
          // file itself can be gone (worktree removed). Mirrors openStageLog's
          // failure copy: a missing file is "cannot open", never a verdict.
          void vscode.window.showWarningMessage(`Cannot open the file at ${path}.`);
        }
      })();
    },
    openPr: (_ticketId, prId) => {
      const pr = getPrById(store, prId);
      if (pr) void vscode.env.openExternal(vscode.Uri.parse(pr.url));
    },
    openCommit: (_ticketId, shipCommitId) => {
      const commit = getShipCommitById(store, shipCommitId);
      if (commit) {
        void vscode.window.showInformationMessage(
          `Commit ${commit.sha.slice(0, 8)} — recorded by ship in ${commit.repo}`,
        );
      }
    },
    resumeStage: (ticketId, stageKey) => {
      const outcome = resumeBlockedStage(store, ticketId, ticketId, stageKey);
      if (outcome.kind === 'cleared') {
        void vscode.commands.executeCommand('karst.openDashboard', ticketId);
        return;
      }
      if (outcome.kind === 'graph-recovery') {
        // The generic Resume refuses the graph block by design (Slice-3 T9);
        // the typed action runs graph-aware recovery: a retry on the same
        // revision, clearing the block only after it durably entered.
        const recovery = recoverGraphRun(
          graphRecoveryDeps(outcome.graphRunId),
          { ticketId: outcome.ticketId, graphRunId: outcome.graphRunId },
        );
        if (recovery.kind === 'retried') {
          void vscode.window.showInformationMessage(
            `Ticket #${ticketId}: the implementation graph was retried (graph run ${outcome.graphRunId}).`,
          );
        } else if (recovery.kind === 'confirmation-restored') {
          void vscode.window.showInformationMessage(
            `Ticket #${ticketId}: the accepted implementation graph is ready to start again.`,
          );
        } else if (recovery.kind === 'replanned') {
          if (recovery.launch) graphReplanLaunch(recovery.launch);
          void vscode.window.showInformationMessage(
            `Ticket #${ticketId}: the implementation graph was replanned (graph run ${outcome.graphRunId}).`,
          );
        } else if (recovery.kind === 'relaunched') {
          if (recovery.launch) graphBootstrapRelaunch(recovery.launch);
          void vscode.window.showInformationMessage(
            `Ticket #${ticketId}: the implementation graph's bootstrap planner was relaunched (graph run ${outcome.graphRunId}).`,
          );
        } else if (recovery.kind === 'refused') {
          void vscode.window.showInformationMessage(
            `Ticket #${ticketId}: the implementation graph cannot retry itself (${recovery.reason}) — open the Inside panel to discard the unknown process.`,
          );
        }
        // Keep this legacy Resume route on the same post-recovery seam as the
        // typed graph controls. It owns neither a second recovery nor launch:
        // it only refreshes the surfaces and wakes work recovery made ready.
        if (
          recovery.kind === 'retried' ||
          recovery.kind === 'confirmation-restored' ||
          recovery.kind === 'replanned' ||
          recovery.kind === 'relaunched'
        ) {
          onGraphRecovered(ticketId, outcome.graphRunId);
        }
      }
    },
    openFullEvidence: (ticketId, processRunId) => {
      void vscode.window.showInformationMessage(`Inside evidence: process run #${processRunId} on ticket #${ticketId}`);
    },
    openBoundedEvidence: (_ticketId, title, rows) => {
      const statusLabel: Record<string, string> = {
        pending: 'Pending',
        run: 'Running',
        wait: 'Waiting',
        pass: 'Passed',
        fail: 'Failed',
        note: 'Note',
        skip: 'Skipped',
      };
      void vscode.window.showQuickPick(
        rows.map((row) => ({
          label: row.label,
          ...(row.detail || row.status
            ? { description: [row.status ? (statusLabel[row.status] ?? 'Recorded') : '', row.detail ?? ''].filter(Boolean).join(' · ') }
            : {}),
          ...(row.duration ? { detail: row.duration } : {}),
        })),
        { title, placeHolder: 'Recorded repository evidence' },
      );
    },
    openSession: (ticketId) => revealSession(ticketId),
    graphOpenSession: (ticketId, session) => graphHost.graphOpenSession(ticketId, session),
    graphStop: (ticketId, graphRunId) => graphHost.graphStop(ticketId, graphRunId),
    graphResume: (ticketId, graphRunId) => recoverBlockedGraph(ticketId, graphRunId, 'resume'),
    graphReplan: (ticketId, graphRunId) => recoverBlockedGraph(ticketId, graphRunId, 'replan'),
    graphConfirm: (ticketId, graphRunId) => graphHost.graphConfirm(ticketId, graphRunId),
    graphMarkImpl: (ticketId, graphRunId) => graphHost.graphMarkImpl(ticketId, graphRunId),
    graphDiscardNode: (ticketId, nodeRunId) => graphHost.graphDiscardNode(ticketId, nodeRunId),
    graphEditOverride: (ticketId, nodeRunId) => graphHost.graphEditOverride(ticketId, nodeRunId),
  };
}

/**
 * Word a successful `changeBaseRef` outcome for the dashboard's action-result
 * toast (§ per-repo base branch — live change): rebased or not, PR retargeted
 * or not, merge check cleared — never a generic "done" (see `panel.ts`'s
 * `change-base-ref` branch, which posts this verbatim as `message`).
 */
function describeChangeBaseRef(result: ChangeBaseRefResult): string {
  if (result.toBase === result.fromBase) return `Already based on ${result.toBase}.`;
  const parts: string[] = [
    result.rebase?.outcome === 'rebased'
      ? `Rebased onto ${result.toBase}.`
      : `Re-targeted to ${result.toBase} (not rebased).`,
  ];
  if (result.prRetarget) {
    parts.push(
      result.prRetarget.ok
        ? `PR #${result.prRetarget.number} re-targeted.`
        : `PR #${result.prRetarget.number} re-target refused.`,
    );
  }
  parts.push('Merge check cleared.');
  return parts.join(' ');
}

function makeDashboardActions(
  store: Store,
  ticketId: number,
  editTicket: () => void,
  afterServerChange: () => void,
  logError: LogError,
  guardCapability: CapabilityGuard,
  // Read fresh when the user confirms ship so a mid-session branch edit
  // controls the PR target and convention edits apply without a window reload.
  manifest: () => Manifest | undefined,
  // Task 3: the configured pr-description process, resolved once at the click.
  // NULL (enabled: false) makes ship skip the AI step for the deterministic
  // fallback — no model call, no pr-description process run.
  prDescriptionProcess: (ticketId: number) => DriveProcessBundle | null,
  // Push the configured post-delivery status for THIS ticket, now that it has
  // reached `done`. A callback rather than the ticketing config + provider,
  // because reaching done is no longer something the ship click can conclude on
  // its own: the same push has to fire from the merge click and from the
  // background sweep, so the decision and the reporting live in one host helper.
  onTicketCompleted: () => Promise<void>,
  // Stream the generic inside-progress union (active/completed/cleared) while
  // `shipTicket` runs, so the confirm-ship click has visible progress instead
  // of a frozen button — ship rides the same channel as gates and Fix, never
  // the legacy per-repo/per-step `ship-progress` stream (Finding 12).
  onInsideProgress: (event: InsideProgressEvent) => void,
  // Run the ship saga for a ticket and settle its aftermath. ONE seam, shared
  // with the stranded-ship recovery at activation (a ship killed by a dead
  // host resumes through the same path as the click that started it): the
  // click owns only the capability guard and the failure toast.
  runShipSaga: (ticketId: number) => Promise<void>,
  // Dispatch one opaque inside action id: the panel posts only the id; the
  // dashboard manager resolves it through the ticket's current registry.
  onInsideAction: (actionId: string) => void,
  // Deliver a prompt to this ticket's session, live or not: nudge the open
  // terminal, else launch one seeded with it. A conflict brief handed to
  // `openSession` alone would be dropped whenever a session is already up —
  // openSession only focuses an existing terminal.
  handOffToSession: (prompt: string) => void,
  // Open the host-owned, whole-ticket changes explorer. The dashboard action
  // carries no path because this closure already owns the ticket id.
  showChanges: () => void,
  // Apply a staged agent-core/model selection to the open session. The closure
  // owns the ticket id AND re-validates the selection against the catalog, so
  // the webview can only ever propose a switch, never direct one.
  switchAgent: (provider: AgentProvider, model: string | null, effort: string | null) => void,
  // Flip the window's terminal binding. Window-scoped, not ticket-scoped, so it
  // takes no id — every open dashboard reports the same toggle.
  toggleBind: () => void,
  // Force an immediate PR/mergeability sweep, ignoring the freshness floor the
  // background tick respects. Project-scoped like the tick itself, so it takes no
  // ticket: the panel is asking for a fresher answer, not a narrower one.
  refreshPrs: () => Promise<void>,
  // Kick the §5.4-safe driver nudge (`maybeDrive`) after a block is cleared.
  // Passed in rather than reached from here because it lives in `activate`'s
  // scope, alongside every other driver trigger (hook, sweep, session close) —
  // resume is just one more trigger, not a special path.
  driveAfterResume: (ticketId: number) => void,
  // Build a worktree's karst-extension checkout and open it as the dev host in
  // a new window. The build takes minutes, so this owns the progress
  // notification and the action ack is immediate (host acceptance only).
  launchWorktree: (path: string) => void,
  // Live feature config (karst.launchWorktreeDev.*), so the action refuses
  // when the switch is off — a crafted message must not launch what the user
  // disabled.
  launchConfig: () => ReturnType<typeof parseLaunchWorktreeConfig>,
  // The graph recovery action's host binding (Slice-4 T6), bound in activate
  // where the snapshot root is known.
  graphRecoveryDeps: (graphRunId: number) => RecoveryDeps,
  // Launch the elected replan planner session (Slice-4 T5).
  graphReplanLaunch: (launch: ReplanLaunchRequest) => void,
  // Launch a fresh bootstrap planner on a graph run whose previous bootstrap
  // planner died before ever submitting — the `planner-relaunch` recovery.
  graphBootstrapRelaunch: (launch: BootstrapRelaunchRequest) => void,
  // Resolve one gate stage's console log via the dashboard manager, which owns
  // the ticket panel: the stage key arrives from the webview, the read stays
  // host-side.
  requestStageLog: (stage: GateStage) => void,
  // Resolve one gate-lane AI process's console tail via the dashboard manager.
  requestAgentLog: (processId: AgentProcessId) => void,
  // Verbose decision-point logging for the recovery action (`sendBackToImplement`),
  // gated inside the logger so it is a no-op unless the manifest's debug flag is on.
  debug: (message: string) => void,
): DashboardActions {
  const worktreeActions = makeWorktreeActions(
    {
      createTerminal: (options) => vscode.window.createTerminal(options),
      revealInExplorer: async (path) => {
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(path));
      },
      expandExplorer: async () => {
        await vscode.commands.executeCommand('list.expand');
      },
      writeClipboard: async (text) => {
        await vscode.env.clipboard.writeText(text);
      },
    },
    logError,
  );

  return {
    stopServer: (serverId) => {
      stopServer(store, serverId);
      afterServerChange();
    },
    restartServer: (serverId) => {
      stopServer(store, serverId);
      afterServerChange();
      void vscode.window.showInformationMessage(
        `Stopped server — re-spin ticket #${ticketId} to restart it with fresh ports.`,
      );
    },
    openServer: (serverId) => {
      const addr = serverAddress(store, serverId);
      if (!addr) {
        void vscode.window.showWarningMessage('That server is no longer running.');
        return;
      }
      void vscode.env.openExternal(vscode.Uri.parse(`http://${addr.host}:${addr.port}`));
    },
    // Copy the server URL to the clipboard (the webview flashes its own feedback).
    copyServerUrl: (serverId) => {
      const addr = serverAddress(store, serverId);
      if (!addr) {
        void vscode.window.showWarningMessage('That server is no longer running.');
        return;
      }
      void vscode.env.clipboard.writeText(`http://${addr.host}:${addr.port}`);
    },
    // No servers yet → let the user spin them from the dashboard (the command
    // owns the service picker + progress; it refreshes the dashboard on success).
    spinServers: () => void vscode.commands.executeCommand('karst.spinTicket', ticketId),
    // Restart-all IS a re-spin: `spinTicket` already calls `stopTicketServers`
    // before starting, so this deliberately shares a command with `spinServers`
    // rather than adding a second path that would drift from it. The two stay
    // distinct by AVAILABILITY, not by implementation — the dashboard disables
    // Start when nothing is offline and disables Restart when there is nothing
    // to restart. Do not "deduplicate" these by deleting one button.
    restartServers: () => void vscode.commands.executeCommand('karst.spinTicket', ticketId),
    // Stop-all is the one genuinely new effect: kill every running server on the
    // ticket, retaining the rows so they come back as offline and restartable.
    stopServers: () => {
      stopTicketServers(store, ticketId);
      afterServerChange();
    },
    showChanges,
    switchAgent,
    copyTicketKey: () => {
      const key = getTicket(store, ticketId).key ?? `#${ticketId}`;
      void vscode.env.clipboard.writeText(key);
    },
    ...worktreeActions,
    // Launch must not be aimable: the webview names a path, and the host
    // verifies it against the ticket's registered worktrees before building
    // anything — a crafted or stale message cannot start a build in an
    // arbitrary directory. It is also gated on the same config the button
    // renders from: an off switch must hold against a crafted message even
    // when no button is visible.
    launchWorktreeExtension: (path) => {
      if (!guardCapability('worktrees')) return;
      if (!launchConfig().enabled) {
        void vscode.window.showWarningMessage(
          'Launch worktree extension is disabled — set karst.launchWorktreeDev.enabled to true.',
        );
        return;
      }
      if (!listWorktreesByTicket(store, ticketId).some((w) => w.path === path)) {
        void vscode.window.showWarningMessage('That worktree is not registered to this ticket.');
        return;
      }
      launchWorktree(path);
    },
    openPr: (url) => void vscode.env.openExternal(vscode.Uri.parse(url)),
    // Copy the PR URL to the clipboard (the webview flashes its own feedback,
    // like copy-server-url / copy-worktree-branch).
    copyPrUrl: (url) => void vscode.env.clipboard.writeText(url),
    openTicketLink: (url) => void vscode.env.openExternal(vscode.Uri.parse(url)),
    editTicket,
    // Stop the auto-driver's next gate run for this ticket (it halts at the
    // next boundary check, never mid-gate — see `shouldContinue`).
    stopDriver: () => driver.requestStop(ticketId),
    // Human confirms ship: open the PR(s) for every hot repo, then let the
    // caller (dashboard) refresh so `done` (or a fresh PR list) shows up. The
    // saga run and its aftermath live in ONE host seam (`runShipSaga`), shared
    // with the stranded-ship recovery at activation — this click only adds the
    // capability guard and the failure toast.
    shipTicket: () => {
      if (!guardCapability('ship')) return;
      void runShipSaga(ticketId).catch((e) => {
        logError('ship failed', e);
        // `shipTicket` already recorded the reason on the ship stage, so the
        // dashboard now explains itself — but the user just clicked a button
        // and deserves an answer to THAT click, not a ticket that quietly goes
        // red. Refresh first so the dashboard reflects the failure when the
        // toast lands.
        afterServerChange();
        onInsideProgress(shipClearedEvent(ticketId));
        void vscode.window.showErrorMessage(
          `Ship failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    },
    // Resume: same interactive-open path the sidebar/dashboard "open session"
    // action already uses; `SessionManager.openSession` resolves --resume vs.
    // a fresh launch on its own.
    resumeTicket: () => void vscode.commands.executeCommand('karst.openSession', ticketId),
    // The unified "Send back to Implement" recovery action (869ehkkzp).
    //
    // The confirmation is a MODAL and the mutation stays host-side: the webview
    // posts only the payload-free message, and everything about whether — and
    // which stage from — it happens is decided here against the store, right
    // before it is mutated. Availability is re-derived AFTER the confirmation
    // too (inside `sendBackToImplement`'s transaction), so a ticket a sweep or
    // a teammate's merge moved while the modal was up is refused rather than
    // mutated underneath its new state.
    //
    // The dashboard is refreshed on EVERY exit — confirm, dismiss, refusal,
    // throw — because the webview's pending state is settled by a state push
    // (the same contract `mergePr` documents). Skipping the push on the cancel
    // path would leave the ⋯ menu item stuck pending.
    sendBackToImplement: () => {
      void (async () => {
        try {
          // The store decides availability: a stale panel can offer an action
          // for a stage the ticket has since left or landed.
          const state = sendBackState(store, ticketId);
          if (!state.available) {
            void vscode.window.showInformationMessage(
              'This ticket cannot be sent back to Implement right now.',
            );
            return;
          }
          const fromShip = state.stage === 'ship';
          const detail = fromShip
            ? 'Move this ticket back to Implement? UAT and Review will need to run again. '
                + 'Existing evidence will remain in history, and existing open pull requests are '
                + 'kept as they are — they are not merged or closed.'
            : 'Move this ticket back to Implement? UAT and Review will need to run again. '
                + 'Existing evidence will remain in history.';
          const choice = await vscode.window.showWarningMessage(
            'Send back to Implement?',
            { modal: true, detail },
            'Send back to Implement',
          );
          if (!choice) return; // dismissed: nothing ran, and nothing is claimed
          const result = sendBackToImplement(store, ticketId, { debug });
          void vscode.window.showInformationMessage(
            `Ticket moved back to Implement${result.from === 'ship' ? ' — open pull requests kept' : ''}.`,
          );
        } catch (e) {
          logError('send back to implement failed', e);
          void vscode.window.showErrorMessage(
            `Could not send the ticket back: ${e instanceof Error ? e.message : String(e)}`,
          );
        } finally {
          afterServerChange();
        }
      })();
    },
    // Resume a parked gate stage (§ blocked state visible). All the "is this
    // even valid" checking lives in `resumeBlockedStage` (vscode-free, unit
    // tested) — this stays a thin binding: apply it, and only on success
    // refresh the panel and kick the same driver trigger every other resume
    // path uses.
    resumeStage: (msgTicketId, stageKey) => {
      const outcome = resumeBlockedStage(store, ticketId, msgTicketId, stageKey);
      if (outcome.kind === 'cleared') {
        afterServerChange();
        driveAfterResume(ticketId);
        return;
      }
      if (outcome.kind === 'graph-recovery') {
        // The graph block is NOT cleared by a generic Resume (Slice-3 T9) —
        // the typed action runs graph-aware recovery instead.
        const recovery = recoverGraphRun(
          graphRecoveryDeps(outcome.graphRunId),
          { ticketId: outcome.ticketId, graphRunId: outcome.graphRunId },
        );
        if (
          recovery.kind === 'retried' ||
          recovery.kind === 'confirmation-restored' ||
          recovery.kind === 'replanned' ||
          recovery.kind === 'relaunched'
        ) {
          if (recovery.kind === 'replanned' && recovery.launch) graphReplanLaunch(recovery.launch);
          if (recovery.kind === 'relaunched' && recovery.launch) graphBootstrapRelaunch(recovery.launch);
          afterServerChange();
          driveAfterResume(ticketId);
        } else if (recovery.kind === 'refused') {
          void vscode.window.showInformationMessage(
            `Ticket #${ticketId}: the implementation graph cannot retry itself (${recovery.reason}) — open the Inside panel to discard the unknown process.`,
          );
        }
      }
    },
    // Pause: stamp the store flag FIRST so any in-flight driver round that
    // checks between stages sees it, then ask the running round to stop. The
    // interactive terminals stay open by design — the user is looking at them;
    // pause only stops karst from starting new work on this ticket.
    pauseExecution: () => {
      pauseTicket(store, ticketId);
      driver.requestStop(ticketId);
      afterServerChange();
    },
    // Unpause: clear the flag, then nudge the driver through the same
    // §5.4-safe seam a cleared block uses — resume is one more trigger.
    unpauseExecution: () => {
      unpauseTicket(store, ticketId);
      afterServerChange();
      driveAfterResume(ticketId);
    },
    // Opens the ticket form in edit mode on the new ticket so the user can type
    // the actual follow-up ask straight away — the command itself copies
    // repos/approach/agent/model from this ticket.
    createFollowUpTicket: () =>
      void vscode.commands.executeCommand('karst.createFollowUpTicket', ticketId),
    // A failed gate's log, opened read-only in an editor — the "why" behind a red
    // node, without sending the user to the dev-only output channel.
    openStageLog: (path) => {
      void (async () => {
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch (e) {
          // The gate wrote the path, but the file can be gone (worktree removed).
          void vscode.window.showWarningMessage(`Cannot open the log at ${path}.`);
          logError('open stage log failed', e);
        }
      })();
    },
    // A `stage-log-request` for the terminal "detailed mode" view: the manager
    // owns the ticket panel, so the read (store + fs, bounded) happens here and
    // the `stage-log` answer is posted to the panel that asked.
    requestStageLog: (stage) => requestStageLog(stage),
    // An `agent-log-request` for the terminal view of a gate-lane AI process
    // (the UAT Tester / Review findings lane): the manager owns the panel, and
    // the read of the persisted tail happens host-side.
    requestAgentLog: (processId) => requestAgentLog(processId),
    // Open one artifact resource in a normal VS Code editor — the deliberate
    // escape from the semantic artifact UI into the file model (spec §12). The
    // webview names ONLY the artifact id and a resource index, so this re-reads
    // the ticket's artifacts FRESH and resolves both against them: a stale
    // panel, a gone artifact, or a forged message all land on the same
    // "no longer available" refusal, and no webview-supplied path ever reaches
    // `Uri.file`. Mirrors openStageLog's failure copy: a missing file is
    // "cannot open", never a domain verdict about the artifact's result.
    openArtifactResource: (artifactId, index) => {
      void (async () => {
        const artifact = buildTicketArtifacts(store, ticketId).find((a) => a.id === artifactId);
        const resource = artifact && artifact.resources[index];
        if (!artifact || !resource) {
          void vscode.window.showWarningMessage('That artifact file is no longer available.');
          return;
        }
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resource.path));
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch (e) {
          void vscode.window.showWarningMessage(`Cannot open the file at ${resource.path}.`);
          logError('open artifact resource failed', e);
        }
      })();
    },
    // Hand one repo's conflict to an agent, briefed with where, against what,
    // and which paths the probe named. karst runs no git itself here: the
    // worktree may still have a session sitting in it, and a half-applied merge
    // left by a button click is a state nobody asked for.
    resolveConflicts: (repo) => {
      if (!guardCapability('sessions', ticketId)) return;
      // The store decides whether there is a conflict — the repo arrived in a
      // webview message, and a stale panel can name one that has since gone.
      const brief = buildConflictBrief(store, ticketId, repo);
      if (!brief) {
        void vscode.window.showInformationMessage(
          `No merge conflict is recorded for "${repo}" on this ticket — nothing to resolve.`,
        );
        return;
      }
      handOffToSession(brief);
    },
    // Merge one repo's PR, from the ship stage.
    //
    // Irreversible, so the confirmation is a MODAL and it is the same click that
    // chooses the strategy — there is no default method and no way to merge
    // without answering. The webview only names the repo; everything about how
    // (and whether) the merge happens is decided here and in `mergeTicketPr`.
    //
    // The dashboard is refreshed on EVERY exit — success, refusal, cancel, throw —
    // because the panel's pending state is cleared by a state push. Skipping the
    // push on the cancel path would leave the button stuck on "Merging…".
    mergePr: (repo) => {
      if (!guardCapability('ship')) return;
      void (async () => {
        try {
          // The store decides what is mergeable: `repo` arrived in a webview
          // message and a stale panel can name a PR that has since gone.
          const pr = findTicketPr(store, ticketId, repo);
          if (!pr) {
            void vscode.window.showInformationMessage(
              `No pull request is recorded for "${repo}" on this ticket — nothing to merge.`,
            );
            return;
          }
          if (pr.status === 'merged') {
            void vscode.window.showInformationMessage(
              `Pull request${pr.number ? ` #${pr.number}` : ''} is already merged.`,
            );
            return;
          }

          const target = pr.baseRef ? ` into ${pr.baseRef}` : '';
          const choice = await vscode.window.showWarningMessage(
            `Merge pull request${pr.number ? ` #${pr.number}` : ''}${target}?`,
            {
              modal: true,
              detail:
                'This merges the branch on GitHub now. karst cannot undo it. '
                + 'The worktree and its branch are kept.',
            },
            'Squash and merge',
            'Create a merge commit',
          );
          if (!choice) return; // dismissed: nothing ran, and nothing is claimed

          const result = await mergeTicketPr(store, {
            ticketId,
            repo,
            method: choice === 'Squash and merge' ? 'squash' : 'merge',
          });
          if (result.ok) {
            void vscode.window.showInformationMessage(
              result.completedTicket
                ? `Merged pull request${pr.number ? ` #${pr.number}` : ''} — ticket done.`
                : `Merged pull request${pr.number ? ` #${pr.number}` : ''}.`,
            );
            // `done` is reached here, not at ship: this is where the work has
            // actually landed, so this is where the provider's status is pushed.
            // Only the merge that finished the ticket does it — a multi-repo
            // ticket with PRs still open is not done.
            if (result.completedTicket) await onTicketCompleted();
            return;
          }
          // The reason is gh's own words where there are any. `mergeTicketPr` has
          // already persisted the real, re-probed state, so the panel and this
          // message describe the same PR.
          logError(`merge failed for ticket #${ticketId} (${repo})`, undefined);
          void vscode.window.showErrorMessage(`Merge failed: ${result.reason}`);
        } catch (e) {
          logError('merge failed', e);
          void vscode.window.showErrorMessage(
            `Merge failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        } finally {
          afterServerChange();
        }
      })();
    },
    // Re-probe PR status and mergeability on demand, from the panel's refresh
    // icon. The background sweep runs once a minute behind a five-minute
    // freshness floor, so after pushing a conflict fix a user could watch a stale
    // "conflicted" for minutes with no way to ask again.
    //
    // Errors are the sweep's own to log — this only has to guarantee the panel
    // gets a push either way, or the icon spins forever.
    refreshPrs: () => {
      void (async () => {
        try {
          await refreshPrs();
        } finally {
          afterServerChange();
        }
      })();
    },
    toggleBind,
    // Returns a promise, so the button reports a REAL terminal outcome rather
    // than a bare ack (UI-R13): the write is fast and local, so there is no
    // reason to settle on anything weaker.
    insideAction: (actionId) => onInsideAction(actionId),
    setDisabledGate: async (stage, name, disabled) => {
      const current = getDisabledGates(store, ticketId)[stage];
      const next = disabled ? [...current, name] : current.filter((n) => n !== name);
      setDisabledGates(store, ticketId, stage, next);
      // Re-push so the row re-renders from what was actually stored, never
      // from what the click assumed.
      afterServerChange();
    },
    // Change a spun ticket's base branch for one repository (§ per-repo base
    // branch — live change). `repo` is the worktree's repoPath; the manifest
    // is read FRESH (like ship) so a mid-session `karst.yml` edit controls
    // the resolved default. A refusal is reported via a THROW — the seam this
    // resolves through (panel.ts's `change-base-ref` branch) reports `ok`
    // from the resolved value, so `ok: false` is expressed by throwing, not
    // by returning it — no repaint happens, and `worktrees.base_ref` is
    // untouched (the workflow itself never writes it on a refusal).
    changeBaseRef: async (repo, baseRef, rebase) => {
      const manifestNow = manifest();
      if (!manifestNow) {
        return { ok: false, message: 'No manifest is loaded — nothing to change.' };
      }
      const result = await changeBaseRefWorkflow({
        store,
        manifest: manifestNow,
        ticketId,
        repoPath: repo,
        toBase: baseRef,
        rebase,
        git: defaultGitRunner,
        gh: defaultGhRunnerAsync,
        debug,
      });
      if (!result.ok) return { ok: false, message: result.reason };
      return { ok: true, message: describeChangeBaseRef(result) };
    },
  };
}
