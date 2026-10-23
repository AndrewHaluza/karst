import type { Store } from '../../store/db.js';
import type { StageKey } from '../../model/types.js';
import type { AgentProvider, Manifest } from '../../manifest/types.js';
import type { ModelCatalog } from '../../agent/modelCatalog.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import type { ProcessAssignmentSnapshot } from '../../agent/processAssignment.js';
import type { Notify } from './notify.js';
import type { GitRunner } from '../../integrations/git.js';
import type { ReviewArtifacts } from '../../workflow/review/conformance.js';
import type { TesterGateRunner } from '../../workflow/uat/testerVerifier.js';
import type { UatSpin, UatStopServers } from '../../workflow/stages/uat.js';
import {
  agentSwitchCoreChoices,
  agentSwitchModelChoices,
  type AgentSwitchCoreChoice,
  type AgentSwitchModelChoice,
} from '../../agent/sessionSwitch.js';
import { stageBlock } from '../../store/stageBlocks.js';
import {
  listOpenParks,
  type UsageLimitParkRow,
} from '../../store/usageLimitParks.js';
import {
  rerunParkedStage,
  dismissUsageLimitPark,
} from '../../workflow/usageLimitRerun.js';

export interface QuickPickChoice {
  label: string;
  description?: string;
  detail?: string;
}

export interface QuickPickCoreChoice extends QuickPickChoice {
  id: AgentProvider;
}

export interface QuickPickModelChoice extends QuickPickChoice {
  model: string | null;
}

/** Formats agent core choices, tagging the parked provider with (usage limit). */
export function formatCoreChoices(parkedProvider: string): QuickPickCoreChoice[] {
  return agentSwitchCoreChoices().map((choice) => ({
    id: choice.id,
    label: choice.id === parkedProvider ? `${choice.label} (usage limit)` : choice.label,
  }));
}

/** Formats model choices for a provider, tagging the parked model with (usage limit). */
export function formatModelChoices(
  provider: AgentProvider,
  catalog: ModelCatalog,
  parkedModel: string | null,
): QuickPickModelChoice[] {
  const choices = agentSwitchModelChoices({
    provider,
    ticketModel: null,
    defaultModel: null,
    catalog,
  });

  return choices.map((choice) => {
    const isParked = parkedModel !== null && choice.model === parkedModel;
    return {
      model: choice.model,
      label: choice.label,
      description: isParked
        ? `${choice.description} (usage limit)`
        : choice.description,
    };
  });
}

function findTargetPark(store: Store, ticketId: number, stageKey: StageKey): UsageLimitParkRow | null {
  const atStage = listOpenParks(store, ticketId).filter((p) => p.stage === stageKey);
  if (atStage.length === 0) {
    return null;
  }
  // A usage-limit STAGE BLOCK is what the dashboard banner speaks for, and it
  // always carries its own `stage-block` park. A sibling `op` park (classify,
  // analysis, suggest) merely RAN at the same stage and can be newer, so
  // selecting by stage alone would hijack the stage action onto an unrelated
  // op. When the stage is blocked on usage-limit, target THAT park.
  const block = stageBlock(store, ticketId, stageKey);
  if (block?.kind === 'usage-limit') {
    return atStage.find((p) => p.kind === 'stage-block') ?? null;
  }
  // No usage-limit block: an op park at this stage is the target (the op-park
  // notification path). A stage-block park whose block is already gone is
  // stale and must not be actioned. An op park is DISMISSED here (resolving
  // its row IS the dismiss), but it is never RE-RUN here — the op's own path
  // re-runs the op, never a stage lane.
  return atStage.find((p) => p.kind === 'op') ?? null;
}

/**
 * Run one park action under the host's per-ticket single-flight lock, passing
 * the run's Stop signal. Returns undefined when a stage run is already in
 * flight — the action then touches nothing, exactly like a lost claim.
 */
export type ExclusiveRunner = <T>(
  run: (signal: AbortSignal | undefined) => Promise<T>,
) => Promise<T | undefined>;

export interface UsageLimitActionCommonDeps {
  store: Store;
  ticketId: number;
  stageKey: StageKey;
  notify: Notify;
  redrive: (ticketId: number) => void;
  refresh: (ticketId: number) => void;
  /**
   * Serialize the re-run with the stage driver (one run per ticket) and give
   * it the same Stop signal every driver-run gate gets. Absent → run directly
   * (unit tests and hosts without a driver).
   */
  runExclusive?: ExclusiveRunner;
  manifest?: () => Manifest | undefined;
  artifactDir?: string;
  cwd?: string;
  debug?: (msg: string) => void;
  /**
   * The git runner the review re-run snapshots the worktree with, so it reviews
   * the SAME committed+uncommitted tree the stage would — never a committed-only
   * range. Absent → no snapshot (fallback wording); the host passes the real one.
   */
  git?: GitRunner;
  /** Review conformance artifacts for the re-run; absent → the lane runs without them. */
  loadArtifacts?: (ticketId: number) => Promise<ReviewArtifacts | undefined>;
  /** The `uat.testerVerifier` host boundary (`runProcess`); absent → a configured verifier parks. */
  runVerifier?: TesterGateRunner;
  /**
   * The composed `karst context` prefix the UAT stage hands its Tester. A
   * re-run that omitted it would drop the prompt's tier-1 context pointer.
   */
  contextCommand?: string;
  /**
   * The role's per-run assignment (profile instructions, effort, agent name),
   * resolved from the picked provider/model by the host. The override changes
   * which core runs, never the role's prompt or its recorded identity.
   */
  assignmentFor?: (
    ticketId: number,
    stageKey: StageKey,
    provider: AgentProvider,
    model: string | null,
  ) => ProcessAssignmentSnapshot | undefined;
  /**
   * The service spin/stop seams (D155): a UAT re-run starts the ticket's
   * runnable services before the Tester and stops its own stack afterwards,
   * exactly like the stage. Both absent → no spin and no stop.
   */
  spin?: UatSpin;
  stopServers?: UatStopServers;
  /**
   * The driver's sandbox preflight (AC-32): a re-run must see the tree the
   * stage would, so the host gets the same sync and provisioning check
   * `driveTicket` runs before every stage. Absent → no preflight (host ticket).
   */
  syncSandbox?: (ticketId: number) => Promise<{ ok: true } | { ok: false; reason: string }>;
  provisionSandbox?: (
    ticketId: number,
    signal?: AbortSignal,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface UsageLimitPickDeps extends UsageLimitActionCommonDeps {
  catalog: ModelCatalog;
  pickCore: (items: QuickPickCoreChoice[]) => Promise<QuickPickCoreChoice | undefined>;
  pickModel: (items: QuickPickModelChoice[]) => Promise<QuickPickModelChoice | undefined>;
  adapterFor: (provider: AgentProvider, model: string | null) => AgentAdapter;
}

export async function handleUsageLimitPick(deps: UsageLimitPickDeps): Promise<void> {
  const park = findTargetPark(deps.store, deps.ticketId, deps.stageKey);
  if (!park) {
    deps.notify.warn('This usage limit was already handled.');
    return;
  }

  const coreChoices = formatCoreChoices(park.provider);
  const pickedCore = await deps.pickCore(coreChoices);
  if (!pickedCore) return;

  const modelChoices = formatModelChoices(pickedCore.id, deps.catalog, park.model);
  const pickedModel = await deps.pickModel(modelChoices);
  if (!pickedModel) return;

  const manifest = deps.manifest?.();
  const run = (signal: AbortSignal | undefined) =>
    rerunParkedStage({
      store: deps.store,
      parkRow: park,
      provider: pickedCore.id,
      model: pickedModel.model,
      resolution: 'pick',
      // Built only if the claim wins (inside `rerunParkedStage`), so a racing
      // window never constructs an adapter it will not use.
      buildAdapter: deps.adapterFor,
      resolveAssignment: deps.assignmentFor
        ? (stageKey, provider, model) =>
            deps.assignmentFor!(deps.ticketId, stageKey, provider, model)
        : undefined,
      manifest,
      cwd: deps.cwd ?? process.cwd(),
      artifactDir: deps.artifactDir ?? '',
      git: deps.git,
      loadArtifacts: deps.loadArtifacts ? () => deps.loadArtifacts!(deps.ticketId) : undefined,
      runVerifier: deps.runVerifier,
      contextCommand: deps.contextCommand,
      spin: deps.spin,
      stopServers: deps.stopServers,
      syncSandbox: deps.syncSandbox,
      provisionSandbox: deps.provisionSandbox,
      signal,
      debug: deps.debug,
    });

  const result = deps.runExclusive ? await deps.runExclusive(run) : await run(undefined);
  if (result === undefined) {
    deps.notify.warn('A stage run is already in flight for this ticket.');
    return;
  }
  if (result.kind === 'stopped') {
    notifyStopped(deps, result);
    return;
  }
  if (result.kind === 'blocked') {
    // The re-run parked again (still out of quota, boot-failed, nothing to
    // run). Redriving here is the very failure the block exists to prevent:
    // the driver's only block filter is the sweep's, so `shouldStartDriver`
    // would run the WHOLE stage again — every gate, the service spin and the
    // Tester — on a ticket the user has not unblocked. Only the panel needs
    // the new park.
    deps.refresh(deps.ticketId);
    return;
  }

  deps.redrive(deps.ticketId);
  deps.refresh(deps.ticketId);
}

/**
 * A lost claim (another window got there first) touched nothing and is a
 * no-op. A Stop is NOT that: the run may have opened, closed or interrupted
 * rows, so the panel is refreshed — it is just never redriven, because the
 * user stopped it on purpose.
 */
function notifyStopped(
  deps: UsageLimitActionCommonDeps,
  result: { alreadyHandled?: true },
): void {
  if (result.alreadyHandled) {
    deps.notify.warn('This usage limit was already handled.');
    return;
  }
  deps.notify.info('The re-run was stopped.');
  deps.refresh(deps.ticketId);
}

export interface UsageLimitRetryDeps extends UsageLimitActionCommonDeps {
  adapterFor: (provider: AgentProvider, model: string | null) => AgentAdapter;
}

export async function handleUsageLimitRetry(deps: UsageLimitRetryDeps): Promise<void> {
  const park = findTargetPark(deps.store, deps.ticketId, deps.stageKey);
  if (!park) {
    deps.notify.warn('This usage limit was already handled.');
    return;
  }

  const manifest = deps.manifest?.();
  const run = (signal: AbortSignal | undefined) =>
    rerunParkedStage({
      store: deps.store,
      parkRow: park,
      provider: park.provider as AgentProvider,
      model: park.model,
      resolution: 'retry',
      // Built only if the claim wins (inside `rerunParkedStage`).
      buildAdapter: deps.adapterFor,
      resolveAssignment: deps.assignmentFor
        ? (stageKey, provider, model) =>
            deps.assignmentFor!(deps.ticketId, stageKey, provider, model)
        : undefined,
      manifest,
      cwd: deps.cwd ?? process.cwd(),
      artifactDir: deps.artifactDir ?? '',
      git: deps.git,
      loadArtifacts: deps.loadArtifacts ? () => deps.loadArtifacts!(deps.ticketId) : undefined,
      runVerifier: deps.runVerifier,
      contextCommand: deps.contextCommand,
      spin: deps.spin,
      stopServers: deps.stopServers,
      syncSandbox: deps.syncSandbox,
      provisionSandbox: deps.provisionSandbox,
      signal,
      debug: deps.debug,
    });

  const result = deps.runExclusive ? await deps.runExclusive(run) : await run(undefined);
  if (result === undefined) {
    deps.notify.warn('A stage run is already in flight for this ticket.');
    return;
  }
  if (result.kind === 'stopped') {
    notifyStopped(deps, result);
    return;
  }
  if (result.kind === 'blocked') {
    // Same rule as Pick: a re-run that parked again must never redrive the
    // whole stage (see `handleUsageLimitPick`).
    deps.refresh(deps.ticketId);
    return;
  }

  deps.redrive(deps.ticketId);
  deps.refresh(deps.ticketId);
}

export interface UsageLimitDismissDeps extends UsageLimitActionCommonDeps {}

export async function handleUsageLimitDismiss(deps: UsageLimitDismissDeps): Promise<void> {
  const park = findTargetPark(deps.store, deps.ticketId, deps.stageKey);
  if (!park) {
    deps.notify.warn('This usage limit was already handled.');
    return;
  }

  const run = async () =>
    dismissUsageLimitPark(deps.store, park, {
      manifest: deps.manifest?.(),
      artifactDir: deps.artifactDir,
      debug: deps.debug,
    });

  const result = deps.runExclusive ? await deps.runExclusive(run) : await run();
  if (result === undefined) {
    deps.notify.warn('A stage run is already in flight for this ticket.');
    return;
  }
  if (result.kind === 'stopped') {
    deps.notify.warn('This usage limit was already handled.');
    return;
  }

  deps.redrive(deps.ticketId);
  deps.refresh(deps.ticketId);
}

export interface UsageLimitParkActionsDeps {
  store: Store;
  ticketId: number;
  notify: Notify;
  catalog: () => ModelCatalog;
  manifest: () => Manifest | undefined;
  redrive: (ticketId: number) => void;
  refresh: (ticketId: number) => void;
  runExclusive?: ExclusiveRunner;
  pickCore: (items: QuickPickCoreChoice[]) => Promise<QuickPickCoreChoice | undefined>;
  pickModel: (items: QuickPickModelChoice[]) => Promise<QuickPickModelChoice | undefined>;
  adapterFor: (provider: AgentProvider, model: string | null) => AgentAdapter;
  artifactDir: () => string;
  cwd?: () => string;
  git?: GitRunner;
  loadArtifacts?: (ticketId: number) => Promise<ReviewArtifacts | undefined>;
  runVerifier?: TesterGateRunner;
  contextCommand?: string;
  assignmentFor?: (
    ticketId: number,
    stageKey: StageKey,
    provider: AgentProvider,
    model: string | null,
  ) => ProcessAssignmentSnapshot | undefined;
  /** The service spin/stop seams (D155) for a UAT re-run. */
  spin?: UatSpin;
  stopServers?: UatStopServers;
  /** The driver's sandbox preflight (AC-32) for a UAT/review re-run. */
  syncSandbox?: (ticketId: number) => Promise<{ ok: true } | { ok: false; reason: string }>;
  provisionSandbox?: (
    ticketId: number,
    signal?: AbortSignal,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  debug?: (msg: string) => void;
}

export interface UsageLimitParkActions {
  usageLimitPick: (ticketId: number, stageKey: StageKey) => Promise<void>;
  usageLimitRetry: (ticketId: number, stageKey: StageKey) => Promise<void>;
  usageLimitDismiss: (ticketId: number, stageKey: StageKey) => Promise<void>;
}

export function makeUsageLimitParkActions(deps: UsageLimitParkActionsDeps): UsageLimitParkActions {
  /**
   * The PANEL owns the ticket. A dashboard message still names one
   * (`routeAction` fills it from `msg.ticketId`), but every other per-ticket
   * seam these actions hold — the driver single-flight lock, the artifact dir,
   * the assignment, the conformance artifacts — belongs to `deps.ticketId`.
   * Acting on the message's id would let a stale or forged message claim,
   * unblock and FAIL another ticket's stage while holding this panel's lock.
   * Refuse on mismatch, exactly like `resumeBlockedStage` does for the same
   * pair (`.../stageResume.ts`).
   */
  const ownsTicket = (ticketId: number): boolean => {
    if (ticketId === deps.ticketId) return true;
    deps.notify.warn(`Ignored: this panel drives ticket ${deps.ticketId}, not ${ticketId}.`);
    return false;
  };
  return {
    usageLimitPick: async (ticketId: number, stageKey: StageKey) => {
      if (!ownsTicket(ticketId)) return;
      await handleUsageLimitPick({
        store: deps.store,
        ticketId: deps.ticketId,
        stageKey,
        notify: deps.notify,
        catalog: deps.catalog(),
        manifest: deps.manifest,
        redrive: deps.redrive,
        refresh: deps.refresh,
        runExclusive: deps.runExclusive,
        pickCore: deps.pickCore,
        pickModel: deps.pickModel,
        adapterFor: deps.adapterFor,
        artifactDir: deps.artifactDir(),
        cwd: deps.cwd?.(),
        git: deps.git,
        loadArtifacts: deps.loadArtifacts,
        runVerifier: deps.runVerifier,
        contextCommand: deps.contextCommand,
        assignmentFor: deps.assignmentFor,
        spin: deps.spin,
        stopServers: deps.stopServers,
      syncSandbox: deps.syncSandbox,
      provisionSandbox: deps.provisionSandbox,
        debug: deps.debug,
      });
    },
    usageLimitRetry: async (ticketId: number, stageKey: StageKey) => {
      if (!ownsTicket(ticketId)) return;
      await handleUsageLimitRetry({
        store: deps.store,
        ticketId: deps.ticketId,
        stageKey,
        notify: deps.notify,
        manifest: deps.manifest,
        redrive: deps.redrive,
        refresh: deps.refresh,
        runExclusive: deps.runExclusive,
        adapterFor: deps.adapterFor,
        artifactDir: deps.artifactDir(),
        cwd: deps.cwd?.(),
        git: deps.git,
        loadArtifacts: deps.loadArtifacts,
        runVerifier: deps.runVerifier,
        contextCommand: deps.contextCommand,
        assignmentFor: deps.assignmentFor,
        spin: deps.spin,
        stopServers: deps.stopServers,
      syncSandbox: deps.syncSandbox,
      provisionSandbox: deps.provisionSandbox,
        debug: deps.debug,
      });
    },
    usageLimitDismiss: async (ticketId: number, stageKey: StageKey) => {
      if (!ownsTicket(ticketId)) return;
      await handleUsageLimitDismiss({
        store: deps.store,
        ticketId: deps.ticketId,
        stageKey,
        notify: deps.notify,
        manifest: deps.manifest,
        redrive: deps.redrive,
        refresh: deps.refresh,
        runExclusive: deps.runExclusive,
        artifactDir: deps.artifactDir(),
        debug: deps.debug,
      });
    },
  };
}
